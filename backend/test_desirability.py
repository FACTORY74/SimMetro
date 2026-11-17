import copy
import unittest
from backend.desirability import evaluate, sample_services
from backend.simulation import City, SIZE
from backend.traffic import Trip, TrafficPlan
from backend.test_water import water_city


class DesirabilityTests(unittest.TestCase):
    def setUp(self):
        self.city = water_city()
        self.index = 9*SIZE+13

    def row(self, city=None, plan=None):
        return evaluate(city or self.city, plan)["lots"][str(self.index)]

    def test_components_explain_bounded_target_and_profiles(self):
        city = self.city
        base = self.row()
        city.build("park", [(12, 11), (13, 11), (14, 11), (15, 11)])
        row = self.row()
        self.assertEqual(row["target"], min(100, max(0, sum(c["points"] for c in row["components"]))))
        self.assertEqual(row["target"]-base["target"], 20)
        city.build("industrial", [(14, 9)], "m")
        city.at(14, 9).level = 1
        city.recalculate()
        row = self.row()
        self.assertEqual(next(c["points"] for c in row["components"] if c["label"] == "Industrial nuisance"), -10)
        city.at(13, 9).kind, city.at(13, 9).variant = "industrial", "m"
        city.at(13, 9).occupants = 0
        city.recalculate()
        row = self.row()
        self.assertEqual(row["profile"], "manufacturing")
        self.assertEqual(next(c["points"] for c in row["components"] if c["label"] == "Industrial nuisance"), 0)

    def test_disconnected_parks_do_not_grant_amenity(self):
        city = self.city
        city.build("park", [(13, 7)])
        city.build("road", [(12, 7)])
        self.assertEqual(next(c["points"] for c in self.row()["components"] if c["label"] == "Parks"), 0)

    def test_powered_public_services_add_named_coverage_contributions(self):
        expected = {"f": ("Fire station", 5), "p": ("Police station", 6), "e": ("School", 10)}
        for variant, (label, points) in expected.items():
            city = water_city()
            city.build("service", [(12, 9)], variant)
            row = self.row(city)
            component = next(c for c in row["components"] if c["label"] == label)
            self.assertEqual(component["points"], points)
            self.assertIn("Covered", component["detail"])
            restored = City.restore(city.save_data())
            self.assertEqual((restored.at(12, 9).kind, restored.at(12, 9).subtype), ("service", variant))

    def test_weighted_actual_commutes_penalize_long_and_failed_routes(self):
        def plan(minutes, routes):
            trips = [Trip("w", self.index, 9*SIZE+23, n, 480, 960, route) for n, route in zip((1, 3), routes)]
            return TrafficPlan(trips, minutes, [0]*len(self.city.tiles), 4, 0, 0)
        short = self.row(plan=plan([10, 10], ["E", "E"]))
        long = self.row(plan=plan([10, 50], ["E", "E"]))
        self.assertEqual(long["commuteMinutes"], 40)
        self.assertEqual(short["target"]-long["target"], 15)
        failed = self.row(plan=plan([10, 10], ["", ""]))
        # The nearby coal plant already depresses the lot close to the score
        # floor, so only twenty of the failed-route penalty remains visible.
        self.assertEqual(short["target"]-failed["target"], 20)

    def test_time_weighted_reliability_and_inspection_has_no_side_effects(self):
        city = self.city
        sample_services(city, 15)
        city.build("bulldoze", [(10, 9)])
        sample_services(city, 5)
        before = copy.deepcopy(city.save_data())
        self.row()
        city.snapshot()
        self.assertEqual(before, city.save_data())
        city.advance()
        row = self.row()
        self.assertAlmostEqual(row["powerReliability"], .75)
        self.assertIn("No power", row["blockers"])

    def test_amenity_cannot_override_missing_services(self):
        city = self.city
        city.build("park", [(12, 11), (13, 11), (14, 11)])
        city.build("remove_pipe", [(12, 10)])
        # Directly remove all pipes to make the service gate unambiguous.
        city.build("remove_pipe", [(i%SIZE, i//SIZE) for i in city.pipes])
        row = self.row()
        self.assertIn("Water shortage", row["blockers"])
        self.assertFalse(row["eligible"])
        before = city.at(13, 9).residents
        city.advance()
        self.assertEqual(city.at(13, 9).residents, before)

    def test_sustained_decline_hysteresis_recovery_and_no_double_water_loss(self):
        city = self.city
        city.build("bulldoze", [(10, 9)])
        before = city.at(13, 9).residents
        for _ in range(2):
            city.advance()
        self.assertEqual(city.at(13, 9).residents, before)
        city.advance()
        self.assertEqual(city.at(13, 9).residents, before-before//10)  # Water loss, not water + reputation.
        self.assertTrue(self.row()["declining"])
        city.build("power", [(10, 9)], "w")
        city.build("park", [(12, 11), (13, 11), (14, 11)])
        for _ in range(12):
            city.advance()
        row = self.row()
        self.assertFalse(row["declining"])
        self.assertEqual(row["poorMonths"], 0)
        self.assertGreater(city.at(13, 9).residents, before)

    def test_score_and_samples_roundtrip_migration_validation_and_repaint_reset(self):
        city = self.city
        city.run(2.25)
        saved = city.save_data()
        other = City.restore(saved)
        city.run(2)
        other.run(2)
        self.assertEqual(city.save_data(), other.save_data())
        old = copy.deepcopy(saved)
        old["version"] = 7
        old.pop("desirability")
        migrated = City.restore(old)
        self.assertEqual(migrated.desirability_state, {})
        self.assertEqual(self.row(migrated)["poorMonths"], 0)
        bad = copy.deepcopy(saved)
        bad["desirability"]["state"][str(self.index)]["score"] = float("nan")
        with self.assertRaises(ValueError): City.restore(bad)
        bad = copy.deepcopy(saved)
        bad["desirability"]["samples"][str(self.index)] = [5, 6, 5]
        with self.assertRaises(ValueError): City.restore(bad)
        city.build("bulldoze", [(13, 9)])
        self.assertNotIn(self.index, city.desirability_state)
        self.assertNotIn(self.index, city.desirability_samples)

    def test_snapshot_and_offscreen_batching_agree(self):
        city = self.city
        city.set_speed("day")
        other = City.restore(city.save_data())
        city.run(10, power_step=30)
        for _ in range(40): other.run(.25)
        self.assertEqual(city.desirability_samples, other.desirability_samples)
        city.advance()
        other.advance()
        self.assertEqual(city.desirability_state, other.desirability_state)
        self.assertEqual(city.snapshot()["desirability"], evaluate(city))

    def test_fully_staffed_business_still_declines_at_a_sustained_poor_location(self):
        city = self.city
        city.build("commercial", [(15, 9)], "r")
        shop = city.at(15, 9)
        shop.level = 1
        city.recalculate()
        self.assertEqual(shop.workers, shop.job_capacity)
        city.desirability_state[9*SIZE+15] = dict(score=0., poor=2, month=0, power=1., water=1.)
        city.advance()
        self.assertEqual(shop.condition, 96)

    def test_service_samples_do_not_cross_months_when_batched(self):
        for speed in ("day", 1):
            with self.subTest(speed=speed):
                city = water_city()
                city.set_speed(speed)
                if speed == "day":
                    city.clock = city.power_clock = 43200-10
                else:
                    city._fast_seconds = 1.5
                other = City.restore(city.save_data())
                city.run(1, power_step=30)
                for _ in range(4):
                    other.run(.25)
                self.assertEqual(city.tick, other.tick)
                self.assertEqual(city.desirability_state, other.desirability_state)
                self.assertEqual(city.desirability_samples, other.desirability_samples)
