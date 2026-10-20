"""The XA ownership guard must be measurable, never assumed.

It previously spawned PowerShell and treated empty stdout as "XA is closed".
A restricted service token enumerates no processes there, so the guard passed
while XA still owned the USB device and both programs silently contended.
"""
import ctypes
import os
import random
import subprocess
import unittest
from unittest.mock import patch

from app.drivers import thorlabs_pdxc3 as driver


WINDOWS = unittest.skipUnless(os.name == "nt", "Windows-only process and lease checks")


def release_lease(instance):
    if instance._lease:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle.restype = ctypes.c_bool
        kernel.CloseHandle(instance._lease)
        instance._lease = None


class XaProcessSnapshotTests(unittest.TestCase):
    def test_snapshot_is_empty_off_windows(self):
        if os.name == "nt":
            self.skipTest("Windows keeps the native snapshot path")
        self.assertEqual(driver.running_xa_processes(), [])

    @WINDOWS
    def test_snapshot_returns_pids_without_a_shell(self):
        pids = driver.running_xa_processes()
        self.assertIsInstance(pids, list)
        self.assertTrue(all(isinstance(pid, int) and pid > 0 for pid in pids))

    @WINDOWS
    def test_lease_refuses_while_xa_gui_is_running(self):
        instance = driver.Pdxc3Driver(str(random.randint(10**8, 10**9 - 1)))
        with patch.object(driver, "running_xa_processes", return_value=[4242]):
            with self.assertRaises(RuntimeError) as caught:
                instance._acquire_lease()
        self.assertIn("XA 进程仍在运行", str(caught.exception))
        self.assertIsNone(instance._lease)

    @WINDOWS
    def test_lease_is_taken_when_no_xa_gui_is_found(self):
        instance = driver.Pdxc3Driver(str(random.randint(10**8, 10**9 - 1)))
        try:
            with patch.object(driver, "running_xa_processes", return_value=[]):
                instance._acquire_lease()
            self.assertTrue(instance._lease)
        finally:
            release_lease(instance)


class LocalNetworkDiscoveryTests(unittest.TestCase):
    @WINDOWS
    def test_unreadable_adapter_list_is_reported_not_treated_as_no_network(self):
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="Access denied")
        with patch.object(driver.subprocess, "run", return_value=failed):
            with self.assertRaises(RuntimeError) as caught:
                driver.local_networks()
        self.assertIn("无法读取本机网段信息", str(caught.exception))

    @WINDOWS
    def test_preferred_ipv4_rows_become_bounded_networks(self):
        payload = ('[{"IPAddress":"101.6.241.160","PrefixLength":23},'
                   '{"IPAddress":"169.254.1.1","PrefixLength":16}]')
        completed = subprocess.CompletedProcess([], 0, stdout=payload, stderr="")
        with patch.object(driver.subprocess, "run", return_value=completed):
            networks = driver.local_networks()
        self.assertEqual([str(network) for network in networks], ["101.6.240.0/23"])


if __name__ == "__main__":
    unittest.main()
