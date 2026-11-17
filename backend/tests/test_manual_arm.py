import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from app.configuration import ConfigurationStore
from app.engine import InterlockEngine, InterlockError
from app.storage import HistoryStore


class ManualArmTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.history = HistoryStore(root / 'history.sqlite3')
        self.e = InterlockEngine(ConfigurationStore(root), self.history)
        await self.e._poll_tpg()
        for sample in self.e._channels:
            sample['pressure_pa'] = .008

    async def asyncTearDown(self):
        await self.e.stop()
        self.history.close()
        self.temp.cleanup()

    async def test_open_valve_and_debug_output_are_preserved_when_arming(self):
        await self.e.debug_set_relay(0, True, 0)
        await self.e.debug_set_relay(7, True, 0)
        await self.e._poll_tpg()
        self.e._sim_state = 'open'
        before = list(self.e._debug_sim_outputs)
        await self.e.arm()
        self.assertEqual(self.e.interlock, 'armed')
        self.assertEqual(self.e._debug_sim_outputs, before)
        self.assertTrue(self.e._open_output)
        self.assertEqual(set(self.e._debug_deadlines), {0, 7})
        self.assertIsNone(self.e._valve_command)
        self.assertEqual(self.e.snapshot()['valve'], 'open')
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'armed')
        self.assertEqual(self.e.snapshot()['valve'], 'open')

    async def test_real_arm_uses_pressure_without_io_or_history_prerequisites(self):
        self.e.mode = self.e.config.mode = 'real'
        self.e._adam_connected = False
        self.e._last_io_read = 0
        self.e._io_error = 'I/O unavailable'
        self.e._history_error = 'History unavailable'
        self.e._rearm_required = True
        self.e._recovery_since = None
        self.e.adam = AsyncMock()
        self.e.tpg = AsyncMock()
        await self.e.arm()
        self.assertEqual(self.e.interlock, 'armed')
        self.assertFalse(self.e.adam.mock_calls)
        self.assertFalse(self.e.tpg.mock_calls)

    async def test_direct_rearm_uses_trip_threshold_in_every_nonarmed_state(self):
        for state in ('disarmed', 'ready', 'tripped', 'fault'):
            with self.subTest(state=state):
                self.e.interlock = state
                self.e.trip_reason = 'previous fault'
                self.e._rearm_required = True
                self.e._recovery_since = None
                self.e._valve_command = 'close'
                self.e._valve_command_at = time.monotonic() - 100
                self.e._pending_gauge_trip = ('previous overpressure', 'pressure_trip')
                self.e._auto_reopen_pending = True
                await self.e.arm()
                self.assertEqual(self.e.interlock, 'armed')
                self.assertIsNone(self.e.trip_reason)
                self.assertIsNone(self.e._valve_command)
                self.assertIsNone(self.e._pending_gauge_trip)
                self.assertFalse(self.e._rearm_required)
                self.assertFalse(self.e._auto_reopen_pending)

    async def test_equal_or_higher_pressure_on_any_protected_channel_is_rejected(self):
        for pressure in (.01, .02):
            for index in range(3):
                with self.subTest(pressure=pressure, channel=index + 1):
                    self.e._channels[index]['pressure_pa'] = pressure
                    with self.assertRaisesRegex(InterlockError, f'通道 {index + 1} 压力达到关阀阈值'):
                        await self.e.arm()
                    self.assertEqual(self.e.interlock, 'disarmed')
                    self.e._channels[index]['pressure_pa'] = .008

    async def test_unavailable_or_expired_pressure_is_not_treated_as_below_threshold(self):
        for value in (None, float('nan'), float('inf')):
            self.e._channels[0]['pressure_pa'] = value
            with self.assertRaisesRegex(InterlockError, '压力读数无效'):
                await self.e.arm()
        self.e._channels[0]['pressure_pa'] = .008
        self.e._channels[0]['valid'] = False
        with self.assertRaisesRegex(InterlockError, '测量异常'):
            await self.e.arm()
        self.e._channels[0]['valid'] = True
        self.e._last_tpg_read = time.monotonic() - 10
        with self.assertRaisesRegex(InterlockError, '超时'):
            await self.e.arm()

    async def test_pressure_monitoring_still_closes_after_pressure_only_arm(self):
        await self.e.debug_set_relay(0, True, 0)
        await self.e._poll_tpg()
        await self.e.arm()
        await self.e.inject_pressure(1, .02)
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'tripped')
        self.assertFalse(self.e._open_output)

    async def test_repeated_arm_does_not_cancel_an_active_valve_command(self):
        await self.e.arm()
        self.e._valve_command = 'open'
        await self.e.arm()
        self.assertEqual(self.e._valve_command, 'open')
