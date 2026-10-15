"""PDXC3 Ethernet adapter using Thorlabs XA 1.8 and its documented C ABI.

The Python SDK omits DiscoverEthernetDeviceInfo; bind that single function using
the published tlmc_xa_native_api.h. TCP 40303 and explicit transports are described
in TLMC_Open / TLMC_DiscoverEthernetDeviceInfo. No serial discovery is requested.
"""
from __future__ import annotations

import ctypes
import ipaddress
import json
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
    TIMEOUT_MS = 1000

    def __init__(self, serial_number, host="", port=40303, connection="tcp"):
        self.serial_number = serial_number
        self.host = host
        self.port = port
        self.connection = connection
        self.manager = None
        self.device = None
        self.channels = {}
        self.stage_names = {}

    def connect(self):
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
                TLMC_OperatingMode.TLMC_OperatingMode_DoNotAutoSetConnectedProduct)
        self.device = self.manager.open_device_as(self.serial_number, transport, mode, Pdxc3)
        self.channels = {n: self.device.get_subchannel(n) for n in (1, 2, 3)}
        self.stage_names = {n: c.get_stage_axis_params(self.TIMEOUT_MS).part_number for n, c in self.channels.items()}
        # Connecting reads state only: no enable, home, position-zero or movement.

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
        result = []
        for n, channel in self.channels.items():
            channel.request_status(self.TIMEOUT_MS)
            items = channel.get_status_items(0, channel.get_status_item_count())
            states = {item.id.name.removeprefix("TLMC_StatusItemId_"): item.value for item in items}
            moving_keys = ("MovingClockwise", "MovingCounterclockwise", "JoggingClockwise", "JoggingCounterclockwise")
            available = [states[key] for key in moving_keys if key in states]
            moving = any(available) if available else None
            faults = []
            for key, label in (("WrongStageDetected", "位移台类型不匹配"),
                               ("Overcurrent", "过流"), ("Overtemperature", "过温"),
                               ("AbnormalStageMovement", "运动异常"),
                               ("Error", "控制器故障")):
                if states.get(key):
                    faults.append(label)
            if states.get("PowerOk") is False:
                faults.append("输出电源未就绪")
            result.append({"channel": n, "moving": moving,
                           "enabled": bool(states.get("Enabled", False)), "stage": self.stage_names.get(n, ""),
                           "ready": not faults and bool(self.stage_names.get(n)),
                           "error": "；".join(faults) or None})
        if len(result) != 3:
            raise RuntimeError("控制器未返回三个通道")
        return result

    def move(self, channel, direction, steps):
        from thorlabs_xa.shared.enums import TLMC_EnableState, TLMC_MoveMode, TLMC_PZ_PositionControlMode
        target = self.channels[channel]
        # A vacuum PD1 uses the same open-loop drive family as PD1. Never set a
        # guessed stage profile or a voltage/frequency silently.
        name = str(target.get_stage_axis_params(self.TIMEOUT_MS).part_number).upper()
        if not name.startswith("PD1") or name.startswith("PD1D"):
            raise RuntimeError(f"CH{channel} 当前配置为 {name or '未知'}；请在 Thorlabs 软件中配置 PD1V/M")
        target.set_position_control_mode(TLMC_PZ_PositionControlMode.TLMC_PZ_PositionControlMode_OpenLoop,
                                         self.TIMEOUT_MS)
        target.set_enable_state(TLMC_EnableState.TLMC_Enabled)
        # Relative in open loop is a signed pulse count. NoWait avoids holding
        # the command lock for the duration of a move; stop remains responsive.
        target.move(TLMC_MoveMode.TLMC_MoveMode_Relative, direction * steps, 0)

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
        try:
            if self.device:
                self.device.disconnect()
                self.device.close()
                self.device = None
                self.channels = {}
        finally:
            if self.manager:
                self.manager.shutdown()
                self.manager = None
