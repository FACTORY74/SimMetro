import assert from "node:assert/strict";
import test from "node:test";
import { regionGeometry, RegionRenderer, detailedCity } from "./region.ts";
import type { RegionTile, RegionView } from "./region.ts";
import type { CityState } from "./types.ts";
import { buildingModel } from "./buildings.ts";
import { createSurface } from "./terrain.ts";
import { levelRectangle } from "./selection.ts";

function tile(step: number, x = 0): RegionTile {
  const size = 20;
  return { x, z: 0, step, stamp: "test", heights: Array((size / step + 1) ** 2).fill(1),
    edges: Array.from({ length: 4 }, () => Array.from({ length: size * 2 + 1 }, (_, i) => 1 + Math.sin(i / 5))),
    buildings: [] };
}

test("coarse terrain preserves fine border vertices and upward-facing triangles", () => {
  const near = regionGeometry(tile(2), 20), far = regionGeometry(tile(10), 20);
  const border = (geometry: typeof near) => {
    const p = geometry.getAttribute("position"), values = new Set<string>();
    for (let i = 0; i < p.count; i++) {
      if (p.getX(i) === 0) values.add(`${p.getY(i)},${p.getZ(i)}`);
    }
    return [...values].sort();
  };
  assert.deepEqual(border(near), border(far));
  assert.equal(border(far).length, 41);
  assert.ok(far.getAttribute("position").count < near.getAttribute("position").count);
  for (const geometry of [near, far]) {
    const normal = geometry.getAttribute("normal");
    for (let i = 0; i < normal.count; i++) assert.ok(normal.getY(i) > 0);
    geometry.dispose();
  }
});

test("overview terrain uses the same amplified height as the detailed surface", () => {
  const district = tile(2);
  district.heights.fill(10);
  district.edges = district.edges.map(edge => edge.map(() => 10));
  const surface = createSurface(20, () => 10, district.edges);
  const geometry = regionGeometry(district, 20);
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    assert.ok(Math.abs(positions.getY(i) - surface.groundAt(positions.getX(i), positions.getZ(i))) < 1e-6);
  }
  assert.ok(Math.abs(surface.groundAt(10, 10) - 6) < 1e-6);
  geometry.dispose();
});

test("region overview shows the focused district and evicts tiles outside the view", () => {
  const renderer = new RegionRenderer();
  const view: RegionView = { size: 20, focus: [0, 0], detailed: [[0, 0]], explored: 2, inhabited: 1,
    tiles: [tile(2), tile(10, 1)], fogNear: 100, fogFar: 200 };
  renderer.update(view, true);
  assert.equal(renderer.group.children.length, 2);
  assert.equal(renderer.group.children[0]!.visible, false);
  renderer.update(view, true, new Set(["1:0"]));
  assert.ok(renderer.group.children.every(child => !child.visible), "Both detailed districts must hide their coarse meshes");
  renderer.update(view, false);
  assert.equal(renderer.group.children[0]!.visible, true);
  renderer.update({ ...view, tiles: [view.tiles[1]!], focus: [1, 0] }, false);
  assert.equal(renderer.group.children.length, 1);
  assert.equal(renderer.group.children[0]!.position.x, 0);
  renderer.dispose();
  assert.equal(renderer.group.children.length, 0);
});

test("neighbour detail keeps local models identical when camera focus crosses a boundary", () => {
  const neighbour = tile(2, 1);
  neighbour.detail = { seed: 42, heights: Array(400).fill(1), terrainRevision: 3, stamp: "a",
    lots: [[4, 5, "commercial", "o", 3, 80, 24, true, true, 0],
      [5, 5, "residential", "h", 1, 100, 0, true, true, 7]], powerLines: [] };
  const focus = { size: 20, session: "test", district: [0, 0] } as CityState;
  const before = detailedCity(neighbour, focus);
  const after = detailedCity(neighbour, { ...focus, district: [1, 0] });
  assert.deepEqual(before.tiles, after.tiles);
  assert.deepEqual(before.district, [1, 0]);
  assert.equal(before.terrainRevision, 3);
  assert.equal(before.tiles[104]!.variant, "o");
  assert.equal(before.tiles[105]!.residents, 7);
  assert.deepEqual(buildingModel(before.tiles[104]!, before.seed), buildingModel(after.tiles[104]!, after.seed));
});


test("neighbour desirability stays local and does not inherit the focused city's scores", () => {
  const neighbour = tile(2, 1);
  neighbour.detail = { seed: 42, heights: Array(400).fill(1), terrainRevision: 1, stamp: "d",
    lots: [[5, 5, "residential", "m", 1, 100, 0, true, true, 7]], powerLines: [] };
  const row = { score: 32, target: 20, profile: "residential", components: [], powerReliability: 1,
    waterReliability: 1, poorMonths: 3, commuteMinutes: 60, demand: 70, blockers: ["Desirability below 50"],
    eligible: false, declining: true, updatedMonth: 4 };
  const data = { version: 1, growthThreshold: 50, declineThreshold: 40, recoveryThreshold: 45, smoothing: .35, lots: { "105": row } };
  const focus = { size: 20, session: "test", district: [0, 0], desirability: data } as unknown as CityState;
  assert.equal(detailedCity(neighbour, focus).tiles[105]!.desirability, undefined);
  neighbour.detail.desirability = data;
  const rendered = detailedCity(neighbour, focus);
  assert.equal(rendered.tiles[105]!.desirability?.score, 32);
  assert.deepEqual(rendered.tiles[105]!.desirability?.blockers, ["Desirability below 50"]);
  assert.equal(rendered.tiles[104]!.desirability, undefined);
});

test("terrain levelling preserves the drag origin as its reference tile", () => {
  const cells = levelRectangle({ x: 8, z: 7 }, { x: 3, z: 2 });
  assert.deepEqual(cells[0], { x: 8, z: 7 });
  assert.equal(cells.length, 36);
  assert.equal(new Set(cells.map(cell => `${cell.x}:${cell.z}`)).size, 36);
});
