import { subtype, type Tile, type Zone } from "./types.ts";

export interface BuildingPart {
  x: number; z: number; bottom: number;
  width: number; depth: number; height: number; color: string;
  shape?: "cylinder";
}
/**
 * Who is behind a pane, which decides when it lights up. Boarded-up panes never do.
 * Entertainment venues have coloured `venue` rooms and `neon` sign strips.
 */
export type WindowUse = "home" | "work" | "shop" | "boarded" | "venue" | "neon";
/**
 * A window pane on an outside wall; `face` is the wall's outward side (0 N, 1 E, 2 S, 3 W).
 * Panes sharing a `room` (a flat, part of an office floor, a shop) switch on and off together.
 */
export interface BuildingWindow {
  x: number; z: number; y: number; face: number; width: number; height: number; use: WindowUse; room: number;
}
/** Top centre of a smokestack, relative to the lot centre and ground. */
export interface Chimney {
  x: number; z: number; top: number; width: number;
  /** Power stations run day and night, so their stacks never stop. */
  always?: boolean;
  /** White water vapour from cooling towers rather than smoke. */
  steam?: boolean;
}
export interface BuildingModel { name: string; parts: BuildingPart[]; windows: BuildingWindow[]; chimneys: Chimney[] }
export type BuildingLod = 0 | 1 | 2;

/** Select one of three visual detail bands. `scale` lets the renderer contract
 * the bands when sustained frame rate is below its target. */
export function distanceLod(distance: number, scale = 1): BuildingLod {
  const full = 100 * scale, medium = 220 * scale;
  return distance <= full ? 0 : distance <= medium ? 1 : 2;
}

/**
 * Reduce instance count while retaining a building's useful silhouette.
 *
 * LOD 1 removes panes and parts too small to read at medium camera distances.
 * LOD 2 keeps only substantial structural masses. If a narrow utility has no
 * conventionally substantial part, retain only its largest few components so
 * every building class still receives a real third level without disappearing.
 */
export function buildingModelLod(model: BuildingModel, tile: Tile, lod: BuildingLod): BuildingModel {
  if (lod === 0) return model;
  const volume = (part: BuildingPart) => part.width * part.depth * part.height;
  const filtered = model.parts.filter(part => volume(part) >= .0025 &&
    (part.width >= .035 || part.depth >= .035) && part.height >= .018);
  const medium = filtered.length ? filtered : [...model.parts].sort((a, b) => volume(b) - volume(a))
    .slice(0, Math.max(1, Math.ceil(model.parts.length * .65)));
  if (lod === 1) return { ...model, parts: medium, windows: [] };
  const structural = medium.filter(part => volume(part) >= .012 &&
    part.width >= .1 && part.depth >= .1 && part.height >= .06);
  const fallback = [...medium].sort((a, b) => volume(b) - volume(a))
    .slice(0, Math.max(1, Math.min(4, Math.ceil(medium.length * .35))));
  return { ...model, parts: structural.length ? structural : fallback, windows: [] };
}
export const POWER_WIRE_HEIGHT = .70;
/** Rotor hub in lot coordinates; the nacelle runs along X and the blades sweep the YZ plane. */
export const WIND_ROTOR = { x: -.21, y: 1.55, z: 0, radius: .63, root: .05 } as const;

/** Raise a span's control point where terrain or water would otherwise intersect the wire. */
export function powerWireControlY(start: number, end: number, distance: number, surfaceAt: (t: number) => number) {
  let control = (start + end) / 2 - Math.min(.09, distance * .015) * 2;
  const steps = Math.max(8, Math.ceil(distance * 8));
  for (let i = 1; i < steps; i++) {
    const t = i / steps, u = 1 - t;
    control = Math.max(control, (surfaceAt(t) + .12 - u * u * start - t * t * end) / (2 * u * t));
  }
  return control;
}

/** Consolidate straight runs for display without changing the electrical grid or its tile IDs. */
export function visualPowerLines(tiles: readonly Tile[], lines: readonly (readonly [number, number])[]) {
  const neighbours = new Map<number, Set<number>>();
  tiles.forEach((tile, i) => { if (tile.kind === "powerline") neighbours.set(i, new Set()); });
  for (const [a, b] of lines) {
    if (a === b || !neighbours.has(a) || !neighbours.has(b)) continue;
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }
  const supports = new Set<number>();
  for (const [i, adjacent] of neighbours) {
    const ends = [...adjacent];
    if (ends.length !== 2) { supports.add(i); continue; }
    const a = tiles[ends[0]!]!, b = tiles[ends[1]!]!, centre = tiles[i]!;
    const da = Math.abs(a.x - centre.x) + Math.abs(a.z - centre.z);
    const db = Math.abs(b.x - centre.x) + Math.abs(b.z - centre.z);
    if (!((a.x === centre.x && b.x === centre.x) || (a.z === centre.z && b.z === centre.z)) ||
      da > 4 || db > 4 || centre.height > (a.height * db + b.height * da) / (da + db))
      supports.add(i);
  }
  const anchors = [...supports].sort((a, b) => a - b);
  const mandatory = new Set(supports);
  const spans: [number, number][] = [], visited = new Set<string>();
  const edge = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  for (const start of anchors) {
    for (const first of neighbours.get(start)!) {
      if (visited.has(edge(start, first))) continue;
      let previous = start, current = first, lastSupport = start, distance = 0;
      for (;;) {
        visited.add(edge(previous, current));
        const a = tiles[previous]!, b = tiles[current]!;
        distance += Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
        if (mandatory.has(current) || distance >= 4) {
          supports.add(current);
          spans.push([lastSupport, current]);
          lastSupport = current;
          distance = 0;
        }
        if (mandatory.has(current)) break;
        const next = [...neighbours.get(current)!].find(i => i !== previous && !visited.has(edge(current, i)));
        if (next === undefined) break;
        previous = current;
        current = next;
      }
    }
  }
  return { supports, spans };
}

/** Room numbers stay below this, so `lot * ROOMS + room` names a room city-wide. */
export const ROOMS = 512;

/** Repeatable 0..1 noise from three integers. */
function random(a: number, b: number, c: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Whether a room's lights are on at a time of day, with fresh habits every day.
 * - Homes: most light up between 17:30 and 20:00 and go dark between 21:30 and midnight; about
 *   half of those are lit again for an early start between 05:20 and 08:00.
 * - Offices and workshops: lit through the working day (from 07:00–08:40 until 16:30–20:00), with
 *   a few late workers and cleaners until as late as 23:30.
 * - Shops: lit from opening (07:30–08:30) until 20:00–21:30.
 * - Venues: lit from 16:00–17:30 until 00:30–02:00.
 * - Neon signs: on from 16:30–17:10 until 01:00–02:00, every night.
 */
export function windowLit(id: number, day: number, minute: number, use: WindowUse = "home") {
  const r = (salt: number) => random(id, day, salt);
  if (use === "boarded") return false;
  if (use === "neon") return minute >= 990 + r(2) * 40 || minute < 60 + r(3) * 60;
  if (use === "venue") return r(1) < .9 && (minute >= 960 + r(2) * 90 || minute < 30 + r(3) * 90);
  if (use === "work") {
    if (r(1) > .85) return false;
    if (minute >= 420 + r(2) * 100 && minute < 990 + r(3) * 210) return true;
    return r(4) < .12 && minute >= 1200 && minute < 1260 + r(5) * 150;
  }
  if (use === "shop") return r(1) < .92 && minute >= 450 + r(2) * 60 && minute < 1200 + r(3) * 90;
  if (r(1) > .72) return false;
  if (minute >= 1050 + r(2) * 150 && minute < 1290 + r(3) * 145) return true;
  return r(4) < .55 && minute >= 320 + r(5) * 80 && minute < 410 + r(6) * 70;
}

const names: Record<Zone, string[]> = {
  residential: ["Bungalow", "Small house", "Cottage",
    "Terraced houses", "Courtyard homes", "Semi-detached pair",
    "Apartment block", "Gallery apartments", "Stepped apartments",
    "Residential tower", "Twin tower apartments", "Point tower"],
  commercial: ["Corner shop", "Market shed", "Café",
    "Retail store", "Car showroom", "Shop terrace",
    "Office block", "Shopping centre", "Glass office",
    "Corporate headquarters", "Office tower", "Stepped skyscraper"],
  industrial: ["Repair garage", "Workshed", "Builders' yard",
    "Workshop", "Freight depot", "Cold store",
    "Warehouse", "Assembly plant", "Bottling plant",
    "Steel mill", "Large factory", "Refinery"],
};
const palettes: Record<Zone, string[]> = {
  residential: ["#e6ccac", "#c5d2bb", "#d9b39a", "#ddd4bd", "#cfc6d6", "#e8dcc8"],
  commercial: ["#b5cbd0", "#cfccbd", "#99afb8", "#c2ccd9", "#d8cbb8"],
  industrial: ["#bca285", "#b8b7a3", "#ac998c", "#c3b38e", "#a9b0ad"],
};
const NX = [0, 1, 0, -1], NZ = [-1, 0, 1, 0];
const TRIM = "#ebe7de", RAIL = "#f6f4ee", GREEN = "#6f9a5a", HEDGE = "#4e7a45", PAVING = "#aaa79f";
const DARK = "#55595d", DOOR = "#6e5646", SHUTTER = "#8f9396", PLANT = "#9ea3a6", BRICK = "#947462";
const SKYLIGHT = "#9fc3cf", STEEL = "#c9cdd2";
const ROOF_COLORS = ["#896754", "#6f5a4e", "#8a4f3f", "#6a6d70"];
const AWNINGS = ["#b18455", "#638e78", "#b65c4f", "#4f6f9a", "#c9a34a"];
const SIGNS = ["#c9372c", "#2f6fb0", "#e2b13c", "#3f8f5a", "#7a4f9a"];
const PAINT = ["#d84a3a", "#f2f0e8", "#3d6fb6", "#2f3438", "#e2b13c", "#7d8b92"];
const SPANDRELS = ["#3f4b54", "#56626b", "#2f3a40", "#6b6f72"];

type Block = { x: number; z: number; w: number; d: number; bottom: number; h: number };
interface Facade {
  storey: number;
  use: WindowUse;
  faces?: number[];
  /** Distance between window columns. */
  spacing?: number;
  paneWidth?: number;
  /** Columns that get a balcony, reached by a balcony door, on every floor above the ground. */
  balcony?: (face: number, column: number, columns: number) => boolean;
  /** Face whose middle ground-floor column is the front door. */
  door?: number;
  /** Window columns per room. */
  roomWidth?: number;
}

export function buildingModel(tile: Tile, seed: number): BuildingModel | null {
  const kind = tile.kind;
  if (kind === "waterworks") {
    const f = tile.facility;
    if (!f || tile.x !== f.x || tile.z !== f.z) return null;
    const width = Math.max(...f.footprint.map(p => p[0])) - f.x + 1;
    const depth = Math.max(...f.footprint.map(p => p[1])) - f.z + 1;
    const x = (width - 1) / 2, z = (depth - 1) / 2;
    const parts: BuildingPart[] = [];
    const box = (dx: number, dz: number, bottom: number, w: number, d: number, height: number, color: string) =>
      parts.push({ x: x + dx, z: z + dz, bottom, width: w, depth: d, height, color });
    box(0, 0, 0, width - .1, depth - .1, .12, "#8c9da0");
    if (f.variant === "p") {
      box(0, 0, .12, width - .3, depth - .3, .55, "#bad5d5");
      box(0, 0, .67, width - .2, depth - .2, .09, "#398597");
      box(0, 0, .76, .3, .3, .18, "#677d86");
    } else {
      // Rotate the compound layout with its road entrance. The pump house uses
      // local cell (0,0), the tower the opposite cell, and the two remaining
      // cells carry exposed manifolds.
      const transform = (lx: number, lz: number) => ([
        [lx, lz], [1 - lz, lx], [1 - lx, 1 - lz], [lz, 1 - lx],
      ] as const)[f.rotation] ?? [lx, lz];
      const at = (lx: number, lz: number) => {
        const [tx, tz] = transform(lx, lz);
        return { x: tx - x, z: tz - z };
      };
      const shaped = (lx: number, lz: number, dx: number, dz: number, bottom: number,
        w: number, d: number, height: number, color: string, shape?: "cylinder") => {
        const p = at(lx, lz);
        parts.push({ x: x + p.x + dx, z: z + p.z + dz, bottom, width: w, depth: d, height, color,
          ...(shape ? { shape } : {}) });
      };
      // Individual concrete pads make the four uses legible as a small works.
      for (const [lx, lz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const)
        shaped(lx, lz, 0, 0, 0, .9, .9, .08, "#8c9694");

      // Entrance-side pump house, motor housing and delivery riser.
      shaped(0, 0, 0, 0, .08, .72, .68, .42, "#b9cac5");
      shaped(0, 0, 0, 0, .50, .78, .74, .07, "#557c7d");
      shaped(0, 0, .20, 0, .57, .22, .22, .18, "#6c8383", "cylinder");
      shaped(0, 0, -.27, 0, .12, .1, .1, .34, "#397c9c", "cylinder");

      // A classic one-cell elevated cylindrical tank on four steel legs.
      for (const dx of [-.25, .25]) for (const dz of [-.25, .25])
        shaped(1, 1, dx, dz, .08, .075, .075, 1.18, "#87999b");
      shaped(1, 1, 0, 0, .08, .1, .1, 1.22, "#397c9c", "cylinder");
      shaped(1, 1, 0, 0, 1.20, .78, .78, .56, "#63b4ce", "cylinder");
      shaped(1, 1, 0, 0, 1.76, .82, .82, .07, "#d3e0df", "cylinder");
      shaped(1, 1, 0, 0, 1.83, .58, .58, .07, "#557c7d", "cylinder");

      // Two open pipe beds: parallel mains, cross-pieces, valves and risers.
      for (const [lx, lz, alongX] of [[1, 0, true], [0, 1, false]] as const) {
        for (const offset of [-.18, .18])
          shaped(lx, lz, alongX ? 0 : offset, alongX ? offset : 0, .19,
            alongX ? .72 : .09, alongX ? .09 : .72, .09, offset < 0 ? "#397c9c" : "#6b9a7c");
        shaped(lx, lz, 0, 0, .12, .1, .1, .25, "#557c7d", "cylinder");
        shaped(lx, lz, alongX ? .26 : 0, alongX ? 0 : .26, .12, .16, .16, .18, "#d0a94f", "cylinder");
      }
    }
    // Entrance marker lies just inside the facility boundary.
    const ex = f.entrance[0] - f.x - x, ez = f.entrance[1] - f.z - z;
    box(Math.max(-width/2+.15, Math.min(width/2-.15, ex)), Math.max(-depth/2+.15, Math.min(depth/2-.15, ez)),
      .13, .2, .2, .05, "#f0dc80");
    return { name: f.variant === "p" ? "Groundwater pumping station" : "Water storage tower", parts, windows: [], chimneys: [] };
  }
  if (kind === "service") {
    const variant = subtype(tile);
    const parts: BuildingPart[] = [];
    const add = (x: number, z: number, bottom: number, width: number, depth: number, height: number, color: string) =>
      parts.push({ x, z, bottom, width, depth, height, color });
    const accent = variant === "f" ? "#d9ad3d" : variant === "p" ? "#4f79b5" : "#5f9d68";
    add(0, 0, 0, .88, .82, .08, "#969b98");
    add(0, .04, .08, .72, .62, .48, variant === "e" ? "#d1c6a4" : "#b9c5c3");
    add(0, .04, .56, .78, .68, .08, accent);
    add(0, -.285, .12, .22, .035, .28, "#33464c");
    add(-.22, -.285, .22, .14, .025, .12, accent);
    add(.22, -.285, .22, .14, .025, .12, accent);
    if (variant === "f") {
      add(-.22, -.18, .08, .24, .3, .32, "#5d6665");
      add(.22, -.18, .08, .24, .3, .32, "#5d6665");
    } else if (variant === "p") {
      add(0, .04, .64, .16, .16, .16, "#e4e8e2");
      add(0, .04, .8, .05, .05, .18, "#4f79b5");
    } else {
      add(-.23, .1, .22, .18, .04, .18, "#7797a1");
      add(.23, .1, .22, .18, .04, .18, "#7797a1");
      add(0, .04, .64, .12, .12, .22, "#5f9d68");
    }
    return { name: variant === "f" ? "Fire station" : variant === "p" ? "Police station" : "School",
      parts, windows: [], chimneys: [] };
  }
  if (kind !== "power" && kind !== "powerline" &&
    (!tile.level || (kind !== "residential" && kind !== "commercial" && kind !== "industrial"))) return null;
  const sub = subtype(tile), business = kind === "commercial" || kind === "industrial";
  const variation = ((tile.x * 73856093 ^ tile.z * 19349663 ^ seed * 83492791) >>> 0);
  const level = tile.level, extra = (variation >>> 12) % 3;
  let style = variation % 3;
  // The original archetypes serve every housing density, retail up to level 2, offices from level 3 and manufacturing.
  const legacy = kind === "residential" || (kind === "industrial" && sub === "m") ||
    (kind === "commercial" && ((sub === "r" && (level <= 2 || style === 0)) || (sub === "o" && level >= 3)));
  if (kind === "commercial" && level === 3) {
    if (sub === "r") style = 1;
    else if (style === 1) style = 2;
  }
  let name = legacy ? names[kind as Zone][(level - 1) * 3 + style]! : "";
  const parts: BuildingPart[] = [];
  const windows: BuildingWindow[] = [];
  const chimneys: Chimney[] = [];
  const pick = <T>(list: T[], shift: number) => list[(variation >>> shift) % list.length]!;
  const palette = palettes[kind === "power" || kind === "powerline" ? "industrial" : kind];
  const wall = pick(palette, 4), accent = pick(palette, 9), third = pick(palette, 14);
  const roofColor = kind === "residential" ? pick(ROOF_COLORS, 6) : "#6e7776";
  const sign = pick(SIGNS, 7), awning = pick(AWNINGS, 11);
  const neglected = business && tile.condition < 60;
  // Entertainment shop floors and offices are venue rooms (bars, auditoria, gaming halls); hotel rooms stay homes.
  const venue = kind === "commercial" && sub === "e";

  const add = (x: number, z: number, bottom: number, width: number, depth: number,
    height: number, color = wall) => parts.push({ x, z, bottom, width, depth, height, color });
  const block = (x: number, z: number, w: number, d: number, bottom: number, h: number, color = wall): Block => {
    add(x, z, bottom, w, d, h, color);
    return { x, z, w, d, bottom, h };
  };
  // Rooms are numbered by floor height, wall and position along the wall.
  const room = (floor: number, face: number, group: number) => (Math.round(floor * 10) % 32) * 16 + face * 4 + group % 4;
  const span = (b: Block, face: number) => face % 2 ? b.d : b.w;
  /** A point `along` the middle of a wall, `out` beyond it. */
  const onFace = (b: Block, face: number, along: number, out: number) => {
    const reach = (face % 2 ? b.w : b.d) / 2 + out;
    return { x: b.x + NX[face]! * reach + (face % 2 ? 0 : along), z: b.z + NZ[face]! * reach + (face % 2 ? along : 0) };
  };
  const pane = (b: Block, face: number, along: number, y: number, width: number, height: number, use: WindowUse, id: number) =>
    windows.push({ ...onFace(b, face, along, .004), y, face, width, height, room: id,
      use: neglected ? "boarded" : venue && (use === "shop" || use === "work") ? "venue" : use });
  /** A neon tube along a wall; a tall thin one makes an upright sign. */
  const neon = (b: Block, face: number, y: number, width = span(b, face) - .04, height = .022, along = 0, group = 3) =>
    pane(b, face, along, y, width, height, "neon", room(y, face, group));
  /** Something fixed to a wall: `width` along it, `depth` sticking out. */
  const jut = (b: Block, face: number, along: number, bottom: number, width: number, depth: number, height: number, color: string) => {
    const at = onFace(b, face, along, depth / 2);
    add(at.x, at.z, bottom, face % 2 ? depth : width, face % 2 ? width : depth, height, color);
  };
  /** Punched windows, one row per storey, with optional balconies and a front door. */
  const facade = (b: Block, o: Facade) => {
    const floors = Math.max(1, Math.floor(b.h / o.storey + .05));
    for (const face of o.faces ?? [0, 1, 2, 3]) {
      const along = span(b, face), columns = Math.max(1, Math.floor(along / (o.spacing ?? .16)));
      for (let f = 0; f < floors; f++) {
        const floor = b.bottom + f * o.storey;
        for (let c = 0; c < columns; c++) {
          const at = ((c + .5) / columns - .5) * along * .9, id = room(floor, face, Math.floor(c / (o.roomWidth ?? 2)));
          if (f === 0 && face === o.door && c === columns >> 1) {
            jut(b, face, at, floor, .075, .008, Math.min(.17, o.storey * .78), DOOR);
          } else if (f > 0 && o.balcony?.(face, c, columns)) {
            const tall = o.storey * .62;
            pane(b, face, at, floor + .016 + tall / 2, .07, tall, o.use, id);
            jut(b, face, at, floor, .14, .056, .014, TRIM);
            const rail = onFace(b, face, at, .053);
            add(rail.x, rail.z, floor + .014, face % 2 ? .006 : .14, face % 2 ? .14 : .006, .04, RAIL);
          } else {
            pane(b, face, at, floor + o.storey * .55, o.paneWidth ?? .065, Math.min(.09, o.storey * .45), o.use, id);
          }
        }
      }
    }
  };
  const homes = (b: Block, o: Omit<Facade, "use">) => facade(b, { ...o, use: "home" });
  const work = (b: Block, o: Omit<Facade, "use">) => facade(b, { ...o, use: "work" });
  /** A curtain wall: storey-high glass between slim mullions, so the block reads as all windows. */
  const curtain = (b: Block, storey: number, use: WindowUse = "work", faces = [0, 1, 2, 3]) => {
    const floors = Math.max(1, Math.floor((b.h + .005) / storey));
    for (const face of faces) {
      const along = span(b, face), columns = Math.max(2, Math.round(along / .1)), w = along / columns;
      for (let f = 0; f < floors; f++) {
        const floor = b.bottom + f * storey;
        for (let c = 0; c < columns; c++)
          pane(b, face, (c + .5) * w - along / 2, floor + storey / 2 + .006, w - .012, storey - .03, use, room(floor, face, Math.floor(c / 3)));
      }
    }
  };
  /** Ground-floor shop windows, optionally under an awning. */
  const shopfront = (b: Block, face: number, height: number, cover?: string) => {
    const along = span(b, face), columns = Math.max(1, Math.round(along / .2)), w = along / columns;
    for (let c = 0; c < columns; c++)
      pane(b, face, (c + .5) * w - along / 2, b.bottom + .03 + height / 2, w - .035, height, "shop", room(b.bottom, face, c));
    if (cover) jut(b, face, 0, b.bottom + height + .04, along * .94, .07, .016, cover);
  };
  /** A pitched roof, stepped in three courses up to the ridge. */
  const roof = (b: Block, ridgeAlongX = true, color = roofColor) => {
    let y = b.bottom + b.h;
    for (const [k, t] of [[1, .06], [.66, .06], [.32, .05]] as const) {
      add(b.x, b.z, y, ridgeAlongX ? b.w + .04 : (b.w + .04) * k, ridgeAlongX ? (b.d + .04) * k : b.d + .04, t, color);
      y += t;
    }
  };
  const parapet = (b: Block, color = TRIM) => add(b.x, b.z, b.bottom + b.h, b.w + .02, b.d + .02, .03, color);
  const top = (b: Block) => b.bottom + b.h;
  const car = (x: number, z: number, alongX: boolean, shift: number) => {
    add(x, z, 0, alongX ? .13 : .07, alongX ? .07 : .13, .045, pick(PAINT, shift));
    add(x, z, .045, alongX ? .07 : .06, alongX ? .06 : .07, .03, "#3c4a55");
  };

  /** A rounded footprint (tank, silo, tower) from crossed boxes; returns blocks usable for panes on faces 0/2 and 1/3. */
  const round = (x: number, z: number, bottom: number, d: number, h: number, color: string) => {
    add(x, z, bottom, d * .86, d * .86, h, color);
    return [block(x, z, d * .62, d, bottom, h, color), block(x, z, d, d * .62, bottom, h, color)] as const;
  };
  const crops = (x: number, z: number, w: number, d: number, color: string, alongX = true) => {
    add(x, z, 0, w, d, .012, "#8a6a48");
    const n = Math.max(2, Math.floor((alongX ? d : w) / .065));
    for (let i = 0; i < n; i++) {
      const at = ((i + .5) / n - .5) * (alongX ? d : w);
      add(alongX ? x : x + at, alongX ? z + at : z, .012, alongX ? w * .94 : .03, alongX ? .03 : d * .94, .035, color);
    }
  };
  const CROPS = ["#d9bf63", "#79a64e", "#e2d24a", "#8fae4a", "#b6c96a"];
  const alt = (variation >>> 16) % 2;

  if (kind === "powerline") {
    name = "Power pylon";
    add(0, 0, 0, .038, .038, .69, "#716c5f");
    add(0, 0, .64, .25, .025, .025, "#636a68");
    add(0, 0, .64, .025, .25, .025, "#636a68");
    for (const [x, z] of [[-.09, 0], [.09, 0], [0, -.09], [0, .09]] as const)
      add(x, z, .665, .024, .024, .028, "#d0cec1");
    add(0, 0, .69, .03, .03, .02, "#d0cec1");
  } else if (kind === "power") {
    if (sub === "s") {
      name = "Solar farm";
      for (let row = 0; row < 6; row++) {
        const z = -.38 + row * .14;
        for (const x of [-.22, .2]) {
          add(x, z, 0, .02, .02, .05, DARK);
          add(x, z - .02, .05, .38, .05, .02, "#2f4f7a");
          add(x, z + .025, .07, .38, .05, .02, "#355a8a");
        }
      }
      const hut = block(.38, .38, .14, .12, 0, .14, "#d9dcd8");
      work(hut, { storey: .14, faces: [3], spacing: .1 });
      add(-.02, .4, 0, .02, .02, .3, STEEL);
    } else if (sub === "w") {
      name = "Wind turbine";
      add(0, 0, 0, .34, .34, .08, "#858b86");
      add(0, 0, .08, .19, .19, .25, "#c8cfcc");
      add(0, 0, .33, .13, .13, .42, "#d9dedb");
      add(0, 0, .75, .085, .085, .42, "#e5e8e4");
      add(0, 0, 1.17, .08, .08, .35, "#d9dedb");
      add(0, 0, 1.49, .3, .12, .12, "#c7cecb");
    } else if (sub === "b") {
      name = "Battery storage station";
      block(0, 0, .88, .78, 0, .035, "#858b82");
      for (const z of [-.23, 0, .23]) {
        block(-.19, z, .46, .18, .035, .3, "#c4c9c4");
        add(-.19, z - .095, .08, .39, .012, .012, "#9ca6a3");
        for (const x of [-.34, -.19, -.04]) add(x, z - .095, .16, .018, .012, .16, "#7f8987");
        add(.042, z - .095, .08, .018, .012, .08, "#6c7776");
      }
      const control = block(.27, .18, .26, .32, .035, .31, "#d4d4cb");
      work(control, { storey: .16, faces: [1, 2, 3], spacing: .13, paneWidth: .055 });
      parapet(control);
      add(.27, .18, .035, .3, .36, .025, "#767d78");
      add(-.42, .32, .035, .025, .025, .02, tile.powered ? "#76d17b" : "#c9504f");
    } else if (sub === "n") {
      name = "Nuclear power plant";
      // Two hyperboloid cooling towers: wide base, waist two-thirds up, flared lip.
      for (const x of [-.24, .24]) {
        let y = 0;
        for (let k = 0; k < 9; k++) {
          const t = (k + .5) / 9, d = .42 * (.64 + .36 * ((t - .68) / .68) ** 2), h = .14;
          round(x, -.2, y, Math.min(.42, d), h, k % 4 === 3 ? "#d8d8d2" : "#e6e5df");
          y += h;
        }
        add(x, -.2, y, .3, .3, .01, "#9a9b98");
        chimneys.push({ x, z: -.2, top: y, width: .3, always: true, steam: true });
      }
      round(-.2, .28, 0, .32, .32, "#e9e9e4");
      round(-.2, .28, .32, .28, .07, "#e9e9e4");
      round(-.2, .28, .39, .2, .05, "#e9e9e4");
      round(-.2, .28, .44, .1, .03, "#e9e9e4");
      const turbine = block(.2, .28, .46, .3, 0, .34, "#b9c2c6");
      work(turbine, { storey: .17, faces: [1, 2], spacing: .12 });
      add(.2, .28, .34, .48, .32, .03, "#7d8b92");
      add(.43, -.44, 0, .04, .04, .5, "#c9372c");
    } else {
      name = "Coal power station";
      // A brick generating hall with a taller boiler house and a white chimney rising from each corner tower.
      const BRICKS = "#9a5c47", DEEP = "#7e4a3a", WHITE = "#efede6";
      const hall = block(0, -.1, .78, .5, 0, .62, BRICKS);
      work(hall, { storey: .31, faces: [1, 3], spacing: .14, paneWidth: .05 });
      for (const at of [-.24, -.08, .08, .24]) jut(hall, 2, at, 0, .03, .012, .62, DEEP);
      for (const at of [-.16, 0, .16]) pane(hall, 2, at, .34, .06, .4, "work", room(0, 2, 1));
      const boiler = block(0, -.1, .46, .46, .62, .22, BRICKS);
      work(boiler, { storey: .22, faces: [0, 2], spacing: .1, paneWidth: .04 });
      add(0, -.1, .84, .48, .48, .025, DEEP);
      for (const x of [-.32, .32]) for (const z of [-.3, .1]) {
        add(x, z, 0, .14, .14, .92, BRICKS);
        add(x, z, .92, .16, .16, .03, DEEP);
        add(x, z, .95, .1, .1, .06, WHITE);
        add(x, z, 1.01, .085, .085, .78, WHITE);
        add(x, z, 1.5, .095, .095, .025, "#d9d5ca");
        add(x, z, 1.79, .095, .095, .03, "#d9d5ca");
        chimneys.push({ x, z, top: 1.82, width: .085, always: true });
      }
      // Coal yard and conveyor in front.
      add(-.18, .34, 0, .44, .24, .03, "#4a4642");
      for (const [x, z, d] of [[-.28, .34, .18], [-.08, .36, .14]] as const) {
        add(x, z, .03, d, d, .05, "#2c2a28");
        add(x, z, .08, d * .6, d * .6, .04, "#2c2a28");
      }
      add(.22, .26, .06, .05, .26, .03, DARK);
      add(.22, .4, 0, .03, .03, .06, DARK);
      add(.36, .38, 0, .14, .16, .1, "#c9c4b8");
    }
  } else if (!legacy && kind === "commercial" && sub === "o") {
    if (level === 1) {
      if (alt === 0) {
        name = "Small office";
        const office = block(0, -.1, .62, .5, 0, .4, wall);
        work(office, { storey: .2, door: 2, spacing: .13 });
        parapet(office);
        jut(office, 2, -.2, .3, .16, .012, .05, sign);
        add(0, .33, 0, .8, .28, .008, PAVING);
        car(-.18, .33, true, 5);
        car(.15, .33, true, 9);
      } else {
        name = "Bank branch";
        const bank = block(0, -.1, .7, .52, 0, .38, "#ddd6c6");
        work(bank, { storey: .38, faces: [0, 1, 3], spacing: .15, paneWidth: .05 });
        for (const at of [-.18, 0, .18]) pane(bank, 2, at, .19, .07, .22, "work", room(0, 2, 0));
        for (const x of [-.27, -.09, .09, .27]) add(x, .21, 0, .04, .04, .32, TRIM);
        add(0, .21, .32, .7, .1, .06, TRIM);
        add(0, -.1, .38, .72, .54, .04, "#cfc6b2");
        add(0, .38, 0, .9, .2, .008, PAVING);
      }
    } else if (level === 2) {
      if (alt === 0) {
        name = "Business centre";
        const office = block(-.04, -.06, .8, .62, 0, .62, accent);
        work(office, { storey: .2, spacing: .1, paneWidth: .085, roomWidth: 3 });
        parapet(office);
        jut(office, 2, 0, .18, .34, .1, .015, STEEL);
        add(.1, -.06, .65, .24, .2, .1, PLANT);
        car(-.25, .4, true, 4);
        car(.2, .4, true, 8);
      } else {
        name = "Office pavilions";
        const spandrel = pick(SPANDRELS, 5);
        const a = block(-.22, -.12, .44, .62, 0, .42, spandrel);
        curtain(a, .21);
        add(-.22, -.12, .42, .46, .64, .025, STEEL);
        const b = block(.25, .1, .38, .5, 0, .63, spandrel);
        curtain(b, .21);
        add(.25, .1, .63, .4, .52, .025, STEEL);
        add(-.22, .38, 0, .4, .2, .01, GREEN);
      }
    }
  } else if (!legacy && kind === "commercial" && sub === "r") {
    if (variation % 3 === 1) {
      name = "Department store";
      const ground = block(0, -.04, .86, .8, 0, .26, wall);
      for (const face of [1, 2, 3]) shopfront(ground, face, .17, face === 2 ? awning : undefined);
      const upper = block(0, -.04, .86, .8, .26, .54, wall);
      facade(upper, { storey: .27, use: "shop", spacing: .2, paneWidth: .1, faces: [1, 2, 3] });
      parapet(upper);
      jut(upper, 2, 0, .62, .5, .012, .1, sign);
      add(0, -.1, .83, .3, .3, .12, PLANT);
    } else {
      name = "Retail park";
      const a = block(-.22, -.24, .46, .5, 0, .34, wall);
      shopfront(a, 2, .17);
      jut(a, 2, 0, .24, .3, .012, .07, sign);
      parapet(a);
      const b = block(.25, -.24, .44, .5, 0, .3, third);
      shopfront(b, 2, .17);
      jut(b, 2, 0, .22, .26, .012, .06, pick(SIGNS, 17));
      parapet(b);
      add(0, .25, 0, .96, .46, .008, PAVING);
      for (const [n, x] of [-.34, -.16, .02, .2, .38].entries()) car(x, n % 2 ? .3 : .17, false, 3 + n * 3);
      add(-.42, .42, 0, .04, .04, .5, DARK);
      add(-.42, .42, .36, .06, .08, .16, sign);
    }
  } else if (kind === "commercial" && sub === "e") {
    if (level === 1) {
      if (alt === 0) {
        name = "Diner";
        const diner = block(-.05, -.12, .72, .4, 0, .24, "#ece8e0");
        shopfront(diner, 2, .14);
        shopfront(diner, 1, .14);
        jut(diner, 2, 0, .19, .72, .012, .03, "#c9372c");
        add(-.05, -.12, .24, .74, .42, .02, "#c9372c");
        add(.2, -.12, .26, .02, .02, .14, DARK);
        add(.2, -.12, .4, .2, .03, .1, sign);
        neon(diner, 2, .205);
        neon(diner, 1, .205);
        neon(diner, 3, .205);
        add(0, .3, 0, .9, .3, .008, PAVING);
        car(-.2, .3, false, 6);
        car(.15, .3, false, 12);
      } else {
        name = "Pub";
        const ground = block(0, -.08, .66, .56, 0, .23, BRICK);
        shopfront(ground, 2, .13, "#3f5f48");
        const upper = block(0, -.08, .66, .56, .23, .23, BRICK);
        homes(upper, { storey: .23 });
        roof(upper);
        jut(ground, 2, .28, .22, .02, .1, .1, sign);
        neon(ground, 2, .205, .4, .018, -.08);
        for (const [n, x] of [-.25, 0, .25].entries()) {
          add(x, .38, 0, .1, .06, .045, "#8a6a4a");
          add(x, .38, .045, .012, .012, .08, DARK);
          add(x, .38, .125, .14, .14, .015, pick(AWNINGS, 4 + n * 3));
        }
      }
    } else if (level === 2) {
      if (alt === 0) {
        name = "Cinema";
        add(0, -.12, 0, .82, .6, .56, accent);
        const lobby = block(0, .27, .6, .18, 0, .3, "#d9dde0");
        curtain(lobby, .3, "shop", [1, 2, 3]);
        add(0, .38, .3, .7, .08, .08, sign);
        add(.32, .3, .38, .04, .1, .34, pick(SIGNS, 15));
        add(0, -.12, .56, .84, .62, .02, TRIM);
        neon(lobby, 2, .29);
        neon(lobby, 2, .2, .03, .16, .27, 2);
        neon(lobby, 2, .2, .03, .16, -.27, 1);
      } else {
        name = "Bowling alley";
        const alley = block(0, -.06, .86, .7, 0, .34, wall);
        shopfront(alley, 2, .15, awning);
        parapet(alley);
        round(.26, -.06, .37, .1, .2, "#f4f2ec");
        add(.26, -.06, .5, .1, .1, .03, "#c9372c");
        round(.26, -.06, .57, .07, .07, "#f4f2ec");
        jut(alley, 2, -.15, .22, .36, .012, .08, sign);
        neon(alley, 2, .325);
        neon(alley, 1, .325);
        neon(alley, 2, .2, .3, .02, .2, 2);
        add(0, .44, 0, .9, .1, .008, PAVING);
      }
    } else if (level === 3) {
      if (alt === 0) {
        name = "Theatre";
        const house = block(0, -.04, .8, .7, 0, .6, "#d9cfbd");
        work(house, { storey: .3, faces: [1, 3], spacing: .18, paneWidth: .05 });
        shopfront(house, 2, .14);
        add(0, -.18, .6, .5, .36, .38, "#c9bfac");
        for (const x of [-.3, -.18, -.06, .06, .18, .3]) add(x, .37, 0, .04, .04, .42, TRIM);
        add(0, .37, .42, .76, .1, .06, TRIM);
        add(0, .37, .48, .5, .08, .05, TRIM);
        add(0, .37, .53, .24, .06, .04, TRIM);
        neon(house, 2, .195, .74);
        neon(house, 2, .4, .02, .3, .375, 2);
        neon(house, 2, .4, .02, .3, -.375, 1);
      } else {
        name = "Casino hotel";
        const floor = block(0, 0, .86, .76, 0, .34, "#e0c890");
        for (const face of [1, 2, 3]) shopfront(floor, face, .2, face === 2 ? "#b8902a" : undefined);
        parapet(floor, "#b8902a");
        const tower = block(.12, -.12, .44, .36, .34, (6 + extra) * .2 + .02, "#b55a4a");
        homes(tower, { storey: .2, spacing: .1 });
        add(.12, -.12, top(tower), .46, .38, .05, "#e2b13c");
        jut(floor, 2, -.2, .26, .3, .012, .08, sign);
        for (const face of [1, 2, 3]) {
          neon(floor, face, .245);
          neon(floor, face, .315, undefined, .02, 0, 2);
        }
        for (const face of [0, 1, 2, 3]) neon(tower, face, top(tower) - .03);
      }
    } else {
      if (alt === 0) {
        name = "Hotel tower";
        const podium = block(0, 0, .86, .84, 0, .28);
        for (const face of [1, 2]) shopfront(podium, face, .17, face === 2 ? awning : undefined);
        parapet(podium);
        jut(podium, 2, 0, .2, .3, .08, .015, TRIM);
        const tower = block(0, -.06, .5, .42, .28, (10 + extra) * .2 + .02, wall);
        homes(tower, { storey: .2, spacing: .1, paneWidth: .07 });
        parapet(tower);
        jut(tower, 2, 0, top(tower) - .14, .3, .012, .1, sign);
        add(0, -.06, top(tower) + .03, .2, .16, .1, PLANT);
        neon(podium, 2, .245);
        neon(podium, 1, .245);
        for (const face of [0, 1, 2, 3]) neon(tower, face, top(tower) - .025);
      } else {
        name = "Arena";
        const [ns, ew] = round(0, 0, 0, .92, .5, "#cfd3d6");
        curtain(ns, .25, "shop", [0, 2]);
        curtain(ew, .25, "shop", [1, 3]);
        for (const face of [0, 2]) { neon(ns, face, .48); neon(ns, face, .015, undefined, .018, 0, 2); }
        for (const face of [1, 3]) { neon(ew, face, .48); neon(ew, face, .015, undefined, .018, 0, 2); }
        round(0, 0, .5, .84, .1, STEEL);
        round(0, 0, .6, .66, .07, "#e4e6e8");
        round(0, 0, .67, .4, .05, "#e4e6e8");
        add(0, 0, .72, .1, .1, .03, sign);
      }
    }
  } else if (kind === "industrial" && sub === "t") {
    const CLEAN = "#eceeec", TEAL = "#4f6f78";
    if (level === 1) {
      if (alt === 0) {
        name = "Tech start-up unit";
        const unit = block(-.06, -.1, .7, .56, 0, .32, CLEAN);
        curtain(unit, .32, "work", [2]);
        work(unit, { storey: .32, faces: [1, 3], spacing: .14 });
        parapet(unit, "#3d6fb6");
        for (const x of [-.25, -.05, .15]) add(x, -.2, .35, .14, .2, .02, "#2f4f7a");
        car(.32, .36, true, 7);
        add(-.3, .3, 0, .2, .04, .05, DARK);
      } else {
        name = "Clean workshop";
        const shed = block(0, -.12, .8, .56, 0, .36, CLEAN);
        jut(shed, 2, 0, .25, .8, .01, .04, "#3d6fb6");
        jut(shed, 2, -.2, 0, .2, .006, .22, SHUTTER);
        work(shed, { storey: .36, faces: [1, 3], spacing: .14 });
        add(0, -.12, .36, .82, .58, .03, "#cfd3d6");
        const office = block(.24, .3, .32, .18, 0, .24, TEAL);
        curtain(office, .24, "work", [1, 2, 3]);
      }
    } else if (level === 2) {
      if (alt === 0) {
        name = "Research lab";
        const lab = block(0, -.06, .78, .6, 0, .5, CLEAN);
        work(lab, { storey: .25, spacing: .1, paneWidth: .08, roomWidth: 3, door: 2 });
        parapet(lab);
        for (const x of [-.25, 0, .25]) add(x, -.15, .53, .12, .14, .07, PLANT);
        for (const x of [-.3, .3]) add(x, .1, .5, .03, .03, .2, STEEL);
        add(0, .4, 0, .8, .14, .01, GREEN);
      } else {
        name = "Data centre";
        const hall = block(0, -.04, .86, .72, 0, .42, "#bfc4c6");
        jut(hall, 2, 0, .3, .86, .01, .03, "#3d6fb6");
        for (let i = 0; i < 4; i++) for (const z of [-.24, .12]) {
          add(-.3 + i * .2, z, .42, .14, .14, .06, "#7d8b92");
          add(-.3 + i * .2, z, .48, .1, .1, .01, DARK);
        }
        const lobby = block(-.3, .41, .22, .1, 0, .24, TEAL);
        curtain(lobby, .24, "work", [1, 2, 3]);
        for (const x of [.12, .32]) add(x, .42, 0, .14, .1, .1, "#d9dcd8");
      }
    } else if (level === 3) {
      if (alt === 0) {
        name = "Tech campus";
        const a = block(-.22, -.12, .42, .64, 0, .62, TEAL);
        curtain(a, .2);
        add(-.22, -.12, .62, .44, .66, .02, GREEN);
        const b = block(.24, .1, .38, .6, 0, .42, "#5b7b86");
        curtain(b, .21);
        add(.24, .1, .42, .4, .62, .02, GREEN);
        add(.01, 0, .22, .04, .14, .08, "#d9dde0");
        add(-.22, .38, 0, .4, .2, .01, GREEN);
      } else {
        name = "Clean-room fab";
        const fab = block(0, -.12, .88, .6, 0, .5, CLEAN);
        jut(fab, 2, 0, .4, .88, .01, .05, "#3d6fb6");
        for (const x of [-.3, -.1, .1, .3]) add(x, -.12, .5, .1, .5, .06, "#9ea3a6");
        const office = block(-.1, .34, .6, .2, 0, .36, TEAL);
        curtain(office, .18, "work", [1, 2, 3]);
        for (const x of [.32, .42]) round(x, .36, 0, .08, .26, "#d8dcdc");
      }
    } else {
      if (alt === 0) {
        name = "Science park tower";
        const tower = block(0, -.06, .54, .54, 0, (9 + extra) * .2 + .02, TEAL);
        curtain(tower, .2);
        add(0, -.06, top(tower), .56, .56, .025, STEEL);
        add(0, -.06, top(tower) + .025, .3, .3, .02, GREEN);
        add(0, .38, 0, .9, .2, .01, GREEN);
      } else {
        name = "Semiconductor plant";
        const fab = block(-.12, -.1, .7, .7, 0, .7, CLEAN);
        jut(fab, 2, 0, .55, .7, .01, .06, "#3d6fb6");
        for (const z of [-.3, -.1, .1]) add(-.12, z, .7, .5, .1, .08, "#9ea3a6");
        const office = block(.34, .3, .26, .3, 0, 1.02, TEAL);
        curtain(office, .2, "work", [1, 2]);
        add(.34, .3, 1.02, .28, .32, .03, STEEL);
        for (const z of [-.35, -.1]) round(.36, z, 0, .14, .4, "#d8dcdc");
      }
    }
  } else if (kind === "industrial" && sub === "f") {
    const crop = pick(CROPS, 5), crop2 = pick(CROPS, 13), BARN = "#9b3d33", FARMHOUSE = "#e8dcc8";
    if (level === 1) {
      if (alt === 0) {
        name = "Crop field";
        crops(-.05, -.05, .86, .86, crop);
        const shed = block(.36, .38, .2, .18, 0, .16, BARN);
        work(shed, { storey: .16, faces: [3], spacing: .12 });
        roof(shed, false, "#6f5a4e");
      } else {
        name = "Market garden";
        crops(-.22, -.22, .42, .42, crop, false);
        crops(.22, -.22, .42, .42, crop2);
        crops(-.22, .22, .42, .42, pick(CROPS, 19), false);
        const hoop = block(.22, .2, .4, .2, 0, .12, "#e8eeea");
        curtain(hoop, .12, "work", [0, 2]);
      }
    } else if (level === 2) {
      if (alt === 0) {
        name = "Farmstead";
        const barn = block(-.2, -.26, .4, .34, 0, .24, BARN);
        work(barn, { storey: .24, faces: [1], spacing: .16 });
        jut(barn, 2, 0, 0, .16, .006, .18, "#e8e2d6");
        roof(barn, false, "#5e4c42");
        const house = block(.27, -.3, .3, .24, 0, .2, FARMHOUSE);
        homes(house, { storey: .2, door: 2, spacing: .12 });
        roof(house);
        round(.03, -.36, 0, .12, .46, "#c9ccc8");
        round(.03, -.36, .46, .09, .04, "#9ea3a6");
        crops(0, .22, .92, .5, crop);
      } else {
        name = "Greenhouses";
        for (const x of [-.3, 0, .3]) {
          const house = block(x, -.06, .24, .78, 0, .16, "#cfe3e0");
          curtain(house, .16, "work", [0, 2]);
          add(x, -.06, .16, .14, .78, .03, "#dfeeed");
          add(x, -.06, .19, .05, .78, .02, "#dfeeed");
        }
        add(0, .43, 0, .9, .1, .008, PAVING);
      }
    } else {
      if (alt === 0) {
        name = "Dairy farm";
        const shed = block(-.14, -.24, .62, .34, 0, .2, "#d8d2c2");
        work(shed, { storey: .2, faces: [2], spacing: .16 });
        roof(shed, true, "#5e4c42");
        for (const z of [-.34, -.14]) round(.36, z, 0, .14, .62, "#c9ccc8");
        add(0, .22, 0, .92, .5, .01, "#86b062");
        for (const [x, z] of [[-.3, .1], [-.1, .3], [.15, .15], [.3, .35]] as const) {
          add(x, z, .01, .07, .035, .04, "#f2f0e8");
          add(x + .02, z, .03, .025, .036, .02, "#2f3438");
        }
        add(0, -.03, 0, .92, .01, .05, "#9a8a70");
      } else {
        name = "Grain elevator";
        for (const [n, z] of [-.3, -.14, .02].entries()) round(-.3, z, 0, .16, .9 - n * .05, "#d9d6cc");
        const head = block(-.12, -.14, .14, .2, 0, 1.08, "#c9c4b8");
        work(head, { storey: .27, faces: [1], spacing: .1 });
        add(.02, -.14, .7, .3, .04, .04, DARK);
        crops(.25, -.15, .44, .62, crop);
        crops(0, .34, .96, .26, crop2, false);
        add(-.34, .2, 0, .14, .07, .08, "#c9372c");
      }
    }
  } else if (kind === "residential") {
    if (level === 1) {
      if (style === 0) {
        const house = block(-.1, -.02, .56, .6, 0, .26);
        homes(house, { storey: .24, door: 2 });
        roof(house);
        const garage = block(.3, .08, .2, .42, 0, .2);
        jut(garage, 2, 0, 0, .15, .006, .15, "#9a9690");
        add(.3, .08, .2, .22, .44, .03, roofColor);
        add(.3, .4, 0, .16, .18, .01, PAVING);
        add(-.1, .42, 0, .5, .05, .06, HEDGE);
      } else if (style === 1) {
        const house = block(-.06, -.06, .5, .5, 0, .5);
        homes(house, { storey: .25, door: 2 });
        roof(house, extra !== 1);
        add(-.22, -.06, .5, .06, .06, .26, "#8a5a48");
        const extension = block(.3, .12, .18, .3, 0, .22);
        homes(extension, { storey: .22, faces: [1, 2] });
        parapet(extension);
        add(-.06, .42, 0, .6, .05, .07, HEDGE);
      } else {
        const main = block(-.1, -.12, .5, .34, 0, .27);
        homes(main, { storey: .25, door: 2 });
        roof(main);
        const wing = block(.17, .14, .26, .18, 0, .25, accent);
        homes(wing, { storey: .25, faces: [1, 2, 3] });
        roof(wing, false);
        add(-.2, .32, 0, .5, .015, .05, "#d8d2c4");
        add(-.2, .24, 0, .3, .1, .02, "#9b6a8f");
      }
    } else if (level === 2) {
      if (style === 0) {
        const colours = [wall, accent, third];
        for (const [n, x] of [-.28, 0, .28].entries()) {
          const unit = block(x, -.04, .27, .6, 0, .58 + ((variation >>> (16 + n)) % 2) * .06, colours[n]);
          homes(unit, { storey: .28, faces: n === 0 ? [0, 2, 3] : n === 2 ? [0, 1, 2] : [0, 2], door: 2 });
          roof(unit);
          add(x, .4, 0, .2, .04, .05, HEDGE);
        }
      } else if (style === 1) {
        for (const x of [-.23, .23]) {
          const wing = block(x, -.15, .36, .42, 0, .62);
          homes(wing, { storey: .3, door: 2, balcony: face => face === 0 });
          parapet(wing);
        }
        const link = block(0, .23, .82, .25, 0, .44, accent);
        homes(link, { storey: .22, faces: [1, 2, 3], door: 2 });
        parapet(link);
        add(0, -.15, 0, .1, .4, .01, PAVING);
      } else {
        for (const side of [-1, 1]) {
          const house = block(side * .2, -.06, .38, .5, 0, .5, side < 0 ? wall : accent);
          homes(house, { storey: .25, faces: side < 0 ? [0, 2, 3] : [0, 1, 2], door: 2 });
          const bay = block(side * .2 - .06, .225, .14, .07, 0, .22);
          homes(bay, { storey: .22, faces: [1, 2, 3] });
          add(side * .2 - .06, .225, .22, .16, .09, .03, roofColor);
          add(side * .38, .38, 0, .12, .2, .01, PAVING);
        }
        roof({ x: 0, z: -.06, w: .78, d: .5, bottom: 0, h: .5 });
      }
    } else if (level === 3) {
      if (style === 0) {
        const flats = block(0, -.04, .64, .6, 0, (5 + extra % 2) * .2 + .04);
        homes(flats, { storey: .2, door: 2, balcony: (face, c, n) => face % 2 === 0 && (c === 0 || c === n - 1) });
        parapet(flats);
        add(.1, -.1, top(flats) + .03, .2, .16, .1, PLANT);
        add(0, .4, 0, .5, .12, .01, PAVING);
      } else if (style === 1) {
        const floors = 5;
        const slab = block(-.2, 0, .32, .8, 0, floors * .2 + .03);
        homes(slab, { storey: .2, faces: [0, 2, 3], roomWidth: 1, balcony: (face, c) => face === 3 && c % 2 === 0 });
        // The access gallery: a walkway on every upper floor with each flat's front door and kitchen window.
        for (let f = 0; f < floors; f++) {
          const floor = f * .2;
          if (f > 0) {
            jut(slab, 1, 0, floor, .78, .07, .014, TRIM);
            const rail = onFace(slab, 1, 0, .067);
            add(rail.x, rail.z, floor + .014, .006, .78, .045, RAIL);
          }
          for (let c = 0; c < 5; c++) {
            const at = ((c + .5) / 5 - .5) * .72;
            jut(slab, 1, at - .04, floor, .06, .006, .15, DOOR);
            pane(slab, 1, at + .04, floor + .11, .05, .06, "home", room(floor, 3, c));
          }
        }
        parapet(slab);
        const stairs = block(.06, -.34, .14, .12, 0, top(slab) + .1, accent);
        homes(stairs, { storey: .2, faces: [1], spacing: .12 });
        const maisonettes = block(.3, .18, .26, .54, 0, .42, accent);
        homes(maisonettes, { storey: .21, door: 3, balcony: face => face === 1 });
        parapet(maisonettes);
      } else {
        const lower = block(0, 0, .76, .72, 0, .62);
        homes(lower, { storey: .2, door: 2, balcony: (face, c) => face === 2 && c % 2 === 1 });
        parapet(lower);
        const upper = block(0, -.16, .76, .4, .62, .6 + (extra % 2) * .2);
        homes(upper, { storey: .2, balcony: (face, c) => face === 2 && c % 2 === 0 });
        parapet(upper);
        add(0, .2, .65, .7, .3, .012, GREEN);
        for (const x of [-.25, .25]) add(x, .3, .662, .08, .08, .05, "#7c5f49");
      }
    } else {
      if (style === 0) {
        const tower = block(0, 0, .56, .56, 0, (11 + extra) * .2 + .05);
        homes(tower, { storey: .2, door: 2, balcony: (_, c, n) => c === 0 || c === n - 1 });
        parapet(tower);
        add(0, 0, top(tower) + .03, .24, .24, .16, PLANT);
        jut(tower, 2, 0, .17, .2, .06, .015, TRIM);
        add(0, .4, 0, .44, .14, .01, PAVING);
      } else if (style === 1) {
        const h = (11 + extra) * .2 + .05;
        for (const side of [-1, 1]) {
          const slab = block(side * .21, 0, .3, .7, 0, side < 0 ? h : h - .4, side < 0 ? wall : accent);
          homes(slab, { storey: .2, door: 2, balcony: (face, c) => face === 2 - side && (c === 1 || c === 2) });
          parapet(slab);
        }
        add(0, 0, Math.round(h * 2) / 5, .12, .22, .16, TRIM);
        add(0, .2, 0, .12, .3, .18, TRIM);
      } else {
        const podium = block(0, 0, .84, .84, 0, .26, accent);
        shopfront(podium, 2, .15, awning);
        shopfront(podium, 1, .15, pick(AWNINGS, 20));
        add(0, 0, .26, .82, .82, .015, GREEN);
        const tower = block(0, -.04, .44, .44, .26, (11 + extra) * .2 + .04);
        homes(tower, { storey: .2, balcony: (face, c) => c === face >> 1 });
        parapet(tower);
        add(0, -.04, top(tower) + .03, .2, .2, .12, PLANT);
      }
    }
  } else if (kind === "commercial") {
    if (level === 1) {
      if (style === 0) {
        const shop = block(0, -.06, .72, .62, 0, .32);
        shopfront(shop, 2, .17, awning);
        shopfront(shop, 1, .17);
        parapet(shop);
        jut(shop, 2, 0, .26, .46, .012, .05, sign);
        add(.2, -.2, .35, .12, .1, .06, PLANT);
        add(-.3, .38, 0, .1, .04, .04, "#6b5a4a");
      } else if (style === 1) {
        for (const x of [-.36, .36]) for (const z of [-.32, .32]) add(x, z, 0, .04, .04, .3, DARK);
        add(0, 0, .3, .86, .76, .05, roofColor);
        add(0, 0, .35, .6, .5, .05, roofColor);
        for (const [n, x] of [-.22, 0, .22].entries())
          for (const z of [-.14, .14]) {
            add(x, z, 0, .16, .1, .08, "#a98b6a");
            add(x, z, .08, .14, .08, .02, pick(AWNINGS, 3 + n * 4 + (z > 0 ? 2 : 0)));
          }
      } else {
        const cafe = block(-.12, -.14, .6, .46, 0, .3);
        shopfront(cafe, 2, .17, awning);
        shopfront(cafe, 1, .17);
        parapet(cafe);
        jut(cafe, 2, 0, .245, .3, .012, .045, sign);
        add(.05, .27, 0, .8, .3, .012, PAVING);
        for (const [n, x] of [-.25, 0, .25].entries()) {
          add(x, .27, 0, .06, .06, .05, "#8a6a4a");
          add(x, .27, .05, .012, .012, .1, DARK);
          add(x, .27, .15, .16, .16, .02, pick(AWNINGS, 2 + n * 3));
        }
      }
    } else if (level === 2) {
      if (style === 0) {
        const ground = block(0, -.04, .8, .72, 0, .26);
        shopfront(ground, 2, .17, awning);
        shopfront(ground, 3, .17);
        const upper = block(0, -.04, .8, .72, .26, .3, accent);
        work(upper, { storey: .28, spacing: .14 });
        parapet(upper);
        jut(upper, 2, 0, .26, .6, .012, .04, sign);
      } else if (style === 1) {
        const hall = block(-.06, -.14, .74, .5, 0, .36, "#d9dde0");
        curtain(hall, .36, "shop", [1, 2, 3]);
        add(-.06, -.14, .36, .8, .56, .03, TRIM);
        add(0, .3, 0, .9, .34, .01, PAVING);
        for (const [n, x] of [-.3, -.08, .14].entries()) car(x, .3, false, 3 + n * 3);
        add(.4, .3, 0, .04, .04, .5, DARK);
        add(.4, .3, .4, .06, .12, .12, sign);
      } else {
        const colours = [wall, accent, third];
        for (const [n, x] of [-.28, 0, .28].entries()) {
          const ground = block(x, -.04, .27, .64, 0, .25, colours[n]);
          shopfront(ground, 2, .15, pick(AWNINGS, 3 + n * 4));
          const flat = block(x, -.04, .27, .64, .25, .27, colours[n]);
          homes(flat, { storey: .27, faces: n === 0 ? [0, 2, 3] : n === 2 ? [0, 1, 2] : [0, 2] });
          parapet(flat);
        }
      }
    } else if (level === 3) {
      if (style === 0) {
        const lobby = block(0, 0, .86, .82, 0, .26);
        for (const face of [1, 2, 3]) shopfront(lobby, face, .17);
        parapet(lobby);
        const offices = block(0, -.02, .62, .58, .26, (4 + extra % 2) * .2 + .02, accent);
        work(offices, { storey: .2, spacing: .1, paneWidth: .085, roomWidth: 3 });
        parapet(offices);
        add(.1, 0, top(offices) + .03, .22, .18, .12, PLANT);
      } else if (style === 1) {
        const mall = block(0, -.05, .9, .78, 0, .42);
        for (const face of [1, 2, 3]) shopfront(mall, face, .18);
        parapet(mall);
        const atrium = block(0, .385, .32, .09, 0, .5, "#cfd8dc");
        curtain(atrium, .25, "shop", [1, 2, 3]);
        add(0, .385, .5, .34, .11, .02, TRIM);
        for (const x of [-.28, 0, .28]) add(x, -.05, .45, .1, .6, .035, SKYLIGHT);
        jut(mall, 2, -.3, .3, .2, .012, .07, sign);
        jut(mall, 2, .3, .3, .2, .012, .07, pick(SIGNS, 15));
      } else {
        const podium = block(0, 0, .78, .78, 0, .22, "#c9cdd0");
        for (const face of [1, 2]) shopfront(podium, face, .15);
        parapet(podium);
        const tower = block(0, 0, .56, .56, .22, (5 + extra % 2) * .2 + .01, pick(SPANDRELS, 5));
        curtain(tower, .2);
        add(0, 0, top(tower), .58, .58, .04, STEEL);
      }
    } else {
      const spandrel = pick(SPANDRELS, 5);
      if (style === 0) {
        const podium = block(0, 0, .9, .86, 0, .3);
        for (const face of [0, 1, 2, 3]) shopfront(podium, face, .19);
        parapet(podium);
        jut(podium, 2, 0, .23, .3, .05, .015, STEEL);
        const tower = block(0, -.04, .52, .48, .3, (12 + extra) * .2 + .01, spandrel);
        curtain(tower, .2);
        const crown = block(0, -.04, .38, .34, top(tower), .4, spandrel);
        curtain(crown, .2);
        add(0, -.04, top(crown), .4, .36, .03, STEEL);
      } else if (style === 1) {
        const tower = block(0, 0, .6, .6, 0, (12 + extra) * .2 + .01, spandrel);
        curtain(tower, .2);
        jut(tower, 2, 0, .2, .3, .08, .015, TRIM);
        const setback = block(0, 0, .44, .44, top(tower), .41, spandrel);
        curtain(setback, .2);
        add(0, 0, top(setback), .46, .46, .03, STEEL);
        add(0, 0, top(setback) + .03, .03, .03, .5, STEEL);
      } else {
        let bottom = 0;
        for (const [w, h] of [[.74, 1.21], [.56, 1.01], [.38, .81 + extra * .2]] as const) {
          const tier = block(0, 0, w, w, bottom, h, spandrel);
          curtain(tier, .2);
          add(0, 0, top(tier), w + .02, w + .02, .025, STEEL);
          bottom = top(tier) + .025;
        }
        add(0, 0, bottom, .16, .16, .1, PLANT);
      }
    }
  } else {
    if (level === 1) {
      if (style === 0) {
        const garage = block(-.1, -.06, .62, .66, 0, .28);
        for (const at of [-.15, .1]) jut(garage, 2, at, 0, .2, .006, .2, SHUTTER);
        work(garage, { storey: .28, faces: [1], spacing: .2 });
        add(-.1, -.06, .28, .66, .7, .04, roofColor);
        jut(garage, 2, 0, .22, .4, .01, .05, sign);
        car(.33, .2, false, 5);
        car(.33, -.12, false, 9);
        add(.38, .42, 0, .06, .06, .08, "#2f3438");
      } else if (style === 1) {
        const shed = block(0, -.04, .76, .7, 0, .26);
        work(shed, { storey: .26, faces: [1, 3] });
        jut(shed, 2, -.18, 0, .22, .006, .2, SHUTTER);
        for (const z of [-.28, -.04, .2]) {
          add(0, z, .26, .78, .12, .1, roofColor);
          add(0, z + .065, .26, .74, .012, .09, SKYLIGHT);
        }
      } else {
        const shed = block(-.18, -.22, .56, .5, 0, .3);
        jut(shed, 2, 0, 0, .4, .006, .22, "#3a3d40");
        add(-.18, -.22, .3, .6, .54, .04, roofColor);
        const cabin = block(.3, -.3, .3, .16, 0, .17, "#d9c37a");
        work(cabin, { storey: .17, faces: [1, 2], spacing: .1 });
        add(-.3, .3, 0, .2, .12, .06, "#b8865a");
        add(-.3, .3, .06, .18, .1, .04, "#a8784e");
        add(0, .25, 0, .16, .16, .1, "#9b5b43");
        add(.25, .25, 0, .18, .18, .05, "#c9c2b0");
        add(0, .46, 0, .9, .015, .07, "#9a9690");
      }
    } else if (level === 2) {
      if (style === 0) {
        const hall = block(-.12, 0, .6, .8, 0, .46);
        jut(hall, 2, 0, 0, .3, .006, .32, SHUTTER);
        work(hall, { storey: .46, faces: [3], spacing: .2 });
        add(-.12, 0, .46, .64, .84, .06, roofColor);
        const office = block(.31, .12, .22, .45, 0, .3, accent);
        work(office, { storey: .15, faces: [1, 2], spacing: .1 });
        parapet(office);
        add(.31, -.26, 0, .06, .06, .62, "#8d8a84");
        chimneys.push({ x: .31, z: -.26, top: .62, width: .06 });
      } else if (style === 1) {
        const depot = block(0, -.2, .86, .48, 0, .42);
        for (const at of [-.3, -.1, .1, .3]) jut(depot, 2, at, 0, .14, .006, .24, SHUTTER);
        jut(depot, 2, 0, .27, .82, .1, .015, roofColor);
        add(0, -.2, .42, .9, .52, .05, roofColor);
        work(depot, { storey: .42, faces: [1, 3] });
        add(0, .3, 0, .9, .32, .008, PAVING);
        for (const [n, x] of [-.25, .1].entries()) {
          add(x, .27, 0, .1, .22, .1, "#f5f1e6");
          add(x, .42, 0, .1, .07, .08, pick(PAINT, 6 + n * 5));
        }
      } else {
        const store = block(-.04, -.06, .78, .66, 0, .5, "#e4e6e3");
        parapet(store, "#c9cdd0");
        for (const x of [-.25, 0, .25]) add(x - .04, -.06, .53, .12, .12, .05, DARK);
        const office = block(.4, 0, .1, .3, 0, .3, accent);
        work(office, { storey: .15, faces: [1, 2], spacing: .1 });
        jut(store, 2, -.2, 0, .14, .006, .24, SHUTTER);
        jut(store, 2, .05, 0, .14, .006, .24, SHUTTER);
        add(-.1, .38, 0, .26, .1, .1, "#f5f1e6");
        add(.08, .38, 0, .08, .1, .08, pick(PAINT, 13));
      }
    } else if (level === 3) {
      if (style === 0) {
        const shed = block(-.06, 0, .76, .82, 0, .62);
        for (const at of [-.22, 0, .22]) jut(shed, 2, at, 0, .16, .006, .3, SHUTTER);
        work(shed, { storey: .62, faces: [1, 3], spacing: .2 });
        add(-.06, 0, .62, .8, .86, .05, roofColor);
        for (const z of [-.25, 0, .25]) add(-.06, z, .67, .5, .08, .03, SKYLIGHT);
        add(.41, -.3, 0, .1, .1, 1.05, BRICK);
        chimneys.push({ x: .41, z: -.3, top: 1.05, width: .1 });
        const office = block(.41, .15, .12, .3, 0, .3, accent);
        work(office, { storey: .15, faces: [1, 2], spacing: .1 });
      } else if (style === 1) {
        const hall = block(-.08, 0, .68, .8, 0, .65);
        jut(hall, 2, 0, 0, .36, .01, .45, "#767d7c");
        for (const z of [-.24, 0, .24]) add(-.08, z, .65, .7, .17, .12, roofColor);
        work(hall, { storey: .65, faces: [3], spacing: .2 });
        const office = block(.34, .2, .16, .4, 0, .42, accent);
        work(office, { storey: .14, faces: [1, 2], spacing: .1 });
        parapet(office);
        add(.34, -.23, 0, .14, .14, 1.05, BRICK);
        chimneys.push({ x: .34, z: -.23, top: 1.05, width: .14 });
      } else {
        const hall = block(-.14, .12, .6, .62, 0, .5);
        work(hall, { storey: .25, faces: [2, 3], spacing: .14 });
        add(-.14, .12, .5, .64, .66, .05, roofColor);
        for (const z of [-.3, .05, .3]) {
          add(.33, z, 0, .16, .16, .7, "#d8dcdc");
          add(.33, z, .7, .12, .12, .03, PLANT);
        }
        add(.205, .05, .35, .09, .03, .03, DARK);
        add(-.32, -.36, 0, .12, .12, 1, BRICK);
        chimneys.push({ x: -.32, z: -.36, top: 1, width: .12 });
      }
    } else {
      if (style === 0) {
        const hall = block(-.1, .05, .62, .76, 0, .85);
        add(-.1, .05, .85, .66, .8, .06, roofColor);
        add(-.1, .05, .91, .2, .7, .12, roofColor);
        add(-.1, .05, .93, .21, .66, .06, SKYLIGHT);
        jut(hall, 2, 0, 0, .3, .01, .5, "#767d7c");
        work(hall, { storey: .85, faces: [3], spacing: .2 });
        for (const z of [-.3, .1]) {
          add(.34, z, 0, .14, .14, 1.8, BRICK);
          chimneys.push({ x: .34, z, top: 1.8, width: .14 });
        }
        add(.34, -.1, 0, .2, .18, .4, "#8d8a84");
      } else if (style === 1) {
        const hall = block(-.1, 0, .7, .82, 0, .7);
        for (const z of [-.3, -.1, .1, .3]) {
          add(-.1, z, .7, .72, .11, .1, roofColor);
          add(-.1, z + .057, .7, .68, .012, .09, SKYLIGHT);
        }
        for (const at of [-.15, .15]) jut(hall, 2, at, 0, .2, .01, .4, "#767d7c");
        work(hall, { storey: .35, faces: [3] });
        const office = block(.36, .22, .18, .36, 0, .56, accent);
        work(office, { storey: .14, faces: [1, 2], spacing: .1 });
        parapet(office);
        add(.36, -.25, 0, .14, .14, 1.7, BRICK);
        chimneys.push({ x: .36, z: -.25, top: 1.7, width: .14 });
      } else {
        for (const [x, z] of [[-.3, -.3], [-.3, 0], [-.05, -.3]] as const) {
          add(x, z, 0, .2, .2, .3, "#e6e4dc");
          add(x, z, .3, .16, .16, .03, "#c9c6bc");
        }
        for (const [x, z, h] of [[.18, -.1, 1.4], [.3, .1, 1.1]] as const) {
          add(x, z, 0, .09, .09, h, "#b9bcbe");
          add(x, z, h * .5, .16, .16, .015, DARK);
        }
        for (const [x, z] of [[.36, -.34], [-.36, .34]] as const) {
          add(x, z, 0, .1, .1, 1.8, BRICK);
          chimneys.push({ x, z, top: 1.8, width: .1 });
        }
        add(0, .2, .3, .7, .04, .04, DARK);
        for (const x of [-.3, 0]) add(x, .2, 0, .03, .03, .3, DARK);
        const control = block(0, .32, .3, .16, 0, .2, accent);
        work(control, { storey: .2, faces: [1, 2, 3], spacing: .1 });
      }
    }
  }
  if (business && tile.condition <= 20) {
    add(.3, .34, 0, .18, .16, .08, "#7b7160");
    add(-.31, .37, 0, .15, .12, .1, "#71685b");
  }
  // Quarter turns diversify streetscapes without changing lot footprints.
  if ((variation >>> 8) % 2 && !(kind === "power" && sub === "w")) {
    for (const part of parts) {
      [part.x, part.z] = [-part.z, part.x];
      [part.width, part.depth] = [part.depth, part.width];
    }
    for (const pane of windows) {
      [pane.x, pane.z] = [-pane.z, pane.x];
      pane.face = (pane.face + 1) % 4;
    }
    for (const stack of chimneys) [stack.x, stack.z] = [-stack.z, stack.x];
  }
  return { name, parts, windows, chimneys };
}
