"""Independent, opt-in control of the PDXC3; never shares vacuum device ports."""
from __future__ import annotations

import asyncio
import ipaddress
from pathlib import Path
from typing import Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StageError(Exception):
    pass


class StageConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["real", "simulation"] = "real"
    connection: Literal["usb", "tcp"] = "tcp"
    serial_number: str = Field(default="", pattern=r"^([0-9]{8,12})?$")
    host: str = ""
    port: int = Field(default=40303, ge=1, le=65535)
    axes: dict[str, int] = Field(default_factory=lambda: {"x": 1, "y": 2, "z": 3})
    inverted: dict[str, bool] = Field(default_factory=lambda: {"x": False, "y": False, "z": False})
    max_steps: int = Field(default=1000, ge=1, le=100000)

    @model_validator(mode="after")
    def mapping_is_permutation(self):
        if self.host:
            self.host = str(ipaddress.IPv4Address(self.host))
        if set(self.axes) != {"x", "y", "z"} or sorted(self.axes.values()) != [1, 2, 3]:
            raise ValueError("XYZ 必须分别映射到 CH1、CH2、CH3，不能重复")
        if set(self.inverted) != {"x", "y", "z"}:
            raise ValueError("每个轴必须指定方向")
        return self


class StageMove(BaseModel):
    axis: Literal["x", "y", "z"]
    steps: int = Field(ge=1, le=100000, strict=True)
    direction: Literal[-1, 1]


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

    def snapshot(self):
        return {"config": self.config.model_dump(), "connected": self.connected,
                "error": self.error, "channels": self.channels, "model": "PDXC3",
                "stage": "PD1V/M", "position_feedback": False,
                "motion_pending": self.motion_pending}

    @staticmethod
    def _idle(channels):
        return (len(channels) == 3 and {row.get("channel") for row in channels} == {1, 2, 3}
                and all(row.get("moving") is False for row in channels))

    def _move_event(self, command, actor, result, reason=""):
        channel = self.config.axes[command.axis]
        labels = {"submitted": "请求已下发", "rejected": "未下发", "unconfirmed": "结果未确认"}
        self.event("stage_move", "info" if result == "submitted" else "warning" if result == "rejected" else "error",
                   f"{command.axis.upper()} 轴移动：{labels[result]}", actor,
                   {**command.model_dump(), "channel": channel,
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
        async with self._lock:
            if self.driver is not None:
                raise StageError("请先断开位移台，再修改连接或轴映射")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".json.tmp")
            temp.write_text(config.model_dump_json(indent=2), encoding="utf-8")
            temp.replace(self.path)
            self.config = config.model_copy(deep=True)
            self.error = None
            self.channels = []
            self.motion_pending = False
            self.event("stage_config", "info", "位移台配置已保存", actor, config.model_dump())
            return self.snapshot()

    async def connect(self, actor):
        async with self._lock:
            if self.driver is not None:
                raise StageError("请先断开现有位移台连接")
            if self.config.mode == "real" and not self.config.serial_number:
                raise StageError("请先填写 PDXC3 序列号")
            if self.driver_factory:
                driver = self.driver_factory(self.config)
            elif self.config.mode == "simulation":
                driver = SimulatedStage()
            else:
                from .drivers.thorlabs_pdxc3 import Pdxc3Driver
                driver = Pdxc3Driver(self.config.serial_number, self.config.host, self.config.port,
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
            self.error = None
            self.channels = channels
            self.motion_pending = False
            self.event("stage_connect", "info", "位移台已连接", actor,
                       {"mode": self.config.mode, "serial_number": self.config.serial_number})
            self._poll_task = asyncio.create_task(self._poll())
            return self.snapshot()

    async def _poll(self):
        while True:
            await asyncio.sleep(0.5)
            if not await self._poll_once():
                return

    async def _poll_once(self):
        async with self._lock:
            if not self.connected or self.driver is None:
                return False
            try:
                self.channels = await self._call(self.driver.status)
                if self._idle(self.channels):
                    self.motion_pending = False
            except Exception as exc:
                if self._must_stop or any(row.get("moving") is True for row in self.channels):
                    try:
                        await self._call(self.driver.stop)
                    except Exception:
                        pass
                self.connected = False
                self.error = f"位移台通信中断，运动状态未知：{exc}"
                self.channels = []
                self.event("stage_fault", "error", self.error, "system")
                return False
            return True

    async def move(self, command: StageMove, actor):
        # Reserve admission before awaiting the SDK lock. A second HTTP request
        # must be rejected, never queued behind a move or stop.
        if self._move_admitting or self.motion_pending or self._stopping_count or self._disconnecting_count:
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
                    if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                        raise StageError("停止或断开已请求，本次移动未下发")
                    channel = self.config.axes[command.axis]
                    direction = command.direction * (-1 if self.config.inverted[command.axis] else 1)
                    self.channels = await self._call(self.driver.status)
                    if not self._idle(self.channels):
                        raise StageError("请等待当前移动完成或停止后再移动")
                    target = next((row for row in self.channels if row["channel"] == channel), None)
                    if target is None or target.get("ready") is not True:
                        raise StageError(f"CH{channel} 未就绪：{(target or {}).get('error') or '请核对位移台配置'}")
                    if epoch != self._stop_epoch or self._stopping_count or self._disconnecting_count:
                        raise StageError("停止或断开已请求，本次移动未下发")
                    self._must_stop = True
                    self.motion_pending = True
                    invoked = True
                    await self._call(self.driver.move, channel, direction, command.steps)
                    self._move_event(command, actor, "submitted")
                    return self.snapshot()
                except (Exception, asyncio.CancelledError) as exc:
                    if isinstance(exc, StageError) and not invoked:
                        self._move_event(command, actor, "rejected", str(exc))
                        raise
                    if invoked:
                        try:
                            await self._call(self.driver.stop)
                        except Exception:
                            pass
                    self.connected = False
                    self.channels = []
                    self.error = (f"移动未确认，勿重复发送，请先停止并重新连接：{exc}" if invoked else
                                  f"移动未下发，状态读取失败，请检查连接：{exc}")
                    self._move_event(command, actor, "unconfirmed" if invoked else "rejected", self.error)
                    self.event("stage_fault", "error", self.error, actor)
                    if isinstance(exc, asyncio.CancelledError):
                        raise
                    raise StageError(self.error) from exc
        finally:
            self._move_admitting = False

    async def stop(self, actor):
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
            except Exception as exc:
                self.connected = False
                self.channels = []
                self.motion_pending = True
                self.error = f"无法确认停止：{exc}"
                raise StageError(self.error) from exc
            self.event("stage_stop", "warning", "已发送位移台全部通道停止指令", actor,
                       {"mode": self.config.mode})
            return self.snapshot()

    async def disconnect(self, actor="system"):
        self._disconnecting_count += 1
        self._stop_epoch += 1
        try:
            return await self._disconnect_locked(actor)
        finally:
            self._disconnecting_count -= 1

    async def _disconnect_locked(self, actor):
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
                    await self._call(self.driver.close)
                except Exception as exc:
                    self.connected = False
                    self.channels = []
                    self.motion_pending = True
                    self.error = f"断开前停止未确认，请检查控制器：{exc}"
                    raise StageError(self.error) from exc
                self.driver = None
                self._must_stop = False
            self.connected = False
            self.channels = []
            self.motion_pending = False
            return self.snapshot()


class SimulatedStage:
    """Explicit simulation only; never substituted for a failed real connection."""
    def __init__(self):
        self.counts = {1: 0, 2: 0, 3: 0}

    def connect(self):
        pass

    def status(self):
        return [{"channel": n, "moving": False, "enabled": True,
                 "commanded_steps": self.counts[n], "stage": "PD1V/M", "ready": True,
                 "error": None} for n in (1, 2, 3)]

    def move(self, channel, direction, steps):
        self.counts[channel] += direction * steps

    def stop(self):
        pass

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
            return await getattr(stage, name)(actor)
        except StageError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/stage/connect")
    async def connect(request: Request, actor: str = Depends(require_operator)):
        return await action("connect", request, actor)

    @app.post("/api/stage/disconnect")
    async def disconnect(request: Request, actor: str = Depends(require_operator)):
        return await action("disconnect", request, actor)

    @app.post("/api/stage/move")
    async def move(body: StageMove, request: Request, actor: str = Depends(require_operator)):
        return await action("move", request, actor, body)

    @app.post("/api/stage/stop")
    async def stop(request: Request, actor: str = Depends(require_operator)):
        return await action("stop", request, actor)
