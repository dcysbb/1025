if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    import sys
    if "--open-browser" in sys.argv:
        from app.desktop import launch
        sys.exit(launch())
    else:
        from app.main import run
        run()
