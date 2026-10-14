import asyncio
import struct
import time
import unittest
from unittest.mock import patch

from pydantic import ValidationError
from app.drivers.dam0808d import Dam0808DClient, DamResponseTimeout, DamPortUnavailable, crc16
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
        self.serial_factory = self.patch.start()
        def reopen_serial(*args, **kwargs):
            self.fake.is_open = True
            return self.fake
        self.serial_factory.side_effect = reopen_serial
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

    async def test_repeated_out1_switches_and_concurrent_monitoring_remain_serialized(self):
        for _ in range(20):
            await asyncio.gather(self.client.write_output(0, True), self.client.read_inputs())
            self.assertTrue((await self.client.read_outputs())[0])
            await asyncio.gather(self.client.write_output(0, False), self.client.read_inputs())
            self.assertFalse((await self.client.read_outputs())[0])
        self.assertTrue(self.client.connected)
        self.assertEqual(self.serial_factory.call_count, 1)

    async def test_close_waits_for_pending_transaction_before_releasing_port(self):
        original_read = self.fake.read
        def slow_read(count):
            time.sleep(.015)
            self.assertTrue(self.fake.is_open)
            return original_read(count)
        with patch.object(self.fake, 'read', side_effect=slow_read):
            read = asyncio.create_task(self.client.read_inputs())
            await asyncio.sleep(.01)
            await self.client.close()
            self.assertTrue((await read)[0])
        self.assertFalse(self.client.connected)

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

    async def test_missing_port_is_reported_as_device_not_present(self):
        self.serial_factory.side_effect=OSError("could not open port: FileNotFoundError(2, 'missing')")
        with self.assertRaisesRegex(DamPortUnavailable,'未被系统识别'):
            await self.client.connect()
        self.assertFalse(self.client.connected)

    async def test_does_not_reconfigure_uart_during_response(self):
        class UsbUart(SerialDevice):
            def __setattr__(self, key, value):
                if key == 'timeout' and getattr(self, 'writes', []):
                    raise RuntimeError('Reconfiguring USB UART destroys pending response')
                super().__setattr__(key, value)
        self.fake = UsbUart()
        with patch('app.drivers.dam0808d.serial.Serial', return_value=self.fake):
            self.assertTrue((await self.client.read_inputs())[0])
            self.assertEqual(await self.client.read_outputs(), [False]*8)

    async def test_missing_response_has_bounded_timeout(self):
        self.client.timeout_s = .03
        with patch.object(self.fake, 'read', return_value=b''):
            with self.assertRaisesRegex(ModbusError, '超时'):
                await self.client.read_inputs()
        self.assertFalse(self.client.connected)
        self.assertEqual(len(self.fake.writes), 1)

    async def test_missing_read_closes_port_and_next_attempt_reopens(self):
        self.client.timeout_s = .02
        original_write = self.fake.write
        def lose_first_reply(frame):
            original_write(frame)
            if len(self.fake.writes) == 1:
                self.fake.buffer.clear()
        with patch.object(self.fake, 'write', side_effect=lose_first_reply):
            with self.assertRaises(DamResponseTimeout):
                await self.client.read_inputs()
            self.assertFalse(self.client.connected)
            self.assertTrue((await self.client.read_inputs())[0])
        self.assertEqual(len(self.fake.writes), 2)
        self.assertTrue(self.client.connected)
        self.assertEqual(self.serial_factory.call_count, 2)

    async def test_default_response_timeout_is_three_seconds(self):
        self.assertEqual(self.client.timeout_s, 3.0)
        await self.client.read_inputs()
        self.assertEqual(self.serial_factory.call_args.kwargs['write_timeout'], 3.0)

    async def test_response_slower_than_old_400ms_deadline_is_accepted(self):
        original_read = self.fake.read
        delayed = False
        def delayed_read(count):
            nonlocal delayed
            if not delayed:
                delayed = True
                time.sleep(.45)
            return original_read(count)
        with patch.object(self.fake, 'read', side_effect=delayed_read):
            self.assertTrue((await self.client.read_inputs())[0])
        self.assertEqual(len(self.fake.writes), 1)

    async def test_lost_off_echo_can_be_confirmed_by_coil_read(self):
        self.client.timeout_s = .02
        self.fake.bits = 1
        original_write = self.fake.write
        def lose_write_echo(frame):
            original_write(frame)
            if frame[1] == 5:
                self.fake.buffer.clear()
        with patch.object(self.fake, 'write', side_effect=lose_write_echo):
            await self.client.write_output(0, False)
        self.assertEqual(self.fake.bits, 0)
        self.assertEqual([frame[1] for frame in self.fake.writes], [5, 1])

    async def test_lost_off_echo_with_still_enabled_coil_is_rejected(self):
        self.client.timeout_s = .02
        self.fake.bits = 1
        self.fake.ignore_write = True
        original_write = self.fake.write
        def lose_write_echo(frame):
            original_write(frame)
            if frame[1] == 5:
                self.fake.buffer.clear()
        with patch.object(self.fake, 'write', side_effect=lose_write_echo):
            with self.assertRaisesRegex(ModbusError, '仍开启'):
                await self.client.write_output(0, False)
        self.assertFalse(self.client.connected)

    async def test_lost_open_echo_never_retries_or_assumes_success(self):
        self.client.timeout_s = .02
        original_write = self.fake.write
        def lose_write_echo(frame):
            original_write(frame)
            self.fake.buffer.clear()
        with patch.object(self.fake, 'write', side_effect=lose_write_echo):
            with self.assertRaises(DamResponseTimeout):
                await self.client.write_output(0, True)
        self.assertEqual(len(self.fake.writes), 1)
        self.assertFalse(self.client.connected)

    async def test_cancelling_pending_serial_read_closes_after_worker_finishes(self):
        original_read = self.fake.read
        def delayed_read(count):
            time.sleep(.025)
            return original_read(count)
        with patch.object(self.fake, 'read', side_effect=delayed_read):
            task = asyncio.create_task(self.client.read_inputs())
            await asyncio.sleep(.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse(self.client.connected)


class DamConfiguration(unittest.TestCase):
    def test_shared_gauge_port_rejected(self):
        with self.assertRaises(ValidationError):
            AppConfig(tpg_connection='usb', tpg_serial_port='COM3', dam_serial_port='com3')
    def test_channel_limits_and_broadcast(self):
        for values in ({'valve_closed_di':8}, {'dam_unit_id':0}):
            with self.assertRaises(ValidationError): AppConfig(**values)
        self.assertEqual(AppConfig(open_output=7).open_output,7)
        self.assertEqual(AppConfig(dam_unit_id=254).dam_unit_id,254)
