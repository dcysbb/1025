"""DAM0808D serial Modbus RTU, eight coils and eight discrete inputs."""
from __future__ import annotations

import asyncio
import struct
import time
import serial

from .adam6050 import ModbusError
from .windows_serial_recovery import restart_usb_serial


class DamResponseTimeout(ModbusError):
    """No complete RTU response within one bounded exchange."""


class DamPortUnavailable(ModbusError):
    """The configured COM endpoint is absent, rather than merely unresponsive."""


def crc16(data: bytes) -> bytes:
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return struct.pack('<H', crc)


class Dam0808DClient:
    DI_COUNT = DO_COUNT = 8

    def __init__(self, host: str, port: int = 9600, unit_id: int = 1, timeout_s: float = 3.0):
        if not 1 <= unit_id <= 255:
            raise ValueError('DAM 地址必须为 1 至 255，禁止广播地址 0')
        self.host, self.port, self.unit_id, self.timeout_s = host, port, unit_id, timeout_s
        self._serial = None
        self._lock = asyncio.Lock()

    @property
    def connected(self):
        return self._serial is not None and self._serial.is_open

    async def connect(self):
        async with self._lock:
            await self._connect()

    async def _connect(self):
        if not self.connected:
            try:
                worker = asyncio.create_task(asyncio.to_thread(serial.Serial, self.host, self.port,
                    timeout=min(self.timeout_s, 0.05), write_timeout=self.timeout_s, bytesize=8, parity='N', stopbits=1))
                try:
                    self._serial = await asyncio.shield(worker)
                except asyncio.CancelledError:
                    try:
                        stream = await worker
                    except (OSError, serial.SerialException):
                        pass
                    else:
                        await asyncio.to_thread(stream.close)
                    raise
            except (OSError, serial.SerialException) as exc:
                if isinstance(exc, FileNotFoundError) or 'FileNotFoundError(2,' in str(exc):
                    raise DamPortUnavailable(
                        f'DAM 串口 {self.host} 未被系统识别；请检查 USB 连接，设备重新出现后再复位'
                    ) from exc
                raise ModbusError(f'DAM0808D 串口连接失败: {exc}') from exc

    async def close(self):
        async with self._lock:
            await self._close()

    async def _close(self):
        stream, self._serial = self._serial, None
        if stream:
            await asyncio.to_thread(stream.close)

    async def restart_usb(self, protected_port: str = '') -> dict:
        async with self._lock:
            await self._close()
            result = await restart_usb_serial(self.host, protected_port)
            if result.get('ok'):
                await asyncio.sleep(1.0)
            return result

    def _exchange(self, function, payload):
        stream = self._serial
        time.sleep(3.5 * 11 / self.port)
        stream.reset_input_buffer()
        request = bytes((self.unit_id, function)) + payload
        deadline = time.monotonic() + self.timeout_s
        stream.write(request + crc16(request))

        def read_exact(count):
            data = bytearray()
            while len(data) < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DamResponseTimeout('DAM0808D 响应超时或截断')
                # Changing timeout calls SetCommState on Windows; some USB UARTs
                # lose an in-flight response when reconfigured. Keep it fixed and
                # enforce the overall deadline across short reads instead.
                part = stream.read(count - len(data))
                if not part:
                    continue
                data.extend(part)
            return bytes(data)

        head = read_exact(3)
        if head[1] & 0x80:
            frame = head + read_exact(2)
        elif function in (1, 2):
            if head[2] != 1:
                raise ModbusError('DAM0808D 位响应字节数错误')
            frame = head + read_exact(3)
        else:
            frame = head + read_exact(5)
        if crc16(frame[:-2]) != frame[-2:]:
            raise ModbusError('DAM0808D CRC 校验失败')
        if frame[0] != self.unit_id or frame[1] not in (function, function | 0x80):
            raise ModbusError('DAM0808D 地址或功能码不匹配')
        if frame[1] & 0x80:
            raise ModbusError(f'DAM0808D Modbus 异常码 {frame[2]}')
        return frame[2:-2]

    async def _request(self, function, payload):
        # The engine owns the three reconnect attempts. Each exchange gets one
        # deadline, so hidden driver retries cannot double the configured timeout.
        await self._connect()
        worker = asyncio.create_task(asyncio.to_thread(self._exchange, function, payload))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            # A serial worker must finish before another transaction reuses UART.
            try:
                await worker
            except (ModbusError, OSError, serial.SerialException):
                pass
            await self._close()
            raise
        except DamResponseTimeout as exc:
            await self._close()
            raise DamResponseTimeout(f'{exc}（{self.timeout_s:g} 秒）') from exc
        except (ModbusError, OSError, serial.SerialException) as exc:
            await self._close()
            raise ModbusError(str(exc)) from exc

    async def _bits(self, function):
        data = await self._request(function, struct.pack('>HH', 0, 8))
        if len(data) != 2 or data[0] != 1:
            raise ModbusError('DAM0808D 位响应长度错误')
        return [bool(data[1] & (1 << index)) for index in range(8)]

    async def read_inputs(self):
        async with self._lock:
            return await self._bits(2)

    async def read_outputs(self):
        async with self._lock:
            return await self._bits(1)

    async def write_output(self, channel: int, state: bool):
        if not 0 <= channel < 8:
            raise ValueError('DAM0808D 输出编号必须为 0 至 7')
        async with self._lock:
            payload = struct.pack('>HH', channel, 0xFF00 if state else 0)
            try:
                echo = await self._request(5, payload)
            except DamResponseTimeout:
                if state:
                    raise
                # OFF may already have reached the relay even if its echo was
                # lost. A new validated coil read can prove it; no guessed success.
                await asyncio.sleep(0.1)
                if (await self._bits(1))[channel]:
                    await self._close()
                    raise ModbusError('DAM0808D 关闭回显超时，继电器仍开启')
                return
            if echo != payload:
                await self._close()
                raise ModbusError('DAM0808D 写入回显不匹配')
            if (await self._bits(1))[channel] != state:
                await self._close()
                raise ModbusError('DAM0808D 继电器状态读回不匹配')
