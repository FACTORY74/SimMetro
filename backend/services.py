"""Initial public-service catalogue; operational simulation will expand later."""
from dataclasses import dataclass
from backend.catalogue import definitions


@dataclass(frozen=True)
class ServiceType:
    name: str
    cost: int
    upkeep: int
    power: float
    radius: int
    points: dict[str, int]


SERVICES = {variant: ServiceType(row["label"], row["constructionCost"], row["service"]["upkeep"],
                                 row["service"]["powerKw"], row["service"]["radius"],
                                 row["service"]["desirabilityPoints"])
            for (kind, variant), row in definitions().items() if kind == "service"}
