"""Local electrical networks, renewable production and finite-energy storage.

Power is kW and stored energy is kWh. Electrical time follows the visible day,
not the independently accelerated monthly economy.
"""

from backend.facilities import FACILITIES
from backend.services import SERVICES
from backend.catalogue import definition, definitions
from dataclasses import dataclass
import math
from typing import Protocol, Sequence


LINE_SPAN = 8
STEP_MINUTES = 5
BATTERY_EFFICIENCY = .92


@dataclass(frozen=True)
class Plant:
    capacity: float
    cost: int
    upkeep: int
    storage: float = 0


PLANTS = {variant: Plant(row["powerPlant"]["capacityKw"], row["constructionCost"],
                         row["powerPlant"]["upkeep"], row["powerPlant"]["storageKwh"])
          for (kind, variant), row in definitions().items() if kind == "power"}


class PowerTile(Protocol):
    x: int
    z: int
    kind: str
    level: int
    road_access: bool
    powered: bool

    @property
    def subtype(self) -> str: ...


# Hourly factors are interpolated, with a different rhythm for each land use.
PROFILES = {
    "residential": (.38, .32, .28, .27, .3, .46, .74, .94, .72, .5, .46, .47,
                    .52, .5, .48, .5, .63, .85, 1, .98, .93, .8, .64, .48),
    "office": (.16, .15, .15, .15, .15, .18, .27, .55, .85, 1, 1, 1,
               .9, 1, 1, 1, .92, .7, .4, .26, .2, .18, .17, .16),
    "retail": (.18, .15, .15, .15, .15, .16, .22, .45, .7, .85, .95, 1,
               1, 1, .95, .95, 1, 1, .95, .85, .65, .35, .22, .2),
    "entertainment": (.85, .6, .25, .16, .14, .14, .14, .16, .18, .2, .25, .3,
                      .35, .4, .45, .5, .65, .85, .95, 1, 1, 1, 1, .95),
    "industrial": (.5, .48, .48, .48, .5, .6, .8, .95, 1, 1, 1, 1,
                   .9, 1, 1, 1, .95, .8, .65, .6, .55, .52, .5, .5),
}


def interpolate(profile: Sequence[float], minute: float) -> float:
    hour = (minute % 1440) / 60
    index = int(hour)
    return profile[index] + (profile[(index + 1) % 24] - profile[index]) * (hour - index)


def solar_factor(minute: float) -> float:
    return max(0, math.sin(math.pi * ((minute % 1440) - 360) / 720)) if 360 < minute % 1440 < 1080 else 0


def wind_factor(clock: float, seed: int) -> float:
    # Slow weather fronts plus shorter gusts. Never negative or above nameplate.
    return max(.08, min(.95, .49 + .26 * math.sin(clock / 517 + seed)
                        + .16 * math.sin(clock / 113 + seed * .7)))


def demand_kw(tile: PowerTile, minute: float) -> float:
    if tile.kind == "waterworks":
        return FACILITIES[tile.subtype].power if tile.facility_root else 0
    if tile.kind == "service":
        return SERVICES[tile.subtype].power
    if tile.kind in ("empty", "power", "powerline"):
        return 0
    if tile.kind in ("road", "park"):
        return (.035 if tile.kind == "road" else .18) * (1 if minute % 1440 < 360 or minute % 1440 > 1080 else .2)
    if not tile.level:
        return .15  # A small service connection allows an undeveloped zone to grow.
    if tile.kind == "residential":
        spec = definition("residential", tile.subtype)["power"]
        return tile.level * spec["peakKwPerLevel"] * interpolate(PROFILES[spec["profile"]], minute)
    if tile.kind == "commercial":
        spec = definition("commercial", tile.subtype)["power"]
        return tile.level * spec["peakKwPerLevel"] * interpolate(PROFILES[spec["profile"]], minute)
    spec = definition("industrial", tile.subtype)["power"]
    return tile.level * spec["peakKwPerLevel"] * interpolate(PROFILES[spec["profile"]], minute)


class PowerGrid:
    def __init__(self, tiles: Sequence[PowerTile], adjacent: Sequence[Sequence[int]], size: int,
                 seed: int, storage: dict[int, float]):
        self.tiles, self.seed, self.storage = tiles, seed, storage
        for tile in tiles:
            if tile.kind == "empty":
                tile.powered = False
        self.nodes = [i for i, t in enumerate(tiles) if t.kind != "empty"]
        self.lines: list[tuple[int, int]] = []
        extra: dict[int, list[int]] = {}
        for i in self.nodes:
            if tiles[i].kind != "powerline":
                continue
            x, z = i % size, i // size
            for dx, dz in ((1, 0), (0, 1)):
                for distance in range(1, LINE_SPAN + 1):
                    nx, nz = x + dx * distance, z + dz * distance
                    if not (0 <= nx < size and 0 <= nz < size):
                        break
                    j = nz * size + nx
                    if tiles[j].kind == "powerline":
                        self.lines.append((i, j))
                        extra.setdefault(i, []).append(j)
                        extra.setdefault(j, []).append(i)
                        break
                    if tiles[j].kind not in ("empty", "road"):
                        break
        self.members: dict[int, list[int]] = {}
        self.grid_of: dict[int, int] = {}
        active = set(self.nodes)
        for start in self.nodes:
            if start in self.grid_of:
                continue
            self.grid_of[start] = start
            queue = [start]
            for i in queue:
                for j in (*adjacent[i], *extra.get(i, ())):
                    if j in active and j not in self.grid_of:
                        self.grid_of[j] = start
                        queue.append(j)
            # Whole-building load shedding: homes first, then businesses, then public space.
            self.members[start] = sorted(queue, key=lambda i: (
                0 if tiles[i].kind == "residential" else
                1 if tiles[i].kind in ("commercial", "industrial") else 2, i))
        batteries = {i for i in self.nodes if tiles[i].kind == "power" and tiles[i].subtype == "b"}
        for i in set(storage) - batteries:
            del storage[i]
        for i in batteries:
            storage.setdefault(i, 0.0)
        self.loads: dict[int, float] = {}
        self.outputs: dict[int, float] = {}
        self.summary: dict = {}

    def production(self, index: int, clock: float) -> float:
        tile = self.tiles[index]
        if tile.kind != "power" or not tile.road_access or tile.subtype == "b" or tile.installation_part > 0:
            return 0
        factor = solar_factor(clock) if tile.subtype == "s" else wind_factor(clock, self.seed) if tile.subtype == "w" else 1
        return PLANTS[tile.subtype].capacity * factor

    def dispatch(self, clock: float, minutes: float = 0) -> bool:
        """Balance each island separately; zero-duration refreshes never move energy."""
        old = [self.tiles[i].powered for i in self.nodes]
        self.loads = {i: demand_kw(self.tiles[i], clock) for i in self.nodes}
        self.outputs = {i: self.production(i, clock) for i in self.nodes if self.tiles[i].kind == "power"}
        hours = (minutes or STEP_MINUTES) / 60
        totals = dict(demand=0., generation=0., served=0., unserved=0., charging=0.,
                      discharging=0., solar=0., wind=0., coal=0., nuclear=0., capacity=0.)
        energized = 0
        for members in self.members.values():
            plants = [i for i in members if self.tiles[i].kind == "power" and self.tiles[i].road_access
                      and self.tiles[i].installation_part <= 0]
            batteries = [i for i in plants if self.tiles[i].subtype == "b"]
            demand = sum(self.loads[i] for i in members)
            generation = sum(self.outputs.get(i, 0) for i in plants)
            available = generation
            surplus = generation - demand
            for i in batteries:
                spec = PLANTS["b"]
                if surplus > 0:
                    charge = min(surplus, spec.capacity, max(0, spec.storage - self.storage[i]) / (hours * BATTERY_EFFICIENCY))
                    if minutes:
                        self.storage[i] = min(spec.storage, self.storage[i] + charge * hours * BATTERY_EFFICIENCY)
                    surplus -= charge
                    totals["charging"] += charge
                    self.outputs[i] = -charge
                else:
                    output = min(-surplus, spec.capacity, self.storage[i] * BATTERY_EFFICIENCY / hours)
                    if minutes:
                        self.storage[i] = max(0, self.storage[i] - output * hours / BATTERY_EFFICIENCY)
                    surplus += output
                    available += output
                    totals["discharging"] += output
                    self.outputs[i] = output
            live = available > 1e-8
            energized += int(live)
            remaining = available
            served = 0.
            for i in members:
                load = self.loads[i]
                powered = live and load <= remaining + 1e-8
                self.tiles[i].powered = powered
                if powered:
                    served += load
                    remaining = max(0, remaining - load)
            for i in plants:
                variant = self.tiles[i].subtype
                if variant != "b":
                    totals[{"c": "coal", "n": "nuclear", "s": "solar", "w": "wind"}[variant]] += self.outputs[i]
                    totals["capacity"] += PLANTS[variant].capacity
            totals["demand"] += demand
            totals["generation"] += generation
            totals["served"] += served
            totals["unserved"] += max(0, demand - served)
        self.summary = {k: round(v, 3) for k, v in totals.items()}
        self.summary.update(storage=round(sum(self.storage.values()), 3),
                            storageCapacity=len(self.storage) * PLANTS["b"].storage,
                            grids=len(self.members), energizedGrids=energized,
                            windFactor=round(wind_factor(clock, self.seed), 4))
        return old != [self.tiles[i].powered for i in self.nodes]

    def daily_profile(self, clock: float) -> list[dict]:
        day = math.floor(clock / 1440) * 1440
        # demand_kw is a per-class daily curve scaled by a per-tile base, so the
        # profile only needs class totals rather than a demand_kw call per tile
        # per sample.
        constant = night = residential = industrial = 0.0
        commercial = {"retail": 0.0, "office": 0.0, "entertainment": 0.0}
        for i in self.nodes:
            tile = self.tiles[i]
            kind = tile.kind
            if kind == "waterworks":
                if tile.facility_root:
                    constant += FACILITIES[tile.subtype].power
            elif kind in ("empty", "power", "powerline"):
                continue
            elif kind in ("road", "park"):
                night += .035 if kind == "road" else .18
            elif not tile.level:
                constant += .15
            elif kind == "residential":
                residential += tile.level * 6
            elif kind == "commercial":
                name = {"r": "retail", "o": "office", "e": "entertainment"}[tile.subtype]
                commercial[name] += tile.level * {"r": 12, "o": 16, "e": 20}[tile.subtype]
            else:
                industrial += tile.level * {"m": 26, "t": 20, "f": 5}[tile.subtype]
        steady = solar = wind = 0.0
        for i in self.outputs:
            tile = self.tiles[i]
            if tile.kind != "power" or not tile.road_access or tile.subtype == "b":
                continue
            capacity = PLANTS[tile.subtype].capacity
            if tile.subtype == "s":
                solar += capacity
            elif tile.subtype == "w":
                wind += capacity
            else:
                steady += capacity
        profile = []
        for minute in range(0, 1441, 30):
            m = minute % 1440
            demand = (constant + night * (1 if m < 360 or m > 1080 else .2)
                      + residential * interpolate(PROFILES["residential"], minute)
                      + sum(total * interpolate(PROFILES[name], minute)
                            for name, total in commercial.items())
                      + industrial * interpolate(PROFILES["industrial"], minute))
            generation = (steady + solar * solar_factor(day + minute)
                          + wind * wind_factor(day + minute, self.seed))
            profile.append({"minute": minute, "demand": round(demand, 3),
                            "generation": round(generation, 3)})
        return profile
