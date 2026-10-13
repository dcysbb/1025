import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.configuration import ConfigurationStore
from app.engine import InterlockEngine, InterlockError
from app.storage import HistoryStore
from app.drivers.adam6050 import ModbusError
from app.drivers.tpg366 import TPG366Error


class ClearFault(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.history=HistoryStore(Path(self.temp.name)/'history.sqlite3')
        self.e=InterlockEngine(ConfigurationStore(Path(self.temp.name)),self.history)
        await self.e._poll_tpg()

    async def asyncTearDown(self):
        await self.e.stop();self.history.close();self.temp.cleanup()

    async def test_clear_real_fault_without_setpoint_or_wiring_confirmation(self):
        self.e.mode='real';self.e.interlock='fault';self.e.trip_reason='关闭位置反馈超时'
        self.e._valve_command='close';self.e._valve_command_at=time.monotonic()-10
        self.e.config.fail_closed_confirmed=False
        self.e._adam_connected=True;self.e.adam=AsyncMock();self.e.adam.connected=True
        self.e.adam.read_inputs.return_value=[False]*8
        self.e.adam.read_outputs.return_value=[False]*8
        await self.e.clear_fault()
        self.assertEqual(self.e.interlock,'disarmed')
        self.assertIsNone(self.e.trip_reason)
        self.assertIsNone(self.e._valve_command)
        self.e.adam.write_output.assert_awaited_once_with(self.e.config.open_output,False)
        self.assertEqual(self.e.snapshot()['valve'],'unknown')
        with self.assertRaises(InterlockError):self.e._validate_arm()

    async def test_old_motion_timeout_does_not_retrip_after_acknowledgement(self):
        await self.e.trip('motion timeout',fault=True)
        self.e._valve_command_at=time.monotonic()-10
        await self.e.clear_fault()
        await self.e._tick(time.monotonic())
        self.assertEqual(self.e.interlock,'disarmed')

    async def test_pressure_hysteresis_is_still_required_for_rearming(self):
        await self.e.trip('pressure trip')
        self.e._sim_pressure[0]=.008  # below trip .01, above reset .005
        await self.e._poll_tpg()
        await self.e.clear_fault()
        with self.assertRaisesRegex(InterlockError,'恢复阈值'):await self.e.arm()
        self.assertEqual(self.e.interlock,'disarmed')

    async def test_failed_output_off_does_not_clear_fault(self):
        self.e.mode='real';self.e.interlock='fault';self.e._adam_connected=True
        self.e.adam=AsyncMock();self.e.adam.write_output.side_effect=ModbusError('timeout')
        with self.assertRaisesRegex(InterlockError,'撤销'):await self.e.clear_fault()
        self.assertEqual(self.e.interlock,'fault')
        self.e.adam.write_output.side_effect=None

    async def test_disconnected_cached_state_reopens_and_clears_without_gauge(self):
        self.e.mode='real';self.e.interlock='fault'
        self.e._adam_connected=False;self.e._io_error='USB response timed out'
        self.e._tpg_connected=False
        self.e.adam=AsyncMock()
        self.e.adam.read_inputs.return_value=[False]*8
        self.e.adam.read_outputs.return_value=[False]*8
        await self.e.clear_fault()
        self.e.adam.close.assert_awaited_once()
        self.e.adam.connect.assert_awaited_once()
        self.e.adam.write_output.assert_awaited_once_with(0,False)
        self.assertEqual(self.e.interlock,'disarmed')
        self.assertTrue(self.e._adam_connected)
        self.assertIsNone(self.e._io_error)
        self.assertFalse(self.e._tpg_connected)

    async def test_missing_driver_is_created_from_config_during_clear(self):
        self.e.mode='real';self.e.interlock='fault';self.e._adam_connected=False
        self.e.config.dam_serial_port='COM4';self.e.adam=None
        device=AsyncMock()
        device.read_inputs.return_value=[False]*8
        device.read_outputs.return_value=[False]*8
        with patch('app.engine.Dam0808DClient',return_value=device) as factory:
            await self.e.clear_fault()
        factory.assert_called_once_with('COM4',9600,1)
        device.write_output.assert_awaited_once_with(0,False)
        self.assertEqual(self.e.interlock,'disarmed')

    async def test_failed_reconnection_keeps_fault_and_invalidates_io_feedback(self):
        self.e.mode='real';self.e.interlock='fault';self.e.trip_reason='old fault'
        self.e._adam_connected=True;self.e.adam=AsyncMock()
        self.e.adam.connect.side_effect=ModbusError('USB adapter unavailable')
        with self.assertRaisesRegex(InterlockError,'USB adapter unavailable'):
            await self.e.clear_fault()
        self.assertEqual(self.e.interlock,'fault')
        self.assertEqual(self.e.trip_reason,'old fault')
        self.assertFalse(self.e._adam_connected)
        self.e.adam.write_output.assert_not_awaited()
        self.assertEqual(self.e.snapshot()['valve'],'unknown')

    async def test_gauge_failure_does_not_skip_io_recovery(self):
        self.e.mode='real';self.e.tpg=AsyncMock();self.e.adam=AsyncMock()
        self.e._adam_connected=False;self.e._io_error='old I/O error'
        self.e.adam.read_inputs.return_value=[True]+[False]*7
        self.e.adam.read_outputs.return_value=[False]*8
        with patch.object(self.e,'_poll_tpg',side_effect=TPG366Error('gauge unplugged')):
            await self.e._tick(time.monotonic())
        self.e.adam.read_inputs.assert_awaited_once()
        self.assertTrue(self.e._adam_connected)
        self.assertIsNone(self.e._io_error)
        self.assertFalse(self.e._tpg_connected)
        self.assertEqual(self.e.snapshot()['valve'],'closed')

    async def test_failed_io_poll_backs_off_without_refreshing_stale_feedback(self):
        self.e.mode='real';self.e.tpg=AsyncMock();self.e.adam=AsyncMock()
        self.e._last_io_read=time.monotonic()-10
        last_good=self.e._last_io_read
        self.e.adam.read_inputs.side_effect=ModbusError('adapter unavailable')
        with patch.object(self.e,'_poll_tpg',new=AsyncMock()):
            await self.e._tick(time.monotonic())
            await self.e._tick(time.monotonic())
        self.e.adam.read_inputs.assert_awaited_once()
        self.assertFalse(self.e._adam_connected)
        self.assertEqual(self.e._last_io_read,last_good)

    async def test_motion_timeout_does_not_repeat_off_writes_on_every_tick(self):
        self.e.mode='real';self.e.tpg=AsyncMock();self.e.adam=AsyncMock()
        self.e.adam.read_inputs.return_value=[False]*8
        self.e.adam.read_outputs.return_value=[False]*8
        self.e._valve_command='close';self.e._valve_command_at=time.monotonic()-10
        with patch.object(self.e,'_poll_tpg',new=AsyncMock()):
            for _ in range(3):
                await self.e._tick(time.monotonic())
        self.e.adam.write_output.assert_awaited_once_with(0,False)
        self.assertEqual(self.e.interlock,'fault')
        self.assertTrue(self.e._motion_timed_out)
        await self.e.close_valve()
        self.assertFalse(self.e._motion_timed_out)

    async def test_failed_off_is_retried_later_without_auto_rearming(self):
        self.e.mode='real';self.e.tpg=AsyncMock();self.e.adam=AsyncMock()
        self.e.adam.read_inputs.return_value=[True]+[False]*7
        self.e.adam.read_outputs.return_value=[False]*8
        self.e.adam.write_output.side_effect=ModbusError('temporarily unavailable')
        await self.e.trip('I/O error',fault=True)
        self.assertTrue(self.e._off_retry_pending)
        self.e.adam.write_output.side_effect=None
        with patch.object(self.e,'_poll_tpg',new=AsyncMock()):
            await self.e._tick(time.monotonic())
            self.assertEqual(self.e.adam.write_output.await_count,1)
            self.e._next_off_retry=0
            await self.e._tick(time.monotonic())
        self.assertEqual(self.e.adam.write_output.await_count,2)
        self.assertFalse(self.e._off_retry_pending)
        self.assertEqual(self.e.interlock,'fault')
