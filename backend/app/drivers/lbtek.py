"""EM-CSx-x SDK 1.0.1. Native USB only; no COM probing or implicit motor setup."""
from __future__ import annotations

import ctypes as c
import math
import multiprocessing
import os
import sys
import time
from pathlib import Path


class MotorState(c.Structure):
    _fields_ = [(name, c.c_short) for name in
                ("can_run", "stopped", "enabled", "home", "limit_left", "limit_right",
                 "left_sensor", "right_sensor", "home_sensor")] + [("jog_index", c.c_uint32)]


def sdk_directory():
    override = os.environ.get("LBTEK_SDK_DIR")
    return Path(override) if override else Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2])) / "vendor" / "lbtek"


class NativeLbtek:
    def __init__(self, usb_port=None):
        self.selected_port = usb_port
        self.port = None
        self.dll = None
        self.base = None
        self.directory_handle = None

    def load(self):
        directory = sdk_directory().resolve()
        if sys.platform != "win32" or c.sizeof(c.c_void_p) != 8:
            raise RuntimeError("LBTEK 原生 USB 驱动需要 Windows 64 位")
        if not (directory / "moverLibrary_x64.dll").is_file():
            raise RuntimeError("未安装 LBTEK SDK，请运行 scripts/install-lbtek-sdk.py，或设置 LBTEK_SDK_DIR")
        self.directory_handle = os.add_dll_directory(str(directory))
        self.dll = c.CDLL(str(directory / "moverLibrary_x64.dll"))
        signatures = {
            "libraryInit": ([], None), "libraryDeInit": ([], None),
            "listLBMotorControlerDevices": ([c.POINTER(c.c_int), c.c_int], c.c_int),
            "addDev": ([c.c_int], c.c_int), "removeDev": ([c.c_int], c.c_int),
            "openLBDevice": ([c.c_int], c.c_int), "closeLBDevice": ([c.c_int], c.c_int),
            "getDevAxisCount": ([c.c_int], c.c_int), "getRockerEnable": ([c.c_int], c.c_int),
            "setRockerEnable": ([c.c_int, c.c_int], c.c_int),
            "getRuningState": ([c.c_int, c.c_uint32, c.POINTER(MotorState)], c.c_int),
            "getCurrentPos": ([c.c_int, c.c_uint32, c.POINTER(c.c_int)], c.c_double),
        }
        for name in ("getSpeed", "getAcceleration"):
            signatures[name] = ([c.c_int, c.c_uint32], c.c_double)
        for name in ("setTargetPos", "setJogStep", "setSpeed", "setAcceleration"):
            signatures[name] = ([c.c_int, c.c_uint32, c.c_double], c.c_int)
        for name in ("setJogCount", "setJogDelay"):
            signatures[name] = ([c.c_int, c.c_uint32, c.c_uint32], c.c_int)
        for name in ("home", "stopRuning", "startMove"):
            signatures[name] = ([c.c_int, c.c_uint32], c.c_int)
        for name in ("startJog", "startDrive", "setRelativeDispEnable"):
            signatures[name] = ([c.c_int, c.c_uint32, c.c_int], c.c_int)
        for name, (args, result) in signatures.items():
            fn = getattr(self.dll, name)
            fn.argtypes, fn.restype = args, result
        self.dll.libraryInit()

    def checked(self, name, *args):
        result = getattr(self.dll, name)(*args)
        if result < 0 or not math.isfinite(result):
            raise RuntimeError(f"LBTEK {name} 失败（SDK 返回 {result}）")
        return result

    def enumerate(self):
        if self.dll is None:
            self.load()
        ports = (c.c_int * 64)()
        count = self.checked("listLBMotorControlerDevices", ports, len(ports))
        if count > len(ports):
            raise RuntimeError("LBTEK 设备数量超出枚举容量")
        return list(ports)[:count]

    def connect(self):
        ports = self.enumerate()
        if self.selected_port is None:
            if len(ports) != 1:
                raise RuntimeError("未发现 LBTEK USB 控制器" if not ports else "发现多台 LBTEK，请在硬件连接中指定 USB 设备端口")
            port = ports[0]
        elif self.selected_port not in ports:
            raise RuntimeError(f"未发现指定的 LBTEK USB 设备端口 {self.selected_port}，请刷新设备列表")
        else:
            port = self.selected_port
        self.checked("addDev", port)
        try:
            self.checked("openLBDevice", port)
        except Exception as exc:
            self.dll.removeDev(port)
            raise RuntimeError(f"LBTEK USB 无法打开，请断开 SyncMotion 的设备连接并检查供电。{exc}") from exc
        self.port = port
        if self.checked("getDevAxisCount", port) != 3:
            raise RuntimeError("连接目标不是三轴控制器，未开放运动操作")
        # The package examples use 0..2, while the PDF says 1..3. Resolve
        # the installed firmware using read-only boundary queries, never motion.
        valid = []
        for axis in (0, 3):
            state, ok = MotorState(), c.c_int(-999999)
            result = self.dll.getRuningState(port, axis, c.byref(state))
            self.dll.getCurrentPos(port, axis, c.byref(ok))
            valid.append(result >= 0 and ok.value >= 0)
        if valid == [True, False]:
            self.base = 0
        elif valid == [False, True]:
            self.base = 1
        else:
            raise RuntimeError("SDK 轴编号未能明确识别，未开放运动；请检查固件与 SDK 版本")
        return self.status()

    def axis(self, channel):
        if self.port is None or self.base is None or channel not in (1, 2, 3):
            raise RuntimeError("LBTEK 通道或连接无效")
        return channel - 1 + self.base

    def status(self):
        rows = []
        for channel in (1, 2, 3):
            axis, state, ok = self.axis(channel), MotorState(), c.c_int(-999999)
            self.checked("getRuningState", self.port, axis, c.byref(state))
            pos = self.dll.getCurrentPos(self.port, axis, c.byref(ok))
            # The shipped DLL writes an integer result code (0 on success),
            # despite the PDF describing this out parameter as a boolean.
            if ok.value < 0 or not math.isfinite(pos):
                raise RuntimeError(f"LBTEK CH{channel} 坐标读取失败")
            rows.append({"channel": channel, **{name: bool(getattr(state, name)) for name, _ in MotorState._fields_[:-1]},
                         "position": pos, "speed": self.checked("getSpeed", self.port, axis),
                         "acceleration": self.checked("getAcceleration", self.port, axis)})
        return {"channels": rows, "usb_port": self.port, "axis_base": self.base,
                "rocker_enabled": bool(self.checked("getRockerEnable", self.port))}

    def action(self, operation, channel, value=None):
        axis = self.axis(channel)
        if operation == "relative":
            self.checked("setJogStep", self.port, axis, abs(value))
            self.checked("setJogCount", self.port, axis, 1)
            self.checked("setJogDelay", self.port, axis, 0)
            self.checked("startJog", self.port, axis, 1 if value > 0 else 2)
        elif operation == "absolute":
            self.checked("setTargetPos", self.port, axis, value)
            self.checked("startMove", self.port, axis)
        elif operation == "home":
            self.checked("home", self.port, axis)
        elif operation == "drive":
            self.checked("setRelativeDispEnable", self.port, axis, 0)
            self.checked("startDrive", self.port, axis, 1 if value > 0 else 2)
        else:
            raise ValueError("不支持的 LBTEK 动作")

    def parameters(self, channel, speed, acceleration):
        axis = self.axis(channel)
        self.checked("setSpeed", self.port, axis, speed)
        self.checked("setAcceleration", self.port, axis, acceleration)
        state = self.status()
        row = state["channels"][channel - 1]
        if not math.isclose(row["speed"], speed, rel_tol=.001, abs_tol=.000001) or not math.isclose(row["acceleration"], acceleration, rel_tol=.001, abs_tol=.000001):
            raise RuntimeError("控制器读回的速度/加速度与输入不同，请核对位移台允许范围；已显示实际读回值")
        return state

    def rocker(self, enabled):
        self.checked("setRockerEnable", self.port, int(enabled))

    def stop(self, channel=None):
        errors = []
        for ch in (channel,) if channel else (1, 2, 3):
            try:
                self.checked("stopRuning", self.port, self.axis(ch))
            except Exception as exc:
                errors.append(str(exc))
        if errors:
            raise RuntimeError("；".join(errors))

    def close(self):
        if self.dll is not None:
            try:
                if self.port is not None:
                    self.checked("closeLBDevice", self.port)
                    self.dll.removeDev(self.port)
            finally:
                self.port = None
                self.dll.libraryDeInit()
                self.dll = None
                if self.directory_handle:
                    self.directory_handle.close()


def _serve(pipe, config):
    driver = NativeLbtek(**config)
    lease, deadline = None, 0
    try:
        while True:
            if lease and time.monotonic() > deadline:
                driver.stop()
                lease = None
            if not pipe.poll(.05):
                continue
            name, args = pipe.recv()
            try:
                if name == "keepalive":
                    if args[0] != lease:
                        raise RuntimeError("按住操作已结束，请松开按钮")
                    deadline = time.monotonic() + 1
                    result = None
                elif name == "drive":
                    channel, direction, token = args
                    # Set the guard before issuing a command with uncertain outcome.
                    lease, deadline = token, time.monotonic() + 1
                    driver.action("drive", channel, direction)
                    result = None
                elif name in {"enumerate", "connect", "status", "action", "parameters", "rocker", "stop", "close"}:
                    result = getattr(driver, name)(*args)
                    if name in {"stop", "close"}:
                        lease = None
                    if name in {"connect", "status"}:
                        result["lease_id"] = lease
                else:
                    raise ValueError("不支持的 SDK 操作")
                pipe.send((True, result))
            except Exception as exc:
                pipe.send((False, str(exc)))
            if name == "close":
                break
    except (EOFError, BrokenPipeError):
        pass
    finally:
        try:
            if lease:
                driver.stop()
        finally:
            driver.close()
            pipe.close()


class LbtekDriver:
    """Single owner process bounds native hangs and guards hold-to-run leases."""
    def __init__(self, usb_port=None):
        self.config = {"usb_port": usb_port}
        self.worker = self.pipe = None

    def _dispose(self):
        if self.worker:
            if self.worker.pid is not None:
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

    def call(self, name, *args):
        if not self.worker:
            if name not in {"connect", "enumerate"}:
                raise RuntimeError("LBTEK USB 会话已结束，请重新连接并停止恢复")
            ctx = multiprocessing.get_context("spawn")
            self.pipe, child = ctx.Pipe()
            self.worker = ctx.Process(target=_serve, args=(child, self.config), daemon=True)
            self.worker.start()
            child.close()
        try:
            self.pipe.send((name, args))
            if not self.pipe.poll(15 if name == "connect" else 5):
                self._dispose()
                raise RuntimeError(f"LBTEK {name} 超时，动作结果未确认，未自动重发；请重新连接并停止恢复")
            ok, result = self.pipe.recv()
        except (EOFError, BrokenPipeError, OSError) as exc:
            self._dispose()
            raise RuntimeError("LBTEK SDK 会话中断，动作结果未确认，请重新连接并停止恢复") from exc
        if not ok:
            raise RuntimeError(result)
        return result

    def close(self):
        try:
            if self.worker and self.worker.is_alive():
                self.call("close")
        finally:
            self._dispose()
