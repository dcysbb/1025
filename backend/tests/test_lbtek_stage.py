import asyncio
import ctypes as c
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI, Request
from pydantic import ValidationError

from app.lbtek_stage import LbtekAction, LbtekConfig, LbtekController, LbtekParameters, SimulatedLbtek, install_lbtek_routes
from app.drivers.lbtek import MotorState, NativeLbtek, LbtekDriver, _serve
from app.device_connections import DeviceConnections


class DriverDouble(SimulatedLbtek):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.calls = []
        self.fail = None

    def call(self, name, *args):
        self.calls.append((name, args))
        if name == self.fail:
            raise RuntimeError('USB interrupted')
        return super().call(name, *args)

    def close(self):
        self.calls.append(('close', ()))


class LbtekTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.driver = DriverDouble()
        self.factory = Mock(return_value=self.driver)
        self.event = Mock()
        self.controller = LbtekController(self.root, self.event, self.factory)

    async def asyncTearDown(self):
        self.driver.fail = None
        if self.controller.driver:
            await self.controller.disconnect()
        self.temp.cleanup()

    async def connect(self):
        await self.controller.connect('test')

    def action(self, op='relative', channel=1, value=.01, **kwargs):
        return LbtekAction(channel=channel, operation=op, value=value, **kwargs)

    async def test_connect_reads_without_enabling_homing_moving_or_setting_parameters(self):
        await self.connect()
        self.assertEqual([c[0] for c in self.driver.calls], ['connect'])
        self.assertTrue(self.controller.snapshot()['connected'])
        self.assertFalse(self.controller.recovery.exists())
        self.assertFalse(self.controller.pending)

    async def test_movement_waits_for_later_sample_and_journal_survives_restart(self):
        await self.connect()
        await self.controller.action(self.action(), 'test')
        self.assertEqual(self.controller.pending, {1})
        self.assertTrue(self.controller.recovery.exists())
        restarted = LbtekController(self.root, self.event, self.factory)
        self.assertTrue(restarted.uncertain)
        with self.assertRaisesRegex(RuntimeError, '等待状态确认'):
            await self.controller.action(self.action(), 'test')
        self.driver.rows[0]['position'] = .01
        self.driver.call('stop')
        await self.controller._sample()
        self.assertFalse(self.controller.pending)
        self.assertFalse(self.controller.recovery.exists())
        self.assertEqual(self.controller.records[-1]['result'], 'submitted')

    async def test_channels_are_independent_and_negative_direction_is_preserved(self):
        await self.connect()
        await self.controller.action(self.action(channel=2, value=-.02), 'test')
        await self.controller.action(self.action(channel=3, value=.03), 'test')
        self.assertEqual(self.controller.pending, {2, 3})
        actions = [args for name, args in self.driver.calls if name == 'action']
        self.assertEqual(actions, [('relative', 2, -.02), ('relative', 3, .03)])
        await self.controller.stop('test', 2)
        self.assertEqual(self.controller.pending, {3})

    async def test_actual_limits_and_max_distance_reject_before_driver_call(self):
        await self.connect()
        for cmd in [self.action(value=10.1), self.action('absolute', value=100)]:
            with self.assertRaises(ValueError):
                await self.controller.action(cmd, 'test')
        self.controller.channels[0]['limit_left'] = True
        with self.assertRaisesRegex(RuntimeError, '限位'):
            await self.controller.action(self.action(value=-.01), 'test')
        self.assertFalse(any(name == 'action' for name, _ in self.driver.calls))
        self.assertFalse(self.controller.recovery.exists())
        await self.controller.action(self.action(value=.01), 'test')

    async def test_busy_requests_are_rejected_without_queue_and_stop_works_while_busy(self):
        await self.connect()
        entered, proceed = asyncio.Event(), asyncio.Event()
        original = self.controller._call

        async def delayed(name, *args):
            if name == 'action':
                entered.set()
                await proceed.wait()
            return await original(name, *args)

        with patch.object(self.controller, '_call', delayed):
            move = asyncio.create_task(self.controller.action(self.action(), 'test'))
            await entered.wait()
            with self.assertRaisesRegex(RuntimeError, '未排队'):
                await self.controller.action(self.action(channel=2), 'test')
            stop = asyncio.create_task(self.controller.stop('test'))
            await asyncio.sleep(0)
            self.assertFalse(stop.done())
            proceed.set()
            await asyncio.gather(move, stop)
        self.assertFalse(self.controller.pending)
        self.assertTrue(self.driver.rows[0]['stopped'])
        self.assertTrue(any(r['result'] == 'rejected' for r in self.controller.records))

    async def test_stop_revokes_motion_waiting_for_lock(self):
        await self.connect()
        async with self.controller._lock:
            action = asyncio.create_task(self.controller.action(self.action(), 'test'))
            await asyncio.sleep(0)
            stop = asyncio.create_task(self.controller.stop('test'))
            await asyncio.sleep(0)
        with self.assertRaisesRegex(RuntimeError, '未下发'):
            await action
        await stop
        self.assertFalse(any(name == 'action' for name, _ in self.driver.calls))

    async def test_uncertain_action_persists_and_only_explicit_stop_unlocks(self):
        await self.connect()
        self.driver.fail = 'action'
        with self.assertRaisesRegex(RuntimeError, 'USB interrupted'):
            await self.controller.action(self.action(), 'test')
        self.assertTrue(self.controller.uncertain)
        self.assertEqual(self.controller.records[0]['result'], 'unconfirmed')
        self.driver.fail = None
        await self.controller._sample()
        self.assertTrue(self.controller.uncertain)
        with self.assertRaisesRegex(RuntimeError, '停止并恢复'):
            await self.controller.action(self.action(), 'test')
        await self.controller.stop('test')
        self.assertFalse(self.controller.uncertain)
        self.assertFalse(self.controller.recovery.exists())

    async def test_stop_failure_retains_lock_and_reconnect_is_read_only(self):
        await self.connect()
        self.driver.fail = 'stop'
        with self.assertRaises(RuntimeError):
            await self.controller.stop('test')
        self.assertTrue(self.controller.recovery.exists())
        self.driver.fail = None
        await self.controller.connect('test')
        self.assertTrue(self.controller.uncertain)
        await self.controller.stop('test')

    async def test_jog_lease_and_stop_cancel_late_keepalive(self):
        await self.connect()
        await self.controller.action(self.action('drive', value=-1, lease_id='hold1'), 'test')
        await self.controller.keepalive('hold1')
        # Stopping another channel must also stop the held channel, never orphan it.
        await self.controller.stop('test', 3)
        self.assertTrue(self.driver.rows[0]['stopped'])
        self.assertIsNone(self.controller.active_lease)
        with self.assertRaises(RuntimeError):
            await self.controller.keepalive('hold1')

    async def test_jog_without_renewal_is_stopped_by_server(self):
        await self.connect()
        await self.controller.action(self.action('drive', value=1, lease_id='hold1'), 'test')
        self.controller.lease_deadline = time.monotonic() - 1
        await asyncio.sleep(.65)
        self.assertIsNone(self.controller.active_lease)
        self.assertTrue(self.driver.rows[0]['stopped'])
        self.assertFalse(self.controller.pending)

    async def test_stale_samples_and_rocker_block_motion_and_home_requires_sensor(self):
        await self.connect()
        self.controller.sample_at = time.monotonic() - 3
        with self.assertRaisesRegex(RuntimeError, '过期'):
            await self.controller.action(self.action(), 'test')
        await self.controller._sample()
        await self.controller.rocker(True, 'test')
        with self.assertRaisesRegex(RuntimeError, '摇杆'):
            await self.controller.action(self.action(), 'test')
        await self.controller.rocker(False, 'test')
        self.controller.channels[1]['home_sensor'] = False
        with self.assertRaisesRegex(RuntimeError, '原点传感器'):
            await self.controller.action(self.action('home', 2, None), 'test')
        await self.controller.action(self.action('home', 1, None), 'test')
        self.assertIn(('action', ('home', 1, None)), self.driver.calls)

    async def test_parameters_are_read_back_and_do_not_move(self):
        await self.connect()
        state = await self.controller.parameters(LbtekParameters(channel=2, speed=.5, acceleration=2), 'test')
        self.assertEqual(state['channels'][1]['speed'], .5)
        self.assertFalse(any(name == 'action' for name, _ in self.driver.calls))

    async def test_zero_parameters_and_conflicting_limits_are_rejected_without_motion(self):
        await self.connect()
        self.controller.channels[0]['speed'] = 0
        with self.assertRaisesRegex(RuntimeError, '速度或加速度'):
            await self.controller.action(self.action(), 'test')
        await self.controller.parameters(LbtekParameters(channel=1, speed=1, acceleration=2), 'test')
        self.controller.channels[0].update(limit_left=True, limit_right=True)
        with self.assertRaisesRegex(RuntimeError, '正负限位同时触发'):
            await self.controller.action(self.action('home', value=None), 'test')
        self.assertFalse(any(name == 'action' for name, _ in self.driver.calls))

    async def test_invalid_saved_configuration_cannot_silently_connect_defaults(self):
        self.controller.path.write_text('{invalid', encoding='utf-8')
        broken = LbtekController(self.root, self.event, self.factory)
        with self.assertRaisesRegex(RuntimeError, '配置读取失败'):
            await broken.connect('test')
        self.assertFalse(self.factory.called)
        await broken.configure(LbtekConfig(), 'test')
        self.assertIsNone(broken.config_error)

    async def test_configuration_failure_does_not_replace_memory_and_target_failure_keeps_saved(self):
        original = self.controller.config
        with patch.object(Path, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                await self.controller.configure(LbtekConfig(usb_port=42), 'test')
        self.assertIs(self.controller.config, original)
        engine = Mock()
        connections = DeviceConnections(engine, Mock(), Mock(), self.controller)
        self.driver.fail = 'connect'
        result = await connections.apply('lbtek', {'usb_port': 42}, 'test')
        self.assertFalse(result['ok'])
        self.assertTrue(result['config_saved'])
        self.assertEqual(result['phase'], 'connect')
        self.assertEqual(self.controller.config.usb_port, 42)
        self.assertEqual(self.factory.call_args.kwargs, {'usb_port': 42})

    async def test_stop_failure_prevents_apply_and_no_other_device_is_reconnected(self):
        await self.connect()
        self.driver.fail = 'stop'
        engine, stage, analog = Mock(), Mock(), Mock()
        connections = DeviceConnections(engine, stage, analog, self.controller)
        result = await connections.apply('lbtek', {'usb_port': 99}, 'test')
        self.assertFalse(result['ok'])
        self.assertFalse(result['config_saved'])
        self.assertIsNone(self.controller.config.usb_port)
        self.assertFalse(stage.mock_calls)
        self.assertFalse(analog.mock_calls)
        self.assertEqual(engine.mock_calls[0][0], '_event')

    async def test_cancel_apply_after_save_never_connects(self):
        connections = DeviceConnections(Mock(), Mock(), Mock(), self.controller)
        configure = self.controller.configure

        async def save_then_cancel(config, actor):
            await configure(config, actor)
            connections.cancel('lbtek')

        with patch.object(self.controller, 'configure', save_then_cancel):
            result = await connections.apply('lbtek', {'usb_port': 42}, 'test')
        self.assertTrue(result['config_saved'])
        self.assertFalse(result['connected'])
        self.assertFalse(self.factory.called)


class NativeTests(unittest.TestCase):
    def fake(self, base):
        driver = NativeLbtek()
        dll = Mock()
        driver.dll = dll
        dll.listLBMotorControlerDevices.side_effect = lambda ports, _: (ports.__setitem__(0, 42), 1)[1]
        dll.addDev.return_value = dll.openLBDevice.return_value = 0
        dll.getDevAxisCount.return_value = 3
        dll.getRockerEnable.return_value = 0
        dll.getSpeed.return_value = 1.
        dll.getAcceleration.return_value = 2.

        def state(port, axis, ptr):
            if axis not in range(base, base + 3):
                return -1
            target = c.cast(ptr, c.POINTER(MotorState)).contents
            target.can_run = target.stopped = target.home_sensor = 1
            return 0

        def pos(port, axis, ptr):
            c.cast(ptr, c.POINTER(c.c_int)).contents.value = 0 if axis in range(base, base+3) else -1
            return 0.
        dll.getRuningState.side_effect = state
        dll.getCurrentPos.side_effect = pos
        return driver, dll

    def test_detects_both_documented_axis_bases_using_reads_only(self):
        for base in (0, 1):
            with self.subTest(base=base):
                driver, dll = self.fake(base)
                state = driver.connect()
                self.assertEqual(state['axis_base'], base)
                self.assertEqual(state['usb_port'], 42)
                self.assertEqual([r['channel'] for r in state['channels']], [1, 2, 3])
                self.assertFalse(any(call[0].startswith(('start', 'home', 'set')) for call in dll.mock_calls))

    def test_native_relative_is_one_jog_and_negative_direction_is_two(self):
        driver, dll = self.fake(0)
        driver.connect()
        for name in ('setJogStep','setJogCount','setJogDelay','startJog','home','stopRuning','setRelativeDispEnable','startDrive'):
            getattr(dll, name).return_value = 0
        driver.action('relative', 3, -.1)
        dll.setJogStep.assert_called_once_with(42, 2, .1)
        dll.setJogCount.assert_called_once_with(42, 2, 1)
        dll.startJog.assert_called_once_with(42, 2, 2)
        driver.action('home', 2)
        dll.home.assert_called_once_with(42, 1)
        driver.action('drive', 1, 1)
        dll.setRelativeDispEnable.assert_called_once_with(42, 0, 0)
        dll.startDrive.assert_called_once_with(42, 0, 1)

    def test_parameter_readback_mismatch_is_not_reported_as_success(self):
        driver, dll = self.fake(1)
        driver.connect()
        dll.setSpeed.return_value = dll.setAcceleration.return_value = 0
        with self.assertRaisesRegex(RuntimeError, '读回'):
            driver.parameters(2, 100, 200)

    def test_sdk_timeout_is_not_retried_and_disposes_owner(self):
        driver = LbtekDriver()
        driver.worker, driver.pipe = Mock(), Mock()
        driver.pipe.poll.return_value = False
        worker, pipe = driver.worker, driver.pipe
        with self.assertRaisesRegex(RuntimeError, '未自动重发'):
            driver.call('action', 'home', 1, None)
        self.assertEqual(pipe.send.call_count, 1)
        worker.terminate.assert_called_once()
        self.assertIsNone(driver.worker)

    def test_native_worker_stops_on_expired_lease_even_without_parent_requests(self):
        pipe, driver = Mock(), Mock()
        pipe.poll.side_effect = [True, False, True]
        pipe.recv.side_effect = [('drive', (1, 1, 'hold1')), ('close', ())]
        with patch('app.drivers.lbtek.NativeLbtek', return_value=driver), patch('app.drivers.lbtek.time.monotonic', side_effect=[0, 2]):
            _serve(pipe, {})
        driver.action.assert_called_once_with('drive', 1, 1)
        driver.stop.assert_called_once_with()

    def test_native_worker_stops_on_parent_disconnection(self):
        pipe, driver = Mock(), Mock()
        pipe.recv.side_effect = [('drive', (2, -1, 'hold2')), EOFError()]
        with patch('app.drivers.lbtek.NativeLbtek', return_value=driver):
            _serve(pipe, {})
        driver.stop.assert_called_once_with()

    def test_validation_rejects_nan_bad_channels_and_unleased_drive(self):
        for data in ({'channel':0,'operation':'home'}, {'channel':1,'operation':'relative','value':float('nan')}, {'channel':1,'operation':'drive','value':1}):
            with self.assertRaises(ValidationError):
                LbtekAction(**data)

    def test_routes_require_auth_and_origin(self):
        from fastapi import HTTPException
        app = FastAPI()
        controller = Mock()

        def reader(request: Request):
            if request.headers.get('x-read') != 'yes':
                raise HTTPException(401)

        def operator(request: Request):
            if request.headers.get('x-operator') != 'yes':
                raise HTTPException(401)
            return 'test'

        def origin(request):
            if request.headers.get('origin') != 'http://testserver':
                raise HTTPException(403)

        install_lbtek_routes(app, controller, reader, operator, origin)
        async def invoke(path, method='GET', headers=()):
            messages = []
            scope = {'type':'http','asgi':{'version':'3.0'},'method':method,'path':path,
                     'raw_path':path.encode(),'query_string':b'','scheme':'http',
                     'headers':[(b'content-type',b'application/json'),*headers],
                     'server':('testserver',80),'client':('127.0.0.1',1000),'root_path':''}
            async def receive():
                return {'type':'http.request','body':b'{}','more_body':False}
            async def send(message):
                messages.append(message)
            await app(scope, receive, send)
            return next(m['status'] for m in messages if m['type']=='http.response.start')
        self.assertEqual(asyncio.run(invoke('/api/lbtek-stage')),401)
        self.assertEqual(asyncio.run(invoke('/api/lbtek-stage/stop','POST')),401)
        self.assertEqual(asyncio.run(invoke('/api/lbtek-stage/stop','POST',[(b'x-operator',b'yes')])),403)
        self.assertFalse(controller.mock_calls)
