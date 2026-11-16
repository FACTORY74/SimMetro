import unittest
from backend.simulation import City, TILE_COUNT
from backend.roads import ROADS
from backend.traffic import _quickest

class RoadTests(unittest.TestCase):
    def test_build_replace_save_and_legacy(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        for x, code in enumerate(ROADS):
            self.assertEqual(city.build('road', [(x, 2)], code), ROADS[code].cost)
        self.assertEqual(city.expenses, sum(r.upkeep for r in ROADS.values()))
        self.assertEqual(city.build('road', [(0, 2)], 'r'), 0)
        self.assertEqual(city.build('road', [(0, 2)], 'a'), 30)
        saved = city.save_data()
        restored = City.restore(saved)
        self.assertEqual(restored.at(0, 2).subtype, 'a')
        saved['variants'] = saved['variants'].replace('a', '.').replace('s', '.').replace('e', '.').replace('r', '.')
        self.assertEqual(City.restore(saved).at(0, 2).subtype, 'r')

    def test_atomic_replacement(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        city.build('road', [(0, 2)])
        city.money = 29
        with self.assertRaises(ValueError):
            city.build('road', [(0, 2)], 'a')
        self.assertEqual(city.at(0, 2).subtype, 'r')
        self.assertEqual(city.money, 29)

    def test_routing_uses_type_speed_and_capacity(self):
        from backend.simulation import Tile
        tiles = [Tile(i, 0, kind='road', variant=v) for i, v in enumerate('rsssee')]
        adj = [(1, 4), (2,), (3,), (), (5,), (3,)]
        dist, parent = _quickest([0], {3}, lambda _: True, adj, [0]*6, tiles)
        self.assertEqual(parent[3], 5)
        dist, parent = _quickest([0], {3}, lambda _: True, adj, [0, 0, 0, 0, 4000, 4000], tiles)
        self.assertEqual(parent[3], 2)
