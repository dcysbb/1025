"""Desktop entry point: reuse the local server or start it before opening a browser."""
from __future__ import annotations

import ctypes
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.request
import webbrowser
from contextlib import contextmanager
from pathlib import Path

from .configuration import data_directory


def connection_options(root: Path):
    config_file = root / "config.json"
    config = json.loads(config_file.read_text("utf-8-sig")).get("config", {}) if config_file.exists() else {}
    port = int(os.environ.get("VACUUM_INTERLOCK_PORT", "8770"))
    if not 1 <= port <= 65535:
        raise ValueError("VACUUM_INTERLOCK_PORT must be between 1 and 65535")
    url = f"{'https' if config.get('allow_lan') else 'http'}://127.0.0.1:{port}"
    return url, port


def server_ready(url: str, root: Path) -> bool:
    try:
        handlers = [urllib.request.ProxyHandler({})]
        if url.startswith("https:"):
            handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(root / "lan-cert.pem"))))
        with urllib.request.build_opener(*handlers).open(url + "/api/health", timeout=1) as response:
            result = json.load(response)
            return isinstance(result, dict) and result.get("ok") is True and bool(result.get("version"))
    except (OSError, ValueError):
        return False


@contextmanager
def startup_lock(port: int):
    handle = None
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel.CreateMutexW(None, False, f"Local\\VacuumInterlock.Desktop.{port}")
        if not handle:
            raise OSError("无法取得控制台启动锁")
        already_starting = ctypes.get_last_error() == 183
    else:
        already_starting = False
    try:
        yield not already_starting
    finally:
        if handle:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(handle)


def start_backend(logs: Path):
    command = [sys.executable]
    if not getattr(sys, "frozen", False):
        command.append(str(Path(__file__).resolve().parents[1] / "run.py"))
    with (logs / "console-stdout.log").open("ab") as stdout, (logs / "console-stderr.log").open("ab") as stderr:
        return subprocess.Popen(command, cwd=str(Path(sys.executable).parent) if getattr(sys, "frozen", False) else str(Path(__file__).resolve().parents[1]),
                                stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def open_console() -> str:
    root = data_directory()
    url, port = connection_options(root)
    with startup_lock(port) as may_start:
        if not server_ready(url, root):
            log_root = Path(os.environ.get("LOCALAPPDATA", str(root))) / "VacuumInterlock" / "logs" if os.name == "nt" else root / "logs"
            logs = log_root / f"startup-{time.time_ns()}-{os.getpid()}"
            logs.mkdir(parents=True, exist_ok=True)
            child = start_backend(logs) if may_start else None
            deadline = time.monotonic() + 45
            while not server_ready(url, root):
                if child is not None and child.poll() is not None:
                    raise RuntimeError(f"控制台后台启动失败（退出码 {child.returncode}）。\n请查看：{logs / 'console-stderr.log'}")
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"控制台后台尚未就绪，请勿反复启动。\n地址：{url}\n请查看：{logs / 'console-stderr.log'}")
                time.sleep(.25)
    if not webbrowser.open(url):
        raise RuntimeError(f"后台已启动，但无法打开默认浏览器。\n请手动打开：{url}")
    return url


def launch() -> int:
    try:
        open_console()
        return 0
    except Exception as exc:
        message = str(exc)
        if os.name == "nt":
            ctypes.windll.user32.MessageBoxW(None, message, "真空联锁控制台启动失败", 0x10)
        else:
            print(message, file=sys.stderr)
        return 1
