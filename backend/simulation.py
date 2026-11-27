"""Deterministic, headless city simulation; no dependency on the web server."""

from collections import deque
from dataclasses import dataclass
from functools import lru_cache
import math

from backend.desirability import evaluate as evaluate_desirability, commit as commit_desirability, restore as restore_desirability, sample_services
from backend.facilities import FACILITIES
from backend.water import WaterNetwork
from backend.water_commands import build_water, starter_water, restore_water
from backend.roads import ROADS, road_type
from backend.services import SERVICES
from backend.traffic import ROAD_CAPACITY, TrafficPlan, plan_traffic
from backend.power import LINE_SPAN, PLANTS, STEP_MINUTES, PowerGrid
from backend.terrain import SIZE, MIN_HEIGHT, MAX_HEIGHT, GENERATOR_VERSION, PERLIN_GENERATORS, world_heights
from backend.catalogue import definitions
from backend.weather import weather


TILE_COUNT = SIZE * SIZE
ORIGIN = 20  # Offset of the starter-town layout within a district.
MAX_TERRAFORM_TILES = 4000
SAVE_VERSION = 15
LANDFILL_CAPACITY = 300
LANDFILL_PLUME_RADIUS = 4
POLLUTION_STEP_MINUTES = 360
BACKGROUND_POLLUTION_REMOVAL = .07
# Woodland is a useful natural resource, but it should complement rather than
# replace removing nearby sources. Each tree adds a small local cleanup bonus.
TREE_POLLUTION_REMOVAL = .03
POLLUTION_DIFFUSION = .24
COAL_PLUME_RADIUS = 5
COAL_PLUME_SHARE = .75
CODES = {"empty": ".", "road": "=", "residential": "r", "commercial": "c",
         "industrial": "i", "power": "p", "park": "k", "powerline": "l", "waterworks": "w", "service": "s", "landfill": "d"}
# Subtypes, one character each; the first listed is the default.
VARIANTS = {
    "waterworks": "pt",
    "road": "rsaehvbmxjcg", # streets, highways, shoulders, ramps and interchanges
    "residential": "hml",   # high, medium and low density
    "commercial": "roe",    # retail, office, entertainment
    "industrial": "mtf",    # manufacturing, high tech, farming
    "power": "csnwb",       # coal, solar, nuclear, wind, battery
    "service": "fpew",      # fire, police, education, forester
}
# Highest development level and jobs per level, keyed by kind initial + variant.
_BUILDINGS = definitions()
MAX_LEVEL = {kind[0] + variant: row["maxLevel"] for (kind, variant), row in _BUILDINGS.items()
             if kind in {"residential", "commercial", "industrial"}}
JOBS_PER_LEVEL = {kind[0] + variant: row["jobsPerLevel"] for (kind, variant), row in _BUILDINGS.items()
                  if kind in {"commercial", "industrial"}}
KIND_BY_CODE = {code: kind for kind, code in CODES.items()}
KINDS = set(CODES)
COSTS = {"road": 12,
         **{kind: next(row["constructionCost"] for (row_kind, _), row in _BUILDINGS.items() if row_kind == kind)
            for kind in ("residential", "commercial", "industrial")},
         "power": 900, "park": 60, "landfill": 35, "powerline": 15, "service": 800, "bulldoze": 5, "raise": 20, "lower": 20, "level": 20, "waterworks": 1000, "pipe": 3, "remove_pipe": 1}
TERRAFORM = {"raise": 1, "lower": -1}
ZONES = {"residential", "commercial", "industrial"}
BUSINESSES = {"commercial", "industrial"}
SPEEDS = (0, "day", 1, 3)
DAY_MINUTES = 1440
MONTH_MINUTES = 30 * DAY_MINUTES
CLOCK_MINUTES_PER_SECOND = DAY_MINUTES / 60   # The time of day always runs at one day per minute.
FAST_MONTH_SECONDS = 2.0                      # At 1x, one month passes every two seconds.
START_CLOCK = 6 * 60                          # New cities open at 06:00 on day 1.


def _adjacent(index: int) -> tuple[int, ...]:
    x, z = index % SIZE, index // SIZE
    return tuple(nz * SIZE + nx for nx, nz in ((x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1))
                 if 0 <= nx < SIZE and 0 <= nz < SIZE)


ADJ = tuple(_adjacent(i) for i in range(TILE_COUNT))
FRONTAGE_ROADS = {"", "r", "s", "a", "e", "m"}


def _road_link(a: "Tile", b: "Tile") -> bool:
    """Highways only join streets through ramps and each other through interchanges."""
    av, bv = a.variant, b.variant
    if av in {"b", "g"} or bv in {"b", "g"}:
        return False
    if av in FRONTAGE_ROADS and bv in FRONTAGE_ROADS:
        return True
    if av == "m" or bv == "m":
        return True
    if av == "c" or bv == "c":
        return av in {"c", "x", "j"} and bv in {"c", "x", "j"}
    if av in FRONTAGE_ROADS or bv in FRONTAGE_ROADS:
        return False
    if av == "h" and a.z != b.z or bv == "h" and a.z != b.z:
        return False
    if av == "v" and a.x != b.x or bv == "v" and a.x != b.x:
        return False
    return av == bv or av in {"x", "j"} or bv in {"x", "j"}
@dataclass(slots=True)
class Tile:
    x: int
    z: int
    height: int = 0
    kind: str = "empty"
    level: int = 0
    powered: bool = False
    connected: bool = False
    road_access: bool = False
    workers: int = 0
    occupants: int = 0
    condition: int = 100
    pollution: float = 0.0
    trees: int = 0
    trash: int = 0
    variant: str = ""
    facility_id: int = 0
    facility_root: bool = False
    installation_part: int = -1
    rezone_kind: str = ""
    rezone_variant: str = ""
    rezone_due: int = 0

    @property
    def subtype(self) -> str:
        """The variant, or the kind's default subtype when none was chosen."""
        return self.variant or VARIANTS.get(self.kind, "")[:1]

    @property
    def jobs_per_level(self) -> int:
        return JOBS_PER_LEVEL.get(self.kind[0] + self.subtype, 0) if self.kind in BUSINESSES else 0

    @property
    def max_level(self) -> int:
        return MAX_LEVEL.get(self.kind[0] + self.subtype, 0) if self.kind in ZONES else 0

    @property
    def residents_per_level(self) -> int:
        return _BUILDINGS.get((self.kind, self.subtype), {}).get("residentsPerLevel", 0)

    @property
    def job_capacity(self) -> int:
        return self.level * self.jobs_per_level

    @property
    def residents(self) -> int:
        return self.occupants if self.kind == "residential" else 0

    @property
    def labor(self) -> int:
        """Residents of working age who want a job."""
        return self.residents * 55 // 100

    @property
    def water(self) -> bool:
        return self.height < 0


def _hash(x: int, z: int, seed: int) -> float:
    n = (x * 374761393 + z * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65535


def _smooth(t: float) -> float:
    return t * t * (3 - 2 * t)


def _noise(x: float, z: float, scale: float, seed: int) -> float:
    fx, fz = x / scale, z / scale
    ix, iz = math.floor(fx), math.floor(fz)
    tx, tz = _smooth(fx - ix), _smooth(fz - iz)
    a, b = _hash(ix, iz, seed), _hash(ix + 1, iz, seed)
    c, d = _hash(ix, iz + 1, seed), _hash(ix + 1, iz + 1, seed)
    top, bottom = a + (b - a) * tx, c + (d - c) * tx
    return top + (bottom - top) * tz


def _starter_flat(x: int, z: int) -> bool:
    town = ORIGIN + 4 <= x <= ORIGIN + 44 and ORIGIN + 5 <= z <= ORIGIN + 35
    regional_road = ORIGIN + 19 <= z <= ORIGIN + 21 and x >= ORIGIN + 4
    return town or regional_road


def limit_slopes(heights: list[int]) -> list[int]:
    """Raise valleys so 4-neighbours differ by at most one terrain level."""
    h = list(heights)
    for z in range(SIZE):
        for x in range(SIZE):
            i = z * SIZE + x
            if x:
                h[i] = max(h[i], h[i - 1] - 1)
            if z:
                h[i] = max(h[i], h[i - SIZE] - 1)
    for z in reversed(range(SIZE)):
        for x in reversed(range(SIZE)):
            i = z * SIZE + x
            if x < SIZE - 1:
                h[i] = max(h[i], h[i + 1] - 1)
            if z < SIZE - 1:
                h[i] = max(h[i], h[i + SIZE] - 1)
    return h


@lru_cache(maxsize=8)
def legacy_generate_heights(seed: int) -> tuple[int, ...]:
    heights = []
    for z in range(SIZE):
        for x in range(SIZE):
            shore = x / (SIZE - 1) + (_noise(x, z, 37, seed + 7) - .5) * .16
            land = _smooth(min(1, max(0, (shore - .16) / .24)))
            relief = (_noise(x, z, 48, seed) + .5 * _noise(x, z, 21, seed + 1) +
                      .25 * _noise(x, z, 9, seed + 2)) / 1.75
            raw = -6 + 8 * land + (relief - .42) * 24 * land
            heights.append(max(-6, min(12, round(raw))))

    # A one-level-per-tile cone keeps the starter town and its regional road flat.
    distance = [-1] * TILE_COUNT
    queue = deque()
    for i in range(TILE_COUNT):
        if _starter_flat(i % SIZE, i // SIZE):
            distance[i] = 0
            queue.append(i)
    while queue:
        i = queue.popleft()
        for j in ADJ[i]:
            if distance[j] < 0:
                distance[j] = distance[i] + 1
                queue.append(j)
    capped = [1 if d == 0 else min(h, 1 + d) for h, d in zip(heights, distance)]
    return tuple(limit_slopes(capped))


def generate_heights(seed: int) -> tuple[int, ...]:
    return world_heights(seed, 0, 0)


def expand_legacy_map(data: dict) -> dict:
    """Reject legacy 200-cell maps which cannot fit in a 100-cell district.

    Extend edge terrain and regional roads through the added border. All validation
    still runs on the expanded data before the live city can be replaced.
    """
    if SIZE < 200:
        raise ValueError("Legacy 200 x 200 saves cannot be loaded into 100 x 100 districts.")
    old, offset = 200, (SIZE - 200) // 2
    result = dict(data)
    columns = {"heights": list, "kinds": str, "levels": str}
    if data.get("version", 0) >= 3: columns["conditions"] = list
    if data.get("version", 0) >= 4 and data.get("variants") is not None: columns["variants"] = str
    if data.get("version", 0) >= 6: columns["residents"] = list
    for field, kind in columns.items():
        if not isinstance(data.get(field), kind) or len(data[field]) != old * old:
            raise ValueError("Invalid legacy map dimensions.")
        values = []
        for z in range(SIZE):
            for x in range(SIZE):
                ox, oz = x - offset, z - offset
                inside = 0 <= ox < old and 0 <= oz < old
                i = max(0, min(old - 1, oz)) * old + max(0, min(old - 1, ox))
                if field == "heights" or inside:
                    value = data[field][i]
                elif field == "kinds":
                    # Only prolong roads straight out from a former edge.
                    value = "=" if data["kinds"][i] == "=" and (0 <= ox < old or 0 <= oz < old) else "."
                else:
                    value = 100 if field == "conditions" else 0 if field == "residents" else "0" if field == "levels" else "."
                values.append(value)
        result[field] = "".join(values) if kind is str else values
    storage = data.get("battery_storage")
    if isinstance(storage, dict):
        migrated = {}
        for key, value in storage.items():
            try:
                i = int(key)
            except (ValueError, TypeError):
                raise ValueError("Invalid saved battery storage.") from None
            if str(i) != key or not 0 <= i < old * old:
                raise ValueError("Invalid saved battery storage.")
            migrated[str((i // old + offset) * SIZE + i % old + offset)] = value
        result["battery_storage"] = migrated
    result["size"] = SIZE
    return result


def _starter_layout():
    for x in range(8, 32):
        yield x, 20, "road", "", 0
    for z in range(9, 31):
        for x in (16, 24):
            yield x, z, "road", "", 0
    yield 29, 18, "power", "c", 0
    for x, zs, kind, variant in [
        (15, range(11, 20), "residential", "h"),
        (17, range(12, 20), "residential", "m"),
        (23, range(13, 20), "commercial", "r"),
        (25, range(22, 29), "industrial", "m"),
        (15, range(22, 28), "residential", "l"),
    ]:
        for z in zs:
            yield x, z, kind, "o" if kind == "commercial" and z % 3 == 0 else variant, int((x + z) % 3 != 0)
    for z in (22, 23):
        yield 17, z, "park", "", 0


STARTER_LAYOUT = tuple(_starter_layout())


class City:
    def __init__(self, seed: int = 42, *, heights: tuple[int, ...] | None = None, starter: bool = True,
                 district: tuple[int, int] = (0, 0)):
        self.seed = seed
        self.district = district
        self.terrain_generator = GENERATOR_VERSION
        self.tick = 0
        self.revision = 0
        self.terrain_revision = 0
        self.money = 24000
        self.speed: int | str = 1
        self.clock = float(START_CLOCK)   # Minutes since the start of the current month.
        self._fast_seconds = 0.0
        self.traffic_revision = 0
        self._traffic: TrafficPlan | None = None
        self._traffic_stale: TrafficPlan | None = None
        self._traffic_digest: int | None = None
        self._desirability: dict | None = None
        self._components: list[int] = []
        self.population = 0
        self.jobs = 0
        self.employed = 0
        self.workforce = 0
        self._labor_surplus: dict[int, int] = {}
        self._districts: dict[int, int] = {}
        self.income = 0
        self.expenses = 0
        self.demand = {"residential": 70, "commercial": 45, "industrial": 60}
        self.history: list[dict] = []
        self.pipes: set[int] = set()
        self.facilities = {}
        self.next_facility_id = 1
        self.water_grace = 0
        self.water_shortages = {}
        self.desirability_state = {}
        self.desirability_samples = {}
        self.battery_storage: dict[int, float] = {}
        self.power_clock = float(START_CLOCK)
        self._power_accumulator = 0.0
        self._pollution_accumulator = 0.0
        self._trees_initialized = False
        self.power_history: list[dict] = []
        self._snapshot: dict | None = None
        heights = generate_heights(seed) if heights is None else heights
        self.tiles = [Tile(i % SIZE, i // SIZE, heights[i]) for i in range(TILE_COUNT)]
        if starter:
            self._lay_out_starter_town()
            starter_water(self, SIZE)
        self.recalculate()
        self.record_power()
        self.record_history()

    def _lay_out_starter_town(self):
        def dry(ox, oz):
            return all(not self.at(ox + x, oz + z).water for x, z, *_ in STARTER_LAYOUT)
        ox = oz = ORIGIN
        if not dry(ox, oz):
            candidates = ((x, z) for z in range(SIZE - 31) for x in range(SIZE - 32))
            for ox, oz in sorted(candidates, key=lambda p: ((p[0] - ORIGIN) ** 2 + (p[1] - ORIGIN) ** 2, p[1], p[0])):
                if dry(ox, oz):
                    break
            else:
                raise ValueError("No dry land for the starter town.")
        for x, z, kind, variant, level in STARTER_LAYOUT:
            tile = self.at(ox + x, oz + z)
            tile.kind, tile.variant, tile.level = kind, variant, level
            tile.occupants = level * tile.residents_per_level if kind == "residential" else 0
            installation = _BUILDINGS.get((kind, variant), {}).get("installation")
            if installation:
                for part, (dx, dz) in enumerate((dx, dz) for dz in range(installation["depth"])
                                                for dx in range(installation["width"])):
                    member = self.at(ox + x + dx, oz + z + dz)
                    member.kind, member.variant, member.installation_part = kind, variant, part
                    member.facility_root = part == 0

    def at(self, x: int, z: int) -> Tile:
        return self.tiles[z * SIZE + x]

    def recalculate(self, refresh_power: bool = True):
        tiles = self.tiles
        road = [t.kind == "road" and t.variant not in {"b", "g"} for t in tiles]
        frontage = [road[i] and t.variant in FRONTAGE_ROADS for i, t in enumerate(tiles)]
        traffic_adj = tuple(tuple(j for j in ADJ[i] if road[j] and
                                  (_road_link(t, tiles[j]) if road[i] else frontage[j]))
                            for i, t in enumerate(tiles))
        queue = deque()
        components = [-1] * TILE_COUNT
        for start in range(TILE_COUNT):
            if not road[start] or components[start] >= 0:
                continue
            components[start] = start
            queue.append(start)
            while queue:
                i = queue.popleft()
                for j in traffic_adj[i]:
                    if road[j] and components[j] < 0:
                        components[j] = start
                        queue.append(j)
        for i, tile in enumerate(tiles):
            tile.road_access = road[i] or any(frontage[j] for j in ADJ[i])
            tile.connected = tile.road_access
        # A multi-tile installation is road-served when any footprint tile has
        # frontage; the generating root need not be the tile beside the road.
        for root in (t for t in tiles if t.kind == "power" and t.installation_part == 0):
            spec = _BUILDINGS.get(("power", root.subtype), {}).get("installation")
            if not spec:
                continue
            footprint = [self.at(root.x + dx, root.z + dz)
                         for dz in range(spec["depth"]) for dx in range(spec["width"])]
            served = any(t.road_access for t in footprint)
            for tile in footprint:
                tile.road_access = tile.connected = served
        if refresh_power:
            self.grid = PowerGrid(tiles, ADJ, SIZE, self.seed, self.battery_storage)
            self.grid.dispatch(self.power_clock)
        active = [t for t in tiles if t.kind in ZONES and t.road_access and t.powered]
        self._districts = {
            t.z * SIZE + t.x: min(components[j] for j in traffic_adj[t.z * SIZE + t.x]
                                 if components[j] >= 0)
            for t in active
        }
        labor: dict[int, int] = {}
        employers: dict[int, list[Tile]] = {}
        for tile in tiles:
            tile.workers = 0
        self.workforce = 0
        for tile in active:
            district = self._districts[tile.z * SIZE + tile.x]
            if tile.kind == "residential":
                workers = tile.labor
                labor[district] = labor.get(district, 0) + workers
                self.workforce += workers
            elif tile.job_capacity:
                employers.setdefault(district, []).append(tile)
        self._labor_surplus = dict(labor)
        for district, businesses in employers.items():
            capacity = sum(t.job_capacity for t in businesses)
            available = min(labor.get(district, 0), capacity)
            # Proportional hiring with largest remainders avoids starving late tiles.
            for tile in businesses:
                tile.workers = available * tile.job_capacity // capacity
            remaining = available - sum(t.workers for t in businesses)
            ranked = sorted(businesses, key=lambda t: -(available * t.job_capacity % capacity))
            for tile in ranked[:remaining]:
                tile.workers += 1
            self._labor_surplus[district] = labor.get(district, 0) - available
        self._components = components
        self._traffic_adj = traffic_adj
        if self._traffic is not None:
            self._traffic_stale = self._traffic
        self._traffic = None
        self._desirability = None
        self.population = sum(t.residents for t in active)
        commercial_jobs = sum(t.job_capacity for t in active if t.kind == "commercial")
        industrial_jobs = sum(t.job_capacity for t in active if t.kind == "industrial")
        self.jobs = commercial_jobs + industrial_jobs
        self.employed = sum(t.workers for t in active)
        if not self._trees_initialized:
            self._recalculate_trees()
            self._trees_initialized = True
        else:
            for tile in tiles:
                if tile.kind == "park":
                    tile.trees = 5
                elif tile.kind != "empty" or tile.water or tile.height >= 30:
                    tile.trees = 0
        self.income = self.population * 2 + sum(
            t.workers * t.condition // 100 for t in active if t.kind in BUSINESSES)
        self.expenses = sum(road_type(t).upkeep for t in tiles if t.kind == "road") + sum(
            PLANTS[t.subtype].upkeep for t in tiles if t.kind == "power" and t.installation_part <= 0) + sum(
            8 if t.kind == "park" else 3 if t.kind == "landfill" else 1 if t.kind == "powerline" else 0 for t in tiles)
        self.expenses += sum(SERVICES[t.subtype].upkeep for t in tiles if t.kind == "service")
        self.expenses += sum(FACILITIES[f.variant].upkeep for f in self.facilities.values())
        self.water_network = WaterNetwork(self)
        self.water_network.dispatch()
        self.demand = {
            "residential": max(5, min(95, 55 + (self.jobs - self.population * .55) / 4)),
            "commercial": max(5, min(95, 35 + (self.population * .22 - commercial_jobs) / 3)),
            "industrial": max(5, min(95, 50 + (self.population * .4 - industrial_jobs) / 4)),
        }

    @staticmethod
    def _tree_hash(x: int, z: int, salt: int = 0) -> float:
        return (((x * 73856093) ^ (z * 19349663) ^ (salt * 83492791)) & 0xFFFFFFFF) % 1000 / 1000

    @classmethod
    def _tree_noise(cls, x: int, z: int, cell: int, salt: int) -> float:
        gx, gz = x / cell, z / cell
        x0, z0 = math.floor(gx), math.floor(gz)
        fx, fz = gx - x0, gz - z0
        sx, sz = _smooth(fx), _smooth(fz)
        a, b = cls._tree_hash(x0, z0, salt), cls._tree_hash(x0 + 1, z0, salt)
        c, d = cls._tree_hash(x0, z0 + 1, salt), cls._tree_hash(x0 + 1, z0 + 1, salt)
        return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz

    def _recalculate_trees(self):
        """Count the same wild/park trees represented by the landscape renderer."""
        ox, oz = self.district[0] * SIZE, self.district[1] * SIZE
        for tile in self.tiles:
            if tile.kind == "park":
                tile.trees = 5
            elif tile.kind == "empty" and 1 <= tile.height < 30:
                x, z = tile.x + ox, tile.z + oz
                wood = self._tree_noise(x, z, 9, 7) * .7 + self._tree_noise(x, z, 3, 8) * .3
                roll = self._tree_hash(x, z)
                tile.trees = 3 if wood > .7 else 2 if wood > .6 else (1 if roll < .35 else 0) if wood > .48 else (1 if roll < .05 else 0)
            else:
                tile.trees = 0

    def _advance_trees(self):
        """Quarterly, simultaneous woodland succession on undeveloped land."""
        previous = [t.trees if t.kind == "empty" else 0 for t in self.tiles]
        changes = [0] * TILE_COUNT
        for i, tile in enumerate(self.tiles):
            if not previous[i]:
                continue
            pollution = tile.pollution
            wx, wz = tile.x + self.district[0] * SIZE + self.seed, tile.z + self.district[1] * SIZE
            # Even clean woods lose occasional trees; dirty air raises mortality.
            death = .012 + .6 * (pollution / 100) ** 2
            if self._tree_hash(wx, wz, self.tick * 7 + 101) < death:
                changes[i] -= 1
            if pollution >= 70:
                continue
            neighbours = ADJ[i]
            target = neighbours[int(self._tree_hash(wx, wz, self.tick * 7 + 102) * len(neighbours))]
            other = self.tiles[target]
            if (other.kind != "empty" or other.water or other.height >= 30 or
                    previous[target] or other.pollution >= 70):
                continue
            chance = .045 * (1 - pollution / 70) * (1 - other.pollution / 70)
            if self._tree_hash(wx, wz, self.tick * 7 + 103) < chance:
                changes[target] = 1
        for tile, delta in zip(self.tiles, changes):
            if delta:
                tile.trees = max(0, min(3, tile.trees + delta))
        # Foresters establish saplings and slowly thicken existing woodland.
        for forester in self.tiles:
            if forester.kind != "service" or forester.subtype != "w" or not forester.powered or not forester.road_access:
                continue
            radius = SERVICES["w"].radius
            for z in range(max(0, forester.z - radius), min(SIZE, forester.z + radius + 1)):
                for x in range(max(0, forester.x - radius), min(SIZE, forester.x + radius + 1)):
                    if (x - forester.x) ** 2 + (z - forester.z) ** 2 > radius ** 2:
                        continue
                    tile = self.at(x, z)
                    if tile.kind != "empty" or tile.water or tile.height >= 30 or tile.trees >= 3:
                        continue
                    chance = (.025 if tile.trees == 0 else .012) * max(0., 1 - tile.pollution / 80)
                    wx, wz = x + self.district[0] * SIZE + self.seed, z + self.district[1] * SIZE
                    if self._tree_hash(wx, wz, self.tick * 7 + 104) < chance:
                        tile.trees += 1

    @staticmethod
    def _emissions(tile: Tile) -> float:
        """Pollution units emitted per game day by each occupied city element."""
        level = max(1, tile.level)
        if tile.kind == "road": return {"r": .12, "s": .18, "a": .28, "e": .4}.get(tile.subtype, .12)
        if tile.kind == "residential": return .08 * level
        if tile.kind == "commercial": return .18 * level
        if tile.kind == "industrial": return {"m": 16., "t": 1., "f": .35}.get(tile.subtype, 2.) * level
        if tile.kind == "power":
            if tile.installation_part > 0 and not tile.facility_root: return 0.
            return {"c": 240., "n": .6, "s": .08, "w": .04, "b": .08}.get(tile.subtype, .2)
        if tile.kind == "landfill": return 30. * tile.trash / LANDFILL_CAPACITY
        return {"park": .02, "powerline": .01, "waterworks": .1, "service": .15}.get(tile.kind, 0.)

    def _advance_pollution(self, minutes: float) -> bool:
        """Emit, diffuse and remove pollution without changing gameplay consumers yet."""
        days = minutes / DAY_MINUTES
        climate = self.weather()
        diffusion = POLLUTION_DIFFUSION * (1 + .25 * climate["rain"] - .2 * climate["snow"])
        weather_removal = .12 * climate["rain"] + .02 * climate["snow"]
        previous = [tile.pollution for tile in self.tiles]
        plume = [0.] * TILE_COUNT
        for source in self.tiles:
            coal = source.kind == "power" and source.subtype == "c"
            landfill = source.kind == "landfill" and source.trash > 0
            if not (coal or landfill) or self._emissions(source) == 0:
                continue
            radius = COAL_PLUME_RADIUS if coal else LANDFILL_PLUME_RADIUS
            share = COAL_PLUME_SHARE if coal else .7
            weighted = []
            for z in range(max(0, source.z - radius), min(SIZE, source.z + radius + 1)):
                for x in range(max(0, source.x - radius), min(SIZE, source.x + radius + 1)):
                    distance = math.hypot(x - source.x, z - source.z)
                    if 0 < distance <= radius:
                        weighted.append((z * SIZE + x, 1 / (1 + distance) ** 2))
            total = sum(weight for _, weight in weighted)
            for i, weight in weighted:
                plume[i] += self._emissions(source) * days * share * weight / total
        changed = False
        for i, tile in enumerate(self.tiles):
            neighbours = ADJ[i]
            local = previous[i]
            mixed = local * (1 - diffusion) + (sum(previous[j] for j in neighbours) / len(neighbours) if neighbours else local) * diffusion
            retained = math.exp(-days * (BACKGROUND_POLLUTION_REMOVAL + weather_removal +
                                         tile.trees * TREE_POLLUTION_REMOVAL))
            emission = self._emissions(tile) * days
            if tile.kind == "power" and tile.subtype == "c":
                emission *= 1 - COAL_PLUME_SHARE
            elif tile.kind == "landfill":
                emission *= .3
            value = min(100., max(0., mixed * retained + emission + plume[i]))
            changed |= abs(value - tile.pollution) > .0001
            tile.pollution = value
        return changed

    def _advance_trash(self):
        """Monthly generation and road-network collection; full dumps leave waste behind."""
        def networks(i):
            return {self._components[j] for j in self._traffic_adj[i] if self._components[j] >= 0}

        dumps = [(tile, networks(i)) for i, tile in enumerate(self.tiles)
                 if tile.kind == "landfill" and tile.road_access and tile.trash < LANDFILL_CAPACITY]
        for i, tile in enumerate(self.tiles):
            if tile.kind == "residential" and tile.residents:
                tile.trash = min(1_000_000, tile.trash + max(1, tile.residents // 4))
            elif tile.kind in BUSINESSES and tile.level and tile.workers:
                tile.trash = min(1_000_000, tile.trash + max(1, tile.workers // 3))
            if not tile.trash or tile.kind == "landfill":
                continue
            if tile.road_access:
                source_networks = networks(i)
                for dump, dump_networks in dumps:
                    if not source_networks.intersection(dump_networks):
                        continue
                    moved = min(tile.trash, LANDFILL_CAPACITY - dump.trash)
                    dump.trash += moved
                    tile.trash -= moved
                    if not tile.trash:
                        break
            if tile.trash >= 10 and tile.kind != "empty":
                tile.condition = max(0, tile.condition - min(25, max(1, tile.trash // 10)))
                if tile.kind == "residential" and tile.condition < 40:
                    tile.occupants = max(0, tile.occupants - max(1, tile.occupants // 10))

    def _changed(self, terrain: bool = False):
        self.revision += 1
        if terrain:
            self.terrain_revision += 1
        self.recalculate()

    def _build_highway(self, cells: list[tuple[int, int]], variant: str, rotation: int):
        """Lay three-wide highway corridors, access ramps or a nine-wide interchange."""
        if variant in {"m", "x"} and len(cells) != 1:
            raise ValueError("Place one ramp or interchange at a time.")
        layout: dict[tuple[int, int], str] = {}
        if variant == "h":
            if len(cells) == 1:
                x, z = cells[0]
                cells = [(x + step, z) if rotation % 2 == 0 else (x, z + step)
                         for step in (-1, 0, 1)]
            for i, (x, z) in enumerate(cells):
                before = cells[i - 1] if i else (x, z)
                after = cells[i + 1] if i + 1 < len(cells) else (x, z)
                bend = before[0] != after[0] and before[1] != after[1]
                horizontal = abs(after[0] - before[0]) >= abs(after[1] - before[1]) if len(cells) > 1 else rotation % 2 == 0
                direction = "h" if horizontal else "v"
                for offset in (-1, 0, 1):
                    point = (x, z + offset) if horizontal else (x + offset, z)
                    layout.setdefault(point, "b")
                layout[x, z] = "x" if bend else direction
        elif variant == "m":
            x, z = cells[0]
            if self.at(x, z).kind != "road" or self.at(x, z).variant not in {"h", "v", "x"}:
                raise ValueError("Start a ramp on a highway centre lane or interchange.")
            if (self.at(x, z).variant == "h" and rotation % 2 != 0 or
                    self.at(x, z).variant == "v" and rotation % 2 == 0):
                raise ValueError("A ramp must leave the side of its highway.")
            dx, dz = ((0, -1), (1, 0), (0, 1), (-1, 0))[rotation]
            for distance in range(1, 4):
                for offset in (-1, 0, 1):
                    layout[x + dx * distance + dz * offset, z + dz * distance - dx * offset] = "m" if offset == 0 else "b"
        else:
            x, z = cells[0]
            for dz in range(-4, 5):
                for dx in range(-4, 5):
                    layout[x + dx, z + dz] = "g"
                    if abs(dx) <= 1 or abs(dz) <= 1:
                        layout[x + dx, z + dz] = "b"
                    if dx == 0 or dz == 0:
                        layout[x + dx, z + dz] = "x"
            layout[x, z] = "j"
            for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                for dx, dz in ((sx, 3 * sz), (2 * sx, 3 * sz), (3 * sx, 3 * sz), (3 * sx, 2 * sz), (3 * sx, sz)):
                    layout[x + dx, z + dz] = "c"
        for (x, z), kind in list(layout.items()):
            if not (0 <= x < SIZE and 0 <= z < SIZE):
                raise ValueError("The highway footprint extends outside the city.")
            tile = self.at(x, z)
            if tile.water or tile.kind not in {"empty", "road"} and not (tile.kind in ZONES and tile.level == 0):
                raise ValueError("Highways need clear, dry ground across their full footprint.")
            if kind in {"b", "g"} and tile.kind == "road" and tile.variant in {"h", "v", "x", "j", "c", "m"}:
                del layout[x, z]  # Keep lanes where corridors overlap.
            elif kind in {"b", "g"} and tile.kind == "road" and tile.variant not in {"b", "g"}:
                raise ValueError("A highway shoulder cannot replace an existing street.")
            elif kind in {"h", "v"} and tile.kind == "road" and tile.variant in {"h", "v"} and tile.variant != kind:
                layout[x, z] = "x"
        changes = [(self.at(x, z), kind) for (x, z), kind in layout.items()
                   if self.at(x, z).kind != "road" or self.at(x, z).variant != kind]
        cost = sum(ROADS[kind].cost for _, kind in changes)
        if cost > self.money:
            raise ValueError(f"Insufficient funds: this highway costs ${cost:,}.")
        for tile, kind in changes:
            tile.kind, tile.variant, tile.level = "road", kind, 0
            tile.condition, tile.workers, tile.occupants, tile.trash = 100, 0, 0, 0
            tile.rezone_kind, tile.rezone_variant, tile.rezone_due = "", "", 0
        if changes:
            self.money -= cost
            self._changed()
        return cost

    def build(self, tool: str, cells: list[tuple[int, int]], variant: str | None = None, *, preserve_border: bool = False, rotation: int = 0):
        if tool not in COSTS:
            raise ValueError("Unknown construction tool.")
        if not cells or len(cells) > 400:
            raise ValueError("A stroke must contain between 1 and 400 tiles.")
        choices = VARIANTS.get(tool, "")
        if variant is None or variant == "":
            variant = choices[:1]
        elif variant not in choices or len(variant) != 1:
            raise ValueError("Unknown subtype for that tool.")
        unique = list(dict.fromkeys(cells))
        for x, z in unique:
            if not (0 <= x < SIZE and 0 <= z < SIZE):
                raise ValueError("Construction is outside the city boundary.")
        if tool == "road" and variant in {"h", "m", "x"}:
            return self._build_highway(unique, variant, rotation)
        if tool == "road" and variant in {"v", "b", "j", "c", "g"}:
            raise ValueError("Choose Highway, Ramp or Highway junction to lay this road type.")
        if tool in ("waterworks", "pipe", "remove_pipe"):
            return build_water(self, tool, unique, variant, rotation, SIZE)
        installation = _BUILDINGS.get((tool, variant), {}).get("installation")
        if tool == "power" and installation:
            if len(unique) != 1:
                raise ValueError(f"Place one {_BUILDINGS[tool, variant]['label'].lower()} at a time.")
            x, z = unique[0]
            footprint = [(x + dx, z + dz) for dz in range(installation["depth"]) for dx in range(installation["width"])]
            if any(not (0 <= px < SIZE and 0 <= pz < SIZE) for px, pz in footprint):
                raise ValueError(f"The {installation['width']} x {installation['depth']} installation is outside the city boundary.")
            if any(self.at(px, pz).kind != "empty" or self.at(px, pz).water for px, pz in footprint):
                raise ValueError(f"The installation requires a clear, dry {installation['width']} x {installation['depth']} site.")
            cost = _BUILDINGS[tool, variant]["constructionCost"]
            if cost > self.money:
                raise ValueError(f"Insufficient funds: this installation costs ${cost:,}.")
            for part, (px, pz) in enumerate(footprint):
                tile = self.at(px, pz)
                tile.kind, tile.variant, tile.installation_part = "power", variant, part
                tile.facility_root = part == 0
            self.money -= cost
            self._changed()
            return cost
        if tool == "bulldoze":
            roots = {(t.x - t.installation_part % _BUILDINGS["power", t.subtype]["installation"]["width"],
                      t.z - t.installation_part // _BUILDINGS["power", t.subtype]["installation"]["width"], t.subtype)
                     for x, z in unique for t in (self.at(x, z),)
                     if t.kind == "power" and t.installation_part >= 0 and
                     _BUILDINGS.get(("power", t.subtype), {}).get("installation")}
            if roots:
                points = {(rx + dx, rz + dz) for rx, rz, subtype_ in roots
                          for dz in range(_BUILDINGS["power", subtype_]["installation"]["depth"])
                          for dx in range(_BUILDINGS["power", subtype_]["installation"]["width"])}
                cost = 5 * len(roots)
                if cost > self.money:
                    raise ValueError("Insufficient funds for demolition.")
                for px, pz in points:
                    t = self.at(px, pz)
                    t.kind, t.variant, t.level, t.installation_part = "empty", "", 0, -1
                    t.facility_root = False
                self.money -= cost
                self._changed()
                return cost
            facility_ids = {self.at(x, z).facility_id for x, z in unique} - {0}
            # One demolition charge per facility, regardless of selected footprint cells.
            ordinary = [(x, z) for x, z in unique if not self.at(x, z).facility_id]
            if facility_ids:
                if any(self.at(x, z).water for x, z in ordinary):
                    raise ValueError("Cannot bulldoze water.")
                cost = 5 * (len(facility_ids) + sum(self.at(x, z).kind != "empty" for x, z in ordinary))
                if cost > self.money:
                    raise ValueError("Insufficient funds for demolition.")
                points = ordinary + [p for fid in facility_ids for p in self.facilities[fid].footprint()]
                for x, z in points:
                    t = self.at(x, z)
                    t.kind, t.variant, t.level, t.workers, t.occupants = "empty", "", 0, 0, 0
                    t.condition, t.facility_id, t.facility_root = 100, 0, False
                    self.water_shortages.pop(z * SIZE + x, None)
                    self.desirability_state.pop(z * SIZE + x, None)
                    self.desirability_samples.pop(z * SIZE + x, None)
                for fid in facility_ids:
                    del self.facilities[fid]
                self.money -= cost
                self._changed()
                return cost
        if tool in TERRAFORM:
            return self._terraform(tool, unique, preserve_border=preserve_border)
        if tool == "level":
            return self._level(unique, preserve_border=preserve_border)
        targets = []
        for x, z in unique:
            tile = self.at(x, z)
            if tile.water:
                if tool in ZONES or tool == "landfill":
                    continue
                raise ValueError("Cannot build on water. Raise the terrain first.")
            if (tool in ZONES or tool == "landfill") and tile.kind not in ZONES and tile.kind != "empty":
                continue
            if tool == "landfill" and tile.kind in ZONES:
                continue
            if tool == "bulldoze":
                if tile.kind != "empty":
                    targets.append(tile)
            elif tool == "powerline" and tile.kind == "road":
                continue  # The span crosses the road without replacing it with a support.
            elif tile.kind == tool and tile.subtype == variant and not tile.rezone_kind:
                continue
            elif tile.rezone_kind == tool and tile.rezone_variant == variant:
                continue
            elif tool in ZONES and tile.kind in ZONES:
                targets.append(tile)
            elif tool == "road" and tile.kind in ZONES and not tile.level:
                targets.append(tile)    # Reserved but undeveloped land is clear for a road.
            elif tile.kind == tool and (tool == "road" or tool in ZONES and not tile.level):
                targets.append(tile)
            elif tile.kind != "empty":
                raise ValueError("Bulldoze existing development before rebuilding.")
            else:
                targets.append(tile)
        price = PLANTS[variant].cost if tool == "power" else ROADS[variant].cost if tool == "road" else SERVICES[variant].cost if tool == "service" else COSTS[tool]
        cost = len(targets) * price
        if cost > self.money:
            raise ValueError(f"Insufficient funds: this stroke costs ${cost:,}.")
        for tile in targets:
            if tool in ZONES and tile.kind in ZONES and tile.level:
                if tile.kind == tool and tile.subtype == variant:
                    tile.rezone_kind, tile.rezone_variant, tile.rezone_due = "", "", 0
                else:
                    tile.rezone_kind, tile.rezone_variant = tool, variant
                    tile.rezone_due = self.tick + 1 + int(self._tree_hash(tile.x + self.seed, tile.z, self.tick + 211) * 12)
                continue
            tile.kind = "empty" if tool == "bulldoze" else tool
            tile.variant = "" if tool == "bulldoze" else variant
            tile.level = 0
            tile.condition = 100
            tile.workers = 0
            tile.occupants = 0
            tile.trash = 0
            tile.rezone_kind, tile.rezone_variant, tile.rezone_due = "", "", 0
            self.water_shortages.pop(tile.z * SIZE + tile.x, None)
            self.desirability_state.pop(tile.z * SIZE + tile.x, None)
            self.desirability_samples.pop(tile.z * SIZE + tile.x, None)
        self.money -= cost
        self._changed()
        return cost

    def _terraform(self, tool: str, cells: list[tuple[int, int]], *, preserve_border: bool = False):
        delta = TERRAFORM[tool]
        heights: dict[int, int] = {}
        queue = deque()
        for x, z in cells:
            i = z * SIZE + x
            tile = self.tiles[i]
            if tile.kind != "empty":
                raise ValueError("Bulldoze development before reshaping the terrain beneath it.")
            target = tile.height + delta
            if MIN_HEIGHT <= target <= MAX_HEIGHT:
                heights[i] = target
                queue.append(i)
        # Neighbouring land is reshaped too, keeping every slope to one level per tile.
        while queue:
            i = queue.popleft()
            wanted = heights[i] - delta
            for j in ADJ[i]:
                current = heights.get(j, self.tiles[j].height)
                if (current < wanted) if delta > 0 else (current > wanted):
                    if self.tiles[j].kind != "empty":
                        raise ValueError("That slope would disturb nearby development. "
                                         "Bulldoze it or reshape land farther away.")
                    heights[j] = wanted
                    queue.append(j)
                    if len(heights) > MAX_TERRAFORM_TILES:
                        raise ValueError("That terrain change is too large for one stroke.")
        if preserve_border and any(i % SIZE in (0, SIZE - 1) or i // SIZE in (0, SIZE - 1) for i in heights):
            raise ValueError("That slope would change a shared district border. Reshape land farther inside the district.")
        if any(i in self.pipes and h < 0 for i, h in heights.items()):
            raise ValueError("Remove underground pipes before submerging land.")
        cost = len(heights) * COSTS[tool]
        if cost > self.money:
            raise ValueError(f"Insufficient funds: this terrain change costs ${cost:,}.")
        if not heights:
            return 0
        for i, height in heights.items():
            self.tiles[i].height = height
        self.money -= cost
        self._changed(terrain=True)
        return cost

    def _level(self, cells: list[tuple[int, int]], *, preserve_border: bool = False):
        """Flatten a stroke to its first cell and relax surrounding slopes."""
        target = self.at(*cells[0]).height
        selected = {z * SIZE + x for x, z in cells}
        if any(self.tiles[i].kind != "empty" for i in selected):
            raise ValueError("Bulldoze development before levelling the terrain beneath it.")
        heights = {i: target for i in selected if self.tiles[i].height != target}
        queue = deque(selected)
        while queue:
            i = queue.popleft()
            height = target if i in selected else heights.get(i, self.tiles[i].height)
            for j in ADJ[i]:
                current = target if j in selected else heights.get(j, self.tiles[j].height)
                wanted = height - 1 if current < height - 1 else height + 1 if current > height + 1 else current
                if wanted == current:
                    continue
                if j in selected:
                    raise ValueError("The selected area cannot be levelled while preserving adjacent slopes.")
                if self.tiles[j].kind != "empty":
                    raise ValueError("That slope would disturb nearby development. Bulldoze it or level land farther away.")
                heights[j] = wanted
                queue.append(j)
                if len(heights) > MAX_TERRAFORM_TILES:
                    raise ValueError("That terrain change is too large for one stroke.")
        if preserve_border and any(i % SIZE in (0, SIZE - 1) or i // SIZE in (0, SIZE - 1) for i in heights):
            raise ValueError("That slope would change a shared district border. Reshape land farther inside the district.")
        if any(i in self.pipes and h < 0 for i, h in heights.items()):
            raise ValueError("Remove underground pipes before submerging land.")
        cost = len(heights) * COSTS["level"]
        if cost > self.money:
            raise ValueError(f"Insufficient funds: this terrain change costs ${cost:,}.")
        if not heights:
            return 0
        for i, height in heights.items():
            self.tiles[i].height = height
        self.money -= cost
        self._changed(terrain=True)
        return cost

    def advance(self):
        self.tick += 1
        if self.tick % 3 == 0:
            self._advance_trees()
        suitability = commit_desirability(self)
        for i, tile in enumerate(self.tiles):
            if tile.kind not in ZONES:
                continue
            if self.water_network.supplied(i):
                self.water_shortages.pop(i, None)
            else:
                months = min(120, self.water_shortages.get(i, 0) + 1)
                self.water_shortages[i] = months
                if months >= 3:
                    if tile.kind == "residential":
                        tile.occupants = max(0, tile.occupants - max(1, tile.occupants // 10))
                    else:
                        tile.condition = max(0, tile.condition - 10)
        for tile in self.tiles:
            if tile.kind in BUSINESSES and tile.level:
                staffed = tile.workers / tile.job_capacity
                change = 4 if staffed >= .8 else -6 if staffed == 0 else -3
                if suitability[str(tile.z * SIZE + tile.x)]["declining"]:
                    change = min(0, change)
                tile.condition = max(0, min(100, tile.condition + change))
        for key, row in suitability.items():
            i = int(key)
            tile = self.tiles[i]
            if row["declining"] and self.water_shortages.get(i, 0) < 3:
                if tile.kind == "residential":
                    tile.occupants = max(0, tile.occupants - max(1, tile.occupants // 20))
                elif tile.level:
                    tile.condition = max(0, tile.condition - 4)
        # Stable integer noise makes saves replayable without serializing RNG state.
        for tile in self.tiles:
            if tile.kind not in ZONES or tile.rezone_kind or not tile.powered or not tile.road_access or not suitability[str(tile.z * SIZE + tile.x)]["eligible"]:
                continue
            if tile.kind in BUSINESSES:
                district = self._districts[tile.z * SIZE + tile.x]
                needed = tile.jobs_per_level
                if (self._labor_surplus.get(district, 0) < needed or
                        tile.condition < 60 or
                        (tile.level and tile.workers < tile.job_capacity * .8)):
                    continue
            else:
                district = None
            chance = ((tile.x * 73856093 ^ tile.z * 19349663 ^
                       self.tick * 83492791 ^ self.seed) & 0xFFFFFFFF) % 100
            if tile.level < tile.max_level and chance < self.demand[tile.kind] * .18:
                tile.level += 1
                if district is not None:
                    self._labor_surplus[district] -= needed
        for tile in self.tiles:
            if tile.kind != "residential" or not tile.powered or not tile.road_access or not self.water_network.supplied(tile.z * SIZE + tile.x) or tile.occupants >= tile.level * tile.residents_per_level:
                continue
            row = suitability[str(tile.z * SIZE + tile.x)]
            if row["eligible"]:
                tile.occupants += min(tile.level * tile.residents_per_level - tile.occupants, 1 + int((row["score"] - 50) // 15))
        self.water_grace = max(0, self.water_grace - 1)
        self._advance_trash()
        for tile in self.tiles:
            if not tile.rezone_kind or tile.rezone_due > self.tick:
                continue
            old_kind = tile.kind
            tile.kind, tile.variant = tile.rezone_kind, tile.rezone_variant
            tile.level = min(tile.level, tile.max_level)
            tile.occupants = min(tile.occupants, tile.level * tile.residents_per_level) if old_kind == "residential" and tile.kind == "residential" else 0
            tile.workers = 0
            tile.condition = 100
            tile.rezone_kind, tile.rezone_variant, tile.rezone_due = "", "", 0
            index = tile.z * SIZE + tile.x
            self.desirability_state.pop(index, None)
            self.desirability_samples.pop(index, None)
        self.recalculate()
        self.money += self.income - self.expenses
        self.revision += 1
        self.record_history()

    def run(self, seconds: float, *, power_step: float = STEP_MINUTES):
        # Keep monthly service samples identical when offscreen work is batched.
        # No interval may straddle the next economy/calendar commit.
        if not self.speed or seconds <= 0:
            return
        while seconds > 1e-9:
            until_month = ((MONTH_MINUTES - self.clock) / CLOCK_MINUTES_PER_SECOND
                           if self.speed == "day" else FAST_MONTH_SECONDS / self.speed - self._fast_seconds)
            span = min(seconds, max(1e-9, until_month))
            self._run_interval(span, power_step=power_step)
            seconds -= span

    def _run_interval(self, seconds: float, *, power_step: float = STEP_MINUTES):
        """Advance real time. The time of day always moves at one day per minute; in "day"
        mode the calendar follows it, while 1x and 3x fast-forward months independently."""
        if not self.speed or seconds <= 0:
            return
        elapsed = seconds * CLOCK_MINUTES_PER_SECOND
        self.clock += elapsed
        self._power_accumulator += elapsed
        self._pollution_accumulator += elapsed
        changed = False
        stepped = False
        while self._power_accumulator >= STEP_MINUTES - 1e-9:
            # Distant districts batch electrical dispatch; calendar growth and taxes
            # still use the ordinary monthly rules. Never leave an unsavable remainder.
            dispatch_minutes = min(STEP_MINUTES if self.facilities or self.pipes else power_step, math.floor((self._power_accumulator + 1e-9) / STEP_MINUTES) * STEP_MINUTES)
            self._power_accumulator = max(0., self._power_accumulator - dispatch_minutes)
            previous_power_clock = self.power_clock
            self.power_clock += dispatch_minutes
            changed |= self.grid.dispatch(self.power_clock, dispatch_minutes)
            self.water_network.dispatch(dispatch_minutes)
            sample_services(self, dispatch_minutes)
            stepped = True
            if math.floor(self.power_clock / 30) > math.floor(previous_power_clock / 30):
                self.record_power()
        if changed:
            self.recalculate(refresh_power=False)
        pollution_changed = False
        while self._pollution_accumulator >= POLLUTION_STEP_MINUTES - 1e-9:
            self._pollution_accumulator = max(0., self._pollution_accumulator - POLLUTION_STEP_MINUTES)
            pollution_changed |= self._advance_pollution(POLLUTION_STEP_MINUTES)
        if pollution_changed:
            stepped = True
        if stepped:
            self.revision += 1
        if self.speed == "day":
            while self.clock >= MONTH_MINUTES - 1e-9:
                self.clock = max(0., self.clock - MONTH_MINUTES)
                self.advance()
            return
        self.clock %= MONTH_MINUTES
        self._fast_seconds += seconds
        # Months are spaced evenly across the fast-forward window rather than
        # bursting `speed` advances at once, bounding each tick's work.
        interval = FAST_MONTH_SECONDS / self.speed
        while self._fast_seconds >= interval - 1e-9:
            self._fast_seconds = max(0., self._fast_seconds - interval)
            self.advance()

    def set_speed(self, speed):
        if speed not in SPEEDS:
            raise ValueError("Unknown speed.")
        self.speed = speed
        self._fast_seconds = 0.0
        self.revision += 1

    def traffic(self) -> TrafficPlan:
        if self._traffic is None:
            plan = plan_traffic(self.tiles, self._traffic_adj, self._components, self._districts, SIZE)
            digest = hash((tuple(plan.trips), tuple(plan.minutes)))
            if digest != self._traffic_digest:
                self._traffic_digest = digest
                self.traffic_revision += 1
            self._traffic = plan
        return self._traffic

    def traffic_preview(self) -> TrafficPlan:
        """Latest computed plan for display; may be one edit stale. The monthly
        economy and the traffic endpoint always replan via traffic()."""
        if self._traffic is not None:
            return self._traffic
        if self._traffic_stale is not None:
            return self._traffic_stale
        return self.traffic()

    def desirability(self) -> dict:
        """Current lot suitability, cached until the next recalculation or monthly commit."""
        if self._desirability is None:
            self._desirability = evaluate_desirability(self, self.traffic_preview())
        return self._desirability

    def traffic_data(self):
        plan = self.traffic()
        trips = plan.trips
        return {
            "revision": self.traffic_revision, "size": SIZE, "road_capacity": ROAD_CAPACITY,
            "kind": "".join(t.kind for t in trips),
            "origin": [t.origin for t in trips], "destination": [t.destination for t in trips],
            "count": [t.count for t in trips], "start": [t.start for t in trips],
            "end": [t.end for t in trips], "minutes": plan.minutes,
            "route": [t.route for t in trips],
        }

    def record_history(self):
        profile = self.grid.daily_profile(self.power_clock)[:-1]
        self.history.append({"month": self.tick, "population": self.population,
                             "money": self.money,
                             "powerDemand": round(sum(p["demand"] for p in profile) / len(profile), 3),
                             "powerPeak": max(p["demand"] for p in profile),
                             "powerCapacity": self.grid.summary["capacity"]})
        self.history = self.history[-60:]

    def record_power(self):
        self.power_history.append({"time": self.power_clock, **self.grid.summary})
        self.power_history = self.power_history[-96:]

    def power_data(self):
        return {"clock": round(self.power_clock, 2), "summary": self.grid.summary,
                "daily": self.grid.daily_profile(self.power_clock),
                "recent": self.power_history, "history": self.history,
                "lineSpan": LINE_SPAN, "stepMinutes": STEP_MINUTES}

    def snapshot(self):
        if not self._snapshot or self._snapshot["revision"] != self.revision:
            self._snapshot = self._build_snapshot()
        # The clock moves continuously, so it is never served from the cache.
        return {**self._snapshot, "clock": round(self.clock, 2), "weather": self.weather()}

    def weather(self):
        clock = self.clock
        if self.speed in (1, 3):
            clock = self._fast_seconds / (FAST_MONTH_SECONDS / self.speed) * MONTH_MINUTES
        return weather(self.seed, self.tick, clock)

    def _build_snapshot(self):
        tiles = self.tiles
        developed = [t for t in tiles if t.kind in ZONES]
        traffic = self.traffic_preview()
        return {
            "size": SIZE, "seed": self.seed, "tick": self.tick,
            "revision": self.revision, "terrain_revision": self.terrain_revision,
            "traffic_revision": self.traffic_revision, "road_capacity": ROAD_CAPACITY,
            "commuters": traffic.commuters, "avg_commute": traffic.avg_commute,
            "congested": traffic.congested,
            "speed": self.speed, "money": self.money,
            "power": self.grid.summary,
            "water": self.water_network.data(),
            "desirability": self.desirability(),
            "power_wind": self.grid.summary["windFactor"],
            "power_lines": self.grid.lines,
            "population": self.population, "jobs": self.jobs,
            "workforce": self.workforce, "employed": self.employed,
            "unemployed": self.workforce - self.employed,
            "vacancies": self.jobs - self.employed,
            "distressed": sum(t.kind in BUSINESSES and t.level > 0 and t.condition < 60
                              for t in tiles),
            "income": self.income, "expenses": self.expenses,
            "demand": self.demand, "history": self.history,
            "unpowered": sum(not t.powered for t in developed),
            "disconnected": sum(not t.connected for t in developed),
            "tiles": {
                "height": [t.height for t in tiles],
                "kind": "".join(CODES[t.kind] for t in tiles),
                "variant": "".join(t.subtype or "." for t in tiles),
                "level": "".join(str(t.level) for t in tiles),
                "powered": "".join("1" if t.powered else "0" for t in tiles),
                "connected": "".join("1" if t.connected else "0" for t in tiles),
                "workers": [t.workers for t in tiles],
                "residents": [t.residents for t in tiles],
                "condition": [t.condition for t in tiles],
                "traffic": traffic.volume,
                "pollution": [round(t.pollution, 2) for t in tiles],
                "trees": [t.trees for t in tiles],
                "trash": [t.trash for t in tiles],
                "rezone_kind": "".join(CODES[t.rezone_kind] if t.rezone_kind else "." for t in tiles),
                "rezone_variant": "".join(t.rezone_variant or "." for t in tiles),
                "rezone_due": [t.rezone_due for t in tiles],
                "power_demand": [round(self.grid.loads.get(i, 0), 3) for i in range(TILE_COUNT)],
                "power_supply": [round(self.grid.outputs.get(i, 0), 3) for i in range(TILE_COUNT)],
                "power_grid": [self.grid.grid_of.get(i, -1) for i in range(TILE_COUNT)],
                "battery_charge": [round(self.battery_storage.get(i, 0), 3) for i in range(TILE_COUNT)],
                "installation_part": [t.installation_part for t in tiles],
            },
        }

    def save_data(self):
        return {"version": SAVE_VERSION, "size": SIZE, "seed": self.seed, "tick": self.tick,
                "terrain_generator": self.terrain_generator,
                "fast_seconds": self._fast_seconds,
                "money": self.money, "speed": self.speed, "clock": self.clock,
                "pollution": [t.pollution for t in self.tiles],
                "trees": [t.trees for t in self.tiles],
                "trash": [t.trash for t in self.tiles],
                "rezoning": [[i, t.rezone_kind, t.rezone_variant, t.rezone_due] for i, t in enumerate(self.tiles) if t.rezone_kind],
                "pollution_accumulator": self._pollution_accumulator,
                "heights": [t.height for t in self.tiles],
                "kinds": "".join(CODES[t.kind] for t in self.tiles),
                "variants": "".join(t.subtype or "." for t in self.tiles),
                "levels": "".join(str(t.level) for t in self.tiles),
                "residents": [t.residents for t in self.tiles],
                "conditions": [t.condition for t in self.tiles],
                "power_installations": [i for i, t in enumerate(self.tiles)
                                        if t.kind == "power" and t.installation_part == 0],
                "desirability": {"version": 1,
                                  "state": {str(i): r for i, r in self.desirability_state.items()},
                                  "samples": {str(i): r for i, r in self.desirability_samples.items()}},
                "water": {"pipes": sorted(self.pipes), "facilities": [f.record() for f in self.facilities.values()],
                          "next_id": self.next_facility_id, "grace": self.water_grace,
                          "shortages": {str(i): n for i, n in self.water_shortages.items()}},
                "battery_storage": {str(i): charge for i, charge in self.battery_storage.items()},
                "power_clock": self.power_clock, "power_accumulator": self._power_accumulator,
                "power_history": self.power_history,
                "history": self.history}

    @classmethod
    def restore(cls, data: dict):
        if not isinstance(data, dict):
            raise ValueError("Unsupported save format.")
        if data.get("version") == 1:
            raise ValueError("This save is from the earlier 40 × 40 map and is not compatible "
                             "with the 100 x 100 district map.")
        if data.get("version") not in (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, SAVE_VERSION):
            raise ValueError("Unsupported save format.")
        if isinstance(data.get("heights"), list) and len(data["heights"]) == 200 * 200:
            data = expand_legacy_map(data)
        if type(data.get("size", SIZE)) is not int or data.get("size", SIZE) != SIZE:
            raise ValueError("Invalid saved district size.")
        for key in ("seed", "tick", "money"):
            if type(data.get(key)) is not int:
                raise ValueError(f"Invalid save field: {key}.")
        if not 0 <= data["seed"] <= 2**31 - 1 or data["tick"] < 0:
            raise ValueError("Invalid save seed or simulation clock.")
        if type(data.get("speed")) not in (int, str) or data["speed"] not in SPEEDS:
            raise ValueError("Invalid saved speed.")
        clock = data.get("clock", START_CLOCK)
        if type(clock) not in (int, float) or not 0 <= clock < MONTH_MINUTES:
            raise ValueError("Invalid saved time of day.")
        heights, kinds, levels = data.get("heights"), data.get("kinds"), data.get("levels")
        if (not isinstance(heights, list) or len(heights) != TILE_COUNT or
                not isinstance(kinds, str) or len(kinds) != TILE_COUNT or
                not isinstance(levels, str) or len(levels) != TILE_COUNT):
            raise ValueError("Invalid saved map dimensions.")
        if any(type(h) is not int or not MIN_HEIGHT <= h <= MAX_HEIGHT for h in heights):
            raise ValueError("Invalid terrain height.")
        if any(abs(heights[i] - heights[j]) > 1 for i in range(TILE_COUNT) for j in ADJ[i]):
            raise ValueError("Saved terrain is steeper than one level per tile.")
        city = cls(data["seed"], heights=tuple(heights), starter=False)
        city.terrain_generator = data.get("terrain_generator", 1)
        if type(city.terrain_generator) is not int or city.terrain_generator not in (1, *PERLIN_GENERATORS):
            raise ValueError("Unsupported terrain generator.")
        fast_seconds = data.get("fast_seconds", 0.0)
        if type(fast_seconds) not in (int, float) or not 0 <= fast_seconds < FAST_MONTH_SECONDS:
            raise ValueError("Invalid saved fast clock.")
        city._fast_seconds = float(fast_seconds)
        pollution = data.get("pollution", [0.] * TILE_COUNT) if data["version"] >= 12 else [0.] * TILE_COUNT
        pollution_accumulator = data.get("pollution_accumulator", 0.) if data["version"] >= 12 else 0.
        if (not isinstance(pollution, list) or len(pollution) != TILE_COUNT or
                any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 100 for v in pollution) or
                type(pollution_accumulator) not in (int, float) or not math.isfinite(pollution_accumulator) or
                not 0 <= pollution_accumulator < POLLUTION_STEP_MINUTES):
            raise ValueError("Invalid saved pollution state.")
        city._pollution_accumulator = float(pollution_accumulator)
        for tile, value in zip(city.tiles, pollution):
            tile.pollution = float(value)
        saved_trees = data.get("trees") if data["version"] >= 13 else None
        if saved_trees is not None and (not isinstance(saved_trees, list) or len(saved_trees) != TILE_COUNT or
                any(type(n) is not int or not 0 <= n <= 5 for n in saved_trees)):
            raise ValueError("Invalid saved woodland state.")
        trash = data.get("trash", [0] * TILE_COUNT) if data["version"] >= 15 else [0] * TILE_COUNT
        if (not isinstance(trash, list) or len(trash) != TILE_COUNT or
                any(type(n) is not int or not 0 <= n <= 1_000_000 for n in trash)):
            raise ValueError("Invalid saved trash state.")
        conditions = data.get("conditions") if data["version"] >= 3 else [100] * TILE_COUNT
        if (not isinstance(conditions, list) or len(conditions) != TILE_COUNT or
                any(type(c) is not int or not 0 <= c <= 100 for c in conditions)):
            raise ValueError("Invalid saved building conditions.")
        variants = data.get("variants") if data["version"] >= 4 else None
        if variants is not None and (not isinstance(variants, str) or len(variants) != TILE_COUNT):
            raise ValueError("Invalid saved subtypes.")
        residents = data.get("residents") if data["version"] >= 6 else None
        if data["version"] >= 6 and (not isinstance(residents, list) or len(residents) != TILE_COUNT):
            raise ValueError("Invalid saved residents.")
        for i, tile in enumerate(city.tiles):
            kind = KIND_BY_CODE.get(kinds[i])
            if kind is None or levels[i] not in "01234":
                raise ValueError("Invalid saved tile.")
            level = int(levels[i])
            if (heights[i] < 0 and kind != "empty") or (kind not in ZONES and level != 0):
                raise ValueError("Invalid saved development.")
            choices = VARIANTS.get(kind, "")
            if variants is None:
                # Older saves had one kind of each zone: mixed shops and offices grew into towers.
                variant = "o" if kind == "commercial" and level >= 3 else choices[:1]
            else:
                variant = ("r" if kind == "road" and variants[i] == "." else variants[i]) if choices else ""
                if (variant not in choices or len(variant) != 1) if choices else variants[i] != ".":
                    raise ValueError("Invalid saved subtype.")
            tile.height, tile.kind, tile.level, tile.variant = heights[i], kind, level, variant
            if level > tile.max_level:
                raise ValueError("Invalid saved development level for its subtype.")
            count = residents[i] if residents is not None else level * tile.residents_per_level if kind == "residential" else 0
            if type(count) is not int or count < 0 or count > (level * tile.residents_per_level if kind == "residential" else 0):
                raise ValueError("Invalid saved residents.")
            tile.occupants = count
            tile.condition = conditions[i]
            if kind == "landfill" and trash[i] > LANDFILL_CAPACITY:
                raise ValueError("Landfill exceeds capacity.")
            tile.trash = trash[i]
        roots = data.get("power_installations", [])
        if not isinstance(roots, list) or any(type(i) is not int or not 0 <= i < TILE_COUNT for i in roots):
            raise ValueError("Invalid power installations.")
        occupied = set()
        for root in roots:
            rx, rz = root % SIZE, root // SIZE
            root_tile = city.at(rx, rz)
            spec = _BUILDINGS.get(("power", root_tile.subtype), {}).get("installation")
            if not spec:
                raise ValueError("Invalid power installation type.")
            points = [(rx + dx, rz + dz) for dz in range(spec["depth"]) for dx in range(spec["width"])]
            if any(px >= SIZE or pz >= SIZE or (px, pz) in occupied or
                   city.at(px, pz).kind != "power" or city.at(px, pz).subtype != root_tile.subtype for px, pz in points):
                raise ValueError("Invalid power installation footprint.")
            for part, (px, pz) in enumerate(points):
                occupied.add((px, pz))
                city.at(px, pz).installation_part = part
                city.at(px, pz).facility_root = part == 0
        legacy_installations = [t for t in city.tiles if t.kind == "power" and
                                _BUILDINGS.get(("power", t.subtype), {}).get("installation") and
                                t.installation_part < 0]
        if legacy_installations:
            if data["version"] >= 12:
                raise ValueError("Power tiles must belong to an installation.")
            # Earlier single-tile stations remain valid compact legacy plants.
            for tile in legacy_installations:
                tile.facility_root = True
        restore_water(city, data, SIZE)
        restore_desirability(city, data)
        history = data.get("history")
        if not isinstance(history, list) or len(history) > 60:
            raise ValueError("Invalid saved history.")
        for entry in history:
            if not isinstance(entry, dict) or any(
                type(entry.get(k)) is not int for k in ("month", "population", "money")
            ):
                raise ValueError("Invalid saved history entry.")
            power_fields = ("powerDemand", "powerPeak", "powerCapacity")
            if any(k in entry for k in power_fields) and any(
                type(entry.get(k)) not in (int, float) or not math.isfinite(entry[k]) or entry[k] < 0
                for k in power_fields
            ):
                raise ValueError("Invalid saved power history entry.")
        city.tick, city.money, city.speed = data["tick"], data["money"], data["speed"]
        rezoning = data.get("rezoning", []) if data["version"] < 14 else data.get("rezoning")
        if not isinstance(rezoning, list):
            raise ValueError("Invalid saved rezoning state.")
        seen_rezones = set()
        for row in rezoning:
            if not isinstance(row, list) or len(row) != 4:
                raise ValueError("Invalid saved rezoning state.")
            index, kind, variant, due = row
            if (type(index) is not int or not 0 <= index < TILE_COUNT or index in seen_rezones or
                    type(kind) is not str or kind not in ZONES or type(variant) is not str or
                    variant not in VARIANTS[kind] or type(due) is not int or
                    not city.tick < due <= city.tick + 12):
                raise ValueError("Invalid saved rezoning state.")
            tile = city.tiles[index]
            if tile.kind not in ZONES or not tile.level or (tile.kind == kind and tile.subtype == variant):
                raise ValueError("Invalid saved rezoning tile.")
            tile.rezone_kind, tile.rezone_variant, tile.rezone_due = kind, variant, due
            seen_rezones.add(index)
        if saved_trees is not None:
            for tile, count in zip(city.tiles, saved_trees):
                if ((tile.kind == "park" and count != 5) or
                        (tile.kind not in ("park", "empty") and count != 0) or
                        (tile.kind == "empty" and (count > 3 or
                         count > 0 and (tile.water or tile.height >= 30)))):
                    raise ValueError("Invalid saved woodland tile.")
                tile.trees = count
        city.clock = float(clock)
        city.history = [dict(entry) for entry in history]
        if data["version"] >= 5:
            power_clock, accumulator = data.get("power_clock"), data.get("power_accumulator")
            if (type(power_clock) not in (int, float) or not math.isfinite(power_clock) or power_clock < 0 or
                    type(accumulator) not in (int, float) or not 0 <= accumulator < STEP_MINUTES or
                    abs((power_clock + accumulator) % MONTH_MINUTES - clock) > .011):
                raise ValueError("Invalid saved power clock.")
            storage = data.get("battery_storage")
            if not isinstance(storage, dict):
                raise ValueError("Invalid saved battery storage.")
            batteries = {i for i, t in enumerate(city.tiles) if t.kind == "power" and t.subtype == "b"}
            if set(storage) != {str(i) for i in batteries} or any(
                type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= PLANTS["b"].storage
                for v in storage.values()
            ):
                raise ValueError("Invalid saved battery storage.")
            city.battery_storage = {int(i): float(v) for i, v in storage.items()}
            power_history = data.get("power_history")
            fields = {*city.grid.summary, "time"}
            if (not isinstance(power_history, list) or len(power_history) > 96 or
                    any(not isinstance(p, dict) or set(p) != fields or
                        any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in p.values())
                        for p in power_history)):
                raise ValueError("Invalid saved power history.")
            city.power_history = [dict(p) for p in power_history]
            city.power_clock, city._power_accumulator = float(power_clock), float(accumulator)
        else:
            city.power_clock = float(clock)
            city._power_accumulator = 0.
            city.power_history = []
        city.recalculate()
        if not city.power_history:
            city.record_power()
        return city
