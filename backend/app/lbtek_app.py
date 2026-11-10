"""Local LBTEK-only entry; never constructs or starts vacuum/I/O/AO services."""
import ipaddress
from contextlib import asynccontextmanager
from pathlib import Path
import sys

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from .configuration import data_directory
from .device_connections import DeviceConnections, install_connection_routes
from .lbtek_stage import LbtekController, install_lbtek_routes
from .storage import HistoryStore


def create_lbtek_app(root=None, frontend=None):
    root = Path(root) if root else data_directory()
    history = HistoryStore(root / "history.sqlite3")

    class Audit:
        def _event(self, kind, severity, message, actor, details=None):
            history.write_event(kind, severity, message, actor, details)

    controller = LbtekController(root, Audit()._event)
    connections = DeviceConnections(Audit(), None, None, controller)

    def local(request: Request):
        if request.client is None or not ipaddress.ip_address(request.client.host).is_loopback:
            raise HTTPException(403, "独立 LBTEK 面板仅允许本机访问")
        return "local_operator"

    def origin(request):
        if request.headers.get("origin") != f"http://{request.headers.get('host')}":
            raise HTTPException(403, "跨站请求或缺少 Origin，操作已拒绝")

    @asynccontextmanager
    async def lifespan(_):
        yield
        try:
            await controller.disconnect()
        finally:
            history.close()

    app = FastAPI(title="1025控制台 · LBTEK", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.controller, app.state.history = controller, history

    @app.middleware("http")
    async def guard(request, call_next):
        path = request.url.path
        if path.startswith("/api/devices/") and not path.startswith("/api/devices/lbtek/"):
            return JSONResponse({"detail": "此入口只管理 LBTEK"}, status_code=404)
        if request.method == "POST" and path in {"/api/lbtek-stage/stop", "/api/devices/lbtek/disconnect"}:
            try:
                local(request)
                origin(request)
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
            connections.cancel("lbtek")
        elif request.method not in {"GET", "HEAD", "OPTIONS"} and not path.endswith(("/apply-connect", "/cancel")) and connections.busy_for(path):
            return JSONResponse({"detail": "连接正在应用，请等待或停止"}, status_code=409)
        response = await call_next(request)
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"})
        return response

    install_lbtek_routes(app, controller, local, local, origin)
    install_connection_routes(app, connections, local, origin)

    @app.get("/api/health")
    async def health():
        return {"ok": True, "scope": "lbtek"}

    directory = Path(frontend) if frontend else Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2])) / "frontend" / "dist"
    if frontend is None and not getattr(sys, "frozen", False) and not (directory / "lbtek.html").is_file():
        directory = Path(__file__).resolve().parents[1] / "build" / "lbtek-ui"

    @app.get("/{path:path}")
    async def static(path: str):
        if path.startswith("api/"):
            raise HTTPException(404)
        target = (directory / (path or "lbtek.html")).resolve()
        if not target.is_relative_to(directory.resolve()) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target)

    return app
