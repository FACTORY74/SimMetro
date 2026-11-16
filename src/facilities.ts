import type { Cell } from "./types.ts";

export function facilityLayout(anchor: Cell, variant: string, rotation: number) {
  const width = 2, depth = variant === "t" ? 2 : 1;
  const transform = (x: number, z: number): Cell => {
    const [dx, dz] = [[x, z], [depth - 1 - z, x], [width - 1 - x, depth - 1 - z], [z, width - 1 - x]][rotation]!;
    return { x: anchor.x + dx!, z: anchor.z + dz! };
  };
  const cells: Cell[] = [];
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) cells.push(transform(x, z));
  return { cells, entrance: transform(-1, 0) };
}
