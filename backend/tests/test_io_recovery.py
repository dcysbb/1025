import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.configuration import ConfigurationStore
from app.drivers.adam6050 import ModbusError
from app.engine import InterlockEngine, InterlockError
from app.storage import HistoryStore


class IoRecovery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.history = HistoryStore(Path(self.temp.name) / 'history.sqlite3')
        self.e = InterlockEngine(ConfigurationStore(Path(self.temp.name)), self.history)
        await self.e._poll_tpg()
        self.e.mode = self.e.config.mode = 'real'
        self.e.config.dam_serial_port = 'COM4'
        self.e.adam = AsyncMock()
        self.e.adam.read_inputs.return_value = [True] + [False]*7
        self.e.adam.read_outputs.return_value = [False]*8
        self.e._last_io_read = time.monotonic()
        self.e._adam_connected = True

    async def asyncTearDown(self):
        await self.e.stop()
        self.history.close()
        self.temp.cleanup()

    async def test_three_reconnections_follow_initial_failure_then_require_manual_reset(self):
        self.e.adam.read_inputs.side_effect = ModbusError('timeout')
        await self.e._io_cycle()  # Initial failed poll is not a reconnect.
        self.assertEqual(self.e._io_reconnect_attempt, 0)
        for attempt in (1, 2, 3):
            await self.e._io_cycle()
            self.assertEqual(self.e._io_reconnect_attempt, attempt)
            self.assertEqual(self.e._io_manual_reset_required, attempt == 3)
        self.e.adam.connect.assert_awaited()
        self.assertEqual(self.e.adam.connect.await_count, 3)
        self.assertEqual(self.e.interlock, 'fault')
        self.assertIn('三次', self.e.trip_reason)
        reads = self.e.adam.read_inputs.await_count
        await self.e._io_cycle()
        self.assertEqual(self.e.adam.read_inputs.await_count, reads)

    async def test_success_on_third_attempt_keeps_working_and_resets_next_outage_budget(self):
        self.e.interlock = 'armed'
        self.e._open_output = True
        self.e.adam.read_outputs.return_value = [True] + [False]*7
        self.e.adam.read_inputs.side_effect = [ModbusError('first'), ModbusError('one'), ModbusError('two'), [False]*8]
        for _ in range(4):
            await self.e._io_cycle()
        self.assertTrue(self.e._adam_connected)
        self.assertEqual(self.e.interlock, 'armed')
        self.assertTrue(self.e._open_output)
        self.assertFalse(self.e._io_reconnecting)
        self.assertEqual(self.e._io_reconnect_attempt, 0)
        self.e.adam.write_output.assert_not_awaited()
        self.e.adam.read_inputs.side_effect = ModbusError('new outage')
        await self.e._io_cycle()
        self.assertEqual(self.e._io_reconnect_attempt, 0)

    async def test_recovery_blocks_new_open_but_does_not_latch_transient_io_fault(self):
        self.e.interlock = 'armed'
        self.e.adam.read_inputs.side_effect = ModbusError('temporary')
        with patch.object(self.e, '_poll_tpg', new=AsyncMock()):
            await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'armed')
        self.assertEqual(self.e.snapshot()['valve'], 'unknown')
        with self.assertRaises(InterlockError):
            self.e._check_fresh()

    async def test_pressure_fault_still_trips_during_reconnection(self):
        self.e.interlock = 'armed'
        self.e._begin_io_recovery('timeout')
        self.e._channels[0]['pressure_pa'] = .02
        with patch.object(self.e, '_poll_tpg', new=AsyncMock()):
            await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'tripped')
        self.e.adam.write_output.assert_awaited_once_with(0, False)

    async def test_pressure_spike_is_retained_even_if_next_sample_recovers_before_tick(self):
        self.e.interlock = 'armed'
        self.e.tpg = AsyncMock()
        with patch.object(self.e, '_poll_tpg', new=AsyncMock()):
            self.e._channels[0]['pressure_pa'] = .02
            await self.e._gauge_cycle(time.monotonic())
            self.e._channels[0]['pressure_pa'] = .001
            await self.e._gauge_cycle(time.monotonic())
            await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock, 'tripped')
        self.assertIn('阈值', self.e.trip_reason)

    async def test_pressure_trip_cancels_background_poll_before_off_write(self):
        entered = asyncio.Event()
        async def slow_inputs():
            entered.set()
            await asyncio.Event().wait()
        self.e.adam.read_inputs.side_effect = slow_inputs
        self.e._io_task = asyncio.create_task(self.e._io_cycle())
        await entered.wait()
        await asyncio.wait_for(self.e.trip('pressure spike'), 1)
        self.assertIsNone(self.e._io_task)
        self.e.adam.read_outputs.assert_not_awaited()
        self.e.adam.write_output.assert_awaited_once_with(0, False)

    async def test_recovery_never_pushes_a_new_close_timer_into_the_future(self):
        self.e._begin_io_recovery('offline')
        self.e._io_recovery_at = time.monotonic() - 20
        self.e._valve_command = 'close'
        self.e._valve_command_at = time.monotonic() - 1
        self.e._finish_io_recovery()
        self.assertLessEqual(self.e._valve_command_at, time.monotonic())

    async def test_pressure_sampling_and_status_continue_during_slow_io(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def slow_io():
            entered.set()
            await release.wait()
            return [True]+[False]*7
        self.e.adam.read_inputs.side_effect = slow_io
        calls = 0
        async def sample():
            nonlocal calls
            calls += 1
            self.e._last_tpg_read = time.monotonic()
            self.e._tpg_connected = True
        with patch.object(self.e, '_poll_tpg', side_effect=sample):
            self.e.tpg = AsyncMock()
            await self.e.start()
            await asyncio.wait_for(entered.wait(), 1)
            await asyncio.sleep(.25)
            self.assertGreaterEqual(calls, 2)
            self.assertLess(self.e.snapshot()['sample_age_s'], .15)
            release.set()
            await self.e.stop()

    async def test_manual_reset_restores_auto_monitoring_without_arming(self):
        self.e.interlock = 'fault'
        self.e._io_manual_reset_required = True
        self.e._adam_connected = False
        await self.e.clear_fault()
        self.assertFalse(self.e._io_manual_reset_required)
        self.assertEqual(self.e.interlock, 'disarmed')
        self.assertTrue(self.e._adam_connected)

    async def test_connect_button_does_not_bypass_exhausted_recovery_latch(self):
        self.e.interlock = 'fault'
        self.e._io_manual_reset_required = True
        with patch.object(self.e, 'connect_gauge', new=AsyncMock(return_value={'ok': True})):
            result = await self.e.connect_devices()
        self.assertFalse(result['adam']['ok'])
        self.e.adam.read_inputs.assert_not_awaited()
        self.assertTrue(self.e._io_manual_reset_required)

    async def test_debug_reads_use_cache_and_do_not_add_serial_traffic(self):
        await self.e._poll_io()
        self.e.adam.read_outputs.reset_mock()
        self.e._io_outputs[0] = True
        self.assertTrue((await self.e.debug_relays())['outputs'][0])
        self.e.adam.read_outputs.assert_not_awaited()

    async def test_failed_debug_write_enters_recovery_and_retains_off_obligation(self):
        self.e.adam.write_output.side_effect = ModbusError('echo lost')
        with self.assertRaises(ModbusError):
            await self.e.debug_set_relay(0, True, 0)
        self.assertTrue(self.e._io_reconnecting)
        self.assertIn(0, self.e._debug_deadlines)
        self.assertFalse(self.e._adam_connected)
        self.e.adam.write_output.side_effect = None

    async def test_latency_is_acquisition_duration_and_stale_channels_are_invalid(self):
        self.e.mode = 'simulation'
        await self.e._poll_tpg()
        latency = self.e.snapshot()['sample_latency_s']
        self.e._last_tpg_read = time.monotonic() - 86400
        status = self.e.snapshot()
        self.assertEqual(status['sample_latency_s'], latency)
        self.assertTrue(status['sample_stale'])
        self.assertTrue(all(not sample['valid'] for sample in status['channels']))
