import type { Cell } from "./types.ts";

/** Inclusive rectangle ordered with the pointer-down cell first. */
export function levelRectangle(a: Cell, b: Cell): Cell[] {
  const cells: Cell[] = [a];
  for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++)
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++)
      if (x !== a.x || z !== a.z) cells.push({ x, z });
  return cells;
}
