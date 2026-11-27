"""Road subtype economics and aggregate traffic characteristics."""
from typing import NamedTuple

class Road(NamedTuple):
    cost: int
    upkeep: int
    capacity: int
    minutes: float

ROADS = {
    "r": Road(12, 2, 400, .3),
    "s": Road(6, 1, 150, .45),
    "a": Road(30, 5, 900, .24),
    "e": Road(50, 8, 1400, .18),
    "h": Road(85, 12, 3200, .08),  # east-west highway centre
    "v": Road(85, 12, 3200, .08),  # north-south highway centre
    "b": Road(20, 0, 1, 1),       # paved highway shoulder, excluded from routing
    "m": Road(45, 5, 700, .26),  # access ramp
    "x": Road(100, 18, 2800, .12),  # interchange lanes
    "j": Road(100, 18, 800, .30),   # at-grade interchange crossing
    "c": Road(45, 5, 1400, .14),   # curved interchange slip lane
    "g": Road(5, 0, 1, 1),         # reserved grassy junction ground
}

def road_type(tile):
    return ROADS.get(tile.variant, ROADS["r"])
