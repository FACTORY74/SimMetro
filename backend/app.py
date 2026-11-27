import asyncio
from contextlib import asynccontextmanager, suppress
import gzip
import json
import logging
import math
import os
from pathlib import Path
import secrets
import threading
import time
from uuid import uuid4
from typing import Literal

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from backend.saves import AUTOSAVE_NAMES, autosave, save_path, write_save
from backend.autoplay import AutoPlayer
from backend.controller import CommandQueue
from backend.simulation import SIZE, City
from backend.region import World, district_at, terrain
from backend.catalogue import public_catalogue


ROOT = Path(__file__).resolve().parent.parent
SAVE_PATH = Path(os.environ.get("KSC_SAVE_DIR", str(ROOT / "saves"))) / "city.json"
logger = logging.getLogger("simmetro")
# A fresh server session starts a genuinely new landscape. Saved regions retain
# their recorded seed, while direct City(seed=...) construction stays deterministic.
city = City(seed=secrets.randbelow(2**31))
region = World(city)
SESSION = uuid4().hex
autoplayer = AutoPlayer()
autoplay_district = None
autosave_status = {"last": None, "error": None}
commands = CommandQueue()
performance_status = {"updatesPerSecond": 0.0, "simulationMs": 0.0}
_last_tick_started: float | None = None
# Serializes all simulation access. Simulation and request work both run on
# worker threads holding this lock, keeping the event loop free to respond.
SIM_LOCK = threading.Lock()


async def in_sim_thread(fn, *args, **kwargs):
    """Run simulation work on a worker thread, serialized by SIM_LOCK."""
    def call():
        with SIM_LOCK:
            return fn(*args, **kwargs)
    return await asyncio.to_thread(call)


async def sim_json(request: Request, fn, *args, **kwargs):
    """Like in_sim_thread, but JSON-encodes and compresses on the worker thread.

    Responses here reach tens of megabytes; encoding them directly skips
    FastAPI's per-element jsonable_encoder pass, and pre-compressing bypasses
    the event-loop GZip middleware (which honours existing Content-Encoding).
    The simulation lock is released before serialization starts."""
    accepts_gzip = "gzip" in request.headers.get("accept-encoding", "")
    def call():
        with SIM_LOCK:
            payload = fn(*args, **kwargs)
        body = json.dumps(payload, separators=(",", ":")).encode()
        if accepts_gzip and len(body) >= 1024:
            return Response(content=gzip.compress(body, 6), media_type="application/json",
                            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
        return Response(content=body, media_type="application/json")
    return await asyncio.to_thread(call)


def snapshot():
    return {**city.snapshot(), "session": SESSION, "district": list(region.focus),
            "terrainEdges": region.terrain_edges(*region.focus)}


def execute_command(name, operation):
    """Execute one authoritative mutation and annotate mapping responses."""
    result, receipt = commands.execute(name, operation)
    if isinstance(result, dict):
        return {**result, "commandSequence": receipt.sequence}
    return result


def _tick(seconds: float, do_autosave: bool):
    global _last_tick_started
    with SIM_LOCK:
        simulation_started = time.perf_counter()
        if _last_tick_started is not None:
            rate = 1 / max(1e-6, simulation_started - _last_tick_started)
            previous = performance_status["updatesPerSecond"]
            performance_status["updatesPerSecond"] = rate if not previous else previous * .8 + rate * .2
        _last_tick_started = simulation_started
        region.run(seconds)
        autoplayer.simulation_ms = (time.perf_counter()-simulation_started)*1000
        performance_status["simulationMs"] = autoplayer.simulation_ms
        if autoplay_district == region.focus:
            try:
                if autoplayer.step(city, max_actions=4, time_budget_ms=50):
                    region.modified.add(region.focus)
            except Exception:
                logger.exception("Autoplay stopped after an unexpected error")
                autoplayer.enabled = False
                autoplayer.reason = "Stopped after an error; check server logs"
        elif autoplayer.enabled:
            autoplayer.enabled = False
            autoplayer.reason = "Stopped because the focused district changed"
        if do_autosave:
            try:
                autosave_status["last"] = autosave(SAVE_PATH, region.save_data())
                autosave_status["error"] = None
            except (OSError, ValueError):
                logger.exception("Autosave failed")
                autosave_status["error"] = "Autosave failed; check disk access and server logs"


async def simulation_loop():
    last = time.monotonic()
    last_autosave = last
    while True:
        await asyncio.sleep(.25)
        now = time.monotonic()
        do_autosave = now - last_autosave >= 120
        await asyncio.to_thread(_tick, min(now - last, 1.0), do_autosave)
        if do_autosave:
            last_autosave = now
        last = now


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(simulation_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="SimMetro City Workshop", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


class Cell(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: int = Field(ge=0, lt=SIZE)
    z: int = Field(ge=0, lt=SIZE)


class BuildRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: Literal["road", "residential", "commercial", "industrial", "power", "park", "landfill", "powerline",
                  "service", "bulldoze", "raise", "lower", "level", "waterworks", "pipe", "remove_pipe"]
    cells: list[Cell] = Field(min_length=1, max_length=400)
    variant: str | None = Field(default=None, max_length=1)
    rotation: int = Field(default=0, ge=0, le=3, strict=True)
    district: tuple[int, int] | None = None


class SpeedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    speed: Literal[0, 1, 3, "day"]


def _state(since: int | None, session: str | None):
    if session == SESSION and since == city.revision:
        return {"unchanged": True, "session": SESSION, "revision": city.revision, "clock": round(city.clock, 2)}
    return snapshot()


@app.get("/api/state")
async def state(request: Request, since: int | None = None, session: str | None = None):
    return await sim_json(request, _state, since, session)


@app.get("/api/buildings")
async def buildings(request: Request):
    """Authoritative building catalogue used by simulation and UI clients."""
    return await sim_json(request, public_catalogue)


@app.get("/api/view")
async def view(request: Request,
               x: float = Query(50, ge=-1999000, le=1999000, allow_inf_nan=False),
               z: float = Query(50, ge=-1999000, le=1999000, allow_inf_nan=False),
               distance: float = Query(75, ge=8, le=900, allow_inf_nan=False),
               terrain_shell: int = Query(1, ge=0, le=3),
               since: int | None = None, session: str | None = None):
    current_region = region
    cx, cz = district_at(x, z)
    radius = min(3, max(1, math.ceil(distance / SIZE))) + terrain_shell
    def prepare():
        for dz in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                terrain(current_region.seed, cx + dx, cz + dz, current_region.base, current_region.generator)
    # Terrain generation is pure; keep it off the authoritative simulation loop.
    # City selection and all mutations still happen serially under SIM_LOCK.
    await asyncio.to_thread(prepare)
    def respond():
        global city
        if region is not current_region:
            raise HTTPException(409, "Region changed while loading terrain. Retrying.")
        region.select(x, z)
        city = region.city
        view_data = region.view(x, z, distance, terrain_shell)
        view_data["performance"] = {
            "updatesPerSecond": round(performance_status["updatesPerSecond"], 1),
            "simulationMs": round(performance_status["simulationMs"], 1),
        }
        return {"state": _state(since, session), "region": view_data}
    return await sim_json(request, respond)


@app.get("/api/traffic")
async def traffic(request: Request):
    return await sim_json(request, lambda: {**city.traffic_data(), "session": SESSION, "district": list(region.focus)})


@app.get("/api/power")
async def power(request: Request):
    return await sim_json(request, lambda: city.power_data())


def _build(request: BuildRequest):
    if request.district is not None and request.district != region.focus:
        raise HTTPException(409, "The viewed district changed. Try the stroke again.")
    try:
        cells = [(c.x, c.z) for c in request.cells]
        cost = region.terraform(request.tool, cells) if request.tool in ("raise", "lower", "level") else \
            city.build(request.tool, cells, request.variant, rotation=request.rotation)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if cost:
        region.modified.add(region.focus)
    return {"cost": cost, "state": snapshot()}


@app.post("/api/build")
async def build(request: Request, payload: BuildRequest):
    return await sim_json(request, execute_command, "build", lambda: _build(payload))


@app.post("/api/speed")
async def speed(request: Request, payload: SpeedRequest):
    def respond():
        region.set_speed(payload.speed)
        return snapshot()
    return await sim_json(request, execute_command, "speed", respond)


@app.post("/api/new")
async def new_city(request: Request):
    def respond():
        global city, region, SESSION, autoplayer, autoplay_district
        city = City(seed=secrets.randbelow(2**31))
        region = World(city)
        SESSION = uuid4().hex
        autoplayer = AutoPlayer()
        autoplay_district = None
        return snapshot()
    return await sim_json(request, execute_command, "new", respond)


class AutoplayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    reserve: int = Field(default=5000, ge=0, le=10000000)
    target: int = Field(default=2000, ge=1, le=1000000)
    mode: Literal["stress", "growth"] = "stress"


@app.get("/api/autoplay")
async def autoplay_status():
    return await in_sim_thread(lambda: {**autoplayer.status(), "district": autoplay_district})


@app.post("/api/autoplay")
async def autoplay_control(request: AutoplayRequest):
    def respond():
        global autoplayer, autoplay_district
        if request.enabled:
            autoplayer = AutoPlayer(request.reserve, request.target, request.mode)
            autoplayer.enabled = True
            autoplayer.reason = "Ready; waiting for simulation to run"
            autoplay_district = region.focus
            region.modified.add(region.focus)
        else:
            autoplayer.enabled = False
            autoplayer.reason = "Stopped by player"
        return {**autoplayer.status(), "district": autoplay_district}
    return await in_sim_thread(execute_command, "autoplay", respond)


class SaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(default="city", pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$")


@app.get("/api/saves")
async def saves():
    entries = []
    try:
        for path in SAVE_PATH.parent.glob("*.json"):
            if path.is_file():
                try:
                    save_path(SAVE_PATH, path.stem)
                except ValueError:
                    continue
                entries.append({"name": path.stem, "modified": path.stat().st_mtime,
                                "automatic": path.stem in AUTOSAVE_NAMES})
    except OSError as exc:
        raise HTTPException(500, "Could not list saves.") from exc
    return {"saves": sorted(entries, key=lambda e: -e["modified"]), "autosave": autosave_status}


@app.post("/api/save")
async def save(request: SaveRequest | None = Body(default=None)):
    name = request.name if request else "city"
    if name in AUTOSAVE_NAMES:
        raise HTTPException(400, "That name is reserved for rotating autosaves.")
    data = await in_sim_thread(lambda: region.save_data())
    try:
        # Serialization and disk writes happen outside the simulation lock.
        await asyncio.to_thread(write_save, save_path(SAVE_PATH, name), data)
    except OSError as exc:
        logger.exception("Could not save city")
        raise HTTPException(500, "Could not write the save file. Check server logs.") from exc
    return {"message": f"Region saved as {name}."}


@app.post("/api/load")
async def load(request: Request, payload: SaveRequest | None = Body(default=None)):
    def parse():
        return Region.restore(json.loads(save_path(SAVE_PATH, payload.name if payload else "city").read_text(encoding="utf-8")))
    try:
        # Reading and validating the save needs no simulation state.
        restored_region = await asyncio.to_thread(parse)
    except FileNotFoundError as exc:
        raise HTTPException(404, "No saved city yet. Save your city first.") from exc
    except (ValueError, TypeError) as exc:
        logger.exception("Invalid city save")
        message = str(exc) if isinstance(exc, ValueError) and str(exc) else \
            "The saved city is invalid or incompatible."
        raise HTTPException(400, message) from exc
    except OSError as exc:
        logger.exception("Could not read city save")
        raise HTTPException(500, "Could not read the save file. Check server logs.") from exc
    def swap():
        global city, region
        restored = restored_region.city
        restored.revision = city.revision + 1
        restored.terrain_revision = city.terrain_revision + 1
        restored.traffic()
        restored.traffic_revision = city.traffic_revision + 1
        autoplayer.enabled = False
        autoplayer.reason = "Stopped after loading a save"
        city = restored
        region = restored_region
        return snapshot()
    return await sim_json(request, execute_command, "load", swap)


if (ROOT / "dist").is_dir():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="web")
