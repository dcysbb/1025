"""Independent, opt-in pressure to current output. No automatic hardware startup."""
import asyncio
import ipaddress
import json
import math
import time
from pathlib import Path
from typing import Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .drivers.zs_ao import ZsAnalogClient


class AnalogError(RuntimeError):
    pass


class AnalogMapping(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    enabled: bool = False
    label: str = Field(default="", max_length=32)
    source_channel: int = Field(default=4, ge=1, le=6, strict=True)
    pressure_4ma_pa: float | None = Field(default=None, ge=0)
    pressure_20ma_pa: float | None = Field(default=None, ge=0)
    scale: Literal["linear", "log"] = "log"
    fault_ma: float = Field(default=20, ge=4, le=20)
    offset_ma: float = Field(default=0, ge=-16, le=16, multiple_of=0.001)

    @model_validator(mode="after")
    def valid_range(self):
        a, b = self.pressure_4ma_pa, self.pressure_20ma_pa
        if self.enabled and (a is None or b is None):
            raise ValueError("启用的输出必须填写 4mA 和 20mA 对应压力")
        if a is not None and b is not None:
            if a == b:
                raise ValueError("4mA 与 20mA 对应压力不能相同")
            if self.scale == "log" and min(a, b) <= 0:
                raise ValueError("对数转换的两个压力端点必须大于 0")
        return self


class AnalogConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    mode: Literal["real", "simulation"] = "real"
    host: str = ""
    port: int = Field(default=8234, ge=1, le=65535, strict=True)
    unit_id: int = Field(default=1, ge=1, le=255, strict=True)
    register_base: Literal[0, 10] | None = None
    current_output_confirmed: bool = False
    update_interval_s: float = Field(default=0.5, ge=0.2, le=10)
    outputs: list[AnalogMapping] = Field(default_factory=lambda: [AnalogMapping() for _ in range(4)])

    @model_validator(mode="after")
    def valid_outputs(self):
        if self.host:
            self.host = str(ipaddress.IPv4Address(self.host))
        if len(self.outputs) != 4:
            raise ValueError("ZS-AO-4-RJ45 必须配置四路输出")
        return self


class ManualCurrent(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    channel: int = Field(ge=1, le=4, strict=True)
    current_ma: float = Field(ge=4, le=20, multiple_of=0.001)


class Calibration(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    channel: int = Field(ge=1, le=4, strict=True)
    offset_ma: float = Field(ge=-16, le=16, multiple_of=0.001)


def calibrated_current(mapping: AnalogMapping, target: float) -> tuple[float, bool]:
    raw = round(target * 1000) + round(mapping.offset_ma * 1000)
    bounded = max(4000, min(20000, raw))
    return bounded / 1000, raw != bounded


def pressure_current(mapping: AnalogMapping, pressure: float) -> tuple[float, bool]:
    if not math.isfinite(pressure) or pressure < 0 or mapping.scale == "log" and pressure <= 0:
        raise AnalogError("压力无效，不能转换为有效电流")
    a, b = mapping.pressure_4ma_pa, mapping.pressure_20ma_pa
    if a is None or b is None:
        raise AnalogError("压力映射尚未设置")
    if mapping.scale == "log":
        ratio = (math.log10(pressure) - math.log10(a)) / (math.log10(b) - math.log10(a))
    else:
        ratio = (pressure - a) / (b - a)
    return round(4 + 16 * max(0, min(1, ratio)), 3), not 0 <= ratio <= 1


class AnalogOutput:
    def __init__(self, root: Path, pressure_status, event, driver_factory=ZsAnalogClient):
        self.path = root / "analog-output.json"
        self.journal = root / "analog-output-recovery.json"
        self.pressure_status, self.event, self.driver_factory = pressure_status, event, driver_factory
        self.config = AnalogConfig()
        self.error = None
        try:
            if self.path.exists():
                self.config = AnalogConfig.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self.error = f"模拟量配置读取失败：{exc}"
        self.driver = None
        self.enabled = False
        self.uncertain = self.journal.exists()
        self._recovery_invalid = False
        self._manual_channels = set()
        if self.uncertain:
            try:
                record = json.loads(self.journal.read_text(encoding="utf-8"))
                self.config = AnalogConfig.model_validate(record["config"])
                channels = record.get("manual_channels", [])
                if not isinstance(channels, list) or any(type(ch) is not int or not 1 <= ch <= 4 for ch in channels):
                    raise ValueError("手动输出恢复通道无效")
                self._manual_channels = set(channels)
                self.error = "上次电流输出尚未停止确认，请恢复原模块连接后停止输出"
            except (OSError, ValueError, KeyError, TypeError):
                self._recovery_invalid = True
                self.error = "输出恢复记录损坏，无法确定原模块与通道，禁止写入电流；请核对现场接线和恢复记录"
        self.rows = []
        self._task = None
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._stopping = False

    @property
    def connected(self):
        return self.driver is not None and (self.config.mode == "simulation" or self.driver.connected)

    def snapshot(self):
        return {"config": self.config.model_dump(), "connected": self.connected,
                "enabled": self.enabled, "unconfirmed": self.uncertain,
                "manual_active": bool(self._manual_channels), "manual_channels": sorted(self._manual_channels),
                "error": self.error, "outputs": self.rows}

    def _save(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    async def configure(self, config, actor):
        async with self._lock:
            if self.enabled or self.uncertain or self._manual_channels or self._stopping:
                raise AnalogError("请先停止输出并确认故障电流已写入，再修改配置")
            if self.driver and any(getattr(config, key) != getattr(self.config, key) for key in ("mode", "host", "port", "unit_id", "register_base")):
                raise AnalogError("请先断开模拟量模块，再修改连接参数")
            self._save(self.path, config.model_dump())
            self.config = config
            self.error = None
            self.rows = []
            self.event("analog_config", "info", "模拟量连接与压力映射已保存，输出未启用", actor)
            return self.snapshot()

    async def connect(self, actor):
        async with self._lock:
            if self.driver:
                if self.connected:
                    return self.snapshot()
                await self.driver.close()
                self.driver = None
            if self.config.mode == "simulation":
                self.driver = object()
            else:
                if not self.config.host:
                    raise AnalogError("请设置 ZS-AO 模块 IPv4 地址")
                candidate = self.driver_factory(self.config.host, self.config.port, self.config.unit_id, timeout_s=0.8)
                try:
                    await candidate.identify()
                    if self.config.register_base is not None:
                        values = await candidate.read_registers(self.config.register_base, 4)
                        self.rows = [{"channel": i + 1, "current_ma": value / 1000,
                                      "status": "寄存器设定值，非实测电流"} for i, value in enumerate(values)]
                except Exception as exc:
                    await candidate.close()
                    raise AnalogError(f"ZS-AO 连接失败：{exc}") from exc
                self.driver = candidate
            if not self._recovery_invalid:
                self.error = "上次输出未确认，请先停止输出并写入故障电流" if self.uncertain else None
            self.event("analog_connect", "info", "模拟量模块已连接，连接过程未写入电流", actor)
            return self.snapshot()

    async def calibrate(self, body: Calibration, actor):
        async with self._lock:
            if self.enabled or self.uncertain or self._manual_channels or self._stopping:
                raise AnalogError("请先停止模拟量输出，再保存校准偏移")
            config = self.config.model_copy(deep=True)
            config.outputs[body.channel - 1].offset_ma = body.offset_ma
            self._save(self.path, config.model_dump())
            self.config = config
            self.error = None
            self.event("analog_calibration", "info", f"AO{body.channel} 电流偏移已保存为 {body.offset_ma:+.3f}mA，下次下发生效", actor)
            return self.snapshot()

    async def enable(self, actor):
        async with self._lock:
            if self._manual_channels or self._stopping:
                raise AnalogError("请先停止手动输出，再开始实时压力输出")
            if not self.connected or self.enabled or self.uncertain:
                raise AnalogError("请先连接模块，并处理上次输出未确认状态")
            if self.config.register_base is None:
                raise AnalogError("厂家寄存器表与示例不一致，请先核对并设置起始地址")
            if not self.config.current_output_confirmed:
                raise AnalogError("请确认现场模块为 4–20mA 电流输出型号及接线")
            if not any(row.enabled for row in self.config.outputs):
                raise AnalogError("请至少启用一路压力映射")
            if self.config.mode == "real" and self.pressure_status()["mode"] != "real":
                raise AnalogError("真实模拟量模块不能输出模拟压力，请先切换真实压力采集")
            self._save(self.journal, {"config": self.config.model_dump(), "reason": "输出已启用，尚未停止确认"})
            self.enabled = True
            self._wake.clear()
            self.error = None
            self._task = asyncio.create_task(self._run())
            self.event("analog_enable", "warning", "已启用实时压力电流输出", actor)
            return self.snapshot()

    async def manual(self, body: ManualCurrent, actor):
        if self._stopping:
            raise AnalogError("停止输出正在处理，请等待确认")
        async with self._lock:
            if self._recovery_invalid or self.uncertain:
                raise AnalogError(self.error or "上次电流输出未确认，请先恢复连接并停止输出")
            if self._stopping:
                raise AnalogError("停止输出正在处理，请等待确认")
            if self.enabled:
                raise AnalogError("请先停止压力跟随，再手动调节电流")
            if not self.connected:
                raise AnalogError("模拟量模块未连接，请先在硬件连接中连接模块")
            if self.config.register_base is None or not self.config.current_output_confirmed:
                raise AnalogError("请先在硬件连接中核对输出寄存器与 4–20mA 型号及接线")
            channels = self._manual_channels | {body.channel}
            self._save(self.journal, {"config": self.config.model_dump(), "manual_channels": sorted(channels),
                                      "reason": "手动电流输出尚未停止确认"})
            self._manual_channels = channels
            try:
                written = await self._write(body.channel, body.current_ma)
            except Exception as exc:
                self.uncertain = True
                self.error = f"AO{body.channel} 手动输出未确认：{exc}；请检查连接后停止输出，勿重复下发。"
                self.event("analog_fault", "error", self.error, actor)
                raise AnalogError(self.error) from exc
            self.error = None
            self.rows = [row for row in self.rows if row["channel"] != body.channel] + [
                {"channel": body.channel, **written,
                 "status": "手动设定，写入应答已确认" + ("；校准补偿已限幅" if written["calibration_limited"] else ""), "updated_at": time.time()}]
            self.rows.sort(key=lambda row: row["channel"])
            self.event("analog_manual", "warning", f"AO{body.channel} 目标 {body.current_ma:.3f}mA，偏移 {written['offset_ma']:+.3f}mA，下发 {written['current_ma']:.3f}mA，写入应答已确认", actor)
            return self.snapshot()

    async def _write(self, channel, current):
        offset = self.config.outputs[channel - 1].offset_ma
        command, limited = calibrated_current(self.config.outputs[channel - 1], current)
        if self.config.mode == "real":
            await self.driver.write_current(self.config.register_base + channel - 1, command)
        return {"target_ma": current, "offset_ma": offset, "current_ma": command, "calibration_limited": limited}

    async def update_once(self):
        rows = []
        for i, mapping in enumerate(self.config.outputs):
            if not mapping.enabled:
                continue
            sample = self.pressure_status()
            source = next((row for row in sample.get("channels", []) if row.get("channel") == mapping.source_channel), {})
            valid = not sample.get("sample_stale", True) and sample.get("tpg_connected") and source.get("valid")
            value = source.get("pressure_pa")
            if self.config.mode == "real" and sample.get("mode") != "real":
                valid = False
            status = "压力映射"
            current = mapping.fault_ma
            if valid and isinstance(value, (int, float)):
                try:
                    current, clipped = pressure_current(mapping, value)
                    if clipped:
                        status = "压力超出映射范围，已限幅"
                except AnalogError:
                    valid = False
            else:
                valid = False
            if not valid:
                status = "压力失效，输出故障电流"
            written = await self._write(i + 1, current)
            rows.append({"channel": i + 1, **written, "pressure_pa": value if valid else None,
                         "status": status + ("；校准补偿已限幅" if written["calibration_limited"] else ""), "updated_at": time.time()})
        self.rows = rows

    async def _run(self):
        try:
            while self.enabled:
                async with self._lock:
                    if self.enabled:
                        await self.update_once()
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=self.config.update_interval_s)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            self.enabled = False
            self.uncertain = True
            self.error = f"电流输出未确认：{exc}；模块可能保持断开前电流，请恢复通信后停止输出。"
            self.event("analog_fault", "error", self.error, "system")

    async def stop(self, actor):
        if self._stopping:
            raise AnalogError("停止输出正在处理，请勿重复提交")
        self._stopping = True
        try:
            return await self._stop(actor)
        finally:
            self._stopping = False

    async def _stop(self, actor):
        self.enabled = False
        self._wake.set()
        if self._task:
            await self._task
            self._task = None
        async with self._lock:
            if self._recovery_invalid:
                raise AnalogError(self.error)
            if not self.journal.exists() and not self.uncertain:
                return self.snapshot()
            if not self.connected:
                raise AnalogError("模块离线，不能确认故障电流已写入；请先恢复连接")
            affected = self._manual_channels or {i + 1 for i, row in enumerate(self.config.outputs) if row.enabled}
            stopped_rows = []
            try:
                for i, row in enumerate(self.config.outputs):
                    if i + 1 in affected:
                        written = await self._write(i + 1, row.fault_ma)
                        stopped_rows.append({"channel": i + 1, **written, "status": "已写入故障电流，输出已停止" + ("；校准补偿已限幅" if written["calibration_limited"] else "")})
                self.journal.unlink(missing_ok=True)
            except Exception as exc:
                self.uncertain = True
                self.error = f"停止输出未确认：{exc}"
                raise AnalogError(self.error) from exc
            self.rows = stopped_rows
            self._manual_channels.clear()
            self.uncertain = False
            self.error = None
            self.event("analog_stop", "warning", "已停止实时输出并写入配置的故障电流", actor)
            return self.snapshot()

    async def disconnect(self, actor="system"):
        await self.stop(actor)
        async with self._lock:
            if self.driver and self.config.mode == "real":
                await self.driver.close()
            self.driver = None
            return self.snapshot()


def install_analog_routes(app, controller, require_read_access, require_operator, verify_origin):
    @app.get("/api/analog-output", dependencies=[Depends(require_read_access)])
    async def status():
        return controller.snapshot()

    @app.put("/api/analog-output/config")
    async def configure(body: AnalogConfig, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await controller.configure(body, actor)
        except (AnalogError, OSError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/debug/analog-output")
    async def manual(body: ManualCurrent, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await controller.manual(body, actor)
        except (AnalogError, OSError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.patch("/api/analog-output/calibration")
    async def calibrate(body: Calibration, request: Request, actor: str = Depends(require_operator)):
        verify_origin(request)
        try:
            return await controller.calibrate(body, actor)
        except (AnalogError, OSError) as exc:
            raise HTTPException(409, str(exc)) from exc

    for name in ("connect", "enable", "stop", "disconnect"):
        def handler(operation):
            async def call(request: Request, actor: str = Depends(require_operator)):
                verify_origin(request)
                try:
                    return await getattr(controller, operation)(actor)
                except (AnalogError, OSError) as exc:
                    raise HTTPException(409, str(exc)) from exc
            return call
        app.add_api_route(f"/api/analog-output/{name}", handler(name), methods=["POST"])
