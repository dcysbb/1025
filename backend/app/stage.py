"""Independent, opt-in control of the PDXC3; never shares vacuum device ports."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import time
from pathlib import Path
from typing import Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StageError(Exception):
    pass


class DriveParamsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    forward_amplitude: int = Field(ge=10, le=100, strict=True)
    reverse_amplitude: int = Field(ge=10, le=100, strict=True)
    step_rate: int = Field(ge=800, le=20000, strict=True)
    acceleration: int = Field(ge=1, le=20000, strict=True)


class StageConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["real", "simulation"] = "real"
    connection: Literal["usb", "tcp"] = "tcp"
    serial_number: str = Field(default="", pattern=r"^([0-9]{8,12})?$")
    host: str = ""
    port: int = Field(default=40303, ge=1, le=65535)
    axes: dict[str, int] = Field(default_factory=lambda: {"x": 1, "y": 2, "z": 3})
    inverted: dict[str, bool] = Field(default_factory=lambda: {"x": False, "y": False, "z": False})
    max_steps: int = Field(default=5000, ge=1, le=100000)
    # Quick-step preset buttons shown per axis card; pure UI preference.
    step_presets: list[int] = Field(default_factory=lambda: [1, 10, 100, 1000])
    # Default hardware direction used when Home attempts a real search.
    home_direction: dict[str, int] = Field(default_factory=lambda: {"x": -1, "y": -1, "z": -1})
    # Last applied drive parameters per axis; re-applied on connect when the
    # controller reports different values so tuning survives power cycles.
    drive_params: dict[str, DriveParamsConfig] = Field(default_factory=dict)
    channel_names: dict[str, str] = Field(default_factory=lambda: {str(ch): "" for ch in (1, 2, 3)})
    card_order: list[int] = Field(default_factory=lambda: [1, 2, 3])

    @model_validator(mode="before")
    @classmethod
    def preserve_legacy_axis_order(cls, values):
        if isinstance(values, dict) and "card_order" not in values and isinstance(values.get("axes"), dict):
            axes = values["axes"]
            if set(axes) == {"x", "y", "z"}:
                return {**values, "card_order": [axes[axis] for axis in ("x", "y", "z")]}
        return values

    @model_validator(mode="after")
    def mapping_is_permutation(self):
        if self.host:
            self.host = str(ipaddress.IPv4Address(self.host))
        if set(self.axes) != {"x", "y", "z"} or sorted(self.axes.values()) != [1, 2, 3]:
            raise ValueError("XYZ 必须分别映射到 CH1、CH2、CH3，不能重复")
        if set(self.inverted) != {"x", "y", "z"}:
            raise ValueError("每个轴必须指定方向")
        if not 2 <= len(self.step_presets) <= 6 or any(
                not isinstance(v, int) or not 1 <= v <= 100000 for v in self.step_presets):
            raise ValueError("快捷步数必须为 2–6 项，每项 1–100000 的整数")
        if len(set(self.step_presets)) != len(self.step_presets):
            raise ValueError("快捷步数不能重复")
        if set(self.home_direction) != {"x", "y", "z"} or any(
                v not in (-1, 1) for v in self.home_direction.values()):
            raise ValueError("每轴回零方向必须为 1 或 -1")
        if not set(self.drive_params) <= {"x", "y", "z"}:
            raise ValueError("驱动参数只能按 x/y/z 轴保存")
        if set(self.channel_names) != {"1", "2", "3"}:
            raise ValueError("通道名称必须对应 CH1、CH2、CH3")
        self.channel_names = {key: value.strip() for key, value in self.channel_names.items()}
        if any(len(value) > 32 or any(ord(char) < 32 for char in value) for value in self.channel_names.values()):
            raise ValueError("通道名称最多 32 个字符，不能包含控制字符")
        if sorted(self.card_order) != [1, 2, 3]:
            raise ValueError("面板顺序必须包含 CH1、CH2、CH3 各一次")
        return self


class StageMove(BaseModel):
    axis: Literal["x", "y", "z"]
    steps: int = Field(ge=1, le=100000, strict=True)
    direction: Literal[-1, 1]


class StageJog(BaseModel):
    axis: Literal["x", "y", "z"]
    direction: Literal[-1, 1]
    lease_id: str | None = Field(default=None, min_length=1, max_length=80)


class StageJogLease(BaseModel):
    lease_id: str = Field(min_length=1, max_length=80)


class StagePresets(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presets: list[int] = Field(min_length=2, max_length=6)


class StagePresentation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel_names: dict[str, str] | None = None
    card_order: list[int] | None = Field(default=None, min_length=3, max_length=3)


class StageAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    axis: Literal["x", "y", "z"]
    operation: Literal["enable", "disable", "zero", "optimize", "home"]
    confirmed: bool = False
    home_direction: Literal[-1, 1] | None = None


class StageParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    forward_amplitude: int = Field(ge=10, le=100, strict=True)
    reverse_amplitude: int = Field(ge=10, le=100, strict=True)
    step_rate: int = Field(ge=800, le=20000, strict=True)
    acceleration: int = Field(ge=1, le=20000, strict=True)


class StageRecovery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed_stationary: bool = False


class StageController:
    def __init__(self, root: Path, event, driver_factory=None):
        self.path = root / "stage.json"
        self.event = event
        self.driver_factory = driver_factory
        self.config = StageConfig()
        self.error = None
        if self.path.exists():
            try:
                self.config = StageConfig.model_validate_json(self.path.read_text(encoding="utf-8"))
            except (ValueError, OSError) as exc:
                self.error = f"位移台配置无法读取：{exc}"
        self.driver = None
        self.connected = False
        self.channels = []
        self._lock = asyncio.Lock()
        self._poll_task = None
        self._must_stop = False
        self.motion_pending = False
        self._move_admitting = False
        self._stopping_count = 0
        self._disconnecting_count = 0
        self._stop_epoch = 0
        self._last_sample = None
        self._read_failures = 0
        self._sample_count = 0
        self._uncertain = False
        self.operation = None
        self._operation_at = 0
        self._parameter_error = None
        self._motion_deadline = 0
        self._optimization_seen_busy = False
        self._recovering = False
        self._connecting = False
        self._motion_lock_reason = None
        self._jogging = None
        self._jog_lease_id = None
        self._jog_lease_deadline = 0
        self._poll_wake = asyncio.Event()
        self.recovery_path = root / "stage-recovery.json"
        if self.recovery_path.exists():
            try:
                reason = json.loads(self.recovery_path.read_text(encoding="utf-8")).get("reason", "之前的运动或停止未确认")
            except (ValueError, OSError, AttributeError):
                reason = "恢复记录无法读取，不能确认上次动作结果"
            self._uncertain = self.motion_pending = self._must_stop = True
            self._motion_lock_reason = reason
            self.error = f"上次操作未确认，移动已锁定：{reason}"

    def _persist_config(self, config=None):
        """Atomic stage.json write for runtime-tunable fields (presets, saved
        drive parameters). Caller must hold self._lock; connection-critical
        fields still go through configure() with its disconnect requirement."""
        data = config if config is not None else self.config
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".json.tmp")
        temp.write_text(data.model_dump_json(indent=2), encoding="utf-8")
        temp.replace(self.path)

    def _save_recovery(self, reason):
        self.recovery_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.recovery_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps({"serial_number": self.config.serial_number,
            "mode": self.config.mode, "reason": reason, "operation": self.operation}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.recovery_path)

    def _remember_fault(self):
        self._motion_lock_reason = self.error or "动作结果或停止未确认"
        try:
            self._save_recovery(self._motion_lock_reason)
        except OSError as exc:
            self.error = f"{self.error}；恢复记录保存失败：{exc}"

    def _clear_recovery(self):
        self.recovery_path.unlink(missing_ok=True)
        self._motion_lock_reason = None

    def snapshot(self):
        return {"config": self.config.model_dump(), "connected": self.connected,
                "error": self.error, "channels": self.channels, "model": "PDXC3",
                "stage": "PD1V/M", "position_feedback": False,
                "motion_pending": self.motion_pending,
                "jogging": None if not self._jogging else dict(self._jogging),
                "operation": None if not self.operation else {**self.operation,
                    "elapsed_s": round(max(0, time.monotonic() - self._operation_at), 1),
                    "phase": "running" if self._optimization_seen_busy else "waiting"},
                "diagnostics": {"transport": getattr(self.driver, "transport", ""),
                    "latency_ms": getattr(self.driver, "last_latency_ms", None),
                    "sample_age_s": None if self._last_sample is None else round(time.monotonic() - self._last_sample, 2),
                    "read_failures": self._read_failures, "sample_count": self._sample_count,
                    "recovery_required": self._uncertain or self.driver is not None and not self.connected,
                    "motion_locked": self._uncertain}}

    @staticmethod
    def _idle(channels):
        return (len(channels) == 3 and {row.get("channel") for row in channels} == {1, 2, 3}
                and all(row.get("moving") is False and not row.get("optimizing") for row in channels))

    def _move_event(self, command, actor, result, reason="", continuous=False):
        channel = self.config.axes[command.axis]
        labels = {"submitted": "请求已下发", "rejected": "未下发", "unconfirmed": "结果未确认"}
        self.event("stage_move", "info" if result == "submitted" else "warning" if result == "rejected" else "error",
                   f"{command.axis.upper()} 轴{'连续' if continuous else ''}移动：{labels[result]}", actor,
                   {**command.model_dump(), "channel": channel, "continuous": continuous,
                    "hardware_direction": command.direction * (-1 if self.config.inverted[command.axis] else 1),
                    "mode": self.config.mode, "result": result, "reason": reason})

    async def _call(self, fn, *args):
        # Keep native SDK calls off the vacuum acquisition/event loop. Await the
        # bounded worker even on cancellation so a second command cannot race it.
        worker = asyncio.create_task(asyncio.to_thread(fn, *args))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            try:
                await worker
            except Exception:
                pass
            raise

    async def configure(self, config: StageConfig, actor):
        if self._uncertain:
            raise StageError("上次操作或停止未确认，不能通过修改配置解除移动锁定；可直接连接，确认静止后解除运动锁定")
        if self._recovering or self._connecting:
            raise StageError("连接恢复正在进行，请等待后再修改配置")
        async with self._lock:
            if self._recovering or self._connecting:
                raise StageError("连接恢复正在进行，请等待后再修改配置")
            if self.driver is not None:
                raise StageError("请先断开位移台，再修改连接或轴映射")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".json.tmp")
            try:
                temp.write_text(config.model_dump_json(indent=2), encoding="utf-8")
                temp.replace(self.path)
            except OSError as exc:
                raise StageError(
                    f"无法写入位移台配置文件 {self.path}：{exc}；"
                    "请检查运行数据目录是否可写（后台账户需要写入权限）") from exc
            self.config = config.model_copy(deep=True)
            self.error = None
            self.channels = []
            self.motion_pending = False
            self._uncertain = False
            self._parameter_error = None
            self.operation = None
            self._motion_deadline = 0
            self.event("stage_config", "info", "位移台配置已保存", actor, config.model_dump())
            return self.snapshot()

    async def connect(self, actor, *, _recovery=False):
        if self._recovering and not _recovery:
            raise StageError("连接恢复正在进行，请勿重复连接")
        if self._connecting or self._move_admitting or self._stopping_count or self._disconnecting_count:
            raise StageError("有操作正在处理，请等待后再连接")
        if self.connected:
            raise StageError("位移台已连接")
        self._connecting = True
        try:
            if self._poll_task:
                self._poll_task.cancel()
                try:
                    await self._poll_task
                except asyncio.CancelledError:
                    pass
                self._poll_task = None
            async with self._lock:
                return await self._connect_locked(actor)
        finally:
            self._connecting = False

    async def _connect_locked(self, actor):
        # Reconnecting only replaces a failed communication session. It must
        # neither clear an uncertain motion journal nor issue a stop/move.
        old, self.driver = self.driver, None
        if old:
            try:
                await self._call(old.close)
            except Exception as exc:
                self.event("stage_connect", "warning", "失效本机会话已释放，设备断开应答未确认", actor, {"reason": str(exc)})
        if self.config.mode == "real" and not self.config.serial_number:
            raise StageError("请先填写 PDXC3 序列号")
        if self.driver_factory:
            driver = self.driver_factory(self.config)
        elif self.config.mode == "simulation":
            driver = SimulatedStage()
        else:
            from .drivers.isolated_pdxc3 import IsolatedPdxc3Driver
            driver = IsolatedPdxc3Driver(self.config.serial_number, self.config.host, self.config.port,
                                 connection=self.config.connection)
        try:
            await self._call(driver.connect)
            channels = await self._call(driver.status)
        except (Exception, asyncio.CancelledError) as exc:
            try:
                await self._call(driver.close)
            except Exception:
                pass
            if isinstance(exc, asyncio.CancelledError):
                raise
            self.error = str(exc)
            raise StageError(self.error) from exc
        self.driver = driver
        self.connected = True
        self.error = f"上次操作未确认，移动已锁定：{self._motion_lock_reason or '动作或停止状态未确认'}" if self._uncertain else None
        self.channels = channels
        self._last_sample = time.monotonic()
        self._read_failures = 0
        self._sample_count = 1
        self.operation = None
        self.motion_pending = self._uncertain
        self._parameter_error = None
        self._motion_deadline = 0
        await self._restore_drive_params(actor)
        self.event("stage_connect", "info", "位移台已连接", actor,
                   {"mode": self.config.mode, "serial_number": self.config.serial_number,
                    "motion_locked": self._uncertain})
        self._poll_task = asyncio.create_task(self._poll())
        return self.snapshot()

    async def _restore_drive_params(self, actor):
        """Re-apply saved drive parameters whose controller values drifted
        (typically after a controller power cycle). A failure locks motion via
        _parameter_error instead of dropping the connection."""
        if not self.config.drive_params:
            return
        applied = []
        try:
            for axis, saved in self.config.drive_params.items():
                channel = self.config.axes[axis]
                wanted = saved.model_dump() if hasattr(saved, "model_dump") else dict(saved)
                current = await self._call(self.driver.parameters, channel)
                if any(current["values"].get(key) != value for key, value in wanted.items()):
                    await self._call(self.driver.set_parameters, channel, wanted)
                    applied.append(f"{axis.upper()}/CH{channel}")
        except Exception as exc:
            self._parameter_error = f"恢复保存的驱动参数失败，移动已锁定；请重新读取并核对参数：{exc}"
            self.error = self._parameter_error
            self.event("stage_parameters", "warning", self._parameter_error, actor)
            return
        if applied:
            self.event("stage_parameters", "info",
                       "已恢复保存的驱动参数：" + "、".join(applied), actor, {"axes": applied})

    async def set_presets(self, values, actor):
        # Pure UI preference: no hardware interaction, allowed while connected.
        async with self._lock:
            try:
                updated = StageConfig(**{**self.config.model_dump(), "step_presets": list(values)})
            except ValueError as exc:
                raise StageError(str(exc)) from exc
            try:
                self._persist_config(updated)
            except OSError as exc:
                raise StageError(f"快捷步数保存失败：{exc}") from exc
            self.config = updated
            self.event("stage_config", "info", "快捷步数已保存", actor, {"step_presets": list(values)})
            return self.snapshot()

    async def set_presentation(self, body: StagePresentation, actor):
        async with self._lock:
            patch = body.model_dump(exclude_none=True)
            if not patch:
                raise StageError("请指定通道名称或面板顺序")
            if "channel_names" in patch:
                patch["channel_names"] = {**self.config.channel_names, **patch["channel_names"]}
            try:
                updated = StageConfig(**{**self.config.model_dump(), **patch})
                self._persist_config(updated)
            except (ValueError, OSError) as exc:
                raise StageError(f"面板设置保存失败：{exc}") from exc
            self.config = updated
            self.event("stage_presentation", "info", "位移台通道名称与面板排列已保存", actor, patch)
            return self.snapshot()

    async def _poll(self):
        while True:
            try:
                await asyncio.wait_for(self._poll_wake.wait(), timeout=0.1 if self.motion_pending else 0.5)
            except asyncio.TimeoutError:
                pass
            self._poll_wake.clear()
            if not await self._poll_once():
                return

    async def _poll_once(self):
        # Never let the status sweep queue behind itself: if a command holds the
        # lock, skip this cycle instead of adding poll latency to the command.
        try:
            await asyncio.wait_for(self._lock.acquire(), timeout=0.05)
        except asyncio.TimeoutError:
            return True
        try:
            return await self._poll_locked()
        finally:
            self._lock.release()

    async def _poll_locked(self):
            if not self.connected or self.driver is None:
                return False
            try:
                self.channels = await self._call(self.driver.status)
                self._last_sample = time.monotonic()
                self._sample_count += 1
                self._read_failures = 0
                if self.operation and any(row.get("channel") == self.operation["channel"] and
                        (row.get("optimizing") or row.get("moving") is True) for row in self.channels):
                    self._optimization_seen_busy = True
                if not self._uncertain:
                    self.error = self._parameter_error
                if self.motion_pending and (self.operation or not self._idle(self.channels)) and self._motion_deadline and time.monotonic() > self._motion_deadline:
                    await self._call(self.driver.stop)
                    self.channels = await self._call(self.driver.status)
                    self.connected = False
                    self._uncertain = True
                    self.error = "运动超过预期时间，已请求全部停止；请检查实际行程并确认静止后解除运动锁定"
                    self._remember_fault()
                    self.event("stage_fault", "error", self.error, "system")
                    return False
                if self._idle(self.channels) and not self._uncertain and not self._jogging and (not self.operation or self._optimization_seen_busy and time.monotonic() - self._operation_at >= 2):
                    if self.motion_pending:
                        self._clear_recovery()
                    if self.operation:
                        target = next(row for row in self.channels if row["channel"] == self.operation["channel"])
                        if self.operation["kind"] == "home":
                            moved = self._optimization_seen_busy
                            self.event("stage_action", "info" if moved else "warning",
                                "回零运动已结束；到位情况仍以机械参考为准" if moved else
                                "控制器立即返回，未执行寻找机械原点；仅清零了命令计数",
                                "system", {"axis": self.operation["axis"], "channel": self.operation["channel"],
                                "operation": "home", "mode": self.config.mode,
                                "result": "completed" if moved else "zeroed_only"})
                        else:
                            success = target.get("optimized") is True
                            self.event("stage_action", "info" if success else "warning",
                                "控制器报告优化完成；不代表实测位移或到位" if success else "优化运动结束，但控制器未返回优化成功标志，请检查负载与控制器状态",
                                "system", {"axis": self.operation["axis"], "channel": self.operation["channel"],
                                "operation": "optimize", "mode": self.config.mode,
                                "result": "completed" if success else "not_optimized"})
                    self.motion_pending = False
                    self._must_stop = False
                    self._jogging = None
                    self.operation = None
                    self._motion_deadline = 0
            except Exception as exc:
                self._read_failures += 1
                self.error = f"位移台状态读取失败（第 {self._read_failures} 次），移动已暂停：{exc}"
                if not self._must_stop and not self.motion_pending and self._read_failures < 3:
                    self.channels = [{**row, "moving": None, "ready": False, "error": self.error} for row in self.channels]
                    return True  # Retry reads only; never replay a command or enable.
                if self._must_stop or any(row.get("moving") is True for row in self.channels):
                    try:
                        await self._call(self.driver.stop)
                    except Exception:
                        pass
                self.connected = False
                self.error = f"位移台通信中断，运动状态未知：{exc}"
                self.channels = []
                self._uncertain = self.motion_pending or self._must_stop
                if self._uncertain:
                    self._remember_fault()
                self.event("stage_fault", "error", self.error, "system")
                return False
            return True

    async def move(self, command: StageMove, actor):
        # Reserve admission before awaiting the SDK lock. A second HTTP request
        # must be rejected, never queued behind a move or stop.
        if self._recovering or self._connecting or self._move_admitting or self.motion_pending or self._uncertain or self._stopping_count or self._disconnecting_count:
            reason = "请等待当前移动或停止确认后再移动"
            self._move_event(command, actor, "rejected", reason)
            raise StageError(reason)
        self._move_admitting = True
        epoch = self._stop_epoch
        invoked = False
        try:
            async with self._lock:
                try:
                    if not self.connected or self.driver is None:
                        raise StageError("位移台未连接")
                    if command.steps > self.config.max_steps:
                        raise StageError(f"单次移动不能超过 {self.config.max_steps} 步")
                    if self._parameter_error:
                        raise StageError(self._parameter_error)
                    if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                        raise StageError("停止或断开已请求，本次移动未下发")
                    channel = self.config.axes[command.axis]
                    direction = command.direction * (-1 if self.config.inverted[command.axis] else 1)
                    # A poll sample at most one poll cycle old still proves
                    # idleness; only read the controller when it went stale.
                    if self._last_sample is None or time.monotonic() - self._last_sample > 1.0:
                        self.channels = await self._call(self.driver.status)
                        self._last_sample = time.monotonic()
                    if not self._idle(self.channels):
                        raise StageError("请等待当前移动完成或停止后再移动")
                    target = next((row for row in self.channels if row["channel"] == channel), None)
                    if target is None or target.get("ready") is not True:
                        raise StageError(f"CH{channel} 未就绪：{(target or {}).get('error') or '请核对位移台配置'}")
                    if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                        raise StageError("停止或断开已请求，本次移动未下发")
                    try:
                        await asyncio.to_thread(self._save_recovery, "移动请求已准备下发，尚未确认停止或完成")
                    except OSError as exc:
                        raise StageError(f"无法保存动作恢复记录，本次移动未下发：{exc}") from exc
                    if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                        self._clear_recovery()
                        raise StageError("停止或断开已请求，本次移动未下发")
                    self._must_stop = True
                    self.motion_pending = True
                    invoked = True
                    await self._call(self.driver.move, channel, direction, command.steps)
                    self._poll_wake.set()
                    budget = getattr(self.driver, "move_budget_s", 30)
                    self._motion_deadline = time.monotonic() + (budget if isinstance(budget, (int, float)) else 30)
                    self._move_event(command, actor, "submitted")
                    return self.snapshot()
                except (Exception, asyncio.CancelledError) as exc:
                    if isinstance(exc, StageError) and not invoked:
                        self._move_event(command, actor, "rejected", str(exc))
                        raise
                    if invoked:
                        self._uncertain = True
                        try:
                            await self._call(self.driver.stop)
                        except Exception:
                            pass
                    self.connected = False
                    self.channels = []
                    self.error = (f"移动未确认，勿重复发送，请先停止并重新连接：{exc}" if invoked else
                                  f"移动未下发，状态读取失败，请检查连接：{exc}")
                    if invoked:
                        self._remember_fault()
                    self._move_event(command, actor, "unconfirmed" if invoked else "rejected", self.error)
                    self.event("stage_fault", "error", self.error, actor)
                    if isinstance(exc, asyncio.CancelledError):
                        raise
                    raise StageError(self.error) from exc
        finally:
            self._move_admitting = False

    async def jog(self, command: StageJog, actor):
        """Press-and-hold continuous jog; runs until stop() with no deadline."""
        if self._recovering or self._connecting or self._move_admitting or self.motion_pending or self._uncertain or self._stopping_count or self._disconnecting_count:
            reason = "请等待当前移动或停止确认后再点动"
            self._move_event(command, actor, "rejected", reason, continuous=True)
            raise StageError(reason)
        self._move_admitting = True
        epoch = self._stop_epoch
        invoked = False
        try:
            async with self._lock:
                try:
                    if not self.connected or self.driver is None:
                        raise StageError("位移台未连接")
                    if self._parameter_error:
                        raise StageError(self._parameter_error)
                    if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                        raise StageError("停止或断开已请求，本次点动未下发")
                    channel = self.config.axes[command.axis]
                    direction = command.direction * (-1 if self.config.inverted[command.axis] else 1)
                    if self._last_sample is None or time.monotonic() - self._last_sample > 1.0:
                        self.channels = await self._call(self.driver.status)
                        self._last_sample = time.monotonic()
                    if not self._idle(self.channels):
                        raise StageError("请等待当前移动完成或停止后再点动")
                    target = next((row for row in self.channels if row["channel"] == channel), None)
                    if target is None or target.get("ready") is not True:
                        raise StageError(f"CH{channel} 未就绪：{(target or {}).get('error') or '请核对位移台配置'}")
                    try:
                        await asyncio.to_thread(self._save_recovery, "连续点动已准备下发，尚未确认停止")
                    except OSError as exc:
                        raise StageError(f"无法保存动作恢复记录，本次点动未下发：{exc}") from exc
                    if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                        self._clear_recovery()
                        raise StageError("停止或断开已请求，本次点动未下发")
                    self._must_stop = True
                    self.motion_pending = True
                    invoked = True
                    await self._call(self.driver.jog_start, channel, direction)
                    self._jogging = {"axis": command.axis, "channel": channel,
                                     "direction": command.direction}
                    self._jog_lease_id = None
                    if command.lease_id:
                        self._jog_lease_id = command.lease_id
                        self._jog_lease_deadline = time.monotonic() + 1.5
                        asyncio.create_task(self._watch_jog_lease(command.lease_id))
                    self._poll_wake.set()
                    self._motion_deadline = 0
                    self._move_event(command, actor, "submitted", continuous=True)
                    return self.snapshot()
                except (Exception, asyncio.CancelledError) as exc:
                    if isinstance(exc, StageError) and not invoked:
                        self._move_event(command, actor, "rejected", str(exc), continuous=True)
                        raise
                    if invoked:
                        self._uncertain = True
                        try:
                            await self._call(self.driver.stop)
                        except Exception:
                            pass
                    self.connected = False
                    self.channels = []
                    self.error = (f"连续点动未确认，勿重复发送，请先停止并重新连接：{exc}" if invoked else
                                  f"连续点动未下发，状态读取失败，请检查连接：{exc}")
                    if invoked:
                        self._remember_fault()
                    self._move_event(command, actor, "unconfirmed" if invoked else "rejected", self.error, continuous=True)
                    self.event("stage_fault", "error", self.error, actor)
                    if isinstance(exc, asyncio.CancelledError):
                        raise
                    raise StageError(self.error) from exc
        finally:
            self._move_admitting = False

    def renew_jog(self, lease_id):
        if (not self.connected or not self._jogging or lease_id != self._jog_lease_id
                or time.monotonic() >= self._jog_lease_deadline):
            raise StageError("连续移动已结束或控制凭据已失效")
        self._jog_lease_deadline = time.monotonic() + 1.5
        return {"ok": True}

    async def _watch_jog_lease(self, lease_id):
        while self._jog_lease_id == lease_id and self._jogging and self.connected:
            await asyncio.sleep(0.1)
            if self._jog_lease_id != lease_id or not self._jogging:
                return
            if time.monotonic() >= self._jog_lease_deadline:
                try:
                    await self.stop("system")
                except StageError:
                    pass
                self.event("stage_jog_expired", "warning", "按住信号中断，已请求全部停止", "system")
                return

    async def stop(self, actor):
        self._jog_lease_id = None
        self._stopping_count += 1
        self._stop_epoch += 1
        try:
            return await self._stop_locked(actor)
        finally:
            self._stopping_count -= 1

    async def _stop_locked(self, actor):
        async with self._lock:
            if self.driver is None:
                raise StageError("位移台未建立连接，无法确认停止")
            try:
                await self._call(self.driver.stop)
                self.channels = await self._call(self.driver.status)
                self._must_stop = not self._idle(self.channels)
                self.motion_pending = self._must_stop
                if not self._must_stop:
                    self._jogging = None
                    self._clear_recovery()
                    self._uncertain = False
                    self.error = self._parameter_error
                    if self.operation:
                        self.event("stage_action", "warning", "优化已被全部停止；未判定为优化完成", actor,
                            {"axis": self.operation["axis"], "channel": self.operation["channel"],
                             "operation": "optimize", "mode": self.config.mode, "result": "stopped"})
                    self.operation = None
                    self._motion_deadline = 0
            except Exception as exc:
                self.connected = False
                self.channels = []
                self._uncertain = self.motion_pending = self._must_stop = True
                self.error = f"无法确认停止：{exc}"
                self._remember_fault()
                raise StageError(self.error) from exc
            self.event("stage_stop", "warning", "已发送位移台全部通道停止指令", actor,
                       {"mode": self.config.mode})
            return self.snapshot()

    async def disconnect(self, actor="system"):
        self._jog_lease_id = None
        if self._recovering or self._connecting:
            raise StageError("连接恢复正在进行，请等待；全部停止仍可使用")
        self._disconnecting_count += 1
        self._stop_epoch += 1
        try:
            return await self._disconnect_locked(actor)
        finally:
            self._disconnecting_count -= 1

    async def _disconnect_locked(self, actor):
        if self.driver is None and self._uncertain:
            raise StageError("停止未确认，断开不能解除移动锁定；可直接连接并读取状态")
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None
        async with self._lock:
            if self.driver is not None:
                try:
                    if self._must_stop or not self.channels or any(row.get("moving") is not False for row in self.channels):
                        await self._call(self.driver.stop)
                        self.channels = await self._call(self.driver.status)
                        if not self._idle(self.channels):
                            raise StageError("停止后的运动状态尚未确认")
                    self._clear_recovery()
                    await self._call(self.driver.close)
                except Exception as exc:
                    self.connected = False
                    self.channels = []
                    self.motion_pending = True
                    self.error = f"断开前停止未确认，请检查控制器：{exc}"
                    self._uncertain = True
                    self._remember_fault()
                    raise StageError(self.error) from exc
                self.driver = None
                self._must_stop = False
            self.connected = False
            self.channels = []
            self.motion_pending = False
            self.operation = None
            self._jogging = None
            self._uncertain = False
            self._parameter_error = None
            self._motion_deadline = 0
            self.error = None
            return self.snapshot()

    async def recover(self, confirmed_stationary, actor):
        if not confirmed_stationary:
            raise StageError("请先现场确认位移台已静止，再解除运动锁定；连接和状态读取无需此确认")
        if self.connected and not self._uncertain:
            raise StageError("连接仍有效，没有需要解除的运动锁定")
        if self._recovering or self._connecting or self._move_admitting or self._stopping_count or self._disconnecting_count:
            raise StageError("有操作正在处理，请等待")
        self._recovering = True
        try:
            return await self._recover_confirmed(actor)
        finally:
            self._recovering = False

    async def _recover_confirmed(self, actor):
        try:
            if not self.connected:
                await self.connect(actor, _recovery=True)
            async with self._lock:
                self.channels = await self._call(self.driver.status)
                if not self._idle(self.channels):
                    raise StageError("控制器尚未报告全部通道空闲，请停止后再解除运动锁定")
                self._clear_recovery()
                self._uncertain = self.motion_pending = self._must_stop = False
                self._jogging = None
                self.error = self._parameter_error = None
                self.operation = None
                self._motion_deadline = 0
                self._last_sample = time.monotonic()
                self.event("stage_recovery", "warning", "现场确认静止且状态读回空闲，运动锁定已解除；未启用输出或重发动作", actor)
                return self.snapshot()
        except StageError:
            # A refused unlock is not a failed connection. Keep the readable
            # session and existing journal when channels are still moving.
            raise
        except Exception:
            self.connected = False
            self._uncertain = True
            self.motion_pending = True
            self._remember_fault()
            raise

    def _require_axis(self, axis):
        if not self.connected or self.driver is None or self._uncertain:
            raise StageError("位移台未连接或运动结果未确认，请连接并检查运动锁定")
        channel = self.config.axes[axis]
        target = next((row for row in self.channels if row["channel"] == channel), None)
        if not target or not target.get("ready"):
            raise StageError(f"CH{channel} 未就绪：{(target or {}).get('error') or '请检查识别型号'}")
        return channel

    async def parameters(self, axis, values=None, actor="operator"):
        if self._recovering or self._connecting or self._move_admitting or self.motion_pending or self._stopping_count or self._disconnecting_count:
            raise StageError("请等待运动、优化或停止结束后再读取或应用参数")
        self._move_admitting = True
        try:
            return await self._parameters_locked(axis, values, actor)
        except StageError:
            raise
        except (Exception, asyncio.CancelledError) as exc:
            self.error = f"驱动参数读取失败，未下发运动：{exc}"
            self.connected = False
            self.channels = []
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise StageError(self.error) from exc
        finally:
            self._move_admitting = False

    async def _parameters_locked(self, axis, values, actor):
        epoch = self._stop_epoch
        async with self._lock:
            self.channels = await self._call(self.driver.status) if self.driver else []
            channel = self._require_axis(axis)
            if not self._idle(self.channels):
                raise StageError("请先停止位移台")
            if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                raise StageError("已请求停止或断开，本次参数操作未下发")
            if values is None:
                result = await self._call(self.driver.parameters, channel)
                self._parameter_error = None
                self.error = None
                return result
            try:
                result = await self._call(self.driver.set_parameters, channel, values)
            except (Exception, asyncio.CancelledError) as exc:
                self.error = self._parameter_error = f"参数应用未确认，请重新读取核对；未自动重发：{exc}"
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise StageError(self.error) from exc
            # Remember the applied tuning so the next connect can restore it
            # after a controller power cycle.
            merged = {axis: params.model_dump() if hasattr(params, "model_dump") else dict(params)
                      for axis, params in self.config.drive_params.items()}
            merged[axis] = dict(values)
            try:
                self.config = StageConfig(**{**self.config.model_dump(), "drive_params": merged})
                self._persist_config()
                persisted = True
            except (ValueError, OSError):
                persisted = False  # Device values stay applied; only the memory failed.
            self.event("stage_parameters", "info",
                       "驱动参数已应用并读回" + ("，并保存到现场配置（重连后自动恢复）" if persisted else "；写入现场配置失败，断电后不保留"),
                       actor, {"axis": axis, "channel": channel, **values})
            self._parameter_error = None
            self.error = None
            return result

    async def control(self, command: StageAction, actor):
        if self._recovering or self._connecting or self._move_admitting or self.motion_pending or self._stopping_count or self._disconnecting_count:
            raise StageError("请等待当前操作或发送全部停止")
        if command.operation in ("zero", "optimize", "home") and not command.confirmed:
            raise StageError("请确认开环计数清零、自动优化或回零的操作说明")
        self._move_admitting = True
        invoked = False
        epoch = self._stop_epoch
        try:
            async with self._lock:
                self.channels = await self._call(self.driver.status) if self.driver else []
                channel = self._require_axis(command.axis)
                if not self._idle(self.channels) or epoch != self._stop_epoch:
                    raise StageError("通道仍在运动或已请求停止，本次操作未下发")
                if self._parameter_error and command.operation in ("enable", "optimize", "home"):
                    raise StageError(self._parameter_error)
                target = next(row for row in self.channels if row["channel"] == channel)
                if target.get("open_loop") is False and command.operation in ("zero", "optimize", "home"):
                    raise StageError("当前不是开环模式，禁止执行本控制台的清零、优化或回零")
                if command.operation == "optimize" and not target.get("enabled"):
                    raise StageError("请先启用此轴输出，再开始性能优化")
                if command.operation == "home" and not target.get("enabled"):
                    raise StageError("请先启用此轴输出，再尝试回零")
                if command.operation in ("optimize", "home"):
                    try:
                        await asyncio.to_thread(self._save_recovery,
                            "性能优化请求已准备下发，尚未确认停止或完成" if command.operation == "optimize"
                            else "回零请求已准备下发，尚未确认停止或完成")
                    except OSError as exc:
                        raise StageError(f"无法保存动作恢复记录，本次操作未下发：{exc}") from exc
                home_direction_hw = (command.home_direction if command.home_direction is not None
                                     else self.config.home_direction.get(command.axis, -1)) * \
                                    (-1 if self.config.inverted[command.axis] else 1)
                invoked = True
                if command.operation in ("enable", "disable"):
                    await self._call(self.driver.enable, channel, command.operation == "enable")
                elif command.operation == "home":
                    self.motion_pending = self._must_stop = True
                    self.operation = {"kind": "home", "axis": command.axis, "channel": channel}
                    self._operation_at = time.monotonic()
                    self._optimization_seen_busy = False
                    self._motion_deadline = time.monotonic() + 60
                    await self._call(self.driver.home, channel, home_direction_hw)
                elif command.operation == "optimize":
                    self.motion_pending = self._must_stop = True
                    self.operation = {"kind": "optimize", "axis": command.axis, "channel": channel}
                    self._operation_at = time.monotonic()
                    self._optimization_seen_busy = False
                    self._motion_deadline = time.monotonic() + 180
                    await self._call(self.driver.optimize, channel)
                else:
                    await self._call(getattr(self.driver, command.operation), channel)
                self.channels = await self._call(self.driver.status)
                if command.operation in ("optimize", "home"):
                    self._optimization_seen_busy = any(row.get("channel") == channel and
                        (row.get("optimizing") or row.get("moving") is True) for row in self.channels)
                    if command.operation == "home" and not self._optimization_seen_busy and self._idle(self.channels):
                        # The firmware answered without starting a search; on
                        # this family that only zeroed the command counter.
                        self._clear_recovery()
                        self.motion_pending = self._must_stop = False
                        self.operation = None
                        self._motion_deadline = 0
                        self.event("stage_action", "warning",
                            "控制器立即返回，未执行寻找机械原点；仅清零了命令计数", actor,
                            {**command.model_dump(), "channel": channel, "mode": self.config.mode,
                             "result": "zeroed_only"})
                        return self.snapshot()
                else:
                    actual = next(row for row in self.channels if row["channel"] == channel)
                    if not self._idle(self.channels):
                        raise RuntimeError("操作后控制器未报告空闲")
                    if command.operation == "zero" and actual.get("command_count") != 0:
                        raise RuntimeError("清零后的命令计数未读回零")
                    if command.operation in ("enable", "disable") and actual.get("enabled") is not (command.operation == "enable"):
                        raise RuntimeError("输出使能状态与请求不一致")
                message = ("性能优化请求已下发，等待控制器进度" if command.operation == "optimize"
                           else "回零请求已下发，等待运动结束" if command.operation == "home"
                           else "控制器操作读回已确认")
                self.event("stage_action", "info", message, actor,
                    {**command.model_dump(), "channel": channel, "mode": self.config.mode,
                     "result": "submitted" if command.operation in ("optimize", "home") else "verified"})
                return self.snapshot()
        except StageError as exc:
            self.event("stage_action", "warning", str(exc), actor, {**command.model_dump(), "mode": self.config.mode, "channel": self.config.axes[command.axis], "result": "rejected"})
            raise
        except (Exception, asyncio.CancelledError) as exc:
            if invoked:
                self._uncertain = self.motion_pending = self._must_stop = True
                try:
                    await self._call(self.driver.stop)
                except Exception:
                    pass
            self.connected = False
            self.error = f"操作{'结果未确认，勿重复发送' if invoked else '未下发'}：{exc}"
            if invoked:
                self._remember_fault()
            self.event("stage_action", "error", self.error, actor, {**command.model_dump(), "mode": self.config.mode, "channel": self.config.axes[command.axis], "result": "unconfirmed" if invoked else "rejected"})
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise StageError(self.error) from exc
        finally:
            self._move_admitting = False


class SimulatedStage:
    """Explicit simulation only; never substituted for a failed real connection."""
    def __init__(self):
        self.counts = {1: 0, 2: 0, 3: 0}
        self.enabled = {n: True for n in (1, 2, 3)}
        self.optimizing = {}
        self.jogging = {}
        self.settings = {n: {"forward_amplitude": 100, "reverse_amplitude": 100, "step_rate": 5000, "acceleration": 1000} for n in (1, 2, 3)}

    def connect(self):
        pass

    def status(self):
        return [{"channel": n, "moving": n in self.jogging or time.monotonic() < self.optimizing.get(n, 0),
                 "enabled": self.enabled[n],
                 "commanded_steps": self.counts[n], "stage": "PD1V/M", "ready": True,
                 "command_count": self.counts[n], "open_loop": True,
                 "optimizing": time.monotonic() < self.optimizing.get(n, 0), "optimized": n in self.optimizing,
                 "error": None} for n in (1, 2, 3)]

    def move(self, channel, direction, steps):
        self.counts[channel] += direction * steps
        self.enabled[channel] = True

    def jog_start(self, channel, direction):
        self.jogging[channel] = direction
        self.enabled[channel] = True

    def stop(self):
        self.optimizing = {}
        self.jogging = {}

    def enable(self, channel, enabled):
        self.enabled[channel] = enabled

    def zero(self, channel):
        self.counts[channel] = 0

    def home(self, channel, direction):
        # Simulate a brief physical search that ends at the reference point.
        self.optimizing[channel] = time.monotonic() + 0.8
        self.counts[channel] = 0

    def optimize(self, channel):
        self.optimizing[channel] = time.monotonic() + 3

    def parameters(self, channel):
        return {"values": dict(self.settings[channel]), "limits": {k: {"min": 10 if "amplitude" in k else 800 if k == "step_rate" else 1, "max": 100 if "amplitude" in k else 20000} for k in self.settings[channel]}}

    def set_parameters(self, channel, values):
        self.settings[channel].update(values)
        return self.parameters(channel)

    def close(self):
        pass


def install_stage_routes(app, stage, require_read_access, require_operator, verify_origin):
    @app.get("/api/stage", dependencies=[Depends(require_read_access)])
    async def status():
        return stage.snapshot()

    @app.put("/api/stage/config")
    async def configure(body: StageConfig, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await stage.configure(body, actor)
        except (StageError, OSError) as exc:
            raise HTTPException(409, str(exc)) from exc

    async def action(name, request, actor, body=None):
        verify_origin(request)
        try:
            if name == "move":
                return await stage.move(body, actor)
            if name == "jog":
                return await stage.jog(body, actor)
            return await getattr(stage, name)(actor)
        except StageError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/stage/connect")
    async def connect(request: Request, actor: str = Depends(require_operator)):
        return await action("connect", request, actor)

    @app.post("/api/stage/disconnect")
    async def disconnect(request: Request, actor: str = Depends(require_operator)):
        return await action("disconnect", request, actor)

    @app.post("/api/stage/recover")
    async def recover(body: StageRecovery, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await stage.recover(body.confirmed_stationary, actor)
        except Exception as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/stage/action")
    async def control(body: StageAction, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await stage.control(body, actor)
        except StageError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/stage/parameters/{axis}")
    async def read_parameters(axis: Literal["x", "y", "z"], actor: str = Depends(require_operator)):
        try:
            return await stage.parameters(axis)
        except Exception as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.put("/api/stage/parameters/{axis}")
    async def write_parameters(axis: Literal["x", "y", "z"], body: StageParameters, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await stage.parameters(axis, body.model_dump(), actor)
        except Exception as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/stage/move")
    async def move(body: StageMove, request: Request, actor: str = Depends(require_operator)):
        return await action("move", request, actor, body)

    @app.post("/api/stage/jog")
    async def jog(body: StageJog, request: Request, actor: str = Depends(require_operator)):
        return await action("jog", request, actor, body)

    @app.post("/api/stage/jog/keepalive")
    async def jog_keepalive(body: StageJogLease, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return stage.renew_jog(body.lease_id)
        except StageError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.put("/api/stage/presets")
    async def presets(body: StagePresets, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await stage.set_presets(body.presets, actor)
        except (StageError, OSError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.patch("/api/stage/presentation")
    async def presentation(body: StagePresentation, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await stage.set_presentation(body, actor)
        except StageError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/stage/stop")
    async def stop(request: Request, actor: str = Depends(require_operator)):
        return await action("stop", request, actor)
