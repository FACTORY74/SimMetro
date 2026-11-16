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
}

def road_type(tile):
    return ROADS.get(tile.variant, ROADS["r"])
