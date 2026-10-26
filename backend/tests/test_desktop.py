import json
import os
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

from app import desktop


class DesktopLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        environment = patch.dict(os.environ, {'LOCALAPPDATA': str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)

    def test_existing_server_opens_browser_without_starting_hardware_again(self):
        with patch.object(desktop, 'data_directory', return_value=self.root), \
             patch.object(desktop, 'startup_lock', return_value=nullcontext(True)), \
             patch.object(desktop, 'server_ready', return_value=True), \
             patch.object(desktop, 'start_backend') as start, \
             patch.object(desktop.webbrowser, 'open', return_value=True) as browser:
            self.assertEqual(desktop.open_console(), 'http://127.0.0.1:8770')
        start.assert_not_called()
        browser.assert_called_once_with('http://127.0.0.1:8770')

    def test_browser_waits_for_http_health_before_opening(self):
        child = Mock(); child.poll.return_value = None
        with patch.object(desktop, 'data_directory', return_value=self.root), \
             patch.object(desktop, 'startup_lock', return_value=nullcontext(True)), \
             patch.object(desktop, 'server_ready', side_effect=[False, False, True]), \
             patch.object(desktop, 'start_backend', return_value=child) as start, \
             patch.object(desktop.time, 'sleep') as sleep, \
             patch.object(desktop.webbrowser, 'open', return_value=True) as browser:
            self.assertEqual(desktop.open_console(), 'http://127.0.0.1:8770')
        start.assert_called_once()
        self.assertEqual(start.call_args.args[0].parent, self.root / 'VacuumInterlock' / 'logs' if os.name == 'nt' else self.root / 'logs')
        self.assertTrue(start.call_args.args[0].name.startswith('startup-'))
        sleep.assert_called_once()
        browser.assert_called_once()

    def test_second_click_waits_for_the_first_launcher_without_duplicate_backend(self):
        with patch.object(desktop, 'data_directory', return_value=self.root), \
             patch.object(desktop, 'startup_lock', return_value=nullcontext(False)), \
             patch.object(desktop, 'server_ready', side_effect=[False, False, True]), \
             patch.object(desktop, 'start_backend') as start, \
             patch.object(desktop.time, 'sleep'), \
             patch.object(desktop.webbrowser, 'open', return_value=True):
            desktop.open_console()
        start.assert_not_called()

    def test_new_start_does_not_reuse_protected_legacy_log_files(self):
        legacy = self.root / 'logs'
        legacy.mkdir()
        (legacy / 'console-stdout.log').write_text('previous installation')
        with patch.object(desktop, 'data_directory', return_value=self.root), \
             patch.object(desktop, 'startup_lock', return_value=nullcontext(True)), \
             patch.object(desktop, 'server_ready', side_effect=[False, True, False, True]), \
             patch.object(desktop, 'start_backend') as start, \
             patch.object(desktop.webbrowser, 'open', return_value=True):
            desktop.open_console()
            desktop.open_console()
        first, second = [call.args[0] for call in start.call_args_list]
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, legacy)
        self.assertEqual((legacy / 'console-stdout.log').read_text(), 'previous installation')

    def test_backend_failure_reports_log_path_instead_of_opening_a_dead_page(self):
        child = Mock(returncode=23); child.poll.return_value = 23
        with patch.object(desktop, 'data_directory', return_value=self.root), \
             patch.object(desktop, 'startup_lock', return_value=nullcontext(True)), \
             patch.object(desktop, 'server_ready', return_value=False), \
             patch.object(desktop, 'start_backend', return_value=child), \
             patch.object(desktop.webbrowser, 'open') as browser:
            with self.assertRaisesRegex(RuntimeError, '23.*|console-stderr.log') as error:
                desktop.open_console()
        self.assertIn('console-stderr.log', str(error.exception))
        browser.assert_not_called()

    def test_https_uses_local_certificate_with_verification(self):
        (self.root / 'config.json').write_text(json.dumps({'config': {'allow_lan': True}}))
        with patch.dict(os.environ, {'VACUUM_INTERLOCK_PORT': '8771'}):
            self.assertEqual(desktop.connection_options(self.root), ('https://127.0.0.1:8771', 8771))
        with patch.object(desktop.ssl, 'create_default_context', side_effect=OSError) as context:
            self.assertFalse(desktop.server_ready('https://127.0.0.1:8771', self.root))
        context.assert_called_once_with(cafile=str(self.root / 'lan-cert.pem'))

    def test_frozen_backend_child_does_not_inherit_browser_flag(self):
        with patch.object(desktop.sys, 'frozen', True, create=True), \
             patch.object(desktop.subprocess, 'Popen') as spawn:
            desktop.start_backend(self.root)
        self.assertEqual(spawn.call_args.args[0], [sys.executable])
        self.assertEqual(spawn.call_args.kwargs['stdin'], desktop.subprocess.DEVNULL)
        self.assertTrue((self.root / 'console-stderr.log').exists())

    def test_browser_failure_explains_that_backend_is_already_ready(self):
        with patch.object(desktop, 'data_directory', return_value=self.root), \
             patch.object(desktop, 'startup_lock', return_value=nullcontext(True)), \
             patch.object(desktop, 'server_ready', return_value=True), \
             patch.object(desktop.webbrowser, 'open', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'http://127.0.0.1:8770'):
                desktop.open_console()

    def test_native_failure_dialog_displays_the_actual_error(self):
        with patch.object(desktop, 'open_console', side_effect=RuntimeError('backend failure')), \
             patch.object(desktop.os, 'name', 'nt'), \
             patch.object(desktop.ctypes, 'windll', create=True) as native:
            self.assertEqual(desktop.launch(), 1)
        native.user32.MessageBoxW.assert_called_once_with(None, 'backend failure', '1025控制台启动失败', 0x10)
