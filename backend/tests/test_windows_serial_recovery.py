import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from app.drivers.windows_serial_recovery import _restart, restart_usb_serial


class WindowsRecovery(unittest.IsolatedAsyncioTestCase):
    def test_protected_gauge_port_and_invalid_names_never_launch_a_process(self):
        with patch('app.drivers.windows_serial_recovery.subprocess.run') as run:
            for port in ('com3', 'COM0', 'COM5;bad', 'USB', ''):
                self.assertFalse(_restart(port, 'COM3')['ok'])
            run.assert_not_called()

    def test_only_exact_configured_port_is_passed_without_shell_or_reboot(self):
        response=SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'port':'COM5','device_id':r'USB\VID_1A86&PID_FE0C\DEVICE'}))
        with patch('app.drivers.windows_serial_recovery.subprocess.run',return_value=response) as run:
            self.assertTrue(_restart('COM5','COM3')['ok'])
        kwargs=run.call_args.kwargs
        self.assertEqual(kwargs['env']['VACUUM_RECOVERY_PORT'],'COM5')
        self.assertEqual(kwargs['env']['VACUUM_RECOVERY_PROTECTED_PORT'],'COM3')
        self.assertNotIn('shell',kwargs)
        script=run.call_args.args[0][-1]
        self.assertIn('/restart-device $id',script)
        self.assertNotIn('/reboot',script)
        self.assertNotIn('/deviceid',script)
        self.assertIn("PNPClass='Ports'",script)

    def test_access_denied_and_wrong_port_are_reported_as_failures(self):
        for result in (SimpleNamespace(returncode=5,stdout=json.dumps({'ok':False,'error':'Access denied'})),
                       SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'port':'COM3','device_id':'x'}))):
            with patch('app.drivers.windows_serial_recovery.subprocess.run',return_value=result):
                self.assertFalse(_restart('COM5','COM3')['ok'])

    async def test_cancel_waits_for_os_restart_before_port_can_be_reused(self):
        import threading
        entered,release=threading.Event(),threading.Event()
        def restart(*args):
            entered.set()
            release.wait(1)
            return {'ok':True}
        with patch('app.drivers.windows_serial_recovery._restart',side_effect=restart):
            task=asyncio.create_task(restart_usb_serial('COM5','COM3'))
            await asyncio.to_thread(entered.wait,1)
            task.cancel()
            await asyncio.sleep(.01)
            self.assertFalse(task.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
