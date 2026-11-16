/**
 * Microscopic traffic simulation for the daily trip plan. No Three.js.
 *
 * Every road tile is a small intersection: a car crossing it follows one of 16 lane-keeping
 * movements (enter from one side, leave by another). Cars keep a safe gap to the car ahead,
 * stop at the edge of a tile when a conflicting movement is occupying it, take turns
 * first-come-first-served at junctions and never enter a junction they cannot leave.
 */
import type { TrafficData } from "./types";

export const DAY = 1440;
/** Free-flow speed in tiles per game minute (about 2.9 tiles per real second at one day per minute). */
export const SPEED = .1225;
/** Right-hand traffic: distance from the road centre line to the lane centre. */
export const LANE = .17;
export const MAX_VEHICLES = 1500;
/** Busiest road tile carries at most this many cars a day; beyond that, a car stands for several people. */
export const FLOW_TARGET = 80;
/**
 * A car stuck this long (gridlock) briefly drives through other traffic to clear the knot.
 * It is the time to drive 15 tiles, so slower cars (and their longer queues) are given longer.
 */
export const DEADLOCK_MINUTES = Math.round(15 / SPEED);
export const VehicleKind = { Commute: 0, Shopper: 1, Truck: 2 } as const;
export const Side = { N: 0, E: 1, S: 2, W: 3 } as const;

const OCCUPANCY = { w: 1.25, s: 1.6, f: 1 } as const;
const STANDSTILL = .07;      // Bumper gap when queued, in tiles.
const HEADWAY = .35;         // Time gap kept to the car ahead, in game minutes.
const MAX_STEP = .3;         // Must stay below HEADWAY so a follower can never overshoot its leader.
const LOOKAHEAD = .6;        // Distance from the next tile at which a car asks to enter it.
const TURN_SPEED = .7;
const CONFLICT_DISTANCE = .22;
const SAMPLES = 16;
const SIDE_X = [0, 1, 0, -1], SIDE_Z = [-1, 0, 1, 0];
const STEP: Record<string, number> = { N: Side.N, E: Side.E, S: Side.S, W: Side.W };

export function seeded(a: number, b: number, salt = 0) {
  let n = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + salt * 7919, 0xc2b2ae35);
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n ^= n >>> 13;
  return (n >>> 0) / 4294967296;
}

/** Tile indices visited by a route, starting at the origin. */
export function decodeRoute(origin: number, route: string, size: number): number[] {
  const tiles = [origin];
  let x = origin % size, z = Math.floor(origin / size);
  for (const move of route) {
    const side = STEP[move]!;
    x += SIDE_X[side]!; z += SIDE_Z[side]!;
    tiles.push(z * size + x);
  }
  return tiles;
}

/** Side of tile `a` that faces the neighbouring tile `b`. */
function sideTowards(a: number, b: number, size: number) {
  const d = b - a;
  return d === 1 ? Side.E : d === -1 ? Side.W : d === size ? Side.S : Side.N;
}

/** Bit mask of sides where a road tile connects to another road. */
export function roadSides(tile: number, size: number, isRoad: (tile: number) => boolean) {
  const x = tile % size, z = Math.floor(tile / size);
  let mask = 0;
  for (let side = 0; side < 4; side++) {
    const nx = x + SIDE_X[side]!, nz = z + SIDE_Z[side]!;
    const inside = nx >= 0 && nz >= 0 && nx < size && nz < size;
    if (inside && isRoad(nz * size + nx)) mask |= 1 << side;
  }
  return mask;
}

export function isJunction(mask: number) {
  return ((mask & 1) + (mask >> 1 & 1) + (mask >> 2 & 1) + (mask >> 3 & 1)) >= 3;
}

/** A lane-following path across one tile, relative to the tile centre. */
interface Movement { x: Float32Array; z: Float32Array; at: Float32Array; length: number; turn: boolean }

function movement(inSide: number, outSide: number): Movement {
  const hx = -SIDE_X[inSide]!, hz = -SIDE_Z[inSide]!;
  const ox = SIDE_X[outSide]!, oz = SIDE_Z[outSide]!;
  const p0x = -hx * .5 - hz * LANE, p0z = -hz * .5 + hx * LANE;
  const p1x = ox * .5 - oz * LANE, p1z = oz * .5 + ox * LANE;
  let cx: number, cz: number;
  const cross = hx * oz - hz * ox;
  if (Math.abs(cross) > 1e-6) {
    // Corner of the two lane lines, so the curve leaves and joins each lane tangentially.
    const t = ((p1x - p0x) * oz - (p1z - p0z) * ox) / cross;
    cx = p0x + hx * t; cz = p0z + hz * t;
  } else if (inSide === outSide) {
    cx = 0; cz = 0;
  } else {
    cx = (p0x + p1x) / 2; cz = (p0z + p1z) / 2;
  }
  const x = new Float32Array(SAMPLES + 1), z = new Float32Array(SAMPLES + 1), at = new Float32Array(SAMPLES + 1);
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES, a = (1 - t) ** 2, b = 2 * t * (1 - t), c = t * t;
    x[i] = a * p0x + b * cx + c * p1x;
    z[i] = a * p0z + b * cz + c * p1z;
    if (i) at[i] = at[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, z[i]! - z[i - 1]!);
  }
  return { x, z, at, length: at[SAMPLES]!, turn: outSide !== (inSide + 2) % 4 };
}

export const MOVEMENTS: Movement[] = Array.from({ length: 16 }, (_, m) => movement(m >> 2, m & 3));

/** Movements entering from different sides whose lanes cross or merge inside the tile. */
export const CONFLICT = new Uint8Array(256);
/** CLEAR[a*16+b]: once a car on movement a has its tail this far along, it is past movement b's lane. */
export const CLEAR = new Float32Array(256);
for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
  if (a >> 2 === b >> 2) continue;
  const ma = MOVEMENTS[a]!, mb = MOVEMENTS[b]!;
  let last = -1;
  for (let i = 0; i <= SAMPLES; i++) {
    let near = Infinity;
    for (let j = 0; j <= SAMPLES; j++) near = Math.min(near, Math.hypot(ma.x[i]! - mb.x[j]!, ma.z[i]! - mb.z[j]!));
    if (near < CONFLICT_DISTANCE) last = ma.at[i]!;
  }
  CONFLICT[a * 16 + b] = last >= 0 ? 1 : 0;
  CLEAR[a * 16 + b] = last >= 0 ? last + .1 : 0;
}

export interface Placement { x: number; z: number; dx: number; dz: number }

/** Point and heading at distance `s` along a movement, extrapolating straight beyond either end. */
export function movementPoint(move: number, s: number, out: Placement) {
  const m = MOVEMENTS[move]!, { x, z, at } = m;
  if (s <= 0 || s >= m.length) {
    const end = s <= 0 ? 0 : SAMPLES, other = s <= 0 ? 1 : SAMPLES - 1;
    const dx = (x[end]! - x[other]!) * (s <= 0 ? -1 : 1), dz = (z[end]! - z[other]!) * (s <= 0 ? -1 : 1);
    const length = Math.hypot(dx, dz) || 1, beyond = s <= 0 ? s : s - m.length;
    out.dx = dx / length; out.dz = dz / length;
    out.x = x[end]! + out.dx * beyond; out.z = z[end]! + out.dz * beyond;
    return out;
  }
  let i = 1;
  while (at[i]! < s) i++;
  const f = (s - at[i - 1]!) / (at[i]! - at[i - 1]! || 1);
  out.dx = x[i]! - x[i - 1]!; out.dz = z[i]! - z[i - 1]!;
  const length = Math.hypot(out.dx, out.dz) || 1;
  out.dx /= length; out.dz /= length;
  out.x = x[i - 1]! + (x[i]! - x[i - 1]!) * f;
  out.z = z[i - 1]! + (z[i]! - z[i - 1]!) * f;
  return out;
}

/** Road tiles of one journey with the movement taken across each. */
export interface Route { tiles: Int32Array; moves: Uint8Array; junction: Uint8Array; length: number }

function makeRoute(tiles: number[], sidesIn: number[], sidesOut: number[], junctions: (tile: number) => boolean): Route {
  const moves = Uint8Array.from(tiles, (_, k) => sidesIn[k]! * 4 + sidesOut[k]!);
  return {
    tiles: Int32Array.from(tiles), moves,
    junction: Uint8Array.from(tiles, tile => junctions(tile) ? 1 : 0),
    length: [...moves].reduce((sum, m) => sum + MOVEMENTS[m]!.length, 0),
  };
}

/** Outbound and return routes for a trip, or null when it has no drivable road. */
export function tripRoutes(origin: number, route: string, size: number,
  junctions: (tile: number) => boolean): [Route, Route] | null {
  const path = decodeRoute(origin, route, size);
  const roads = path.slice(1, -1);
  if (!roads.length) return null;
  const sidesIn = roads.map((tile, k) => sideTowards(tile, path[k]!, size));
  const sidesOut = roads.map((tile, k) => sideTowards(tile, path[k + 2]!, size));
  return [makeRoute(roads, sidesIn, sidesOut, junctions),
    makeRoute([...roads].reverse(), [...sidesOut].reverse(), [...sidesIn].reverse(), junctions)];
}

export interface Driver {
  trip: number;
  kind: number;
  shade: number;
  out: Route;
  back: Route;
  /** Daily habits: how early they like to arrive, how late they tend to stay. */
  early: number;
  late: number;
}

export interface Fleet {
  drivers: Driver[];
  start: Int32Array;
  end: Int32Array;
  /** People represented by each car on screen. */
  peoplePerCar: number;
}

/**
 * One car per household that drives (scaled down for busy cities so roads stay readable).
 * Each car keeps the same trip and habits, but its departure times vary from day to day.
 */
export function buildFleet(data: TrafficData, isRoad: (tile: number) => boolean,
  maxVehicles = MAX_VEHICLES, flowTarget = FLOW_TARGET): Fleet {
  const junctions = (tile: number) => isJunction(roadSides(tile, data.size, isRoad));
  const candidates: { i: number; kind: keyof typeof OCCUPANCY; routes: [Route, Route]; cars: number }[] = [];
  const flow = new Map<number, number>();
  let wanted = 0, people = 0;
  for (let i = 0; i < data.kind.length; i++) {
    const kind = data.kind[i] as keyof typeof OCCUPANCY;
    if (!data.route[i]) continue;
    const routes = tripRoutes(data.origin[i]!, data.route[i]!, data.size, junctions);
    if (!routes) continue;
    const cars = data.count[i]! / OCCUPANCY[kind];
    candidates.push({ i, kind, routes, cars });
    wanted += cars;
    people += data.count[i]!;
    for (const tile of routes[0].tiles) flow.set(tile, (flow.get(tile) ?? 0) + cars * 2);
  }
  const busiest = Math.max(1, ...flow.values());
  const scale = Math.min(1, maxVehicles / Math.max(1, wanted), flowTarget / busiest);
  const drivers: Driver[] = [];
  for (const { i, kind, routes, cars } of candidates) {
    const exact = cars * scale;
    const count = Math.floor(exact) + (seeded(i, 0, 1) < exact % 1 ? 1 : 0);
    const type = kind === "w" ? VehicleKind.Commute : kind === "s" ? VehicleKind.Shopper : VehicleKind.Truck;
    for (let car = 0; car < count; car++) {
      drivers.push({ trip: i, kind: type, shade: seeded(i, car, 4), out: routes[0], back: routes[1],
        early: seeded(i, car, 5), late: seeded(i, car, 6) });
    }
  }
  return {
    drivers,
    start: Int32Array.from(data.start), end: Int32Array.from(data.end),
    peoplePerCar: drivers.length ? Math.max(1, people / drivers.length) : 1,
  };
}

export interface Departure { time: number; driver: number; home: boolean }

/** Every car journey that starts on day `day`, sorted by time (absolute minutes, may spill into neighbouring days). */
export function departures(fleet: Fleet, day: number): Departure[] {
  const list: Departure[] = [];
  const base = day * DAY;
  fleet.drivers.forEach((driver, d) => {
    const r = (salt: number) => seeded(d * 8 + salt, day, 11);
    const start = fleet.start[driver.trip]!, end = fleet.end[driver.trip]!;
    const travel = driver.out.length / SPEED;
    if (driver.kind === VehicleKind.Commute) {
      if (r(0) < .06) return;                                         // Day off, sick, working from home.
      const leave = start - travel - 4 - driver.early * 28 + (r(1) + r(2) - 1) * 14;
      const back = end + driver.late * 25 + r(3) ** 3 * 50 + (r(4) - .5) * 8;
      list.push({ time: base + leave, driver: d, home: false }, { time: base + back, driver: d, home: true });
    } else if (driver.kind === VehicleKind.Shopper) {
      if (r(0) > .7) return;
      const arrive = start + (r(1) - .5) * 150;
      list.push({ time: base + arrive - travel, driver: d, home: false },
        { time: base + arrive + 25 + r(2) * 80, driver: d, home: true });
    } else {
      if (r(0) < .1) return;
      const leave = start + r(1) * 120;
      list.push({ time: base + leave, driver: d, home: false },
        { time: base + leave + travel + 20 + r(2) * 60, driver: d, home: true });
    }
  });
  return list.sort((a, b) => a.time - b.time);
}

export interface Car {
  id: number;
  driver: Driver;
  route: Route;
  stage: number;
  /** Distance of the car's centre along the current stage's movement. */
  s: number;
  v: number;
  length: number;
  departed: number;
  waitTile: number;
  waitStage: number;
  waitSince: number;
  stopped: number;
  /** Held back because the lane beyond its next tile is full. */
  boxed: boolean;
  /** Stages left during which a gridlocked car ignores other traffic. */
  ghost: number;
}

export interface TrafficStats { driving: number; queued: number; waiting: number }

/** Steps every car on the road; call `sync` with the game clock each frame. */
export class TrafficSim {
  readonly cars: Car[] = [];
  readonly pending: Car[] = [];
  time = Number.NaN;
  private nextId = 1;
  private readonly occupants = new Map<number, Car[]>();
  private readonly waiters = new Map<number, Car[]>();
  private readonly plans = new Map<number, Departure[]>();

  readonly fleet: Fleet;

  constructor(fleet: Fleet) {
    this.fleet = fleet;
  }

  stats(): TrafficStats {
    let queued = 0;
    for (const car of this.cars) if (car.v < .02) queued++;
    return { driving: this.cars.length, queued, waiting: this.pending.length };
  }

  sync(clock: number) {
    const ahead = clock - this.time;
    if (!(ahead > -30 && ahead <= 60)) this.reset(clock);
    else while (this.time < clock) this.step(Math.min(MAX_STEP, clock - this.time));
  }

  /** World-space position of a car (tile centres are at x + .5, z + .5). */
  place(car: Car, size: number, out: Placement) {
    let { stage, s } = car;
    const route = car.route;
    if (s < 0 && stage > 0) {
      stage--;
      s += MOVEMENTS[route.moves[stage]!]!.length;
    }
    movementPoint(route.moves[stage]!, s, out);
    const tile = route.tiles[stage]!;
    out.x += tile % size + .5;
    out.z += Math.floor(tile / size) + .5;
    return out;
  }

  private plan(day: number) {
    let plan = this.plans.get(day);
    if (!plan) {
      plan = departures(this.fleet, day);
      this.plans.set(day, plan);
      for (const key of this.plans.keys()) if (Math.abs(key - day) > 3) this.plans.delete(key);
    }
    return plan;
  }

  /** Departures in (from, to]. Return trips can spill into the next day, so look back two days. */
  private due(from: number, to: number, each: (departure: Departure) => void) {
    const last = Math.floor(to / DAY) + 1;
    for (let day = Math.floor(from / DAY) - 2; day <= last; day++) {
      const plan = this.plan(day);
      let low = 0, high = plan.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (plan[mid]!.time <= from) low = mid + 1; else high = mid;
      }
      for (let i = low; i < plan.length && plan[i]!.time <= to; i++) each(plan[i]!);
    }
  }

  private makeCar(departure: Departure): Car {
    const driver = this.fleet.drivers[departure.driver]!;
    const length = driver.kind === VehicleKind.Truck ? .5 : .3;
    return {
      id: this.nextId++, driver, route: departure.home ? driver.back : driver.out, stage: 0, s: -length / 2,
      v: 0, length, departed: departure.time, waitTile: -1, waitStage: 0, waitSince: departure.time,
      stopped: 0, boxed: false, ghost: 0,
    };
  }

  /** Jumps straight to `clock`, placing recent departures part-way along their journeys. */
  reset(clock: number) {
    this.cars.length = 0;
    this.pending.length = 0;
    this.time = clock;
    this.occupants.clear();
    this.waiters.clear();
    this.due(clock - 120, clock, departure => {
      const car = this.makeCar(departure);
      let distance = (clock - departure.time) * SPEED * .7;
      if (distance >= car.route.length) return;
      const { route } = car;
      while (distance > MOVEMENTS[route.moves[car.stage]!]!.length && car.stage < route.tiles.length - 1) {
        distance -= MOVEMENTS[route.moves[car.stage]!]!.length;
        car.stage++;
      }
      const span = MOVEMENTS[route.moves[car.stage]!]!.length;
      if (span < car.length) return;
      car.s = Math.min(Math.max(distance, car.length / 2), span - car.length / 2);
      const tile = route.tiles[car.stage]!, move = route.moves[car.stage]!;
      const clash = (this.occupants.get(tile) ?? []).some(other => {
        const otherMove = other.route.moves[other.stage]!;
        return otherMove >> 2 === move >> 2
          ? Math.abs(other.s - car.s) < (other.length + car.length) / 2 + STANDSTILL
          : CONFLICT[move * 16 + otherMove] === 1;
      });
      if (clash) return;
      car.departed = departure.time;
      this.cars.push(car);
      this.occupy(tile, car);
    });
  }

  private occupy(tile: number, car: Car) {
    const list = this.occupants.get(tile);
    if (list) list.push(car); else this.occupants.set(tile, [car]);
  }

  /** Rebuilds who is in each tile: cars on their current stage, plus cars whose tail is still behind them. */
  private index() {
    this.occupants.clear();
    this.waiters.clear();
    for (const car of this.cars) {
      this.occupy(car.route.tiles[car.stage]!, car);
      if (car.stage > 0 && car.s < car.length / 2) this.occupy(car.route.tiles[car.stage - 1]!, car);
      if (car.waitTile >= 0) this.wait(car);
    }
    for (const car of this.pending) if (car.waitTile >= 0) this.wait(car);
  }

  private wait(car: Car) {
    const list = this.waiters.get(car.waitTile);
    if (list) { if (!list.includes(car)) list.push(car); } else this.waiters.set(car.waitTile, [car]);
  }

  /** Movement a car is making (or tailing out of) in `tile`. */
  private moveIn(car: Car, tile: number) {
    const route = car.route;
    return route.tiles[car.stage] === tile ? route.moves[car.stage]! : route.moves[car.stage - 1]!;
  }

  /** May `car` drive into stage `k` of its route right now? */
  canEnter(car: Car, k: number): boolean {
    if (car.ghost > 0) return true;
    const route = car.route, tile = route.tiles[k]!, move = route.moves[k]!, inSide = move >> 2;
    // Don't block the box: only enter a junction, or pull out of a driveway, with room to leave.
    // A car held back by this rule lets crossing traffic go first, but keeps its place in the
    // zip with traffic heading for the same lane, so queues let driveways merge in.
    car.boxed = (route.junction[k] === 1 || k === 0) && k + 1 < route.tiles.length && !this.room(car, k);
    if (car.boxed) return false;
    for (const other of this.occupants.get(tile) ?? []) {
      if (other === car || other.ghost > 0) continue;
      const current = other.route.tiles[other.stage] === tile;
      const otherMove = this.moveIn(other, tile);
      if (otherMove >> 2 === inSide) {
        if (current && other.s - other.length / 2 < STANDSTILL + .02) return false;
      } else if (CONFLICT[move * 16 + otherMove]) {
        const tail = (current ? other.s : other.s + MOVEMENTS[otherMove]!.length) - other.length / 2;
        if (tail < CLEAR[otherMove * 16 + move]!) return false;
      }
    }
    for (const other of this.waiters.get(tile) ?? []) {
      if (other === car || other.waitTile !== tile || other.ghost > 0) continue;
      const otherMove = other.route.moves[other.waitStage]!;
      if (otherMove >> 2 === inSide || !CONFLICT[move * 16 + otherMove]) continue;
      if (other.boxed && (otherMove & 3) !== (move & 3)) continue;
      if (other.waitSince < car.waitSince || (other.waitSince === car.waitSince && other.id < car.id)) return false;
    }
    return true;
  }

  /** Is there space in the lane beyond stage `k` for this car and everyone ahead of it heading there? */
  private room(car: Car, k: number) {
    const route = car.route, tile = route.tiles[k]!, outSide = route.moves[k]! & 3;
    const exit = route.tiles[k + 1]!, exitSide = route.moves[k + 1]! >> 2;
    let room = MOVEMENTS[route.moves[k + 1]!]!.length;
    for (const other of this.occupants.get(exit) ?? []) {
      if (other.route.tiles[other.stage] !== exit || other.ghost > 0) continue;
      if (other.route.moves[other.stage]! >> 2 === exitSide) room = Math.min(room, other.s - other.length / 2);
    }
    let need = car.length + STANDSTILL;
    for (const other of this.occupants.get(tile) ?? []) {
      if (other === car || other.route.tiles[other.stage] !== tile || other.ghost > 0) continue;
      if ((other.route.moves[other.stage]! & 3) === outSide) need += other.length + STANDSTILL;
    }
    return room >= need;
  }

  private enter(car: Car, k: number) {
    car.stage = k;
    car.waitTile = -1;
    if (car.ghost > 0) car.ghost--;
    this.occupy(car.route.tiles[k]!, car);
  }

  step(dt: number) {
    const from = this.time, to = from + dt;
    this.index();
    this.due(from, to, departure => this.pending.push(this.makeCar(departure)));
    let kept = 0;
    const heads = new Set<number>();
    for (const car of this.pending) {
      // Cars from one driveway leave in order; only the front one is trying to pull out.
      const lane = car.route.tiles[0]! * 4 + (car.route.moves[0]! >> 2);
      if (heads.has(lane)) {
        this.pending[kept++] = car;
        continue;
      }
      heads.add(lane);
      if (car.stopped > DEADLOCK_MINUTES) car.ghost = 2;
      if (this.canEnter(car, 0)) {
        car.stopped = 0;
        this.enter(car, 0);
        this.cars.push(car);
        continue;
      }
      car.stopped += dt;
      // Cars pulling out of a driveway give way to passing traffic, until they have waited a while.
      if (car.stopped > 4 && car.waitTile < 0) {
        car.waitTile = car.route.tiles[0]!;
        car.waitStage = 0;
        car.waitSince = to;
        this.wait(car);
      }
      this.pending[kept++] = car;
    }
    this.pending.length = kept;

    kept = 0;
    for (const car of this.cars) {
      if (this.drive(car, dt, to)) this.cars[kept++] = car;
    }
    this.cars.length = kept;
    this.time = to;
  }

  /** Moves one car; returns false once it has arrived. */
  private drive(car: Car, dt: number, now: number): boolean {
    const route = car.route, last = route.tiles.length - 1;
    let k = car.stage, span = MOVEMENTS[route.moves[k]!]!.length;
    const limit = SPEED * (car.ghost > 0 || !MOVEMENTS[route.moves[k]!]!.turn ? 1 : TURN_SPEED);
    let gap = Infinity;
    if (car.ghost === 0) {
      const tile = route.tiles[k]!, inSide = route.moves[k]! >> 2;
      let ahead = false;
      for (const other of this.occupants.get(tile) ?? []) {
        if (other === car || other.route.tiles[other.stage] !== tile || other.route.moves[other.stage]! >> 2 !== inSide) continue;
        if (other.s > car.s || (other.s === car.s && other.id < car.id)) {
          ahead = true;
          gap = Math.min(gap, other.s - other.length / 2 - car.s - car.length / 2);
        }
      }
      if (!ahead && k < last) {
        const toEnd = span - car.s - car.length / 2;
        const next = route.tiles[k + 1]!, nextSide = route.moves[k + 1]! >> 2;
        for (const other of this.occupants.get(next) ?? []) {
          if (other.route.tiles[other.stage] !== next || other.route.moves[other.stage]! >> 2 !== nextSide) continue;
          gap = Math.min(gap, toEnd + other.s - other.length / 2);
        }
        if (toEnd < LOOKAHEAD) {
          if (car.waitTile !== next) {
            car.waitTile = next;
            car.waitStage = k + 1;
            car.waitSince = now;
            this.wait(car);
          }
          if (!this.canEnter(car, k + 1)) gap = Math.min(gap, toEnd + STANDSTILL);
        }
      }
    }
    car.v = Math.max(0, Math.min(limit, (gap - STANDSTILL) / HEADWAY));
    car.s += car.v * dt;
    car.stopped = car.v < .02 ? car.stopped + dt : 0;
    if (car.stopped > DEADLOCK_MINUTES) {
      car.ghost = 2;
      car.stopped = 0;
    }
    while (k < last && car.s + car.length / 2 >= span) {
      if (!this.canEnter(car, k + 1)) {
        car.s = span - car.length / 2;
        car.v = 0;
        break;
      }
      car.s -= span;
      this.enter(car, ++k);
      span = MOVEMENTS[route.moves[k]!]!.length;
    }
    return !(k === last && car.s >= span);
  }
}
