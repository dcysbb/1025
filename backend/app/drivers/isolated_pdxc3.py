"""Bound native XA calls in an isolated worker; a hung DLL cannot hang acquisition."""
from __future__ import annotations

import multiprocessing
import time


class NativeCallError(RuntimeError):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def _serve(pipe, config):
    from .thorlabs_pdxc3 import Pdxc3Driver
    driver = Pdxc3Driver(**config)
    allowed = {"connect", "status", "move", "stop", "close", "enable", "zero", "optimize", "parameters", "set_parameters"}
    try:
        while True:
            name, args = pipe.recv()
            if name not in allowed:
                pipe.send((False, "不支持的 SDK 操作", {}))
                continue
            try:
                result = getattr(driver, name)(*args)
                pipe.send((True, result, {"transport": driver.transport, "latency_ms": driver.last_latency_ms, "move_budget_s": driver.move_budget_s}))
            except Exception as exc:
                pipe.send((False, str(exc), {"error_code": getattr(exc, "error_code", None)}))
            if name == "close":
                break
    except (EOFError, BrokenPipeError):
        pass
    finally:
        try:
            driver.close()
        except Exception:
            pass
        pipe.close()


class IsolatedPdxc3Driver:
    DEADLINES = {"connect": 12, "status": 8, "parameters": 12, "set_parameters": 15, "close": 5}

    def __init__(self, serial_number, host="", port=40303, connection="tcp"):
        self.config = dict(serial_number=serial_number, host=host, port=port, connection=connection)
        self.worker = None
        self.pipe = None
        self.transport = ""
        self.last_latency_ms = None
        self.move_budget_s = 30

    def _dispose(self):
        if self.worker:
            if self.worker.is_alive():
                self.worker.terminate()
            self.worker.join(2)
            if self.worker.is_alive():
                self.worker.kill()
                self.worker.join(1)
            self.worker.close()
            self.worker = None
        if self.pipe:
            self.pipe.close()
            self.pipe = None

    def _rpc(self, name, *args):
        if not self.worker or not self.worker.is_alive():
            self._dispose()
            raise RuntimeError("XA 驱动进程已退出；动作结果与停止状态需重新确认")
        try:
            self.pipe.send((name, args))
            if not self.pipe.poll(self.DEADLINES.get(name, 8)):
                self._dispose()
                raise RuntimeError(f"XA {name} 原生调用超时，已释放失效本机会话；未自动重发，可直接重新连接读取状态，运动锁定需单独解除")
            ok, result, diagnostic = self.pipe.recv()
            if not ok:
                raise NativeCallError(result, diagnostic.get("error_code"))
            self.transport = diagnostic.get("transport", self.transport)
            self.last_latency_ms = diagnostic.get("latency_ms")
            self.move_budget_s = diagnostic.get("move_budget_s", 30)
            return result
        except (EOFError, BrokenPipeError, OSError) as exc:
            self._dispose()
            raise RuntimeError("XA 驱动通信中断，未重发指令；可直接重新连接读取状态，运动锁定需单独解除") from exc

    def connect(self):
        for attempt in range(2):
            ctx = multiprocessing.get_context("spawn")
            self.pipe, child = ctx.Pipe()
            self.worker = ctx.Process(target=_serve, args=(child, self.config), daemon=True)
            self.worker.start()
            child.close()
            try:
                self._rpc("connect")
                return
            except Exception as exc:
                self._dispose()
                if attempt or not isinstance(exc, NativeCallError) or exc.code not in (2, 4):
                    if isinstance(exc, NativeCallError):
                        target = (f"网口 {self.config['host'] or '自动发现'}:{self.config['port']}" if self.config['connection'] == 'tcp' else "原生 USB")
                        raise NativeCallError(f"PDXC3 {target} 连接未成功（序列号 {self.config['serial_number']}）。请确认 XA 已完全退出，并检查设备供电及所选连接。厂家 SDK：{exc}", exc.code) from exc
                    raise
                # Connect only; create a fresh DLL process rather than cycling
                # XA Startup/Shutdown in the same process (message-window leak).
                time.sleep(.5)

    def status(self):
        return self._rpc("status")

    def move(self, channel, direction, steps):
        return self._rpc("move", channel, direction, steps)

    def stop(self):
        return self._rpc("stop")

    def enable(self, channel, enabled):
        return self._rpc("enable", channel, enabled)

    def zero(self, channel):
        return self._rpc("zero", channel)

    def optimize(self, channel):
        return self._rpc("optimize", channel)

    def parameters(self, channel):
        return self._rpc("parameters", channel)

    def set_parameters(self, channel, values):
        return self._rpc("set_parameters", channel, values)

    def close(self):
        try:
            if self.worker and self.worker.is_alive():
                self._rpc("close")
                self.worker.join(1)
        finally:
            self._dispose()
