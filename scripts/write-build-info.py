"""Write immutable packaging metadata into an ignored build directory."""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
revision = subprocess.check_output(["git", "rev-parse", "--short=8", "HEAD"], cwd=root, text=True).strip()
dirty = bool(subprocess.check_output(["git", "diff", "HEAD", "--name-only"], cwd=root, text=True).strip())
target = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "backend" / "build" / "build-info.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({"revision": revision + ("-modified" if dirty else ""),
                              "built_at": datetime.now(timezone.utc).isoformat()}, indent=2), encoding="utf-8")
