"""Independent EM-CS5-3 service. Connecting never changes motor parameters or motion."""
from __future__ import annotations

import asyncio
import copy
import json
import math
import time
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .drivers.lbtek import LbtekDriver, model_catalog


class LbtekConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    mode: Literal["real", "simulation"] = "real"
    usb_port: int | None = Field(default=None, ge=0, le=2147483647)
    max_distance: float = Field(default=10, gt=0, le=1000)
    names: list[str] = Field(default_factory=lambda: ["", "", ""], min_length=3, max_length=3)
    units: list[Literal["mm", "°"]] = Field(default_factory=lambda: ["mm"] * 3, min_length=3, max_length=3)
    models: list[str | None] = Field(default_factory=lambda: [None] * 3, min_length=3, max_length=3)

    @model_validator(mode="after")
    def validate_names(self):
        self.names = [name.strip() for name in self.names]
        if any(len(n) > 32 or any(ord(c) < 32 for c in n) for n in self.names):
            raise ValueError("通道名称最多 32 个字符，不能包含控制字符")
        if any(n is not None and (len(n) > 80 or not n or any(ord(c) < 32 for c in n)) for n in self.models):
            raise ValueError("位移台型号名称无效")
        return self


class LbtekAction(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    channel: int = Field(ge=1, le=3, strict=True)
    operation: Literal["relative", "absolute", "home", "drive"]
    value: float | None = None
    lease_id: str | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode="after")
    def validate_value(self):
        if self.operation != "home" and self.value is None:
            raise ValueError("移动必须指定数值")
        if self.operation in ("relative", "drive") and not self.value:
            raise ValueError("移动距离或方向不能为零")
        if self.operation == "drive" and (self.value not in (-1, 1) or not self.lease_id):
            raise ValueError("按住移动需要方向和有效的操作标识")
        return self


class LbtekParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    channel: int = Field(ge=1, le=3, strict=True)
    speed: float = Field(gt=0, le=1000)
    acceleration: float = Field(gt=0, le=10000)


class LbtekLease(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lease_id: str = Field(min_length=1, max_length=80)


class LbtekStop(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel: int | None = Field(default=None, ge=1, le=3, strict=True)


class RockerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class SimulatedLbtek:
    def __init__(self, **_):
        self.rows = [dict(channel=ch, can_run=True, stopped=True, enabled=True, home=True,
                          limit_left=False, limit_right=False, left_sensor=True, right_sensor=True,
                          home_sensor=True, position=0., speed=1., acceleration=2.) for ch in (1, 2, 3)]
        self.operations = {}
        self.last = time.monotonic()
        self.rocker_enabled = False
        self.lease = None
        self.deadline = 0

    def call(self, name, *args):
        if name == "enumerate":
            return [0]
        if name in {"connect", "status"}:
            now = time.monotonic()
            dt, self.last = now - self.last, now
            for ch, (operation, target) in list(self.operations.items()):
                row = self.rows[ch - 1]
                if operation == "drive":
                    if now > self.deadline:
                        self.call("stop", ch)
                        continue
                    row["position"] += target * row["speed"] * dt
                else:
                    distance = target - row["position"]
                    travel = row["speed"] * dt
                    if abs(distance) <= travel:
                        row["position"] = target
                        self.call("stop", ch)
                    else:
                        row["position"] += math.copysign(travel, distance)
                row["home"] = abs(row["position"]) < .000001
            return {"channels": copy.deepcopy(self.rows), "usb_port": 0, "axis_base": 0,
                    "rocker_enabled": self.rocker_enabled, "lease_id": self.lease}
        if name in {"action", "drive"}:
            if name == "drive":
                ch, value, self.lease = args
                operation, self.deadline = "drive", time.monotonic() + 1
            else:
                operation, ch, value = args
            row = self.rows[ch - 1]
            target = 0 if operation == "home" else row["position"] + value if operation == "relative" else value
            self.operations[ch] = (operation, target)
            row.update(can_run=False, stopped=False, home=False)
        elif name == "stop":
            channel = args[0] if args else None
            for ch in (channel,) if channel else (1, 2, 3):
                self.operations.pop(ch, None)
                self.rows[ch - 1].update(can_run=True, stopped=True)
            self.lease = None
        elif name == "keepalive":
            if args[0] != self.lease:
                raise RuntimeError("按住操作已结束")
            self.deadline = time.monotonic() + 1
        elif name == "parameters":
            ch, speed, acceleration = args
            self.rows[ch - 1].update(speed=speed, acceleration=acceleration)
            return self.call("status")
        elif name == "rocker":
            self.rocker_enabled = args[0]

    def close(self):
        pass


class LbtekController:
    def __init__(self, root: Path, event, driver_factory=LbtekDriver):
        self.path = root / "lbtek-stage.json"
        self.recovery = root / "lbtek-stage-recovery.json"
        self.event, self.factory = event, driver_factory
        self.config = LbtekConfig()
        self.config_error = None
        self.error = None
        try:
            if self.path.exists():
                self.config = LbtekConfig.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self.error = f"LBTEK 配置读取失败：{exc}"
            self.config_error = self.error
        self.driver = None
        self.connected = False
        self.channels = []
        self.hardware = {}
        self.sample_at = None
        self.pending = set()
        self.uncertain = self.recovery.exists()
        self.active_lease = None
        self.lease_deadline = 0
        self.records = []
        self._lock = asyncio.Lock()
        self._busy = False
        self._stopping = 0
        self._epoch = 0
        self._poll_task = None
        self.instance = uuid4().hex
        try:
            self.catalog = model_catalog()
        except (OSError, ValueError, KeyError):
            self.catalog = {}

    def snapshot(self):
        age = None if self.sample_at is None else time.monotonic() - self.sample_at
        return {"config": self.config.model_dump(), "connected": self.connected,
                "channels": copy.deepcopy(self.channels), "error": self.error,
                "stale": age is None or age > 2 or not self.connected,
                "sample_age_s": age, "motion_pending": sorted(self.pending), "uncertain": self.uncertain,
                "busy": self._busy, "lease_id": self.active_lease, "records": self.records[:20],
                "instance_id": self.instance, **self.hardware}

    def _journal(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.recovery.with_suffix(".json.tmp")
        temp.write_text(json.dumps({"mode": self.config.mode, "usb_port": self.config.usb_port,
                                    "reason": "运动结果尚未确认"}), encoding="utf-8")
        temp.replace(self.recovery)

    def _clear_journal(self):
        if not self.pending and not self.uncertain:
            self.recovery.unlink(missing_ok=True)

    def _record(self, command, actor, result, reason=None):
        from datetime import datetime, timezone
        row = {"timestamp": datetime.now(timezone.utc).isoformat(), **command.model_dump(),
               "mode": self.config.mode, "result": result, "reason": reason}
        self.records.insert(0, row)
        del self.records[20:]
        self.event("lbtek_move", "info" if result == "submitted" else "warning", "LBTEK 运动请求" +
                   {"submitted": "已下发", "rejected": "未下发", "unconfirmed": "结果未确认"}[result], actor, row)

    async def _call(self, name, *args):
        return await asyncio.to_thread(self.driver.call, name, *args)

    async def enumerate(self):
        if self._busy:
            raise RuntimeError("设备操作中，请稍后刷新")
        async with self._lock:
            if self.driver:
                return await self._call("enumerate")
            driver = SimulatedLbtek() if self.config.mode == "simulation" else self.factory()
            try:
                return await asyncio.to_thread(driver.call, "enumerate")
            finally:
                await asyncio.to_thread(driver.close)

    async def configure(self, config, actor):
        if self.driver or self._busy:
            raise RuntimeError("请先断开 LBTEK，再保存连接参数")
        if self.uncertain and config != self.config:
            raise RuntimeError("旧目标运动未确认，请先连接并停止恢复，再更换连接参数")
        config = self.validate_config(config)
        temp = self.path.with_suffix(".json.tmp")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp.write_text(config.model_dump_json(indent=2), encoding="utf-8")
        temp.replace(self.path)
        self.config = config
        self.config_error = None
        self.error = None
        self.event("lbtek_config", "info", "LBTEK 配置已保存", actor)
        return self.snapshot()

    def validate_config(self, config):
        for index, model in enumerate(config.models):
            if model:
                if model not in self.catalog:
                    raise ValueError(f"官方型号表中未找到 {model}，请检查 SDK 安装")
                config.units[index] = self.catalog[model]["unit"]
        return config

    async def connect(self, actor="system"):
        self.uncertain = self.uncertain or self.recovery.exists()
        if self.config_error:
            raise RuntimeError(self.config_error + "；请在硬件连接中修正后应用")
        if self._busy or self._stopping:
            raise RuntimeError("LBTEK 正在操作，请等待或停止")
        self._busy = True
        epoch = self._epoch
        try:
            async with self._lock:
                if self.driver:
                    if self.connected:
                        return self.snapshot()
                    await asyncio.to_thread(self.driver.close)
                self.driver = SimulatedLbtek() if self.config.mode == "simulation" else self.factory(usb_port=self.config.usb_port)
                try:
                    data = await self._call("connect")
                    self._accept(data)
                    self.connected = True
                    self.error = None
                except Exception:
                    await asyncio.to_thread(self.driver.close)
                    self.driver = None
                    raise
            if epoch != self._epoch:
                raise RuntimeError("连接期间已请求停止，请检查当前状态")
            if not self._poll_task or self._poll_task.done():
                self._poll_task = asyncio.create_task(self._poll())
            self.event("lbtek_connect", "info", "LBTEK 已连接（未发送运动指令）", actor)
            return self.snapshot()
        except Exception as exc:
            self.error = str(exc)
            raise
        finally:
            self._busy = False

    def _accept(self, data):
        rows = data["channels"]
        if len(rows) != 3 or [row["channel"] for row in rows] != [1, 2, 3]:
            raise RuntimeError("LBTEK 返回的通道状态不完整")
        self.channels = rows
        for row in rows:
            model = self.config.models[row["channel"] - 1]
            metadata = self.catalog.get(model) if model else None
            row.update(model=model, home_supported=metadata["home_supported"] if metadata else self.config.mode == "simulation",
                       model_limits=metadata)
        self.sample_at = time.monotonic()
        self.hardware = {key: data.get(key) for key in ("usb_port", "axis_base", "rocker_enabled")}
        if not self.uncertain:
            for row in rows:
                if row["can_run"] and row["stopped"] and not self.active_lease:
                    self.pending.discard(row["channel"])
            self._clear_journal()

    def _fault(self, exc):
        self.connected = False
        self.error = str(exc)
        if self.pending or self.active_lease:
            self.uncertain = True
        self.active_lease = None

    async def _sample(self):
        data = await self._call("status")
        self._accept(data)

    async def _poll(self):
        try:
            while self.driver:
                await asyncio.sleep(.1 if self.pending else .5)
                if self._busy or self._stopping:
                    continue
                async with self._lock:
                    if not self.driver:
                        break
                    if self.active_lease and time.monotonic() > self.lease_deadline:
                        await self._call("stop")
                        self.active_lease = None
                        self.event("lbtek_stop", "warning", "按住移动续期超时，已发送全部停止", "system")
                    await self._sample()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fault(exc)
            self.event("lbtek_fault", "error", f"LBTEK 状态读取失败：{exc}", "system")

    def _ready(self, channel=None):
        if not self.connected or self.driver is None or self.sample_at is None or time.monotonic() - self.sample_at > 2:
            raise RuntimeError("LBTEK 未连接或状态已过期，请重新连接")
        if self.uncertain:
            raise RuntimeError("运动结果未确认，请先停止并恢复")
        if self.hardware.get("rocker_enabled"):
            raise RuntimeError("摇杆已接管，请先关闭摇杆控制")
        if channel:
            row = self.channels[channel - 1]
            if channel in self.pending or not row["can_run"] or not row["stopped"]:
                raise RuntimeError(f"CH{channel} 正在运动或等待状态确认")
            return row

    async def action(self, command: LbtekAction, actor):
        issued = False
        if self._busy or self._stopping:
            self._record(command, actor, "rejected", "其他请求正在处理，未排队")
            raise RuntimeError("其他请求正在处理，未排队")
        self._busy = True
        epoch = self._epoch
        try:
            async with self._lock:
                row = self._ready(command.channel)
                value, op = command.value, command.operation
                if row["limit_left"] and row["limit_right"]:
                    raise RuntimeError("正负限位同时触发，请检查位移台连接与型号配置")
                if op != "home" and (row["speed"] <= 0 or row["acceleration"] <= 0):
                    raise RuntimeError("速度或加速度未设置，请先在该通道应用有效参数")
                direction = value - row["position"] if op == "absolute" else value
                if op in {"relative", "absolute"} and abs(direction) > self.config.max_distance:
                    raise ValueError(f"单次位移不能超过 {self.config.max_distance:g} {self.config.units[command.channel - 1]}")
                if op != "home" and ((direction > 0 and row["limit_right"]) or (direction < 0 and row["limit_left"])):
                    raise RuntimeError("目标方向已触发限位，请向相反方向退回")
                metadata = row.get("model_limits")
                target = row["position"] + value if op == "relative" else value
                if op in {"relative", "absolute"} and metadata and not metadata["min_position"] <= target <= metadata["max_position"]:
                    raise ValueError(f"目标超出 {row['model']} 行程：{metadata['min_position']:g}–{metadata['max_position']:g} {metadata['unit']}")
                if op == "home" and not row.get("home_supported"):
                    raise RuntimeError("请先在硬件连接中记录支持回零的实际位移台型号")
                self._journal()
                if epoch != self._epoch:
                    self._clear_journal()
                    raise RuntimeError("已请求停止，本次动作未下发")
                self.pending.add(command.channel)
                issued = True
                if op == "drive":
                    self.active_lease = command.lease_id
                    self.lease_deadline = time.monotonic() + 1
                    await self._call("drive", command.channel, value, command.lease_id)
                else:
                    await self._call("action", op, command.channel, value)
                self._record(command, actor, "submitted")
                return self.snapshot()
        except Exception as exc:
            if issued:
                self.uncertain = True
                self.error = f"动作结果未确认：{exc}；请停止并恢复"
            self._record(command, actor, "unconfirmed" if issued else "rejected", str(exc))
            raise
        finally:
            self._busy = False

    async def keepalive(self, token):
        if token != self.active_lease or time.monotonic() > self.lease_deadline or self._stopping:
            raise RuntimeError("按住操作已结束，请松开后重试")
        async with self._lock:
            if token != self.active_lease or self._stopping:
                raise RuntimeError("按住操作已停止")
            await self._call("keepalive", token)
            self.lease_deadline = time.monotonic() + 1
        return self.snapshot()

    async def stop(self, actor="system", channel=None):
        self._epoch += 1
        self._stopping += 1
        if self.active_lease:
            channel = None
        self.active_lease = None
        try:
            async with self._lock:
                if self.driver is None:
                    if self.uncertain or self.pending:
                        raise RuntimeError("LBTEK 未连接，停止尚未确认；请先连接原控制器")
                    return self.snapshot()
                await self._call("stop", channel)
                data = await self._call("status")
                targets = [r for r in data["channels"] if channel is None or r["channel"] == channel]
                if not all(r["can_run"] and r["stopped"] for r in targets):
                    raise RuntimeError("停止已下发，控制器尚未确认空闲，请再次停止恢复")
                if channel is None:
                    self.uncertain = False
                    self.pending.clear()
                else:
                    self.pending.discard(channel)
                self._accept(data)
                self.connected, self.error = True, None
                self.event("lbtek_stop", "info", "LBTEK 停止已下发且状态读回空闲", actor, {"channel": channel})
                if not self._poll_task or self._poll_task.done():
                    self._poll_task = asyncio.create_task(self._poll())
                return self.snapshot()
        except Exception as exc:
            self.uncertain = True
            self.error = f"停止结果未确认：{exc}"
            self._journal()
            raise
        finally:
            self._stopping -= 1

    async def disconnect(self, actor="system"):
        self._stopping += 1
        try:
            return await self._disconnect(actor)
        finally:
            self._stopping -= 1

    async def _disconnect(self, actor):
        if self.driver:
            await self.stop(actor)
        elif self.pending or self.uncertain:
            raise RuntimeError("LBTEK 旧目标停止未确认，请先连接并停止恢复")
        self._epoch += 1
        async with self._lock:
            if self.driver:
                await asyncio.to_thread(self.driver.close)
            self.driver = None
            self.connected = False
            self.sample_at = None
        if self._poll_task and self._poll_task is not asyncio.current_task():
            self._poll_task.cancel()
            await asyncio.gather(self._poll_task, return_exceptions=True)
            self._poll_task = None
        return self.snapshot()

    async def parameters(self, values, actor):
        if self._busy or self._stopping:
            raise RuntimeError("其他请求正在处理")
        self._busy = True
        epoch = self._epoch
        try:
            async with self._lock:
                row = self._ready(values.channel)
                limits = row.get("model_limits")
                if limits and (values.speed > limits["max_speed"] or values.acceleration > limits["max_acceleration"]):
                    raise ValueError(f"{row['model']} 速度上限 {limits['max_speed']:g}，加速度上限 {limits['max_acceleration']:g}")
                if epoch != self._epoch:
                    raise RuntimeError("已请求停止，参数未下发")
                try:
                    self._accept(await self._call("parameters", values.channel, values.speed, values.acceleration))
                except Exception:
                    try:
                        await self._sample()
                    except Exception as exc:
                        self._fault(exc)
                    raise
            self.event("lbtek_parameters", "info", "LBTEK 速度/加速度已设置并读回", actor, values.model_dump())
            return self.snapshot()
        finally:
            self._busy = False

    async def rocker(self, enabled, actor):
        if self._busy or self._stopping:
            raise RuntimeError("其他请求正在处理")
        self._busy = True
        try:
            async with self._lock:
                if not self.connected or self.uncertain or self.pending or any(not r["stopped"] for r in self.channels):
                    raise RuntimeError("请先连接并确认全部通道空闲")
                await self._call("rocker", enabled)
                await self._sample()
                if self.hardware.get("rocker_enabled") != enabled:
                    raise RuntimeError("摇杆控制状态读回不一致")
                self.event("lbtek_rocker", "info", "LBTEK 摇杆控制" + ("开启" if enabled else "关闭"), actor)
                return self.snapshot()
        finally:
            self._busy = False


def install_lbtek_routes(app, controller, require_read_access, require_operator, verify_origin):
    @app.get("/api/lbtek-stage", dependencies=[Depends(require_read_access)])
    async def state():
        return controller.snapshot()

    @app.get("/api/lbtek-stage/models", dependencies=[Depends(require_read_access)])
    async def models():
        return {"models": list(controller.catalog.values())}

    @app.get("/api/lbtek-stage/devices", dependencies=[Depends(require_read_access)])
    async def devices():
        try:
            return {"ports": await controller.enumerate()}
        except Exception as exc:
            raise HTTPException(409, str(exc)) from exc

    async def run(request, fn, *args):
        verify_origin(request)
        try:
            return await fn(*args)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/lbtek-stage/connect")
    async def connect(request: Request, actor: str = Depends(require_operator)):
        return await run(request, controller.connect, actor)

    @app.post("/api/lbtek-stage/action")
    async def action(body: LbtekAction, request: Request, actor: str = Depends(require_operator)):
        return await run(request, controller.action, body, actor)

    @app.post("/api/lbtek-stage/parameters")
    async def parameters(body: LbtekParameters, request: Request, actor: str = Depends(require_operator)):
        return await run(request, controller.parameters, body, actor)

    @app.post("/api/lbtek-stage/stop")
    async def stop(body: LbtekStop, request: Request, actor: str = Depends(require_operator)):
        return await run(request, controller.stop, actor, body.channel)

    @app.post("/api/lbtek-stage/keepalive")
    async def keepalive(body: LbtekLease, request: Request, actor: str = Depends(require_operator)):
        return await run(request, controller.keepalive, body.lease_id)

    @app.post("/api/lbtek-stage/rocker")
    async def rocker(body: RockerRequest, request: Request, actor: str = Depends(require_operator)):
        return await run(request, controller.rocker, body.enabled, actor)
