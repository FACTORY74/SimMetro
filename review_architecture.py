#!/usr/bin/env python3
"""Review SimMetro architecture against implementation."""

import sys
sys.path.insert(0, r'E:\Data\03-CodeProjects\22-GithubRepos\SimMetro')

from backend.simulation import City, SIZE, TILE_COUNT
from backend.region import Region, Activity, district_at, detailed_districts
from backend.controller import CommandQueue
import threading

print("=== Architecture Invariant Review ===")
print()

# 1. A district is mutated by at most one authoritative job at a time
print("1. District single ownership:")
city = City(seed=42, starter=True)
region = Region(city, workers=2)
# Check that only one city can run at a time under the current design
print(f"   - Region has {len(region.cities)} cities")
print(f"   - Activity levels: {region.activity_counts()}")

# 2. Published generations are immutable
print()
print("2. Published generations:")
snapshot = city.snapshot()
print(f"   - Snapshot keys: {list(snapshot.keys())}")
print(f"   - Revision: {snapshot.get('revision')}")

# 3. Commands have total order
print()
print("3. Command ordering:")
cq = CommandQueue()
receipt1, _ = cq.execute("test", lambda: 1)
receipt2, _ = cq.execute("test2", lambda: 2)
print(f"   - Sequence numbers: {receipt1.sequence}, {receipt2.sequence}")
print(f"   - Last sequence: {cq.last_sequence}")

# 4. Activity levels
print()
print("4. Activity levels:")
city2 = City(seed=42, starter=True)
region2 = Region(city2, workers=1)
home = region2.city
region2.select(SIZE * 2 + 100, 100)
empty = region2.focus
print(f"   - Home activity: {region2.activity(empty)}")
print(f"   - Focus activity: {region2.activity((0, 0))}")
print(f"   - Activity counts: {region2.activity_counts()}")

# 5. World coordinates and spatial indexing
print()
print("5. World coordinates:")
from backend.world import world_cell, ChunkCoord
cell = world_cell((0, 0), 50, 50, SIZE)
print(f"   - World cell at (50, 50): {cell}")
chunk = cell.chunk(SIZE)
print(f"   - Chunk coord: {chunk}")

print()
print("=== Review Complete ===")
