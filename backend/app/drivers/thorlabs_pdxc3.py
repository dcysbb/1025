"""PDXC3 USB/Ethernet adapter using Thorlabs XA 1.8 and its documented C ABI.

The Python SDK omits DiscoverEthernetDeviceInfo; bind that single function using
the published tlmc_xa_native_api.h. TCP 40303 and explicit transports are described
in TLMC_Open / TLMC_DiscoverEthernetDeviceInfo. No serial discovery is requested.
"""
from __future__ import annotations

import ctypes
import ipaddress
import json
import math
import os
import re
import subprocess
import time


def local_networks():
    if os.name != "nt":
        raise RuntimeError("请填写控制器 IPv4 地址；此系统未启用自动网段发现")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' } | "
         "Select-Object IPAddress,PrefixLength | ConvertTo-Json -Compress"],
        capture_output=True, text=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
    data = json.loads(result.stdout or "[]")
    rows = data if isinstance(data, list) else [data]
    networks = set()
    for row in rows:
        addr = ipaddress.IPv4Address(row["IPAddress"])
        if addr.is_loopback or addr.is_link_local:
            continue
        # Bound discovery to at most 1024 addresses per interface.
        prefix = max(22, int(row["PrefixLength"]))
        networks.add(ipaddress.IPv4Network(f"{addr}/{prefix}", strict=False))
    return sorted(networks, key=str)


class Pdxc3Driver:
    TIMEOUT_MS = 2000
    PARAMETERS = {
        "forward_amplitude": "amplifierOutput.forwardAmplifierLevel",
        "reverse_amplitude": "amplifierOutput.reverseAmplifierLevel",
        "step_rate": "jog.openLoopMaxVelocity",
        "acceleration": "jog.openLoopAcceleration",
    }

    def __init__(self, serial_number, host="", port=40303, connection="tcp"):
        self.serial_number = serial_number
        self.host = host
        self.port = port
        self.connection = connection
        self.manager = None
        self.device = None
        self.channels = {}
        self.stage_names = {}
        self.transport = ""
        self._lease = None
        self.last_latency_ms = None
        self.move_budget_s = 30

    def connect(self):
        self._acquire_lease()
        try:
            from thorlabs_xa.shared.system_manager import SystemManager
            from thorlabs_xa.shared.enums import TLMC_OperatingMode
            from thorlabs_xa.products.pdxc3 import Pdxc3
        except ImportError as exc:
            raise RuntimeError("缺少 Thorlabs XA SDK，请安装后台 requirements.txt 中的 thorlabs-xa") from exc
        self.manager = SystemManager.instance()
        # 0 disables background USB discovery. Every open below supplies an
        # explicit Ethernet transport, so the vacuum gauge is never probed.
        self.manager.startup("deviceDiscovery.connections=\ndeviceDiscovery.interval=" +
                             ("250" if self.connection == "usb" else "0"))
        if self.connection == "usb":
            transport = self.find_usb_transport()
        elif self.host:
            transport = f"{ipaddress.IPv4Address(self.host)}:{self.port}"
        else:
            found = [d for d in self.discover(self.manager, self.port)
                     if d.part_number == "PDXC3" and d.device == self.serial_number]
            if len(found) != 1:
                raise RuntimeError("未在本机网段找到指定序列号的 PDXC3；请填写控制器 IPv4 地址并检查其网络设置")
            transport = found[0].transport
        mode = (TLMC_OperatingMode.TLMC_OperatingMode_ManualStatusPolling |
                TLMC_OperatingMode.TLMC_OperatingMode_SendEndOfMoveMessages |
                TLMC_OperatingMode.TLMC_OperatingMode_DoNotLoadParamsOnConnect |
                TLMC_OperatingMode.TLMC_OperatingMode_DoNotAutoCalibrate)
        self.device = self.manager.open_device_as(self.serial_number, transport, mode, Pdxc3)
        self.transport = transport
        self.channels = {n: self.device.get_subchannel(n) for n in (1, 2, 3)}
        self.stage_names = {n: c.get_stage_axis_params(self.TIMEOUT_MS).part_number for n, c in self.channels.items()}
        # Connecting reads state only: no enable, home, position-zero or movement.

    def _acquire_lease(self):
        if os.name != "nt":
            return
        # XA and this console must never be active control owners simultaneously.
        running = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "Get-Process -Name tlmc_xa_dotnet_ui -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"],
            capture_output=True, text=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
        if running.stdout.strip():
            raise RuntimeError("检测到 XA 进程仍在运行，请完全退出 XA 后再连接；仅关闭通道窗口可能仍占用设备")
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel.CreateMutexW(None, False, f"Global\\VacuumInterlock.PDXC3.{self.serial_number}")
        error = ctypes.get_last_error()
        if not handle:
            raise RuntimeError("无法取得位移台独占连接锁")
        if error == 183:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(handle)
            raise RuntimeError("另一控制台进程已占用此 PDXC3，请先断开另一连接")
        self._lease = handle

    @staticmethod
    def supported(name):
        name = str(name).upper()
        return name == "PDXC2AD" or name in ("PD1", "PD1/M", "PD1V", "PD1V/M")

    def find_usb_transport(self):
        # Windows XA enumerates its native USB devices without probing COM ports.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            found = [d for d in self.manager.get_device_list()
                     if d.part_number == "PDXC3" and d.device == self.serial_number
                     and d.transport and not re.fullmatch(r"\d+(?:\.\d+){3}:\d+", d.transport)
                     and not d.transport.upper().startswith(("COM", "\\\\.\\COM", "TCP", "ETHERNET"))]
            if len(found) == 1:
                return found[0].transport
            if len(found) > 1:
                raise RuntimeError("发现多个匹配的 USB 设备，请检查序列号")
            time.sleep(0.1)
        raise RuntimeError("未找到指定序列号的 PDXC3 USB 设备；请检查 USB 连接和 Thorlabs 驱动")

    @staticmethod
    def discover(manager, port):
        from thorlabs_xa.shared.c_params import C_TLMC_DeviceInfo
        from thorlabs_xa.shared.map_native_to_python import MapNativeToPython
        fn = manager.native_functions.xa_lib.TLMC_DiscoverEthernetDeviceInfo
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int32, ctypes.c_uint32,
                       ctypes.POINTER(C_TLMC_DeviceInfo), ctypes.c_uint16,
                       ctypes.POINTER(ctypes.c_uint16)]
        fn.restype = ctypes.c_int32
        devices = []
        for network in local_networks():
            if network.num_addresses < 4:
                continue
            buffer = (C_TLMC_DeviceInfo * 32)()
            count = ctypes.c_uint16()
            result = fn(str(network.network_address + 1).encode(),
                        str(network.broadcast_address - 1).encode(), port, 50000,
                        buffer, 32, ctypes.byref(count))
            manager.native_functions.wrap_error_code(result)
            devices.extend(MapNativeToPython.device_info(buffer[i]) for i in range(min(count.value, 32)))
        return devices

    def status(self):
        started = time.monotonic()
        result = []
        for n, channel in self.channels.items():
            channel.request_status(self.TIMEOUT_MS)
            items = channel.get_status_items(0, channel.get_status_item_count())
            states = {item.id.name.removeprefix("TLMC_StatusItemId_"): item.value for item in items}
            moving_keys = ("MovingClockwise", "MovingCounterclockwise", "JoggingClockwise", "JoggingCounterclockwise")
            available = [states[key] for key in moving_keys if key in states]
            optimizing = states.get("PulseAcquiring", False)
            moving = (any(available) or optimizing) if available else None
            faults = []
            for key, label in (("WrongStageDetected", "位移台类型不匹配"),
                               ("Overcurrent", "过流"), ("Overtemperature", "过温"),
                               ("AbnormalStageMovement", "运动异常"),
                               ("Error", "控制器故障")):
                if states.get(key):
                    faults.append(label)
            name = self.stage_names.get(n, "")
            if name and not self.supported(name):
                faults.append(f"当前控制台仅支持 PD1/PD1V 开环台，识别为 {name}")
            # PDXC3 firmware 0.51 returns PowerOk=False even while XA successfully
            # drives PDXC2AD. It is diagnostic data, not an independent fault.
            result.append({"channel": n, "moving": moving,
                           "enabled": bool(states.get("Enabled", False)), "stage": name,
                           "ready": not faults and self.supported(name),
                           "optimizing": bool(optimizing), "optimized": bool(states.get("PulseAcquired", False)),
                           "open_loop": not bool(states.get("ClosedLoopPositionControl", False)),
                           "command_count": states.get("Position"), "power_ok_raw": states.get("PowerOk"),
                           "error": "；".join(faults) or None})
        if len(result) != 3:
            raise RuntimeError("控制器未返回三个通道")
        self.last_latency_ms = round((time.monotonic() - started) * 1000, 1)
        return result

    def move(self, channel, direction, steps):
        from thorlabs_xa.shared.enums import TLMC_EnableState, TLMC_MoveMode, TLMC_PZ_PositionControlMode, TLMC_JogMode
        target = self.channels[channel]
        # A vacuum PD1 uses the same open-loop drive family as PD1. Never set a
        # guessed stage profile or a voltage/frequency silently.
        name = str(target.get_stage_axis_params(self.TIMEOUT_MS).part_number).upper()
        if not self.supported(name):
            raise RuntimeError(f"CH{channel} 识别为 {name or '未知'}，不支持当前开环台控制")
        target.set_position_control_mode(TLMC_PZ_PositionControlMode.TLMC_PZ_PositionControlMode_OpenLoop,
                                         self.TIMEOUT_MS)
        # PDXC3 0.51 rejects Relative (FunctionNotSupported). Its finite jog uses
        # programmed step size; the Move param is UNUSED, not the pulse count.
        if not 1 <= steps <= 20000:
            raise RuntimeError("PDXC3 单次点动步数必须为 1–20000")
        single = int(TLMC_JogMode.TLMC_JogMode_SingleStep)
        self._set_setting(channel, "jog.mode", single)
        self._set_setting(channel, "jog.openLoopStepSize", steps)
        for key, expected in (("jog.mode", single), ("jog.openLoopStepSize", steps)):
            actual = target.get_setting(key, self.TIMEOUT_MS)
            if not actual.is_value_set or actual.value != expected:
                raise RuntimeError("单步模式或点动步数读回不一致；本次移动未下发")
        rate = target.get_setting("jog.openLoopMaxVelocity", self.TIMEOUT_MS)
        acceleration = target.get_setting("jog.openLoopAcceleration", self.TIMEOUT_MS)
        if not rate.is_value_set or not acceleration.is_value_set or rate.value <= 0 or acceleration.value <= 0:
            raise RuntimeError("步频或加速度读回无效；本次移动未下发")
        self.move_budget_s = max(3, 4 * math.sqrt(steps / acceleration.value) + steps / rate.value + 2)
        target.set_enable_state(TLMC_EnableState.TLMC_Enabled)
        target.move(TLMC_MoveMode.TLMC_MoveMode_JogForward if direction > 0 else TLMC_MoveMode.TLMC_MoveMode_JogReverse, 0, 0)

    def _set_setting(self, channel, key, value):
        from thorlabs_xa.shared.c_params import C_TLMC_Value
        data = C_TLMC_Value()
        data.int64Value = value
        fn = self.manager.native_functions.xa_lib.TLMC_SetSetting
        fn.argtypes = [ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(C_TLMC_Value)]
        fn.restype = ctypes.c_uint16
        self.manager.native_functions.wrap_error_code(fn(self.channels[channel].subchannel_handle, key.encode(), ctypes.byref(data)))

    def enable(self, channel, enabled):
        from thorlabs_xa.shared.enums import TLMC_EnableState
        self.channels[channel].set_enable_state(TLMC_EnableState.TLMC_Enabled if enabled else TLMC_EnableState.TLMC_Disabled)

    def zero(self, channel):
        from thorlabs_xa.shared.enums import TLMC_PZ_PositionControlMode
        target = self.channels[channel]
        if target.get_position_control_mode(self.TIMEOUT_MS) != TLMC_PZ_PositionControlMode.TLMC_PZ_PositionControlMode_OpenLoop:
            raise RuntimeError("只有开环模式允许计数清零；不会执行寻找机械原点")
        target.home(0)

    def optimize(self, channel):
        # The Python wrapper omits this documented PDXC3-channel native function.
        fn = self.manager.native_functions.xa_lib.TLMC_PZIM_PulseParaAcquire
        fn.argtypes = [ctypes.c_uint32, ctypes.c_int64]
        fn.restype = ctypes.c_uint16
        self.manager.native_functions.wrap_error_code(fn(self.channels[channel].subchannel_handle, 0))

    def parameters(self, channel):
        values, limits = {}, {}
        for name, key in self.PARAMETERS.items():
            setting = self.channels[channel].get_setting(key, self.TIMEOUT_MS)
            if not setting.is_value_set:
                raise RuntimeError(f"参数 {key} 未返回有效值")
            values[name] = setting.value
            limits[name] = {"min": setting.min_value if setting.has_min else None,
                            "max": setting.max_value if setting.has_max else None}
        return {"values": values, "limits": limits}

    def set_parameters(self, channel, values):
        current = self.parameters(channel)
        for name, value in values.items():
            bounds = current["limits"][name]
            if bounds["min"] is not None and value < bounds["min"] or bounds["max"] is not None and value > bounds["max"]:
                raise RuntimeError(f"{name} 超出控制器报告范围 {bounds['min']}–{bounds['max']}")
        # Use named scalar settings with integer device values. Bulk JSON settings
        # need a connected-product conversion profile that PDXC2AD does not supply.
        for name, value in values.items():
            self._set_setting(channel, self.PARAMETERS[name], value)
        actual = self.parameters(channel)
        if any(actual["values"][k] != v for k, v in values.items()):
            raise RuntimeError("驱动参数写入后的读回不一致，请重新读取并核对")
        return actual

    def stop(self):
        from thorlabs_xa.shared.enums import TLMC_StopMode
        errors = []
        for n, channel in self.channels.items():
            try:
                channel.stop(TLMC_StopMode.TLMC_StopMode_Immediate, 0)
            except Exception as exc:
                errors.append(f"CH{n}: {exc}")
        if errors:
            raise RuntimeError("；".join(errors))

    def close(self):
        errors = []
        if self.device:
            try:
                try:
                    self.device.disconnect()
                except Exception as exc:
                    errors.append(str(exc))
                try:
                    self.device.close()
                except Exception as exc:
                    errors.append(str(exc))
            finally:
                self.device = None
                self.channels = {}
        try:
            if self.manager:
                try:
                    self.manager.shutdown()
                except Exception as exc:
                    errors.append(str(exc))
                finally:
                    self.manager = None
        finally:
            if self._lease is not None:
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                kernel.CloseHandle(self._lease)
                self._lease = None
        if errors:
            raise RuntimeError("已释放本机连接；设备断开应答未确认：" + "；".join(errors))
