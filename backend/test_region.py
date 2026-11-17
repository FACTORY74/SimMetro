import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import app as app_module
from backend.region import Activity, Region, terrain, district_at, detailed_districts, visible_detail
from backend.simulation import City, SIZE


class RegionTests(unittest.TestCase):
    def test_adaptive_shell_adds_only_coarse_terrain(self):
        region = Region(City(), workers=1)
        outer = City(region.seed, heights=tuple([1] * (SIZE * SIZE)), starter=False)
        outer.at(10, 10).kind = "road"
        region.cities[(2, 0)] = outer
        ordinary = region.view(SIZE / 2, SIZE / 2, 75)
        expanded = region.view(SIZE / 2, SIZE / 2, 75, terrain_shell=1)
        fullest = region.view(SIZE / 2, SIZE / 2, 75, terrain_shell=3)
        self.assertEqual(len(ordinary["tiles"]), 9)
        self.assertEqual(len(expanded["tiles"]), 25)
        self.assertEqual(len(fullest["tiles"]), 81)
        shell = [tile for tile in expanded["tiles"] if max(abs(tile["x"]), abs(tile["z"])) == 2]
        self.assertTrue(shell)
        self.assertTrue(all(tile["step"] == 4 for tile in shell))
        self.assertTrue(all(not tile["buildings"] and "detail" not in tile for tile in shell))
        self.assertTrue(all(SIZE % tile["step"] == 0 for tile in fullest["tiles"]))

    def test_bounded_executor_can_run_independent_hot_districts(self):
        region = Region(City(), workers=2)
        barrier = threading.Barrier(2)
        threads = []

        class FakeCity:
            speed = 1

            def run(self, seconds, **kwargs):
                threads.append(threading.get_ident())
                barrier.wait(timeout=2)

        region.cities = {(0, 0): FakeCity(), (1, 0): FakeCity()}
        region.focus, region.high = (0, 0), {(0, 0), (1, 0)}
        region.run(.25)
        self.assertEqual(len(set(threads)), 2)
        region._executor.shutdown()

    def test_activity_levels_distinguish_hot_cold_and_dormant_districts(self):
        region = Region(City(), workers=1)
        home = region.city
        region.select(SIZE * 2 + 100, 100)
        empty = region.focus
        self.assertEqual(region.activity(empty), Activity.HOT)
        self.assertEqual(region.activity((0, 0)), Activity.COLD)
        home.set_speed(0)
        self.assertEqual(region.activity((0, 0)), Activity.DORMANT)
        self.assertEqual(region.activity_counts(), {"hot": 1, "cold": 0, "dormant": 1})

    def test_visual_detail_preloads_before_crossing_and_retains_previous_district(self):
        before = visible_detail(SIZE - 80, SIZE / 2, 75)
        self.assertEqual(before, {(0, 0), (1, 0)})
        after = visible_detail(SIZE + 1, SIZE / 2, 75, before)
        self.assertEqual(after, before)
        # Reversing slightly does not thrash at the loading threshold.
        self.assertNotIn((1, 0), visible_detail(SIZE - 110, SIZE / 2, 75))
        self.assertIn((1, 0), visible_detail(SIZE - 110, SIZE / 2, 75, before))
        self.assertNotIn((1, 0), visible_detail(SIZE - 140, SIZE / 2, 75, before))
        self.assertEqual(visible_detail(SIZE, SIZE, 75), {(0, 0), (1, 0), (0, 1), (1, 1)})
        self.assertEqual(visible_detail(SIZE, SIZE, 700, before), set())
        self.assertIn((-1, 0), visible_detail(40, SIZE / 2, 75))

    def test_preloaded_terrain_matches_the_focused_city_after_crossing(self):
        region = Region(City())
        before = region.view(SIZE - 80, SIZE / 2, 75)
        neighbour = next(t for t in before['tiles'] if (t['x'], t['z']) == (1, 0))
        self.assertIn('detail', neighbour)
        self.assertEqual(len(region.cities), 1)  # Rendering alone does not create a City.
        heights = list(neighbour['detail']['heights'])
        region.select(SIZE + 1, SIZE / 2)
        self.assertEqual(heights, [t.height for t in region.city.tiles])
        after = region.view(SIZE + 1, SIZE / 2, 75)
        self.assertTrue(all('detail' in t for t in after['tiles'] if (t['x'], t['z']) in ((0, 0), (1, 0))))
        restored = Region.restore(region.save_data())
        self.assertNotEqual(restored.render_id, region.render_id)

    def test_legacy_200_map_preserves_lots_batteries_and_regional_road_access(self):
        data = City().save_data()
        data["version"] = 6
        data.pop("water")
        data.pop('size')
        data.pop('terrain_generator')
        data['heights'] = [1] * 40000
        data['conditions'] = [100] * 40000
        data['residents'] = [0] * 40000
        kinds, variants, levels = list('.' * 40000), list('.' * 40000), list('0' * 40000)
        kinds[100 * 200 + 199] = '='
        i = 99 * 200 + 110
        kinds[i], variants[i] = 'p', 'b'
        home = 99 * 200 + 111
        kinds[home], variants[home], levels[home], data['residents'][home] = 'r', 'h', '1', 7
        data.update(kinds=''.join(kinds), variants=''.join(variants), levels=''.join(levels), battery_storage={str(i): 123.5})
        region = Region.restore(data)
        offset = (SIZE - 200) // 2
        city = region.city
        self.assertEqual(city.at(110 + offset, 99 + offset).subtype, 'b')
        self.assertEqual(city.at(111 + offset, 99 + offset).residents, 7)
        self.assertEqual(city.battery_storage[(99 + offset) * SIZE + 110 + offset], 123.5)
        self.assertTrue(city.at(199 + offset, 100 + offset).connected)
        self.assertEqual(city.at(SIZE - 1, 100 + offset).kind, 'road')
        self.assertEqual(region.mesh(0, 0, 4)['edges'][1], region.mesh(1, 0, 32)['edges'][3])
        restored = Region.restore(json.loads(json.dumps(region.save_data())))
        self.assertEqual(restored.city.save_data(), city.save_data())

    def test_focus_supports_negative_coordinates_and_four_district_junction(self):
        self.assertEqual(district_at(-.1, -SIZE - 1), (-1, -2))
        self.assertEqual(detailed_districts(100, 100), {(0, 0)})
        self.assertEqual(detailed_districts(SIZE, SIZE), {(0, 0), (1, 0), (0, 1), (1, 1)})

    def test_generated_terrain_is_deterministic_sloped_and_seamless(self):
        for cx, cz in ((0, 0), (-1, 0), (1, 1)):
            a = terrain(42, cx, cz)
            b = terrain(42, cx + 1, cz)
            c = terrain(42, cx, cz + 1)
            self.assertTrue(all(abs(a[z * SIZE + SIZE - 1] - b[z * SIZE]) <= 1 for z in range(SIZE)))
            self.assertTrue(all(abs(v - w) <= 1 for v, w in zip(a[-SIZE:], c[:SIZE])))
            self.assertTrue(all(abs(a[z * SIZE + x] - a[z * SIZE + x + 1]) <= 1
                                for z in range(SIZE) for x in range(SIZE - 1)))
            self.assertTrue(all(abs(a[z * SIZE + x] - a[(z + 1) * SIZE + x]) <= 1
                                for z in range(SIZE - 1) for x in range(SIZE)))
        expected = terrain(42, 2, 2)
        terrain.cache_clear()
        self.assertEqual(terrain(42, 2, 2), expected)
        self.assertNotEqual(expected, terrain(42, 4, 2))

    def test_lod_borders_match_and_generated_views_do_not_allocate_cities(self):
        region = Region(City())
        a, b = region.mesh(0, 0, 4), region.mesh(1, 0, 32)
        self.assertEqual(a['edges'][1], b['edges'][3])
        self.assertGreater(len(a['heights']), len(b['heights']))
        self.assertEqual(len(region.cities), 1)
        region.city.run(.25)
        self.assertIs(a, region.mesh(0, 0, 4))  # Clock changes do not rebuild static meshes.

    def test_empty_districts_are_evicted_and_modified_districts_survive_save_load(self):
        region = Region(City())
        region.select(300, 100)
        self.assertTrue(all(t.kind == 'empty' for t in region.city.tiles))
        tile = next(t for t in region.city.tiles if not t.water and 20 < t.x < 180 and 20 < t.z < 180)
        region.city.build('road', [(tile.x, tile.z)])
        region.modified.add(region.focus)
        region.select(SIZE * 2 + 100, 100)
        region.select(SIZE * 3 + 100, 100)
        self.assertNotIn((2, 0), region.cities)
        restored = Region.restore(json.loads(json.dumps(region.save_data())))
        restored.select(300, 100)
        self.assertEqual(restored.city.at(tile.x, tile.z).kind, 'road')
        self.assertEqual(restored.focus, (1, 0))
        self.assertEqual(Region.restore(City().save_data()).focus, (0, 0))

    def test_coarse_city_keeps_calendar_and_budget_running_and_pause_flushes(self):
        region = Region(City())
        original = region.city
        region.select(SIZE * 2 + 100, 100)
        region.run(1)
        self.assertEqual(original.tick, 0)
        region.run(1)
        self.assertEqual(original.tick, 1)
        self.assertNotEqual(original.money, 24000)
        region.run(.5)
        region.set_speed(0)
        before = json.dumps(region.save_data(), sort_keys=True)
        region.run(10)
        self.assertEqual(json.dumps(region.save_data(), sort_keys=True), before)
        Region.restore(region.save_data())


class RegionApiTests(unittest.TestCase):
    def setUp(self):
        self.old_city, self.old_region = app_module.city, app_module.region
        app_module.city = City()
        app_module.region = Region(app_module.city)
        self.client = TestClient(app_module.app)

    def tearDown(self):
        app_module.city, app_module.region = self.old_city, self.old_region

    def test_view_switches_district_and_rejects_stale_construction(self):
        original = self.client.get('/api/state').json()
        home = next(t for t in app_module.city.tiles if t.kind == 'residential' and t.residents)
        self.assertEqual(original['tiles']['residents'][home.z * SIZE + home.x], home.residents)
        result = self.client.get('/api/view', params={'x': 300, 'z': 100, 'distance': 75}).json()
        self.assertEqual(result['state']['district'], [1, 0])
        self.assertEqual(set(result['region']['performance']), {'updatesPerSecond', 'simulationMs'})
        self.assertGreater(result['state']['revision'], original['revision'])
        response = self.client.post('/api/build', json={'tool': 'road', 'district': [0, 0], 'cells': [{'x': 100, 'z': 100}]})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.get('/api/traffic').json()['district'], [1, 0])
        self.assertEqual(self.client.get('/api/view', params={'x': 'NaN'}).status_code, 422)

    def test_region_save_endpoint_preserves_multiple_districts_and_focus(self):
        with TemporaryDirectory() as directory, patch.object(app_module, 'SAVE_PATH', Path(directory) / 'city.json'):
            self.client.get('/api/view', params={'x': 300, 'z': 100})
            city = app_module.city
            tile = next(t for t in city.tiles if not t.water)
            response = self.client.post('/api/build', json={'tool': 'road', 'district': [1, 0], 'cells': [{'x': tile.x, 'z': tile.z}]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.client.post('/api/save').status_code, 200)
            self.client.get('/api/view', params={'x': 100, 'z': 100})
            loaded = self.client.post('/api/load')
            self.assertEqual(loaded.status_code, 200, loaded.text[:200])
            self.assertEqual(loaded.json()['district'], [1, 0])
            self.assertEqual(app_module.city.at(tile.x, tile.z).kind, 'road')
            self.assertIn((0, 0), app_module.region.cities)


if __name__ == '__main__':
    unittest.main()
