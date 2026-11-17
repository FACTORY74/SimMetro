import unittest

from backend.region import World
from backend.simulation import City, SIZE
from backend.world import Bounds, ChunkCoord, SpatialIndex, WorldCell, group_by_chunk, world_cell


class CoordinateTests(unittest.TestCase):
    def test_negative_world_cells_round_trip_through_chunks(self):
        for cell in (WorldCell(0, 0), WorldCell(99, 99), WorldCell(100, 100),
                     WorldCell(-1, -1), WorldCell(-101, 250)):
            chunk = cell.chunk(SIZE)
            local = cell.local(SIZE)
            self.assertEqual(world_cell(chunk, *local, SIZE), cell)
            self.assertTrue(0 <= local[0] < SIZE and 0 <= local[1] < SIZE)

    def test_bounds_query_entities_without_assigning_them_to_one_chunk(self):
        index = SpatialIndex[str](SIZE)
        index.put(7, Bounds(95, 20, 106, 22), "crossing road")
        self.assertEqual(index.query(Bounds(0, 0, 100, 100)), [(7, "crossing road")])
        self.assertEqual(index.query(Bounds(100, 0, 200, 100)), [(7, "crossing road")])
        self.assertEqual(index.query(Bounds(200, 0, 300, 100)), [])

    def test_cells_group_into_storage_chunks_only_at_the_boundary(self):
        groups = group_by_chunk([WorldCell(99, 4), WorldCell(100, 4), WorldCell(-1, 4)], SIZE)
        self.assertEqual(groups[ChunkCoord(0, 0)], [(99, 4)])
        self.assertEqual(groups[ChunkCoord(1, 0)], [(0, 4)])
        self.assertEqual(groups[ChunkCoord(-1, 0)], [(99, 4)])


class ContinuousRoadTests(unittest.TestCase):
    def test_road_component_crosses_a_chunk_boundary(self):
        world = World(City(starter=False))
        world.select(SIZE + 1, 50)
        west, east = world.cities[(0, 0)], world.cities[(1, 0)]
        west.at(SIZE - 1, 50).kind = "road"
        east.at(0, 50).kind = "road"
        component = world.road_component(WorldCell(SIZE - 1, 50))
        self.assertEqual(component, {WorldCell(SIZE - 1, 50), WorldCell(SIZE, 50)})

    def test_world_tile_lookup_is_boundary_transparent(self):
        world = World(City(starter=False))
        world.select(-1, -1)
        tile = world.tile_at(-1, -1)
        self.assertIs(tile, world.cities[(-1, -1)].at(SIZE - 1, SIZE - 1))

    def test_workers_commute_over_a_chunk_boundary(self):
        world = World(City(starter=False))
        world.select(SIZE + 1, 50)
        west, east = world.cities[(0, 0)], world.cities[(1, 0)]
        west.at(SIZE - 1, 50).kind = "road"
        east.at(0, 50).kind = "road"
        home = west.at(SIZE - 1, 49)
        home.kind, home.level, home.occupants, home.powered = "residential", 1, 20, True
        job = east.at(0, 49)
        job.kind, job.variant, job.level, job.powered = "commercial", "r", 1, True
        west.revision += 1
        east.revision += 1
        world.run(0)
        self.assertEqual(job.workers, home.labor)
        self.assertEqual(world.mobility["crossBoundary"], home.labor)
        self.assertEqual(world.mobility["averageWorldDistance"], 1.0)


if __name__ == "__main__":
    unittest.main()
