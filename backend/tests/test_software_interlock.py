import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.configuration import ConfigurationStore
from app.engine import InterlockEngine, InterlockError
from app.models import AppConfig
from app.storage import HistoryStore


class SoftwareInterlock(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = ConfigurationStore(self.root)
        self.history = HistoryStore(self.root / 'history.sqlite3')
        self.e = InterlockEngine(self.store, self.history)
        await self.e._poll_tpg()
        self.e.mode = self.e.config.mode = 'real'
        self.e.config.tpg_serial_port = 'COM3'
        self.e.config.tpg_connection = 'usb'
        self.e.config.dam_serial_port = 'COM4'
        self.e.config.fail_closed_confirmed = True
        # Former pressure-permit DI1 is now available as a valve sensor.
        self.e.config.valve_closed_di = 1
        self.e._io_inputs = [False, True] + [False] * 6
        self.e._last_io_read = time.monotonic()
        self.e._adam_connected = True
        self.e.adam = AsyncMock()
        self.e.adam.connected = True
        self.e.adam.read_inputs.return_value = self.e._io_inputs
        self.outputs = [False] * 8
        self.e.adam.read_outputs.side_effect = lambda: list(self.outputs)
        async def write(channel, value):
            self.outputs[channel] = value
        self.e.adam.write_output.side_effect = write
        self.e.tpg = AsyncMock()
        async def pressure_sample():
            self.e._last_tpg_read = time.monotonic()
            self.e._tpg_connected = True
        self.poll_patch = patch.object(self.e, '_poll_tpg', side_effect=pressure_sample)
        self.poll_patch.start()

    async def asyncTearDown(self):
        await self.e.stop()
        self.poll_patch.stop()
        self.history.close()
        self.temp.cleanup()

    async def test_real_arm_open_and_reset_use_only_valve_relay(self):
        await self.e.arm()
        await self.e.open_valve()
        self.assertTrue(self.outputs[0])
        self.e._channels[0]['pressure_pa'] = .02
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'tripped')
        self.assertFalse(self.outputs[0])
        self.assertFalse(self.e.snapshot()['pressure_ok'])
        self.e._channels[0]['pressure_pa'] = .001
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'tripped')
        self.e.config.recovery_hold_s = 0
        self.e._recovery_since = time.monotonic() - 1
        await self.e.reset()
        self.assertEqual(self.e.interlock, 'armed')
        self.assertFalse(self.outputs[0])
        self.assertTrue(all(call.args[0] == 0 for call in self.e.adam.write_output.await_args_list))
        self.e.tpg.configure_setpoint.assert_not_awaited()

    async def test_stale_io_blocks_open_and_trips_running_interlock(self):
        await self.e.arm()
        self.e._last_io_read = time.monotonic() - 10
        with self.assertRaisesRegex(InterlockError, 'I/O 数据已超时'):
            await self.e.open_valve()
        with patch.object(self.e, '_poll_io', new=AsyncMock()):
            await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'fault')
        self.assertFalse(self.outputs[0])

    async def test_invalid_reading_and_conflicting_sensors_still_close(self):
        await self.e.arm()
        await self.e.open_valve()
        self.e._channels[0]['valid'] = False
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'tripped')
        self.assertFalse(self.outputs[0])
        self.e.config.valve_open_di = 4
        self.e._io_inputs[4] = True
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'fault')
        self.assertEqual(self.e.snapshot()['valve'], 'fault')

    async def test_legacy_confirmation_does_not_block_arm_or_close(self):
        self.e.config.fail_closed_confirmed = False
        await self.e.arm()
        self.assertEqual(self.e.interlock, 'armed')
        self.assertFalse(self.e.config.fail_closed_confirmed)
        await self.e.close_valve()
        self.e.adam.write_output.assert_awaited_with(0, False)

    async def test_arm_rechecks_closed_feedback_after_reading_devices(self):
        self.e.adam.read_inputs.return_value = [False] * 8
        with self.assertRaisesRegex(InterlockError, '关闭位置反馈'):
            await self.e.arm()
        self.assertEqual(self.e.interlock, 'fault')
        self.assertFalse(self.outputs[0])

    async def test_sensor_conflict_trips_before_any_open_command(self):
        await self.e.arm()
        self.e.config.valve_open_di = 4
        self.e._io_inputs[4] = True
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'fault')
        self.assertIn('同时有效', self.e.trip_reason)
        self.assertFalse(self.outputs[0])

    async def test_legacy_config_keeps_real_ports_without_external_fields(self):
        data = json.loads(self.store.path.read_text(encoding='utf-8'))
        data['config'] = self.e.config.model_dump()
        data['config'].update(permit_ok_di=1, watchdog_ok_di=2, latch_ready_di=3,
                              heartbeat_output=1, reset_output=2,
                              external_watchdog_confirmed=False)
        data['password_hash'] = 'preserved-hash'
        self.store.path.write_text(json.dumps(data), encoding='utf-8')
        migrated = ConfigurationStore(self.root)
        config = migrated.get_config()
        self.assertEqual(config.mode, 'real')
        self.assertEqual(config.dam_serial_port, 'COM4')
        self.assertEqual(config.valve_closed_di, 1)
        self.assertEqual(migrated.password_hash, 'preserved-hash')
        self.assertNotIn('permit_ok_di', config.model_dump())
        with self.assertRaises(ValueError):
            AppConfig(valve_closed_di=1, valve_open_di=1)
