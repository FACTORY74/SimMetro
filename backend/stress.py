"""Continuous construction workload: real commands, catalogue diversity, no population cap.

Plan a complete serviced neighbourhood once, then execute its commands in bounded
chunks. Never demolish user development or invent money/population.
"""
from collections import Counter, deque
from dataclasses import dataclass

from backend.facilities import FACILITIES, Facility
from backend.power import PLANTS
from backend.roads import ROADS
from backend.services import SERVICES
from backend.simulation import SIZE, ADJ, ZONES, VARIANTS
from backend.water_commands import valid_facility


@dataclass
class Action:
    tool: str
    cells: list
    variant: str = ""
    rotation: int = 0
    reason: str = "Stress-test neighbourhood construction"

    @property
    def cost(self):
        price = (ROADS[self.variant].cost if self.tool == "road" else
                 PLANTS[self.variant].cost if self.tool == "power" else
                 FACILITIES[self.variant].cost if self.tool == "waterworks" else
                 SERVICES[self.variant].cost if self.tool == "service" else
                 {"pipe": 3, "powerline": 15, "park": 60, "residential": 8,
                  "commercial": 10, "industrial": 10}[self.tool])
        return price * len(self.cells)


def coverage(city):
    counts = Counter(f"{t.kind}:{t.subtype}" for t in city.tiles if t.kind != "empty")
    counts.update({f"waterworks:{v}": sum(f.variant == v for f in city.facilities.values()) for v in FACILITIES})
    counts["pipe:"] = len(city.pipes)
    expected = [f"{kind}:{v}" for kind, variants in VARIANTS.items() for v in variants] + ["park:", "powerline:", "pipe:"]
    return dict(counts), [key for key in expected if not counts[key]]


class StressPlanner:
    def __init__(self):
        self.queue = deque()
        self.projects = 0
        self.blocked_revision = None
        self.reason = "Ready to expand"

    def clear(self):
        self.queue.clear()
        self.blocked_revision = None

    def next(self, city, reserve):
        if self.queue:
            return self.queue[0]
        available = city.money-reserve
        if available < 8:
            self.reason = "Cash reserve reached; waiting for income"
            return None
        support = self.support(city, available)
        if support:
            self.queue.extend(support)
            return self.queue[0]
        # Do not rerun an exhausted-land search on every electrical dispatch.
        signature = (city.terrain_revision, sum(t.kind != "empty" for t in city.tiles), int(available//1000))
        if self.blocked_revision == signature:
            return None
        dimensions = [(36, 18), (12, 6)] if available >= 30000 else [(12, 6)]
        for width, depth in dimensions:
            project = self.project(city, width, depth, available)
            if project:
                self.projects += 1
                self.queue.extend(project)
                self.reason = f"Building stress neighbourhood {self.projects} ({width} x {depth})"
                return self.queue[0]
        # Spend small balances on existing frontage rather than waiting for a full block.
        frontage = [i for i, t in enumerate(city.tiles) if t.kind == "empty" and not t.water and
                    0 < t.x < SIZE-1 and 0 < t.z < SIZE-1 and any(city.tiles[j].kind == "road" for j in ADJ[i])]
        if frontage:
            kind = ("residential", "commercial", "industrial")[self.projects % 3]
            price = 8 if kind == "residential" else 10
            cells = [(city.tiles[i].x, city.tiles[i].z) for i in frontage[:min(96, int(available//price))]]
            if cells:
                self.projects += 1
                self.queue.append(Action(kind, cells, VARIANTS[kind][self.projects % len(VARIANTS[kind])],
                                         reason="Spend remaining construction funds on existing frontage"))
                return self.queue[0]
        self.blocked_revision = signature
        self.reason = "No affordable dry neighbourhood site or free frontage; district/terrain limit reached"
        return None

    def support(self, city, available):
        # Recover real electrical islands instead of adding generators to the wrong grid.
        for members in city.grid.members.values():
            demand = sum(city.grid.loads.get(i, 0) for i in members)
            generation = sum(max(0, city.grid.outputs.get(i, 0)) for i in members)
            if demand <= generation*.85 or demand < 2:
                continue
            roads = {i for i in members if city.tiles[i].kind == "road"}
            sites = sorted({j for i in roads for j in ADJ[i] if city.tiles[j].kind == "empty" and not city.tiles[j].water})
            variant = "n" if available >= 4000 else "c"
            if sites and available >= PLANTS[variant].cost:
                t = city.tiles[sites[-1]]
                return [Action("power", [(t.x, t.z)], variant, reason="Increase capacity on an overloaded electrical network")]
        # Match pump additions to the pipe island with the shortage.
        networks = {s["network"] for s in city.water_network.services.values()
                    if s["network"] is not None and s["fraction"] < .99}
        for network in sorted(networks):
            roads = {i for i in city.pipes if city.water_network.components.get(i) == network and city.tiles[i].kind == "road"}
            for i in sorted(roads):
                for rotation in range(4):
                    probe = Facility(0, "p", 0, 0, rotation)
                    dx, dz = probe.entrance
                    f = Facility(0, "p", i%SIZE-dx, i//SIZE-dz, rotation)
                    try:
                        valid_facility(city, f, SIZE)
                    except ValueError:
                        continue
                    pipes = [p for p in f.footprint() if p[1]*SIZE+p[0] not in city.pipes]
                    actions = [Action("waterworks", [(f.x, f.z)], "p", rotation,
                                      "Increase supply on an undersupplied water network")]
                    if pipes: actions.append(Action("pipe", pipes))
                    if sum(a.cost for a in actions) <= available:
                        return actions
        return []

    def project(self, city, width, depth, available):
        tiles = city.tiles
        roads = [i for i, t in enumerate(tiles) if t.kind == "road"]
        def empty(i):
            t = tiles[i]
            return t.kind == "empty" and not t.water and 0 < t.x < SIZE-1 and 0 < t.z < SIZE-1
        anchors = [i for i in roads if any(empty(j) for j in ADJ[i])]
        # Spread the sampled frontier across the whole city, not just the original town.
        if len(anchors) > 64:
            anchors = [anchors[k*(len(anchors)-1)//63] for k in range(64)]
        if not anchors:
            anchors = sorted((i for i in range(len(tiles)) if empty(i)),
                             key=lambda i: (abs(i%SIZE-SIZE//2)+abs(i//SIZE-SIZE//2), i))[:64]
        directions = [(1, 0), (0, 1), (-1, 0), (0, -1)]
        directions = directions[self.projects%4:] + directions[:self.projects%4]
        for i in anchors:
            for dx, dz in directions:
                for turn in (-1, 1):
                    sx, sz = -dz*turn, dx*turn
                    streets, lots = [], []
                    valid = True
                    for u in range(width+1):
                        for v in range(depth+1):
                            x, z = i%SIZE+dx*u+sx*v, i//SIZE+dz*u+sz*v
                            if not (0 < x < SIZE-1 and 0 < z < SIZE-1):
                                valid = False; break
                            at = z*SIZE+x
                            if u % 12 == 0 or v % 3 == 0:
                                if tiles[at].kind != "road" and not empty(at):
                                    valid = False; break
                                streets.append((x, z))
                            elif empty(at):
                                lots.append((x, z, u, v))
                        if not valid: break
                    new_streets = [p for p in streets if city.at(*p).kind != "road"]
                    if not valid or len(new_streets) < 6 or len(lots) < (24 if width == 12 else 180):
                        continue
                    actions = self.populate(city, streets, new_streets, lots, depth, available)
                    if actions and sum(a.cost for a in actions) <= available:
                        return actions
        return []

    def populate(self, city, streets, new_streets, lots, depth, available):
        counts, missing = coverage(city)
        road_variant = next((v for v in "rsae" if f"road:{v}" in missing), "a" if self.projects%3 else "e")
        actions = [Action("road", new_streets, road_variant, reason="Lay a stress-test street grid across new land")]
        street_set = set(streets)
        free = {(x, z) for x, z, _, _ in lots}
        facilities = []
        for variant in ("p", "t"):
            found = None
            for x, z in sorted(free):
                for rotation in range(4):
                    f = Facility(0, variant, x, z, rotation)
                    if f.entrance not in street_set or not set(f.footprint()) <= free:
                        continue
                    try: valid_facility(city, f, SIZE)
                    except ValueError: continue
                    found = f; break
                if found: break
            if found:
                free.difference_update(found.footprint())
                facilities.append(found)
        if not any(f.variant == "p" for f in facilities):
            return []
        pipes = sorted((street_set | {p for f in facilities for p in f.footprint()}) -
                       {(i%SIZE, i//SIZE) for i in city.pipes})
        for start in range(0, len(pipes), 400): actions.append(Action("pipe", pipes[start:start+400]))
        # At least one dependable generator in every new neighbourhood. Rich runs
        # add all missing generator/storage types to exercise their models and dispatch.
        power_types = ["n" if available >= 30000 else "c"]
        power_types += [v for v in "csnwb" if f"power:{v}" in missing and v not in power_types]
        if available < 12000: power_types = power_types[:1]
        for variant in power_types:
            if not free: return []
            cell = min(free)
            free.remove(cell)
            actions.append(Action("power", [cell], variant, reason="Exercise generation/storage catalogue and supply the new district blocks"))
        for f in facilities:
            actions.append(Action("waterworks", [(f.x, f.z)], f.variant, f.rotation))
        for variant in SERVICES:
            if f"service:{variant}" not in missing or not free:
                continue
            cell = min(free)
            free.remove(cell)
            actions.append(Action("service", [cell], variant, reason="Exercise public-service coverage catalogue"))
        # Park and pylon tiles are permanent infrastructure, never disposable churn.
        for tool, count in (("park", max(2, len(free)//24)), ("powerline", 2)):
            cells = sorted(free)[::max(1, len(free)//count)][:count]
            free.difference_update(cells)
            if cells: actions.append(Action(tool, cells))
        groups = {}
        for x, z, u, v in lots:
            if (x, z) not in free: continue
            kind = "residential" if v <= depth*.5 else "commercial" if v <= depth*.7 else "industrial"
            variant = VARIANTS[kind][(u//3 + self.projects) % len(VARIANTS[kind])]
            groups.setdefault((kind, variant), []).append((x, z))
        for (kind, variant), cells in groups.items():
            for start in range(0, len(cells), 400):
                actions.append(Action(kind, cells[start:start+400], variant, reason="Zone every street-facing lot; cycle all implemented zone subtypes"))
        return actions
