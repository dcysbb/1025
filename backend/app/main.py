from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import os
import secrets
import sqlite3
import sys
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .configuration import ConfigurationStore, data_directory
from .engine import InterlockEngine, InterlockError
from .drivers.tpg366 import TPG366Error
from .drivers.adam6050 import ModbusError
from .models import ActionRequest, AppConfig, ConfigPatch, ConfigUpdate, InjectPressure, LoginRequest
from .storage import HistoryStore
from .stage import StageController, StageError, install_stage_routes


DATA_DIR = data_directory()
CONFIG = ConfigurationStore(DATA_DIR)
HISTORY = HistoryStore(DATA_DIR / "history.sqlite3")
ENGINE = InterlockEngine(CONFIG, HISTORY)
STAGE = StageController(DATA_DIR, ENGINE._event)
SESSIONS: dict[str, float] = {}
LOGIN_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)
SESSION_COOKIE = "vacuum_interlock_session"
_bundle_root = getattr(sys, "_MEIPASS", None)
FRONTEND_DIST = (
    Path(_bundle_root) / "frontend" / "dist"
    if _bundle_root
    else Path(__file__).resolve().parents[2] / "frontend" / "dist"
)


class SimulationFault(BaseModel):
    kind: str = Field(pattern="^(io|sensor|gauge|close|tpg)$")
    enabled: bool
    channel: int = Field(default=1, ge=1, le=6)


class HistoryReset(BaseModel):
    scope: Literal["simulation", "all"] = "simulation"


class DebugRelayRequest(BaseModel):
    enabled: bool
    duration_s: float = Field(default=0, ge=0, le=60)


def is_local(request: Request) -> bool:
    if request.client is None:
        return False
    try:
        return ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        return False


def has_session(request: Request) -> bool:
    token = request.cookies.get(SESSION_COOKIE)
    expiry = SESSIONS.get(token or "")
    if expiry is None:
        return False
    if expiry < time.monotonic():
        SESSIONS.pop(token or "", None)
        return False
    return True


def require_read_access(request: Request) -> None:
    if not is_local(request) and not has_session(request):
        raise HTTPException(401, "请登录后查看设备数据")


def require_operator(request: Request) -> str:
    if is_local(request):
        return "local_operator"
    if not has_session(request):
        raise HTTPException(401, "此操作需要操作员登录")
    # Only one configured operator is supported in v1; commands remain auditable.
    return "operator"


def verify_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        raise HTTPException(403, "写操作缺少浏览器 Origin 校验")
    host = request.headers.get("host", "")
    if origin not in (f"http://{host}", f"https://{host}"):
        raise HTTPException(403, "跨站写入请求已拒绝")


def encode_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${derived.hex()}"


def password_matches(password: str, encoded: Optional[str]) -> bool:
    if not encoded:
        return False
    try:
        scheme, salt_hex, digest_hex = encoded.split("$", 2)
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def set_session(response: Response, token: str, request: Request) -> None:
    SESSIONS[token] = time.monotonic() + 8 * 60 * 60
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=8 * 60 * 60,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        path="/",
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    await ENGINE.start()
    yield
    try:
        await STAGE.disconnect()
    except StageError:
        pass  # Fault is retained in the stage status; vacuum shutdown still runs.
    await ENGINE.stop()
    HISTORY.close()


app = FastAPI(
    title="真空联锁控制台",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)

install_stage_routes(app, STAGE, require_read_access, require_operator, verify_origin)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.get("/api/health")
async def health():
    return {"ok": True, "version": "0.1.0"}


@app.get("/api/auth/status")
async def auth_status(request: Request):
    return {"configured": CONFIG.password_hash is not None,
            "authenticated": is_local(request) or has_session(request), "local": is_local(request)}


@app.post("/api/auth/setup")
async def auth_setup(body: LoginRequest, request: Request, response: Response):
    verify_origin(request)
    if not is_local(request):
        raise HTTPException(403, "首次设置必须在运行设备上操作")
    if CONFIG.password_hash is not None:
        raise HTTPException(409, "操作员密码已经设置")
    CONFIG.set_password_hash(encode_password(body.password))
    token = secrets.token_urlsafe(32)
    set_session(response, token, request)
    ENGINE._event("operator_setup", "warning", "本机首次设置操作员密码", "operator")
    return {"authenticated": True}


@app.post("/api/auth/login")
async def auth_login(body: LoginRequest, request: Request, response: Response):
    verify_origin(request)
    now = time.monotonic()
    key = request.client.host if request.client else "unknown"
    attempts = LOGIN_ATTEMPTS[key]
    while attempts and now - attempts[0] > 60:
        attempts.popleft()
    if len(attempts) >= 8:
        raise HTTPException(429, "登录尝试过多，请一分钟后重试")
    if not password_matches(body.password, CONFIG.password_hash):
        attempts.append(now)
        raise HTTPException(401, "密码不正确")
    attempts.clear()
    token = secrets.token_urlsafe(32)
    set_session(response, token, request)
    return {"authenticated": True}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    verify_origin(request)
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        SESSIONS.pop(token, None)
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="strict")
    return {"authenticated": False}


@app.get("/api/status", dependencies=[Depends(require_read_access)])
async def get_status():
    return ENGINE.snapshot()


@app.get("/api/config", dependencies=[Depends(require_read_access)])
async def get_config():
    config = ENGINE.config.model_dump(mode="json")
    return {"config": config, "version": CONFIG.version, "restart_required": False}


@app.put("/api/config")
async def put_config(body: ConfigPatch, request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    previous = ENGINE.config
    try:
        await ENGINE.apply_config(body.config, actor)
    except (ValueError, InterlockError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {
        "config": ENGINE.config.model_dump(mode="json"),
        "version": CONFIG.version,
        "restart_required": previous.allow_lan != ENGINE.config.allow_lan,
    }


@app.patch("/api/config")
async def patch_config(body: ConfigUpdate, request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    previous = ENGINE.config
    try:
        await ENGINE.patch_config(body.config, actor)
    except (ValueError, InterlockError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"config": ENGINE.config.model_dump(mode="json"), "version": CONFIG.version,
            "restart_required": previous.allow_lan != ENGINE.config.allow_lan}


@app.get("/api/hardware/ports", dependencies=[Depends(require_read_access)])
async def hardware_ports():
    from serial.tools import list_ports
    ports = await asyncio.to_thread(list_ports.comports)
    return {"ports": [{"device": p.device, "description": p.description,
                       "serial_number": p.serial_number} for p in ports]}


@app.get("/api/hardware/status", dependencies=[Depends(require_read_access)])
async def hardware_status():
    fresh = ENGINE._adam_connected and time.monotonic() - ENGINE._last_io_read <= ENGINE.config.stale_timeout_s
    inputs = list(ENGINE._io_inputs)
    outputs = list(ENGINE._io_outputs)
    if ENGINE.mode == "simulation":
        status = ENGINE.snapshot()
        fresh = status["adam_connected"]
        inputs[ENGINE.config.valve_closed_di] = (status["valve_closed_sensor"] == ENGINE.config.valve_closed_active_high)
        if ENGINE.config.valve_open_di is not None:
            inputs[ENGINE.config.valve_open_di] = (status["valve_open_sensor"] == ENGINE.config.valve_open_active_high)
        outputs = list(ENGINE._debug_sim_outputs)
        outputs[ENGINE.config.open_output] = ENGINE._open_output
    return {"tpg": {"connected": ENGINE._tpg_connected, "error": getattr(ENGINE, "_tpg_error", None)},
            "io": {"connected": ENGINE._adam_connected, "error": ENGINE._io_error,
                   "inputs": inputs if fresh else None,
                   "outputs": outputs if fresh else None,
                   "manual_reset_required": ENGINE._io_manual_reset_required}}


@app.post("/api/devices/connect-io")
async def connect_io(request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    result = await ENGINE.connect_io()
    ENGINE._event("io_connect", "info" if result["ok"] else "error", "连接 I/O 控制器", actor, result)
    if not result["ok"]:
        raise HTTPException(409, result.get("error", "I/O 连接失败"))
    return ENGINE.snapshot()


@app.get("/api/debug/relays")
async def debug_relays(actor: str = Depends(require_operator)):
    try:
        return await ENGINE.debug_relays()
    except (InterlockError, ModbusError, OSError) as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/debug/relays/{channel}")
async def debug_set_relay(channel: int, body: DebugRelayRequest, request: Request,
                          actor: str = Depends(require_operator)):
    verify_origin(request)
    try:
        return await ENGINE.debug_set_relay(channel, body.enabled, body.duration_s, actor)
    except (InterlockError, ModbusError, OSError) as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/devices/connect")
async def connect_devices(request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    result = await ENGINE.connect_devices()
    ENGINE._event("device_connect", "info" if result["ok"] else "error", "手动连接设备", actor, result)
    return result


@app.post("/api/devices/connect-gauge")
async def connect_gauge(request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    result = await ENGINE.connect_gauge()
    if not result["ok"]:
        raise HTTPException(409, result.get("error", "真空规连接失败"))
    ENGINE._event("gauge_connect", "info", "仅连接真空规", actor, result)
    return ENGINE.snapshot()


async def action_call(action: str, actor: str):
    try:
        if action == "arm":
            await ENGINE.arm(actor)
        elif action == "disarm":
            await ENGINE.disarm(actor)
        elif action == "reset":
            await ENGINE.reset(actor)
        elif action == "open":
            await ENGINE.open_valve(actor)
        elif action == "close":
            await ENGINE.close_valve(actor)
        else:
            raise InterlockError("未知操作")
    except InterlockError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ModbusError, OSError) as exc:
        ENGINE._begin_io_recovery(str(exc))
        raise HTTPException(409, f"控制未完成，I/O 通信故障：{exc}") from exc
    return ENGINE.snapshot()


@app.post("/api/interlock/arm")
async def arm_interlock(request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    return await action_call("arm", actor)


@app.post("/api/interlock/disarm")
async def disarm_interlock(request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    return await action_call("disarm", actor)


@app.post("/api/interlock/reset")
async def reset_interlock(request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    return await action_call("reset", actor)


@app.post("/api/interlock/clear-fault")
async def clear_fault(request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    try:
        await ENGINE.clear_fault(actor)
    except InterlockError as exc:
        raise HTTPException(409, str(exc)) from exc
    return ENGINE.snapshot()


@app.post("/api/valve/open")
async def open_valve(request: Request, body: Optional[ActionRequest] = None, actor: str = Depends(require_operator)):
    verify_origin(request)
    return await action_call("open", actor)


@app.post("/api/valve/close")
async def close_valve(request: Request, body: Optional[ActionRequest] = None, actor: str = Depends(require_operator)):
    verify_origin(request)
    return await action_call("close", actor)


@app.post("/api/simulation/pressure")
async def simulation_pressure(body: InjectPressure, request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    try:
        await ENGINE.inject_pressure(body.channel, body.pressure_pa)
    except InterlockError as exc:
        raise HTTPException(409, str(exc)) from exc
    ENGINE._event("simulation_pressure", "warning", "模拟真空压力改变", actor, body.model_dump())
    return ENGINE.snapshot()


@app.post("/api/simulation/fault")
async def simulation_fault(body: SimulationFault, request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    if ENGINE.mode != "simulation":
        raise HTTPException(409, "只能在模拟模式注入故障")
    if body.kind == "io":
        await ENGINE.inject_io_fault(body.enabled)
    elif body.kind == "gauge":
        ENGINE._sim_gauge_status[body.channel - 1] = 3 if body.enabled else 0
    elif body.kind == "sensor":
        ENGINE._sim_sensor_conflict = body.enabled
    elif body.kind == "close":
        ENGINE._sim_close_failure = body.enabled
    elif body.kind == "tpg":
        ENGINE._sim_tpg_fault = body.enabled
    ENGINE._event("simulation_fault", "warning", f"模拟故障：{body.kind}", actor, body.model_dump())
    ENGINE._publish()
    return ENGINE.snapshot()


def parse_channels(raw: str) -> list[int]:
    try:
        parts = [item.strip() for item in raw.split(",") if item.strip()]
        if not parts:
            raise ValueError("empty selection")
        values = sorted(set(int(item) for item in parts))
    except ValueError as exc:
        raise HTTPException(422, "通道必须是逗号分隔的 1 至 6") from exc
    if any(value < 1 or value > 6 for value in values):
        raise HTTPException(422, "通道必须是 1 至 6")
    return values


@app.get("/api/history", dependencies=[Depends(require_read_access)])
async def get_history(
    start: str = Query(...),
    end: str = Query(...),
    channels: str = Query(default="1,2,3,4,5,6"),
    limit: int = Query(default=10000, ge=1, le=249999),
):
    try:
        start_dt, end_dt = datetime.fromisoformat(start.replace("Z", "+00:00")), datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(422, "时间必须是 ISO-8601 格式") from exc
    if start_dt.tzinfo is None or end_dt.tzinfo is None or end_dt <= start_dt:
        raise HTTPException(422, "结束时间必须晚于带时区的开始时间")
    fetched = HISTORY.history(
        start_dt.astimezone(timezone.utc).isoformat(),
        end_dt.astimezone(timezone.utc).isoformat(),
        parse_channels(channels), limit + 1,
    )
    return {"rows": fetched[:limit], "count": min(len(fetched), limit), "truncated": len(fetched) > limit}


@app.post("/api/history/reset")
async def reset_history(body: HistoryReset, request: Request, actor: str = Depends(require_operator)):
    verify_origin(request)
    try:
        deleted = HISTORY.reset_history(body.scope, actor)
    except sqlite3.Error as exc:
        raise HTTPException(503, "历史重置失败，请检查存储状态") from exc
    return {"ok": True, "scope": body.scope, "deleted": deleted}


@app.get("/api/events", dependencies=[Depends(require_read_access)])
async def get_events(
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    kind: Optional[str] = Query(default=None, max_length=100),
    severity: Optional[str] = Query(default=None, pattern="^(info|warning|error|critical)$"),
):
    def normalized(value):
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("missing timezone")
            return parsed.astimezone(timezone.utc).isoformat()
        except ValueError as exc:
            raise HTTPException(422, "日志时间必须是带时区的 ISO-8601 格式") from exc
    start, end = normalized(start), normalized(end)
    if start and end and end <= start:
        raise HTTPException(422, "日志结束时间必须晚于开始时间")
    fetched = HISTORY.list_events(start, end, limit + 1, offset, kind, severity)
    return {"events": fetched[:limit], "has_more": len(fetched) > limit}


@app.get("/api/history/export.csv", dependencies=[Depends(require_read_access)])
async def export_history(
    start: str = Query(...),
    end: str = Query(...),
    channels: str = Query(default="1,2,3,4,5,6"),
    unit: str = Query(default="mbar", pattern="^(Pa|mbar|Torr)$"),
):
    try:
        start_dt, end_dt = datetime.fromisoformat(start.replace("Z", "+00:00")), datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(422, "时间必须是 ISO-8601 格式") from exc
    if start_dt.tzinfo is None or end_dt.tzinfo is None or end_dt <= start_dt:
        raise HTTPException(422, "结束时间必须晚于带时区的开始时间")
    rows = HISTORY.iter_history(
        start_dt.astimezone(timezone.utc).isoformat(),
        end_dt.astimezone(timezone.utc).isoformat(),
        parse_channels(channels),
    )
    filename = f"vacuum-history-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.csv"
    return StreamingResponse(
        HISTORY.csv_chunks(rows, unit),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.websocket("/ws/status")
async def websocket_status(websocket: WebSocket):
    local = False
    if websocket.client:
        try:
            local = ipaddress.ip_address(websocket.client.host).is_loopback
        except ValueError:
            pass
    token = websocket.cookies.get(SESSION_COOKIE)
    if not local and not (token and SESSIONS.get(token, 0) >= time.monotonic()):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    queue = await ENGINE.subscribe()
    try:
        while True:
            payload = await asyncio.wait_for(queue.get(), timeout=5.0)
            await websocket.send_json(payload)
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    finally:
        ENGINE.unsubscribe(queue)


@app.get("/{asset_path:path}")
async def frontend(asset_path: str):
    if not FRONTEND_DIST.exists():
        return {"message": "前端开发中。请在 frontend 运行 npm run dev。"}
    target = (FRONTEND_DIST / asset_path).resolve()
    try:
        target.relative_to(FRONTEND_DIST.resolve())
    except ValueError:
        raise HTTPException(404, "Not found")
    if target.is_file():
        return FileResponse(target)
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(404, "Not found")


def _local_tls_paths() -> tuple[Optional[str], Optional[str]]:
    # LAN mode needs HTTPS so operator credentials and control cookies do not
    # traverse the laboratory network in clear text.
    from .tls import ensure_certificate

    certificate, key = ensure_certificate(DATA_DIR)
    return str(certificate), str(key)


def run() -> None:
    import uvicorn

    config = CONFIG.get_config()
    port = int(os.environ.get("VACUUM_INTERLOCK_PORT", "8770"))
    if not 1 <= port <= 65535:
        raise ValueError("VACUUM_INTERLOCK_PORT must be between 1 and 65535")
    options = {"host": "0.0.0.0" if config.allow_lan else "127.0.0.1", "port": port, "log_level": "info"}
    if config.allow_lan:
        cert, key = _local_tls_paths()
        options.update(ssl_certfile=cert, ssl_keyfile=key)
    uvicorn.run("app.main:app", **options)


if __name__ == "__main__":
    run()
