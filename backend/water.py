"""District-local pipe networks. Rates m3/day; stocks m3; elapsed time in minutes.

Pipes service lots within Manhattan distance two. Each lot belongs to its nearest
pipe, ties by tile index, independently of whether that network has supply.
"""
from collections import deque
from backend.facilities import FACILITIES

RADIUS = 2
PIPE_COST = 3
PIPE_UPKEEP = 0  # Maintenance included in facility operating costs for this slice.


def demand(tile):
    if tile.kind == "residential":
        return .5 + tile.residents * .15
    if tile.kind in ("commercial", "industrial"):
        return .5 + tile.workers * (.5 if tile.kind == "industrial" else .25)
    if tile.kind == "power":
        return 6 if tile.subtype in ("c", "n") else 0
    return 0


class WaterNetwork:
    def __init__(self, city):
        self.city = city
        self.components = {}
        self.members = {}
        size = city.size if hasattr(city, "size") else int(len(city.tiles) ** .5)
        self.size = size
        for i in sorted(city.pipes):
            if i in self.components:
                continue
            self.components[i] = i
            queue = deque([i])
            members = []
            while queue:
                at = queue.popleft()
                members.append(at)
                for j in self.adjacent(at):
                    if j in city.pipes and j not in self.components:
                        self.components[j] = i
                        queue.append(j)
            self.members[i] = members
        self.coverage = {}
        # O(pipes * fixed radius), rather than scanning every pipe for every lot.
        nearest = {}
        for i in sorted(city.pipes):
            x, z = i % size, i // size
            for dz in range(-RADIUS, RADIUS + 1):
                for dx in range(-RADIUS + abs(dz), RADIUS - abs(dz) + 1):
                    if 0 <= x + dx < size and 0 <= z + dz < size:
                        j = (z + dz) * size + x + dx
                        candidate = (abs(dx) + abs(dz), i)
                        if candidate < nearest.get(j, (999, 999999999)):
                            nearest[j] = candidate
        self.coverage = {j: self.components[i] for j, (_, i) in nearest.items()}
        self.consumers = [i for i, t in enumerate(city.tiles) if t.kind in ("residential", "commercial", "industrial", "power")]
        self.services = {}
        self.facility_status = {}
        self.summary = {}

    def adjacent(self, i):
        x, z, n = i % self.size, i // self.size, self.size
        return [nz * n + nx for nx, nz in ((x-1, z), (x+1, z), (x, z-1), (x, z+1))
                if 0 <= nx < n and 0 <= nz < n]

    def dispatch(self, minutes=0):
        city, size = self.city, self.size
        days = (minutes or 5) / 1440
        rates = {i: demand(city.tiles[i]) for i in self.consumers}
        requested = {key: 0. for key in self.members}
        for i, rate in rates.items():
            key = self.coverage.get(i)
            if key is not None:
                requested[key] += rate
        pumps = {key: 0. for key in self.members}
        towers = {key: [] for key in self.members}
        self.facility_status = {}
        for f in sorted(city.facilities.values(), key=lambda f: f.id):
            key = self.components.get(f.z * size + f.x)
            ex, ez = f.entrance
            road = 0 <= ex < size and 0 <= ez < size and city.at(ex, ez).kind == "road"
            power = city.at(f.x, f.z).powered
            reason = "No entrance road" if not road else "No power" if not power else "No connector pipe" if key is None else "Operating"
            operating = reason == "Operating"
            spec = FACILITIES[f.variant]
            self.facility_status[f.id] = dict(reason=reason, operating=operating, network=key,
                                              production=spec.production if operating else 0)
            if operating:
                pumps[key] += spec.production
                if spec.storage:
                    towers[key].append(f)
        fractions = {}
        produced = served = charging = discharging = spilled = 0.
        for key in self.members:
            need, output = requested[key], pumps[key]
            available = output
            surplus = output - need
            for f in towers[key]:
                if surplus >= 0:
                    charge = min(surplus, max(0, FACILITIES[f.variant].storage - f.stored) / days)
                    if minutes:
                        f.stored = min(FACILITIES[f.variant].storage, f.stored + charge * days)
                    surplus -= charge
                    charging += charge
                else:
                    discharge = min(-surplus, f.stored / days)
                    if minutes:
                        f.stored = max(0., f.stored - discharge * days)
                    surplus += discharge
                    available += discharge
                    discharging += discharge
            fractions[key] = min(1., available / need) if need else (1. if output or towers[key] else 0.)
            produced += output
            served += min(need, available)
            spilled += max(0, surplus)
        self.services = {}
        for i, rate in rates.items():
            key = self.coverage.get(i)
            fraction = fractions.get(key, 0.)
            reason = "No pipe coverage" if key is None else "Supplied" if fraction >= .999999 else "Insufficient supply or stored water"
            self.services[i] = dict(requested=rate, served=rate * fraction, fraction=fraction, network=key, reason=reason)
        self.summary = dict(demand=sum(rates.values()), production=produced, served=served,
                            unserved=max(0., sum(rates.values())-served), charging=charging,
                            discharging=discharging, spilled=spilled,
                            storage=sum(f.stored for f in city.facilities.values()),
                            storageCapacity=sum(FACILITIES[f.variant].storage for f in city.facilities.values()),
                            networks=len(self.members), graceMonths=city.water_grace)

    def supplied(self, i):
        return self.city.water_grace > 0 or self.services.get(i, {}).get("fraction", 0.) >= .999999

    def data(self):
        return dict(summary=self.summary, pipes=sorted(self.city.pipes), radius=RADIUS,
                    services={str(i): s for i, s in self.services.items()},
                    facilities=[{**f.record(), **self.facility_status[f.id],
                                 "footprint": f.footprint(), "entrance": f.entrance,
                                 "capacity": FACILITIES[f.variant].production,
                                 "storageCapacity": FACILITIES[f.variant].storage,
                                 "upkeep": FACILITIES[f.variant].upkeep}
                                for f in self.city.facilities.values()])
