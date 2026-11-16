import unittest
import numpy as np

from backend.terrain import SIZE, ORIGIN, MIN_HEIGHT, MAX_HEIGHT, GENERATOR_VERSION, _anchor, _fractal, height_samples, world_heights, world_edges
from backend.simulation import City, ADJ, TILE_COUNT
from backend.region import Region, terrain


class WorldTerrainTests(unittest.TestCase):
    def test_partitioning_world_into_districts_does_not_change_samples(self):
        # Include negative coordinates and a four-district junction. The centre
        # samples must match one large world-space evaluation exactly.
        x = np.arange(-SIZE, SIZE, dtype=float) + .5
        z = np.arange(-SIZE, SIZE, dtype=float) + .5
        whole = height_samples(42, x[None, :], z[:, None])
        for cx, cz in ((-1, -1), (0, -1), (-1, 0), (0, 0)):
            part = np.array(world_heights(42, cx, cz)).reshape(SIZE, SIZE)
            np.testing.assert_array_equal(part, whole[(cz + 1) * SIZE:(cz + 2) * SIZE,
                                                      (cx + 1) * SIZE:(cx + 2) * SIZE])

    def test_edges_and_corners_are_identical_from_both_regions(self):
        for cx, cz in ((0, 0), (-1, -1), (2, -3)):
            here, east, south = world_edges(42, cx, cz), world_edges(42, cx + 1, cz), world_edges(42, cx, cz + 1)
            self.assertEqual(here[1], east[3])
            self.assertEqual(here[2], south[0])
            self.assertEqual(here[1][-1], world_edges(42, cx + 1, cz + 1)[0][0])

    def test_relief_has_many_levels_without_breaking_buildable_slopes(self):
        axis = np.arange(-256, 512, dtype=float) + .5
        for seed in (0, 7, 42, 123, 2147483647):
            h = height_samples(seed, axis[None, :], axis[:, None])
            self.assertGreater(int(h.max()), 12)
            self.assertGreaterEqual(len(np.unique(h)), 28)
            self.assertGreaterEqual(int(h.min()), -12)
            self.assertLessEqual(int(h.max()), 32)
            self.assertLessEqual(int(np.abs(np.diff(h, axis=0)).max()), 1)
            self.assertLessEqual(int(np.abs(np.diff(h, axis=1)).max()), 1)

    def test_regions_are_not_mirrored_or_repeated_and_seed_changes_the_world(self):
        a = np.array(world_heights(42, 0, 0)).reshape(SIZE, SIZE)
        b = np.array(world_heights(42, 1, 0)).reshape(SIZE, SIZE)
        self.assertFalse(np.array_equal(a[:, ::-1], b))
        self.assertNotEqual(world_heights(42, 2, 0), world_heights(42, 0, 0))
        self.assertNotEqual(world_heights(42, 2, 0), world_heights(7, 2, 0))

    def test_high_elevation_saves_and_generation_version_round_trip(self):
        city = City(7)
        self.assertGreater(max(t.height for t in city.tiles), 12)
        region = Region(city)
        restored = Region.restore(region.save_data())
        self.assertEqual(restored.generator, GENERATOR_VERSION)
        self.assertEqual(restored.city.save_data(), city.save_data())
        self.assertEqual(terrain(restored.seed, 3, -2, restored.base, restored.generator), world_heights(7, 3, -2))

    def test_previous_perlin_saves_keep_their_generation_profile(self):
        for version in (2, 3, 4):
            with self.subTest(version=version):
                city = City(42, heights=world_heights(42, 0, 0, version))
                city.terrain_generator = version
                restored = Region.restore(Region(city).save_data())
                self.assertEqual(restored.generator, version)
                self.assertEqual(restored.city.save_data(), city.save_data())
                self.assertEqual(terrain(42, 1, 0, restored.base, restored.generator), world_heights(42, 1, 0, version))
                self.assertEqual(restored.mesh(1, 0, 4)['edges'], world_edges(42, 1, 0, version))

    def test_new_landscape_has_more_local_detail_than_previous_profile(self):
        axis = np.arange(256, 512, dtype=float) + .5
        changes = {4: 0, GENERATOR_VERSION: 0}
        residuals = {4: 0., GENERATOR_VERSION: 0.}
        for seed in (0, 7, 42, 123, 2147483647):
            for version in changes:
                heights = height_samples(seed, axis[None, :], axis[:, None], version)
                changes[version] += np.count_nonzero(np.diff(heights, axis=0)) + np.count_nonzero(np.diff(heights, axis=1))
                blocks = heights.reshape(32, 8, 32, 8).transpose(0, 2, 1, 3)
                residuals[version] += float(np.mean((blocks - blocks.mean(axis=(2, 3), keepdims=True)) ** 2))
        self.assertGreater(changes[GENERATOR_VERSION], changes[4] * 1.1)
        self.assertGreater(residuals[GENERATOR_VERSION], residuals[4] * 1.1)

    def test_new_terrain_does_not_flatten_the_old_highway_corridor(self):
        x = np.arange(ORIGIN + 45, SIZE, dtype=float) + .5
        z = np.full_like(x, ORIGIN + 20.5)
        self.assertTrue(np.all(height_samples(42, x, z, 3) == 1))
        self.assertTrue(np.any(height_samples(42, x, z) != 1))

    def test_starter_area_uses_the_unmodified_noise(self):
        x = np.arange(ORIGIN + 4, ORIGIN + 45, dtype=float)[None, :] + .5
        z = np.arange(ORIGIN + 5, ORIGIN + 36, dtype=float)[:, None] + .5
        raw = 2 + 7 * np.tanh((x - 45) / 40) + _fractal(x, z, 42, GENERATOR_VERSION) - _anchor(42, GENERATOR_VERSION)
        expected = np.rint(np.clip(raw, -12, 32)).astype(np.int16)
        np.testing.assert_array_equal(height_samples(42, x, z), expected)
        self.assertGreater(len(np.unique(expected)), 1)

    def test_default_district_has_lower_hills_with_more_local_changes(self):
        old = np.array(world_heights(42, 0, 0, 2))
        new = np.array(world_heights(42, 0, 0, 3))
        self.assertLess(int(new.max()), int(old.max()) * .75)
        def turns(version):
            transect = height_samples(42, np.full(256, 300.5), np.arange(256) + 256.5, version)
            signs = np.sign(np.diff(transect))
            return np.count_nonzero(np.diff(signs[signs != 0]))
        self.assertGreater(turns(3), turns(2))

    def test_terraform_cascade_cannot_change_a_shared_border(self):
        city = City(heights=tuple([1] * TILE_COUNT), starter=False)
        for z in range(SIZE):
            for x in range(SIZE):
                city.at(x, z).height = min(30, x)
        city.recalculate()
        before, money = [t.height for t in city.tiles], city.money
        # The 30-level slope propagates all the way to x=0, despite starting
        # farther inside than the previous fixed 20-cell exclusion distance.
        with self.assertRaisesRegex(ValueError, "shared district border"):
            city.build('raise', [(25, 100)], preserve_border=True)
        self.assertEqual([t.height for t in city.tiles], before)
        self.assertEqual(city.money, money)


if __name__ == '__main__':
    unittest.main()
