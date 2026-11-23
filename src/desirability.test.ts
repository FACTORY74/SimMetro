import assert from "node:assert/strict";
import test from "node:test";
import { tileAdvice } from "./desirabilityAdvice.ts";
import type { DesirabilityLot } from "./types.ts";

const lot: DesirabilityLot = {
  score: 20, target: 20, profile: "high_tech", powerReliability: 1, waterReliability: 1,
  poorMonths: 3, commuteMinutes: null, demand: 95, blockers: ["Desirability below 50"],
  eligible: false, declining: true, updatedMonth: 192,
  components: [
    { label: "Base suitability", points: 50, detail: "high tech profile" },
    { label: "Local workforce", points: 10, detail: "871 workers" },
    { label: "Parks", points: 0, detail: "0 road-accessible parks within two tiles; bonus capped at 12" },
    { label: "Industrial nuisance", points: -10, detail: "1 developed manufacturing lot nearby" },
    { label: "Coal power station", points: -30, detail: "Within 12-tile impact radius" },
  ],
};

test("tile adviser prioritises the intervention that can close the suitability gap", () => {
  const advice = tileAdvice(lot);
  assert.match(advice[0]!.action, /coal station/i);
  assert.match(advice[0]!.reason, /30 suitability points/i);
  assert.ok(advice.some(row => /manufacturing/i.test(row.action)));
  assert.ok(advice.some(row => /park/i.test(row.action)));
});
