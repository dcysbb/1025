import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from pydantic import ValidationError
from app.configuration import ConfigurationStore
from app.engine import InterlockEngine, InterlockError
from app.models import AppConfig
from app.storage import HistoryStore
from app.stage import StageConfig
from app.drivers.thorlabs_pdxc3 import Pdxc3Driver


class HardwareConfigTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = ConfigurationStore(root)
        self.history = HistoryStore(root / 'history.sqlite3')
        self.engine = InterlockEngine(self.store, self.history)

    async def asyncTearDown(self):
        self.history.close()
        self.temp.cleanup()

    async def test_legacy_defaults_and_bounded_terminal_definitions(self):
        self.assertEqual(AppConfig().dam_input_labels, [''] * 8)
        self.assertEqual(StageConfig().connection, 'tcp')
        for changes in ({'dam_input_labels': ['x']}, {'dam_output_notes': ['x' * 161] * 8}):
            with self.assertRaises(ValidationError): AppConfig(**changes)
        self.assertEqual(AppConfig(dam_output_labels=[' x '] * 8).dam_output_labels, ['x'] * 8)

    async def test_caption_only_save_never_touches_outputs_or_interlock(self):
        self.engine.interlock = 'armed'
        self.engine._safe_open_output = AsyncMock()
        self.engine._clear_debug_outputs = AsyncMock()
        self.engine.connect_devices = AsyncMock()
        before = self.engine.config.channels
        await self.engine.patch_config({'dam_output_labels': ['阀门'] + [''] * 7})
        self.assertEqual(self.engine.interlock, 'armed')
        self.assertEqual(self.engine.config.channels, before)
        self.engine._safe_open_output.assert_not_called()
        self.engine._clear_debug_outputs.assert_not_called()
        self.engine.connect_devices.assert_not_called()
        self.assertEqual(ConfigurationStore(Path(self.temp.name)).get_config().dam_output_labels[0], '阀门')

    async def test_mapping_save_latches_and_revokes_confirmation_without_reconnect(self):
        self.engine.interlock = 'armed'
        self.engine.config.fail_closed_confirmed = True
        self.engine._safe_open_output = AsyncMock()
        self.engine.connect_devices = AsyncMock()
        await self.engine.patch_config({'open_output': 4})
        self.assertEqual(self.engine.interlock, 'tripped')
        self.assertFalse(self.engine.config.fail_closed_confirmed)
        self.engine._safe_open_output.assert_awaited_once()
        self.engine.connect_devices.assert_not_called()

    async def test_invalid_patch_cannot_touch_hardware_or_overwrite_other_fields(self):
        self.engine._safe_open_output = AsyncMock()
        before = self.engine.config.model_dump()
        for changes in ({'valve_open_di': 0}, {'open_output': 8}, {'dam_input_labels': []}, {'unknown': 1},
                        {'tpg_connection': 'usb', 'tpg_serial_port': 'COM3', 'dam_serial_port': '\\\\.\\com3'}):
            with self.assertRaises(ValueError): await self.engine.patch_config(changes)
        self.assertEqual(self.engine.config.model_dump(), before)
        self.engine._safe_open_output.assert_not_called()
        await self.engine.patch_config({'dam_input_notes': ['反馈'] * 8})
        self.assertEqual(self.engine.config.channels, AppConfig.model_validate(before).channels)

    async def test_saved_transport_waits_for_explicit_connect(self):
        self.engine._safe_open_output = AsyncMock()
        self.engine.connect_devices = AsyncMock()
        await self.engine.patch_config({'mode': 'real', 'tpg_connection': 'usb', 'tpg_serial_port': 'COM3'})
        self.engine._poll_tpg = AsyncMock()
        self.engine._poll_io = AsyncMock()
        await self.engine._gauge_cycle(0)
        await self.engine._io_cycle()
        self.engine._poll_tpg.assert_not_called()
        self.engine._poll_io.assert_not_called()
        self.engine.connect_devices.assert_not_called()

    async def test_unconfirmed_old_output_prevents_rerouting(self):
        self.engine._safe_open_output = AsyncMock()
        self.engine._off_retry_pending = True
        with self.assertRaisesRegex(InterlockError, '关闭尚未确认'):
            await self.engine.patch_config({'open_output': 3})
        self.assertEqual(self.engine.config.open_output, 0)
        self.assertEqual(self.store.get_config().open_output, 0)

    async def test_new_valve_output_is_off_before_mapping_becomes_active(self):
        self.engine.config = AppConfig(mode='real')
        self.engine.mode = 'real'
        self.engine.adam = Mock()
        self.engine._safe_open_output = AsyncMock()
        self.engine._write_output = AsyncMock()
        await self.engine.patch_config({'open_output': 2})
        self.engine._write_output.assert_awaited_once_with(2, False)
        self.assertEqual(self.engine.config.open_output, 2)

    async def test_io_connect_is_independent_and_does_not_enable_outputs(self):
        self.engine.config = AppConfig(mode='real', dam_serial_port='COM4')
        self.engine.mode = 'real'
        self.engine.connect_gauge = AsyncMock()
        self.engine._poll_io = AsyncMock()
        self.engine._write_output = AsyncMock()
        with patch('app.engine.Dam0808DClient') as factory:
            result = await self.engine.connect_io()
        self.assertTrue(result['ok'])
        self.engine.connect_gauge.assert_not_called()
        self.engine._write_output.assert_not_called()
        factory.assert_called_once_with('COM4', 9600, 1)


class UsbRoutingTests(unittest.TestCase):
    def setUp(self):
        lease = patch.object(Pdxc3Driver, '_acquire_lease')
        lease.start()
        self.addCleanup(lease.stop)

    def test_usb_uses_exact_native_usb_transport_and_no_com_or_tcp_discovery(self):
        from thorlabs_xa.shared.system_manager import SystemManager
        manager = Mock()
        manager.open_device_as.return_value.transport = 'USB129123456'
        for subchannel in manager.open_device_as.return_value.get_subchannel.return_value,:
            subchannel.get_stage_axis_params.return_value.part_number = 'PD1V/M'
        manager.get_device_list.return_value = [
            SimpleNamespace(part_number='PDXC3', device='129123456', transport='101.6.241.172:40303'),
            SimpleNamespace(part_number='PDXC3', device='129123456', transport='USB129123456'),
            SimpleNamespace(part_number='TPG366', device='129123456', transport='COM3')]
        driver = Pdxc3Driver('129123456', '101.6.241.172', connection='usb')
        with patch.object(SystemManager, 'instance', return_value=manager), patch.object(driver, 'discover') as discover:
            driver.connect()
        args = manager.open_device_as.call_args.args
        self.assertEqual(args[:2], ('129123456', 'USB129123456'))
        discover.assert_not_called()
        self.assertIn('deviceDiscovery.connections=\n', manager.startup.call_args.args[0])
        for channel in driver.channels.values():
            channel.set_enable_state.assert_not_called()
            channel.move.assert_not_called()
            channel.home.assert_not_called()

    def test_missing_usb_never_falls_back_to_tcp(self):
        driver = Pdxc3Driver('129123456', '101.6.241.172', connection='usb')
        driver.manager = Mock()
        driver.manager.get_device_list.return_value = [SimpleNamespace(part_number='PDXC3', device='129123456', transport='COM3')]
        with patch('app.drivers.thorlabs_pdxc3.time.monotonic', side_effect=[0, 6]):
            with self.assertRaisesRegex(RuntimeError, 'USB'): driver.find_usb_transport()
        driver.manager.open_device_as.assert_not_called()

    def test_windows_usb_empty_transport_is_valid_only_after_exact_device_match(self):
        from thorlabs_xa.shared.system_manager import SystemManager
        from thorlabs_xa.shared.map_python_to_native import MapPythonToNative
        manager = Mock()
        manager.open_device_as.return_value.transport = ''
        manager.open_device_as.return_value.get_subchannel.return_value.get_stage_axis_params.return_value.part_number = 'PD1V/M'
        manager.get_device_list.return_value = [
            SimpleNamespace(part_number='PDXC3', device='129999999', transport=''),
            SimpleNamespace(part_number='PDXC3', device='129123456', transport=''),
            SimpleNamespace(part_number='TPG366', device='129123456', transport='COM3')]
        driver = Pdxc3Driver('129123456', '101.6.241.172', connection='usb')
        with patch.object(SystemManager, 'instance', return_value=manager), patch.object(driver, 'discover') as discover:
            driver.connect()
        self.assertEqual(manager.open_device_as.call_args.args[:2], ('129123456', ''))
        self.assertEqual(MapPythonToNative.string(''), b'')  # Empty, non-NULL SDK transport.
        self.assertEqual(driver.transport, 'USB / 129123456')
        discover.assert_not_called()
        for channel in driver.channels.values():
            channel.set_enable_state.assert_not_called()
            channel.move.assert_not_called()
            channel.home.assert_not_called()

    def test_tcp_discovery_cannot_use_the_usb_empty_transport(self):
        from thorlabs_xa.shared.system_manager import SystemManager
        manager = Mock()
        driver = Pdxc3Driver('129123456', connection='tcp')
        with patch.object(SystemManager, 'instance', return_value=manager), patch.object(driver, 'discover', return_value=[SimpleNamespace(part_number='PDXC3', device='129123456', transport='')]):
            with self.assertRaisesRegex(RuntimeError, '缺少传输标识'):
                driver.connect()
        manager.open_device_as.assert_not_called()

    def test_usb_never_accepts_a_null_transport_or_ambiguous_serial(self):
        driver = Pdxc3Driver('129123456', connection='usb')
        driver.manager = Mock()
        driver.manager.get_device_list.return_value = [SimpleNamespace(part_number='PDXC3', device='129123456', transport=None)]
        with patch('app.drivers.thorlabs_pdxc3.time.monotonic', side_effect=[0, 0, 6]), patch('app.drivers.thorlabs_pdxc3.time.sleep'):
            with self.assertRaisesRegex(RuntimeError, '未找到'):
                driver.find_usb_transport()
        driver.manager.get_device_list.return_value = [SimpleNamespace(part_number='PDXC3', device='129123456', transport='')] * 2
        with self.assertRaisesRegex(RuntimeError, '多个匹配'):
            driver.find_usb_transport()

    def test_tcp_remains_explicit_and_move_skips_unsupported_model_setter(self):
        from thorlabs_xa.shared.system_manager import SystemManager
        manager = Mock()
        manager.open_device_as.return_value.transport = '101.6.241.172:40303'
        manager.open_device_as.return_value.get_subchannel.return_value.get_stage_axis_params.return_value.part_number = 'PD1V/M'
        driver = Pdxc3Driver('129123456', '101.6.241.172')
        with patch.object(SystemManager, 'instance', return_value=manager): driver.connect()
        self.assertEqual(manager.open_device_as.call_args.args[1], '101.6.241.172:40303')
        channel = driver.channels[1]
        driver._set_setting = Mock()
        channel.get_setting.side_effect = lambda key, _: SimpleNamespace(is_value_set=True, value={'jog.mode':2,'jog.openLoopStepSize':1,'jog.openLoopMaxVelocity':5000,'jog.openLoopAcceleration':1000}[key])
        driver.move(1, 1, 1)
        channel.set_connected_product.assert_not_called()
        channel.move.assert_called_once()

    def test_native_tcp_fallback_to_usb_is_rejected_before_any_control(self):
        from thorlabs_xa.shared.system_manager import SystemManager
        manager = Mock()
        manager.open_device_as.return_value.transport = ''
        driver = Pdxc3Driver('129123456', '192.0.2.17', connection='tcp')
        with patch.object(SystemManager, 'instance', return_value=manager):
            with self.assertRaisesRegex(RuntimeError, '原生 USB.*192.0.2.17:40303.*不一致'):
                driver.connect()
        self.assertEqual(driver.channels, {})
        manager.open_device_as.return_value.get_subchannel.assert_not_called()

    def test_native_usb_fallback_to_another_transport_is_rejected(self):
        from thorlabs_xa.shared.system_manager import SystemManager
        manager = Mock()
        manager.open_device_as.return_value.transport = '192.0.2.17:40303'
        manager.get_device_list.return_value = [SimpleNamespace(part_number='PDXC3', device='129123456', transport='')]
        driver = Pdxc3Driver('129123456', connection='usb')
        with patch.object(SystemManager, 'instance', return_value=manager):
            with self.assertRaisesRegex(RuntimeError, '不一致'):
                driver.connect()
        manager.open_device_as.return_value.get_subchannel.assert_not_called()
