"""Continuous world coordinates and spatial indexing.

Chunks are an implementation detail: public world operations use absolute cell
coordinates and stable entity ids.  A world cell belongs to exactly one raster
chunk, while vector entities may be indexed by every chunk they intersect.
"""
from dataclasses import dataclass
import math
from typing import Generic, Iterable, Iterator, TypeVar


@dataclass(frozen=True, order=True, slots=True)
class ChunkCoord:
    x: int
    z: int


@dataclass(frozen=True, order=True, slots=True)
class WorldCell:
    x: int
    z: int

    def chunk(self, size: int) -> ChunkCoord:
        return ChunkCoord(self.x // size, self.z // size)

    def local(self, size: int) -> tuple[int, int]:
        return self.x % size, self.z % size

    def neighbours(self) -> tuple["WorldCell", ...]:
        return (WorldCell(self.x - 1, self.z), WorldCell(self.x + 1, self.z),
                WorldCell(self.x, self.z - 1), WorldCell(self.x, self.z + 1))


@dataclass(frozen=True, slots=True)
class Bounds:
    min_x: float
    min_z: float
    max_x: float
    max_z: float

    def chunks(self, size: int) -> Iterator[ChunkCoord]:
        x0, z0 = math.floor(self.min_x / size), math.floor(self.min_z / size)
        x1 = math.floor((self.max_x - 1e-9) / size)
        z1 = math.floor((self.max_z - 1e-9) / size)
        for z in range(z0, z1 + 1):
            for x in range(x0, x1 + 1):
                yield ChunkCoord(x, z)

    def intersects(self, other: "Bounds") -> bool:
        return (self.min_x < other.max_x and self.max_x > other.min_x and
                self.min_z < other.max_z and self.max_z > other.min_z)


T = TypeVar("T")


class SpatialIndex(Generic[T]):
    """Small chunk-bucket spatial index with one authoritative entity record.

    This deliberately has no database dependency.  Its API matches the shape
    needed by a future R-tree/PostGIS implementation without making chunks the
    owners of entities that cross their edges.
    """

    def __init__(self, chunk_size: int):
        self.chunk_size = chunk_size
        self._entities: dict[int, tuple[Bounds, T]] = {}
        self._buckets: dict[ChunkCoord, set[int]] = {}

    def put(self, entity_id: int, bounds: Bounds, value: T):
        self.remove(entity_id)
        self._entities[entity_id] = bounds, value
        for chunk in bounds.chunks(self.chunk_size):
            self._buckets.setdefault(chunk, set()).add(entity_id)

    def remove(self, entity_id: int):
        previous = self._entities.pop(entity_id, None)
        if previous is None:
            return
        for chunk in previous[0].chunks(self.chunk_size):
            bucket = self._buckets.get(chunk)
            if bucket is not None:
                bucket.discard(entity_id)
                if not bucket:
                    del self._buckets[chunk]

    def query(self, bounds: Bounds) -> list[tuple[int, T]]:
        candidates: set[int] = set()
        for chunk in bounds.chunks(self.chunk_size):
            candidates.update(self._buckets.get(chunk, ()))
        return [(entity_id, self._entities[entity_id][1]) for entity_id in sorted(candidates)
                if self._entities[entity_id][0].intersects(bounds)]


def world_cell(chunk: tuple[int, int] | ChunkCoord, local_x: int, local_z: int,
               size: int) -> WorldCell:
    cx, cz = (chunk.x, chunk.z) if isinstance(chunk, ChunkCoord) else chunk
    return WorldCell(cx * size + local_x, cz * size + local_z)


def group_by_chunk(cells: Iterable[WorldCell], size: int) -> dict[ChunkCoord, list[tuple[int, int]]]:
    grouped: dict[ChunkCoord, list[tuple[int, int]]] = {}
    for cell in cells:
        grouped.setdefault(cell.chunk(size), []).append(cell.local(size))
    return grouped
