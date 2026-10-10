import asyncio
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.configuration import ConfigurationStore
from app.drivers.adam6050 import Adam6050Client
from app.engine import InterlockEngine, InterlockError
from app.models import ChannelConfig
from app.storage import HistoryStore


class SafetyRegressions(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ConfigurationStore(Path(self.temp.name))
        self.history = HistoryStore(Path(self.temp.name) / 'history.sqlite3')
        self.e = InterlockEngine(self.store, self.history)
        await self.e._poll_tpg()

    async def asyncTearDown(self):
        await self.e.stop()
        self.history.close()
        self.temp.cleanup()

    async def run_ticks(self, count=8):
        for _ in range(count):
            await self.e._tick(time.monotonic())
            await asyncio.sleep(.08)

    async def test_stale_sample_cannot_open(self):
        await self.e.arm()
        self.e._last_tpg_read = time.monotonic() - 10
        with self.assertRaisesRegex(InterlockError, '超时'):
            await self.e.open_valve()
        self.assertFalse(self.e._open_output)

    async def test_disk_failure_does_not_kill_loop_and_closes(self):
        await self.e.arm()
        await self.e.open_valve()
        with (patch.object(self.history, 'write_sample', side_effect=sqlite3.OperationalError('disk full')),
              patch.object(self.history, 'write_event', side_effect=sqlite3.OperationalError('disk full'))):
            await self.e.start()
            await asyncio.sleep(.3)
            self.assertFalse(self.e._task.done())
            self.assertEqual(self.e.interlock, 'fault')
            self.assertFalse(self.e._open_output)
            self.assertFalse(self.e.snapshot()['history_recording'])
            with self.assertRaises(InterlockError):
                await self.e.reset()

    async def test_storage_recovery_does_not_reopen(self):
        await self.e.arm()
        with patch.object(self.history, 'write_sample', side_effect=sqlite3.OperationalError('readonly')):
            await self.e._record_sample()
        await self.e._record_sample()
        self.assertTrue(self.e.snapshot()['history_recording'])
        self.assertEqual(self.e.interlock, 'fault')
        self.assertFalse(self.e._open_output)

    async def test_shutdown_clears_open_and_auxiliary_outputs(self):
        class Adam:
            connected = True
            def __init__(self): self.writes = []
            async def write_output(self, channel, value): self.writes.append((channel, value))
            async def close(self): self.connected = False
        self.e.mode = 'real'
        self.e.config.io_device = 'adam6050'
        self.e.config.fail_closed_confirmed = True
        self.e.adam = Adam()
        self.e._open_output = True
        await self.e.stop()
        self.assertEqual(self.e.adam.writes, [(0, False), (2, False), (1, False)])
        self.assertFalse(self.e.adam.connected)

    async def test_dam_watchdog_checks_feedback_without_relay_pulses(self):
        self.e.mode = 'real'
        self.e.config.external_watchdog_confirmed = True
        self.e.adam = AsyncMock()
        self.e._io_inputs[self.e.config.watchdog_ok_di] = True
        with patch.object(self.e, '_poll_io', new=AsyncMock()):
            await self.e._exercise_watchdog()
        self.e.adam.write_output.assert_not_awaited()
        self.e._io_inputs[self.e.config.watchdog_ok_di] = False
        with patch.object(self.e, '_poll_io', new=AsyncMock()):
            with self.assertRaisesRegex(InterlockError, '反馈'):
                await self.e._exercise_watchdog()

    async def test_sensor_conflict_trips_and_cannot_reset(self):
        await self.e.arm()
        await self.e.open_valve()
        self.e._sim_sensor_conflict = True
        await self.run_ticks(1)
        self.assertEqual(self.e.interlock, 'fault')
        self.assertFalse(self.e._open_output)
        with self.assertRaises(InterlockError): await self.e.reset()

    async def test_default_simulation_shows_open_feedback(self):
        await self.e.arm()
        await self.e.open_valve()
        await self.run_ticks()
        self.assertEqual(self.e.snapshot()['valve'], 'open')
        self.assertTrue(self.e.snapshot()['valve_open_sensor'])

    async def test_io_fault_is_not_permissive(self):
        await self.e.inject_io_fault(True)
        self.assertFalse(self.e.snapshot()['permit_ok'])
        self.assertFalse(self.e.snapshot()['adam_connected'])

    async def test_configured_channel_four_and_thresholds(self):
        c=self.e.config.model_copy(deep=True)
        for channel in c.channels: channel.enabled=False
        c.channels[3]=ChannelConfig(enabled=True,trip_pa=.1,reset_pa=.05)
        await self.e.apply_config(c)
        await self.e.inject_pressure(4,.02)
        await self.e._poll_tpg()
        self.assertIsNone(self.e._pressure_fault())
        self.e._channels[3]['pressure_pa']=.1
        self.assertIn('通道 4',self.e._pressure_fault())

    async def test_disabling_all_protection_blocks_arm(self):
        c=self.e.config.model_copy(deep=True)
        for channel in c.channels: channel.enabled=False
        await self.e.apply_config(c)
        with self.assertRaisesRegex(InterlockError,'保护'):
            await self.e.arm()

    async def test_unit_id_change_invalidates_driver(self):
        self.e.adam=Adam6050Client('127.0.0.1',unit_id=1)
        c=self.e.config.model_copy(deep=True);c.adam_unit_id=2
        await self.e.apply_config(c)
        self.assertIsNone(self.e.adam)

    async def test_configuration_audit_before_after(self):
        c=self.e.config.model_copy(deep=True);c.recovery_hold_s=.3
        await self.e.apply_config(c)
        event=self.history.list_events(None,None,1)[0]
        self.assertEqual(event['details']['changes']['recovery_hold_s'],{'before':5.,'after':.3})

    async def test_concurrent_open_and_disarm_leave_closed(self):
        await self.e.arm()
        original=self.e._write_output
        async def delayed(channel,value):
            await asyncio.sleep(.01)
            await original(channel,value)
        with patch.object(self.e,'_write_output',side_effect=delayed):
            await asyncio.gather(self.e.open_valve(),self.e.disarm())
        self.assertEqual(self.e.interlock,'disarmed')
        self.assertFalse(self.e._open_output)

    async def test_close_failure_trips_after_timeout(self):
        self.e.config.valve_timeout_s=.5
        await self.e.arm();await self.e.open_valve();await self.run_ticks()
        self.e._sim_close_failure=True
        await self.e.close_valve();await self.run_ticks()
        self.assertEqual(self.e.interlock,'fault')
        self.assertIn('反馈超时',self.e.trip_reason)

    async def test_tpg_disconnect_trips_after_stale_timeout(self):
        self.e.config.stale_timeout_s=.5
        await self.e.arm();await self.e.open_valve()
        self.e._sim_tpg_fault=True
        await self.run_ticks()
        self.assertFalse(self.e.snapshot()['tpg_connected'])
        self.assertEqual(self.e.interlock,'fault')
        self.assertFalse(self.e._open_output)

    async def test_arrival_event_has_elapsed_time(self):
        await self.e.arm();await self.e.open_valve();await self.run_ticks()
        events=self.history.list_events(None,None,100)
        arrivals=[e for e in events if e['type']=='valve_arrived' and e['details']['position']=='open']
        self.assertEqual(len(arrivals),1)
        self.assertGreaterEqual(arrivals[0]['details']['command_to_feedback_s'],.45)

    async def test_active_low_latch(self):
        self.e.mode='real';self.e.config.latch_ready_active_high=False
        self.assertTrue(self.e._latch_ready())
        self.e._io_inputs[self.e.config.latch_ready_di]=True
        self.assertFalse(self.e._latch_ready())

    async def test_sync_failure_invalidates_previous_validation(self):
        self.e.mode='real';self.e._tpg_connected=True;self.e._setpoints_synced=True
        self.e.tpg=AsyncMock()
        self.e.tpg.configure_setpoint.side_effect=ValueError('readback mismatch')
        with self.assertRaises(ValueError):await self.e.sync_setpoints()
        self.assertFalse(self.e._setpoints_synced)

    async def test_optional_open_sensor_does_not_invent_arrival(self):
        self.e.mode='real';self.e.config.mode='real';self.e._valve_command='open'
        self.e._valve_command_at=time.monotonic()-3
        self.e._adam_connected=True;self.e._io_inputs=[False]*12
        self.e.tpg=AsyncMock();self.e.adam=AsyncMock()
        with (patch.object(self.e,'_poll_tpg',new=AsyncMock()),patch.object(self.e,'_poll_io',new=AsyncMock())):
            await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock,'disarmed')
        self.assertEqual(self.e.snapshot()['valve'],'unknown')

    async def test_filtered_paginated_audit(self):
        for i in range(5):self.history.write_event('test','critical',str(i))
        self.history.write_event('other','info','noise')
        a=self.history.list_events(None,None,2,0,'test','critical')
        b=self.history.list_events(None,None,2,2,'test','critical')
        self.assertEqual([e['message'] for e in a],['4','3'])
        self.assertEqual([e['message'] for e in b],['2','1'])
