import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from app.configuration import ConfigurationStore
from app.engine import InterlockEngine, InterlockError
from app.storage import HistoryStore
from app.drivers.adam6050 import ModbusError


class DebugRelays(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        store = ConfigurationStore(Path(self.temp.name))
        self.history = HistoryStore(Path(self.temp.name)/'history.sqlite3')
        self.e = InterlockEngine(store,self.history)

    async def asyncTearDown(self):
        await self.e.stop()
        self.history.close()
        self.temp.cleanup()

    async def test_all_eight_simulated_relays_and_manual_off(self):
        for channel in range(8):
            result = await self.e.debug_set_relay(channel,True,10)
            self.assertTrue(result['outputs'][channel])
            await self.e.debug_set_relay(channel,False,1)
        self.assertEqual((await self.e.debug_relays())['outputs'],[False]*8)
        self.assertFalse(self.e._debug_deadlines)
        self.assertTrue(any(x['type']=='debug_relay' for x in self.history.list_events(None,None)))

    async def test_auto_close_and_arm_block(self):
        await self.e.debug_set_relay(0,True,1)
        with self.assertRaisesRegex(InterlockError,'Debug'): self.e._validate_arm()
        self.e._debug_deadlines[0] = time.monotonic()-1
        await self.e._tick(time.monotonic())
        self.assertFalse((await self.e.debug_relays())['outputs'][0])

    async def test_armed_trip_fault_and_shutdown_cannot_enable(self):
        for state in ('armed','tripped','fault','ready'):
            self.e.interlock=state
            with self.assertRaises(InterlockError): await self.e.debug_set_relay(0,True,10)
        self.e.interlock='disarmed';self.e._stopping=True
        with self.assertRaises(InterlockError): await self.e.debug_set_relay(0,True,10)

    async def test_bad_channel_and_duration_rejected(self):
        for channel,duration in ((-1,10),(8,10),(0,-1),(0,.5),(0,61)):
            with self.assertRaises(InterlockError): await self.e.debug_set_relay(channel,True,duration)

    async def test_manual_output_holds_across_ticks_until_explicit_off(self):
        result = await self.e.debug_set_relay(0,True,0)
        self.assertEqual(result['remaining_s'],{})
        self.assertIsNone(self.e._debug_deadlines[0])
        for _ in range(3):
            await self.e._tick(time.monotonic()+120)
            self.assertTrue((await self.e.debug_relays())['outputs'][0])
        with self.assertRaisesRegex(InterlockError,'Debug'): self.e._validate_arm()
        await self.e.debug_set_relay(0,False,0)
        self.assertFalse((await self.e.debug_relays())['outputs'][0])
        self.assertFalse(self.e._debug_deadlines)

    async def test_disarm_and_config_change_clear_debug(self):
        await self.e.debug_set_relay(7,True,60)
        await self.e.disarm()
        self.assertFalse((await self.e.debug_relays())['outputs'][7])
        await self.e.debug_set_relay(6,True,60)
        await self.e.apply_config(self.e.config)
        self.assertFalse(self.e._debug_deadlines)
        self.assertFalse((await self.e.debug_relays())['outputs'][6])

    async def test_trip_and_close_clear_manual_outputs(self):
        await self.e.debug_set_relay(0,True,60)
        await self.e.trip('test fault')
        self.assertFalse(self.e._debug_deadlines)
        self.assertFalse((await self.e.debug_relays())['outputs'][0])
        self.e.interlock='disarmed'
        await self.e.debug_set_relay(7,True,60)
        await self.e.close_valve()
        self.assertFalse((await self.e.debug_relays())['outputs'][7])

    async def test_real_write_failure_attempts_off_and_preserves_cleanup(self):
        self.e.mode='real';self.e._adam_connected=True
        device=AsyncMock();device.connected=True
        device.write_output.side_effect=ModbusError('timeout')
        self.e.adam=device
        with self.assertRaises(ModbusError): await self.e.debug_set_relay(0,True,10)
        self.assertEqual([call.args for call in device.write_output.await_args_list],[(0,True),(0,False)])
        self.assertIn(0,self.e._debug_deadlines)
        device.write_output.side_effect=None
        await self.e._clear_debug_outputs()
        self.assertFalse(self.e._debug_deadlines)
