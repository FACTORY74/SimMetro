import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.region import Region
from backend.simulation import ADJ, ORIGIN, SIZE, TILE_COUNT, City, generate_heights
from backend.terrain import world_heights


def find(city, predicate):
    return next(t for t in city.tiles if predicate(t))


def connected_city():
    city = City(heights=world_heights(42, 0, 0, 3))
    city.build("road", [(x, ORIGIN + 20) for x in range(ORIGIN + 32, SIZE)])
    return city


class TerrainTests(unittest.TestCase):
    def test_terrain_has_levels_above_and_below_water_with_gentle_slopes(self):
        heights = generate_heights(42)
        self.assertEqual(len(heights), TILE_COUNT)
        self.assertLessEqual(min(heights), -4)
        self.assertGreaterEqual(max(heights), 6)
        self.assertTrue(all(abs(heights[i] - heights[j]) <= 1
                            for i in range(TILE_COUNT) for j in ADJ[i]))

    def test_starter_town_follows_natural_terrain_without_a_regional_road(self):
        city = City()
        self.assertEqual(tuple(t.height for t in city.tiles), generate_heights(city.seed))
        self.assertGreater(len({t.height for t in city.tiles if t.kind != "empty"}), 1)
        self.assertTrue(all(not t.water for t in city.tiles if t.kind != "empty"))
        self.assertTrue(all(city.at(x, ORIGIN + 20).kind == "empty" for x in range(ORIGIN + 32, SIZE)))
        self.assertGreater(city.population, 0)
        self.assertGreater(city.grid.summary["generation"], 0)
        self.assertEqual(city.snapshot()["disconnected"], 0)
        self.assertEqual(city.snapshot()["unpowered"], 0)
        self.assertTrue(any(t.kind == "w" for t in city.traffic().trips))
        self.assertTrue(any(t.kind == "f" for t in city.traffic().trips))
        restored = City.restore(city.save_data())
        self.assertEqual(restored.population, city.population)
        self.assertEqual(restored.traffic().trips, city.traffic().trips)
        city.build("road", [(ORIGIN + 24, z) for z in range(ORIGIN + 9)])
        self.assertGreater(city.population, 0)
        self.assertEqual(city.snapshot()["disconnected"], 0)
        self.assertEqual(city.snapshot()["unpowered"], 0)
        self.assertTrue(any(t.kind == "f" for t in city.traffic().trips))

    def test_starter_moves_to_dry_land_without_changing_terrain(self):
        x, z = ORIGIN + 8, ORIGIN + 20
        heights = tuple(max(-1, min(1, abs(i % SIZE - x) + abs(i // SIZE - z) - 1))
                        for i in range(TILE_COUNT))
        city = City(heights=heights)
        self.assertEqual(tuple(t.height for t in city.tiles), heights)
        self.assertTrue(all(not t.water for t in city.tiles if t.kind != "empty"))
        self.assertEqual(city.at(x, z).kind, "empty")
        self.assertGreater(sum(t.kind == "road" for t in city.tiles), 0)

    def test_restoring_city_does_not_require_a_starter_site(self):
        city = City(heights=tuple([-1] * TILE_COUNT), starter=False)
        self.assertEqual(City.restore(city.save_data()).save_data(), city.save_data())


class BuildTests(unittest.TestCase):
    def test_public_service_costs_and_upkeep(self):
        city = City()
        cells = [(ORIGIN + 40 + i, ORIGIN + 8) for i in range(3)]
        money, expenses = city.money, city.expenses
        for cell, variant in zip(cells, "fpe"):
            city.build("service", [cell], variant)
        self.assertEqual(money - city.money, 2700)
        self.assertEqual(city.expenses - expenses, 270)

    def test_zone_stroke_charges_per_tile(self):
        city = City()
        money = city.money
        cost = city.build("residential", [(ORIGIN + 17, ORIGIN + 8), (ORIGIN + 17, ORIGIN + 7),
                                          (ORIGIN + 17, ORIGIN + 8)])
        self.assertEqual(cost, 16)
        self.assertEqual(city.money, money - 16)

    def test_roads_and_new_zone_rules_replace_undeveloped_zones(self):
        city = City()
        road_cell = (ORIGIN + 40, ORIGIN + 8)
        rezone_cell = (ORIGIN + 41, ORIGIN + 8)
        developed_cell = (ORIGIN + 42, ORIGIN + 8)
        city.build("residential", [road_cell, rezone_cell, developed_cell], "l")

        city.build("road", [road_cell], "r")
        self.assertEqual((city.at(*road_cell).kind, city.at(*road_cell).variant), ("road", "r"))

        city.build("commercial", [rezone_cell], "o")
        self.assertEqual((city.at(*rezone_cell).kind, city.at(*rezone_cell).variant, city.at(*rezone_cell).level),
                         ("commercial", "o", 0))

        city.at(*developed_cell).level = 1
        with self.assertRaisesRegex(ValueError, "Bulldoze"):
            city.build("road", [developed_cell], "r")
        with self.assertRaisesRegex(ValueError, "Bulldoze"):
            city.build("industrial", [developed_cell], "m")

    def test_cannot_build_on_water(self):
        city = City()
        water = find(city, lambda t: t.water)
        with self.assertRaisesRegex(ValueError, "water"):
            city.build("road", [(water.x, water.z)])

    def test_unconnected_zone_does_not_grow(self):
        city = City()
        city.build("residential", [(ORIGIN + 40, ORIGIN + 8)])
        tile = city.at(ORIGIN + 40, ORIGIN + 8)
        self.assertFalse(tile.powered)  # Isolated land no longer receives radius-based power.
        self.assertFalse(tile.connected)
        for _ in range(20):
            city.advance()
        self.assertEqual(tile.level, 0)

    def test_cutting_a_district_edge_road_preserves_local_services(self):
        city = connected_city()
        self.assertGreater(city.population, 0)
        self.assertEqual(City.restore(city.save_data()).at(SIZE - 1, ORIGIN + 20).kind, "road")
        population = city.population
        city.build("bulldoze", [(SIZE - 1, ORIGIN + 20)])
        self.assertEqual(city.population, population)
        self.assertGreater(city.grid.summary["generation"], 0)
        self.assertEqual(city.snapshot()["disconnected"], 0)
        self.assertTrue(any(t.kind == "f" for t in city.traffic().trips))

    def test_subtypes_set_growth_caps_jobs_and_power_connections(self):
        city = connected_city()
        cell = (ORIGIN + 17, ORIGIN + 8)
        city.build("residential", [cell], "l")
        tile = city.at(*cell)
        self.assertEqual((tile.variant, tile.max_level), ("l", 2))
        city.build("residential", [cell], "h")     # Undeveloped zones can be repainted.
        self.assertEqual((tile.variant, tile.max_level), ("h", 4))
        with self.assertRaisesRegex(ValueError, "subtype"):
            city.build("commercial", [(ORIGIN + 18, ORIGIN + 8)], "x")
        farm = city.at(ORIGIN + 25, ORIGIN + 22)
        farm.variant, farm.level = "f", 2
        self.assertEqual((farm.job_capacity, farm.max_level), (12, 3))
        city.recalculate()
        self.assertEqual(city.snapshot()["tiles"]["variant"][(ORIGIN + 22) * SIZE + ORIGIN + 25], "f")
        # A solar farm joins the road's grid, not a radius of empty ground, for $500.
        money = city.money
        city.build("power", [(ORIGIN + 90, ORIGIN + 21)], "s")
        self.assertEqual(money - city.money, 500)
        self.assertTrue(city.at(ORIGIN + 90, ORIGIN + 20).powered)
        self.assertFalse(city.at(ORIGIN + 102, ORIGIN + 21).powered)
        self.assertFalse(city.at(ORIGIN + 103, ORIGIN + 21).powered)

    def test_subtypes_survive_save_and_old_saves_get_defaults(self):
        city = City()
        city.build("industrial", [(ORIGIN + 26, ORIGIN + 23)], "t")
        restored = City.restore(city.save_data())
        self.assertEqual(restored.at(ORIGIN + 26, ORIGIN + 23).variant, "t")
        self.assertEqual(restored.at(ORIGIN + 15, ORIGIN + 23).variant, "l")
        old = city.save_data()
        old["version"] = 3
        del old["variants"]
        legacy = City.restore(old)
        self.assertEqual(legacy.at(ORIGIN + 26, ORIGIN + 23).variant, "m")
        self.assertEqual(legacy.at(ORIGIN + 29, ORIGIN + 19).variant, "c")


class TerraformTests(unittest.TestCase):
    def test_raise_cascades_to_keep_slopes_gentle(self):
        city = City(heights=tuple([1] * TILE_COUNT))
        x, z = ORIGIN + 40, ORIGIN + 8
        terrain_revision = city.terrain_revision
        city.build("raise", [(x, z)])
        city.build("raise", [(x, z)])
        self.assertEqual(city.at(x, z).height, 3)
        self.assertEqual(city.at(x + 1, z).height, 2)
        self.assertEqual(city.terrain_revision, terrain_revision + 2)
        self.assertTrue(all(abs(city.tiles[i].height - city.tiles[j].height) <= 1
                            for i in range(TILE_COUNT) for j in ADJ[i]))

    def test_terraform_rejects_development_and_nearby_development(self):
        city = City(heights=tuple([1] * TILE_COUNT))
        with self.assertRaisesRegex(ValueError, "Bulldoze"):
            city.build("raise", [(ORIGIN + 16, ORIGIN + 20)])
        x, z = ORIGIN + 18, ORIGIN + 12  # empty tile beside residential zones
        city.build("raise", [(x, z)])
        money = city.money
        with self.assertRaisesRegex(ValueError, "nearby development"):
            city.build("raise", [(x, z)])
        self.assertEqual(city.money, money)
        self.assertEqual(city.at(x, z).height, 2)

    def test_lowering_land_creates_water(self):
        city = City(heights=tuple([1] * TILE_COUNT))
        x, z = ORIGIN + 40, ORIGIN + 8
        city.build("lower", [(x, z)])
        city.build("lower", [(x, z)])
        self.assertTrue(city.at(x, z).water)
        with self.assertRaisesRegex(ValueError, "water"):
            city.build("park", [(x, z)])


class SaveTests(unittest.TestCase):
    def test_fast_clock_round_trip_preserves_next_month_boundary(self):
        for speed in (1, 3):
            with self.subTest(speed=speed):
                city = City()
                city.set_speed(speed)
                city.run(1.75)
                restored = City.restore(city.save_data())
                city.run(.25)
                restored.run(.25)
                self.assertEqual(city.tick, speed)
                self.assertEqual(restored.save_data(), city.save_data())

    def test_fast_clock_defaults_for_old_saves_and_rejects_invalid_values(self):
        data = City().save_data()
        del data["fast_seconds"]
        self.assertEqual(City.restore(data)._fast_seconds, 0)
        for value in (-1, 2, float("nan"), float("inf"), True, "1"):
            with self.subTest(value=value):
                data["fast_seconds"] = value
                with self.assertRaisesRegex(ValueError, "fast clock"):
                    City.restore(data)

    def test_migrated_power_history_records_crossed_half_hours(self):
        data = City().save_data()
        data.update(version=4, clock=361.25, speed="day")
        city = City.restore(data)
        city.run(60)
        self.assertEqual(len(city.power_history), 49)
        self.assertEqual(city.power_history[1]["time"], 391.25)
        self.assertEqual(city.power_history[-1]["time"], 1801.25)
        restored = City.restore(city.save_data())
        restored.run(1.25)
        self.assertEqual(restored.power_history[-1]["time"], 1831.25)

    def test_round_trip_preserves_terrain_and_development(self):
        city = City()
        city.build("raise", [(ORIGIN + 40, ORIGIN + 8)])
        city.advance()
        restored = City.restore(city.save_data())
        self.assertEqual([t.height for t in restored.tiles], [t.height for t in city.tiles])
        self.assertEqual([t.kind for t in restored.tiles], [t.kind for t in city.tiles])
        self.assertEqual(restored.population, city.population)

    def test_conditions_round_trip_replay_and_version_two_migration(self):
        city = City()
        business = find(city, lambda t: t.kind == "commercial" and t.level > 0)
        business.condition = 17
        city.recalculate()
        restored = City.restore(city.save_data())
        self.assertEqual(restored.at(business.x, business.z).condition, 17)
        city.advance()
        restored.advance()
        self.assertEqual(restored.save_data(), city.save_data())
        legacy = city.save_data()
        legacy["version"] = 2
        del legacy["conditions"]
        migrated = City.restore(legacy)
        self.assertTrue(all(t.condition == 100 for t in migrated.tiles))
        invalid = city.save_data()
        invalid["conditions"][0] = 101
        with self.assertRaisesRegex(ValueError, "conditions"):
            City.restore(invalid)

    def test_rejects_old_and_invalid_saves(self):
        with self.assertRaisesRegex(ValueError, "40 × 40"):
            City.restore({"version": 1})
        data = City().save_data()
        data["heights"][0] = data["heights"][1] + 3
        with self.assertRaisesRegex(ValueError, "steeper"):
            City.restore(data)


class ApiTests(unittest.TestCase):
    def test_state_is_compact_and_supports_since(self):
        client = TestClient(app_module.app)
        state = client.get("/api/state").json()
        self.assertEqual(state["size"], SIZE)
        self.assertEqual(len(state["tiles"]["kind"]), TILE_COUNT)
        self.assertEqual(len(state["tiles"]["workers"]), TILE_COUNT)
        self.assertEqual(len(state["tiles"]["condition"]), TILE_COUNT)
        self.assertEqual(state["employed"] + state["unemployed"], state["workforce"])
        unchanged = client.get("/api/state", params={"since": state["revision"], "session": state["session"]}).json()
        self.assertEqual(set(unchanged), {"unchanged", "session", "revision", "clock"})
        self.assertEqual(unchanged["revision"], state["revision"])
        for session in ("previous-server", None):
            params = {"since": state["revision"]}
            if session is not None:
                params["session"] = session
            fresh = client.get("/api/state", params=params).json()
            self.assertIn("tiles", fresh)
            self.assertEqual(fresh["session"], state["session"])
        response = client.post("/api/build", json={"tool": "raise", "cells": [{"x": SIZE, "z": 0}]})
        self.assertEqual(response.status_code, 422)

    def test_day_speed_and_traffic_endpoint(self):
        city = connected_city()
        with patch.object(app_module, "city", city), patch.object(app_module, "region", Region(city)):
            client = TestClient(app_module.app)
            state = client.post("/api/speed", json={"speed": "day"}).json()
            self.assertEqual(state["speed"], "day")
            self.assertEqual(client.post("/api/speed", json={"speed": 2}).status_code, 422)
            plan = client.get("/api/traffic").json()
            self.assertEqual(plan["session"], state["session"])
            self.assertEqual(plan["revision"], state["traffic_revision"])
            self.assertEqual(len(plan["kind"]), len(plan["route"]))
            self.assertIn("w", plan["kind"])
            client.post("/api/speed", json={"speed": 1})

    def test_power_endpoint_daily_and_total_graph_data(self):
        client = TestClient(app_module.app)
        data = client.get("/api/power").json()
        self.assertEqual([p["minute"] for p in data["daily"]], list(range(0, 1441, 30)))
        self.assertGreater(data["summary"]["demand"], 0)
        self.assertGreater(data["daily"][36]["demand"], data["daily"][6]["demand"])
        self.assertEqual(data["lineSpan"], 8)
        self.assertIn("powerDemand", data["history"][-1])


class ClockTests(unittest.TestCase):
    def test_day_mode_runs_one_day_per_minute_and_months_follow_the_calendar(self):
        city = City()
        city.set_speed("day")
        city.run(60)
        self.assertAlmostEqual(city.clock, 360 + 1440)
        self.assertEqual(city.tick, 0)
        city.run(29 * 60 - 15)  # 06:00 on day 31 is the start of the next month.
        self.assertEqual(city.tick, 1)
        self.assertAlmostEqual(city.clock, 0)

    def test_fast_speeds_advance_months_while_paused_freezes_time(self):
        city = City()
        city.set_speed(3)
        city.run(2)
        self.assertEqual(city.tick, 3)
        city.set_speed(0)
        clock = city.clock
        city.run(10)
        self.assertEqual((city.tick, city.clock), (3, clock))

    def test_day_speed_and_clock_round_trip_and_validate(self):
        city = City()
        city.set_speed("day")
        city.run(7)
        restored = City.restore(city.save_data())
        self.assertEqual((restored.speed, restored.clock), ("day", city.clock))
        legacy = city.save_data()
        legacy["version"] = 4
        del legacy["clock"]
        self.assertEqual(City.restore(legacy).clock, 360)
        for key, value in (("speed", "fast"), ("speed", True), ("clock", -1)):
            data = city.save_data()
            data[key] = value
            with self.assertRaises(ValueError):
                City.restore(data)


class TrafficTests(unittest.TestCase):
    STEP = {"E": 1, "W": -1, "S": SIZE, "N": -SIZE}

    def walk(self, trip):
        tiles, tile = [trip.origin], trip.origin
        for move in trip.route:
            tile += self.STEP[move]
            tiles.append(tile)
        return tiles

    def test_every_worker_commutes_along_a_contiguous_road_route(self):
        city = connected_city()
        for _ in range(30):
            city.advance()
        plan = city.traffic()
        commutes = [t for t in plan.trips if t.kind == "w"]
        self.assertEqual(sum(t.count for t in commutes), city.employed)
        self.assertEqual(plan.commuters, city.employed)
        for trip in commutes:
            self.assertTrue(trip.route)
            path = self.walk(trip)
            self.assertEqual(path[-1], trip.destination)
            self.assertTrue(all(city.tiles[i].kind == "road" for i in path[1:-1]))
            self.assertTrue(330 <= trip.start <= 900 and 300 <= trip.end - trip.start <= 570)
        self.assertGreater(plan.avg_commute, 3)
        self.assertGreater(sum(plan.volume), 0)

    def test_freight_and_shoppers_reach_local_shops(self):
        city = connected_city()
        for _ in range(30):
            city.advance()
        plan = city.traffic()
        freight = [t for t in plan.trips if t.kind == "f"]
        shopping = [t for t in plan.trips if t.kind == "s"]
        self.assertTrue(freight and shopping)
        for trip in freight:
            self.assertEqual(city.tiles[trip.origin].kind, "industrial")
            end = self.walk(trip)[-1]
            self.assertEqual(end, trip.destination)
            self.assertEqual(city.tiles[end].kind, "commercial")
            self.assertTrue(all(city.tiles[i].kind == "road" for i in self.walk(trip)[1:-1]))
            self.assertEqual(plan.volume[end], 0)
        for trip in shopping:
            self.assertEqual(self.walk(trip)[-1], trip.destination)
            self.assertEqual(city.tiles[trip.destination].kind, "commercial")

    def test_traffic_revision_only_changes_when_trips_change(self):
        city = connected_city()
        city.traffic()
        revision = city.traffic_revision
        city.recalculate()
        city.traffic()
        self.assertEqual(city.traffic_revision, revision)
        city.build("residential", [(ORIGIN + 15, ORIGIN + 21)])
        for _ in range(6):
            city.advance()
        city.traffic()
        self.assertGreater(city.traffic_revision, revision)

    def network(self, detour_x, level=4):
        """Homes north of an east-west arterial, factories south, linked by two side streets."""
        city = City()
        for tile in city.tiles:
            tile.kind, tile.level, tile.height = "empty", 0, 1
        for x in range(88, SIZE):
            city.at(x, 100).kind = "road"
        for x in range(88, 97):
            city.at(x, 110).kind = "road"
        for x in (90, detour_x):
            for z in range(101, 110):
                city.at(x, z).kind = "road"
        city.at(100, 101).kind = "power"
        city.at(100, 101).variant = "n"  # Enough capacity even for the deliberately oversized traffic fixture.
        for z, kind in ((99, "residential"), (101, "residential"),
                        (109, "industrial"), (111, "industrial")):
            tile = city.at(92, z)
            tile.kind, tile.level = kind, level
            tile.occupants = level * 24 if kind == "residential" else 0
        city.recalculate()
        plan = city.traffic()
        commuters = sum(t.count for t in plan.trips if t.kind == "w")
        self.assertGreater(commuters, 50)
        return city, plan, commuters

    def street_load(self, city, plan, x):
        return sum(t.count for t in plan.trips if t.kind == "w"
                   and 105 * SIZE + x in self.walk(t))

    def test_commuters_split_across_equally_quick_routes(self):
        city, plan, commuters = self.network(94)
        west, east = self.street_load(city, plan, 90), self.street_load(city, plan, 94)
        self.assertEqual(west + east, commuters)
        self.assertGreaterEqual(min(west, east), commuters // 4)

    def test_light_traffic_keeps_to_the_quickest_route(self):
        city, plan, commuters = self.network(96)
        self.assertEqual(self.street_load(city, plan, 90), commuters)

    def test_overloaded_route_sheds_commuters_onto_a_longer_detour(self):
        city, plan, commuters = self.network(96, level=30)
        detour = self.street_load(city, plan, 96)
        self.assertGreater(detour, commuters // 5)
        self.assertLess(detour, commuters // 2)

    def test_heavy_volume_slows_commutes_and_flags_congestion(self):
        from backend.traffic import ROAD_CAPACITY, delay_factor
        self.assertEqual(delay_factor(0), 1)
        self.assertAlmostEqual(delay_factor(ROAD_CAPACITY), 1.15)
        self.assertGreater(delay_factor(ROAD_CAPACITY * 2), 3)


class PopulationTests(unittest.TestCase):
    def setUp(self):
        self.city = City(heights=tuple([1] * TILE_COUNT), starter=False)
        for x in range(10, 17):
            self.city.at(x, 10).kind = "road"
        self.city.at(10, 9).kind = "power"
        self.home = self.city.at(12, 9)
        self.home.kind, self.home.variant, self.home.level = "residential", "l", 2
        self.city.build("waterworks", [(14, 11)], "p", rotation=1)
        self.city.build("pipe", [(x, 10) for x in range(10, 17)] + [(14, 11), (14, 12)])
        self.city.recalculate()

    def test_arrivals_are_gradual_and_limited_by_capacity(self):
        self.city.advance()
        self.assertEqual(self.home.residents, 1)
        self.assertEqual(self.city.population, 1)
        self.home.occupants = 47
        for x in (11, 12, 13):
            self.city.at(x, 11).kind = "park"
        self.city.recalculate()
        self.city.advance()
        self.assertEqual(self.home.residents, 48)
        self.city.advance()
        self.assertEqual(self.home.residents, 48)

    def test_parks_and_local_vacancies_increase_arrivals(self):
        for x in (11, 12, 13):
            self.city.at(x, 11).kind = "park"
        self.city.recalculate()
        self.city.advance()
        self.assertEqual(self.home.residents, 2)
        self.home.occupants = 0
        shop = self.city.at(16, 9)
        shop.kind, shop.level = "commercial", 1
        self.city.recalculate()
        self.city.advance()
        self.assertEqual(self.home.residents, 2)  # The new vacancy bonus is smoothed in.
        self.assertGreater(self.city.snapshot()["desirability"]["lots"][str(9*SIZE+12)]["target"], 65)

    def test_nearby_industry_can_prevent_arrivals(self):
        for x in (13, 14):
            factory = self.city.at(x, 9)
            factory.kind, factory.level = "industrial", 1
        self.city.recalculate()
        self.city.advance()
        self.assertEqual(self.home.residents, 0)

    def test_no_arrivals_without_power_or_road_access(self):
        self.city.at(10, 9).kind = "empty"
        self.city.recalculate()
        self.assertTrue(self.home.road_access)
        self.assertFalse(self.home.powered)
        self.city.advance()
        self.assertEqual(self.home.residents, 0)
        self.city.at(10, 9).kind = "power"
        self.city.at(12, 10).kind = "empty"
        self.city.at(11, 9).kind = "residential"
        self.city.recalculate()
        self.assertTrue(self.home.powered)
        self.assertFalse(self.home.road_access)
        self.city.advance()
        self.assertEqual(self.home.residents, 0)

    def test_economy_and_traffic_use_actual_residents_and_bulldoze_clears_them(self):
        self.home.occupants = 10
        shop = self.city.at(16, 9)
        shop.kind, shop.level = "commercial", 1
        self.city.recalculate()
        self.assertEqual((self.city.population, self.city.workforce, self.city.employed), (10, 5, 5))
        self.assertEqual(self.city.income, 25)
        trips = self.city.traffic().trips
        self.assertEqual(sum(t.count for t in trips if t.kind == "w"), 5)
        self.assertEqual(sum(t.count for t in trips if t.kind == "s"), 1)
        index = self.home.z * SIZE + self.home.x
        self.assertEqual(self.city.snapshot()["tiles"]["residents"][index], 10)
        self.city.build("bulldoze", [(self.home.x, self.home.z)])
        self.assertEqual(self.home.occupants, 0)
        self.assertEqual(self.city.population, 0)

    def test_occupancy_save_validation_migration_and_replay(self):
        self.home.occupants = 7
        self.city.recalculate()
        saved = self.city.save_data()
        restored = City.restore(saved)
        self.assertEqual(restored.at(12, 9).residents, 7)
        self.city.advance()
        restored.advance()
        self.assertEqual(restored.save_data(), self.city.save_data())
        old = {**saved, "version": 5}
        del old["residents"]
        self.assertEqual(City.restore(old).at(12, 9).residents, 48)
        index = 9 * SIZE + 12
        for invalid in (-1, 49, True, 1.5):
            with self.subTest(invalid=invalid):
                counts = saved["residents"].copy()
                counts[index] = invalid
                with self.assertRaisesRegex(ValueError, "residents"):
                    City.restore({**saved, "residents": counts})
        counts = saved["residents"].copy()
        counts[0] = 1
        with self.assertRaisesRegex(ValueError, "residents"):
            City.restore({**saved, "residents": counts})


class WorkforceTests(unittest.TestCase):
    def setUp(self):
        self.city = connected_city()
        for tile in self.city.tiles:
            if tile.kind in ("residential", "commercial", "industrial"):
                tile.kind, tile.level = "empty", 0
        self.home = self.city.at(ORIGIN + 15, ORIGIN + 14)
        self.home.kind, self.home.level, self.home.occupants = "residential", 1, 24
        self.shop = self.city.at(ORIGIN + 23, ORIGIN + 14)
        self.shop.kind, self.shop.level = "commercial", 4
        self.factory = self.city.at(ORIGIN + 25, ORIGIN + 24)
        self.factory.kind, self.factory.level = "industrial", 4
        self.city.recalculate()

    def test_fair_hiring_conserves_workers_and_business_taxes_use_staff(self):
        self.assertEqual(self.city.workforce, 13)
        self.assertEqual((self.shop.workers, self.factory.workers), (5, 8))
        self.assertEqual(self.city.employed, 13)
        self.assertEqual(self.city.jobs, 128)
        self.assertEqual(self.city.income, 24 * 2 + 13)
        self.city.recalculate()
        self.assertEqual((self.shop.workers, self.factory.workers), (5, 8))
        self.shop.condition = 50
        self.city.recalculate()
        self.assertEqual(self.city.income, 24 * 2 + 2 + 8)

    def test_unstaffed_business_decays_then_recovers_without_demolition(self):
        self.home.kind, self.home.level = "empty", 0
        self.city.recalculate()
        for _ in range(14):
            self.city.advance()
        self.assertEqual(self.shop.condition, 16)
        self.assertEqual(self.shop.level, 4)
        self.assertEqual(self.shop.workers, 0)
        self.assertEqual(self.city.income, 0)
        # A supplied business can rehire even at condition zero.
        self.factory.level = 0
        self.home.kind, self.home.level, self.home.occupants = "residential", 4, 96
        self.shop.condition = 0
        self.city.recalculate()
        self.assertEqual(self.shop.workers, 48)
        for _ in range(25):
            self.city.advance()
        self.assertEqual(self.shop.condition, 100)
        self.assertEqual(self.city.snapshot()["distressed"], 0)

    def test_partial_staffing_decay_and_repeated_recalculation_do_not_age(self):
        self.city.advance()
        self.assertEqual(self.shop.condition, 97)
        for _ in range(4):
            self.city.recalculate()
        self.assertEqual(self.shop.condition, 97)

    def test_separate_road_networks_cannot_exchange_workers(self):
        city = self.city
        for tile in city.tiles:
            tile.kind, tile.level, tile.height = "empty", 0, 1
        for x in range(90, SIZE):
            city.at(x, 100).kind = "road"
            city.at(x, 104).kind = "road"
        city.at(100, 101).kind = "power"
        city.at(100, 102).kind = city.at(100, 103).kind = "powerline"
        home, shop = city.at(100, 99), city.at(100, 105)
        home.kind, home.level, home.occupants = "residential", 4, 96
        shop.kind, shop.level = "commercial", 1
        city.recalculate()
        self.assertTrue(shop.connected and shop.powered)
        self.assertEqual(shop.workers, 0)
        self.assertEqual(city.workforce, 52)
        city.build("road", [(95, z) for z in range(101, 104)])
        self.assertEqual(shop.workers, 12)

    def test_bulldoze_resets_condition_and_staff(self):
        self.shop.condition = 12
        self.city.build("bulldoze", [(self.shop.x, self.shop.z)])
        self.assertEqual((self.shop.condition, self.shop.workers, self.shop.level), (100, 0, 0))

    def test_no_business_growth_without_a_local_workforce(self):
        self.home.kind, self.home.level = "empty", 0
        self.shop.level = 0
        self.factory.level = 1
        self.city.recalculate()
        for _ in range(20):
            self.city.advance()
        self.assertEqual(self.shop.level, 0)
        self.assertEqual(self.factory.level, 1)
        self.assertEqual(self.factory.condition, 0)


if __name__ == "__main__":
    unittest.main()
