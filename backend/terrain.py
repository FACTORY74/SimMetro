"""Seeded gradient-Perlin terrain in absolute world coordinates.

No district-local normalization or edge mirroring: partitioning the same world
into different rectangles produces exactly the same height samples.
"""
from functools import lru_cache
import numpy as np

SIZE = 256
MIN_HEIGHT, MAX_HEIGHT = -32, 96
GENERATOR_VERSION = 5
PERLIN_GENERATORS = (2, 3, 4, GENERATOR_VERSION)
ORIGIN = 80

_D = 2 ** -.5
_GRADIENTS = np.array(((1, 0), (-1, 0), (0, 1), (0, -1),
                       (_D, _D), (-_D, _D), (_D, -_D), (-_D, -_D)))
_PROFILES = {
    2: ((2048., 80.), (1024., 40.), (512., 24.), (256., 8.)),
    3: ((192., 16.), (96., 8.), (48., 3.), (24., 1.)),
    4: ((128., 18.), (64., 8.), (32., 3.), (16., 1.), (8., .35)),
    5: ((128., 17.), (64., 8.), (32., 3.5), (16., 1.4), (8., .8), (4., .25)),
}


def perlin(x, z, seed):
    ix, iz = np.floor(x).astype(np.int64), np.floor(z).astype(np.int64)
    fx, fz = x - ix, z - iz
    u, v = fx ** 3 * (fx * (fx * 6 - 15) + 10), fz ** 3 * (fz * (fz * 6 - 15) + 10)

    def dot(dx, dz):
        h = ((ix + dx) * 374761393 + (iz + dz) * 668265263 + seed * 2246822519) & 0xFFFFFFFF
        h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
        gradients = _GRADIENTS[(h ^ (h >> 16)) & 7]
        return gradients[..., 0] * (fx - dx) + gradients[..., 1] * (fz - dz)

    a, b, c, d = dot(0, 0), dot(1, 0), dot(0, 1), dot(1, 1)
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v


def _fractal(x, z, seed, generator):
    return sum(amplitude * perlin((x + 713) / scale, (z - 419) / scale, seed + octave * 101)
               for octave, (scale, amplitude) in enumerate(_PROFILES[generator]))


@lru_cache(maxsize=8)
def _anchor(seed, generator):
    return float(_fractal(np.asarray(100.5), np.asarray(100.5), seed, generator))


def height_samples(seed: int, x, z, generator: int = GENERATOR_VERSION):
    x, z = np.broadcast_arrays(np.asarray(x, dtype=np.float64), np.asarray(z, dtype=np.float64))
    coast = 8 + 24 * np.tanh((x - 64) / 160) if generator == 2 else 2 + 7 * np.tanh((x - 45) / 40)
    raw = coast + _fractal(x, z, seed, generator) - _anchor(seed, generator)
    if generator in (2, 3, 4):
        def rectangle_distance(x0, z0, x1, z1):
            return np.maximum(np.maximum(x0 - x, x - x1), 0) + np.maximum(np.maximum(z0 - z, z - z1), 0)
        distance = rectangle_distance(ORIGIN + 4.5, ORIGIN + 5.5, ORIGIN + 44.5, ORIGIN + 35.5)
        if generator in (2, 3):
            distance = np.minimum(distance, rectangle_distance(ORIGIN + 4.5, ORIGIN + 19.5, SIZE - .5, ORIGIN + 21.5))
        raw = np.clip(raw, 1 - distance, 1 + distance)
    low, high = (MIN_HEIGHT, MAX_HEIGHT) if generator == 2 else (-12, 32)
    return np.rint(np.clip(raw, low, high)).astype(np.int16)


@lru_cache(maxsize=64)
def world_heights(seed: int, cx: int, cz: int, generator: int = GENERATOR_VERSION) -> tuple[int, ...]:
    x = cx * SIZE + np.arange(SIZE, dtype=np.float64) + .5
    z = cz * SIZE + np.arange(SIZE, dtype=np.float64) + .5
    return tuple(map(int, height_samples(seed, x[None, :], z[:, None], generator).ravel()))


@lru_cache(maxsize=64)
def world_edges(seed: int, cx: int, cz: int, generator: int = GENERATOR_VERSION) -> tuple[tuple[float, ...], ...]:
    """Shared half-cell surface vertices, averaging the cells on BOTH sides."""
    t = np.arange(2 * SIZE + 1, dtype=np.float64) / 2
    sides = ((t, np.zeros_like(t)), (np.full_like(t, SIZE), t),
             (t, np.full_like(t, SIZE)), (np.zeros_like(t), t))
    result = []
    for x, z in sides:
        x, z = x + cx * SIZE, z + cz * SIZE
        left, right = np.floor(x - .5) + .5, np.floor(x) + .5
        top, bottom = np.floor(z - .5) + .5, np.floor(z) + .5
        samples = (height_samples(seed, left, top, generator).astype(float) + height_samples(seed, right, top, generator) +
                   height_samples(seed, left, bottom, generator) + height_samples(seed, right, bottom, generator)) / 4
        result.append(tuple(map(float, samples)))
    return tuple(result)
