from __future__ import annotations

import asyncio
import math
import logging
from functools import wraps
import random
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Optional

from .configuration import ConfigurationStore
from .drivers.adam6050 import Adam6050Client, ModbusError
from .drivers.dam0808d import Dam0808DClient
from .drivers.tpg366 import GaugeReading, TPG366Client, TPG366Error
from .drivers.tpg366_usb import TPG366USBClient
from .models import AppConfig, ChannelConfig, SampleChannel, SystemStatus
from .storage import HistoryStore


STATUS_LABELS = {
    0: "正常",
    1: "低于量程",
    2: "高于量程",
    3: "传感器故障",
    4: "测量通道已关闭",
    5: "未连接真空规",
    6: "真空规识别错误",
}
SIM_TRIP_PA = (1.0e-2, 1.0e-2, 1.0e-2)
SIM_RESET_PA = (5.0e-3, 5.0e-3, 5.0e-3)


class InterlockError(RuntimeError):
    pass


class TaskLock:
    """Reentrant only for the owning asyncio task, including nested safety trips."""
    def __init__(self):
        self.lock = asyncio.Lock()
        self.owner = None
        self.depth = 0

    async def __aenter__(self):
        task = asyncio.current_task()
        if self.owner is not task:
            await self.lock.acquire()
            self.owner = task
        self.depth += 1
        return self

    async def __aexit__(self, *args):
        self.depth -= 1
        if not self.depth:
            self.owner = None
            self.lock.release()


def serialized(fn):
    @wraps(fn)
    async def call(self, *args, **kwargs):
        async with self._lock:
            return await fn(self, *args, **kwargs)
    return call


class InterlockEngine:
    """Serializes state transitions and keeps protective logic off the browser."""

    def __init__(self, config_store: ConfigurationStore, history: HistoryStore) -> None:
        self.config_store = config_store
        self.history = history
        self.config = config_store.get_config()
        # Migrate the old implicit demo limits into editable, explicit configuration.
        if self.config.mode == "simulation" and all(ch.trip_pa is None for ch in self.config.channels):
            self.config.channels = [
                ChannelConfig(enabled=i < 3, trip_pa=0.01, reset_pa=0.005)
                for i in range(6)
            ]
            config_store.update(self.config)
        self.mode = self.config.mode
        self.interlock = "disarmed"
        self.trip_reason: Optional[str] = None
        self._rearm_required = False
        self._lock = TaskLock()
        self._task: Optional[asyncio.Task] = None
        self._subscribers: set[asyncio.Queue] = set()
        self.tpg: Optional[TPG366Client] = None
        self.adam: Optional[Adam6050Client | Dam0808DClient] = None
        self._last_tpg_read: Optional[float] = None
        self._last_history_write = 0.0
        self._history_recording = True
        self._history_error: Optional[str] = None
        self._sim_close_failure = False
        self._sim_tpg_fault = False
        self._motion_reported = False
        self._motion_timed_out = False
        self._stopping = False
        self._last_retention_check = 0.0
        self._recovery_since: Optional[float] = None
        self._valve_command: Optional[str] = None
        self._valve_command_at = 0.0
        self._open_output = False
        self._off_retry_pending = False
        self._next_off_retry = 0.0
        # None tracks a held manual output without an automatic shutoff timer.
        self._debug_deadlines: dict[int, Optional[float]] = {}
        self._debug_sim_outputs = [False] * 8
        self._last_io_read = 0.0
        self._next_io_poll = 0.0
        self._next_unit_check = 0.0
        self._io_inputs = [False] * 12
        self._channels: list[dict] = []
        self._tpg_connected = self.mode == "simulation"
        self._adam_connected = self.mode == "simulation"
        self._tpg_error: Optional[str] = None
        self._io_error: Optional[str] = None
        self._sim_pressure = [2.0e-3, 3.1e-3, 1.8e-3, 2.2e-3, 4.0e-3, 2.5e-3]
        self._sim_state = "closed"
        self._sim_open_after = 0.0
        self._sim_close_after = 0.0
        self._sim_sensor_conflict = False
        self._sim_io_fault = False
        self._sim_gauge_status = [0] * 6
        self.status = SystemStatus(mode=self.mode)
        self._refresh_status()

    async def start(self) -> None:
        self._stopping = False
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="vacuum-interlock-loop")

    async def stop(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception:
                logging.exception("Protection loop failed before shutdown")
            self._task = None
        async with self._lock:
            try:
                await self._clear_debug_outputs()
                await self._safe_open_output()
                self.interlock = "disarmed"
            finally:
                await self._close_devices()

    async def _close_devices(self) -> None:
        if self.tpg:
            await self.tpg.close()
        if self.adam:
            await self.adam.close()

    def _stamp(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _refresh_status(self) -> SystemStatus:
        now = time.monotonic()
        age = None if self._last_tpg_read is None else max(0.0, now - self._last_tpg_read)
        open_di = self.config.valve_open_di
        closed_di = self.config.valve_closed_di
        open_sensor = self._input_active(open_di, self.config.valve_open_active_high) if open_di is not None and self._adam_connected else False
        closed_sensor = self._input_active(closed_di, self.config.valve_closed_active_high) if self._adam_connected else False
        if self.mode == "simulation":
            self._tpg_connected = not self._sim_tpg_fault
            self._adam_connected = not self._sim_io_fault
            closed_sensor = self._sim_state == "closed" and self._adam_connected
            open_sensor = self._sim_state == "open" and self._adam_connected
            if self._sim_sensor_conflict:
                closed_sensor = open_sensor = self._adam_connected
        if not self._adam_connected:
            valve = "unknown"
        elif open_sensor and closed_sensor:
            valve = "fault"
        elif closed_sensor:
            valve = "closed"
        elif self._valve_command == "close" and now - self._valve_command_at < self.config.valve_timeout_s:
            valve = "closing"
        elif open_sensor:
            valve = "open"
        elif self._valve_command == "open" and now - self._valve_command_at < self.config.valve_timeout_s:
            valve = "opening"
        elif self._valve_command == "close" and now - self._valve_command_at < self.config.valve_timeout_s:
            valve = "closing"
        else:
            valve = "unknown"

        labels = {
            "disarmed": "未启用",
            "ready": "待命",
            "armed": "联锁已启用",
            "tripped": "联锁已触发",
            "fault": "故障停机",
        }
        channel_models = []
        for sample in self._channels:
            index = sample["channel"] - 1
            channel_config = self.config.channels[index]
            channel_models.append(
                SampleChannel(
                    **sample,
                    label=channel_config.label or f"通道 {index + 1}",
                    trip_pa=channel_config.trip_pa if channel_config.enabled else None,
                    reset_pa=channel_config.reset_pa if channel_config.enabled else None,
                )
            )
        self.status = SystemStatus(
            timestamp=self._stamp(),
            mode=self.mode,
            interlock=self.interlock,
            interlock_label=labels.get(self.interlock, self.interlock),
            trip_reason=self.trip_reason,
            valve=valve,
            valve_open_sensor=open_sensor,
            valve_closed_sensor=closed_sensor,
            tpg_connected=self._tpg_connected,
            adam_connected=self._adam_connected,
            sample_age_s=age,
            unit="Pa",
            pressure_ok=self._pressure_permitted(),
            fail_closed_confirmed=self.config.fail_closed_confirmed,
            history_recording=self._history_recording,
            history_error=self._history_error,
            channels=channel_models,
        )
        return self.status

    def snapshot(self) -> dict:
        self._refresh_status()
        return self.status.model_dump(mode="json")

    async def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self._subscribers.add(queue)
        queue.put_nowait(self.snapshot())
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def _publish(self) -> None:
        payload = self.snapshot()
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def _event(self, kind: str, severity: str, message: str, actor: str = "system", details: Optional[dict] = None) -> dict:
        try:
            return self.history.write_event(kind, severity, message, actor, details)
        except (OSError, RuntimeError, sqlite3.Error) as exc:
            self._history_recording = False
            self._history_error = str(exc)
            logging.error("Audit storage unavailable: %s", exc)
            return {"timestamp": self._stamp(), "type": kind, "message": message, "persisted": False}

    def _check_fresh(self) -> None:
        if self._stopping:
            raise InterlockError("后台正在停止，禁止开阀")
        if self._history_error:
            raise InterlockError("历史或审计存储故障，禁止开阀")
        if not self._tpg_connected or not self._adam_connected:
            raise InterlockError("设备通信未就绪")
        now = time.monotonic()
        if self._last_tpg_read is None or now - self._last_tpg_read > self.config.stale_timeout_s:
            raise InterlockError("真空数据已超时，禁止开阀")
        if self.mode == "real":
            if now - self._last_io_read > self.config.stale_timeout_s:
                raise InterlockError("I/O 数据已超时，禁止开阀")
            if not self.config.fail_closed_confirmed or self._tpg_error or self._io_error:
                raise InterlockError("硬件配置或反馈未通过校验")

    def _validate_arm(self) -> None:
        if self._debug_deadlines:
            raise InterlockError("请先关闭 Debug 手动输出，再启用联锁")
        if self._rearm_required:
            fault = self._reset_conditions()
            if fault:
                raise InterlockError(fault)
            if self.status.valve != "closed":
                raise InterlockError("启用前必须确认阀门已关闭")
            if self._recovery_since is None or time.monotonic()-self._recovery_since < self.config.recovery_hold_s:
                raise InterlockError("等待真空恢复状态稳定后才能启用联锁")
        if self.interlock == "tripped":
            raise InterlockError("联锁已触发，须在压力恢复并保持后人工复位")
        if self.mode == "real":
            if not self.config.fail_closed_confirmed:
                raise InterlockError("尚未确认电磁阀断电后插板阀关闭，真实联锁不能启用")
            tpg_address = self.config.tpg_serial_port if self.config.tpg_connection == "usb" else self.config.tpg_host
            if not tpg_address or not (self.config.dam_serial_port if self.config.io_device == "dam0808d" else self.config.adam_host):
                raise InterlockError("请先设置真空规与 I/O 控制器连接地址")
            selected = [ch for ch in self.config.channels if ch.enabled]
            if not selected:
                raise InterlockError("至少选择一个真空保护通道")
            if not self._tpg_connected or not self._adam_connected:
                raise InterlockError("真空规与 I/O 控制器都必须在线")
            if self._tpg_error or self._io_error:
                raise InterlockError("设备报告故障，联锁不能启用")
            if self.status.valve != "closed":
                raise InterlockError("先关闭阀门并确认关闭位置传感器动作")
        if self._last_tpg_read is None or time.monotonic() - self._last_tpg_read > self.config.stale_timeout_s:
            raise InterlockError("真空数据尚未更新或已超时")
        bad = self._pressure_fault()
        if bad:
            raise InterlockError(bad)

    def _pressure_permitted(self) -> bool:
        return (self._tpg_connected and self._last_tpg_read is not None
                and time.monotonic() - self._last_tpg_read <= self.config.stale_timeout_s
                and self._pressure_fault() is None)

    def _pressure_fault(self) -> Optional[str]:
        selected = [(index, cfg.trip_pa) for index, cfg in enumerate(self.config.channels) if cfg.enabled]
        if not selected:
            return "尚未配置受保护的真空通道"
        by_channel = {s["channel"]: s for s in self._channels}
        for index, trip_pa in selected:
            sample = by_channel.get(index + 1)
            if sample is None or not sample.get("valid"):
                status = "无数据" if sample is None else sample.get("status", "测量错误")
                return f"通道 {index + 1} 测量异常：{status}"
            pressure = sample["pressure_pa"]
            if pressure is None or not math.isfinite(pressure):
                return f"通道 {index + 1} 压力读数无效"
            if pressure >= trip_pa:
                return f"通道 {index + 1} 压力达到关阀阈值"
        return None

    def _reset_conditions(self) -> Optional[str]:
        if self._last_tpg_read is None or time.monotonic() - self._last_tpg_read > self.config.stale_timeout_s:
            return "真空读数已超时，不能复位联锁"
        if self.mode == "real" and (not self._tpg_connected or not self._adam_connected):
            return "真空规与 I/O 控制器必须在线才能复位"
        if self.mode == "real":
            if not self.config.fail_closed_confirmed:
                return "尚未确认电磁阀断电后插板阀关闭"
            if time.monotonic() - self._last_io_read > self.config.stale_timeout_s:
                return "I/O 数据已超时，不能复位联锁"
            if self._tpg_error or self._io_error:
                return "设备故障仍未恢复"
        fault = self._pressure_fault()
        if fault:
            return fault
        by_channel = {s["channel"]: s for s in self._channels}
        selected = [(index, cfg.reset_pa) for index, cfg in enumerate(self.config.channels) if cfg.enabled]
        for index, reset_pa in selected:
            sample = by_channel.get(index + 1)
            if sample is None or sample.get("pressure_pa") is None:
                return f"通道 {index + 1} 没有有效读数"
            if sample["pressure_pa"] >= reset_pa:
                return f"通道 {index + 1} 压力尚未降到恢复阈值以下"
        if self._history_error:
            return "历史或审计存储仍不可用"
        if self._sim_sensor_conflict and self.mode == "simulation":
            return "阀位反馈冲突仍未恢复"
        return None

    async def _write_output(self, channel: int, value: bool) -> None:
        if self.mode == "simulation":
            if channel == self.config.open_output:
                self._open_output = value
                now = time.monotonic()
                if value:
                    self._sim_close_after = 0.0
                    self._sim_open_after = now + 0.45
                else:
                    self._sim_open_after = 0.0
                    self._sim_close_after = now + 0.45
            return
        if not self.adam:
            raise ModbusError("I/O 控制器驱动未初始化")
        await self.adam.write_output(channel, value)

    async def _safe_open_output(self) -> None:
        if self.mode == "simulation":
            self._open_output = False
            self._off_retry_pending = False
            self._sim_open_after = 0.0
            self._sim_close_after = time.monotonic() + 0.45
            return
        if self.adam:
            try:
                await self.adam.write_output(self.config.open_output, False)
                self._open_output = False
                self._off_retry_pending = False
            except (ModbusError, OSError) as exc:
                self._off_retry_pending = True
                self._next_off_retry = time.monotonic() + 1.0
                self._adam_connected = False
                self._io_error = str(exc)
                self._event("io_error", "critical", "撤销开阀输出失败，阀门关闭状态无法保证", details={"error": str(exc)})

    @serialized
    async def trip(self, reason: str, kind: str = "pressure_trip", fault: bool = False) -> None:
        async with self._lock:
            try:
                await self._clear_debug_outputs()
            except (ModbusError, OSError):
                logging.exception("Unable to clear Debug outputs during trip; retaining cleanup deadlines")
            already = self.interlock in ("tripped", "fault")
            same_fault = already and self.trip_reason == reason
            self.interlock = "fault" if fault else "tripped"
            self.trip_reason = reason
            self._recovery_since = None
            if not already or self._valve_command != "close":
                self._motion_reported = False
                self._motion_timed_out = False
                self._valve_command = "close"
                self._valve_command_at = time.monotonic()
            if not same_fault or (self._off_retry_pending and time.monotonic() >= self._next_off_retry):
                await self._safe_open_output()
            if not already:
                snapshot = [
                    {"channel": s["channel"], "pressure_pa": s.get("pressure_pa"), "status": s.get("status")}
                    for s in self._channels
                ]
                self._event(kind, "critical", reason, details={"channels": snapshot})
            self._refresh_status()
            self._publish()

    @serialized
    async def disarm(self, actor: str = "operator") -> None:
        await self._clear_debug_outputs()
        if self.interlock == "armed" or self.interlock == "ready":
            self.interlock = "disarmed"
            self.trip_reason = None
            self._recovery_since = None
            self._valve_command = "close"
            self._valve_command_at = time.monotonic()
            self._motion_reported = False
            self._motion_timed_out = False
            self._event("interlock_disarm", "warning", "操作员关闭联锁；阀门保持关闭", actor)
        await self._safe_open_output()
        self._refresh_status()
        self._publish()

    @serialized
    async def arm(self, actor: str = "operator") -> None:
        self._refresh_status()
        self._validate_arm()
        self._check_fresh()
        if self.interlock not in ("disarmed", "ready"):
            raise InterlockError("联锁当前状态不允许启用")
        try:
            await self._write_output(self.config.open_output, False)
            if self.mode == "real":
                await self._poll_io()
                await self._poll_tpg()
                self._check_fresh()
                if self._pressure_fault():
                    raise InterlockError(self._pressure_fault())
                self._refresh_status()
                if self.status.valve != "closed":
                    raise InterlockError("关闭位置反馈已变化，不能启用联锁")
        except (ModbusError, OSError, InterlockError) as exc:
            await self._safe_open_output()
            self.interlock = "fault"
            self.trip_reason = str(exc)
            self._event("arm_failed", "critical", f"联锁启用失败：{exc}", actor)
            raise InterlockError(str(exc)) from exc
        self.interlock = "armed"
        self._rearm_required = False
        self.trip_reason = None
        self._event("interlock_armed", "info", "分子泵真空保护联锁已启用", actor)
        self._refresh_status()
        self._publish()

    @serialized
    async def clear_fault(self, actor: str = "operator") -> None:
        if self.interlock not in ("tripped", "fault"):
            raise InterlockError("当前没有待清除的故障")
        try:
            if self.mode == "real":
                await self._ensure_io_driver()
                # Cached connection flags must not prevent a manual recovery.
                if not self._adam_connected or self._io_error:
                    await self.adam.close()
                await self.adam.connect()
            await self._clear_debug_outputs()
            if self.mode == "real":
                await self.adam.write_output(self.config.open_output, False)
                await self._poll_io()
            else:
                await self._write_output(self.config.open_output, False)
        except (ModbusError, OSError) as exc:
            self._adam_connected = False
            self._io_error = str(exc)
            if self.adam:
                await self.adam.close()
            self._refresh_status()
            self._publish()
            raise InterlockError(f"无法撤销开阀输出：{exc}") from exc
        self._open_output = False
        self._off_retry_pending = False
        self.interlock = "disarmed"
        self.trip_reason = None
        self._rearm_required = True
        # Acknowledge the old movement fault; do not restart its timeout timer.
        self._valve_command = None
        self._motion_reported = True
        self._motion_timed_out = False
        self._event("fault_cleared", "warning", "故障已清除，联锁未启用；阀位仍以传感器反馈为准", actor)
        self._refresh_status()
        self._publish()

    @serialized
    async def reset(self, actor: str = "operator") -> None:
        if self.interlock not in ("tripped", "fault"):
            raise InterlockError("当前没有待复位的联锁故障")
        recovery_fault = self._reset_conditions()
        if recovery_fault:
            raise InterlockError(recovery_fault)
        self._refresh_status()
        if self.status.valve != "closed":
            raise InterlockError("复位前必须确认阀门已关闭")
        if self._recovery_since is None:
            raise InterlockError("等待真空恢复状态稳定")
        remaining = self.config.recovery_hold_s - (time.monotonic() - self._recovery_since)
        if remaining > 0:
            raise InterlockError(f"真空恢复稳定时间不足，还需 {remaining:.1f} 秒")
        if self.mode == "real":
            if not self.adam or not self.config.fail_closed_confirmed:
                raise InterlockError("真实硬件没有就绪")
            await self._write_output(self.config.open_output, False)
            await self._poll_io()
            await self._poll_tpg()
            self._check_fresh()
            if self._reset_conditions():
                raise InterlockError(self._reset_conditions())
            self._refresh_status()
            if self.status.valve != "closed":
                raise InterlockError("关闭位置反馈已变化，不能复位联锁")
        self.interlock = "armed"
        self.trip_reason = None
        self._valve_command = "close"
        self._valve_command_at = time.monotonic()
        self._motion_reported = False
        self._motion_timed_out = False
        self._event("interlock_reset", "warning", "操作员复位联锁；阀门仍保持关闭", actor)
        self._rearm_required = False
        self._refresh_status()
        self._publish()

    @serialized
    async def open_valve(self, actor: str = "operator") -> None:
        self._refresh_status()
        if self.interlock != "armed":
            raise InterlockError("必须先启用真空联锁")
        self._check_fresh()
        fault = self._pressure_fault()
        if fault:
            await self.trip(fault)
            raise InterlockError(fault)
        if self.status.valve != "closed":
            raise InterlockError("只有确认阀门关闭后才能发送开阀命令")
        try:
            await self._write_output(self.config.open_output, True)
        except (ModbusError, OSError) as exc:
            await self.trip(str(exc), kind="open_output_failed", fault=True)
            raise InterlockError(str(exc)) from exc
        self._open_output = True
        self._valve_command = "open"
        self._valve_command_at = time.monotonic()
        self._motion_reported = False
        self._motion_timed_out = False
        self._event("valve_open_command", "warning", "操作员请求开阀", actor)
        if self._history_error:
            await self.trip("开阀审计写入失败", kind="storage_fault", fault=True)
            raise InterlockError("审计存储故障，已撤销开阀输出")
        self._refresh_status()
        self._publish()

    @serialized
    async def close_valve(self, actor: str = "operator", reason: str = "操作员请求关阀") -> None:
        await self._clear_debug_outputs()
        await self._safe_open_output()
        self._valve_command = "close"
        self._valve_command_at = time.monotonic()
        self._motion_reported = False
        self._motion_timed_out = False
        self._event("valve_close_command", "info", reason, actor)
        self._refresh_status()
        self._publish()

    @serialized
    async def apply_config(self, config: AppConfig, actor: str = "operator") -> None:
        async with self._lock:
            await self._clear_debug_outputs()
            if self.interlock == "armed":
                self.interlock = "tripped"
                self.trip_reason = "设备配置已修改，联锁保持锁存关闭"
                await self._safe_open_output()
                self._event("config_change_trip", "critical", self.trip_reason, actor)
            else:
                await self._safe_open_output()
            old = self.config
            self.config_store.update(config)
            self.config = config
            self.mode = config.mode
            if any(getattr(old, key) != getattr(config, key) for key in (
                    "mode", "tpg_host", "tpg_port", "tpg_connection", "tpg_serial_port", "tpg_baudrate")):
                if self.tpg:
                    await self.tpg.close()
                self.tpg = None
                self._tpg_connected = False
                self._last_tpg_read = None
            if old.mode != config.mode or old.adam_host != config.adam_host or old.adam_port != config.adam_port or old.adam_unit_id != config.adam_unit_id or any(getattr(old, key) != getattr(config, key) for key in ("io_device", "dam_serial_port", "dam_baudrate", "dam_unit_id")):
                if self.adam:
                    await self.adam.close()
                self.adam = None
                self._adam_connected = False
            if config.mode == "simulation":
                self._tpg_connected = True
                self._adam_connected = not self._sim_io_fault
            else:
                self._tpg_connected = False
                self._adam_connected = False
            self._event(
                "config_changed", "warning", "设备或联锁配置已保存",
                actor,
                {"previous_mode": old.mode, "mode": config.mode, "version": self.config_store.version,
                 "changes": {key: {"before": old.model_dump()[key], "after": config.model_dump()[key]}
                             for key in old.model_dump() if old.model_dump()[key] != config.model_dump()[key]}},
            )
        if config.mode == "real":
            await self.connect_devices()
        self._refresh_status()
        self._publish()

    @serialized
    async def connect_gauge(self) -> dict:
        if self.mode != "real":
            return {"ok": True, "mode": self.mode}
        if self.interlock == "armed":
            await self.trip("重新连接真空规，联锁保持锁存关闭", kind="gauge_reconnect")
        usb = self.config.tpg_connection == "usb"
        host = self.config.tpg_serial_port if usb else self.config.tpg_host
        port = self.config.tpg_baudrate if usb else self.config.tpg_port
        if not host:
            return {"ok": False, "error": "未配置 USB 串口或 IP"}
        expected = TPG366USBClient if usb else TPG366Client
        if self.tpg is None or type(self.tpg) is not expected or self.tpg.host != host or self.tpg.port != port:
            if self.tpg:
                await self.tpg.close()
            self.tpg = expected(host, port)
        try:
            await self.tpg.connect()
            await self.tpg.read_unit()
            await self._poll_tpg()
            self._tpg_connected = True
            self._tpg_error = None
            return {"ok": True, "connection": self.config.tpg_connection, "address": host}
        except TPG366Error as exc:
            self._tpg_connected = False
            self._tpg_error = str(exc)
            return {"ok": False, "error": str(exc)}
        finally:
            self._publish()

    @serialized
    async def connect_devices(self) -> dict:
        if self.mode != "real":
            return {"ok": True, "mode": self.mode}
        results = {"tpg": await self.connect_gauge()}
        dam = self.config.io_device == "dam0808d"
        address = self.config.dam_serial_port if dam else self.config.adam_host
        port = self.config.dam_baudrate if dam else self.config.adam_port
        unit = self.config.dam_unit_id if dam else self.config.adam_unit_id
        driver = Dam0808DClient if dam else Adam6050Client
        if address:
            if self.adam is None or not isinstance(self.adam, driver) or (self.adam.host, self.adam.port, self.adam.unit_id) != (address, port, unit):
                if self.adam:
                    await self.adam.close()
                self.adam = driver(address, port, unit)
            try:
                await self._poll_io()
                self._adam_connected = True
                self._io_error = None
                results["adam"] = {"ok": True, "device": self.config.io_device}
            except ModbusError as exc:
                self._adam_connected = False
                self._io_error = str(exc)
                results["adam"] = {"ok": False, "error": str(exc)}
        else:
            results["adam"] = {"ok": False, "error": "未配置 DAM 串口" if dam else "未配置 IP"}
        self._refresh_status()
        self._publish()
        return {"ok": all(item.get("ok") for item in results.values()), **results}

    async def _ensure_io_driver(self) -> None:
        if self.adam is not None:
            return
        if self.config.io_device == "dam0808d":
            if not self.config.dam_serial_port:
                raise InterlockError("未配置 DAM 串口，无法撤销开阀输出")
            self.adam = Dam0808DClient(self.config.dam_serial_port,
                                      self.config.dam_baudrate, self.config.dam_unit_id)
        else:
            if not self.config.adam_host:
                raise InterlockError("未配置 I/O 地址，无法撤销开阀输出")
            self.adam = Adam6050Client(self.config.adam_host,
                                      self.config.adam_port, self.config.adam_unit_id)

    async def _clear_debug_outputs(self) -> None:
        for channel in list(self._debug_deadlines):
            if self.mode == "simulation":
                self._debug_sim_outputs[channel] = False
            elif self.adam:
                await self.adam.write_output(channel, False)
            self._debug_deadlines.pop(channel, None)

    @serialized
    async def debug_relays(self) -> dict:
        if self.config.io_device != "dam0808d":
            raise InterlockError("Debug 继电器菜单仅支持 DAM0808D")
        if self.mode == "simulation":
            outputs = list(self._debug_sim_outputs)
        else:
            if not self.adam or not self._adam_connected:
                raise InterlockError("DAM 未连接，请检查串口配置与接线")
            outputs = await self.adam.read_outputs()
        return {"mode": self.mode, "outputs": outputs,
                "interlock": self.interlock,
                "remaining_s": {str(ch): max(0, deadline-time.monotonic())
                                for ch, deadline in self._debug_deadlines.items() if deadline is not None}}

    @serialized
    async def debug_set_relay(self, channel: int, enabled: bool, duration_s: float,
                              actor: str = "operator") -> dict:
        if not 0 <= channel < 8 or not (duration_s == 0 or 1 <= duration_s <= 60):
            raise InterlockError("继电器编号或通电时长无效")
        if self.config.io_device != "dam0808d":
            raise InterlockError("Debug 继电器菜单仅支持 DAM0808D")
        if enabled and (self.interlock != "disarmed" or self._stopping):
            raise InterlockError("只有联锁未启用时才能手动开启继电器")
        if enabled and self._history_error:
            raise InterlockError("审计存储故障，不能开启 Debug 输出")
        if self.mode == "simulation":
            self._debug_sim_outputs[channel] = enabled
        else:
            if not self.adam or not self._adam_connected:
                raise InterlockError("DAM 未连接")
            # Register cleanup before writing: a write can succeed even if its
            # acknowledgement is lost. Never lose the obligation to clear it.
            if enabled:
                self._debug_deadlines[channel] = time.monotonic()
            try:
                await self.adam.write_output(channel, enabled)
            except (ModbusError, OSError):
                if enabled:
                    try:
                        await self._clear_debug_outputs()
                    except (ModbusError, OSError):
                        pass
                raise
        if enabled:
            self._debug_deadlines[channel] = time.monotonic() + duration_s if duration_s else None
        else:
            self._debug_deadlines.pop(channel, None)
        self._event("debug_relay", "warning", f"Debug OUT{channel+1} {'开启' if enabled else '关闭'}",
                    actor, {"channel": channel, "enabled": enabled, "duration_s": duration_s})
        return await self.debug_relays()

    @serialized
    async def inject_pressure(self, channel: int, pressure_pa: float) -> None:
        if self.mode != "simulation":
            raise InterlockError("只能在模拟模式注入压力")
        self._sim_pressure[channel - 1] = pressure_pa

    @serialized
    async def inject_io_fault(self, fault: bool) -> None:
        if self.mode != "simulation":
            raise InterlockError("只能在模拟模式注入 I/O 故障")
        self._sim_io_fault = fault
        self._adam_connected = not fault

    def _di(self, channel: Optional[int]) -> bool:
        if channel is None or channel < 0 or channel >= len(self._io_inputs):
            return False
        return bool(self._io_inputs[channel])

    def _input_active(self, channel: Optional[int], active_high: bool) -> bool:
        raw = self._di(channel)
        return raw if active_high else not raw

    async def _poll_io(self) -> None:
        if self.mode == "simulation":
            self._adam_connected = not self._sim_io_fault
            self._last_io_read = time.monotonic()
            return
        if not self.adam:
            return
        inputs = await self.adam.read_inputs()
        outputs = await self.adam.read_outputs()
        self._io_inputs = inputs
        self._adam_connected = True
        self._io_error = None
        self._last_io_read = time.monotonic()
        if self.interlock == "armed" and not outputs[self.config.open_output] and self._open_output:
            self._open_output = False

    async def _poll_tpg(self) -> None:
        if self.mode == "simulation":
            if self._sim_tpg_fault:
                self._tpg_connected = False
                return
            now = time.monotonic()
            if self._sim_open_after and now >= self._sim_open_after:
                self._sim_state = "open"
                self._sim_open_after = 0.0
            if self._sim_close_after and now >= self._sim_close_after and not self._sim_close_failure:
                self._sim_state = "closed"
                self._sim_close_after = 0.0
            # Gentle drift keeps the trace alive but stays under the example limits.
            for index, pressure in enumerate(self._sim_pressure):
                if self._sim_gauge_status[index] == 0:
                    self._sim_pressure[index] = max(1e-12, pressure * (1 + random.uniform(-0.006, 0.006)))
            self._channels = [
                {
                    "channel": i + 1,
                    "pressure_pa": self._sim_pressure[i],
                    "raw_value": self._sim_pressure[i],
                    "raw_unit": "Pa",
                    "status_code": self._sim_gauge_status[i],
                    "status": STATUS_LABELS.get(self._sim_gauge_status[i], "未知状态"),
                    "valid": self._sim_gauge_status[i] == 0,
                }
                for i in range(6)
            ]
            self._tpg_connected = True
            self._last_tpg_read = now
            return
        if not self.tpg:
            return
        readings = await self.tpg.read_channels()
        self._channels = [self._reading_dict(item) for item in readings]
        self._last_tpg_read = time.monotonic()
        self._tpg_connected = True
        self._tpg_error = None

    @staticmethod
    def _reading_dict(reading: GaugeReading) -> dict:
        return {
            "channel": reading.channel,
            "pressure_pa": reading.pressure_pa,
            "raw_value": reading.raw_value,
            "raw_unit": reading.raw_unit,
            "status_code": reading.status_code,
            "status": STATUS_LABELS.get(reading.status_code, f"未知状态 {reading.status_code}"),
            "valid": reading.valid,
        }

    async def _record_sample(self) -> None:
        timestamp = self._stamp()
        try:
            self.history.write_sample(timestamp, self._channels, self.mode, self.config_store.version)
            self._history_recording = True
            self._history_error = None
        except (OSError, RuntimeError, sqlite3.Error) as exc:
            self._history_recording = False
            self._history_error = str(exc)
            logging.error("Sample storage unavailable: %s", exc)
            await self.trip("历史存储故障，已撤销开阀许可", kind="history_write_error", fault=True)

    async def _run(self) -> None:
        while True:
            tick = time.monotonic()
            try:
                await self._tick(tick)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logging.exception("Protection tick failed; closing valve")
                await self.trip(f"保护循环异常：{exc}", kind="engine_fault", fault=True)
            await asyncio.sleep(max(0.02, 0.1 - (time.monotonic() - tick)))

    @serialized
    async def _tick(self, tick: float) -> None:
        for channel, deadline in list(self._debug_deadlines.items()):
            if deadline is not None and tick >= deadline:
                await self.debug_set_relay(channel, False, 1, "system")
        if self.mode == "real" and (self.tpg is None or (self.adam is None and (self.config.dam_serial_port if self.config.io_device == "dam0808d" else self.config.adam_host))):
            await self.connect_devices()
        try:
            await self._poll_tpg()
            if self.mode == "real" and tick >= self._next_unit_check and self.tpg:
                await self.tpg.read_unit()
                self._next_unit_check = tick + 1.0
        except (TPG366Error, ModbusError, OSError, ValueError) as exc:
            if self.mode == "real":
                self._tpg_connected = False
                self._tpg_error = str(exc)
                if self.tpg:
                    await self.tpg.close()
                if self.interlock == "armed":
                    await self.trip(f"设备通信故障：{exc}", kind="device_communication_trip", fault=True)
            else:
                self._event("simulation_error", "error", f"模拟器内部故障：{exc}")

        # An unavailable gauge must not starve I/O recovery or keep stale valve
        # feedback marked online. Failed I/O polls back off instead of reopening
        # an absent USB adapter on every 100 ms protection tick.
        now = time.monotonic()
        if self.mode == "real" and now >= self._next_io_poll:
            try:
                await self._poll_io()
                self._next_io_poll = time.monotonic() + 0.2
            except (ModbusError, OSError, ValueError) as exc:
                self._adam_connected = False
                self._io_error = str(exc)
                self._next_io_poll = time.monotonic() + 1.0
                if self.adam:
                    await self.adam.close()
                if self.interlock == "armed":
                    await self.trip(f"I/O 通信故障：{exc}", kind="device_communication_trip", fault=True)

        if self.mode == "simulation":
            self._tpg_connected = not self._sim_tpg_fault
            self._adam_connected = not self._sim_io_fault

        if self._off_retry_pending and time.monotonic() >= self._next_off_retry:
            await self._safe_open_output()

        pressure_fault = self._pressure_fault()
        if self.interlock == "armed" and pressure_fault:
            await self.trip(pressure_fault)

        if self.interlock == "armed":
            age = None if self._last_tpg_read is None else time.monotonic() - self._last_tpg_read
            if age is None or age > self.config.stale_timeout_s:
                await self.trip("真空数据更新超时，已撤销开阀许可", kind="stale_data_trip", fault=True)
            elif not self._tpg_connected or not self._adam_connected:
                await self.trip("设备通信未就绪", kind="device_communication_trip", fault=True)
            elif self.mode == "real" and time.monotonic() - self._last_io_read > self.config.stale_timeout_s:
                await self.trip("I/O 数据更新超时，已撤销开阀输出", kind="stale_io_trip", fault=True)

        if self._valve_command is not None or self.interlock == "armed":
            self._refresh_status()
            command_age = time.monotonic() - self._valve_command_at
            if self.status.valve == "fault":
                await self.trip("插板阀打开/关闭位置反馈同时有效", kind="valve_sensor_conflict", fault=True)
            elif (self._valve_command is not None and not self._motion_timed_out
                  and command_age > self.config.valve_timeout_s):
                expected = "open" if self._valve_command == "open" else "closed"
                has_open_feedback = self.mode == "simulation" or self.config.valve_open_di is not None
                reached = self.status.valve == expected
                if expected == "open" and not has_open_feedback:
                    reached = not self.status.valve_closed_sensor and self._adam_connected
                if not reached:
                    action = "打开" if expected == "open" else "关闭"
                    await self.trip(f"插板阀{action}位置反馈超时", kind="valve_motion_timeout", fault=True)
                    self._motion_timed_out = True

        self._refresh_status()
        if self._valve_command and not self._motion_reported:
            expected = "open" if self._valve_command == "open" else "closed"
            if self.status.valve == expected:
                self._event("valve_arrived", "info", "阀门位置反馈已到位", details={
                    "position": expected, "command_to_feedback_s": time.monotonic() - self._valve_command_at})
                self._motion_reported = True
        if self._history_error and self.interlock == "armed":
            await self.trip("历史或审计存储故障", kind="storage_fault", fault=True)

        recovery_pending = self.interlock in ("tripped", "fault") or self._rearm_required
        recovery_fault = self._reset_conditions() if recovery_pending else "inactive"
        if recovery_pending and recovery_fault is None:
            if self._recovery_since is None:
                self._recovery_since = time.monotonic()
        elif recovery_pending:
            self._recovery_since = None

        now = time.monotonic()
        if self._channels and now - self._last_history_write >= self.config.sample_interval_s:
            await self._record_sample()
            self._last_history_write = now
        if self.config.history_retention_days is not None and now - self._last_retention_check >= 3600:
            cutoff = datetime.now(timezone.utc).timestamp() - self.config.history_retention_days * 86400
            cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
            try:
                deleted = self.history.purge_before(cutoff_iso)
                if deleted:
                    self._event("history_retention", "info", "按保留期限清理历史记录", details={"deleted_samples": deleted})
            except (OSError, sqlite3.Error) as exc:
                self._event("history_retention_error", "error", "历史保留期限清理失败", details={"error": str(exc)})
            self._last_retention_check = now
        self._refresh_status()
        self._publish()
