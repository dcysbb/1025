import asyncio
import math
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from pydantic import ValidationError
from app.analog_output import AnalogConfig, AnalogError, AnalogMapping, AnalogOutput, pressure_current
from app.drivers.zs_ao import ZsAnalogClient, ModbusError


class AnalogTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sample = {'mode': 'real', 'sample_stale': False, 'tpg_connected': True,
                       'channels': [{'channel': 4, 'valid': True, 'pressure_pa': 1}]}
        self.driver = Mock(connected=True)
        self.driver.identify = AsyncMock()
        self.driver.read_registers = AsyncMock(return_value=[0]*4)
        self.driver.write_current = AsyncMock()
        self.driver.close = AsyncMock()
        self.controller = AnalogOutput(Path(self.temp.name), lambda: self.sample, Mock(), lambda *args, **kw: self.driver)

    async def asyncTearDown(self):
        if self.controller._task:
            self.controller._task.cancel()
            await self.controller._task

    def configured(self, **values):
        return AnalogConfig(host='192.168.0.7', register_base=10, current_output_confirmed=True,
                            outputs=[AnalogMapping(enabled=True, pressure_4ma_pa=0.01, pressure_20ma_pa=100),
                                     *[AnalogMapping() for _ in range(3)]], **values)

    def test_linear_log_inverse_and_saturation(self):
        m = AnalogMapping(enabled=True, pressure_4ma_pa=0.01, pressure_20ma_pa=100)
        self.assertEqual(pressure_current(m, 1), (12, False))
        self.assertEqual(pressure_current(m, 1000), (20, True))
        m = AnalogMapping(enabled=True, scale='linear', pressure_4ma_pa=100, pressure_20ma_pa=0)
        self.assertEqual(pressure_current(m, 25), (16, False))
        for value in (math.nan, math.inf, -1):
            with self.assertRaises(AnalogError): pressure_current(m, value)
        with self.assertRaises(ValidationError):
            AnalogMapping(enabled=True, pressure_4ma_pa=0, pressure_20ma_pa=1)

    async def test_save_connect_and_reload_never_write_or_auto_enable(self):
        await self.controller.configure(self.configured(), 'test')
        await self.controller.connect('test')
        self.driver.identify.assert_awaited_once()
        self.driver.write_current.assert_not_awaited()
        reloaded = AnalogOutput(Path(self.temp.name), lambda: self.sample, Mock())
        self.assertFalse(reloaded.enabled)
        self.assertIsNone(reloaded.driver)

    async def test_output_tracks_pressure_and_faults_without_holding_stale_pressure(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        await self.controller.update_once()
        self.driver.write_current.assert_awaited_with(10, 12)
        self.sample['sample_stale'] = True
        await self.controller.update_once()
        self.driver.write_current.assert_awaited_with(10, 20)
        self.assertIsNone(self.controller.rows[0]['pressure_pa'])
        self.assertIn('失效', self.controller.rows[0]['status'])
        self.sample['sample_stale'] = False
        self.sample['mode'] = 'simulation'
        await self.controller.update_once()
        self.driver.write_current.assert_awaited_with(10, 20)

    async def test_explicit_enable_then_stop_writes_fault_and_clears_recovery(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        await self.controller.enable('test')
        await asyncio.sleep(0.01)
        self.assertTrue(self.controller.journal.exists())
        await self.controller.stop('test')
        self.driver.write_current.assert_awaited_with(10, 20)
        self.assertFalse(self.controller.journal.exists())
        self.assertFalse(self.controller.enabled)

    async def test_each_output_rechecks_pressure_after_previous_network_exchange(self):
        config = self.configured()
        config.outputs[1] = config.outputs[0].model_copy()
        self.controller.config = config
        self.controller.driver = self.driver
        def delayed_network(*_args):
            self.sample['sample_stale'] = True
        self.driver.write_current.side_effect = delayed_network
        await self.controller.update_once()
        self.assertEqual(self.driver.write_current.await_args_list[0].args, (10, 12))
        self.assertEqual(self.driver.write_current.await_args_list[1].args, (11, 20))

    async def test_transport_failure_latches_uncertainty_and_blocks_config_replacement(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        self.driver.write_current.side_effect = OSError('network down')
        await self.controller.enable('test')
        await asyncio.sleep(0.01)
        self.assertTrue(self.controller.uncertain)
        self.assertFalse(self.controller.enabled)
        with self.assertRaises(AnalogError):
            await self.controller.configure(AnalogConfig(), 'test')
        reloaded = AnalogOutput(Path(self.temp.name), lambda: self.sample, Mock())
        self.assertTrue(reloaded.uncertain)

    async def test_unconfirmed_register_base_and_simulated_pressure_cannot_enable_real_output(self):
        self.controller.driver = self.driver
        self.controller.config = self.configured().model_copy(update={'register_base': None})
        with self.assertRaisesRegex(AnalogError, '起始地址'):
            await self.controller.enable('test')
        self.controller.config = self.configured()
        self.sample['mode'] = 'simulation'
        with self.assertRaisesRegex(AnalogError, '模拟压力'):
            await self.controller.enable('test')
        self.driver.write_current.assert_not_awaited()

    async def test_wire_values_use_microamps_and_check_write_echo(self):
        client = ZsAnalogClient('127.0.0.1')
        payload = struct.pack('>HH', 10, 12000)
        with patch.object(client, '_request', new=AsyncMock(return_value=payload)) as request:
            await client.write_current(10, 12)
            request.assert_awaited_once_with(6, payload)
        with patch.object(client, '_request', new=AsyncMock(return_value=b'bad')):
            with self.assertRaises(ModbusError): await client.write_current(10, 12)
