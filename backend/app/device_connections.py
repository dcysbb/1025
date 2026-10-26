"""Device-scoped apply/connect operations; every stop revokes later phases."""
import asyncio
from typing import Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, ValidationError

from .models import AppConfig
from .stage import StageConfig
from .analog_output import AnalogConfig


Device = Literal["tpg", "io", "stage", "analog"]
FIELDS = {
    "tpg": {"tpg_connection", "tpg_serial_port", "tpg_baudrate", "tpg_host", "tpg_port"},
    "io": {"io_device", "dam_serial_port", "dam_baudrate", "dam_unit_id", "adam_host", "adam_port", "adam_unit_id"},
    "stage": {"mode", "connection", "serial_number", "host", "port", "axes", "inverted", "home_direction", "max_steps"},
    "analog": {"mode", "host", "port", "unit_id", "register_base"},
}


class ConnectionChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config: dict


class DeviceConnections:
    def __init__(self, engine, stage, analog):
        self.engine, self.stage, self.analog = engine, stage, analog
        self.pending = {}

    def cancel(self, device):
        if device in self.pending:
            self.pending[device].set()

    def busy_for(self, path):
        if path.startswith("/api/stage"):
            return "stage" in self.pending
        if path.startswith("/api/analog-output") or path == "/api/debug/analog-output":
            return "analog" in self.pending
        if path == "/api/config" or path.startswith(("/api/devices/", "/api/interlock/", "/api/valve/", "/api/debug/relays/")):
            return any(device in self.pending for device in ("tpg", "io"))
        return False

    def snapshot(self, device):
        return (self.stage if device == "stage" else self.analog if device == "analog" else self.engine).snapshot()

    def validate(self, device, changes):
        if set(changes) - FIELDS[device]:
            raise ValueError("此设备不支持修改字段：" + ", ".join(sorted(set(changes) - FIELDS[device])))
        if device in ("tpg", "io"):
            return AppConfig.model_validate({**self.engine.config.model_dump(), **changes})
        controller, model = (self.stage, StageConfig) if device == "stage" else (self.analog, AnalogConfig)
        return model.model_validate({**controller.config.model_dump(), **changes})

    async def stop(self, device, actor):
        self.cancel(device)
        if device == "stage":
            return await self.stage.stop(actor)
        if device == "analog":
            return await self.analog.stop(actor)
        await self.engine.close_valve(actor)
        return self.engine.snapshot()

    async def disconnect(self, device, actor):
        self.cancel(device)
        if device in ("stage", "analog"):
            return await (self.stage if device == "stage" else self.analog).disconnect(actor)
        engine = self.engine
        async with engine._lock:
            if engine.interlock == "armed":
                await engine.trip("设备断开，联锁保持锁存关闭", kind="device_disconnect")
            await engine.close_valve(actor)
            if engine._off_retry_pending:
                raise RuntimeError("旧输出关阀请求未确认，无法断开")
            lock = engine._gauge_lock if device == "tpg" else engine._io_lock
            async with lock:
                driver = engine.tpg if device == "tpg" else engine.adam
                if driver:
                    await driver.close()
                if device == "tpg":
                    engine.tpg = None
                    engine._tpg_connected = False
                    engine._gauge_config_pending = True
                else:
                    engine.adam = None
                    engine._adam_connected = False
                    engine._io_config_pending = True
            engine._refresh_status()
            engine._publish()
            return engine.snapshot()

    async def apply(self, device, changes, actor):
        self.validate(device, changes)
        if device in self.pending or device in ("tpg", "io") and any(key in self.pending for key in ("tpg", "io")):
            raise RuntimeError("设备连接正在应用，请等待或停止本次操作")
        cancelled = asyncio.Event()
        self.pending[device] = cancelled
        phase, saved = "stop", False

        def checkpoint():
            if cancelled.is_set():
                raise RuntimeError("操作已停止，后续连接已取消")

        try:
            if device in ("tpg", "io"):
                engine = self.engine
                async with engine._lock:
                    if engine.interlock == "armed":
                        await engine.trip("设备重新连接，联锁保持锁存关闭", kind="device_reconnect")
                    await engine.close_valve(actor)
                    if engine._off_retry_pending:
                        raise RuntimeError("旧输出关阀请求未确认，连接参数未修改")
                    checkpoint()
                    phase = "disconnect"
                    lock = engine._gauge_lock if device == "tpg" else engine._io_lock
                    async with lock:
                        driver = engine.tpg if device == "tpg" else engine.adam
                        if driver:
                            await driver.close()
                        if device == "tpg":
                            engine.tpg = None
                            engine._tpg_connected = False
                            engine._gauge_config_pending = True
                        else:
                            engine.adam = None
                            engine._adam_connected = False
                            engine._io_config_pending = True
                    checkpoint()
                    phase = "save"
                    candidate = self.validate(device, changes)
                    engine.config_store.update(candidate)
                    engine.config = candidate
                    engine._event("device_config", "info", f"{device} 连接参数已保存", actor, {"device": device, "changes": changes})
                    saved = True
                    checkpoint()
                    phase = "connect"
                    result = await (engine.connect_gauge() if device == "tpg" else engine.connect_io())
                    if not result["ok"]:
                        raise RuntimeError(result.get("error", "连接失败"))
            else:
                controller = self.stage if device == "stage" else self.analog
                if device == "stage" and controller._uncertain and controller.driver is None:
                    await controller.recover(False, actor)
                if device == "stage" and controller.driver is not None:
                    await controller.stop(actor)
                    if controller.motion_pending:
                        raise RuntimeError("停止后运动状态未确认，连接参数未修改")
                elif device == "analog":
                    await controller.stop(actor)
                checkpoint()
                phase = "disconnect"
                await controller.disconnect(actor)
                checkpoint()
                phase = "save"
                await controller.configure(self.validate(device, changes), actor)
                saved = True
                checkpoint()
                phase = "connect"
                await controller.connect(actor)
            checkpoint()
            state = self.snapshot(device)
            connected = state.get("connected", state.get("tpg_connected" if device == "tpg" else "adam_connected", False))
            if not connected:
                raise RuntimeError("连接后设备未报告在线状态")
            return {"ok": True, "device": device, "config_saved": saved, "connected": True, "phase": "complete", "error": None, "state": state}
        except Exception as exc:
            state = self.snapshot(device)
            connected = state.get("connected", state.get("tpg_connected" if device == "tpg" else "adam_connected", False))
            self.engine._event("device_connect_failed", "error", f"{device} 应用连接失败：{exc}", actor, {"phase": phase, "config_saved": saved})
            return {"ok": False, "device": device, "config_saved": saved, "connected": connected, "phase": phase, "error": str(exc), "state": state}
        finally:
            self.pending.pop(device, None)


def install_connection_routes(app, connections, require_operator, verify_origin):
    @app.post("/api/devices/{device}/apply-connect")
    async def apply(device: Device, body: ConnectionChange, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await connections.apply(device, body.config, actor)
        except ValidationError as exc:
            raise HTTPException(422, exc.errors(include_url=False, include_context=False, include_input=False)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/devices/{device}/cancel")
    async def cancel(device: Device, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await connections.stop(device, actor)
        except Exception as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/devices/{device}/disconnect")
    async def disconnect(device: Device, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await connections.disconnect(device, actor)
        except Exception as exc:
            raise HTTPException(409, str(exc)) from exc
