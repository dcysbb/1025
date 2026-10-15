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
        for path in ('/api/devices/connect-io',):
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

    async def test_port_listing_only_enumerates_and_does_not_open_serial_ports(self):
        from types import SimpleNamespace
        port = SimpleNamespace(device='COM3', description='TPG', serial_number='123')
        with patch('serial.tools.list_ports.comports', return_value=[port]), patch('serial.Serial') as open_port:
            result = await self.main.hardware_ports()
        self.assertEqual(result['ports'][0]['device'], 'COM3')
        open_port.assert_not_called()

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
