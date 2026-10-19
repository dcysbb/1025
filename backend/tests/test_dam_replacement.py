import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.configuration import ConfigurationStore
from app.drivers.adam6050 import ModbusError
from app.engine import InterlockEngine, InterlockError
from app.models import AppConfig
from app.storage import HistoryStore


class DamReplacementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = ConfigurationStore(root)
        self.store.update(AppConfig(mode='real', dam_serial_port='COM5',
            tpg_connection='usb', tpg_serial_port='COM3', fail_closed_confirmed=True))
        self.history = HistoryStore(root / 'history.sqlite3')
        self.engine = InterlockEngine(self.store, self.history)
        self.engine.interlock = 'fault'
        self.engine.trip_reason = 'DAM 连续三次重连失败，请人工复位'
        self.engine._io_manual_reset_required = True
        self.engine._off_retry_pending = True
        self.old = self.engine.adam = AsyncMock()
        self.device = AsyncMock()
        self.device.read_inputs.return_value = [False] * 8
        self.device.read_outputs.return_value = [False] * 8
        self.factory = patch('app.engine.Dam0808DClient', return_value=self.device).start()
        self.ports = patch('serial.tools.list_ports.comports',
            return_value=[SimpleNamespace(device='COM9')]).start()
        self.addCleanup(patch.stopall)

    async def asyncTearDown(self):
        self.history.close()
        self.temp.cleanup()

    async def test_verified_replacement_retains_fault_and_other_configuration_without_writes(self):
        before = self.engine.config.model_dump()
        self.engine._debug_deadlines[2] = 123
        self.engine.tpg = AsyncMock()
        await self.engine.replace_dam('COM9', True, True, 'test_operator')
        expected = {**before, 'dam_serial_port': 'COM9', 'fail_closed_confirmed': False}
        self.assertEqual(self.engine.config.model_dump(), expected)
        self.assertEqual(ConfigurationStore(Path(self.temp.name)).get_config().model_dump(), expected)
        self.assertIs(self.engine.adam, self.device)
        self.assertTrue(self.engine._adam_connected)
        self.assertFalse(self.engine._off_retry_pending)
        self.assertTrue(self.engine._io_manual_reset_required)
        self.assertEqual(self.engine.interlock, 'fault')
        self.assertEqual(self.engine._debug_deadlines, {})
        self.assertEqual(self.engine.snapshot()['valve'], 'unknown')
        self.factory.assert_called_once_with('COM9', 9600, 1)
        self.device.write_output.assert_not_awaited()
        self.old.write_output.assert_not_awaited()
        self.engine.tpg.connect.assert_not_awaited()
        # Existing acknowledgement verifies OFF again and leaves interlock disabled.
        await self.engine.clear_fault()
        self.device.write_output.assert_awaited_once_with(0, False)
        self.assertEqual(self.engine.interlock, 'disarmed')
        self.assertFalse(self.engine._io_manual_reset_required)
        self.assertFalse(self.engine.config.fail_closed_confirmed)

    async def test_no_confirmation_or_wrong_state_never_opens_candidate(self):
        for removed, wiring in ((False, True), (True, False)):
            with self.assertRaises(InterlockError):
                await self.engine.replace_dam('COM9', removed, wiring)
        for state in ('armed', 'disarmed', 'tripped'):
            self.engine.interlock = state
            with self.assertRaises(InterlockError):
                await self.engine.replace_dam('COM9', True, True)
        self.factory.assert_not_called()

    async def test_old_port_present_missing_candidate_and_protected_gauge_are_rejected(self):
        for port_list, new_port in ((['COM5', 'COM9'], 'COM9'), ([], 'COM9'), (['COM3'], 'COM3')):
            self.ports.return_value = [SimpleNamespace(device=p) for p in port_list]
            with self.assertRaises((InterlockError, ValueError)):
                await self.engine.replace_dam(new_port, True, True)
        self.factory.assert_not_called()
        self.assertEqual(self.engine.config.dam_serial_port, 'COM5')

    async def test_on_or_incomplete_outputs_do_not_change_route_or_release_latch(self):
        for outputs in ([True] + [False] * 7, [False] * 7):
            self.device.read_outputs.return_value = outputs
            with self.assertRaises(InterlockError):
                await self.engine.replace_dam('COM9', True, True)
            self.assertEqual(self.engine.config.dam_serial_port, 'COM5')
            self.assertTrue(self.engine._off_retry_pending)
            self.assertTrue(self.engine._io_manual_reset_required)
            self.assertIs(self.engine.adam, self.old)
        self.assertEqual(self.device.close.await_count, 2)
        self.device.write_output.assert_not_awaited()

    async def test_communication_failure_preserves_configuration_and_fault(self):
        self.device.read_outputs.side_effect = ModbusError('timeout')
        with self.assertRaises(ModbusError):
            await self.engine.replace_dam('COM9', True, True)
        self.assertEqual(self.store.get_config().dam_serial_port, 'COM5')
        self.assertTrue(self.engine._off_retry_pending)
        self.assertEqual(self.engine.interlock, 'fault')
        self.device.close.assert_awaited_once()

    async def test_reverse_mapping_requires_close_coil_state_before_adopting_replacement(self):
        self.engine.config.valve_open_on_energized = False
        with self.assertRaises(InterlockError):
            await self.engine.replace_dam('COM9', True, True)
        self.assertEqual(self.engine.config.dam_serial_port, 'COM5')
        self.device.read_outputs.return_value = [True] + [False] * 7
        await self.engine.replace_dam('COM9', True, True)
        self.assertEqual(self.engine.config.dam_serial_port, 'COM9')
        self.assertEqual(self.engine.interlock, 'fault')
        self.assertTrue(self.engine._io_manual_reset_required)
        self.device.write_output.assert_not_awaited()

