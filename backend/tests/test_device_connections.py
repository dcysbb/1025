import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from app.analog_output import AnalogConfig, AnalogMapping, AnalogOutput, ManualCurrent
from app.configuration import ConfigurationStore
from app.device_connections import DeviceConnections
from app.engine import InterlockEngine
from app.stage import StageConfig, StageController
from app.storage import HistoryStore


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.history = HistoryStore(self.root / 'history.sqlite3')
        self.engine = InterlockEngine(ConfigurationStore(self.root), self.history)
        self.stage = StageController(self.root, Mock())
        self.driver = Mock(connected=True)
        self.driver.identify = AsyncMock()
        self.driver.read_registers = AsyncMock(return_value=[12000] * 4)
        self.driver.write_current = AsyncMock()
        self.driver.close = AsyncMock()
        self.factory = Mock(return_value=self.driver)
        self.analog = AnalogOutput(self.root, self.engine.snapshot, Mock(), self.factory)
        self.analog.config = AnalogConfig(host='192.168.0.7')
        self.connections = DeviceConnections(self.engine, self.stage, self.analog)

    async def asyncTearDown(self):
        if self.stage.driver:
            await self.stage.disconnect()
        self.history.close()
        self.temp.cleanup()

    async def test_analog_reconnect_merges_connection_only_and_never_enables(self):
        self.analog.config.outputs[1].offset_ma = .125
        self.analog.config.outputs[2].label = 'pressure'
        result = await self.connections.apply('analog', {'host':'192.168.0.8'}, 'test')
        self.assertTrue(result['ok'])
        self.assertTrue(result['config_saved'])
        self.assertFalse(result['state']['enabled'])
        self.assertEqual(self.analog.config.outputs[1].offset_ma, .125)
        self.assertEqual(self.analog.config.outputs[2].label, 'pressure')
        self.factory.assert_called_once_with('192.168.0.8', 8234, 1, timeout_s=.8)
        self.driver.write_current.assert_not_awaited()

    async def test_invalid_connection_is_rejected_before_stop_or_disk_write(self):
        self.analog.driver = self.driver
        for changes in ({'host':'not-an-ip'}, {'outputs':[]}, {'port':0}):
            with self.assertRaises(ValueError):
                await self.connections.apply('analog', changes, 'test')
        self.driver.close.assert_not_awaited()
        self.assertFalse(self.analog.path.exists())

    async def test_old_manual_output_must_stop_before_target_changes(self):
        self.analog.driver = self.driver
        await self.analog.manual(ManualCurrent(channel=2, current_ma=12), 'test')
        self.driver.write_current.side_effect = OSError('old device offline')
        result = await self.connections.apply('analog', {'host':'192.168.0.8'}, 'test')
        self.assertFalse(result['ok'])
        self.assertEqual(result['phase'], 'stop')
        self.assertFalse(result['config_saved'])
        self.assertEqual(self.analog.config.host, '192.168.0.7')
        self.driver.close.assert_not_awaited()
        self.factory.assert_not_called()

    async def test_save_failure_never_connects_and_new_target_failure_keeps_saved_config(self):
        with patch.object(self.analog, '_save', side_effect=OSError('disk full')):
            result = await self.connections.apply('analog', {'host':'192.168.0.8'}, 'test')
        self.assertFalse(result['config_saved'])
        self.assertEqual(result['phase'], 'save')
        self.factory.assert_not_called()
        self.driver.identify.side_effect = OSError('new target offline')
        result = await self.connections.apply('analog', {'host':'192.168.0.8'}, 'test')
        self.assertFalse(result['ok'])
        self.assertTrue(result['config_saved'])
        self.assertFalse(result['connected'])
        self.assertEqual(result['phase'], 'connect')
        self.assertEqual(self.analog.config.host, '192.168.0.8')

    async def test_cancel_and_duplicate_submission_cannot_continue_after_disconnect(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def close():
            entered.set()
            await release.wait()
        self.analog.driver = self.driver
        self.driver.close.side_effect = close
        operation = asyncio.create_task(self.connections.apply('analog', {'host':'192.168.0.8'}, 'test'))
        await entered.wait()
        with self.assertRaises(RuntimeError):
            await self.connections.apply('analog', {}, 'test')
        self.assertTrue(self.connections.busy_for('/api/analog-output/config'))
        self.assertTrue(self.connections.busy_for('/api/debug/analog-output'))
        self.connections.cancel('analog')
        release.set()
        result = await operation
        self.assertFalse(result['ok'])
        self.assertFalse(result['config_saved'])
        self.factory.assert_not_called()
        self.assertFalse(self.connections.pending)

    async def test_stage_apply_stops_and_reconnects_without_move_or_enable(self):
        await self.stage.configure(StageConfig(mode='simulation'), 'test')
        await self.stage.connect('test')
        old = self.stage.driver
        old.stop = Mock(wraps=old.stop)
        result = await self.connections.apply('stage', {'host':'192.168.0.9'}, 'test')
        self.assertTrue(result['ok'])
        old.stop.assert_called_once()
        self.assertFalse(result['state']['motion_pending'])
        self.assertEqual(self.stage.driver.counts, {1:0, 2:0, 3:0})
        self.assertEqual(self.stage.config.channel_names, {'1':'','2':'','3':''})

    async def test_io_reconnect_is_independent_and_old_unknown_output_blocks_changes(self):
        self.engine.connect_io = AsyncMock(return_value={'ok':True})
        self.engine.connect_gauge = AsyncMock()
        result = await self.connections.apply('io', {'dam_serial_port':'COM9'}, 'test')
        self.assertTrue(result['ok'])
        self.engine.connect_io.assert_awaited_once()
        self.engine.connect_gauge.assert_not_awaited()
        self.assertEqual(self.engine.config.dam_serial_port, 'COM9')
        self.engine._off_retry_pending = True
        self.engine.close_valve = AsyncMock()
        result = await self.connections.apply('io', {'dam_serial_port':'COM12'}, 'test')
        self.assertFalse(result['ok'])
        self.assertEqual(self.engine.config.dam_serial_port, 'COM9')

    async def test_analog_partial_patch_merges_channels_and_rejects_invalid_full_result(self):
        self.analog.config.outputs[2].label = 'keep'
        await self.analog.patch_config({'outputs':[{'channel':2,'offset_ma':.125}]}, 'test')
        self.assertEqual(self.analog.config.outputs[1].offset_ma,.125)
        self.assertEqual(self.analog.config.outputs[2].label,'keep')
        self.assertEqual(self.analog.config.host,'192.168.0.7')
        for changes in ({'outputs':[{'channel':2,'enabled':True}]}, {'outputs':[{'channel':1},{'channel':1}]}, {'outputs':[{'channel':5}]}, {'unknown':1}):
            with self.assertRaises(ValueError):
                await self.analog.patch_config(changes,'test')
        self.driver.write_current.assert_not_awaited()

    async def test_io_save_failure_keeps_persisted_and_runtime_config_and_never_connects(self):
        original = self.engine.config_store.get_config().model_dump()
        self.engine.connect_io = AsyncMock()
        with patch.object(self.engine.config_store, 'save', side_effect=OSError('disk full')):
            result = await self.connections.apply('io', {'dam_serial_port':'COM9'}, 'test')
        self.assertFalse(result['ok'])
        self.assertFalse(result['config_saved'])
        self.assertEqual(result['phase'],'save')
        self.engine.connect_io.assert_not_awaited()
        self.assertEqual(self.engine.config_store.get_config().model_dump(),original)
        self.assertEqual(self.engine.config.model_dump(),original)

    async def test_new_default_register_and_legacy_missing_address_are_distinct(self):
        self.assertEqual(AnalogConfig().register_base,10)
        self.analog.path.write_text('{}',encoding='utf-8')
        reloaded = AnalogOutput(self.root,self.engine.snapshot,Mock())
        self.assertIsNone(reloaded.config.register_base)
