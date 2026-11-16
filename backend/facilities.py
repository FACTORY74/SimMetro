"""Placed multi-cell facilities, independent of surface tile subtype encoding."""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class FacilityType:
    width: int
    depth: int
    cost: int
    upkeep: int
    power: float
    production: float = 0
    storage: float = 0


FACILITIES = {
    "p": FacilityType(2, 1, 1000, 60, 12, production=1200),
    "t": FacilityType(2, 2, 650, 15, 2, storage=600),
}


@dataclass
class Facility:
    id: int
    variant: str
    x: int
    z: int
    rotation: int = 0
    stored: float = 0

    def transform(self, x, z):
        spec = FACILITIES[self.variant]
        return ((x, z), (spec.depth - 1 - z, x),
                (spec.width - 1 - x, spec.depth - 1 - z),
                (z, spec.width - 1 - x))[self.rotation]

    def footprint(self):
        spec = FACILITIES[self.variant]
        return [(self.x + dx, self.z + dz)
                for z in range(spec.depth) for x in range(spec.width)
                for dx, dz in [self.transform(x, z)]]

    @property
    def entrance(self):
        dx, dz = self.transform(-1, 0)
        return self.x + dx, self.z + dz

    @property
    def connector(self):
        # The anchor is always the northwest footprint cell, at every rotation.
        return self.x, self.z

    def record(self):
        return asdict(self)
