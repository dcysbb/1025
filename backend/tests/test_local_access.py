import importlib
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from app.drivers.adam6050 import ModbusError
from starlette.requests import Request
from fastapi import HTTPException


class LocalAccess(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        previous = os.environ.get('VACUUM_INTERLOCK_DATA_DIR')
        os.environ['VACUUM_INTERLOCK_DATA_DIR'] = cls.temp.name
        try:
            cls.main = importlib.import_module('app.main')
        finally:
            if previous is None: os.environ.pop('VACUUM_INTERLOCK_DATA_DIR',None)
            else: os.environ['VACUUM_INTERLOCK_DATA_DIR'] = previous

    @classmethod
    def tearDownClass(cls):
        cls.main.HISTORY.close()
        cls.temp.cleanup()

    def request(self,host='127.0.0.1',origin=None):
        headers=[(b'host',b'127.0.0.1:8770')]
        if origin: headers.append((b'origin',origin.encode()))
        return Request({'type':'http','method':'POST','path':'/api/debug/relays/0',
                        'headers':headers,'client':(host,1234),'scheme':'http'})

    async def test_loopback_control_needs_no_cookie_or_password(self):
        for host in ('127.0.0.1','::1'):
            request=self.request(host)
            self.assertEqual(self.main.require_operator(request),'local_operator')
            self.assertTrue((await self.main.auth_status(request))['authenticated'])

    async def test_missing_io_returns_actionable_conflict_instead_of_internal_server_error(self):
        with patch.object(self.main.ENGINE,'close_valve',new=AsyncMock(side_effect=ModbusError('COM5 未被系统识别'))), \
             patch.object(self.main.ENGINE,'_begin_io_recovery') as recovery:
            with self.assertRaises(HTTPException) as error:
                await self.main.action_call('close','local_operator')
        self.assertEqual(error.exception.status_code,409)
        self.assertIn('COM5',error.exception.detail)
        recovery.assert_called_once()

    async def test_hardware_routes_keep_permission_guards_and_origin_checks(self):
        routes = {route.path: route for route in self.main.app.routes if hasattr(route, 'dependant')}
        for path in ('/api/devices/connect-io', '/api/devices/replace-dam'):
            self.assertIn(self.main.require_operator, [dep.call for dep in routes[path].dependant.dependencies])
        patch_route = next(route for route in self.main.app.routes if getattr(route, 'path', None) == '/api/config' and 'PATCH' in getattr(route, 'methods', set()))
        self.assertIn(self.main.require_operator, [dep.call for dep in patch_route.dependant.dependencies])
        for path in ('/api/hardware/ports', '/api/hardware/status'):
            self.assertIn(self.main.require_read_access, [dep.call for dep in routes[path].dependant.dependencies])
        from app.models import ConfigUpdate
        with patch.object(self.main.ENGINE, 'patch_config', new=AsyncMock()) as update:
            with self.assertRaises(HTTPException):
                await self.main.patch_config(ConfigUpdate(config={}), self.request(), 'test')
            update.assert_not_called()
        for origin in (None, 'http://example.com'):
            with patch.object(self.main.ENGINE, 'replace_dam', new=AsyncMock()) as replace:
                with self.assertRaises(HTTPException):
                    await self.main.replace_dam(self.main.DamReplacementRequest(serial_port='COM9'),
                                                self.request(origin=origin), 'test')
                replace.assert_not_called()

    async def test_port_listing_only_enumerates_and_does_not_open_serial_ports(self):
        from types import SimpleNamespace
        port = SimpleNamespace(device='COM3', description='TPG', serial_number='123')
        with patch('serial.tools.list_ports.comports', return_value=[port]), patch('serial.Serial') as open_port:
            result = await self.main.hardware_ports()
        self.assertEqual(result['ports'][0]['device'], 'COM3')
        open_port.assert_not_called()

    async def test_system_control_and_new_hardware_routes_keep_origin_and_local_guards(self):
        from fastapi import BackgroundTasks
        from app.runtime import SystemAction
        routes = {route.path: route for route in self.main.app.routes if hasattr(route, 'dependant')}
        for path in ('/api/system/control', '/api/analog-output/enable', '/api/analog-output/config', '/api/stage/presentation', '/api/debug/analog-output', '/api/analog-output/calibration'):
            self.assertIn(self.main.require_operator, [dep.call for dep in routes[path].dependant.dependencies])
        for origin, host in ((None, '127.0.0.1'), ('http://example.com', '127.0.0.1'), ('http://127.0.0.1:8770', '192.168.1.2')):
            with patch.object(self.main.SYSTEM, 'prepare', new=AsyncMock()) as prepare:
                with self.assertRaises(HTTPException):
                    await self.main.system_control(SystemAction(action='exit'), self.request(host, origin), BackgroundTasks(), 'test')
                prepare.assert_not_awaited()

    async def test_manual_analog_output_checks_origin_before_any_driver_call(self):
        from app.analog_output import ManualCurrent
        route = next(route for route in self.main.app.routes if getattr(route, 'path', None) == '/api/debug/analog-output')
        for origin in (None, 'http://example.com'):
            with patch.object(self.main.ANALOG, 'manual', new=AsyncMock()) as manual:
                with self.assertRaises(HTTPException):
                    await route.endpoint(ManualCurrent(channel=1, current_ma=12), self.request(origin=origin), 'test')
                manual.assert_not_awaited()

    async def test_analog_calibration_checks_origin_before_saving(self):
        from app.analog_output import Calibration
        route = next(route for route in self.main.app.routes if getattr(route, 'path', None) == '/api/analog-output/calibration')
        for origin in (None, 'http://example.com'):
            with patch.object(self.main.ANALOG, 'calibrate', new=AsyncMock()) as save:
                with self.assertRaises(HTTPException):
                    await route.endpoint(Calibration(channel=1, offset_ma=0.1), self.request(origin=origin), 'test')
                save.assert_not_awaited()

    async def test_simulated_hardware_status_exposes_mapped_physical_valve_coil(self):
        engine = self.main.ENGINE
        config = engine.config.model_copy(update={'valve_open_on_energized': False})
        with patch.object(engine, 'mode', 'simulation'), patch.object(engine, 'config', config), \
             patch.object(engine, 'snapshot', return_value={'adam_connected': True, 'valve_closed_sensor': True, 'valve_open_sensor': False}), \
             patch.object(engine, '_open_output', False):
            self.assertTrue((await self.main.hardware_status())['io']['outputs'][config.open_output])
            engine._open_output = True
            self.assertFalse((await self.main.hardware_status())['io']['outputs'][config.open_output])

    async def test_remote_control_still_requires_session(self):
        request=self.request('192.168.1.25')
        with self.assertRaises(HTTPException) as error: self.main.require_operator(request)
        self.assertEqual(error.exception.status_code,401)
        self.assertFalse((await self.main.auth_status(request))['authenticated'])

    async def test_local_writes_still_check_origin(self):
        for origin in (None,'http://example.com'):
            with self.assertRaises(HTTPException) as error: self.main.verify_origin(self.request(origin=origin))
            self.assertEqual(error.exception.status_code,403)
        self.main.verify_origin(self.request(origin='http://127.0.0.1:8770'))

    async def test_new_stage_tools_keep_operator_and_origin_guards(self):
        from app.stage import StageAction, StageRecovery, StageParameters
        routes = {(route.path, method): route for route in self.main.app.routes if hasattr(route, 'dependant') for method in getattr(route, 'methods', set())}
        for path, method in (('/api/stage/action','POST'),('/api/stage/recover','POST'),('/api/stage/parameters/{axis}','GET'),('/api/stage/parameters/{axis}','PUT')):
            self.assertIn(self.main.require_operator, [dep.call for dep in routes[path,method].dependant.dependencies])
        request = self.request(origin='http://example.com')
        with patch.object(self.main.STAGE, 'control', new=AsyncMock()) as control:
            with self.assertRaises(HTTPException):
                await routes['/api/stage/action','POST'].endpoint(StageAction(axis='x', operation='enable'), request, 'test')
            control.assert_not_called()
        with patch.object(self.main.STAGE, 'recover', new=AsyncMock()) as recover:
            with self.assertRaises(HTTPException):
                await routes['/api/stage/recover','POST'].endpoint(StageRecovery(confirmed_stationary=True), request, 'test')
            recover.assert_not_called()
        with patch.object(self.main.STAGE, 'parameters', new=AsyncMock()) as parameters:
            with self.assertRaises(HTTPException):
                await routes['/api/stage/parameters/{axis}','PUT'].endpoint('x', StageParameters(forward_amplitude=100,reverse_amplitude=100,step_rate=5000,acceleration=1000), request, 'test')
            parameters.assert_not_called()


    async def test_connection_routes_require_operator_and_origin(self):
        from app.device_connections import ConnectionChange
        routes = {route.path: route for route in self.main.app.routes if hasattr(route, 'dependant')}
        for path in ('/api/devices/{device}/apply-connect', '/api/devices/{device}/cancel', '/api/devices/{device}/disconnect'):
            self.assertIn(self.main.require_operator, [dep.call for dep in routes[path].dependant.dependencies])
        endpoint = routes['/api/devices/{device}/apply-connect'].endpoint
        with patch.object(self.main.CONNECTIONS, 'apply', new=AsyncMock()) as apply:
            for origin in (None, 'http://example.com'):
                with self.assertRaises(HTTPException):
                    await endpoint('analog', ConnectionChange(config={}), self.request(origin=origin), 'test')
            apply.assert_not_awaited()
        route = next(route for route in self.main.app.routes if getattr(route,'path',None)=='/api/analog-output/config' and 'PATCH' in route.methods)
        self.assertIn(self.main.require_operator,[dep.call for dep in route.dependant.dependencies])
        with patch.object(self.main.ANALOG, 'patch_config', new=AsyncMock()) as update:
            with self.assertRaises(HTTPException):
                await route.endpoint({},self.request(),'test')
            update.assert_not_awaited()

    async def test_pending_connection_blocks_old_writes_and_only_valid_stops_cancel(self):
        import asyncio
        from starlette.responses import JSONResponse
        event = asyncio.Event()
        self.main.CONNECTIONS.pending['analog'] = event
        def request(path, origin='http://127.0.0.1:8770'):
            scope = dict(self.request(origin=origin).scope)
            scope['path'] = path
            return Request(scope)
        try:
            next_call = AsyncMock(return_value=JSONResponse({}))
            response = await self.main.security_headers(request('/api/debug/analog-output'),next_call)
            self.assertEqual(response.status_code,409)
            next_call.assert_not_awaited()
            response = await self.main.security_headers(request('/api/analog-output/stop','http://evil.invalid'),next_call)
            self.assertEqual(response.status_code,403)
            self.assertFalse(event.is_set())
            response = await self.main.security_headers(request('/api/analog-output/stop'),next_call)
            self.assertEqual(response.status_code,200)
            self.assertTrue(event.is_set())
            next_call.assert_awaited_once()
        finally:
            self.main.CONNECTIONS.pending.pop('analog',None)
