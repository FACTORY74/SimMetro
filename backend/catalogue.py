"""Validated, backend-authoritative building definitions."""
from functools import lru_cache
import json
from pathlib import Path

DEFINITION_DIR = Path(__file__).resolve().parent.parent / "building_def"
BUILDING_KINDS = {"residential", "commercial", "industrial", "power", "service", "waterworks"}


def _number(value, *, minimum=0):
    return type(value) in (int, float) and value >= minimum


@lru_cache(maxsize=1)
def definitions() -> dict[tuple[str, str], dict]:
    result: dict[tuple[str, str], dict] = {}
    for path in sorted(DEFINITION_DIR.glob("*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Invalid building definition {path.name}: {exc}") from exc
        if not isinstance(row, dict):
            raise ValueError(f"Building definition {path.name} must be an object.")
        kind, variant = row.get("kind"), row.get("variant")
        if kind not in BUILDING_KINDS or not isinstance(variant, str) or len(variant) != 1:
            raise ValueError(f"Building definition {path.name} has an invalid kind or variant.")
        if row.get("id") is None or not isinstance(row.get("label"), str) or not _number(row.get("constructionCost")):
            raise ValueError(f"Building definition {path.name} is missing common fields.")
        key = kind, variant
        if key in result:
            raise ValueError(f"Duplicate building definition for {kind}.{variant}.")
        result[key] = row
    if not result:
        raise ValueError(f"No building definitions found in {DEFINITION_DIR}.")
    return result


def definition(kind: str, variant: str) -> dict:
    try:
        return definitions()[kind, variant]
    except KeyError as exc:
        raise ValueError(f"Unknown building definition {kind}.{variant}.") from exc


def public_catalogue() -> list[dict]:
    """JSON-safe catalogue for UI and inspection clients."""
    return [dict(row) for row in definitions().values()]
