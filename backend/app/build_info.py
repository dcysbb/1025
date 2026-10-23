"""Build identity, stamped by the packaging script rather than at server startup."""
import json
import sys
from pathlib import Path

VERSION = "0.2.0"


def build_info():
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    try:
        stamped = json.loads((root / "build-info.json").read_text(encoding="utf-8"))
        return {"version": VERSION, "revision": stamped["revision"], "built_at": stamped["built_at"]}
    except (OSError, ValueError, KeyError, TypeError):
        return {"version": VERSION, "revision": "source", "built_at": None}
