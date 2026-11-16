"""Atomic named saves and a bounded three-slot autosave ring."""
import json
import os
import re
from pathlib import Path

AUTOSAVE_NAMES = tuple(f"autosave-{i}" for i in range(1, 4))


def save_path(default: Path, name: str):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,47}", name):
        raise ValueError("Save name must be 1-48 letters, digits, hyphens or underscores.")
    return default if name == "city" else default.parent / f"{name}.json"


def write_save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


def autosave(default, data):
    paths = [save_path(default, name) for name in AUTOSAVE_NAMES]
    target = min(paths, key=lambda p: p.stat().st_mtime_ns if p.exists() else -1)
    write_save(target, data)
    return target.stem
