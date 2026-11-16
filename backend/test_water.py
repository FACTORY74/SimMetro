import copy
import unittest

from backend.simulation import City, SIZE, TILE_COUNT
from backend.facilities import FACILITIES, Facility


def water_city():
    city = City(heights=(1,) * TILE_COUNT, starter=False)
    city.build("road", [(x, 10) for x in range(10, 26)])
    city.build("power", [(10, 9)], "c")
    city.build("waterworks", [(11, 11)], "p", rotation=1)
    city.build("waterworks", [(21, 11)], "t", rotation=1)
    city.build("residential", [(13, 9), (23, 9)], "l")
    for x in (13, 23):
        t = city.at(x, 9)
        t.level, t.occupants = 2, 24
    pipes = [(x, 10) for x in range(10, 26)] + [p for f in city.facilities.values() for p in f.footprint()]
    city.build("pipe", pipes)
    return city


class WaterTests(unittest.TestCase):
    def test_starter_served_and_facilities_charge_once(self):
        city = City()
        self.assertEqual(city.water_network.summary["unserved"], 0)
        self.assertEqual(len(city.facilities), 1)
        self.assertEqual(city.water_grace, 0)
        city = water_city()
        tower = next(f for f in city.facilities.values() if f.variant == "t")
        self.assertEqual(len(tower.footprint()), 4)
        self.assertEqual(sum(t.facility_root for t in city.tiles), 2)
        self.assertAlmostEqual(sum(city.grid.loads[z*SIZE+x] for x, z in tower.footprint()), 2)
        self.assertEqual(city.expenses, 16*2 + 180 + 60 + 15)

    def test_rotation_and_atomic_footprints(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        for rotation in range(4):
            anchor = (10 + rotation*5, 10)
            before = city.money
            self.assertEqual(city.build("waterworks", [anchor], "p", rotation=rotation), 1000)
            self.assertEqual(before-city.money, 1000)
            f = city.facilities[rotation+1]
            self.assertEqual(len(set(f.footprint())), 2)
            self.assertNotIn(f.entrance, f.footprint())
        before = city.save_data()
        with self.assertRaises(ValueError):
            city.build("waterworks", [(9, 10)], "t")
        self.assertEqual(before, city.save_data())
        with self.assertRaises(ValueError):
            city.build("waterworks", [(SIZE-1, 10)], "p")
        city.money = 649
        with self.assertRaises(ValueError):
            city.build("waterworks", [(40, 10)], "t")
        self.assertEqual(city.at(40, 10).kind, "empty")

    def test_independent_layers_and_whole_facility_demolition(self):
        city = water_city()
        f = next(f for f in city.facilities.values() if f.variant == "t")
        self.assertEqual(city.build("bulldoze", f.footprint()), 5)
        self.assertTrue(all(city.at(x, z).kind == "empty" for x, z in f.footprint()))
        self.assertTrue(all(z*SIZE+x in city.pipes for x, z in f.footprint()))
        city.build("remove_pipe", [(15, 10)])
        self.assertEqual(city.at(15, 10).kind, "road")
        city.build("bulldoze", [(14, 10)])
        self.assertIn(10*SIZE+14, city.pipes)
        self.assertEqual(city.build("pipe", [(14, 10)]), 0)

    def test_disconnect_storage_exhaustion_and_recovery(self):
        city = water_city()
        network = city.water_network
        self.assertEqual(network.summary["unserved"], 0)
        tower = next(f for f in city.facilities.values() if f.variant == "t")
        network.dispatch(60)
        self.assertGreater(tower.stored, 0)
        city.build("remove_pipe", [(18, 10)])
        self.assertTrue(city.water_network.supplied(9*SIZE+23))
        tower.stored = .001
        city.water_network.dispatch(5)
        city.water_network.dispatch()
        self.assertEqual(tower.stored, 0)
        self.assertFalse(city.water_network.supplied(9*SIZE+23))
        self.assertTrue(city.water_network.supplied(9*SIZE+13))
        city.build("pipe", [(18, 10)])
        self.assertTrue(city.water_network.supplied(9*SIZE+23))
        city.water_network.dispatch(5)
        self.assertGreater(tower.stored, 0)

    def test_mass_balance_refreshes_and_save_replay(self):
        city = water_city()
        for _ in range(4):
            before = sum(f.stored for f in city.facilities.values())
            city.water_network.dispatch(30)
            s = city.water_network.summary
            self.assertAlmostEqual(before+s["production"]*30/1440,
                                   s["storage"]+(s["served"]+s["spilled"])*30/1440)
        stored = sum(f.stored for f in city.facilities.values())
        for _ in range(3):
            city.recalculate()
            city.snapshot()
        self.assertEqual(stored, sum(f.stored for f in city.facilities.values()))
        restored = City.restore(city.save_data())
        self.assertEqual(city.save_data(), restored.save_data())
        city.run(2)
        restored.run(2)
        self.assertEqual(city.save_data(), restored.save_data())

    def test_power_and_entrance_failures(self):
        city = water_city()
        pump = next(f for f in city.facilities.values() if f.variant == "p")
        city.build("bulldoze", [pump.entrance])
        self.assertEqual(city.water_network.facility_status[pump.id]["reason"], "No entrance road")
        city.build("road", [pump.entrance])
        city.build("bulldoze", [(10, 9)])
        self.assertEqual(city.water_network.facility_status[pump.id]["reason"], "No power")
        self.assertEqual(city.water_network.summary["production"], 0)

    def test_shortage_blocks_growth_then_declines_and_recovers(self):
        city = water_city()
        home = city.at(23, 9)
        city.build("remove_pipe", [(18, 10)])
        for _ in range(2):
            city.advance()
        self.assertEqual(home.residents, 24)
        city.advance()
        self.assertLess(home.residents, 24)
        city.build("pipe", [(18, 10)])
        before = home.residents
        for _ in range(12):
            city.advance()  # Service recovers immediately; neighbourhood reputation recovers gradually.
        self.assertGreater(home.residents, before)
        self.assertNotIn(9*SIZE+23, city.water_shortages)

    def test_legacy_grace_and_corrupt_records(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        old = city.save_data()
        old["version"] = 6
        del old["water"]
        migrated = City.restore(old)
        self.assertEqual(migrated.water_grace, 24)
        migrated.advance()
        self.assertEqual(City.restore(migrated.save_data()).water_grace, 23)
        data = water_city().save_data()
        for change in (lambda d: d["water"]["facilities"][0].update(stored=float("nan")),
                       lambda d: d["water"]["facilities"][0].update(x=250),
                       lambda d: d["water"].update(grace=-1),
                       lambda d: d["water"]["pipes"].append(-1),
                       lambda d: d["water"].update(facilities=[])):
            bad = copy.deepcopy(data)
            change(bad)
            with self.assertRaises(ValueError):
                City.restore(bad)

    def test_batched_offscreen_flow_and_pause(self):
        a = water_city()
        a.set_speed("day")
        b = City.restore(a.save_data())
        a.run(10, power_step=30)
        for _ in range(40):
            b.run(.25)
        self.assertAlmostEqual(a.water_network.summary["storage"], b.water_network.summary["storage"])
        a.set_speed(0)
        stored = a.water_network.summary["storage"]
        a.run(100)
        self.assertEqual(a.water_network.summary["storage"], stored)

    def test_coverage_tie_does_not_merge_disconnected_pipes(self):
        city = water_city()
        # An isolated pipe directly under the home wins over the supplied street.
        city.build("remove_pipe", [(23, 10)])
        city.build("pipe", [(23, 8)])
        service = city.water_network.services[9*SIZE+23]
        self.assertEqual(service["network"], 8*SIZE+23)
        self.assertEqual(service["served"], 0)
