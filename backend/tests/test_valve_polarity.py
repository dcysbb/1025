import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.configuration import ConfigurationStore
from app.drivers.adam6050 import ModbusError
from app.engine import InterlockEngine, InterlockError
from app.models import AppConfig
from app.storage import HistoryStore


class ValvePolarityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = ConfigurationStore(root)
        self.store.update(AppConfig(valve_open_on_energized=False))
        self.history = HistoryStore(root / 'history.sqlite3')
        self.e = InterlockEngine(self.store, self.history)
        await self.e._poll_tpg()

    async def asyncTearDown(self):
        await self.e.stop()
        self.history.close()
        self.temp.cleanup()

    async def real_device(self, polarity=False):
        self.e.mode = self.e.config.mode = 'real'
        self.e.config.valve_open_on_energized = polarity
        self.e.config.fail_closed_confirmed = True
        self.e.config.dam_serial_port = 'COM4'
        self.e.config.tpg_connection = 'usb'
        self.e.config.tpg_serial_port = 'COM3'
        self.e.tpg = AsyncMock()
        self.coils = [False] * 8
        self.coils[0] = not polarity
        self.device = self.e.adam = AsyncMock()
        self.device.read_inputs.return_value = [True] + [False] * 7
        self.device.read_outputs.side_effect = lambda: list(self.coils)
        self.device.write_output.side_effect = lambda channel, value: self.coils.__setitem__(channel, value)
        await self.e._poll_io()
        return self.device

    async def test_legacy_config_defaults_and_boolean_validation(self):
        self.assertTrue(AppConfig.model_validate({}).valve_open_on_energized)
        with self.assertRaises(ValueError):
            AppConfig(valve_open_on_energized='false')

    async def test_simulation_reports_physical_coil_and_moves_by_logical_request(self):
        self.assertTrue((await self.e.debug_relays())['outputs'][0])
        self.e.interlock = 'armed'
        await self.e.open_valve()
        self.assertFalse((await self.e.debug_relays())['outputs'][0])
        await asyncio.sleep(.46)
        await self.e._poll_tpg()
        self.assertEqual(self.e.snapshot()['valve'], 'open')
        await self.e.close_valve()
        self.assertTrue((await self.e.debug_relays())['outputs'][0])
        await asyncio.sleep(.46)
        await self.e._poll_tpg()
        self.assertEqual(self.e.snapshot()['valve'], 'closed')

    async def test_real_open_close_and_pressure_trip_use_mapped_coil_values(self):
        device = await self.real_device()
        self.e.interlock = 'armed'
        await self.e.open_valve()
        self.assertFalse(self.coils[0])
        self.e._channels[0]['pressure_pa'] = .02
        with patch.object(self.e, '_poll_tpg', new=AsyncMock()):
            await self.e._tick(time.monotonic())
        self.assertTrue(self.coils[0])
        self.assertEqual(self.e.interlock, 'tripped')
        self.assertEqual([call.args for call in device.write_output.await_args_list], [(0, False), (0, True)])

    async def test_arm_reset_fault_clear_and_stop_all_request_mapped_close(self):
        device = await self.real_device()
        self.e.config.recovery_hold_s = 0
        self.e._recovery_since = time.monotonic() - 5
        with patch.object(self.e, '_poll_tpg', new=AsyncMock()):
            await self.e.arm()
            self.e.interlock = 'fault'
            await self.e.reset()
        self.e.interlock = 'fault'
        await self.e.clear_fault()
        await self.e.stop()
        self.assertTrue(device.write_output.await_count >= 4)
        self.assertTrue(all(call.args == (0, True) for call in device.write_output.await_args_list))
        self.assertEqual(self.e.interlock, 'disarmed')

    async def test_debug_release_is_opening_and_timer_cleanup_energizes_close(self):
        self.e.interlock = 'fault'
        with self.assertRaises(InterlockError):
            await self.e.debug_set_relay(0, False, 0)
        await self.e.debug_set_relay(0, True, 0)
        self.e.interlock = 'disarmed'
        await self.e.debug_set_relay(0, False, 1)
        self.assertIn(0, self.e._debug_deadlines)
        self.e._debug_deadlines[0] = time.monotonic() - 1
        await self.e._expire_debug_outputs()
        self.assertTrue((await self.e.debug_relays())['outputs'][0])
        self.assertNotIn(0, self.e._debug_deadlines)
        await self.e.debug_set_relay(0, False, 0)
        await self.e._clear_debug_outputs()
        self.assertTrue((await self.e.debug_relays())['outputs'][0])
        self.assertFalse(self.e._open_output)

    async def test_polarity_save_closes_old_and_new_latches_and_revokes_confirmation(self):
        device = await self.real_device(polarity=True)
        self.e.interlock = 'armed'
        await self.e.patch_config({'valve_open_on_energized': False})
        self.assertEqual([call.args for call in device.write_output.await_args_list], [(0, False), (0, True)])
        self.assertEqual(self.e.interlock, 'tripped')
        self.assertFalse(self.e.config.fail_closed_confirmed)
        self.assertFalse(ConfigurationStore(Path(self.temp.name)).get_config().valve_open_on_energized)

    async def test_unconfirmed_old_close_prevents_polarity_change(self):
        device = await self.real_device(polarity=True)
        device.write_output.side_effect = ModbusError('old close failed')
        with self.assertRaises(InterlockError):
            await self.e.patch_config({'valve_open_on_energized': False})
        self.assertTrue(self.e.config.valve_open_on_energized)
        self.assertEqual(device.write_output.await_args.args, (0, False))
        device.write_output.side_effect = None

    async def test_combined_channel_and_polarity_save_closes_only_old_then_new_target(self):
        device = await self.real_device(polarity=True)
        await self.e.patch_config({'open_output': 2, 'valve_open_on_energized': False})
        self.assertEqual([call.args for call in device.write_output.await_args_list], [(0, False), (2, True)])
        self.assertFalse(self.e.config.fail_closed_confirmed)

    async def test_reverse_debug_open_release_stays_blocked_when_audit_is_unavailable(self):
        await self.real_device()
        self.e._history_error = 'audit unavailable'
        with self.assertRaises(InterlockError):
            await self.e.debug_set_relay(0, False, 0)
        await self.e.debug_set_relay(0, True, 0)
        self.device.write_output.assert_awaited_once_with(0, True)

    async def test_failed_new_close_keeps_new_mapping_faulted_and_retries_only_close(self):
        device = await self.real_device(polarity=True)
        device.write_output.side_effect = [None, ModbusError('new close failed')]
        await self.e.patch_config({'valve_open_on_energized': False})
        self.assertEqual(self.e.interlock, 'fault')
        self.assertTrue(self.e._off_retry_pending)
        self.assertFalse(self.e.config.valve_open_on_energized)
        self.assertFalse(self.e.config.fail_closed_confirmed)
        device.write_output.side_effect = None
        device.write_output.reset_mock()
        await self.e._safe_open_output()
        device.write_output.assert_awaited_once_with(0, True)

