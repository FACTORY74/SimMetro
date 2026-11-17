import unittest

from backend.catalogue import definition, definitions
from backend.facilities import FACILITIES
from backend.power import PLANTS, demand_kw
from backend.services import SERVICES
from backend.simulation import JOBS_PER_LEVEL, MAX_LEVEL, Tile
from backend.simulation import City, SIZE


class BuildingCatalogueTests(unittest.TestCase):
    def test_every_definition_has_a_unique_kind_and_variant(self):
        rows = definitions()
        self.assertEqual(len(rows), 19)
        self.assertEqual(len({row["id"] for row in rows.values()}), len(rows))

    def test_zone_limits_and_jobs_are_loaded_from_json(self):
        office = definition("commercial", "o")
        self.assertEqual(MAX_LEVEL["co"], office["maxLevel"])
        self.assertEqual(JOBS_PER_LEVEL["co"], office["jobsPerLevel"])

    def test_infrastructure_catalogues_are_loaded_from_json(self):
        self.assertEqual(PLANTS["n"].capacity, definition("power", "n")["powerPlant"]["capacityKw"])
        self.assertEqual(SERVICES["e"].radius, definition("service", "e")["service"]["radius"])
        self.assertEqual(FACILITIES["p"].production, definition("waterworks", "p")["facility"]["productionPerDay"])

    def test_zone_power_demand_uses_definition_peak_and_profile(self):
        office = Tile(0, 0, kind="commercial", variant="o", level=2)
        self.assertEqual(demand_kw(office, 600), 32)

    def test_nuclear_station_is_one_atomic_four_by_four_installation(self):
        city = City(heights=tuple([1] * (SIZE * SIZE)), starter=False)
        before = city.money
        self.assertEqual(city.build("power", [(10, 10)], "n"), 4000)
        parts = [t for t in city.tiles if t.kind == "power" and t.subtype == "n"]
        self.assertEqual(len(parts), 16)
        self.assertEqual(sorted(t.installation_part for t in parts), list(range(16)))
        self.assertEqual(sum(t.facility_root for t in parts), 1)
        self.assertEqual(city.money, before - 4000)
        restored = City.restore(city.save_data())
        self.assertEqual(sum(t.kind == "power" and t.subtype == "n" for t in restored.tiles), 16)
        restored.build("bulldoze", [(12, 12)])
        self.assertFalse(any(t.kind == "power" and t.subtype == "n" for t in restored.tiles))

    def test_coal_station_is_one_atomic_two_by_two_installation(self):
        city = City(heights=tuple([1] * (SIZE * SIZE)), starter=False)
        before = city.money
        self.assertEqual(city.build("power", [(10, 10)], "c"), 900)
        parts = [t for t in city.tiles if t.kind == "power" and t.subtype == "c"]
        self.assertEqual(len(parts), 4)
        self.assertEqual(sorted(t.installation_part for t in parts), list(range(4)))
        self.assertEqual(sum(t.facility_root for t in parts), 1)
        self.assertEqual(city.money, before - 900)
        restored = City.restore(city.save_data())
        restored.build("bulldoze", [(11, 11)])
        self.assertFalse(any(t.kind == "power" and t.subtype == "c" for t in restored.tiles))

    def test_nuclear_station_has_strong_twenty_tile_desirability_impact(self):
        spec = definition("power", "n")["landDesirability"]
        self.assertEqual(spec, {"points": -80, "radius": 20, "label": "Nuclear power station"})

    def test_coal_and_school_radii_come_from_the_catalogue(self):
        self.assertEqual(definition("power", "c")["landDesirability"],
                         {"points": -30, "radius": 12, "label": "Coal power station"})
        self.assertEqual(SERVICES["e"].radius, 10)


if __name__ == "__main__":
    unittest.main()
