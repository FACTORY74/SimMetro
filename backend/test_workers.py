import unittest

from backend.simulation import City
from backend.workers import ProcessRegionPool, RegionWorkerState


class RegionWorkerTests(unittest.TestCase):
    def test_local_protocol_keeps_state_between_messages(self):
        source = City(42, starter=False)
        source.set_speed(1)
        worker = RegionWorkerState()
        worker.handle({"operation": "load", "key": (2, -1), "state": source.save_data()})
        worker.handle({"operation": "advance", "jobs": [((2, -1), 2.0, 30)]})
        saved = worker.handle({"operation": "checkpoint", "keys": [(2, -1)]})[(2, -1)]
        expected = City.restore(source.save_data())
        expected.run(2.0, power_step=30)
        self.assertEqual(saved, expected.save_data())

    def test_processes_own_regions_persistently_and_match_serial_results(self):
        cities = {(0, 0): City(7, starter=False), (1, 0): City(8, starter=False)}
        expected = {key: City.restore(city.save_data()) for key, city in cities.items()}
        with ProcessRegionPool(2) as pool:
            for key, city in cities.items():
                pool.load(key, city)
            pool.advance([(key, 2.25, 30) for key in cities])
            saved = pool.checkpoint(list(cities))
            restored = pool.unload((0, 0))
        for key, city in expected.items():
            city.run(2.25, power_step=30)
            self.assertEqual(saved[key], city.save_data())
        self.assertEqual(restored.save_data(), expected[(0, 0)].save_data())


if __name__ == "__main__":
    unittest.main()
