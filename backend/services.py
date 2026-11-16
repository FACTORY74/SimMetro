"""Initial public-service catalogue; operational simulation will expand later."""
from dataclasses import dataclass


@dataclass(frozen=True)
class ServiceType:
    name: str
    cost: int
    upkeep: int
    power: float
    radius: int
    points: dict[str, int]


SERVICES = {
    "f": ServiceType("Fire station", 800, 80, 10, 12,
                     {"residential": 5, "commercial": 6, "industrial": 8}),
    "p": ServiceType("Police station", 900, 90, 12, 10,
                     {"residential": 6, "commercial": 8, "industrial": 4}),
    "e": ServiceType("School", 1000, 100, 14, 14,
                     {"residential": 10, "commercial": 3, "industrial": 2}),
}
