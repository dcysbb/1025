import asyncio
import json
import tempfile
import time
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch, call

from pydantic import ValidationError
from app.stage import SimulatedStage, StageAction, StageConfig, StageController, StageError, StageMove, StageParameters
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

    async def test_zero_requires_readback_zero_and_latches_a_mismatch(self):
        self.stage.driver.counts[1] = 17
        self.stage.driver.zero = Mock()  # SDK accepted the request but did not apply it.
        with self.assertRaisesRegex(StageError, '未读回零'):
            await self.stage.control(StageAction(axis='x', operation='zero', confirmed=True), 'test')
        self.assertFalse(self.stage.connected)
        self.assertTrue(self.stage.motion_pending)
        self.assertEqual(self.events.call_args.args[-1]['result'], 'unconfirmed')

    async def test_unconfirmed_action_remains_locked_across_restart_and_cannot_be_configured_away(self):
        self.stage.driver.counts[1] = 17
        self.stage.driver.zero = Mock()
        with self.assertRaises(StageError):
            await self.stage.control(StageAction(axis='x', operation='zero', confirmed=True), 'test')
        restarted = StageController(Path(self.temp.name), Mock())
        self.assertTrue(restarted.motion_pending)
        self.assertTrue(restarted.snapshot()['diagnostics']['recovery_required'])
        for action in (restarted.configure(StageConfig(mode='simulation'), 'test'), restarted.disconnect('test'), restarted.recover(False, 'test')):
            with self.assertRaises(StageError):
                await action
        journal = restarted.recovery_path.read_bytes()
        result = await restarted.connect('test')
        self.assertTrue(result['connected'])
        self.assertTrue(result['diagnostics']['motion_locked'])
        self.assertEqual(restarted.recovery_path.read_bytes(), journal)
        await restarted._poll_once()
        with self.assertRaises(StageError):
            await restarted.move(StageMove(axis='x', direction=1, steps=1), 'test')
        await restarted.recover(True, 'test')
        self.assertFalse(restarted.recovery_path.exists())
        self.assertFalse(restarted.motion_pending)
        await restarted.disconnect('test')

    async def test_direct_reconnect_releases_stale_session_but_preserves_motion_lock(self):
        old = self.stage.driver
        old.close = Mock(side_effect=OSError('stale session'))
        old.stop = Mock()
        self.stage.connected = False
        self.stage._uncertain = self.stage.motion_pending = self.stage._must_stop = True
        self.stage.error = 'previous action unconfirmed'
        self.stage._remember_fault()
        journal = self.stage.recovery_path.read_bytes()
        driver = SimulatedStage()
        for name in ('connect', 'status', 'stop', 'move', 'enable', 'zero', 'optimize', 'close'):
            setattr(driver, name, Mock(wraps=getattr(driver, name)))
        self.stage.driver_factory = lambda _: driver
        result = await self.stage.connect('test')
        self.assertTrue(result['connected'])
        self.assertTrue(result['motion_pending'])
        self.assertTrue(result['diagnostics']['motion_locked'])
        self.assertEqual(len(result['channels']), 3)
        old.close.assert_called_once()
        old.stop.assert_not_called()
        driver.connect.assert_called_once()
        for name in ('stop', 'move', 'enable', 'zero', 'optimize'):
            getattr(driver, name).assert_not_called()
        await self.stage._poll_once()
        self.assertEqual(self.stage.recovery_path.read_bytes(), journal)
        self.assertTrue(self.stage.motion_pending)
        for action in (self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test'),
                       self.stage.control(StageAction(axis='x', operation='enable'), 'test')):
            with self.assertRaises(StageError):
                await action
        await self.stage.recover(True, 'test')
        self.assertIs(self.stage.driver, driver)
        driver.close.assert_not_called()
        driver.stop.assert_not_called()
        self.assertFalse(self.stage.snapshot()['diagnostics']['motion_locked'])

    async def test_failed_direct_reconnect_keeps_journal_and_releases_failed_driver(self):
        await self.stage.disconnect('test')
        self.stage._uncertain = self.stage.motion_pending = True
        self.stage.error = 'previous stop unconfirmed'
        self.stage._remember_fault()
        journal = self.stage.recovery_path.read_bytes()
        driver = Mock()
        driver.connect.side_effect = OSError('USB device missing')
        self.stage.driver_factory = lambda _: driver
        with self.assertRaisesRegex(StageError, 'USB device missing'):
            await self.stage.connect('test')
        self.assertFalse(self.stage.connected)
        self.assertTrue(self.stage.motion_pending)
        self.assertEqual(self.stage.recovery_path.read_bytes(), journal)
        driver.close.assert_called_once()
        driver.stop.assert_not_called()
        driver.move.assert_not_called()
        # Teardown has no live session to stop; preserve the failed state above.
        self.stage._uncertain = self.stage.motion_pending = False

    async def test_connect_reads_moving_channels_without_requiring_stationary_or_sending_stop(self):
        await self.stage.disconnect('test')
        driver = SimulatedStage()
        rows = driver.status()
        rows[0]['moving'] = True
        driver.status = Mock(return_value=rows)
        driver.stop = Mock()
        self.stage.driver_factory = lambda _: driver
        result = await self.stage.connect('test')
        self.assertTrue(result['connected'])
        self.assertTrue(result['channels'][0]['moving'])
        driver.stop.assert_not_called()
        with self.assertRaises(StageError):
            await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')

    async def test_refused_motion_unlock_keeps_readable_connection_and_existing_lock(self):
        self.stage._uncertain = self.stage.motion_pending = True
        self.stage.error = 'previous motion unconfirmed'
        self.stage._remember_fault()
        journal = self.stage.recovery_path.read_bytes()
        rows = self.stage.driver.status()
        rows[0]['moving'] = True
        self.stage.driver.status = Mock(return_value=rows)
        self.stage.driver.stop = Mock()
        with self.assertRaisesRegex(StageError, '尚未报告全部通道空闲'):
            await self.stage.recover(True, 'test')
        self.assertTrue(self.stage.connected)
        self.assertTrue(self.stage.snapshot()['diagnostics']['motion_locked'])
        self.assertEqual(self.stage.recovery_path.read_bytes(), journal)
        self.stage.driver.stop.assert_not_called()

    async def test_parallel_connection_is_rejected_without_queuing_moves_or_configuration(self):
        await self.stage.disconnect('test')
        driver = SimulatedStage()
        entered, release = threading.Event(), threading.Event()
        def connect():
            entered.set()
            if not release.wait(2):
                raise TimeoutError('test timed out')
        driver.connect = Mock(side_effect=connect)
        driver.move = Mock()
        self.stage.driver_factory = lambda _: driver
        connecting = asyncio.create_task(self.stage.connect('test'))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        try:
            for action in (self.stage.connect('other'),
                           self.stage.configure(StageConfig(mode='simulation'), 'other'),
                           self.stage.move(StageMove(axis='x', direction=1, steps=1), 'other')):
                with self.assertRaises(StageError):
                    await action
        finally:
            release.set()
        self.assertTrue((await connecting)['connected'])
        driver.connect.assert_called_once()
        driver.move.assert_not_called()

    async def test_motion_is_journaled_before_submission_and_cleared_only_after_idle_sample(self):
        await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')
        self.assertTrue(self.stage.recovery_path.exists())
        restarted = StageController(Path(self.temp.name), Mock())
        self.assertTrue(restarted.motion_pending)
        await self.stage._poll_once()
        self.assertFalse(self.stage.recovery_path.exists())
        self.assertFalse(self.stage.motion_pending)

    async def test_unwritable_motion_journal_prevents_hardware_submission(self):
        self.stage.driver.move = Mock()
        self.stage._save_recovery = Mock(side_effect=OSError('disk full'))
        with self.assertRaisesRegex(StageError, '本次移动未下发'):
            await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')
        self.stage.driver.move.assert_not_called()
        self.assertFalse(self.stage.motion_pending)

    async def test_output_change_requires_matching_readback(self):
        self.stage.driver.enable = Mock()
        with self.assertRaisesRegex(StageError, '使能状态'):
            await self.stage.control(StageAction(axis='x', operation='disable'), 'test')
        self.assertEqual(self.events.call_args.args[-1]['result'], 'unconfirmed')

    async def test_optimize_progress_and_completion_are_distinct_from_submission(self):
        result = await self.stage.control(StageAction(axis='x', operation='optimize', confirmed=True), 'test')
        self.assertEqual(result['operation']['phase'], 'running')
        self.assertGreaterEqual(result['operation']['elapsed_s'], 0)
        self.assertEqual(self.events.call_args.args[-1]['result'], 'submitted')
        self.stage._operation_at -= 3
        self.stage.driver.optimizing[1] = 0
        await self.stage._poll_once()
        self.assertFalse(self.stage.motion_pending)
        self.assertEqual(self.events.call_args.args[-1]['result'], 'completed')
        self.assertEqual(self.events.call_args.args[-1]['mode'], 'simulation')

    async def test_stop_during_optimize_records_stopped_without_completion(self):
        await self.stage.control(StageAction(axis='x', operation='optimize', confirmed=True), 'test')
        await self.stage.stop('test')
        results = [item.args[-1].get('result') for item in self.events.call_args_list if item.args[0] == 'stage_action']
        self.assertIn('stopped', results)
        self.assertNotIn('completed', results)

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
        before = json.loads(self.stage.path.read_text(encoding="utf-8"))
        values = dict((await self.stage.parameters('x'))['values'], step_rate=1600)
        result = await self.stage.parameters('x', values, 'test')
        self.assertEqual(result['values']['step_rate'], 1600)
        after = json.loads(self.stage.path.read_text(encoding="utf-8"))
        for key in ('mode', 'serial_number', 'connection', 'host', 'port', 'axes', 'inverted', 'max_steps'):
            self.assertEqual(after[key], before[key])
        self.assertEqual(after['drive_params']['x']['step_rate'], 1600)
        reloaded = StageController(Path(self.temp.name), self.events)
        self.assertEqual(reloaded.config.drive_params['x'].step_rate, 1600)
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
        driver.stage_names = {1: 'PDXC2AD'}
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
        driver.stage_names = {1: 'PDXC2AD'}
        driver._set_setting = Mock()
        with self.assertRaisesRegex(RuntimeError, '本次移动未下发'):
            driver.move(1, 1, 1)
        driver._set_setting.assert_not_called()
        channel.set_position_control_mode.assert_not_called()
        channel.set_enable_state.assert_not_called()
        channel.move.assert_not_called()

    def test_repeat_moves_skip_reconfiguration_and_verification(self):
        driver = Pdxc3Driver('129123456')
        channel = Mock()
        channel.get_setting.side_effect = lambda key, _: SimpleNamespace(is_value_set=True, value={'jog.mode':2,'jog.openLoopStepSize':23,'jog.openLoopMaxVelocity':5000,'jog.openLoopAcceleration':1000}[key])
        driver.channels = {1: channel}
        driver.stage_names = {1: 'PDXC2AD'}
        driver._set_setting = Mock()
        driver.move(1, 1, 23)
        channel.move.assert_called_once()
        channel.set_position_control_mode.assert_called_once()
        channel.set_enable_state.assert_called_once()
        self.assertEqual(len(driver._set_setting.call_args_list), 2)  # jog.mode + step size
        channel.move.reset_mock()
        driver.move(1, 1, 23)
        channel.move.assert_called_once()  # motion re-issued...
        self.assertEqual(len(driver._set_setting.call_args_list), 2)   # ...with zero reconfiguration
        channel.set_position_control_mode.assert_called_once()
        channel.set_enable_state.assert_called_once()

    def test_jog_start_switches_mode_to_continuous_and_moves(self):
        driver = Pdxc3Driver('129123456')
        channel = Mock()
        state = {'jog.mode': 2, 'jog.openLoopStepSize': 23, 'jog.openLoopMaxVelocity': 5000, 'jog.openLoopAcceleration': 1000}
        channel.get_setting.side_effect = lambda key, _: SimpleNamespace(is_value_set=True, value=state[key])
        driver.channels = {1: channel}
        driver.stage_names = {1: 'PDXC2AD'}
        driver._set_setting = Mock(side_effect=lambda _, key, value: state.__setitem__(key, value))
        driver.jog_start(1, -1)
        self.assertEqual(state['jog.mode'], 1)  # TLMC_JogMode_Continuous
        self.assertEqual(driver.move_budget_s, 0)  # no completion deadline for continuous jog
        from thorlabs_xa.shared.enums import TLMC_MoveMode
        channel.move.assert_called_once_with(TLMC_MoveMode.TLMC_MoveMode_JogReverse, 0, 0)

    def test_home_sets_direction_and_velocity_then_requests_homing(self):
        driver = Pdxc3Driver('129123456')
        channel = Mock()
        channel.subchannel_handle = 7
        channel.get_setting.side_effect = lambda key, _: SimpleNamespace(is_value_set=True, value={'jog.openLoopMaxVelocity': 5000, 'jog.openLoopAcceleration': 1000}[key])
        driver.channels = {2: channel}
        driver.stage_names = {2: 'PD1V/M'}
        params = SimpleNamespace(direction='stale', limit_switch='keep', offset_distance=3, velocity=0)
        native = Mock()
        native.get_home_params.return_value = params
        driver.manager = SimpleNamespace(native_functions=native)
        driver.home(2, -1)
        from thorlabs_xa.shared.enums import TLMC_HomeDirection
        native.get_home_params.assert_called_once_with(7, driver.TIMEOUT_MS)
        self.assertIs(params.direction, TLMC_HomeDirection.TLMC_HomeDirection_Reverse)
        self.assertEqual(params.velocity, 5000)
        self.assertEqual(params.limit_switch, 'keep')  # device limit-switch mode untouched
        native.set_home_params.assert_called_once_with(7, params)
        channel.home.assert_called_once_with(driver.TIMEOUT_MS)

    async def test_saved_drive_params_restored_on_connect_after_drift(self):
        await self.stage.disconnect('test')
        values = {'forward_amplitude': 100, 'reverse_amplitude': 100, 'step_rate': 1600, 'acceleration': 1000}
        await self.stage.configure(StageConfig(mode='simulation', drive_params={'x': values}), 'test')
        await self.stage.connect('test')
        try:
            self.assertEqual(self.stage.driver.settings[1]['step_rate'], 1600)
            self.assertFalse(self.stage.snapshot()['error'])
        finally:
            self.stage._poll_task.cancel()
        parameters_events = [c.args for c in self.events.call_args_list if c.args[0] == 'stage_parameters']
        self.assertTrue(any('恢复' in c.args[2] for c in parameters_events))

    async def test_drive_params_restore_failure_locks_motion_without_dropping_link(self):
        await self.stage.disconnect('test')
        driver = Mock()
        driver.connect.return_value = None
        driver.status.return_value = [{'channel': n, 'moving': False, 'enabled': True, 'stage': 'PD1V/M',
                                       'ready': True, 'optimizing': False, 'optimized': False,
                                       'open_loop': True, 'command_count': 0, 'error': None} for n in (1, 2, 3)]
        driver.parameters.return_value = {'values': {'forward_amplitude': 100, 'reverse_amplitude': 100,
                                                      'step_rate': 5000, 'acceleration': 1000},
                                          'limits': {k: {'min': 1, 'max': 20000} for k in
                                                     ('forward_amplitude', 'reverse_amplitude', 'step_rate', 'acceleration')}}
        driver.set_parameters.side_effect = OSError('apply lost')
        self.stage.driver_factory = lambda _: driver
        values = {'forward_amplitude': 100, 'reverse_amplitude': 100, 'step_rate': 1600, 'acceleration': 1000}
        await self.stage.configure(StageConfig(mode='simulation', drive_params={'x': values}), 'test')
        await self.stage.connect('test')
        try:
            self.assertTrue(self.stage.connected)
            with self.assertRaisesRegex(StageError, '恢复保存的驱动参数失败'):
                await self.stage.move(StageMove(axis='x', direction=1, steps=1), 'test')
            driver.move.assert_not_called()
        finally:
            self.stage._poll_task.cancel()
            driver.close = Mock()

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
