import unittest
from backend.autoplay import AutoPlayer, MAX_ACTIONS
from backend.simulation import City, TILE_COUNT, SIZE, ADJ, ZONES


class AutoplayTests(unittest.TestCase):
    def test_budget_pause_and_monthly_limit(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        player = AutoPlayer(reserve=24000, mode="growth")
        player.enabled = True
        player.step(city)
        self.assertEqual(city.money, 24000)
        self.assertEqual(player.actions, 0)
        player.reserve = 5000
        city.set_speed(0)
        city.tick += 1
        player.step(city)
        self.assertEqual(player.actions, 0)
        city.set_speed(1)
        player.step(city)
        self.assertGreater(player.actions, 0)
        self.assertLessEqual(player.actions, MAX_ACTIONS)
        actions = player.actions
        player.step(city)
        self.assertEqual(player.actions, actions)
        self.assertGreaterEqual(city.money, 5000)

    def test_target_stops_without_spending(self):
        city = City()
        player = AutoPlayer(target=1, mode="growth")
        player.enabled = True
        player.step(city)
        self.assertFalse(player.enabled)
        self.assertEqual(player.actions, 0)

    def test_empty_city_replay_and_growth(self):
        results = []
        for _ in range(2):
            city = City(heights=(1,) * TILE_COUNT, starter=False)
            player = AutoPlayer(mode="growth")
            player.enabled = True
            for _ in range(12):
                player.step(city)
                city.run(2)
            self.assertGreater(city.population, 0)
            self.assertGreaterEqual(city.money, player.reserve)
            self.assertEqual(City.restore(city.save_data()).population, city.population)
            results.append((city.save_data(), list(player.log)))
        self.assertEqual(results[0], results[1])

    def test_live_api_validation_and_stop(self):
        from fastapi.testclient import TestClient
        from backend import app as module
        client = TestClient(module.app)
        self.assertEqual(client.post('/api/autoplay', json={'enabled': True, 'reserve': -1}).status_code, 422)
        response = client.post('/api/autoplay', json={'enabled': True, 'reserve': 5000, 'target': 900})
        self.assertTrue(response.json()['enabled'])
        self.assertFalse(client.post('/api/autoplay', json={'enabled': False}).json()['enabled'])

    def test_block_layout_is_connected_and_does_not_replace_development(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        city.build("road", [(100, 100)])
        city.build("park", [(102, 100)])
        road = 100*SIZE+100
        empty = lambda i: city.tiles[i].kind == "empty" and not city.tiles[i].water
        command, _ = AutoPlayer.extend(city, [road], empty)
        self.assertIsNotNone(command)
        tool, cells, variant = command
        self.assertGreater(len(cells), 30)
        self.assertNotIn((102, 100), cells)
        city.build(tool, cells, variant)
        components = {city._components[z*SIZE+x] for x, z in cells}
        self.assertEqual(components, {city._components[road]})
        self.assertEqual(city.at(102, 100).kind, "park")
        # The block has junctions and loops, not merely a longer single dead-end.
        self.assertGreaterEqual(sum(sum(city.tiles[j].kind == "road" for j in ADJ[z*SIZE+x]) >= 3 for x, z in cells), 2)

    def test_first_year_lays_out_and_zones_a_serviced_neighbourhood(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        player = AutoPlayer(mode="growth")
        player.enabled = True
        largest_batch = 0
        for _ in range(12):
            previous = player.actions
            player.step(city)
            self.assertLessEqual(player.actions-previous, MAX_ACTIONS)
            self.assertGreaterEqual(city.money, player.reserve)
            largest_batch = max(largest_batch, max((len(e["cells"]) for e in player.log if e["tool"] in ZONES), default=0))
            city.run(2)
        self.assertGreaterEqual(sum(t.kind == "road" for t in city.tiles), 40)
        self.assertGreaterEqual(sum(t.kind in ZONES for t in city.tiles), 40)
        self.assertGreaterEqual(largest_batch, 8)
        self.assertLess(city.water_network.summary["unserved"], .01)
        self.assertTrue(all(t.road_access and t.powered for t in city.tiles if t.kind in ZONES))

    def test_full_block_budget_includes_servicing_buffer_and_runway(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        player = AutoPlayer(reserve=5000, mode="growth")
        command = ("road", [(x, 10) for x in range(10, 50)], "r")
        # Can pay for asphalt alone, but cannot fund the connected neighbourhood.
        city.money = 5600
        self.assertFalse(player.affordable(city, command))
        city.money = 8000
        self.assertTrue(player.affordable(city, command))

    def test_wet_terrain_is_excluded_from_planned_roads(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        city.build("road", [(100, 100)])
        for z in range(101, 110):
            for x in range(101, 115):
                city.at(x, z).height = -1
        empty = lambda i: city.tiles[i].kind == "empty" and not city.tiles[i].water
        command, _ = AutoPlayer.extend(city, [100*SIZE+100], empty)
        self.assertIsNotNone(command)
        self.assertTrue(all(not city.at(x, z).water for x, z in command[1]))

    def test_starter_city_opens_an_expansion_block_before_running_out_of_lots(self):
        city = City()
        player = AutoPlayer(mode="growth")
        player.enabled = True
        roads_before = sum(t.kind == "road" for t in city.tiles)
        player.step(city)
        self.assertGreater(sum(t.kind == "road" for t in city.tiles), roads_before)
        self.assertGreaterEqual(player.blocks_built, 1)
        self.assertGreaterEqual(city.money, player.reserve)

class StressTests(unittest.TestCase):
    def test_wealth_funds_sprawl_all_types_and_continues_without_month_or_target_gate(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        city.money = 2700000
        player = AutoPlayer(reserve=5001, target=1)
        player.enabled = True
        player.step(city, max_actions=64)
        self.assertEqual(player.missing, [])
        self.assertGreater(sum(t.kind == 'road' for t in city.tiles), 800)
        self.assertGreater(sum(t.kind in ZONES for t in city.tiles), 800)
        before = player.actions
        player.step(city, max_actions=8)
        self.assertGreater(player.actions, before)
        self.assertTrue(player.enabled)
        self.assertEqual(city.money, 2700000-player.spent)
        self.assertGreaterEqual(city.money, player.reserve)
        self.assertIsNone(player.status()['actionsPerMonth'])

    def test_reserve_pause_and_soft_budget_resume(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        player = AutoPlayer(reserve=city.money)
        player.enabled = True
        self.assertFalse(player.step(city))
        player.reserve = 5001
        city.set_speed(0)
        self.assertFalse(player.step(city))
        city.set_speed(1)
        player.step(city, max_actions=64, time_budget_ms=0)
        self.assertEqual(player.actions, 1)
        self.assertGreater(len(player.stress.queue), 0)
        player.step(city, max_actions=64, time_budget_ms=0)
        self.assertEqual(player.actions, 2)
        self.assertGreaterEqual(city.money, player.reserve)

    def test_commands_replay_exactly_and_keep_full_batch_log(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        city.money = 2700000
        replay = City.restore(city.save_data())
        player = AutoPlayer()
        player.enabled = True
        player.step(city, max_actions=40)
        self.assertEqual(len(player.last_commands), 40)
        for entry in player.last_commands:
            cost = replay.build(entry['tool'], entry['cells'], entry['variant'], rotation=entry['rotation'], preserve_border=True)
            self.assertEqual(cost, entry['cost'])
            self.assertEqual(replay.money, entry['money'])
        self.assertEqual(replay.save_data(), city.save_data())

    def test_manual_edits_invalidate_queued_surface_work(self):
        city = City(heights=(1,) * TILE_COUNT, starter=False)
        player = AutoPlayer()
        player.enabled = True
        player.step(city, max_actions=1)
        # A player takes a future zoning site while the queued project is building.
        zone = next(a for a in player.stress.queue if a.tool in ZONES)
        cell = zone.cells[0]
        city.build('park', [cell])
        player.step(city, max_actions=64)
        self.assertEqual(city.at(*cell).kind, 'park')
        self.assertIn('Replanning', player.reason)
        self.assertEqual(len(player.stress.queue), 0)
