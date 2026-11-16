import test from "node:test";
import assert from "node:assert/strict";
import { facilityLayout } from "./facilities.ts";
import { buildingModel } from "./buildings.ts";
import { attachWater, type Tile, type WaterData, type WaterFacility } from "./types.ts";

const tile = (x: number, z: number): Tile => ({ x, z, height: 1, water: false, kind: "waterworks", variant: "p",
  level: 0, powered: true, connected: true, workers: 0, residents: 0, condition: 100, traffic: 0,
  powerDemand: 12, powerSupply: 0, powerGrid: 1, batteryCharge: 0 });

test("facility preview rotations preserve footprints and put entrances outside the correct edge", () => {
  const entrances = [{ x: 9, z: 10 }, { x: 10, z: 9 }, { x: 12, z: 10 }, { x: 10, z: 12 }];
  for (let r = 0; r < 4; r++) {
    const layout = facilityLayout({ x: 10, z: 10 }, "p", r);
    assert.deepEqual(layout.entrance, entrances[r]);
    assert.equal(layout.cells.length, 2);
    assert.ok(!layout.cells.some(c => c.x === layout.entrance.x && c.z === layout.entrance.z));
    assert.equal(new Set(layout.cells.map(c => `${c.x},${c.z}`)).size, 2);
  }
});

test("multi-tile water models render once and stay inside their footprint", () => {
  for (const variant of ["p", "t"]) for (let rotation = 0; rotation < 4; rotation++) {
    const layout = facilityLayout({ x: 10, z: 10 }, variant, rotation);
    const f: WaterFacility = { id: 1, x: 10, z: 10, variant, rotation, stored: 0, operating: true,
      reason: "Operating", network: 1, production: 1200, capacity: 1200, storageCapacity: 600, upkeep: 60,
      footprint: layout.cells.map(c => [c.x, c.z]), entrance: [layout.entrance.x, layout.entrance.z] };
    const root = { ...tile(10, 10), variant, facility: f };
    const model = buildingModel(root, 42)!;
    assert.ok(model.parts.length > 3);
    const width = Math.max(...layout.cells.map(c => c.x)) - 9;
    const depth = Math.max(...layout.cells.map(c => c.z)) - 9;
    for (const p of model.parts) {
      assert.ok(p.x - p.width/2 >= -.5 && p.x + p.width/2 <= width-.5);
      assert.ok(p.z - p.depth/2 >= -.5 && p.z + p.depth/2 <= depth-.5);
    }
    const other = layout.cells.find(c => c.x !== 10 || c.z !== 10)!;
    assert.equal(buildingModel({ ...tile(other.x, other.z), variant, facility: f }, 42), null);
  }
});

test("water tower compound separates tank, pump house and two pipe beds", () => {
  const layout = facilityLayout({ x: 10, z: 10 }, "t", 0);
  const f: WaterFacility = { id: 1, x: 10, z: 10, variant: "t", rotation: 0, stored: 0, operating: true,
    reason: "Operating", network: 1, production: 0, capacity: 0, storageCapacity: 600, upkeep: 15,
    footprint: layout.cells.map(c => [c.x, c.z]), entrance: [layout.entrance.x, layout.entrance.z] };
  const model = buildingModel({ ...tile(10, 10), variant: "t", facility: f }, 42)!;
  const tank = model.parts.find(p => p.shape === "cylinder" && p.bottom === 1.2);
  assert.ok(tank && tank.x === 1 && tank.z === 1 && tank.width >= .75, "one-cell elevated cylindrical tank");
  assert.ok(model.parts.some(p => p.x === 0 && p.z === 0 && p.width === .72), "entrance-side pump house");
  assert.ok(model.parts.some(p => p.x === 1 && Math.abs(p.z) < .3 && p.width === .72), "east pipe bed");
  assert.ok(model.parts.some(p => Math.abs(p.x) < .3 && p.z === 1 && p.depth === .72), "south pipe bed");
  assert.equal(model.parts.filter(p => p.shape === "cylinder").length >= 8, true);
});

test("sparse underground state coexists with surface lots and exposes partial service", () => {
  const tiles = Array.from({ length: 16 }, (_, i) => ({ ...tile(i%4, Math.floor(i/4)), kind: "road" as const }));
  const service = { requested: 10, served: 5, fraction: .5, network: 2, reason: "Insufficient supply" };
  const data = { pipes: [2], services: { "2": service }, facilities: [] } as unknown as WaterData;
  attachWater(tiles, 4, data);
  assert.equal(tiles[2]!.kind, "road");
  assert.equal(tiles[2]!.pipe, true);
  assert.equal(tiles[2]!.waterService?.fraction, .5);
  assert.equal(tiles[3]!.pipe, undefined);
});
