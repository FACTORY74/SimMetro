import assert from "node:assert/strict";
import test from "node:test";
import { Ray, Vector3 } from "three";
import { createCityCamera, updateCityCameraDepth } from "./camera.ts";
import { createSurface, groundY, pickCell, WATER_Y, writeVehicleTransform } from "./terrain.ts";
import { buildingModel } from "./buildings.ts";
import { MAX_LEVEL, type Tile } from "./types.ts";

test("distant objects appear smaller on screen", () => {
  const camera = createCityCamera(200);
  const width = (z: number) => {
    const left = new Vector3(95, 0, z).project(camera);
    const right = new Vector3(105, 0, z).project(camera);
    return Math.abs(right.x - left.x);
  };
  assert.ok(width(60) < width(130));
});

test("wide and low camera views retain depth separation between water and low land", () => {
  const camera = createCityCamera();
  const target = new Vector3(128, 0, 128);
  const depthSteps = 2 ** 24 - 1;
  for (const distance of [8, 75, 200, 330, 700, 900]) {
    for (const polar of [.55, 1.25, 1.38]) {
      camera.position.copy(target).add(new Vector3(0, Math.cos(polar), Math.sin(polar)).multiplyScalar(distance));
      camera.lookAt(target);
      updateCityCameraDepth(camera, target);
      camera.updateMatrixWorld();
      for (const z of [0, 128]) {
        const water = new Vector3(128, WATER_Y, z).project(camera);
        const land = new Vector3(128, 0, z).project(camera);
        // Several depth-buffer steps of clearance, even at the far shoreline.
        assert.ok((water.z - land.z) * .5 * depthSteps > 8,
          `Insufficient depth separation at distance ${distance}, polar ${polar}, z ${z}`);
        assert.ok(land.z > -1 && land.z < 1, "Ground must remain inside the clipping planes");
      }
    }
  }
});

test("picks the tile under a vertical ray on flat land", () => {
  const ray = new Ray(new Vector3(10.5, 40, 20.5), new Vector3(0, -1, 0));
  assert.deepEqual(pickCell(ray, createSurface(200, () => 1)), { x: 10, z: 20 });
});

test("elevated terrain occludes tiles behind it", () => {
  const heights = (x: number) => (x >= 5 && x <= 7 ? 10 : 0);
  const origin = new Vector3(.5, groundY(10) + 2, 3.5);
  const direction = new Vector3(10, -(groundY(10) + 2), 0).normalize();
  // Without the hill this ray would land on x = 10.
  assert.deepEqual(pickCell(new Ray(origin.clone(), direction.clone()), createSurface(20, () => 0)), { x: 10, z: 3 });
  assert.deepEqual(pickCell(new Ray(origin, direction), createSurface(20, heights)), { x: 5, z: 3 });
});

test("rays hit the water surface above a deep seabed and miss the sky", () => {
  const ray = new Ray(new Vector3(7.5, 30, 7.5), new Vector3(0, -1, 0));
  assert.deepEqual(pickCell(ray, createSurface(20, () => -6)), { x: 7, z: 7 });
  assert.equal(pickCell(new Ray(new Vector3(7, 3, 7), new Vector3(0, 1, 0)), createSurface(20, () => 0)), null);
});

test("adjacent levels meet on a ramp while plateaus stay flat", () => {
  const surface = createSurface(10, x => (x < 5 ? 1 : 2));
  assert.equal(surface.levelAt(2.5, 4.5), 1);
  assert.equal(surface.levelAt(4.5, 4.5), 1);
  assert.equal(surface.levelAt(5, 4.5), 1.5);
  assert.equal(surface.levelAt(5.5, 4.5), 2);
  assert.equal(surface.levelAt(8.2, 3.7), 2);
  assert.ok(Math.abs(surface.groundAt(5.5, 4.5) - surface.groundAt(4.5, 4.5) - .6) < 1e-6);
});

test("shared border samples keep different district heights joined", () => {
  const left = createSurface(2, () => 20, [[20, 20, 20, 20, 20.5], [20.5, 20.5, 20.5, 20.5, 20.5],
    [20, 20, 20, 20, 20.5], [20, 20, 20, 20, 20]]);
  const right = createSurface(2, () => 21, [[20.5, 21, 21, 21, 21], [21, 21, 21, 21, 21],
    [20.5, 21, 21, 21, 21], [20.5, 20.5, 20.5, 20.5, 20.5]]);
  for (let z = 0; z <= 2; z += .125) assert.equal(left.groundAt(2, z), right.groundAt(0, z));
  assert.equal(left.levelAt(1.5, .5), 20);
  assert.equal(right.levelAt(.5, .5), 21);
});

test("vehicles follow uphill and cross-sloped roads", () => {
  const surface = createSurface(6, (x, z) => x + z);
  const matrix = new Float32Array(16);
  writeVehicleTransform(surface, 2.5, 2.5, 1, 0, 1, 1, matrix, 0);
  const forward = new Vector3(matrix[0], matrix[1], matrix[2]);
  const up = new Vector3(matrix[4], matrix[5], matrix[6]);
  const side = new Vector3(matrix[8], matrix[9], matrix[10]);
  assert.ok(forward.y > .4);
  assert.ok(side.y > .3);
  assert.ok(Math.abs(forward.dot(up)) < 1e-6);
  assert.ok(Math.abs(side.dot(up)) < 1e-6);
  assert.ok(Math.abs(matrix[13]! - surface.groundAt(2.5, 2.5) - .01) < 1e-6);
});

test("picking starts above the expanded mountain range", () => {
  const surface = createSurface(4, () => 90);
  const ray = new Ray(new Vector3(1.5, 50, 1.5), new Vector3(0, -1, 0));
  assert.deepEqual(pickCell(ray, surface), { x: 1, z: 1 });
});

test("building diversity includes different silhouettes at every zone, subtype and level", () => {
  const names = new Set<string>();
  const shapes = new Set<string>();
  const subtypes = [["residential", ""], ["commercial", "r"], ["commercial", "o"], ["commercial", "e"],
    ["industrial", "m"], ["industrial", "t"], ["industrial", "f"], ["power", "c"], ["power", "s"], ["power", "n"]] as const;
  for (const [kind, variant] of subtypes) {
    const top = kind === "power" ? 1 : MAX_LEVEL[`${kind[0]}${variant}`] ?? 4;
    for (let level = 1; level <= top; level++) {
      for (let x = 0; x < 20; x++) {
        const tile: Tile = { x, z: 90, height: 1, water: false, kind, variant, level,
          powered: true, connected: true, workers: 0, residents: kind === "residential" ? level * 24 : 0, condition: 100, traffic: 0,
          powerDemand: 0, powerSupply: 0, powerGrid: 0, batteryCharge: 0 };
        const model = buildingModel(tile, 42)!;
        names.add(model.name);
        shapes.add(JSON.stringify(model.parts.map(p => [p.x, p.z, p.width, p.depth, p.height])));
        for (const part of model.parts) {
          assert.ok(Math.abs(part.x) + part.width / 2 <= .5 + 1e-9, `${model.name} x`);
          assert.ok(Math.abs(part.z) + part.depth / 2 <= .5 + 1e-9, `${model.name} z`);
          assert.ok(part.height > 0 && part.bottom >= 0, model.name);
        }
        assert.deepEqual(buildingModel(tile, 42), model);
      }
    }
  }
  assert.equal(names.size, 67);
  assert.ok(shapes.size >= 67);
});

test("derelict businesses have boarded glazing and debris without losing their building", () => {
  const tile: Tile = { x: 95, z: 94, height: 1, water: false, kind: "commercial", variant: "",
    level: 4, powered: true, connected: true, workers: 0, residents: 0, condition: 100, traffic: 0,
    powerDemand: 0, powerSupply: 0, powerGrid: 0, batteryCharge: 0 };
  const maintained = buildingModel(tile, 42)!;
  const derelict = buildingModel({ ...tile, condition: 0 }, 42)!;
  assert.equal(maintained.name, derelict.name);
  assert.equal(derelict.parts.length, maintained.parts.length + 2);
  assert.equal(derelict.windows.length, maintained.windows.length);
  assert.ok(maintained.windows.length > 0 && maintained.windows.every(w => w.use !== "boarded"));
  assert.ok(derelict.windows.every(w => w.use === "boarded"));
  assert.equal(buildingModel({ ...tile, level: 0 }, 42), null);
});
