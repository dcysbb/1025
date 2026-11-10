import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.lbtek_app import create_lbtek_app
from app.lbtek_stage import LbtekConfig


class StandaloneTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'lbtek-stage.json').write_text(LbtekConfig(mode='simulation').model_dump_json(), encoding='utf-8')
        self.frontend = self.root / 'frontend'
        self.frontend.mkdir()
        (self.frontend / 'lbtek.html').write_text('<h1>LBTEK</h1>', encoding='utf-8')
        self.app = create_lbtek_app(self.root, self.frontend)

    async def asyncTearDown(self):
        await self.app.state.controller.disconnect()
        self.app.state.history.close()
        self.temp.cleanup()

    async def request(self, path, method='GET', body=None, client='127.0.0.1', origin=None):
        messages, received = [], False
        headers = [(b'host', b'127.0.0.1:8776'), (b'content-type', b'application/json')]
        if origin:
            headers.append((b'origin', origin.encode()))
        scope = {'type':'http','asgi':{'version':'3.0','spec_version':'2.4'},'method':method,'path':path,
                 'raw_path':path.encode(),'query_string':b'','scheme':'http','headers':headers,
                 'server':('127.0.0.1',8776),'client':(client,1000),'root_path':''}

        async def receive():
            nonlocal received
            if received:
                await asyncio.Event().wait()
            received = True
            return {'type':'http.request','body':json.dumps(body or {}).encode(),'more_body':False}

        async def send(message):
            messages.append(message)

        await self.app(scope, receive, send)
        return next(m['status'] for m in messages if m['type']=='http.response.start'), b''.join(m.get('body',b'') for m in messages if m['type']=='http.response.body')

    async def test_uses_only_lbtek_and_does_not_create_other_hardware_configurations(self):
        with patch('app.drivers.lbtek.LbtekDriver.call', side_effect=AssertionError('real USB must not open')):
            status, payload = await self.request('/api/lbtek-stage/connect', 'POST', origin='http://127.0.0.1:8776')
        self.assertEqual(status,200)
        self.assertTrue(json.loads(payload)['connected'])
        for filename in ('config.json','stage.json','analog-output.json'):
            self.assertFalse((self.root / filename).exists())
        self.assertEqual((await self.request('/api/devices/io/apply-connect','POST'))[0],404)

    async def test_mutations_check_origin_and_remote_reads_are_rejected(self):
        self.assertEqual((await self.request('/api/lbtek-stage/connect','POST'))[0],403)
        self.assertEqual((await self.request('/api/lbtek-stage/stop','POST'))[0],403)
        self.assertEqual((await self.request('/api/lbtek-stage',client='192.168.0.2'))[0],403)
        self.assertEqual((await self.request('/api/lbtek-stage/connect','POST',origin='http://attacker'))[0],403)
        self.assertIsNone(self.app.state.controller.driver)

    async def test_serves_panel_and_refuses_unknown_apis_and_files(self):
        self.assertEqual((await self.request('/'))[0],200)
        self.assertEqual((await self.request('/api/status'))[0],404)
        self.assertEqual((await self.request('/../lbtek-stage.json'))[0],404)
