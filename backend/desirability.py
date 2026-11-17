"""Explainable location suitability, separate from demand and service eligibility.

Balance profile v1: indices in points, bounded to 0..100. Only monthly commits
change smoothed scores or decline counters; inspection is a pure calculation.
"""
import math
from backend.services import SERVICES
from backend.catalogue import definition, definitions

VERSION = 1
ZONES = {"residential", "commercial", "industrial"}
GROWTH_SCORE = 50
DECLINE_SCORE = 40
RECOVERY_SCORE = 45
SMOOTHING = .35
PROFILES = {row["desirability"]["profile"]: (row["desirability"]["parkWeight"],
                                             row["desirability"]["parkCap"],
                                             row["desirability"]["industryPenalty"])
            for (kind, _), row in definitions().items() if kind in ZONES}


def sample_services(city, minutes):
    """Time-weighted service observations; no dependency on rendering or polling."""
    for i in city.water_network.consumers:
        t = city.tiles[i]
        if t.kind not in ZONES:
            continue
        sample = city.desirability_samples.setdefault(i, [0., 0., 0.])
        sample[0] += minutes
        sample[1] += minutes * bool(t.powered)
        sample[2] += minutes * city.water_network.services.get(i, {}).get("fraction", 0.)


def _amenity_index(city, size):
    """Window-scan inputs resolved once per evaluation instead of per lot.

    Returns a prefix-sum grid of developed manufacturing lots and, for each park
    tile, the set of road networks it is connected to.
    """
    manufacturing = [0] * ((size + 1) * (size + 1))
    park_networks: dict[int, frozenset] = {}
    components = city._components
    for i, tile in enumerate(city.tiles):
        if tile.kind == "industrial" and tile.level > 0 and tile.subtype == "m":
            manufacturing[(tile.z + 1) * (size + 1) + tile.x + 1] = 1
        elif tile.kind == "park":
            x, z = tile.x, tile.z
            park_networks[i] = frozenset(
                components[b * size + a] for a, b in ((x-1, z), (x+1, z), (x, z-1), (x, z+1))
                if 0 <= a < size and 0 <= b < size and components[b * size + a] >= 0)
    width = size + 1
    for z in range(1, width):
        row = z * width
        above = row - width
        total = 0
        for x in range(1, width):
            total += manufacturing[row + x]
            manufacturing[row + x] = total + manufacturing[above + x]
        manufacturing[row] = 0
    return manufacturing, park_networks


def evaluate(city, plan=None, *, monthly=False):
    plan = city.traffic() if plan is None else plan
    size = int(len(city.tiles) ** .5)
    manufacturing, park_networks = _amenity_index(city, size)
    parks_near: dict[int, list[int]] = {}
    for i, networks in park_networks.items():
        x, z = i % size, i // size
        for pz in range(max(0, z - 2), min(size, z + 3)):
            for px in range(max(0, x - 2), min(size, x + 3)):
                parks_near.setdefault(pz * size + px, []).append(i)
    operating_services = [(t.x, t.z, t.subtype, SERVICES[t.subtype]) for t in city.tiles
                          if t.kind == "service" and t.powered and t.road_access]
    land_impacts = []
    for source in city.tiles:
        if source.kind != "power":
            continue
        impact = definition("power", source.subtype).get("landDesirability")
        if not impact or source.installation_part > 0:
            continue
        installation = definition("power", source.subtype).get("installation")
        offset = (installation["width"] - 1) / 2 if installation and source.installation_part >= 0 else 0
        land_impacts.append((source.x + offset, source.z + offset, impact))
    jobs, labor, vacant = {}, {}, {}
    district_of = {}
    for i, tile in enumerate(city.tiles):
        if tile.kind not in ZONES:
            continue
        x, z = tile.x, tile.z
        neighbours = ((x-1, z), (x+1, z), (x, z-1), (x, z+1))
        networks = [city._components[b*size+a] for a, b in neighbours
                    if 0 <= a < size and 0 <= b < size and city._components[b*size+a] >= 0]
        district_of[i] = min(networks) if networks else None
        district = district_of[i]
        if tile.kind == "residential":
            labor[district] = labor.get(district, 0) + tile.labor
        elif tile.powered:
            jobs[district] = jobs.get(district, 0) + tile.job_capacity
            vacant[district] = vacant.get(district, 0) + max(0, tile.job_capacity-tile.workers)
    trips = {}
    for trip, minutes in zip(plan.trips, plan.minutes):
        if trip.kind != "w":
            continue
        for i in (trip.origin, trip.destination):
            count, weighted, failed = trips.get(i, (0, 0., 0))
            trips[i] = (count+trip.count, weighted+minutes*trip.count, failed+(0 if trip.route else trip.count))
    rows = {}
    for i, district in district_of.items():
        tile = city.tiles[i]
        profile = definition(tile.kind, tile.subtype)["desirability"]["profile"]
        park_weight, park_cap, industry_weight = PROFILES[profile]
        x0, z0 = max(0, tile.x - 2), max(0, tile.z - 2)
        x1, z1 = min(size, tile.x + 3), min(size, tile.z + 3)
        width = size + 1
        industry = (manufacturing[z1 * width + x1] - manufacturing[z0 * width + x1]
                    - manufacturing[z1 * width + x0] + manufacturing[z0 * width + x0])
        if tile.kind == "industrial" and tile.level > 0 and tile.subtype == "m":
            industry -= 1
        # Same local radius as the original amenity rule, now explained and shared.
        parks = 0
        if district is not None:
            nearby = parks_near.get(i)
            if nearby:
                parks = sum(district in park_networks[p] for p in nearby)
        prior = city.desirability_state.get(i)
        sample = city.desirability_samples.get(i)
        service = city.water_network.services.get(i, {})
        if monthly and sample and sample[0] > 0:
            power, water = sample[1]/sample[0], sample[2]/sample[0]
        elif prior and not monthly:
            power, water = prior["power"], prior["water"]
        else:
            power, water = float(tile.powered), service.get("fraction", 0.)
        count, weighted, failed = trips.get(i, (0, 0., 0))
        commute = weighted/count if count else None
        commute_penalty = min(25., max(0., (commute or 0)-20)*.75 + (25*failed/count if count else 0))
        job_points = (15 if vacant.get(district, 0) else 0) if tile.kind == "residential" else (10 if labor.get(district, 0) > 0 else -10)
        if district is None:
            job_points = 0
        components = [
            dict(label="Base suitability", points=50., detail=f"{profile.replace('_', ' ')} profile"),
            dict(label="Road access", points=0. if tile.road_access else -35., detail="Connected frontage" if tile.road_access else "No adjacent road"),
            dict(label="Local jobs" if tile.kind == "residential" else "Local workforce", points=float(job_points),
                 detail=f"{jobs.get(district, 0) if district is not None else 0} job places; {labor.get(district, 0) if district is not None else 0} workers on this road network"),
            dict(label="Parks", points=float(min(park_cap, parks*park_weight)), detail=f"{parks} road-accessible parks within two tiles; bonus capped at {park_cap}"),
            dict(label="Industrial nuisance", points=-float(min(40, industry*industry_weight)), detail=f"{industry} developed manufacturing lots nearby; proximity index, not simulated pollution"),
            dict(label="Commute", points=round(-commute_penalty, 2), detail=f"{commute:.1f} min weighted one-way commute; {failed} unrouted commuters" if count else "No assigned commute yet; neutral"),
            dict(label="Power reliability", points=round(-25*(1-power), 2), detail=f"{power:.0%} served during last monthly sample"),
            dict(label="Water reliability", points=0. if city.water_grace else round(-25*(1-water), 2),
                 detail=f"{water:.0%} served during last monthly sample" + (f"; {city.water_grace}-month migration grace" if city.water_grace else "")),
        ]
        for ix, iz, impact in land_impacts:
            distance = math.hypot(tile.x - ix, tile.z - iz)
            affected = distance <= impact.get("radius", 0)
            components.append(dict(label=impact.get("label", "Land-use impact"),
                points=float(impact.get("points", 0) if affected else 0),
                detail=(f"Within {impact['radius']}-tile impact radius; source {distance:.1f} tiles away"
                        if affected else f"Outside {impact.get('radius', 0)}-tile impact radius")))
        for variant, service in SERVICES.items():
            distances = [math.hypot(tile.x-sx, tile.z-sz) for sx, sz, kind, _ in operating_services if kind == variant]
            nearest = min(distances) if distances else None
            covered = nearest is not None and nearest <= service.radius
            components.append(dict(label=service.name, points=float(service.points[tile.kind] if covered else 0),
                detail=(f"Covered; nearest operating facility {nearest:.1f} tiles away, radius {service.radius}"
                        if covered else f"Not covered by an operating facility; radius {service.radius}")))
        raw = round(max(0., min(100., sum(c["points"] for c in components))), 2)
        score = prior["score"] if prior else raw
        if monthly:
            score = round(score + SMOOTHING*(raw-score), 2)
            if abs(score-raw) < .5:
                score = raw
        blockers = []
        if not tile.road_access: blockers.append("No road access")
        if not tile.powered: blockers.append("No power")
        if not city.water_network.supplied(i): blockers.append("Water shortage")
        if score < GROWTH_SCORE: blockers.append("Desirability below 50")
        poor = prior["poor"] if prior else 0
        if monthly:
            poor = min(120, poor+1) if score < DECLINE_SCORE else 0 if score >= RECOVERY_SCORE else poor
        rows[str(i)] = dict(score=score, target=raw, profile=profile, components=components,
                            powerReliability=power, waterReliability=water, poorMonths=poor,
                            commuteMinutes=round(commute, 1) if commute is not None else None,
                            demand=city.demand[tile.kind], blockers=blockers,
                            eligible=not blockers, declining=score < DECLINE_SCORE and poor >= 3,
                            updatedMonth=city.tick if monthly else prior["month"] if prior else None)
    return dict(version=VERSION, growthThreshold=GROWTH_SCORE, declineThreshold=DECLINE_SCORE,
                recoveryThreshold=RECOVERY_SCORE, smoothing=SMOOTHING, lots=rows)


def commit(city):
    data = evaluate(city, monthly=True)
    city.desirability_state = {int(i): dict(score=r["score"], poor=r["poorMonths"], month=city.tick,
                                         power=r["powerReliability"], water=r["waterReliability"])
                               for i, r in data["lots"].items()}
    city.desirability_samples = {}
    return data["lots"]


def restore(city, data):
    raw = data.get("desirability")
    if raw is None and data["version"] < 8:
        return  # Scores initialise from real conditions, with no accumulated decline.
    if not isinstance(raw, dict) or raw.get("version") != VERSION:
        raise ValueError("Invalid saved desirability state.")
    state, samples = raw.get("state"), raw.get("samples")
    if not isinstance(state, dict) or not isinstance(samples, dict):
        raise ValueError("Invalid saved desirability fields.")
    def index(key):
        if (not isinstance(key, str) or not key.isdecimal() or str(int(key)) != key or
                not 0 <= int(key) < len(city.tiles) or city.tiles[int(key)].kind not in ZONES):
            raise ValueError("Invalid saved desirability lot.")
        return int(key)
    def number(n, low, high):
        return type(n) in (float, int) and math.isfinite(n) and low <= n <= high
    for key, row in state.items():
        i = index(key)
        if (not isinstance(row, dict) or set(row) != {"score", "poor", "month", "power", "water"} or
                not number(row["score"], 0, 100) or not number(row["power"], 0, 1) or not number(row["water"], 0, 1) or
                type(row["poor"]) is not int or not 0 <= row["poor"] <= 120 or
                type(row["month"]) is not int or not 0 <= row["month"] <= data["tick"]):
            raise ValueError("Invalid saved desirability score.")
        city.desirability_state[i] = dict(row)
    for key, sample in samples.items():
        i = index(key)
        if (not isinstance(sample, list) or len(sample) != 3 or not number(sample[0], 0, 43200) or
                any(not number(n, 0, sample[0]) for n in sample[1:])):
            raise ValueError("Invalid saved service reliability sample.")
        city.desirability_samples[i] = list(sample)
