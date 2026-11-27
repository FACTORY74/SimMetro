/** Procedural trees and the sun's path: pure functions shared by the renderer and tests. */

/** Crown shapes; each is drawn by its own instanced mesh. */
export const Crown = { Fir: 0, Pine: 1, Round: 2, Bush: 3 } as const;
export type Crown = typeof Crown[keyof typeof Crown];
export const CROWN_COUNT = 4;

interface Variety {
  crown: Crown;
  width: [number, number];
  height: [number, number];
  /** Share of the tree's height that is bare trunk below the crown. */
  trunk: number;
  colors: string[];
  bark: string;
}

const BARK = "#6b4f3a";
export const VARIETIES = {
  fir: { crown: Crown.Fir, width: [.42, .6], height: [.95, 1.45], trunk: .1, colors: ["#2f5d43", "#36664a", "#2a5240"], bark: BARK },
  pine: { crown: Crown.Pine, width: [.45, .65], height: [.85, 1.25], trunk: .14, colors: ["#3f6b4a", "#4a7650", "#456e4c"], bark: BARK },
  oak: { crown: Crown.Round, width: [.6, .82], height: [.62, .82], trunk: .32, colors: ["#4f8a4f", "#5b9450", "#4a7f45"], bark: BARK },
  birch: { crown: Crown.Round, width: [.34, .44], height: [.7, .9], trunk: .4, colors: ["#7fae5c", "#8cbb63", "#9cc46e"], bark: "#ddd8c8" },
  poplar: { crown: Crown.Round, width: [.24, .32], height: [1, 1.3], trunk: .15, colors: ["#5f9a4f", "#6aa456"], bark: BARK },
  autumn: { crown: Crown.Round, width: [.55, .75], height: [.6, .8], trunk: .32, colors: ["#d08a35", "#c4552f", "#d9b13c"], bark: BARK },
  shrub: { crown: Crown.Bush, width: [.28, .45], height: [.16, .28], trunk: 0, colors: ["#557f45", "#62904d", "#4b7341"], bark: BARK },
} satisfies Record<string, Variety>;
export type VarietyName = keyof typeof VARIETIES;

export interface Tree {
  variety: VarietyName;
  crown: Crown;
  /** Position within the map, in tile units. */
  x: number;
  z: number;
  width: number;
  height: number;
  /** Height of the crown's base above the ground. */
  crownBase: number;
  yaw: number;
  color: string;
  bark: string;
}

export const hash = (x: number, z: number, salt = 0) =>
  (((x * 73856093) ^ (z * 19349663) ^ (salt * 83492791)) >>> 0) % 1000 / 1000;

/** Smooth value noise on a coarse grid, so woods form clumps instead of random speckles. */
function noise(x: number, z: number, cell: number, salt: number) {
  const gx = x / cell, gz = z / cell, x0 = Math.floor(gx), z0 = Math.floor(gz);
  const fx = gx - x0, fz = gz - z0, sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(x0, z0, salt), b = hash(x0 + 1, z0, salt), c = hash(x0, z0 + 1, salt), d = hash(x0 + 1, z0 + 1, salt);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

/** How wooded a tile is, 0..1. */
export const woodland = (x: number, z: number) => noise(x, z, 9, 7) * .7 + noise(x, z, 3, 8) * .3;

/** Uplands are coniferous, lowlands broadleaved with birches, poplars, shrubs and the odd autumn tree. */
function pickVariety(height: number, r: number): VarietyName {
  const table: [VarietyName, number][] = height >= 18
    ? [["fir", .55], ["pine", .4], ["shrub", .05]]
    : height >= 8
      ? [["pine", .3], ["oak", .31], ["fir", .15], ["birch", .1], ["shrub", .12], ["autumn", .02]]
      : [["oak", .38], ["birch", .15], ["poplar", .14], ["shrub", .2], ["autumn", .03], ["pine", .1]];
  for (const [name, weight] of table) {
    if (r < weight) return name;
    r -= weight;
  }
  return table[0]![0];
}

function grow(variety: VarietyName, x: number, z: number, salt: number): Tree {
  const v: Variety = VARIETIES[variety];
  const r1 = hash(Math.floor(x * 97), Math.floor(z * 89), salt), r2 = hash(Math.floor(x * 61), Math.floor(z * 67), salt + 1);
  const height = v.height[0] + (v.height[1] - v.height[0]) * r1;
  return {
    variety, crown: v.crown, x, z,
    width: v.width[0] + (v.width[1] - v.width[0]) * r2,
    height, crownBase: height * v.trunk, yaw: r1 * Math.PI * 2,
    color: v.colors[Math.floor(r2 * v.colors.length)]!, bark: v.bark,
  };
}

// Quarter-tile slots keep trees in a tile from sitting on top of each other.
const SLOTS: [number, number][] = [[.27, .27], [.73, .3], [.3, .73], [.72, .72]];

/** Trees growing wild on an empty land tile at the given terrain level. */
export function wildTreeCount(x: number, z: number, height: number): number {
  if (height < 1 || height >= 30) return 0;
  const wood = woodland(x, z), roll = hash(x, z);
  return wood > .7 ? 3 : wood > .6 ? 2 : wood > .48 ? (roll < .35 ? 1 : 0) : (roll < .05 ? 1 : 0);
}

export function wildTrees(x: number, z: number, height: number, out: Tree[] = [], treeCount?: number): Tree[] {
  if (height < 1 || height >= 30) return out;
  const count = treeCount ?? wildTreeCount(x, z, height);
  if (!count) return out;
  if (count === 1) {
    const tx = x + .5 + (hash(x, z, 3) - .5) * .4, tz = z + .5 + (hash(x, z, 4) - .5) * .4;
    out.push(grow(pickVariety(height, hash(x, z, 5)), tx, tz, 11));
    return out;
  }
  const first = Math.floor(hash(x, z, 6) * 4);
  for (let i = 0; i < count; i++) {
    const [sx, sz] = SLOTS[(first + i) % 4]!;
    const tx = x + sx + (hash(x, z, 20 + i) - .5) * .18, tz = z + sz + (hash(x, z, 30 + i) - .5) * .18;
    out.push(grow(pickVariety(height, hash(x, z, 40 + i)), tx, tz, 50 + i));
  }
  return out;
}

/** A small planted park: a few broadleaf trees around a pair of shrubs. */
export function parkTrees(x: number, z: number, out: Tree[] = []): Tree[] {
  const kinds: VarietyName[] = ["oak", hash(x, z, 1) < .3 ? "autumn" : "birch", hash(x, z, 2) < .5 ? "poplar" : "oak"];
  const first = Math.floor(hash(x, z, 6) * 4);
  kinds.forEach((kind, i) => {
    const [sx, sz] = SLOTS[(first + i) % 4]!;
    out.push(grow(kind, x + sx, z + sz, 60 + i));
  });
  const [sx, sz] = SLOTS[(first + 3) % 4]!;
  out.push(grow("shrub", x + sx - .08, z + sz, 70), grow("shrub", x + sx + .1, z + sz + .06, 71));
  return out;
}

/**
 * Direction towards the sun at a time of day (minutes). It rises due east (+x), stands 45° above
 * the southern horizon (+z) at noon and sets due west; below the horizon at night (y < 0).
 */
export function sunDirection(minute: number, out = { x: 0, y: 0, z: 0 }) {
  const theta = Math.PI * (minute / 60 - 6) / 12, tilt = Math.PI / 4;
  out.x = Math.cos(theta);
  out.y = Math.sin(theta) * Math.sin(tilt);
  out.z = Math.sin(theta) * Math.cos(tilt);
  return out;
}

/** The night sky turns with the sun: about this axis (the southern pole, below the horizon) by `skyAngle`. */
export const SKY_AXIS = { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 } as const;
export const skyAngle = (minute: number) => Math.PI * (minute / 60 - 6) / 12;

/** Evenly spread star directions on the unit sphere, each with a brightness in (0, 1]. */
export function starField(count: number) {
  const positions = new Float32Array(count * 3), brightness = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * hash(i, 11, 5), around = 2 * Math.PI * hash(i, 23, 7), ring = Math.sqrt(1 - y * y);
    positions.set([ring * Math.cos(around), y, ring * Math.sin(around)], i * 3);
    brightness[i] = .45 + .55 * hash(i, 37, 3) ** 2;
  }
  return { positions, brightness };
}
