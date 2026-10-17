"""Optional Windows service entry point. Install only through an elevated terminal."""
import asyncio
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

import servicemanager
import win32event
import win32service
import win32serviceutil


class VacuumService(win32serviceutil.ServiceFramework):
    _svc_name_ = "VacuumInterlock"
    _svc_display_name_ = "Vacuum Interlock Control"
    _svc_description_ = "Local vacuum monitoring and interlock control service."
    if getattr(sys, "frozen", False):
        _exe_name_ = sys.executable

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self.server = None

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.stop_event)
        if self.server:
            self.server.should_exit = True

    def SvcDoRun(self):
        import uvicorn
        from app.main import app, DATA_DIR, CONFIG, _local_tls_paths
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(level=logging.INFO, handlers=[RotatingFileHandler(
            DATA_DIR / "service.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8")])
        config = CONFIG.get_config()
        options = {"host": "0.0.0.0" if config.allow_lan else "127.0.0.1",
                   "port": int(os.environ.get("VACUUM_INTERLOCK_PORT", "8770")), "log_config": None}
        if config.allow_lan:
            cert, key = _local_tls_paths()
            options.update(ssl_certfile=cert, ssl_keyfile=key)
        self.server = uvicorn.Server(uvicorn.Config(app, **options))
        if win32event.WaitForSingleObject(self.stop_event, 0) != win32event.WAIT_OBJECT_0:
            servicemanager.LogInfoMsg("VacuumInterlock starting")
            asyncio.run(self.server.serve())


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    if "--help" in sys.argv:
        print("VacuumInterlockService.exe [--startup auto] install | start | stop | remove | debug")
    elif getattr(sys, "frozen", False) and len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(VacuumService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        win32serviceutil.HandleCommandLine(VacuumService)
