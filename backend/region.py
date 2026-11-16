"""Streamed 256-cell districts. Unvisited land is deterministic, not a live City.

Only inhabited or recently focused districts need mutable simulation records.
District road and utility networks are currently independent.
"""
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
import math
import os
import sys
from uuid import uuid4

from backend.simulation import City, SIZE, MIN_HEIGHT, MAX_HEIGHT, legacy_generate_heights, limit_slopes, _hash, _smooth
from backend.terrain import GENERATOR_VERSION, PERLIN_GENERATORS, world_heights, world_edges


def district_at(x: float, z: float) -> tuple[int, int]:
    return math.floor(x / SIZE), math.floor(z / SIZE)


def detailed_districts(x: float, z: float) -> set[tuple[int, int]]:
    # A 24-cell focus footprint can straddle at most four districts.
    return {district_at(x + dx, z + dz) for dx in (-12, 12) for dz in (-12, 12)}


def visible_detail(x: float, z: float, distance: float, previous=()) -> set[tuple[int, int]]:
    """Distance to district bounds, with a retention band to prevent edge churn."""
    if distance >= 340:
        return set()
    radius = max(96., min(144., distance * .65))
    cx, cz = district_at(x, z)
    result = set()
    for dz in (-1, 0, 1):
        for dx in (-1, 0, 1):
            key = (cx + dx, cz + dz)
            gap_x = max(key[0] * SIZE - x, 0., x - (key[0] + 1) * SIZE)
            gap_z = max(key[1] * SIZE - z, 0., z - (key[1] + 1) * SIZE)
            limit = radius + (32 if key in previous else 0)
            if gap_x * gap_x + gap_z * gap_z <= limit * limit:
                result.add(key)
    return result


class Activity(str, Enum):
    """Simulation fidelity assigned to a materialised district."""

    HOT = "hot"          # Camera-near or focused: ordinary fine-grained update.
    COLD = "cold"        # Developed but distant: accumulated, batched update.
    DORMANT = "dormant"  # Empty/non-running state; retained only when necessary.


def recommended_workers() -> int:
    """Return a safe default for Python work, with an environment override.

    CPU-bound Python threads scale only on a free-threaded interpreter.  Normal
    builds therefore remain serial unless KSC_SIM_WORKERS explicitly opts in
    (useful for profiling native kernels that release the GIL).
    """
    configured = os.environ.get("KSC_SIM_WORKERS")
    if configured is not None:
        try:
            return max(1, min(32, int(configured)))
        except ValueError as exc:
            raise ValueError("KSC_SIM_WORKERS must be an integer.") from exc
    gil_enabled = getattr(sys, "_is_gil_enabled", lambda: True)()
    return max(1, min(8, os.cpu_count() or 1)) if not gil_enabled else 1


@lru_cache(maxsize=8)
def border_template(base: tuple[int, ...], cx: int, cz: int):
    source = [base[(SIZE - 1 - z if cz % 2 else z) * SIZE +
                   (SIZE - 1 - x if cx % 2 else x)] for z in range(SIZE) for x in range(SIZE)]
    ceiling = [12] * (SIZE * SIZE)
    for z in range(SIZE):
        for x in range(SIZE):
            i = z * SIZE + x
            if x in (0, SIZE - 1) or z in (0, SIZE - 1):
                ceiling[i] = source[i]
            if x: ceiling[i] = min(ceiling[i], ceiling[i - 1] + 1)
            if z: ceiling[i] = min(ceiling[i], ceiling[i - SIZE] + 1)
    for z in reversed(range(SIZE)):
        for x in reversed(range(SIZE)):
            i = z * SIZE + x
            if x < SIZE - 1: ceiling[i] = min(ceiling[i], ceiling[i + 1] + 1)
            if z < SIZE - 1: ceiling[i] = min(ceiling[i], ceiling[i + SIZE] + 1)
    return source, ceiling


@lru_cache(maxsize=64)
def terrain(seed: int, cx: int, cz: int, base: tuple[int, ...] | None = None, generator: int = GENERATOR_VERSION) -> tuple[int, ...]:
    if generator in PERLIN_GENERATORS:
        return world_heights(seed, cx, cz, generator)
    base = legacy_generate_heights(seed) if base is None else base
    if (cx, cz) == (0, 0):
        return base
    # Mirrored border profiles meet exactly, including negative coordinates.
    # Only four border templates exist; interiors still use world-space noise.
    source, ceiling = border_template(base, cx % 2, cz % 2)
    smooth = [_smooth(x / 64) for x in range(64)]
    knots = [[_hash(cx * 4 + x, cz * 4 + z, seed + 101) for x in range(5)] for z in range(5)]
    # Interpolate lattice rows once instead of hashing four corners per cell.
    rows = [[row[x // 64] + (row[x // 64 + 1] - row[x // 64]) * smooth[x % 64]
             for x in range(SIZE)] for row in knots]
    heights = []
    for z in range(SIZE):
        top, bottom, fz = rows[z // 64], rows[z // 64 + 1], smooth[z % 64]
        for x in range(SIZE):
            edge = min(x, z, SIZE - 1 - x, SIZE - 1 - z)
            variation = round((top[x] + (bottom[x] - top[x]) * fz - .5) * 16)
            heights.append(max(-6, min(12, source[z * SIZE + x] +
                                               max(-edge, min(edge, variation)))))
    # The border ceiling and slope limiter preserve the shared edge profiles.
    return tuple(limit_slopes([min(a, b) for a, b in zip(heights, ceiling)]))


class Region:
    def __init__(self, city: City, *, workers: int | None = None):
        self.seed = city.seed
        self.generator = city.terrain_generator
        self.base = tuple(t.height for t in city.tiles)
        self.cities = {(0, 0): city}
        self.focus = (0, 0)
        self.high = {(0, 0)}
        self.pending: dict[tuple[int, int], float] = {}
        self.modified = {(0, 0)}
        self.explored = {(0, 0)}
        self.elapsed = 0.0
        self.mesh_cache: dict[tuple, dict] = {}
        self.visual_high: set[tuple[int, int]] = set()
        self.render_id = uuid4().hex
        self.workers = recommended_workers() if workers is None else max(1, workers)
        self._executor: ThreadPoolExecutor | None = None

    def activity(self, key: tuple[int, int]) -> Activity:
        city = self.cities.get(key)
        if city is None or not city.speed:
            return Activity.DORMANT
        if key == self.focus or key in self.high:
            return Activity.HOT
        if key in self.modified:
            return Activity.COLD
        return Activity.DORMANT

    def activity_counts(self) -> dict[str, int]:
        counts = {level.value: 0 for level in Activity}
        for key in self.cities:
            counts[self.activity(key).value] += 1
        return counts

    def _run_jobs(self, jobs: list[tuple[tuple[int, int], float, int | None]]):
        """Run independent district jobs and observe failures deterministically."""
        def run(job):
            key, seconds, power_step = job
            if power_step is None:
                self.cities[key].run(seconds)
            else:
                self.cities[key].run(seconds, power_step=power_step)
        if len(jobs) < 2 or self.workers == 1:
            for job in jobs:
                run(job)
            return
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="ksc-region")
        # executor.map yields results in input order, making exception observation
        # stable even though independent districts execute concurrently.
        list(self._executor.map(run, jobs))

    @property
    def city(self):
        return self.cities[self.focus]

    def flush(self, key):
        seconds = self.pending.pop(key, 0.)
        if seconds:
            self.cities[key].run(seconds, power_step=30)

    def select(self, x: float, z: float):
        key = district_at(x, z)
        self.high = detailed_districts(x, z)
        if key == self.focus:
            return
        previous = self.city
        self.flush(self.focus)
        if key not in self.cities:
            city = City(self.seed, heights=terrain(self.seed, *key, self.base, self.generator), starter=False)
            city.terrain_generator = self.generator
            # New districts share the region's time and simulation speed.
            city.tick, city.clock = previous.tick, previous.clock
            city.power_clock, city._power_accumulator = previous.power_clock, previous._power_accumulator
            city._fast_seconds, city.speed = previous._fast_seconds, previous.speed
            city.history = []
            city.power_history = []
            city.record_history()
            city.record_power()
            self.cities[key] = city
        self.flush(key)
        self.focus = key
        self.explored.add(key)
        # Keep API revisions monotonic across district switches.
        self.city.revision = max(self.city.revision, previous.revision) + 1
        self.city.traffic()
        self.city.traffic_revision = max(self.city.traffic_revision, previous.traffic_revision) + 1
        self.city._snapshot = None
        # Empty districts can be regenerated; exploration never retains endless grids.
        for old in list(self.cities):
            if old not in self.modified and old not in self.high:
                del self.cities[old]
                self.pending.pop(old, None)

    def run(self, seconds: float):
        self.elapsed += seconds
        jobs: list[tuple[tuple[int, int], float, int | None]] = []
        for key in sorted(self.cities):
            level = self.activity(key)
            if level is Activity.HOT:
                pending = self.pending.pop(key, 0.)
                jobs.append((key, pending + seconds, None))
            elif level is Activity.COLD:
                self.pending[key] = self.pending.get(key, 0.) + seconds
                # Lower-frequency power dispatch; no traffic routing or snapshots.
                if self.pending[key] >= 2:
                    jobs.append((key, self.pending.pop(key), 30))
        self._run_jobs(jobs)

    def set_speed(self, speed):
        for key, city in self.cities.items():
            self.flush(key)
            city.set_speed(speed)

    def mesh(self, cx: int, cz: int, step: int):
        city = self.cities.get((cx, cz))
        development = hash(tuple((i, t.kind, t.level) for i, t in enumerate(city.tiles) if t.kind != "empty")) if city else 0
        key = (cx, cz, step, city.terrain_revision if city else 0, development)
        if key in self.mesh_cache:
            return self.mesh_cache[key]
        heights = [t.height for t in city.tiles] if city else terrain(self.seed, cx, cz, self.base, self.generator)
        def vertex(x, z):
            xs = [max(0, min(SIZE - 1, math.floor(x - .5))), max(0, min(SIZE - 1, math.floor(x))) ]
            zs = [max(0, min(SIZE - 1, math.floor(z - .5))), max(0, min(SIZE - 1, math.floor(z))) ]
            return sum(heights[b * SIZE + a] for a in xs for b in zs) / 4
        result = dict(x=cx, z=cz, step=step, stamp=self.render_id + ":" + ":".join(map(str, key[3:])),
                      heights=[vertex(x, z) for z in range(0, SIZE + 1, step) for x in range(0, SIZE + 1, step)],
                      edges=[[vertex(x, z) for x, z in points] for points in (
                          [(i / 2, 0) for i in range(SIZE * 2 + 1)],
                          [(SIZE, i / 2) for i in range(SIZE * 2 + 1)],
                          [(i / 2, SIZE) for i in range(SIZE * 2 + 1)],
                          [(0, i / 2) for i in range(SIZE * 2 + 1)])],
                      buildings=[[t.x, t.z, t.height, t.kind, t.level] for t in city.tiles
                                 if t.level or t.kind in ("power", "park", "road", "waterworks", "service")] if city else [])
        if self.generator in PERLIN_GENERATORS:
            result["edges"] = world_edges(self.seed, cx, cz, self.generator)
        self.mesh_cache[key] = result
        if len(self.mesh_cache) > 80:
            del self.mesh_cache[next(iter(self.mesh_cache))]
        return result

    def view(self, x: float, z: float, distance: float):
        cx, cz = self.focus
        self.visual_high = visible_detail(x, z, distance, self.visual_high)
        self.high = self.visual_high | {self.focus}
        radius = min(3, max(1, math.ceil(distance / SIZE)))
        tiles = []
        for dz in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                ring = max(abs(dx), abs(dz))
                step = 4 if distance < 300 and ring <= 1 else 16 if ring <= 2 else 32
                key = (cx + dx, cz + dz)
                mesh = self.mesh(*key, step)
                if key in self.visual_high:
                    city = self.cities.get(key)
                    lots = [[t.x, t.z, t.kind, t.variant, t.level, t.condition, t.workers,
                             t.powered, t.connected, t.residents]
                            for t in city.tiles if t.kind != "empty"] if city else []
                    # Rendering data does not allocate simulations for pristine neighbours.
                    detail = dict(seed=self.seed, desirability=city.desirability() if city else None, water=city.water_network.data() if city else None,
                                  heights=[t.height for t in city.tiles] if city else terrain(self.seed, *key, self.base, self.generator),
                                  lots=lots, powerLines=city.grid.lines if city else [],
                                  edges=mesh["edges"],
                                  terrainRevision=city.terrain_revision if city else 0)
                    detail["stamp"] = self.render_id + ":" + str(hash((detail["terrainRevision"], tuple(tuple(lot) for lot in lots),
                        tuple((f.id, f.rotation, round(f.stored, 2), city.water_network.facility_status[f.id]["reason"]) for f in city.facilities.values()) if city else (),
                        tuple(sorted(city.pipes)) if city else (),
                        tuple((i, r["score"]) for i, r in city.desirability_state.items()) if city else ())))
                    tiles.append({**mesh, "detail": detail})
                else:
                    tiles.append(mesh)
        self.explored.update((t["x"], t["z"]) for t in tiles)
        return dict(size=SIZE, focus=list(self.focus), detailed=[list(k) for k in sorted(self.high)],
                    activity=self.activity_counts(), workers=self.workers,
                    explored=len(self.explored), inhabited=len(self.modified), tiles=tiles,
                    fogNear=max(180, distance * .85), fogFar=min(1400, max(360, distance + radius * SIZE * .8)))

    def save_data(self):
        for key in self.cities:
            self.flush(key)
        return dict(region_version=1, terrain_generator=self.generator, seed=self.seed, terrain_base=list(self.base), focus=list(self.focus),
                    explored=[list(k) for k in sorted(self.explored)],
                    cities=[dict(x=x, z=z, state=c.save_data(), modified=(x, z) in self.modified)
                            for (x, z), c in self.cities.items()])

    @classmethod
    def restore(cls, data):
        if not isinstance(data, dict) or "region_version" not in data:
            return cls(City.restore(data))
        if data.get("region_version") != 1 or type(data.get("seed")) is not int:
            raise ValueError("Unsupported region save.")
        def coord(value):
            if not isinstance(value, list) or len(value) != 2 or any(type(v) is not int or abs(v) > 10000 for v in value):
                raise ValueError("Invalid saved district coordinates.")
            return tuple(value)
        entries = data.get("cities")
        if not isinstance(entries, list) or not entries:
            raise ValueError("Invalid saved districts.")
        cities, modified = {}, set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Invalid saved district.")
            key = coord([entry.get("x"), entry.get("z")])
            if key in cities:
                raise ValueError("Duplicate saved district.")
            city = City.restore(entry.get("state"))
            if city.seed != data["seed"]:
                raise ValueError("District seed differs from region seed.")
            cities[key] = city
            if entry.get("modified", True): modified.add(key)
        focus = coord(data.get("focus"))
        if focus not in cities:
            raise ValueError("Missing focused district.")
        region = cls(cities[focus])
        region.generator = data.get("terrain_generator", 1)
        if type(region.generator) is not int or region.generator not in (1, *PERLIN_GENERATORS):
            raise ValueError("Unsupported regional terrain generator.")
        if any(c.terrain_generator != region.generator for c in cities.values()):
            raise ValueError("Inconsistent regional terrain generators.")
        base = data.get("terrain_base")
        if not isinstance(base, list) or len(base) != SIZE * SIZE or any(type(h) is not int or not MIN_HEIGHT <= h <= MAX_HEIGHT for h in base):
            raise ValueError("Invalid regional terrain seed map.")
        if limit_slopes(base) != base:
            raise ValueError("Regional terrain seed map has invalid slopes.")
        region.base = tuple(base)
        region.seed, region.cities, region.focus = data["seed"], cities, focus
        region.modified, region.high = modified, {focus}
        explored = data.get("explored", [])
        if not isinstance(explored, list):
            raise ValueError("Invalid explored districts.")
        region.explored = {coord(k) for k in explored} | set(cities)
        return region
