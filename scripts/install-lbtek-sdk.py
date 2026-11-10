"""Install the unmodified official Windows x64 runtime outside Git."""
import hashlib
import io
from pathlib import Path
import urllib.parse
import urllib.request
import zipfile


URL = "https://images.lbtek.com/mall/software/EM-CSx-SDK二次开发包 V1.0.1-llaaRm4eCQvXXiICSsm6g44UM11r.zip?attname=EM-CSx-SDK二次开发包 V1.0.1.zip"
SHA256 = "9a89d68ff049eb31637e079d244042911e7cafd0bffac1910ca97d874443563a"
FILES = ["moverLibrary_x64.dll", "msys-usb-1.0.dll", "libwinpthread-1.dll", "deviceModelsParam", "EM-CSx-x-logconfig.ini"]


def install():
    root = Path(__file__).resolve().parents[1] / "backend" / "vendor" / "lbtek"
    request = urllib.request.Request(urllib.parse.quote(URL, safe=":/?=&"))
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = response.read()
    if hashlib.sha256(payload).hexdigest() != SHA256:
        raise RuntimeError("LBTEK SDK checksum differs from the reviewed 1.0.1 release")
    prefix = "EM-CSx-SDK/LuBon_mover_PythonSDK_Interp/libs_x64/"
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        root.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            (root / name).write_bytes(archive.read(prefix + name))
    print(f"Installed official LBTEK SDK 1.0.1 to {root}")


if __name__ == "__main__":
    install()
