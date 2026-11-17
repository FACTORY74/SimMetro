import * as THREE from "three";
import { LEVEL_HEIGHT, TERRAIN_COLORS } from "./terrain.ts";
import { zoneColors } from "./types.ts";
import { attachDesirability, type DesirabilityData, attachWater, type WaterData, type CityState, type Kind, type Tile } from "./types.ts";

export interface DistrictDetail {
  seed: number; heights: number[]; terrainRevision: number; stamp: string;
  lots: [number, number, Kind, string, number, number, number, boolean, boolean, number, number?][];
  desirability?: DesirabilityData;
  water?: WaterData;
  powerLines: [number, number][];
  edges?: number[][];
}

export interface RegionTile {
  x: number; z: number; step: number; stamp: string;
  heights: number[]; edges: number[][];
  buildings: [number, number, number, string, number][];
  detail?: DistrictDetail;
}

/** Reuse the ordinary city renderer for neighbours, including identical tree and
 * building models. UI/economic summary fields remain owned by the focused city. */
export function detailedCity(tile: RegionTile, focus: CityState): CityState {
  const data = tile.detail!;
  const tiles: Tile[] = data.heights.map((height, i) => ({
    x: i % focus.size, z: Math.floor(i / focus.size), height, water: height < 0,
    kind: "empty", variant: "", level: 0, condition: 100, workers: 0, residents: 0,
    powered: false, connected: false, traffic: 0, powerDemand: 0, powerSupply: 0, installationPart: -1,
    powerGrid: null, batteryCharge: 0,
  }));
  for (const [x, z, kind, variant, level, condition, workers, powered, connected, residents, installationPart] of data.lots)
    Object.assign(tiles[z * focus.size + x]!, { kind, variant, level, condition, workers, powered, connected, residents, installationPart });
  return { ...focus, desirability: data.desirability, water: data.water, district: [tile.x, tile.z], seed: data.seed, tiles: attachDesirability(attachWater(tiles, focus.size, data.water), data.desirability),
    terrainRevision: data.terrainRevision, terrainEdges: data.edges ?? null, powerLines: data.powerLines, trafficRevision: -1 };
}
export interface RegionView {
  size: number; focus: [number, number]; detailed: [number, number][];
  coordinateSystem?: "world"; activeBounds?: [number, number, number, number];
  mobility?: { commuters: number; crossBoundary: number; averageWorldDistance: number };
  explored: number; inhabited: number; tiles: RegionTile[];
  terrainShell?: number;
  fogNear: number; fogFar: number;
  activity?: { hot: number; cold: number; dormant: number }; workers?: number;
  performance?: { updatesPerSecond: number; simulationMs: number };
}

const palette = TERRAIN_COLORS;
const stops = palette.map(([h, c]) => [h, new THREE.Color(c)] as const);
function tint(h: number) {
  for (let i = 1; i < stops.length; i++) {
    const [a, ca] = stops[i - 1]!, [b, cb] = stops[i]!;
    if (h <= b) return ca.clone().lerp(cb, Math.max(0, (h - a) / (b - a)));
  }
  return stops[stops.length - 1]![1];
}

/** Coarse interiors with full-resolution borders. All LODs share the same
 * half-cell border vertices, including the detailed city's terrain fan. */
export function regionGeometry(tile: RegionTile, size: number) {
  const positions: number[] = [], colors: number[] = [];
  const n = size / tile.step + 1;
  const vertex = (x: number, z: number): [number, number, number] => {
    let h: number;
    if (z === 0) h = tile.edges[0]![x * 2]!;
    else if (x === size) h = tile.edges[1]![z * 2]!;
    else if (z === size) h = tile.edges[2]![x * 2]!;
    else if (x === 0) h = tile.edges[3]![z * 2]!;
    else h = tile.heights[z / tile.step * n + x / tile.step]!;
    return [x, h, z];
  };
  const put = ([x, h, z]: [number, number, number]) => {
    positions.push(x, h * LEVEL_HEIGHT, z);
    const c = tint(h); colors.push(c.r, c.g, c.b);
  };
  for (let z = 0; z < size; z += tile.step) for (let x = 0; x < size; x += tile.step) {
    const s = tile.step, ring: [number, number, number][] = [];
    const corners: [number, number][] = [[x, z], [x, z + s], [x + s, z + s], [x + s, z]];
    for (let side = 0; side < 4; side++) {
      const a = corners[side]!, b = corners[(side + 1) % 4]!;
      const boundary = (a[0] === b[0] && (a[0] === 0 || a[0] === size)) ||
        (a[1] === b[1] && (a[1] === 0 || a[1] === size));
      const segments = boundary ? s * 2 : 1;
      for (let i = 0; i < segments; i++) ring.push(vertex(
        a[0] + (b[0] - a[0]) * i / segments, a[1] + (b[1] - a[1]) * i / segments));
    }
    const h = corners.reduce((sum, [cx, cz]) => sum + vertex(cx, cz)[1], 0) / 4;
    for (let i = 0; i < ring.length; i++) {
      put([x + s / 2, h, z + s / 2]); put(ring[i]!); put(ring[(i + 1) % ring.length]!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export class RegionRenderer {
  readonly group = new THREE.Group();
  private readonly ground = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  private readonly buildingMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private tiles = new Map<string, { stamp: string; group: THREE.Group; terrain: THREE.Mesh; buildings: THREE.InstancedMesh }>();
  private readonly boundaryMaterial = new THREE.LineBasicMaterial({ color: "#fff2a8", transparent: true, opacity: .85 });
  private readonly boundaries = new THREE.Group();
  private showBoundaries = false;

  setBoundaries(visible: boolean) {
    this.showBoundaries = visible;
    if (visible && this.boundaries.parent !== this.group) this.group.add(this.boundaries);
    if (!visible && this.boundaries.parent === this.group) this.group.remove(this.boundaries);
  }

  setBuildingsGhosted(ghosted: boolean) {
    this.buildingMaterial.transparent = ghosted;
    this.buildingMaterial.opacity = ghosted ? .5 : 1;
    this.buildingMaterial.depthWrite = !ghosted;
    this.buildingMaterial.needsUpdate = true;
  }

  private rebuildBoundaries(view: RegionView) {
    this.boundaries.clear();
    for (const tile of view.tiles) {
      const positions: number[] = [];
      const edge = (values: number[], side: number) => {
        for (let i = 0; i < values.length - 1; i++) {
          const a = i / 2, b = (i + 1) / 2, y1 = values[i]! * LEVEL_HEIGHT + .08, y2 = values[i + 1]! * LEVEL_HEIGHT + .08;
          if (side === 0) positions.push(a, y1, 0, b, y2, 0);
          else if (side === 1) positions.push(view.size, y1, a, view.size, y2, b);
          else if (side === 2) positions.push(a, y1, view.size, b, y2, view.size);
          else positions.push(0, y1, a, 0, y2, b);
        }
      };
      tile.edges.forEach(edge);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const line = new THREE.LineSegments(geometry, this.boundaryMaterial);
      line.position.set((tile.x - view.focus[0]) * view.size, 0, (tile.z - view.focus[1]) * view.size);
      this.boundaries.add(line);
    }
    if (this.showBoundaries && this.boundaries.parent !== this.group) this.group.add(this.boundaries);
  }

  update(view: RegionView, detailed: boolean, neighbours: ReadonlySet<string> = new Set()) {
    for (const child of this.boundaries.children) (child as THREE.LineSegments).geometry.dispose();
    this.rebuildBoundaries(view);
    const wanted = new Set<string>();
    for (const tile of view.tiles) {
      const key = `${tile.x}:${tile.z}`;
      wanted.add(key);
      let cached = this.tiles.get(key);
      const stamp = `${tile.step}:${tile.stamp}`;
      if (!cached || cached.stamp !== stamp) {
        if (cached) this.remove(key);
        const group = new THREE.Group();
        const terrain = new THREE.Mesh(regionGeometry(tile, view.size), this.ground);
        const buildings = new THREE.InstancedMesh(this.box, this.buildingMaterial, tile.buildings.length);
        const dummy = new THREE.Object3D(), color = new THREE.Color();
        tile.buildings.forEach(([x, z, height, kind, level], i) => {
          const h = kind === "road" ? .025 : kind === "park" ? .15 : Math.max(.5, level * .65);
          dummy.position.set(x + .5, height * LEVEL_HEIGHT + h / 2 + .015, z + .5);
          const width = kind === "road" ? 1 : .8;
          dummy.scale.set(width, h, width); dummy.updateMatrix();
          buildings.setMatrixAt(i, dummy.matrix);
          buildings.setColorAt(i, color.set(kind === "road" ? "#46535b" : kind === "residential" ? zoneColors.residential.h! :
            kind === "commercial" ? "#8daebc" : kind === "park" ? "#63985b" : "#b4a48d"));
        });
        group.add(terrain, buildings); this.group.add(group);
        cached = { stamp, group, terrain, buildings }; this.tiles.set(key, cached);
      }
      cached.group.position.set((tile.x - view.focus[0]) * view.size, 0, (tile.z - view.focus[1]) * view.size);
      cached.group.visible = !(detailed && ((tile.x === view.focus[0] && tile.z === view.focus[1]) || neighbours.has(key)));
    }
    for (const key of this.tiles.keys()) if (!wanted.has(key)) this.remove(key);
  }

  private remove(key: string) {
    const tile = this.tiles.get(key)!;
    tile.terrain.geometry.dispose(); tile.buildings.dispose();
    this.group.remove(tile.group); this.tiles.delete(key);
  }

  dispose() {
    for (const key of this.tiles.keys()) this.remove(key);
    for (const child of this.boundaries.children) (child as THREE.LineSegments).geometry.dispose();
    this.boundaryMaterial.dispose();
    this.ground.dispose(); this.buildingMaterial.dispose(); this.box.dispose();
  }
}
