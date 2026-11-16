"""Deterministic development player. All construction goes through City.build.

Run isolated scenarios with: python -m backend.autoplay --months 120 --seed 42
"""
import argparse
import json
import math
import time
from collections import deque
from pathlib import Path

from backend.simulation import ADJ, SIZE, City, COSTS, ZONES
from backend.stress import StressPlanner, coverage
from backend.roads import ROADS
from backend.power import PLANTS
from backend.services import SERVICES
from backend.facilities import FACILITIES, Facility
from backend.water_commands import valid_facility


MAX_ACTIONS = 12
HOUSING_BATCH = 12
BUSINESS_BATCH = 6


class AutoPlayer:
    def __init__(self, reserve=5000, target=2000, mode="stress"):
        if mode not in ("stress", "growth"):
            raise ValueError("Unknown autoplay mode")
        self.mode = mode
        self.stress = StressPlanner()
        self.last_work_ms = 0.
        self.last_plan_ms = 0.
        self.last_build_ms = 0.
        self.simulation_ms = 0.
        self.coverage = {}
        self.missing = []
        self.last_commands = []
        self.reserve = reserve
        self.target = target
        self.enabled = False
        self.last_tick = -1
        self.actions = 0
        self.spent = 0
        self.blocks_built = 0
        self.reason = "Stopped"
        self.log = deque(maxlen=30)
        self.planned_rotation = 0

    def status(self):
        return dict(enabled=self.enabled, reserve=self.reserve, target=self.target, mode=self.mode,
                    pendingActions=len(self.stress.queue), workMs=round(self.last_work_ms, 2),
                    planMs=round(self.last_plan_ms, 2), buildMs=round(self.last_build_ms, 2), simulationMs=round(self.simulation_ms, 2),
                    coverage=self.coverage, missingTypes=self.missing,
                    actions=self.actions, spent=self.spent, reason=self.reason, actionsPerMonth=MAX_ACTIONS if self.mode == "growth" else None, blocksBuilt=self.blocks_built, log=list(self.log))

    def affordable(self, city, command):
        tool, cells, variant = command
        price = PLANTS[variant].cost if tool == "power" else FACILITIES[variant].cost if tool == "waterworks" else SERVICES[variant].cost if tool == "service" else ROADS[variant].cost if tool == "road" else COSTS[tool]
        if self.mode == "stress":
            return city.money - price * len(cells) >= self.reserve
        upkeep = PLANTS[variant].upkeep if tool == "power" else FACILITIES[variant].upkeep if tool == "waterworks" else SERVICES[variant].upkeep if tool == "service" else 2 if tool == "road" else 8 if tool == "park" else 0
        floor = self.reserve + 6 * max(0, city.expenses + upkeep * len(cells) - city.income)
        if tool == "road" and len(cells) >= 16:
            # A full block also needs pipes, zoning and its next utility connection.
            floor += 1000 + 3 * len(cells)
        return city.money - price * len(cells) >= floor

    def step(self, city, *, max_actions=None, time_budget_ms=None):
        self.last_commands = []
        if self.mode == "stress":
            return self.stress_step(city, max_actions or 64, time_budget_ms)
        return self.growth_step(city)

    def stress_step(self, city, max_actions, time_budget_ms):
        if not self.enabled or not city.speed:
            return False
        started = time.perf_counter()
        self.last_plan_ms = self.last_build_ms = 0.
        changed = False
        for _ in range(max_actions):
            planning = time.perf_counter()
            action = self.stress.next(city, self.reserve)
            self.last_plan_ms += (time.perf_counter()-planning)*1000
            if action is None:
                self.reason = self.stress.reason
                break
            if city.money-action.cost < self.reserve:
                self.reason = "Cash reserve reached; queued construction resumes when income permits"
                break
            building = time.perf_counter()
            try:
                if action.tool != "pipe" and any(city.at(x, z).kind != "empty" for x, z in action.cells):
                    raise ValueError("Queued site was occupied after planning")
                cost = city.build(action.tool, action.cells, action.variant, rotation=action.rotation, preserve_border=True)
            except ValueError as exc:
                self.stress.clear()
                self.reason = f"Replanning after a changed/blocked site: {exc}"
                break
            self.last_build_ms += (time.perf_counter()-building)*1000
            self.stress.queue.popleft()
            if cost:
                self.actions += 1
                self.spent += cost
                if action.tool == "road" and len(action.cells) >= 16: self.blocks_built += 1
                entry = dict(month=city.tick, tool=action.tool, cells=action.cells, variant=action.variant,
                             cost=cost, money=city.money, reason=action.reason, rotation=action.rotation)
                self.log.append(entry)
                self.last_commands.append(entry)
                changed = True
            self.reason = f"Stress expansion active / {len(self.stress.queue)} queued commands / no population cap"
            if time_budget_ms is not None and (time.perf_counter()-started)*1000 >= time_budget_ms:
                break  # Yield between atomic commands; a single command can exceed this soft budget.
        self.last_work_ms = (time.perf_counter()-started)*1000
        self.coverage, self.missing = coverage(city)
        return changed

    def growth_step(self, city):
        if not self.enabled or not city.speed or city.tick == self.last_tick:
            return False
        self.last_tick = city.tick
        if city.population >= self.target and city.water_network.summary["unserved"] < .01:
            self.enabled = False
            self.reason = "Population target reached"
            return False
        changed = False
        previous_actions = self.actions
        for _ in range(MAX_ACTIONS):
            command, reason = self.choose(city)
            self.reason = reason
            if command is None:
                break
            tool, cells, variant = command
            if not self.affordable(city, command):
                self.reason = "Waiting for income: preserving reserve and six-month deficit runway"
                break
            try:
                cost = city.build(tool, cells, variant, preserve_border=True, rotation=self.planned_rotation)
            except ValueError as exc:
                self.reason = f"Construction blocked: {exc}"
                break
            self.actions += 1
            self.spent += cost
            if tool == "road" and len(cells) >= 16:
                self.blocks_built += 1
            self.log.append(dict(month=city.tick, tool=tool, cells=cells, variant=variant,
                                 cost=cost, money=city.money, reason=reason, rotation=self.planned_rotation))
            changed = True
        self.last_commands = list(self.log)[-(self.actions-previous_actions):] if changed else []
        return changed

    def choose(self, city):
        self.planned_rotation = 0
        tiles = city.tiles
        roads = [i for i, t in enumerate(tiles) if t.kind == "road"]
        def empty(i):
            t = tiles[i]
            return t.kind == "empty" and not t.water and 1 <= t.x < SIZE-1 and 1 <= t.z < SIZE-1
        def command(tool, ids, variant, reason):
            return (tool, [(tiles[i].x, tiles[i].z) for i in ids], variant), reason
        if not roads:
            sites = [i for i in range(len(tiles)) if empty(i) and all(empty(j) for j in ADJ[i])]
            if not sites:
                return None, "No dry site for a starter road"
            i = min(sites, key=lambda i: (abs(tiles[i].x-SIZE//2)+abs(tiles[i].z-SIZE//2), i))
            return command("road", [i], "r", "Start a connected neighbourhood")
        # Grow one network, preferring the existing populated town's largest road component.
        groups = {}
        for i in roads:
            groups.setdefault(city._components[i], []).append(i)
        network = max(groups.values(), key=len)
        frontage = sorted({j for i in network for j in ADJ[i] if empty(j)})
        network_set = set(network)
        lots = [t for i, t in enumerate(tiles) if t.kind in ZONES and any(j in network_set for j in ADJ[i])]
        expansion, _ = self.extend(city, network, empty)
        reserved = set(expansion[1]) if expansion else set()
        powered = [i for i in frontage if (tiles[i].x, tiles[i].z) not in reserved]
        powered = [i for i in powered if any(j in network_set and tiles[j].powered for j in ADJ[i])]
        plants = [t for i, t in enumerate(tiles) if t.kind == "power" and any(j in network_set for j in ADJ[i])]
        if not plants or any(not t.powered for t in lots) or city.grid.summary["demand"] > city.grid.summary["capacity"] * .75:
            if frontage:
                return command("power", [frontage[-1]], "c", "Provide reliable power before further growth")
            return self.extend(city, network, empty)
        # Service roads underground before adding more consumers. Facility connectors
        # join the same network through their footprint, including rotated entrances.
        local_facilities = [f for f in city.facilities.values() if f.entrance[1]*SIZE+f.entrance[0] in network_set]
        required_pipes = network_set | {z*SIZE+x for f in local_facilities for x, z in f.footprint()}
        missing = sorted(required_pipes - city.pipes)
        if missing:
            return command("pipe", missing[:400], "", "Connect roads and facility anchors to the water network")
        local_pumps = [f for f in local_facilities if f.variant == "p"]
        needs_pump = not local_pumps or city.water_network.summary["demand"] > sum(FACILITIES["p"].production for f in local_pumps) * .8
        needs_tower = not any(f.variant == "t" for f in local_facilities) and city.money > self.reserve + 2500
        if needs_pump or needs_tower:
            variant = "p" if needs_pump else "t"
            for i in reversed(network):
                for rotation in range(4):
                    probe = Facility(0, variant, 0, 0, rotation)
                    dx, dz = probe.entrance
                    f = Facility(0, variant, tiles[i].x-dx, tiles[i].z-dz, rotation)
                    if any(p in reserved for p in f.footprint()):
                        continue
                    try:
                        valid_facility(city, f, SIZE)
                    except ValueError:
                        continue
                    self.planned_rotation = rotation
                    return ("waterworks", [(f.x, f.z)], variant), "Add water production" if needs_pump else "Add outage storage"
            if needs_pump:
                return self.extend(city, network, empty)
        # Improve existing low-suitability homes before buying more vacant zoning.
        # Only add an amenity if its uncapped contribution can address current conditions.
        suitability = city.desirability()["lots"]
        needy = [t for t in lots if t.kind == "residential" and t.residents > 0
                 and suitability[str(t.z*SIZE+t.x)]["target"] < 50
                 and next(c["points"] for c in suitability[str(t.z*SIZE+t.x)]["components"] if c["label"] == "Parks") < 20]
        if needy and city.income-city.expenses >= 16:
            sites = [(sum(abs(tiles[i].x-t.x) <= 2 and abs(tiles[i].z-t.z) <= 2 for t in needy), i)
                     for i in powered]
            if sites and max(sites)[0] > 0:
                return command("park", [max(sites)[1]], "", "Improve low residential desirability with an accessible park")
        # Maintain a substantial pipeline instead of waiting for almost every
        # existing home to fill. Plan employment for incoming residents as well.
        homes = [t for t in lots if t.kind == "residential"]
        industry = [t for t in lots if t.kind == "industrial"]
        viable_homes = [t for t in homes if not any(abs(t.x-b.x) <= 2 and abs(t.z-b.z) <= 2 for b in industry)]
        open_housing = sum(max(48, t.level * 24) - t.residents for t in viable_homes)
        desired_housing = min(max(1536, city.population * 1.5), max(0, self.target-city.population))
        future_workers = (city.population + min(open_housing, desired_housing)) * .55
        committed_jobs = {kind: sum(max(t.job_capacity, t.jobs_per_level * 2) for t in lots if t.kind == kind)
                          for kind in ("commercial", "industrial")}
        deficits = {"residential": desired_housing-open_housing,
                    "commercial": future_workers*.4-committed_jobs["commercial"],
                    "industrial": future_workers*.6-committed_jobs["industrial"]}
        # Balance prospective jobs even when today's residents have not arrived.
        options = [kind for kind in ("residential", "commercial", "industrial") if deficits[kind] > 0]
        if not options:
            return None, "Neighbourhood pipeline ready: waiting for residents and businesses to develop"
        tool = options[0]
        batch = min(HOUSING_BATCH, max(1, math.ceil(deficits[tool]/48))) if tool == "residential" else min(
            BUSINESS_BATCH, max(1, math.ceil(deficits[tool]/(24 if tool == "commercial" else 40))))
        open_first_block = self.blocks_built == 0 and city.population > 0 and self.target-city.population >= 500
        if expansion and len(expansion[1]) >= 16 and open_first_block and self.affordable(city, expansion):
            return expansion, "Prepare the first expansion neighbourhood while existing lots keep growing"
        if len(powered) < batch + 24 and expansion and self.affordable(city, expansion):
            # Open the next block before the last usable frontage is consumed.
            return expansion, "Open the next connected block ahead of zoning demand"
        if not powered:
            return self.extend(city, network, empty)
        # Keep manufacturing away from housing; stable tie-breaking makes runs reproducible.
        industry = [t for t in lots if t.kind == "industrial"]
        avoid = industry if tool == "residential" else homes if tool == "industrial" else []
        if avoid:
            powered = [i for i in powered if all(abs(tiles[i].x-t.x) > 2 or abs(tiles[i].z-t.z) > 2 for t in avoid)]
        if not powered:
            return self.extend(city, network, empty)
        ranked = sorted(powered, key=lambda i: (-min((abs(tiles[i].x-t.x)+abs(tiles[i].z-t.z) for t in avoid), default=0), i))
        return command(tool, ranked[:batch], {"residential": "m", "commercial": "r", "industrial": "m"}[tool],
                       "Zone a neighbourhood batch for current and incoming residents")

    @staticmethod
    def extend(city, network, empty):
        """Attach compact 12-by-6 street blocks, with a middle street so every
        interior lot has frontage. Reject blocked/wet routes as a whole."""
        network_set = set(network)
        # Examine useful edges first; cap planning work on very large networks.
        anchors = [i for i in network if any(empty(j) for j in ADJ[i])]
        if len(anchors) > 96:
            anchors = [anchors[k*(len(anchors)-1)//95] for k in range(96)]
        best = None
        for i in anchors:
            t = city.tiles[i]
            for dx, dz in ((1, 0), (0, 1), (-1, 0), (0, -1)):
                for turn in (-1, 1):
                    sx, sz = -dz*turn, dx*turn
                    route, interior = [], []
                    valid = True
                    for u in range(13):
                        for v in range(7):
                            x, z = t.x+dx*u+sx*v, t.z+dz*u+sz*v
                            if not (1 <= x < SIZE-1 and 1 <= z < SIZE-1):
                                valid = False
                                break
                            at = z*SIZE+x
                            if u in (0, 12) or v in (0, 3, 6):
                                if at not in network_set and not empty(at):
                                    valid = False
                                    break
                                if at not in network_set:
                                    route.append((x, z))
                            elif empty(at):
                                interior.append(at)
                        if not valid:
                            break
                    if not valid or len(route) < 12 or len(interior) < 24:
                        continue
                    # Prefer filling adjacent space over paying for isolated corridors.
                    score = len(interior)*3-len(route)
                    if best is None or score > best[0]:
                        best = (score, route)
        if best:
            return ("road", best[1], "r"), "Lay out a connected neighbourhood block with three parallel streets"
        # Tight terrain can still expand along an ordinary street.
        for i in network:
            t = city.tiles[i]
            for dx, dz in ((1, 0), (0, 1), (-1, 0), (0, -1)):
                cells = []
                for n in range(1, 13):
                    x, z = t.x + dx*n, t.z + dz*n
                    if not (1 <= x < SIZE-1 and 1 <= z < SIZE-1) or not empty(z*SIZE+x):
                        break
                    cells.append((x, z))
                if len(cells) >= 3:
                    return ("road", cells, "r"), "Extend a connected street where terrain prevents a full block"
        return None, "No safe expansion corridor; manual intervention needed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--months", type=int, default=120)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--reserve", type=int, default=5000)
    parser.add_argument("--target", type=int, default=2000)
    parser.add_argument("--mode", choices=("stress", "growth"), default="stress")
    parser.add_argument("--actions-per-month", type=int, default=64, help="Deterministic headless stress workload; live mode runs continuously")
    parser.add_argument("--starting-money", type=int, help="Explicit initial treasury for an isolated benchmark; never changes the live city")
    parser.add_argument("--empty", action="store_true", help="Start without the starter town")
    parser.add_argument("--output", type=Path, help="Write report and loadable city save to this directory")
    args = parser.parse_args()
    if not 1 <= args.months <= 10000 or args.reserve < 0 or args.target < 1 or not 1 <= args.actions_per_month <= 1024 or (args.starting_money is not None and args.starting_money < 0):
        parser.error("months must be 1..10000; reserve and starting-money >= 0; target >= 1; actions-per-month 1..1024")
    city = City(seed=args.seed, starter=not args.empty)
    if args.starting_money is not None: city.money = args.starting_money
    player = AutoPlayer(args.reserve, args.target, args.mode)
    player.enabled = True
    history, commands = [], []
    for _ in range(args.months):
        player.step(city, max_actions=args.actions_per_month)
        commands.extend(player.last_commands)
        started = time.perf_counter()
        city.run(2)
        player.simulation_ms = (time.perf_counter()-started)*1000
        history.append(dict(month=city.tick, population=city.population, money=city.money,
                            income=city.income, expenses=city.expenses, waterUnserved=city.water_network.summary["unserved"],
                            waterStorage=city.water_network.summary["storage"],
                            roadTiles=sum(t.kind == "road" for t in city.tiles),
                            zonedTiles=sum(t.kind in ZONES for t in city.tiles), simulationMs=round(player.simulation_ms, 2),
                            constructionMs=round(player.last_work_ms, 2), reason=player.reason))
    timings = sorted(row["simulationMs"] for row in history)
    report = dict(seed=args.seed, policy="continuous-stress-v5" if args.mode == "stress" else "assertive-blocks-v4",
                  startingMoney=args.starting_money if args.starting_money is not None else 24000,
                  actionsPerMonth=args.actions_per_month, simulationP95Ms=timings[min(len(timings)-1, math.ceil(len(timings)*.95)-1)],
                  status=player.status(), history=history, commands=commands)
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        (args.output / "city.json").write_text(json.dumps(city.save_data()), encoding="utf-8")
    print(json.dumps(dict(seed=args.seed, **history[-1], actions=player.actions, spent=player.spent, missingTypes=player.missing, simulationP95Ms=report["simulationP95Ms"])))


if __name__ == "__main__":
    main()
