import struct
import unittest
from unittest.mock import patch

from pydantic import ValidationError
from app.drivers.dam0808d import Dam0808DClient, crc16
from app.drivers.adam6050 import ModbusError
from app.models import AppConfig


class SerialDevice:
    def __init__(self, *args, **kwargs):
        self.is_open = True
        self.buffer = bytearray()
        self.writes = []
        self.bits = 0
        self.corrupt = False
        self.wrong_unit = False
        self.ignore_write = False
        self.timeout = .4

    def close(self): self.is_open = False
    def reset_input_buffer(self): self.buffer.clear()
    def write(self, frame):
        self.writes.append(frame)
        assert crc16(frame[:-2]) == frame[-2:]
        unit, function = frame[:2]
        if function == 5:
            channel, value = struct.unpack('>HH', frame[2:6])
            if not self.ignore_write:
                self.bits = (self.bits | (1 << channel)) if value else (self.bits & ~(1 << channel))
            body = frame[:-2]
        else:
            assert frame[2:6] == b'\x00\x00\x00\x08'
            body = bytes((unit, function, 1, self.bits if function == 1 else 0x81))
        if self.wrong_unit: body = bytes((unit ^ 1,)) + body[1:]
        reply = body + crc16(body)
        if self.corrupt: reply = reply[:-1] + bytes((reply[-1] ^ 1,))
        self.buffer.extend(reply)
    def read(self, count):
        # Exercise partial serial reads.
        data = bytes(self.buffer[:1]); del self.buffer[:1]; return data


class DamProtocol(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake = SerialDevice()
        self.patch = patch('app.drivers.dam0808d.serial.Serial', return_value=self.fake)
        self.patch.start()
        self.client = Dam0808DClient('COM4', unit_id=254)
    async def asyncTearDown(self):
        await self.client.close(); self.patch.stop()

    async def test_manufacturer_crc_and_read_inputs(self):
        self.assertEqual(crc16(bytes.fromhex('FE 01 00 00 00 08')), bytes.fromhex('29 C3'))
        bits = await self.client.read_inputs()
        self.assertEqual(bits, [True, False, False, False, False, False, False, True])
        self.assertTrue(all(frame[1] == 2 for frame in self.fake.writes))

    async def test_write_first_and_eighth_with_state_readback(self):
        await self.client.write_output(0, True)
        self.assertEqual(self.fake.writes[0], bytes.fromhex('FE 05 00 00 FF 00 98 35'))
        await self.client.write_output(7, True)
        await self.client.write_output(0, False)
        self.assertEqual(await self.client.read_outputs(), [False]*7+[True])
        self.assertEqual([f[1] for f in self.fake.writes[:2]], [5, 1])

    async def test_bad_crc_disconnects(self):
        self.fake.corrupt = True
        with self.assertRaisesRegex(ModbusError, 'CRC'): await self.client.read_inputs()
        self.assertFalse(self.client.connected)

    async def test_wrong_address_disconnects(self):
        self.fake.wrong_unit = True
        with self.assertRaisesRegex(ModbusError, '地址'): await self.client.read_inputs()
        self.assertFalse(self.client.connected)

    async def test_echo_without_changed_coil_fails(self):
        self.fake.ignore_write = True
        with self.assertRaisesRegex(ModbusError, '读回'): await self.client.write_output(0, True)
        self.assertFalse(self.client.connected)

    async def test_invalid_channel_does_not_send(self):
        with self.assertRaises(ValueError): await self.client.write_output(8, True)
        self.assertEqual(self.fake.writes, [])


class DamConfiguration(unittest.TestCase):
    def test_shared_gauge_port_rejected(self):
        with self.assertRaises(ValidationError):
            AppConfig(tpg_connection='usb', tpg_serial_port='COM3', dam_serial_port='com3')
    def test_channel_limits_and_broadcast(self):
        for values in ({'valve_closed_di':8}, {'dam_unit_id':0}):
            with self.assertRaises(ValidationError): AppConfig(**values)
        self.assertEqual(AppConfig(open_output=7).open_output,7)
        self.assertEqual(AppConfig(dam_unit_id=254).dam_unit_id,254)
