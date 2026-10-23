"""Cooperative lifecycle control for the directly launched local server."""
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict


class SystemAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["exit", "restart"]


class RuntimeControl:
    def __init__(self):
        self.signal = None
        self.pending = None
        self.prepared = False
        self.instance_id = uuid4().hex

    def snapshot(self):
        return {"can_manage": self.signal is not None, "pending": self.pending, "instance_id": self.instance_id,
                "unavailable_reason": "" if self.signal else "当前由外部进程或 Windows 服务管理，请通过对应管理入口退出或重启。"}

    async def prepare(self, action, stage, engine, actor, analog=None):
        if self.signal is None:
            raise RuntimeError(self.snapshot()["unavailable_reason"])
        if self.pending:
            raise RuntimeError("退出或重启正在处理，请勿重复提交")
        self.pending = action
        try:
            if analog is not None:
                await analog.disconnect(actor)
            if stage.driver is not None or stage._connecting or stage._recovering:
                await stage.disconnect(actor)
            await engine.stop()
            if getattr(engine, "_off_retry_pending", False) or getattr(engine, "_debug_deadlines", {}):
                raise RuntimeError("阀门或调试输出关闭未确认，请先检查 I/O 通信")
            engine._event("system_control", "warning", "操作员请求" + ("重启控制台" if action == "restart" else "退出控制台"), actor)
            self.prepared = True
        except Exception as exc:
            self.pending = None
            await engine.start()
            raise RuntimeError(f"未能安全关闭，控制台保持运行：{exc}") from exc

    def finish_response(self):
        if self.prepared and self.signal:
            self.signal()
