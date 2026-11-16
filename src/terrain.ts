import type { Ray } from "three";
import type { Cell } from "./types";

export const LEVEL_HEIGHT = .6;
export const WATER_Y = -.12;
export const MAX_LEVEL = 96;
export const MIN_LEVEL = -32;
export const TERRAIN_COLORS = [
  [-32, "#193d52"], [-12, "#2c5562"], [-3, "#4f7c7c"], [-1, "#8fa688"],
  [0, "#d9cb93"], [1, "#86b472"], [6, "#6f9f5f"], [12, "#7f9558"],
  [18, "#8f8670"], [24, "#9a9488"], [30, "#e7ece8"], [96, "#ffffff"],
] as const;

/** World-space Y of a terrain level. */
export const groundY = (height: number) => height * LEVEL_HEIGHT;
/** Height at which a pointer ray first meets a tile centre: land, or the water above a seabed. */
export const surfaceY = (height: number) => Math.max(groundY(height), WATER_Y);

/**
 * Continuous terrain built on a half-tile vertex grid. A tile's centre sits exactly at its
 * level; edge midpoints and corners average the tiles that touch them. Because neighbouring
 * levels differ by at most one, this forms ramps between levels that roads and lots can follow.
 */
export interface Surface {
  readonly size: number;
  /** Terrain level at each half-grid vertex, (2 * size + 1)² entries, row-major by z. */
  readonly levels: Float32Array;
  /** Interpolated terrain level at a world-space position. */
  levelAt(x: number, z: number): number;
  /** World Y of the land (or seabed) at a world-space position. */
  groundAt(x: number, z: number): number;
}

export function createSurface(size: number, heightAt: (x: number, z: number) => number, edges?: readonly (readonly number[])[] | null): Surface {
  const n = 2 * size + 1;
  const levels = new Float32Array(n * n);
  const touching = (i: number) => i % 2 ? [(i - 1) / 2] : [i / 2 - 1, i / 2].filter(t => t >= 0 && t < size);
  for (let j = 0; j < n; j++) {
    const zs = touching(j);
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (const z of zs) for (const x of touching(i)) { sum += heightAt(x, z); count++; }
      levels[j * n + i] = sum / count;
    }
  }
  if (edges) for (let i = 0; i < n; i++) {
    levels[i] = edges[0]![i]!;
    levels[i * n + n - 1] = edges[1]![i]!;
    levels[(n - 1) * n + i] = edges[2]![i]!;
    levels[i * n] = edges[3]![i]!;
  }
  const levelAt = (x: number, z: number) => {
    const u = Math.min(Math.max(x * 2, 0), n - 1), v = Math.min(Math.max(z * 2, 0), n - 1);
    const i = Math.min(Math.floor(u), n - 2), j = Math.min(Math.floor(v), n - 2);
    const fu = u - i, fv = v - j;
    const a = levels[j * n + i]!, b = levels[j * n + i + 1]!;
    const c = levels[(j + 1) * n + i]!, d = levels[(j + 1) * n + i + 1]!;
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };
  return { size, levels, levelAt, groundAt: (x, z) => groundY(levelAt(x, z)) };
}

/** Write an orthonormal vehicle transform aligned with the road surface. */
export function writeVehicleTransform(surface: Surface, x: number, z: number, dx: number, dz: number,
  length: number, height: number, matrix: Float32Array, offset: number) {
  const sample = .1;
  const along = (surface.groundAt(x + dx * sample, z + dz * sample) -
    surface.groundAt(x - dx * sample, z - dz * sample)) / (2 * sample);
  const across = (surface.groundAt(x - dz * sample, z + dx * sample) -
    surface.groundAt(x + dz * sample, z - dx * sample)) / (2 * sample);
  const f = 1 / Math.hypot(dx, along, dz), fx = dx * f, fy = along * f, fz = dz * f;
  const rx = -dz, ry = across, rz = dx;
  let nx = ry * fz - rz * fy, ny = rz * fx - rx * fz, nz = rx * fy - ry * fx;
  const n = 1 / Math.hypot(nx, ny, nz);
  nx *= n; ny *= n; nz *= n;
  matrix[offset] = fx * length; matrix[offset + 1] = fy * length; matrix[offset + 2] = fz * length; matrix[offset + 3] = 0;
  matrix[offset + 4] = nx * height; matrix[offset + 5] = ny * height; matrix[offset + 6] = nz * height; matrix[offset + 7] = 0;
  matrix[offset + 8] = fy * nz - fz * ny; matrix[offset + 9] = fz * nx - fx * nz;
  matrix[offset + 10] = fx * ny - fy * nx; matrix[offset + 11] = 0;
  matrix[offset + 12] = x; matrix[offset + 13] = surface.groundAt(x, z) + .01; matrix[offset + 14] = z; matrix[offset + 15] = 1;
}

/**
 * Marches a ray across the terrain and returns the first tile it meets.
 * Hills therefore correctly occlude tiles behind them, and rays stop at the water surface.
 */
export function pickCell(ray: Ray, surface: Surface, step = .04): Cell | null {
  const { origin, direction } = ray;
  if (direction.y >= -1e-6) return null;
  const top = groundY(MAX_LEVEL) + .01;
  const start = Math.max(0, (top - origin.y) / direction.y);
  const end = (WATER_Y - origin.y) / direction.y;
  if (end < 0) return null;
  for (let t = start; t <= end + step; t += step) {
    const along = Math.min(t, end);
    const x = origin.x + direction.x * along;
    const z = origin.z + direction.z * along;
    if (x < 0 || z < 0 || x >= surface.size || z >= surface.size) continue;
    if (origin.y + direction.y * along <= Math.max(surface.groundAt(x, z), WATER_Y) + 1e-6)
      return { x: Math.floor(x), z: Math.floor(z) };
  }
  return null;
}
