import assert from "node:assert/strict";
import test from "node:test";
import { CONFLICT, Side, TrafficSim, VehicleKind, buildFleet, decodeRoute, departures, movementPoint, roadSides, isJunction } from "./traffic.ts";
import type { Placement } from "./traffic.ts";
import type { TrafficData } from "./types.ts";

const SIZE = 11;
const at = (x: number, z: number) => z * SIZE + x;
const move = (inSide: number, outSide: number) => inSide * 4 + outSide;
// A crossroads: row z=5 and column x=5 meet at (5,5).
const isRoad = (tile: number) => tile % SIZE === 5 || Math.floor(tile / SIZE) === 5;
const plan = (trips: [number, string][], count = 40, start = 480): TrafficData => ({
  revision: 1, size: SIZE, road_capacity: 400, kind: "w".repeat(trips.length),
  origin: trips.map(t => t[0]), destination: trips.map(([o, r]) => decodeRoute(o, r, SIZE).at(-1)!),
  count: trips.map(() => count), start: trips.map(() => start), end: trips.map(() => start + 510),
  minutes: trips.map(() => 5), route: trips.map(t => t[1]),
});
const CROSSING: [number, string][] = [
  [at(2, 4), "SEEEEEES"],   // West to east, straight over.
  [at(8, 4), "SWWWWWWS"],   // East to west.
  [at(4, 2), "ESSSSSSE"],   // North to south.
  [at(6, 2), "WSSSSSSW"],   // North to south, other side.
  [at(2, 6), "NEEENNNW"],   // West, then left turn to the north.
  [at(8, 6), "NWWWSSSE"],   // East, then left turn to the south.
];

test("routes decode into contiguous tiles ending at the destination", () => {
  assert.deepEqual(decodeRoute(at(1, 4), "SEEN", SIZE), [at(1, 4), at(1, 5), at(2, 5), at(3, 5), at(3, 4)]);
});

test("local freight renders trucks traveling between factories and shops", () => {
  const data = { ...plan([[at(2, 4), "SEEEEN"]], 2), kind: "f" };
  const fleet = buildFleet(data, isRoad, 1e4, 1e4);
  assert.equal(fleet.drivers.length, 2);
  assert.equal(fleet.drivers[0]!.kind, VehicleKind.Truck);
  assert.deepEqual([...fleet.drivers[0]!.out.tiles], [at(2, 5), at(3, 5), at(4, 5), at(5, 5), at(6, 5)]);
  assert.deepEqual([...fleet.drivers[0]!.back.tiles], [at(6, 5), at(5, 5), at(4, 5), at(3, 5), at(2, 5)]);
  const sim = new TrafficSim(fleet);
  const p: Placement = { x: 0, z: 0, dx: 0, dz: 0 };
  let minX = Infinity, maxX = -Infinity;
  for (let clock = 0; clock < 900; clock += 1) {
    sim.sync(clock);
    for (const car of sim.cars) {
      sim.place(car, SIZE, p);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
  }
  assert.ok(maxX - minX > 2, "trucks visibly move along the route");
});

test("lanes keep to the right and junction movements know what they cross", () => {
  const p: Placement = { x: 0, z: 0, dx: 0, dz: 0 };
  movementPoint(move(Side.W, Side.E), .5, p);
  assert.ok(p.z > .1 && p.dx > .9, "eastbound traffic drives on the south side");
  movementPoint(move(Side.E, Side.W), .5, p);
  assert.ok(p.z < -.1 && p.dx < -.9, "westbound traffic drives on the north side");
  assert.equal(CONFLICT[move(Side.W, Side.E) * 16 + move(Side.E, Side.W)], 0, "opposite lanes pass freely");
  assert.equal(CONFLICT[move(Side.W, Side.E) * 16 + move(Side.N, Side.S)], 1, "crossing traffic conflicts");
  assert.equal(CONFLICT[move(Side.W, Side.E) * 16 + move(Side.S, Side.E)], 1, "merging into one lane conflicts");
  assert.equal(CONFLICT[move(Side.E, Side.N) * 16 + move(Side.W, Side.S)], 0, "opposite right turns pass freely");
  assert.ok(isJunction(roadSides(at(5, 5), SIZE, isRoad)));
  assert.ok(!isJunction(roadSides(at(3, 5), SIZE, isRoad)));
  assert.equal(roadSides(at(5, 0), SIZE, isRoad), 1 << Side.S, "district edges are not road connections");
});

test("daily journeys vary by day, person and habit, with occasional absences", () => {
  const fleet = buildFleet(plan([CROSSING[0]!], 125), isRoad, 1e4, 1e4);
  assert.equal(fleet.drivers.length, 100);
  const days = [0, 1, 2, 3].map(day => departures(fleet, day));
  const outbound = days.map((list, day) => list.filter(d => !d.home).map(d => d.time - day * 1440));
  assert.ok(outbound.every(times => times.length < 100 && times.length > 80), "some people stay home");
  assert.ok(outbound.every(times => times.every(t => t < 480 && t > 330)), "everyone leaves for work before the shift");
  assert.notDeepEqual(outbound[0]!.slice(0, 5), outbound[1]!.slice(0, 5));
  const spread = Math.max(...outbound[0]!) - Math.min(...outbound[0]!);
  assert.ok(spread > 35, `departures spread over the morning (${spread} minutes)`);
  const home = days[0]!.filter(d => d.home).map(d => d.time);
  assert.ok(home.every(t => t >= 985) && Math.max(...home) - Math.min(...home) > 30);
});

test("busy cities are thinned so each car stands for several people", () => {
  const fleet = buildFleet(plan([CROSSING[0]!], 5000), isRoad, 1e4, 200);
  assert.ok(fleet.drivers.length <= 101);
  assert.ok(fleet.peoplePerCar > 40);
});

test("cars queue without touching and the crossroads never deadlocks", () => {
  const fleet = buildFleet(plan(CROSSING, 15), isRoad, 1e4, 1e4);
  const sim = new TrafficSim(fleet);
  sim.sync(300);
  const p: Placement = { x: 0, z: 0, dx: 0, dz: 0 };
  let peak = 0, queued = 0, ghosts = 0, closest = Infinity;
  // Run on to 03:00 so late-evening trips at the slower speed have finished.
  for (let clock = 300; clock <= 1440 * 2 + 180; clock += .4) {
    sim.sync(clock);
    peak = Math.max(peak, sim.cars.length);
    queued = Math.max(queued, sim.stats().queued);
    const points = sim.cars.filter(car => !car.ghost).map(car => { sim.place(car, SIZE, p); return [p.x, p.z] as const; });
    ghosts += sim.cars.length - points.length;
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
      closest = Math.min(closest, Math.hypot(points[i]![0] - points[j]![0], points[i]![1] - points[j]![1]));
  }
  assert.ok(peak > 10, `rush hour fills the roads (${peak})`);
  assert.ok(queued > 3, "cars queue at the junction");
  assert.equal(ghosts, 0, "no car needed the gridlock breaker");
  assert.ok(closest > .2, `cars keep their distance (${closest.toFixed(3)})`);
  assert.equal(sim.cars.length + sim.pending.length, 0, "everyone got home");
});

test("eastbound cars on a straight road stay in the southern lane", () => {
  const sim = new TrafficSim(buildFleet(plan([CROSSING[0]!], 4), isRoad, 1e4, 1e4));
  const p: Placement = { x: 0, z: 0, dx: 0, dz: 0 };
  let seen = 0;
  for (let clock = 300; clock < 480; clock += .4) {
    sim.sync(clock);
    for (const car of sim.cars) {
      sim.place(car, SIZE, p);
      if (p.x > 3.2 && p.x < 4.8) {
        seen++;
        assert.ok(p.z > 5.6 && p.z < 5.75 && p.dx > .99);
      }
    }
  }
  assert.ok(seen > 0);
});
