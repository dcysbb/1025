"""ZS analog outputs, RJ45 V2.0 manual: Modbus TCP, 1 microamp per count."""
import struct

from .adam6050 import Adam6050Client, ModbusError


class ZsAnalogClient(Adam6050Client):
    async def _request(self, function, payload):
        try:
            return await super()._request(function, payload)
        except ModbusError as exc:
            await self.close()
            raise ModbusError(str(exc).replace("ADAM-6050", "ZS-AO-4-RJ45")) from exc

    async def read_registers(self, address, count):
        if not 1 <= count <= 4 or not 0 <= address <= 65535 - count + 1:
            raise ValueError("模拟量寄存器范围错误")
        async with self._lock:
            data = await self._request(3, struct.pack(">HH", address, count))
            if len(data) != 1 + 2 * count or data[0] != 2 * count:
                await self.close()
                raise ModbusError("ZS-AO-4-RJ45 寄存器响应长度错误")
            return list(struct.unpack(">" + "H" * count, data[1:]))

    async def write_current(self, address, current_ma):
        if not 4 <= current_ma <= 20:
            raise ValueError("输出电流必须在 4–20mA 内")
        payload = struct.pack(">HH", address, round(current_ma * 1000))
        async with self._lock:
            echoed = await self._request(6, payload)
            if echoed != payload:
                await self.close()
                raise ModbusError("ZS-AO-4-RJ45 写入回显不匹配，输出未确认")

    async def identify(self):
        await self.connect()
        address = (await self.read_registers(0x32, 1))[0]
        if address != self.unit_id:
            await self.close()
            raise ModbusError(f"ZS-AO 站号读回 {address}，与配置 {self.unit_id} 不符")
