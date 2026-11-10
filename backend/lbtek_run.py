"""Run only the LBTEK controller when the main console must remain online."""
if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    import os
    import sys
    import json
    import threading
    import time
    import urllib.request
    import webbrowser
    import uvicorn
    from app.lbtek_app import create_lbtek_app
    port = int(os.environ.get("LBTEK_PANEL_PORT", "8776"))
    url = f"http://127.0.0.1:{port}/"

    def ready():
        try:
            with urllib.request.urlopen(url + "api/health", timeout=1) as response:
                return json.load(response).get("scope") == "lbtek"
        except (OSError, ValueError):
            return False

    if "--open-browser" in sys.argv:
        if ready():
            webbrowser.open(url)
            sys.exit(0)

        def open_when_ready():
            for _ in range(40):
                if ready():
                    webbrowser.open(url)
                    return
                time.sleep(.25)

        threading.Thread(target=open_when_ready, daemon=True).start()
    uvicorn.run(create_lbtek_app(frontend=os.environ.get("LBTEK_FRONTEND_DIR")), host="127.0.0.1",
                port=port)
