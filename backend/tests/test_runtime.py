import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app.build_info import build_info
from app.runtime import RuntimeControl


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def resources(self):
        self.stage = SimpleNamespace(driver=object(), _connecting=False, _recovering=False, disconnect=AsyncMock())
        self.engine = SimpleNamespace(stop=AsyncMock(), start=AsyncMock(), _event=Mock())
        self.analog = SimpleNamespace(disconnect=AsyncMock())
        self.runtime = RuntimeControl()
        self.runtime.signal = Mock()

    async def test_prepare_closes_devices_before_signal_and_rejects_second_request(self):
        self.resources()
        calls = []
        self.stage.disconnect.side_effect = lambda actor: calls.append('stage')
        self.analog.disconnect.side_effect = lambda actor: calls.append('analog')
        self.engine.stop.side_effect = lambda: calls.append('engine')
        await self.runtime.prepare('restart', self.stage, self.engine, 'test', self.analog)
        self.assertEqual(calls, ['analog', 'stage', 'engine'])
        self.runtime.signal.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, '重复'):
            await self.runtime.prepare('exit', self.stage, self.engine, 'test')
        self.runtime.finish_response()
        self.runtime.signal.assert_called_once()

    async def test_shutdown_failure_preserves_server_and_monitoring(self):
        self.resources()
        self.engine.stop.side_effect = OSError('关阀输出无法确认')
        with self.assertRaisesRegex(RuntimeError, '关阀输出无法确认'):
            await self.runtime.prepare('exit', self.stage, self.engine, 'test', self.analog)
        self.assertIsNone(self.runtime.pending)
        self.assertFalse(self.runtime.prepared)
        self.runtime.signal.assert_not_called()
        self.engine.start.assert_awaited_once()

    async def test_external_server_is_not_killed(self):
        self.resources()
        self.runtime.signal = None
        with self.assertRaisesRegex(RuntimeError, '外部进程'):
            await self.runtime.prepare('exit', self.stage, self.engine, 'test')
        self.stage.disconnect.assert_not_awaited()
        self.engine.stop.assert_not_awaited()

    async def test_unconfirmed_relay_shutdown_does_not_exit_even_if_driver_did_not_raise(self):
        self.resources()
        self.engine._off_retry_pending = True
        with self.assertRaisesRegex(RuntimeError, '输出关闭未确认'):
            await self.runtime.prepare('restart', self.stage, self.engine, 'test')
        self.runtime.signal.assert_not_called()
        self.assertFalse(self.runtime.prepared)
        self.engine.start.assert_awaited_once()

    async def test_unknown_stage_stop_keeps_vacuum_monitoring(self):
        self.resources()
        self.stage.disconnect.side_effect = RuntimeError('位移台停止未确认')
        with self.assertRaisesRegex(RuntimeError, '位移台停止未确认'):
            await self.runtime.prepare('exit', self.stage, self.engine, 'test')
        self.engine.stop.assert_not_awaited()
        self.runtime.signal.assert_not_called()

    def test_build_timestamp_is_read_from_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'build-info.json').write_text('{"revision":"1234abc","built_at":"2026-10-23T06:00:00+00:00"}')
            with patch('sys._MEIPASS', temp, create=True):
                info = build_info()
            self.assertEqual(info['built_at'], '2026-10-23T06:00:00+00:00')
            self.assertEqual(info['revision'], '1234abc')
