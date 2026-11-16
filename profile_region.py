"""Temporary: verify optimizations match original formulas, then measure timings."""
import json
import time

from backend.region import Region
from backend.simulation import SIZE
from backend.power import demand_kw
from backend.desirability import ZONES

data = json.loads(open("saves/city.json", encoding="utf-8").read())
region = Region.restore(data)
city = region.city

# --- Equivalence check 1: daily_profile vs direct demand_kw/production sums ---
profile = city.grid.daily_profile(city.power_clock)
import math
day = math.floor(city.power_clock / 1440) * 1440
errors = 0
for row in profile:
    minute = row["minute"]
    demand = round(sum(demand_kw(city.grid.tiles[i], minute) for i in city.grid.nodes), 3)
    generation = round(sum(city.grid.production(i, day + minute) for i in city.grid.outputs), 3)
    if abs(demand - row["demand"]) > 0.001 or abs(generation - row["generation"]) > 0.001:
        errors += 1
        print("daily_profile mismatch", minute, demand, row["demand"], generation, row["generation"])
print("daily_profile equivalence:", "OK" if not errors else f"{errors} mismatches")

# --- Equivalence check 2: desirability park/industry counts vs brute force ---
suitability = city.desirability()["lots"]
mismatches = 0
checked = 0
for key, row in suitability.items():
    i = int(key)
    tile = city.tiles[i]
    district = None
    neighbours = ((tile.x-1, tile.z), (tile.x+1, tile.z), (tile.x, tile.z-1), (tile.x, tile.z+1))
    networks = [city._components[b*SIZE+a] for a, b in neighbours
                if 0 <= a < SIZE and 0 <= b < SIZE and city._components[b*SIZE+a] >= 0]
    district = min(networks) if networks else None
    parks = industry = 0
    for z in range(max(0, tile.z-2), min(SIZE, tile.z+3)):
        for x in range(max(0, tile.x-2), min(SIZE, tile.x+3)):
            other = city.at(x, z)
            parks += other.kind == "park" and district is not None and any(
                city._components[b*SIZE+a] == district for a, b in ((x-1,z),(x+1,z),(x,z-1),(x,z+1))
                if 0 <= a < SIZE and 0 <= b < SIZE)
            industry += other is not tile and other.kind == "industrial" and other.level > 0 and other.subtype == "m"
    expect_parks = next(c for c in row["components"] if c["label"] == "Parks")["detail"]
    expect_industry = next(c for c in row["components"] if c["label"] == "Industrial nuisance")["detail"]
    if not expect_parks.startswith(f"{parks} ") or not expect_industry.startswith(f"{industry} "):
        mismatches += 1
        if mismatches < 5:
            print("amenity mismatch at", i, parks, expect_parks, "|", industry, expect_industry)
    checked += 1
print(f"desirability amenity equivalence: {'OK' if not mismatches else f'{mismatches} mismatches'} ({checked} lots)")


def t(label, fn, repeat=1):
    results = []
    for _ in range(repeat):
        start = time.perf_counter()
        fn()
        results.append((time.perf_counter() - start) * 1000)
    print(f"{label:40s} min {min(results):8.1f} ms   max {max(results):8.1f} ms   runs {repeat}")


print()
t("region.run(0.25) [tick]", lambda: region.run(0.25), repeat=16)
t("region.run(1.0)  [catch-up tick]", lambda: region.run(1.0), repeat=6)
t("city.snapshot() cached", lambda: city.snapshot(), repeat=3)
city._snapshot = None
t("city._build_snapshot()", lambda: city._build_snapshot(), repeat=3)
city._traffic = None
city._desirability = None
t("city.traffic() replan", lambda: city.traffic(), repeat=3)
city._desirability = None
t("city.desirability() cold", lambda: city.desirability(), repeat=1)
t("city.desirability() warm", lambda: city.desirability(), repeat=3)
t("region.view(128,128,75)", lambda: region.view(128, 128, 75), repeat=3)
t("city.advance() [monthly]", lambda: city.advance(), repeat=3)
t("city.power_data()", lambda: city.power_data(), repeat=3)
