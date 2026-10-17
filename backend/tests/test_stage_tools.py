import asyncio
import tempfile
import time
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch, call

from pydantic import ValidationError
from app.stage import StageAction, StageConfig, StageController, StageError, StageMove, StageParameters
from app.drivers.thorlabs_pdxc3 import Pdxc3Driver
from app.drivers.isolated_pdxc3 import IsolatedPdxc3Driver, NativeCallError


class StageToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.events = Mock()
        self.stage = StageController(Path(self.temp.name), self.events)
        await self.stage.configure(StageConfig(mode='simulation'), 'test')
        await self.stage.connect('test')
        self.stage._poll_task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await self.stage._poll_task
        self.stage._poll_task = None

    async def asyncTearDown(self):
        if self.stage.driver:
            self.stage.driver.stop = Mock()
            self.stage.driver.close = Mock()
            self.stage.driver.status = Mock(return_value=[{'channel': n, 'moving': False, 'ready': True} for n in (1,2,3)])
        await self.stage.disconnect()
        self.temp.cleanup()

    async def test_zero_changes_only_the_selected_counter_and_never_moves(self):
        driver = self.stage.driver
        driver.counts = {1: 12, 2: 34, 3: 56}
        driver.move = Mock()
        with self.assertRaises(StageError):
            await self.stage.control(StageAction(axis='y', operation='zero'), 'test')
        await self.stage.control(StageAction(axis='y', operation='zero', confirmed=True), 'test')
        self.assertEqual(driver.counts, {1: 12, 2: 0, 3: 56})
        driver.move.assert_not_called()

    async def test_explicit_enable_and_disable_do_not_send_home_or_move(self):
        driver = self.stage.driver
        driver.move, driver.zero = Mock(), Mock()
        await self.stage.control(StageAction(axis='z', operation='disable'), 'test')
        self.assertFalse(driver.enabled[3])
        await self.stage.control(StageAction(axis='z', operation='enable'), 'test')
        self.assertTrue(driver.enabled[3])
        driver.move.assert_not_called()
        driver.zero.assert_not_called()

    async def test_optimize_requires_confirmation_and_enable_then_stop_cancels_it(self):
        with self.assertRaises(StageError):
            await self.stage.control(StageAction(axis='x', operation='optimize'), 'test')
        self.stage.driver.enabled[1] = False
        with self.assertRaisesRegex(StageError, '先启用'):
            await self.stage.control(StageAction(axis='x', operation='optimize', confirmed=True), 'test')
        self.stage.driver.enabled[1] = True
        result = await self.stage.control(StageAction(axis='x', operation='optimize', confirmed=True), 'test')
        self.assertTrue(result['motion_pending'])
        with self.assertRaises(StageError):
            await self.stage.move(StageMove(axis='y', steps=1, direction=1), 'test')
        result = await self.stage.stop('test')
        self.assertFalse(result['motion_pending'])
        self.assertIsNone(result['operation'])

    async def test_optimize_cannot_complete_from_old_idle_samples_without_observing_progress(self):
        self.stage.driver.optimize = Mock()
        await self.stage.control(StageAction(axis='x', operation='optimize', confirmed=True), 'test')
        self.stage._operation_at = time.monotonic() - 5
        await self.stage._poll_once()
        self.assertTrue(self.stage.motion_pending)
        with self.assertRaises(StageError):
            await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')
        self.stage._motion_deadline = time.monotonic() - 1
        self.stage.driver.stop = Mock()
        self.assertFalse(await self.stage._poll_once())
        self.stage.driver.stop.assert_called_once()
        self.assertFalse(self.stage.connected)

    async def test_parameter_reads_and_applies_preserve_connection_configuration(self):
        before = self.stage.path.read_bytes()
        values = dict((await self.stage.parameters('x'))['values'], step_rate=1600)
        result = await self.stage.parameters('x', values, 'test')
        self.assertEqual(result['values']['step_rate'], 1600)
        self.assertEqual(self.stage.path.read_bytes(), before)
        self.assertEqual(self.stage.driver.counts, {1: 0, 2: 0, 3: 0})
        for bad in ({**values, 'forward_amplitude': 101}, {**values, 'step_rate': 799}, {**values, 'acceleration': 0}, {**values, 'step_rate': True}, {**values, 'arbitrary_setting': 0}):
            with self.assertRaises(ValidationError):
                StageParameters(**bad)

    async def test_failed_parameter_apply_blocks_motion_until_an_explicit_read(self):
        self.stage.driver.set_parameters = Mock(side_effect=OSError('lost acknowledgement'))
        values = (await self.stage.parameters('x'))['values']
        with self.assertRaises(StageError):
            await self.stage.parameters('x', values, 'test')
        await self.stage._poll_once()
        with self.assertRaises(StageError):
            await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')
        await self.stage.parameters('x')
        await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')

    async def test_failed_parameter_read_has_actionable_error_and_requires_recovery(self):
        self.stage.driver.parameters = Mock(side_effect=OSError('link lost'))
        with self.assertRaisesRegex(StageError, '驱动参数读取失败，未下发运动'):
            await self.stage.parameters('x')
        self.assertFalse(self.stage.connected)
        self.assertTrue(self.stage.snapshot()['diagnostics']['recovery_required'])
        self.assertEqual(self.stage.driver.counts[1], 0)

    async def test_confirmed_disconnect_releases_old_uncertainty_and_parameter_error(self):
        self.stage._uncertain = True
        self.stage._parameter_error = self.stage.error = 'old parameter acknowledgement lost'
        result = await self.stage.disconnect('test')
        self.assertFalse(result['diagnostics']['recovery_required'])
        self.assertIsNone(result['error'])
        await self.stage.connect('test')
        await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')
        self.assertEqual(self.stage.driver.counts[1], 1)

    async def test_transient_idle_read_failure_pauses_then_recovers_without_replaying(self):
        driver = self.stage.driver
        original = driver.status
        driver.status = Mock(side_effect=OSError('transient read timeout'))
        self.assertTrue(await self.stage._poll_once())
        self.assertTrue(self.stage.connected)
        self.assertIsNone(self.stage.channels[0]['moving'])
        driver.status = original
        self.assertTrue(await self.stage._poll_once())
        self.assertIsNone(self.stage.error)
        self.assertEqual(driver.counts[1], 0)

    async def test_three_idle_read_failures_require_explicit_recovery(self):
        self.stage.driver.status = Mock(side_effect=OSError('offline'))
        for _ in range(3):
            await self.stage._poll_once()
        self.assertFalse(self.stage.connected)
        self.assertTrue(self.stage.snapshot()['diagnostics']['recovery_required'])
        with self.assertRaises(StageError):
            await self.stage.recover(False, 'test')
        self.stage.driver.close = Mock(side_effect=OSError('dead session'))
        result = await self.stage.recover(True, 'test')
        self.assertTrue(result['connected'])
        self.assertFalse(result['motion_pending'])
        self.assertEqual(self.stage.driver.counts[1], 0)

    async def test_recovery_has_one_owner_and_rejects_parallel_configuration_or_connection(self):
        self.stage.connected = False
        entered, release = threading.Event(), threading.Event()
        def close():
            entered.set()
            if not release.wait(2):
                raise TimeoutError('test timed out')
        self.stage.driver.close = close
        recovering = asyncio.create_task(self.stage.recover(True, 'test'))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        try:
            with self.assertRaises(StageError):
                await self.stage.recover(True, 'test')
            with self.assertRaisesRegex(StageError, '恢复正在进行'):
                await self.stage.connect('test')
            with self.assertRaisesRegex(StageError, '恢复正在进行'):
                await self.stage.configure(StageConfig(mode='simulation', serial_number='129123456'), 'test')
        finally:
            release.set()
        self.assertTrue((await recovering)['connected'])
        self.assertFalse(self.stage.snapshot()['diagnostics']['recovery_required'])
        self.assertEqual(self.stage.driver.counts, {1: 0, 2: 0, 3: 0})

    async def test_unexpected_long_motion_requests_stop_and_latches_fault(self):
        driver = self.stage.driver
        original = driver.status
        rows = original()
        rows[0]['moving'] = True
        driver.status = Mock(side_effect=[rows, original()])
        driver.stop = Mock()
        self.stage.motion_pending = self.stage._must_stop = True
        self.stage._motion_deadline = time.monotonic() - 1
        self.assertFalse(await self.stage._poll_once())
        driver.stop.assert_called_once()
        self.assertTrue(self.stage.motion_pending)
        self.assertFalse(self.stage.connected)
        self.assertIn('超过预期', self.stage.error)

    async def test_stop_cancels_parameter_write_waiting_on_preflight(self):
        driver = self.stage.driver
        original = driver.status
        entered, release = threading.Event(), threading.Event()
        calls = 0
        def preflight():
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                if not release.wait(2):
                    raise TimeoutError('test timeout')
            return original()
        driver.status = preflight
        driver.set_parameters = Mock()
        pending = asyncio.create_task(self.stage.parameters('x', driver.settings[1], 'test'))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        with self.assertRaises(StageError):
            await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')
        stopping = asyncio.create_task(self.stage.stop('test'))
        await asyncio.sleep(0)
        release.set()
        with self.assertRaisesRegex(StageError, '未下发'):
            await pending
        await stopping
        driver.set_parameters.assert_not_called()


class DriverContractTests(unittest.TestCase):
    def test_adapter_and_raw_power_bit_do_not_mask_real_faults(self):
        driver = Pdxc3Driver('129123456')
        driver.channels = {n: Mock() for n in (1, 2, 3)}
        driver.stage_names = {1: 'PDXC2AD', 2: '', 3: ''}
        values = {'MovingClockwise': False, 'MovingCounterclockwise': False, 'PowerOk': False, 'Enabled': True, 'WrongStageDetected': False}
        def items():
            return [SimpleNamespace(id=SimpleNamespace(name='TLMC_StatusItemId_' + key), value=value) for key, value in values.items()]
        for channel in driver.channels.values():
            channel.get_status_items.side_effect = lambda *_: items()
        result = driver.status()
        self.assertTrue(result[0]['ready'])
        self.assertFalse(result[1]['ready'])
        values['Overcurrent'] = True
        self.assertFalse(driver.status()[0]['ready'])

    def test_continuous_mode_readback_never_sends_motion_or_enable(self):
        driver = Pdxc3Driver('129123456')
        channel = Mock()
        channel.get_stage_axis_params.return_value.part_number = 'PDXC2AD'
        channel.get_setting.side_effect = lambda key, _: SimpleNamespace(is_value_set=True, value={'jog.mode':1,'jog.openLoopStepSize':1,'jog.openLoopMaxVelocity':5000,'jog.openLoopAcceleration':1000}[key])
        driver.channels = {1: channel}
        driver._set_setting = Mock()
        with self.assertRaisesRegex(RuntimeError, '读回不一致'):
            driver.move(1, 1, 1)
        driver._set_setting.assert_any_call(1, 'jog.mode', 2)
        channel.move.assert_not_called()
        channel.set_enable_state.assert_not_called()

    def test_invalid_drive_parameters_never_change_settings_or_enable_output(self):
        driver = Pdxc3Driver('129123456')
        channel = Mock()
        channel.get_stage_axis_params.return_value.part_number = 'PDXC2AD'
        channel.get_setting.return_value = SimpleNamespace(is_value_set=True, value=0)
        driver.channels = {1: channel}
        driver._set_setting = Mock()
        with self.assertRaisesRegex(RuntimeError, '本次移动未下发'):
            driver.move(1, 1, 1)
        driver._set_setting.assert_not_called()
        channel.set_position_control_mode.assert_not_called()
        channel.set_enable_state.assert_not_called()
        channel.move.assert_not_called()

    def test_close_always_releases_local_device_after_lost_disconnect(self):
        driver = Pdxc3Driver('129123456')
        driver.device, driver.manager = Mock(), Mock()
        device = driver.device
        device.disconnect.side_effect = OSError('offline')
        with self.assertRaisesRegex(RuntimeError, '已释放本机连接'):
            driver.close()
        device.close.assert_called_once()
        self.assertIsNone(driver.device)

    def test_native_cleanup_attempts_shutdown_even_when_device_close_fails(self):
        driver = Pdxc3Driver('129123456')
        driver.device, driver.manager = Mock(), Mock()
        device, manager = driver.device, driver.manager
        device.close.side_effect = OSError('native close failed')
        manager.shutdown.side_effect = OSError('native shutdown failed')
        with self.assertRaisesRegex(RuntimeError, '已释放本机连接'):
            driver.close()
        manager.shutdown.assert_called_once()
        self.assertIsNone(driver.device)
        self.assertIsNone(driver.manager)

    def test_hung_sdk_is_terminated_and_motion_is_never_replayed(self):
        driver = IsolatedPdxc3Driver('129123456')
        worker, pipe = Mock(), Mock()
        driver.worker, driver.pipe = worker, pipe
        worker.is_alive.return_value = True
        pipe.poll.return_value = False
        with self.assertRaisesRegex(RuntimeError, '原生调用超时'):
            driver.move(1, 1, 1)
        pipe.send.assert_called_once_with(('move', (1, 1, 1)))
        worker.terminate.assert_called_once()
        self.assertIsNone(driver.worker)

    def test_failed_handshake_uses_fresh_workers_and_names_the_configured_transport(self):
        driver = IsolatedPdxc3Driver('129123456', '192.0.2.17')
        context = Mock()
        context.Pipe.side_effect = [(Mock(), Mock()), (Mock(), Mock())]
        driver._rpc = Mock(side_effect=NativeCallError('Device not found, error code 2', 2))
        driver._dispose = Mock()
        with patch('app.drivers.isolated_pdxc3.multiprocessing.get_context', return_value=context), patch('app.drivers.isolated_pdxc3.time.sleep'):
            with self.assertRaisesRegex(NativeCallError, '网口 192.0.2.17:40303.*129123456'):
                driver.connect()
        self.assertEqual(context.Process.call_count, 2)
        self.assertEqual(driver._rpc.call_args_list, [call('connect'), call('connect')])
