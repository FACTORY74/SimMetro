import unittest

from backend.simulation import City, SIZE
from backend.region import World


class TerrainToolTests(unittest.TestCase):
    def test_level_uses_first_cell_height_and_preserves_valid_slopes(self):
        city = City(heights=tuple([1] * (SIZE * SIZE)), starter=False)
        city.at(50, 50).height = 2
        before = city.money
        cost = city.build("level", [(50, 50), (51, 50)])
        self.assertEqual(city.at(50, 50).height, 2)
        self.assertEqual(city.at(51, 50).height, 2)
        self.assertEqual(cost, 20)
        self.assertEqual(city.money, before - cost)

    def test_level_rejects_developed_tiles(self):
        city = City(heights=tuple([1] * (SIZE * SIZE)), starter=False)
        city.at(50, 50).kind = "road"
        with self.assertRaisesRegex(ValueError, "Bulldoze development"):
            city.build("level", [(50, 50), (51, 50)])

    def test_raise_propagates_into_the_adjacent_district(self):
        city = City(heights=tuple([1] * (SIZE * SIZE)), starter=False)
        neighbour = City(heights=tuple([1] * (SIZE * SIZE)), starter=False)
        city.at(SIZE - 1, 50).height = 2
        world = World(city, workers=1)
        world.cities[(1, 0)] = neighbour
        before = city.money
        cost = world.terraform("raise", [(SIZE - 1, 50)])
        self.assertEqual(city.at(SIZE - 1, 50).height, 3)
        self.assertEqual(neighbour.at(0, 50).height, 2)
        self.assertIn((1, 0), world.modified)
        self.assertEqual(city.money, before - cost)
        self.assertEqual(world.terrain_edges(0, 0)[1], world.terrain_edges(1, 0)[3])


if __name__ == "__main__":
    unittest.main()
