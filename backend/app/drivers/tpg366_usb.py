from __future__ import annotations

import asyncio
import serial
from .tpg366 import TPG366Client, TPG366Error


class TPG366USBClient(TPG366Client):
    """USB virtual COM port transport using the same TPG mnemonics protocol."""
    def __init__(self, serial_port: str, baudrate: int = 9600, timeout_s: float = .35):
        super().__init__(serial_port, baudrate, timeout_s)
        self.serial_port, self.baudrate = serial_port, baudrate
        self._serial = None

    @property
    def connected(self):
        return self._serial is not None and self._serial.is_open

    async def connect(self):
        if self.connected:
            return
        try:
            self._serial = await asyncio.to_thread(serial.Serial, self.serial_port, self.baudrate,
                timeout=self.timeout_s, write_timeout=self.timeout_s,
                bytesize=serial.EIGHTBITS, parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE)
            self._serial.reset_input_buffer()
        except (serial.SerialException, OSError) as exc:
            await self.close()
            raise TPG366Error(f"无法连接 TPG USB {self.serial_port}: {exc}") from exc

    async def close(self):
        transport, self._serial = self._serial, None
        self._unit_code = None
        if transport is not None:
            await asyncio.to_thread(transport.close)

    async def _send(self, payload: bytes):
        if not self.connected:
            await self.connect()
        try:
            await asyncio.to_thread(self._serial.write, payload)
        except (serial.SerialException, OSError) as exc:
            await self.close()
            raise TPG366Error(f"TPG USB 写入失败: {exc}") from exc

    async def _read_line(self):
        if not self.connected:
            raise TPG366Error("TPG USB 未连接")
        try:
            raw = await asyncio.to_thread(self._serial.read_until, b'\n', 4096)
            if not raw or not raw.endswith(b'\n'):
                raise TPG366Error("TPG USB 响应超时或报文不完整")
            return raw.decode('ascii', errors='replace').strip('\r\n \x00')
        except (serial.SerialException, OSError, TPG366Error) as exc:
            await self.close()
            raise TPG366Error(f"TPG USB 读取失败: {exc}") from exc
