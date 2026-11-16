import unittest

from backend.power import BATTERY_EFFICIENCY, PLANTS, PowerGrid, demand_kw
from backend.simulation import ORIGIN, SIZE, City, Tile
from backend.terrain import world_heights


def network(size=12):
    tiles = [Tile(i % size, i // size) for i in range(size * size)]
    adjacent = [
        tuple(nz * size + nx for nx, nz in ((i % size - 1, i // size), (i % size + 1, i // size),
                                           (i % size, i // size - 1), (i % size, i // size + 1))
              if 0 <= nx < size and 0 <= nz < size)
        for i in range(size * size)
    ]
    return tiles, adjacent


class PowerTests(unittest.TestCase):
    def test_adjacent_lots_share_power_but_empty_space_is_not_a_radius(self):
        tiles, adjacent = network()
        tiles[12].kind, tiles[12].variant, tiles[12].road_access = "power", "c", True
        tiles[13].kind, tiles[13].level = "residential", 2
        tiles[14].kind, tiles[14].level = "commercial", 2
        tiles[16].kind, tiles[16].level = "residential", 1
        grid = PowerGrid(tiles, adjacent, 12, 42, {})
        grid.dispatch(1200)
        self.assertTrue(tiles[13].powered and tiles[14].powered)
        self.assertFalse(tiles[16].powered)
        self.assertGreater(grid.summary["unserved"], 0)
        self.assertEqual(grid.summary["grids"], 2)

    def test_pylons_bridge_eight_tiles_including_water_and_cutting_breaks_it(self):
        tiles, adjacent = network()
        tiles[12].kind, tiles[12].variant, tiles[12].road_access = "power", "c", True
        tiles[13].kind = tiles[21].kind = "powerline"
        tiles[17].height = -2
        tiles[22].kind, tiles[22].level = "residential", 1
        grid = PowerGrid(tiles, adjacent, 12, 42, {})
        grid.dispatch(720)
        self.assertEqual(grid.lines, [(13, 21)])
        self.assertTrue(tiles[22].powered)
        tiles[21].kind = "empty"
        grid = PowerGrid(tiles, adjacent, 12, 42, {})
        grid.dispatch(720)
        self.assertFalse(tiles[22].powered)
        self.assertFalse(tiles[21].powered)  # Bulldozed land must not retain its old service flag.
        tiles[22].kind = "powerline"  # Nine tiles is beyond the span limit.
        grid = PowerGrid(tiles, adjacent, 12, 42, {})
        self.assertEqual(grid.lines, [])

    def test_solar_day_night_wind_variation_and_facility_access(self):
        tiles, adjacent = network()
        for i, variant in ((12, "s"), (13, "w")):
            tiles[i].kind, tiles[i].variant, tiles[i].road_access = "power", variant, True
        grid = PowerGrid(tiles, adjacent, 12, 42, {})
        grid.dispatch(720)
        self.assertEqual(grid.summary["solar"], PLANTS["s"].capacity)
        first_wind = grid.summary["wind"]
        grid.dispatch(0)
        self.assertEqual(grid.summary["solar"], 0)
        self.assertGreater(grid.summary["wind"], 0)
        self.assertNotEqual(first_wind, grid.summary["wind"])
        tiles[13].road_access = False
        grid.dispatch(0)
        self.assertEqual(grid.summary["generation"], 0)

    def test_building_loads_scale_with_levels_and_have_different_peaks(self):
        home = Tile(0, 0, kind="residential", level=1)
        venue = Tile(1, 0, kind="commercial", variant="e", level=1)
        office = Tile(2, 0, kind="commercial", variant="o", level=1)
        self.assertGreater(demand_kw(home, 1140), demand_kw(home, 180))
        self.assertGreater(demand_kw(venue, 1260), demand_kw(venue, 480))
        self.assertGreater(demand_kw(office, 600), demand_kw(office, 1260))
        single = demand_kw(home, 1140)
        home.level = 4
        self.assertEqual(demand_kw(home, 1140), single * 4)

    def test_battery_energy_efficiency_rate_limits_and_isolation(self):
        tiles, adjacent = network()
        for i, variant in ((12, "s"), (13, "b")):
            tiles[i].kind, tiles[i].variant, tiles[i].road_access = "power", variant, True
        tiles[14].kind, tiles[14].level = "residential", 1
        tiles[18].kind, tiles[18].variant, tiles[18].road_access = "power", "b", True
        storage = {}
        grid = PowerGrid(tiles, adjacent, 12, 42, storage)
        grid.dispatch(720, 60)
        charged = (180 - demand_kw(tiles[14], 720)) * BATTERY_EFFICIENCY
        self.assertAlmostEqual(storage[13], charged)
        self.assertEqual(storage[18], 0)  # Cannot charge from a different island.
        before = storage[13]
        grid.dispatch(0)  # Reading/refreshing must not charge or drain a battery.
        self.assertEqual(storage[13], before)
        grid.dispatch(0, 60)
        self.assertTrue(tiles[14].powered)
        self.assertAlmostEqual(storage[13], before - demand_kw(tiles[14], 0) / BATTERY_EFFICIENCY)
        storage[13] = .01
        grid.dispatch(0, 60)
        self.assertFalse(tiles[14].powered)
        self.assertEqual(storage[13], 0)
        self.assertLessEqual(grid.summary["discharging"], PLANTS["b"].capacity)

    def test_shortages_cannot_be_hidden_by_surplus_on_another_grid(self):
        tiles, adjacent = network()
        tiles[12].kind, tiles[12].variant, tiles[12].road_access = "power", "s", True
        tiles[13].kind, tiles[13].level, tiles[13].variant = "industrial", 4, "m"
        tiles[14].kind, tiles[14].level, tiles[14].variant = "industrial", 4, "m"
        tiles[20].kind, tiles[20].variant, tiles[20].road_access = "power", "n", True
        grid = PowerGrid(tiles, adjacent, 12, 42, {})
        grid.dispatch(600)
        self.assertGreater(grid.summary["generation"], grid.summary["demand"])
        self.assertGreater(grid.summary["unserved"], 0)
        self.assertFalse(tiles[13].powered and tiles[14].powered)

    def test_storage_caps_charge_and_discharge_power_and_does_not_create_energy(self):
        tiles, adjacent = network()
        for i, variant in ((12, "c"), (13, "b")):
            tiles[i].kind, tiles[i].variant, tiles[i].road_access = "power", variant, True
        storage = {}
        grid = PowerGrid(tiles, adjacent, 12, 42, storage)
        grid.dispatch(720, 60)
        self.assertEqual(grid.summary["charging"], 200)
        self.assertAlmostEqual(storage[13], 200 * BATTERY_EFFICIENCY)
        storage[13] = PLANTS["b"].storage - 1
        grid.dispatch(720, 60)
        self.assertEqual(storage[13], PLANTS["b"].storage)
        self.assertAlmostEqual(grid.summary["charging"], 1 / BATTERY_EFFICIENCY, places=3)
        tiles[12].road_access = False
        for i in (14, 15, 16):
            tiles[i].kind, tiles[i].level, tiles[i].variant = "industrial", 4, "m"
        # Rebuild topology after placing the new loads.
        grid = PowerGrid(tiles, adjacent, 12, 42, storage)
        before = storage[13]
        grid.dispatch(720, 60)
        self.assertEqual(grid.summary["discharging"], 200)
        self.assertAlmostEqual(storage[13], before - 200 / BATTERY_EFFICIENCY)
        self.assertGreater(grid.summary["unserved"], 0)

    def test_battery_save_replay_pause_and_invalid_energy(self):
        city = City(heights=world_heights(42, 0, 0, 3))
        city.build("road", [(x, ORIGIN + 20) for x in range(ORIGIN + 32, SIZE)])
        city.build("power", [(110, 99)], "b")
        city.set_speed("day")
        city.run(15.1)
        self.assertGreater(sum(city.battery_storage.values()), 0)
        restored = City.restore(city.save_data())
        self.assertEqual(restored.battery_storage, city.battery_storage)
        city.run(3.2)
        for _ in range(32):
            restored.run(.1)
        self.assertAlmostEqual(sum(city.battery_storage.values()), sum(restored.battery_storage.values()), places=8)
        city.set_speed(0)
        before = dict(city.battery_storage)
        city.run(60)
        self.assertEqual(city.battery_storage, before)
        saved = city.save_data()
        saved["battery_storage"][str(99 * SIZE + 110)] = PLANTS["b"].storage + 1
        with self.assertRaisesRegex(ValueError, "battery"):
            City.restore(saved)


if __name__ == "__main__":
    unittest.main()
