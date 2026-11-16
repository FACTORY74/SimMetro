import assert from "node:assert/strict";
import test from "node:test";
import { Crown, parkTrees, SKY_AXIS, skyAngle, starField, sunDirection, wildTrees } from "./nature.ts";

test("the sun rises in the east, stands 45 degrees south at noon and sets in the west", () => {
  const rise = sunDirection(6 * 60), noon = sunDirection(12 * 60), set = sunDirection(18 * 60), night = sunDirection(0);
  assert.ok(rise.x > .99 && Math.abs(rise.y) < 1e-9, "due east at dawn");
  assert.ok(Math.abs(noon.x) < 1e-9 && noon.z > 0);
  assert.ok(Math.abs(Math.atan2(noon.y, noon.z) - Math.PI / 4) < 1e-9, "45 degrees above the southern horizon");
  assert.ok(set.x < -.99 && Math.abs(set.y) < 1e-9, "due west at dusk");
  assert.ok(night.y < 0, "below the horizon at midnight");
});

test("woods are clumped and mixed, with conifers on the uplands", () => {
  const lowland = new Set<string>(), upland = new Set<string>();
  let lowTrees = 0, crowded = 0;
  for (let z = 0; z < 120; z++) for (let x = 0; x < 120; x++) {
    const low = wildTrees(x, z, 2), high = wildTrees(x, z, 24);
    lowTrees += low.length;
    if (low.length > 1) crowded++;
    low.forEach(t => lowland.add(t.variety));
    high.forEach(t => upland.add(t.variety));
    for (const t of low) assert.ok(t.x > x && t.x < x + 1 && t.z > z && t.z < z + 1, "stays on its tile");
  }
  assert.ok(lowland.size >= 5, `lowland varieties: ${[...lowland]}`);
  assert.deepEqual([...upland].filter(v => !["fir", "pine", "shrub"].includes(v)), []);
  assert.ok(crowded > 500 && lowTrees < 120 * 120, `${crowded} wooded tiles, ${lowTrees} trees`);
  assert.equal(wildTrees(5, 5, 0).length + wildTrees(5, 5, 80).length, 0, "no trees on beaches or snow");
});

test("parks get broadleaf trees and shrubs", () => {
  const trees = parkTrees(10, 10);
  assert.ok(trees.some(t => t.crown === Crown.Bush) && trees.some(t => t.crown === Crown.Round));
});

test("stars wheel across the sky with the sun, around the pole star in the north", () => {
  // Rodrigues rotation about SKY_AXIS, as the renderer applies it to the star dome.
  const turn = (v: { x: number; y: number; z: number }, angle: number) => {
    const k = SKY_AXIS, c = Math.cos(angle), s = Math.sin(angle), d = (k.x * v.x + k.y * v.y + k.z * v.z) * (1 - c);
    return {
      x: v.x * c + (k.y * v.z - k.z * v.y) * s + k.x * d,
      y: v.y * c + (k.z * v.x - k.x * v.z) * s + k.y * d,
      z: v.z * c + (k.x * v.y - k.y * v.x) * s + k.z * d,
    };
  };
  const pole = { x: 0, y: Math.SQRT1_2, z: -Math.SQRT1_2 };
  for (const minute of [0, 300, 720, 1110]) {
    const star = turn({ x: 1, y: 0, z: 0 }, skyAngle(minute)), sun = sunDirection(minute);
    assert.ok(Math.hypot(star.x - sun.x, star.y - sun.y, star.z - sun.z) < 1e-9, "a star where the sun rose follows its path");
    const still = turn(pole, skyAngle(minute));
    assert.ok(Math.hypot(still.x - pole.x, still.y - pole.y, still.z - pole.z) < 1e-9, "the northern pole stays put");
  }
  const { positions, brightness } = starField(2000);
  let up = 0;
  for (let i = 0; i < 2000; i++) {
    assert.ok(Math.abs(Math.hypot(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!) - 1) < 1e-6);
    if (positions[i * 3 + 1]! > 0) up++;
  }
  assert.ok(up > 900 && up < 1100, `evenly spread: ${up} of 2000 above the horizon`);
  assert.ok(brightness.every(b => b > 0 && b <= 1) && brightness.some(b => b > .9) && brightness.some(b => b < .5));
});
