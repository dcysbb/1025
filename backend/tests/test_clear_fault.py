import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from app.configuration import ConfigurationStore
from app.engine import InterlockEngine, InterlockError
from app.storage import HistoryStore
from app.drivers.adam6050 import ModbusError


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
