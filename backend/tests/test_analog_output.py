import asyncio
import math
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from pydantic import ValidationError
from app.analog_output import AnalogConfig, AnalogError, AnalogMapping, AnalogOutput, ManualCurrent, Calibration, calibrated_current, pressure_current
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

    async def test_manual_all_channels_are_independent_and_preserve_pressure_mapping(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        original = self.controller.config.model_dump()
        for channel, current in enumerate((4, 8.125, 12, 20), 1):
            result = await self.controller.manual(ManualCurrent(channel=channel, current_ma=current), 'test')
            self.driver.write_current.assert_awaited_with(9 + channel, current)
            self.assertFalse(result['enabled'])
            self.assertTrue(result['manual_active'])
        self.assertEqual([row['current_ma'] for row in result['outputs']], [4, 8.125, 12, 20])
        self.assertEqual(self.controller.config.model_dump(), original)
        with self.assertRaisesRegex(AnalogError, '停止手动输出'):
            await self.controller.enable('test')
        with self.assertRaises(AnalogError):
            await self.controller.configure(self.configured(), 'test')
        self.driver.write_current.reset_mock()
        await self.controller.stop('test')
        self.assertEqual([call.args for call in self.driver.write_current.await_args_list], [(10, 20), (11, 20), (12, 20), (13, 20)])
        self.assertFalse(self.controller.snapshot()['manual_active'])
        self.assertFalse(self.controller.journal.exists())

    async def test_manual_rejects_pressure_following_offline_and_unverified_hardware(self):
        body = ManualCurrent(channel=1, current_ma=12)
        self.controller.config = self.configured()
        with self.assertRaisesRegex(AnalogError, '未连接'): await self.controller.manual(body, 'test')
        self.controller.driver = self.driver
        self.controller.enabled = True
        with self.assertRaisesRegex(AnalogError, '压力跟随'): await self.controller.manual(body, 'test')
        self.controller.enabled = False
        for update in ({'register_base': None},):
            self.controller.config = self.configured().model_copy(update=update)
            with self.assertRaisesRegex(AnalogError, '核对'): await self.controller.manual(body, 'test')
        self.driver.write_current.assert_not_awaited()
        self.controller.config = self.configured().model_copy(update={'current_output_confirmed': False})
        await self.controller.manual(body, 'test')
        self.driver.write_current.assert_awaited_once_with(10, 12)

    async def test_manual_failure_retains_exact_recovery_channels_including_unmapped_output(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        self.driver.write_current.side_effect = OSError('lost response')
        with self.assertRaisesRegex(AnalogError, '未确认'):
            await self.controller.manual(ManualCurrent(channel=4, current_ma=6), 'test')
        with self.assertRaises(AnalogError):
            await self.controller.manual(ManualCurrent(channel=3, current_ma=8), 'test')
        reloaded = AnalogOutput(Path(self.temp.name), lambda: self.sample, Mock(), lambda *args, **kw: self.driver)
        self.assertTrue(reloaded.uncertain)
        self.assertEqual(reloaded.snapshot()['manual_channels'], [4])
        self.driver.write_current.side_effect = None
        self.driver.write_current.reset_mock()
        await reloaded.connect('test')
        await reloaded.stop('test')
        self.driver.write_current.assert_awaited_once_with(13, 20)
        self.assertFalse(reloaded.uncertain)

    async def test_stop_waits_for_manual_write_and_prevents_new_writes_while_stopping(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed(*args):
            started.set()
            await release.wait()
        self.driver.write_current.side_effect = delayed
        first = asyncio.create_task(self.controller.manual(ManualCurrent(channel=2, current_ma=12), 'test'))
        await started.wait()
        stopped = asyncio.create_task(self.controller.stop('test'))
        await asyncio.sleep(0)
        extra = asyncio.create_task(self.controller.manual(ManualCurrent(channel=3, current_ma=8), 'test'))
        release.set()
        await first
        with self.assertRaisesRegex(AnalogError, '停止输出正在处理'): await extra
        await stopped
        self.assertEqual([c.args for c in self.driver.write_current.await_args_list], [(11, 12), (11, 20)])

    async def test_stop_does_not_cancel_an_inflight_pressure_write(self):
        self.controller.config = self.configured(update_interval_s=10)
        self.controller.driver = self.driver
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed(*args):
            started.set()
            await release.wait()
        self.driver.write_current.side_effect = delayed
        await self.controller.enable('test')
        await started.wait()
        stopped = asyncio.create_task(self.controller.stop('test'))
        await asyncio.sleep(0)
        self.assertFalse(stopped.done())
        release.set()
        await asyncio.wait_for(stopped, 1)
        self.assertEqual([c.args for c in self.driver.write_current.await_args_list], [(10, 12), (10, 20)])

    async def test_simulation_manual_never_calls_real_transport(self):
        self.controller.config = self.configured(mode='simulation')
        await self.controller.connect('test')
        await self.controller.manual(ManualCurrent(channel=3, current_ma=7.125), 'test')
        await self.controller.stop('test')
        self.driver.write_current.assert_not_awaited()

    def test_manual_request_rejects_invalid_channel_current_and_precision(self):
        for values in ({'channel': 0, 'current_ma': 12}, {'channel': 5, 'current_ma': 12}, {'channel': True, 'current_ma': 12},
                       {'channel': 1, 'current_ma': 3.999}, {'channel': 1, 'current_ma': 21}, {'channel': 1, 'current_ma': math.nan},
                       {'channel': 1, 'current_ma': math.inf}, {'channel': 1, 'current_ma': 4.0001}):
            with self.assertRaises(ValidationError): ManualCurrent(**values)

    async def test_calibration_saves_only_one_channel_without_writing_and_migrates_old_defaults(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        before = self.controller.config.model_dump()
        result = await self.controller.calibrate(Calibration(channel=3, offset_ma=-0.125), 'test')
        expected = before
        expected['outputs'][2]['offset_ma'] = -0.125
        self.assertEqual(result['config'], expected)
        self.driver.write_current.assert_not_awaited()
        reloaded = AnalogOutput(Path(self.temp.name), lambda: self.sample, Mock())
        self.assertEqual(reloaded.config.outputs[2].offset_ma, -0.125)
        self.assertFalse(reloaded.enabled)
        self.assertEqual(AnalogMapping().offset_ma, 0)

    async def test_calibration_is_applied_once_to_manual_pressure_and_fault_outputs(self):
        self.controller.config = self.configured()
        mapping = self.controller.config.outputs[0]
        mapping.offset_ma, mapping.fault_ma = 0.125, 10
        self.controller.driver = self.driver
        result = await self.controller.manual(ManualCurrent(channel=1, current_ma=12), 'test')
        self.driver.write_current.assert_awaited_with(10, 12.125)
        self.assertEqual(result['outputs'][0]['target_ma'], 12)
        self.assertEqual(result['outputs'][0]['offset_ma'], 0.125)
        self.assertEqual(result['outputs'][0]['current_ma'], 12.125)
        await self.controller.stop('test')
        self.driver.write_current.assert_awaited_with(10, 10.125)
        await self.controller.update_once()
        self.driver.write_current.assert_awaited_with(10, 12.125)
        self.sample['sample_stale'] = True
        await self.controller.update_once()
        self.driver.write_current.assert_awaited_with(10, 10.125)

    async def test_calibration_cannot_change_running_or_uncertain_outputs(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        body = Calibration(channel=1, offset_ma=0.1)
        await self.controller.enable('test')
        with self.assertRaises(AnalogError): await self.controller.calibrate(body, 'test')
        await self.controller.stop('test')
        await self.controller.manual(ManualCurrent(channel=2, current_ma=12), 'test')
        with self.assertRaises(AnalogError): await self.controller.calibrate(body, 'test')
        self.controller.uncertain = True
        with self.assertRaises(AnalogError): await self.controller.calibrate(body, 'test')
        self.assertEqual(self.controller.config.outputs[0].offset_ma, 0)

    async def test_calibration_recovery_preserves_saved_offset_on_unmapped_manual_channel(self):
        self.controller.config = self.configured()
        self.controller.config.outputs[3].offset_ma = -0.15
        self.controller.config.outputs[3].fault_ma = 12
        self.controller.driver = self.driver
        await self.controller.manual(ManualCurrent(channel=4, current_ma=10), 'test')
        reloaded = AnalogOutput(Path(self.temp.name), lambda: self.sample, Mock(), lambda *args, **kw: self.driver)
        self.assertTrue(reloaded.uncertain)
        self.assertEqual(reloaded.config.outputs[3].offset_ma, -0.15)
        await reloaded.connect('test')
        await reloaded.stop('test')
        self.driver.write_current.assert_awaited_with(13, 11.85)

    def test_calibration_uses_microamp_precision_and_clamps_after_addition(self):
        for target, offset, expected, limited in [(12, 0.001, 12.001, False), (12, -0.125, 11.875, False),
                                                   (4, -0.1, 4, True), (20, 0.1, 20, True), (4, 0.1, 4.1, False)]:
            self.assertEqual(calibrated_current(AnalogMapping(offset_ma=offset), target), (expected, limited))
        for value in (math.inf, math.nan, 16.001, -16.001, 0.0001):
            with self.assertRaises(ValidationError): Calibration(channel=1, offset_ma=value)
            with self.assertRaises(ValidationError): AnalogMapping(offset_ma=value)


    async def test_manual_auto_saves_offset_before_write_and_updates_only_selected_channel(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        await self.controller.manual(ManualCurrent(channel=2, current_ma=10), 'test')
        async def verify_saved(register, current):
            saved = AnalogConfig.model_validate_json(self.controller.path.read_text(encoding='utf-8'))
            self.assertEqual(saved.outputs[0].offset_ma, .125)
            self.assertEqual(saved.outputs[1].offset_ma, 0)
            self.assertEqual((register, current), (10, 12.125))
        self.driver.write_current.side_effect = verify_saved
        await self.controller.manual(ManualCurrent(channel=1, current_ma=12, offset_ma=.125), 'test')
        self.assertEqual(self.controller.rows[1]['current_ma'], 10)
        reloaded = AnalogOutput(Path(self.temp.name), lambda: self.sample, Mock())
        self.assertEqual(reloaded.config.outputs[0].offset_ma, .125)
        self.assertEqual(reloaded.snapshot()['manual_channels'], [1, 2])

    async def test_manual_auto_save_failure_never_writes_hardware(self):
        self.controller.config = self.configured()
        self.controller.driver = self.driver
        for fail_path in (self.controller.path, self.controller.journal):
            original = self.controller._save
            def fail(path, value):
                if path == fail_path:
                    raise OSError('disk full')
                original(path, value)
            with patch.object(self.controller, '_save', side_effect=fail):
                with self.assertRaises(OSError):
                    await self.controller.manual(ManualCurrent(channel=1, current_ma=12, offset_ma=.125), 'test')
            self.driver.write_current.assert_not_awaited()
            self.assertFalse(self.controller.snapshot()['manual_active'])

    def test_manual_auto_save_offset_validation(self):
        for value in (17, -17, .0001, math.nan, math.inf):
            with self.assertRaises(ValidationError):
                ManualCurrent(channel=1, current_ma=12, offset_ma=value)
