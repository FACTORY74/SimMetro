"""Start City Workshop with: python main.py"""

import argparse
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent


def configure_logging(path: Path):
    """Send application and Uvicorn output to one bounded rotating log."""
    path.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    handler = RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=4, encoding="utf-8")
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "simmetro"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
        logger.setLevel(logging.INFO)


def main():
    # Use the project's installed dependencies even from a system Python.
    environment = ROOT / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if python.is_file() and Path(sys.prefix).resolve() != environment.resolve():
        os.execv(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]])

    if sys.version_info < (3, 15):
        raise SystemExit("SimMetro requires Python 3.15 or newer. Recreate .venv with: uv venv --python 3.15 .venv")

    parser = argparse.ArgumentParser(description="Run SimMetro City Workshop locally.")
    parser.add_argument("--port", type=int, default=8000, help="Local port (default: 8000)")
    parser.add_argument("--log", type=Path, default=ROOT / "logs" / "simmetro.log",
                        help="Rotating server log (default: logs/simmetro.log)")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")

    try:
        import uvicorn
    except ImportError:
        parser.exit(1, "Missing dependencies. Run: python -m pip install -r requirements.txt\n")

    if not (ROOT / "dist" / "index.html").is_file():
        parser.exit(1, "Build the interface first: npm install && npm run build\n")

    log_path = args.log.resolve()
    configure_logging(log_path)
    print(f"City Workshop: http://127.0.0.1:{args.port} · log: {log_path} (Ctrl+C to stop)", flush=True)
    uvicorn.run("backend.app:app", host="127.0.0.1", port=args.port, app_dir=str(ROOT), log_config=None)


if __name__ == "__main__":
    main()
