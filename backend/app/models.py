from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class ChannelConfig(BaseModel):
    enabled: bool = False
    label: str = ""
    trip_pa: Optional[float] = Field(default=None, gt=0)
    reset_pa: Optional[float] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def thresholds_are_ordered(self) -> "ChannelConfig":
        if self.enabled and (self.trip_pa is None or self.reset_pa is None):
            raise ValueError("启用保护的通道必须设置关阀与恢复阈值")
        if self.enabled and self.reset_pa is not None and self.trip_pa is not None:
            if self.reset_pa >= self.trip_pa:
                raise ValueError("恢复阈值必须低于关阀阈值")
        return self


class AppConfig(BaseModel):
    mode: Literal["simulation", "real"] = "simulation"
    tpg_host: str = ""
    tpg_port: int = Field(default=8000, ge=1, le=65535)
    tpg_connection: Literal["tcp", "usb"] = "tcp"
    tpg_serial_port: str = ""
    tpg_baudrate: Literal[9600, 19200, 38400, 57600, 115200] = 9600
    io_device: Literal["dam0808d", "adam6050"] = "dam0808d"
    dam_serial_port: str = ""
    dam_baudrate: Literal[2400, 4800, 9600, 19200, 38400] = 9600
    dam_unit_id: int = Field(default=1, ge=1, le=255)
    adam_host: str = ""
    adam_port: int = Field(default=502, ge=1, le=65535)
    adam_unit_id: int = Field(default=1, ge=0, le=255)
    sample_interval_s: float = Field(default=1.0, ge=0.2, le=30.0)
    stale_timeout_s: float = Field(default=1.0, ge=0.5, le=10.0)
    valve_timeout_s: float = Field(default=2.0, ge=0.5, le=20.0)
    recovery_hold_s: float = Field(default=5.0, ge=0.0, le=120.0)
    history_retention_days: Optional[int] = Field(default=None, ge=1, le=3650)
    allow_lan: bool = False
    # Position inputs must match the installed sensors; output 0 requests OPEN.
    valve_closed_di: int = Field(default=0, ge=0, le=11)
    valve_open_di: Optional[int] = Field(default=None, ge=0, le=11)
    valve_closed_active_high: bool = True
    valve_open_active_high: bool = True
    open_output: int = Field(default=0, ge=0, le=7)
    # Confirm the installed solenoid and pneumatic plumbing close on deenergizing.
    fail_closed_confirmed: bool = False
    channels: list[ChannelConfig] = Field(
        default_factory=lambda: [ChannelConfig() for _ in range(6)]
    )

    @model_validator(mode="after")
    def verify_channel_count_and_mapping(self) -> "AppConfig":
        if len(self.channels) != 6:
            raise ValueError("TPG 366 配置必须包含六个通道")
        inputs = [self.valve_closed_di, self.valve_open_di]
        used = [item for item in inputs if item is not None]
        if len(used) != len(set(used)):
            raise ValueError("打开与关闭到位传感器必须使用不同输入")
        if self.io_device == "dam0808d":
            if any(item > 7 for item in used):
                raise ValueError("DAM0808D 输入编号必须为 0 至 7")
            if (self.tpg_connection == "usb" and self.dam_serial_port.strip()
                and self.dam_serial_port.strip().casefold() == self.tpg_serial_port.strip().casefold()):
                raise ValueError("DAM 与真空规必须使用不同串口")
        elif self.open_output > 5:
            raise ValueError("ADAM6050 输出编号必须为 0 至 5")
        return self


class ConfigPatch(BaseModel):
    config: AppConfig


class ActionRequest(BaseModel):
    reason: str = Field(default="操作员请求", max_length=240)


class LoginRequest(BaseModel):
    password: str = Field(min_length=12, max_length=256)


class SampleChannel(BaseModel):
    channel: int
    label: str
    pressure_pa: Optional[float] = None
    raw_value: Optional[float] = None
    raw_unit: str = "Pa"
    status_code: Optional[int] = None
    status: str = "未连接"
    valid: bool = False
    trip_pa: Optional[float] = None
    reset_pa: Optional[float] = None


class SystemStatus(BaseModel):
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    mode: Literal["simulation", "real"] = "simulation"
    interlock: Literal["disarmed", "ready", "armed", "tripped", "fault"] = "disarmed"
    interlock_label: str = "未启用"
    trip_reason: Optional[str] = None
    valve: Literal["unknown", "open", "closed", "opening", "closing", "fault"] = "unknown"
    valve_open_sensor: bool = False
    valve_closed_sensor: bool = False
    tpg_connected: bool = False
    adam_connected: bool = False
    sample_age_s: Optional[float] = None
    sample_latency_s: Optional[float] = None
    sample_timestamp: Optional[str] = None
    sample_stale: bool = True
    io_reconnecting: bool = False
    io_reconnect_attempt: int = 0
    io_manual_reset_required: bool = False
    io_error: Optional[str] = None
    unit: str = "Pa"
    pressure_ok: bool = False
    fail_closed_confirmed: bool = False
    history_recording: bool = True
    history_error: Optional[str] = None
    channels: list[SampleChannel] = Field(default_factory=list)


class InjectPressure(BaseModel):
    channel: int = Field(ge=1, le=6)
    pressure_pa: float = Field(gt=0)


class EventRecord(BaseModel):
    id: int
    timestamp: str
    type: str
    severity: str
    message: str
    actor: str
    details: dict = Field(default_factory=dict)
