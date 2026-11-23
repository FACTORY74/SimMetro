import assert from "node:assert/strict";
import test from "node:test";
import { ROOMS, WIND_ROTOR, buildingModel, buildingModelLod, distanceLod, powerWireControlY, visualPowerLines, windowLit } from "./buildings.ts";
import type { Tile } from "./types.ts";

const share = (day: number, minute: number) => {
  let lit = 0;
  for (let id = 0; id < 4000; id++) if (windowLit(id, day, minute)) lit++;
  return lit / 4000;
};

test("home windows light up in the evening and early morning, differently each day", () => {
  assert.equal(share(3, 13 * 60), 0, "dark at midday");
  assert.equal(share(3, 3 * 60), 0, "dark in the small hours");
  const evening = share(3, 21 * 60), morning = share(3, 6.5 * 60);
  assert.ok(evening > .45 && evening < .75, `evening ${evening}`);
  assert.ok(morning > .1 && morning < evening, `morning ${morning}`);
  assert.ok(share(3, 18 * 60) < evening && share(3, 23.5 * 60) < evening, "lights come on and go off gradually");
  const differs = Array.from({ length: 200 }, (_, id) => windowLit(id, 3, 21 * 60) !== windowLit(id, 4, 21 * 60));
  assert.ok(differs.filter(Boolean).length > 30, "a different set each night");
});

const tile = (kind: Tile["kind"], level: number, x = 4, z = 7, variant = ""): Tile => ({
  x, z, kind, variant, level, height: 1, water: false, powered: true, connected: true, workers: 20, residents: kind === "residential" ? level * 24 : 0, condition: 100, traffic: 0, pollution: 0, trees: 0,
  powerDemand: 0, powerSupply: 0, powerGrid: null, batteryCharge: 0,
});

test("offices are lit through the working day and shops until the evening", () => {
  const office = (minute: number) => Array.from({ length: 4000 }, (_, id) => windowLit(id, 5, minute, "work")).filter(Boolean).length / 4000;
  const shop = (minute: number) => Array.from({ length: 4000 }, (_, id) => windowLit(id, 5, minute, "shop")).filter(Boolean).length / 4000;
  assert.ok(office(11 * 60) > .8 && office(3 * 60) === 0, "offices: busy at 11:00, dark at 03:00");
  assert.ok(office(19 * 60) < .5 && office(19 * 60) > .05, "a few offices still lit at 19:00");
  assert.ok(shop(12 * 60) > .85 && shop(22 * 60) === 0 && shop(6 * 60) === 0, "shops open by day only");
  assert.equal(windowLit(1, 5, 12 * 60, "boarded"), false);
});

test("entertainment venues glow with coloured rooms and neon through the evening", () => {
  const share = (minute: number, use: "venue" | "neon") =>
    Array.from({ length: 4000 }, (_, id) => windowLit(id, 5, minute, use)).filter(Boolean).length / 4000;
  for (const minute of [18 * 60, 21 * 60, 23 * 60 + 30]) assert.ok(share(minute, "venue") > .85 && share(minute, "neon") === 1, `${minute}`);
  for (const minute of [6 * 60, 12 * 60]) assert.ok(share(minute, "venue") === 0 && share(minute, "neon") === 0, `${minute}`);
  for (let level = 1; level <= 4; level++) for (let x = 0; x < 4; x++) {
    const model = buildingModel(tile("commercial", level, x, 5, "e"), 42)!;
    assert.ok(model.windows.some(w => w.use === "neon") && model.windows.some(w => w.use === "venue"), model.name);
    assert.ok(!model.windows.some(w => w.use === "shop" || w.use === "work"), model.name);
    const run = buildingModel({ ...tile("commercial", level, x, 5, "e"), condition: 30 }, 42)!;
    assert.ok(run.windows.every(w => w.use === "boarded"), `${run.name} neon is dead when run down`);
  }
});

test("every archetype's panes sit on a wall, and each lot's rooms fit in its id range", () => {
  const kinds = [["residential", ""], ["commercial", "r"], ["commercial", "o"], ["commercial", "e"],
    ["industrial", "m"], ["industrial", "t"], ["industrial", "f"], ["power", "c"], ["power", "s"], ["power", "n"],
    ["power", "w"], ["power", "b"]] as const;
  const glass = new Set<string>();
  for (const [kind, variant] of kinds) for (let level = 1; level <= 4; level++) for (let x = 0; x < 24; x++) {
    const model = buildingModel(tile(kind, level, x, 11, variant), 42)!;
    assert.ok(model.windows.length > 0 || kind === "power" && variant === "w" ||
      kind === "commercial" && level === 1 && model.name === "Market shed", model.name);
    for (const pane of model.windows) {
      assert.ok(pane.room >= 0 && pane.room < ROOMS);
      if (pane.height > .15) glass.add(model.name);
      // Each pane sits just outside one face of a wall block, within that face's extent and height.
      const onWall = model.parts.some(part => {
        const [half, across, halfAcross] = pane.face % 2
          ? [part.width / 2, pane.z - part.z, part.depth / 2] : [part.depth / 2, pane.x - part.x, part.width / 2];
        const out = pane.face === 0 ? part.z - pane.z : pane.face === 1 ? pane.x - part.x
          : pane.face === 2 ? pane.z - part.z : part.x - pane.x;
        return Math.abs(out - half - .004) < 1e-6 && Math.abs(across) < halfAcross
          && pane.y > part.bottom && pane.y < part.bottom + part.height;
      });
      assert.ok(onWall, `${model.name} pane on a wall (${pane.face}: ${pane.x}, ${pane.z}, ${pane.y})`);
    }
  }
  for (const name of ["Glass office", "Office tower", "Stepped skyscraper", "Corporate headquarters"])
    assert.ok(glass.has(name), `${name} has storey-high curtain-wall glass`);
});

test("homes have windows on every wall, towers have balconies, and factories have smokestacks", () => {
  for (const [x, z] of [[4, 7], [5, 7], [9, 2], [12, 3]] as const) {
    const tower = buildingModel(tile("residential", 4, x, z), 42)!;
    assert.deepEqual(new Set(tower.windows.map(w => w.face)), new Set([0, 1, 2, 3]));
    assert.ok(tower.windows.filter(w => w.face === 0).some(w => w.use === "home"));
    assert.ok(tower.parts.some(p => p.color === "#f6f4ee"), `${tower.name} has balcony rails`);
    assert.ok(buildingModel(tile("industrial", 4, x, z), 42)!.chimneys.length > 0);
  }
  const office = buildingModel(tile("commercial", 3, 4, 7, "o"), 42)!;
  assert.ok(office.windows.some(w => w.use === "work") && office.windows.some(w => w.use === "shop"), office.name);
});

test("building LODs remove facade detail while retaining structural silhouettes", () => {
  for (const kind of ["residential", "commercial", "industrial"] as const) {
    const source = buildingModel(tile(kind, 4, 9, 11), 42)!;
    const medium = buildingModelLod(source, tile(kind, 4, 9, 11), 1);
    const distant = buildingModelLod(source, tile(kind, 4, 9, 11), 2);
    assert.equal(medium.windows.length, 0);
    assert.equal(distant.windows.length, 0);
    assert.ok(medium.parts.length < source.parts.length, `${source.name} medium LOD reduces parts`);
    assert.ok(distant.parts.length <= medium.parts.length, `${source.name} distant LOD does not add parts`);
    assert.ok(distant.parts.length > 0, `${source.name} retains a silhouette`);
    const top = (parts: typeof source.parts) => Math.max(...parts.map(p => p.bottom + p.height));
    assert.ok(top(distant.parts) >= top(source.parts) * .75, `${source.name} retains most of its height`);
  }
  const pylonTile = tile("powerline", 0, 3, 3);
  const pylon = buildingModel(pylonTile, 42)!;
  const pylonMedium = buildingModelLod(pylon, pylonTile, 1).parts;
  const pylonFar = buildingModelLod(pylon, pylonTile, 2).parts;
  assert.ok(pylonFar.length > 0 && pylonFar.length < pylonMedium.length,
    "narrow infrastructure has a reduced but readable far silhouette");
});

test("distance LOD bands contract with the performance scale", () => {
  assert.equal(distanceLod(90), 0);
  assert.equal(distanceLod(150), 1);
  assert.equal(distanceLod(240), 2);
  assert.equal(distanceLod(60, .5), 1);
  assert.equal(distanceLod(120, .5), 2);
});

test("subtypes have their own buildings: clean high tech and farms, and power stations that always smoke", () => {
  for (let x = 0; x < 12; x++) for (let level = 1; level <= 4; level++) {
    for (const variant of ["t", "f"]) assert.equal(buildingModel(tile("industrial", level, x, 5, variant), 42)!.chimneys.length, 0);
    assert.notEqual(buildingModel(tile("commercial", level, x, 5, "e"), 42)!.name,
      buildingModel(tile("commercial", level, x, 5, "o"), 42)!.name);
  }
  const coal = buildingModel(tile("power", 0, 3, 3, "c"), 42)!;
  assert.equal(coal.name, "Coal power station");
  assert.equal(coal.chimneys.length, 4);
  assert.ok(coal.chimneys.every(c => c.always && !c.steam && c.top > 1.5));
  const nuclear = buildingModel(tile("power", 0, 3, 3, "n"), 42)!;
  assert.ok(nuclear.chimneys.length === 2 && nuclear.chimneys.every(c => c.always && c.steam));
  assert.equal(buildingModel(tile("power", 0, 3, 3, "s"), 42)!.chimneys.length, 0);
  assert.equal(buildingModel(tile("power", 0, 3, 3), 42)!.name, "Coal power station");
});

test("wind, battery and powerline models have distinct level-zero infrastructure", () => {
  const wind = buildingModel(tile("power", 0, 3, 3, "w"), 42)!;
  assert.equal(wind.name, "Wind turbine");
  assert.equal(wind.chimneys.length, 0);
  assert.ok(wind.parts.some(part => part.bottom + part.height > 1.4), "the turbine has a tall mast for its animated rotor");
  const nacelle = wind.parts.find(part => part.bottom === 1.49 && part.width === .3)!;
  assert.ok(nacelle && nacelle.width > nacelle.depth, "nacelle's long axis is X");
  assert.ok(WIND_ROTOR.x < nacelle.x - nacelle.width / 2 - .04, "rotor clears the narrow end of the nacelle");
  assert.equal(WIND_ROTOR.y, nacelle.bottom + nacelle.height / 2);
  assert.equal(WIND_ROTOR.z, nacelle.z);
  assert.ok(WIND_ROTOR.radius > .6 && WIND_ROTOR.y - WIND_ROTOR.radius > .5, "long blades clear the ground");

  const battery = buildingModel(tile("power", 0, 3, 3, "b"), 42)!;
  assert.equal(battery.name, "Battery storage station");
  assert.equal(battery.chimneys.length, 0);
  assert.ok(battery.parts.length > 20 && battery.windows.length > 0, "storage containers and a lit control room");
  assert.ok(battery.parts.some(part => part.color === "#76d17b"), "the powered station has a green status light");
  const offline = buildingModel({ ...tile("power", 0, 3, 3, "b"), powered: false }, 42)!;
  assert.ok(offline.parts.some(part => part.color === "#c9504f"), "the unpowered station has a red status light");

  const pylon = buildingModel(tile("powerline", 0, 3, 3), 42)!;
  assert.equal(pylon.name, "Power pylon");
  assert.equal(pylon.windows.length, 0);
  assert.ok(pylon.parts.some(part => part.bottom === 0 && part.height > .5 && part.height < .75),
    "level-zero pylons have a slender house-scale mast");
});

test("visual lines consolidate dense straight runs while retaining endpoints, turns and junctions", () => {
  const poles = Array.from({ length: 11 }, (_, x) => tile("powerline", 0, x, 0));
  const lines: [number, number][] = Array.from({ length: 10 }, (_, i) => [i, i + 1]);
  const dense = visualPowerLines(poles, lines);
  assert.deepEqual([...dense.supports].sort((a, b) => a - b), [0, 4, 8, 10]);
  assert.deepEqual(dense.spans, [[0, 4], [4, 8], [8, 10]]);

  const junction = [...poles.slice(0, 9), tile("powerline", 0, 4, 1),
    tile("powerline", 0, 4, 2), tile("powerline", 0, 8, 1), tile("powerline", 0, 8, 2),
    tile("powerline", 0, 15, 5), tile("powerline", 0, 23, 5), tile("powerline", 0, 25, 5)];
  const links: [number, number][] = [
    ...lines.slice(0, 8), [4, 9], [9, 10], [8, 11], [11, 12], [13, 14],
  ];
  const layout = visualPowerLines(junction, links);
  assert.deepEqual([...layout.supports].sort((a, b) => a - b), [0, 4, 8, 10, 12, 13, 14, 15]);
  const spans = layout.spans.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join("-")).sort();
  assert.deepEqual(spans, ["0-4", "4-10", "4-8", "8-12", "13-14"].sort());
  assert.deepEqual(links.slice(-1), [[13, 14]], "visual consolidation does not mutate grid spans");
  const sparse = [tile("powerline", 0, 0, 0), tile("powerline", 0, 1, 0), tile("powerline", 0, 9, 0)];
  assert.deepEqual([...visualPowerLines(sparse, [[0, 1], [1, 2]]).supports].sort((a, b) => a - b), [0, 1, 2]);
  const ridge = Array.from({ length: 5 }, (_, x) => ({ ...tile("powerline", 0, x, 0), height: x === 2 ? 2 : 1 }));
  assert.ok(visualPowerLines(ridge, [[0, 1], [1, 2], [2, 3], [3, 4]]).supports.has(2),
    "keep the support at a terrain crest so wires do not cut through it");
});

test("power wires preserve clearance above hills and water without losing their flat-terrain sag", () => {
  const height = (start: number, end: number, control: number, t: number) =>
    (1 - t) ** 2 * start + 2 * (1 - t) * t * control + t * t * end;
  const flat = powerWireControlY(.7, .7, 8, () => 0);
  assert.ok(height(.7, .7, flat, .5) < .7, "flat spans still sag");
  const hill = (t: number) => Math.max(0, 1.15 - Math.abs(t - .5) * 3);
  const aboveHill = powerWireControlY(.7, .7, 8, hill);
  const aboveWater = powerWireControlY(.7, .28, 8, t => Math.max(-.12, -t));
  for (let i = 0; i <= 256; i++) {
    const t = i / 256;
    assert.ok(height(.7, .7, aboveHill, t) >= hill(t) + .09, `hill at ${t}`);
    assert.ok(height(.7, .28, aboveWater, t) >= Math.max(-.12, -t) + .09, `water at ${t}`);
  }
});
