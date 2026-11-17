import { facilityLayout } from "./facilities";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAMERA_OFFSET, createCityCamera, updateCityCameraDepth } from "./camera";
import { LEVEL_HEIGHT, MIN_LEVEL, WATER_Y, TERRAIN_COLORS, createSurface, groundY, pickCell, surfaceY, writeVehicleTransform } from "./terrain";
import type { Surface } from "./terrain";
import { colors, roadType, subtype, zoneColor } from "./types";
import { POWER_WIRE_HEIGHT, ROOMS, WIND_ROTOR, buildingModel, buildingModelLod, distanceLod, powerWireControlY, visualPowerLines, windowLit, type BuildingLod, type WindowUse } from "./buildings";
import { DAY, LANE, TrafficSim, VehicleKind, buildFleet, isJunction, roadSides } from "./traffic";
import type { Placement } from "./traffic";
import { CROWN_COUNT, SKY_AXIS, hash, parkTrees, skyAngle, starField, sunDirection, wildTrees } from "./nature";
import type { Tree } from "./nature";
import type { Cell, CityState, Overlay, Speed, Tile, Tool, TrafficData } from "./types";
import { RegionRenderer, detailedCity } from "./region";
import type { RegionView } from "./region";
import { levelRectangle } from "./selection";

const MAX_STROKE = 400;
const COLUMN_BOTTOM = groundY(MIN_LEVEL) - .6;
/** Buildings extend below the tile centre so they never float over the downhill side of a slope. */
const FOUNDATION = LEVEL_HEIGHT;
const VERTICES_PER_TILE = 24;
// Tile perimeter on the half-tile grid, traversed so the fan triangles face upwards.
const RING_I = [0, 1, 2, 2, 2, 1, 0, 0], RING_J = [0, 0, 0, 1, 2, 2, 2, 1];
const SKY = "#b7cdd0";
const DAY_SKY = new THREE.Color(SKY), NIGHT_SKY = new THREE.Color("#1c2a3d"), DUSK_SKY = new THREE.Color("#d9a382");
const CAR_COLORS = ["#d84a3a", "#f2f0e8", "#3d6fb6", "#2f3438", "#e2b13c", "#7d8b92", "#4f8d5c", "#a3b8c9"]
  .map(c => new THREE.Color(c));
const SHOPPER_COLORS = ["#c96fa1", "#f08a4b", "#65c1c4", "#e7d27a"].map(c => new THREE.Color(c));
const TRUCK_COLORS = ["#f5f1e6", "#d7743a", "#5a7c8f"].map(c => new THREE.Color(c));
const CLOCK_MINUTES_PER_SECOND = DAY / 60;
/** Showcase camera: elevation range (polar angle from straight down), zoom range and their periods in game minutes. */
/** Showcase tour: polar range, and zoom between these multiples of the distance the tour started at. */
const TOUR = { polar: [.55, 1.25] as const, polarPeriod: 720 * 1.7, far: 1.6, near: .55, zoomPeriod: 720 * .8 };
const STAR_COUNT = 7000, STAR_RADIUS = 1000;
const skyAxis = new THREE.Vector3(SKY_AXIS.x, SKY_AXIS.y, SKY_AXIS.z);
// Treetops bend downwind (the way chimney smoke drifts) and rock gently in the gusts; bases stay put.
const SWAY_VERTEX = /* glsl */ `
  vec4 mvPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
    vec2 root = instanceMatrix[3].xz;
    float phase = dot(root, vec2(.73, 1.31));
    float gust = .55 + .45 * sin(swayTime * .31 + root.x * .045 + root.y * .03);
    float bend = transformed.y * transformed.y * length(instanceMatrix[1].xyz) * gust;
    mvPosition.xz += vec2(.92, .4) * bend * (.025 + .035 * sin(swayTime * 1.6 + phase))
      + vec2(-.4, .92) * bend * .012 * sin(swayTime * 2.3 + phase * 1.7);
  #endif
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
`;
const trafficRamp: [number, THREE.Color][] = ([
  [0, "#4f6670"], [.05, "#57b46d"], [.6, "#e3c650"], [1, "#e0803f"], [1.5, "#c9372c"],
] as [number, string][]).map(([h, c]) => [h, new THREE.Color(c)]);
const MUTED = new THREE.Color("#9aa69f"), PALE = new THREE.Color("#d9ddd8");
const WHITE = new THREE.Color("#ffffff"), LOT_TINT = new THREE.Color("#c9d6c2");
const terrainStops: [number, THREE.Color][] = TERRAIN_COLORS.map(([h, c]) => [h, new THREE.Color(c)]);
const elevationStops: [number, THREE.Color][] = ([
  [-32, "#16337a"], [-1, "#4f9bd8"], [0, "#f4e6a2"], [16, "#62b45f"], [40, "#c6a44d"], [64, "#8a5a3c"], [96, "#ffffff"],
] as [number, string][]).map(([h, c]) => [h, new THREE.Color(c)]);
const previewColors: Partial<Record<Tool, string>> = {
  inspect: "#ffffff", bulldoze: "#e46f57", raise: "#f6d77f", lower: "#79b8e0", level: "#b9d7a3",
};

const SUN_LOW = new THREE.Color("#ffb070"), SUN_HIGH = new THREE.Color("#fff4df");
const SKY_DAY = new THREE.Color("#f1f7ff"), SKY_NIGHT = new THREE.Color("#7d92c4");
const GROUND_DAY = new THREE.Color("#55684f"), GROUND_NIGHT = new THREE.Color("#2b3540");
const SHADOW_MAP = 4096;
const WINDOW_GLOW = new THREE.Color("#ffd27a");
const PANE_COLORS: Record<WindowUse, THREE.Color> = {
  home: new THREE.Color("#3c5260"), work: new THREE.Color("#6e98ab"),
  shop: new THREE.Color("#86aab5"), boarded: new THREE.Color("#6d5340"),
  venue: new THREE.Color("#5a5068"), neon: new THREE.Color("#4a4652"),
};
const USES: WindowUse[] = ["home", "work", "shop", "boarded", "venue", "neon"];
/** Sidewalks: width, and how far their centre line sits from the lot centre (just past the edge, on the road). */
const SIDEWALK = "#b8b5ac", SIDEWALK_WIDTH = .17, SIDEWALK_OUT = .525;
/** Outward direction of building faces 0 N, 1 E, 2 S, 3 W. */
const FACE_X = [0, 1, 0, -1], FACE_Z = [-1, 0, 1, 0];
/** How far a strip runs past its lot to reach the outer edge of a crossing strip. */
const CORNER = SIDEWALK_OUT + SIDEWALK_WIDTH / 2 - .5;
/** Venue rooms glow in party colours; neon tubes are brighter and some cycle through the palette. */
const VENUE_GLOW = ["#ff6fb5", "#b072ff", "#ffb347", "#4fd8e8", "#ff5a5a", "#7cf07a"].map(c => new THREE.Color(c));
const NEON_GLOW = ["#ff2fa8", "#2ff4ff", "#a54bff", "#ffd23f", "#4bff6e", "#ff4040"].map(c => new THREE.Color(c));
/** Game minutes between colour changes on cycling neon. */
const NEON_CYCLE = 20;
const SMOKE_DARK = new THREE.Color("#5f5b57"), SMOKE_LIGHT = new THREE.Color("#d9d7d1"), STEAM = new THREE.Color("#f4f5f4");
/** Puffs per chimney and how long (game minutes) each drifts before dissolving. */
const PUFFS = 7, PUFF_LIFE = 90;
const WIND_X = .8, WIND_Z = .35;

function ramp(stops: [number, THREE.Color][], height: number, target: THREE.Color) {
  const first = stops[0]!, last = stops[stops.length - 1]!;
  if (height <= first[0]) return target.copy(first[1]);
  for (let i = 1; i < stops.length; i++) {
    const [h1, c1] = stops[i]!;
    const [h0, c0] = stops[i - 1]!;
    if (height <= h1) return target.copy(c0).lerp(c1, (height - h0) / (h1 - h0));
  }
  return target.copy(last[1]);
}

/** Four-connected path so dragged roads never touch only at a corner. */
export function roadLine(a: Cell, b: Cell): Cell[] {
  const cells: Cell[] = [{ ...a }];
  const dx = b.x - a.x, dz = b.z - a.z, steps = Math.max(Math.abs(dx), Math.abs(dz));
  let x = a.x, z = a.z;
  for (let i = 1; i <= steps; i++) {
    const nx = a.x + Math.round(dx * i / steps), nz = a.z + Math.round(dz * i / steps);
    if (nx !== x && nz !== z) cells.push({ x: nx, z });
    cells.push({ x: nx, z: nz });
    x = nx; z = nz;
  }
  return cells.slice(0, MAX_STROKE);
}

function rectangle(a: Cell, b: Cell): Cell[] {
  const cells: Cell[] = [];
  for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++)
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) cells.push({ x, z });
  return cells.slice(0, MAX_STROKE);
}

export class CityWorld {
  enabled = true;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly detail = new THREE.Group();
  private readonly regionRenderer = new RegionRenderer();
  private regionView: RegionView | null = null;
  private detailed = true;
  private detailDirty = false;
  /** Multiplier for the full/medium LOD radii. It contracts after five seconds
   * below the frame-rate target and recovers cautiously when there is headroom. */
  private lodDistanceScale = 1;
  private lowFpsFor = 0;
  private highFpsFor = 0;
  private terrainShell = 1;
  private lowTerrainFpsFor = 0;
  private highTerrainFpsFor = 0;
  private terrainShellAdjustedAt = 0;
  private lodAdjustedAt = 0;
  private lodRefreshedAt = 0;
  private readonly lodCamera = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private readonly neighbours = new Map<string, { world: CityWorld; stamp: string; x: number; z: number }>();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly materials: THREE.Material[] = [];
  private readonly terrain: THREE.Mesh;
  private surface: Surface | null = null;
  private buildings: THREE.InstancedMesh;
  private cylinders: THREE.InstancedMesh;
  private serviceRings: THREE.InstancedMesh;
  private readonly crowns: THREE.InstancedMesh[][] = [[], [], []];
  private readonly trunks: THREE.InstancedMesh[] = [];
  private readonly preview: THREE.InstancedMesh;
  private readonly selection: THREE.LineSegments;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly keys = new Set<string>();
  private readonly resize: ResizeObserver;
  private city: CityState | null = null;
  private terrainKey = "";
  private tool: Tool = "inspect";
  private overlay: Overlay = "normal";
  private anchor: Cell | null = null;
  private hovered: Cell | null = null;
  private selectedCell: Cell | null = null;
  private stroke: Cell[] = [];
  private frame = 0;
  private last = performance.now();
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky = new THREE.Color(SKY);
  private readonly swayTime = { value: 0 };
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.ShaderMaterial;
  private vehicles: THREE.InstancedMesh;
  private wheels: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  /** Coloured light thrown onto the pavement by venue frontages and low neon signs. */
  private spills: THREE.InstancedMesh;
  /** For each spill, the index of the window (in `windowSlots`) whose glow it carries. */
  private spillWindows = new Uint32Array(0);
  private readonly lampMaterial: THREE.MeshBasicMaterial;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly sunDirection = { x: 0, y: 1, z: 0 };
  private night = 0;
  private panes: THREE.InstancedMesh;
  /** Per-pane emissive colour, so a lit window glows in place rather than being drawn twice. */
  private readonly paneGeometry = new THREE.BoxGeometry(1, 1, 1);
  /** Every window that can light up: its pane instance, city-wide room id and use index. */
  private windowSlots = new Uint32Array(0);
  private windowIds = new Uint32Array(0);
  private windowUses = new Uint8Array(0);
  private windowPower = new Uint8Array(0);
  private windowStep = -1;
  private smoke: THREE.InstancedMesh;
  private chimneys: { x: number; y: number; z: number; start: number; end: number; phase: number; width: number; steam: boolean }[] = [];
  private windRotors: THREE.InstancedMesh;
  private windRotorPositions: { index: number; x: number; y: number; z: number; angle: number }[] = [];
  private readonly powerWires: THREE.Mesh;
  private powerWireKey = "";
  private sim: TrafficSim | null = null;
  private markings: THREE.InstancedMesh;
  private sidewalks: THREE.InstancedMesh;
  private markingsKey = "";
  private junctions = new Set<number>();
  private traffic: TrafficData | null = null;
  private readonly placement: Placement = { x: 0, z: 0, dx: 0, dz: 0 };
  private clockBase = 360;
  private showcase: { angle: number; progress: number; clock: number; polar: number; distance: number; polarPhase: number;
    zoomPhase: number; near: number; far: number } | null = null;
  private clockAt = performance.now();
  private running = false;
  private reported = 0;
  private reportedFrames = 0;
  /** Called about twice a second with traffic on the road, the extrapolated clock and people per car. */
  onTick: ((vehicles: number, clock: number, queued: number, peoplePerCar: number, fps: number) => void) | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly onStroke: (cells: Cell[]) => void,
    private readonly onHover: (cell: Cell | null) => void,
    private readonly onSelect: (cell: Cell | null) => void,
    private readonly shared?: { renderer: THREE.WebGLRenderer; controls: OrbitControls },
  ) {
    this.renderer = shared?.renderer ?? new THREE.WebGLRenderer({ antialias: true });
    if (!shared) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      container.appendChild(this.renderer.domElement);
    }
    this.scene.background = new THREE.Color(SKY);
    this.scene.add(this.detail, this.regionRenderer.group);
    this.scene.fog = new THREE.Fog(SKY, 260, 720);
    this.camera = createCityCamera();
    this.hemisphere = new THREE.HemisphereLight("#f1f7ff", "#55684f", 1.9);
    this.sun = new THREE.DirectionalLight("#fff4df", 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -.0005;
    this.sun.shadow.normalBias = .04;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 450;
    this.scene.add(this.hemisphere, this.sun, this.sun.target);

    // Square, unblurred stars on a dome around the camera, wheeling with the sun and hidden below the horizon.
    const field = starField(STAR_COUNT);
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(field.positions.map(p => p * STAR_RADIUS), 3));
    starGeometry.setAttribute("brightness", new THREE.BufferAttribute(field.brightness, 1));
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 }, pixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: /* glsl */ `
        attribute float brightness;
        uniform float opacity, pixelRatio;
        varying float alpha;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          float up = normalize(world.xyz - cameraPosition).y;
          alpha = opacity * brightness * smoothstep(-.015, .05, up);
          gl_PointSize = (brightness > .85 ? 3.0 : 2.0) * pixelRatio;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        varying float alpha;
        void main() { gl_FragColor = vec4(1.0, .97, .88, alpha); }`,
      transparent: true,
      depthWrite: false,
    });
    this.materials.push(this.starMaterial);
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    this.scene.add(this.stars);

    const material = (options: THREE.MeshLambertMaterialParameters) => {
      const created = new THREE.MeshLambertMaterial(options);
      this.materials.push(created);
      return created;
    };
    const instanced = (geometry: THREE.BufferGeometry, count: number, mat: THREE.Material, cast = true, receive = true) => {
      const mesh = new THREE.InstancedMesh(geometry, mat, count);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      this.detail.add(mesh);
      return mesh;
    };
    this.terrain = new THREE.Mesh(new THREE.BufferGeometry(),
      material({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
    this.terrain.frustumCulled = false;
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = true;
    this.detail.add(this.terrain);
    this.buildings = instanced(this.box, 1, material({}));
    this.cylinders = instanced(new THREE.CylinderGeometry(.5, .5, 1, 12), 1, material({ flatShading: true }));
    this.serviceRings = instanced(new THREE.RingGeometry(.965, 1, 64).rotateX(-Math.PI / 2), 1,
      material({ transparent: true, opacity: .42, depthWrite: false }), false, false);
    this.serviceRings.renderOrder = 3;
    const rotorParts: THREE.BufferGeometry[] = [];
    const bladeLength = WIND_ROTOR.radius - WIND_ROTOR.root;
    for (let blade = 0; blade < 3; blade++) {
      const geometry = new THREE.CylinderGeometry(.009, .044, bladeLength, 4)
        .scale(.25, 1, 1).translate(0, WIND_ROTOR.root + bladeLength / 2, 0)
        .rotateX(blade * Math.PI * 2 / 3);
      rotorParts.push(geometry);
    }
    rotorParts.push(new THREE.SphereGeometry(.065, 8, 6));
    const rotorGeometry = mergeGeometries(rotorParts, false)!;
    rotorParts.forEach(geometry => geometry.dispose());
    this.windRotors = instanced(rotorGeometry, 1, material({ color: "#e5e8e4", flatShading: true }));
    this.powerWires = new THREE.Mesh(new THREE.BufferGeometry(), material({ color: "#30383a" }));
    this.powerWires.frustumCulled = false;
    this.powerWires.castShadow = true;
    this.powerWires.receiveShadow = true;
    this.detail.add(this.powerWires);
    // Three crown geometry levels in Crown order (fir, pine, round, bush).
    // All are one unit wide/high from y=0, so an individual tree can move
    // between instance pools without changing its silhouette or placement.
    const crownShapes = [
      [
        mergeGeometries([
          new THREE.ConeGeometry(.5, .55, 7).translate(0, .275, 0),
          new THREE.ConeGeometry(.38, .5, 7).translate(0, .5, 0),
          new THREE.ConeGeometry(.26, .45, 7).translate(0, .775, 0),
        ])!,
        new THREE.ConeGeometry(.5, 1, 7).translate(0, .5, 0),
        new THREE.DodecahedronGeometry(.5, 0).translate(0, .5, 0),
        new THREE.IcosahedronGeometry(.5, 0).translate(0, .5, 0),
      ],
      [
        mergeGeometries([
          new THREE.ConeGeometry(.5, .62, 5).translate(0, .31, 0),
          new THREE.ConeGeometry(.32, .55, 5).translate(0, .725, 0),
        ])!,
        new THREE.ConeGeometry(.5, 1, 5).translate(0, .5, 0),
        new THREE.OctahedronGeometry(.5, 0).translate(0, .5, 0),
        new THREE.OctahedronGeometry(.5, 0).scale(1, .7, 1).translate(0, .35, 0),
      ],
      [
        new THREE.ConeGeometry(.5, 1, 3).translate(0, .5, 0),
        new THREE.ConeGeometry(.5, 1, 3).translate(0, .5, 0),
        new THREE.TetrahedronGeometry(.62, 0).rotateY(Math.PI / 4).translate(0, .45, 0),
        new THREE.TetrahedronGeometry(.56, 0).rotateY(Math.PI / 4).scale(1, .65, 1).translate(0, .3, 0),
      ],
    ];
    const foliage = material({ flatShading: true });
    const sway = (target: THREE.Material) => {
      target.onBeforeCompile = shader => {
        shader.uniforms.swayTime = this.swayTime;
        shader.vertexShader = "uniform float swayTime;\n"
          + shader.vertexShader.replace("#include <project_vertex>", SWAY_VERTEX);
      };
      target.customProgramCacheKey = () => "sway";
    };
    sway(foliage);
    const swayingShadow = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    sway(swayingShadow);
    this.materials.push(swayingShadow);
    for (let lod = 0; lod < 3; lod++) for (let c = 0; c < CROWN_COUNT; c++) {
      const crown = instanced(crownShapes[lod]![c]!, 1, foliage, lod < 2, false);
      if (lod < 2) crown.customDepthMaterial = swayingShadow;
      this.crowns[lod]!.push(crown);
    }
    const bark = material({});
    this.trunks.push(
      instanced(new THREE.CylinderGeometry(.5, .6, 1, 5).translate(0, .5, 0), 1, bark, true, false),
      instanced(new THREE.CylinderGeometry(.5, .6, 1, 3).translate(0, .5, 0), 1, bark, false, false),
    );
    this.preview = instanced(this.box, MAX_STROKE, material({ transparent: true, opacity: .6, depthWrite: false }), false, false);
    // A small car built along +x: body plus a narrower cabin, merged into one instanced geometry.
    const car = mergeGeometries([
      new THREE.BoxGeometry(.3, .07, .15).translate(0, .075, 0),
      new THREE.BoxGeometry(.16, .06, .13).translate(-.02, .14, 0),
    ]);
    this.vehicles = instanced(car, 1, material({}), true, false);
    // Four tyres under the body, sharing each car's transform (trucks stretch to a longer wheelbase).
    const tyre = (x: number, z: number) =>
      new THREE.CylinderGeometry(.032, .032, .026, 10).rotateX(Math.PI / 2).translate(x, .032, z);
    this.wheels = instanced(mergeGeometries([tyre(.09, .064), tyre(.09, -.064), tyre(-.09, .064), tyre(-.09, -.064)]),
      1, material({ color: "#1c1d20" }), false, false);
    // Head- and tail-lights on the car's nose and tail, and a pool of light on the road ahead.
    const lamp = (x: number, z: number, color: string) => {
      const box = new THREE.BoxGeometry(.012, .022, .03).translate(x, .085, z);
      const rgb = new THREE.Color(color), colors = new Float32Array(box.getAttribute("position").count * 3);
      for (let i = 0; i < colors.length; i += 3) rgb.toArray(colors, i);
      box.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      return box;
    };
    const lamps = mergeGeometries([lamp(.154, .045, "#fff6d8"), lamp(.154, -.045, "#fff6d8"),
      lamp(-.154, .05, "#ff3b2a"), lamp(-.154, -.05, "#ff3b2a")]);
    this.lampMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.materials.push(this.lampMaterial);
    this.lamps = instanced(lamps, 1, this.lampMaterial, false, false);
    const beam = new THREE.BufferGeometry();
    // Trapezoid from the bumper (x = .16) to 0.8 ahead, fading from warm white to nothing.
    beam.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      .16, .015, -.06, .16, .015, .06, .45, .015, .15, .45, .015, -.15, .8, .015, .24, .8, .015, -.24]), 3));
    beam.setAttribute("color", new THREE.BufferAttribute(new Float32Array([
      1, .92, .7, 1, .92, .7, .45, .41, .31, .45, .41, .31, 0, 0, 0, 0, 0, 0]), 3));
    beam.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]);
    this.beamMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.materials.push(this.beamMaterial);
    this.beams = instanced(beam, 1, this.beamMaterial, false, false);
    // A strip of light from a frontage (x = 0) out across the pavement, built along +x for a unit-wide source.
    // It barely widens, so neighbouring windows' strips sit side by side instead of piling up to white.
    const spill = new THREE.BufferGeometry();
    spill.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      0, 0, -.5, 0, 0, .5, .2, 0, .55, .2, 0, -.55, .45, 0, .62, .45, 0, -.62]), 3));
    spill.setAttribute("color", new THREE.BufferAttribute(new Float32Array([
      1, 1, 1, 1, 1, 1, .45, .45, .45, .45, .45, .45, 0, 0, 0, 0, 0, 0]), 3));
    spill.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]);
    const spillMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.materials.push(spillMaterial);
    this.spills = instanced(spill, 1, spillMaterial, false, false);
    this.spills.count = 0;
    this.beams.renderOrder = 2;
    this.markings = instanced(this.box, 1, material({ color: "#eef0ea" }), false, true);
    this.sidewalks = instanced(this.box, 1, material({}), false, true);
    const glass = material({});
    glass.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec3 glow;\nvarying vec3 vGlow;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vGlow;")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;");
    };
    this.paneGeometry.setAttribute("glow", new THREE.InstancedBufferAttribute(new Float32Array(3), 3));
    this.panes = instanced(this.paneGeometry, 1, glass, false, true);
    this.smoke = instanced(new THREE.IcosahedronGeometry(.5, 0),
      1, material({ flatShading: true, transparent: true, opacity: .6, depthWrite: false }), false, false);
    this.smoke.renderOrder = 2;

    const water = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2),
      material({ color: "#3f8db0", transparent: true, opacity: .68, depthWrite: false }));
    water.position.y = WATER_Y;
    water.renderOrder = 1;
    water.receiveShadow = true;
    const seabed = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2),
      material({ color: "#2c5562" }));
    // Keep the background ocean floor clear of the lowest terrain and map sides.
    seabed.position.y = COLUMN_BOTTOM - .1;
    this.scene.add(seabed, water);

    const outline = new THREE.LineBasicMaterial({ color: "#fff2a8" });
    this.materials.push(outline);
    this.selection = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, .5, 1.04)), outline);
    this.selection.visible = false;
    this.detail.add(this.selection);

    if (shared) {
      // Neighbours contribute only their detail group to the parent scene. They
      // share its WebGL context, controls, lights and animation loop.
      this.controls = shared.controls;
      this.resize = new ResizeObserver(() => {});
      return;
    }
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 900;
    this.controls.maxPolarAngle = 1.38;
    this.controls.target.set(128, 0, 128);
    this.controls.addEventListener("change", this.clampTarget);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("pointerleave", this.pointerLeave);
    canvas.addEventListener("contextmenu", this.preventMenu);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", this.clearKeys);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.frame = requestAnimationFrame(this.animate);
  }

  update(city: CityState) {
    const resized = this.city?.size !== city.size;
    const switched = this.city && (this.city.district[0] !== city.district[0] || this.city.district[1] !== city.district[1]);
    if (switched && this.city && !this.shared) {
      const shift = new THREE.Vector3((this.city.district[0] - city.district[0]) * city.size, 0,
        (this.city.district[1] - city.district[1]) * city.size);
      this.camera.position.add(shift); this.controls.target.add(shift);
      for (const neighbour of this.neighbours.values()) neighbour.world.detail.position.add(shift);
      this.regionRenderer.group.position.add(shift);
      this.cancel(); this.hovered = null; this.onHover(null); this.onSelect(null);
    }
    if (this.city && (this.city.session !== city.session || switched)) {
      this.traffic = null;
      this.sim = null;
      this.scheduled = "";
    }
    this.city = city;
    if (resized && !this.shared) {
      const centre = city.size / 2;
      this.controls.target.set(centre, 0, centre);
      this.camera.position.set(centre + CAMERA_OFFSET.x, CAMERA_OFFSET.y, centre + CAMERA_OFFSET.z);
    }
    if (!this.detailed) { this.detailDirty = true; return; }
    this.detailDirty = false;
    const key = `${city.session}:${city.district}:${city.size}:${city.terrainRevision}`;
    if (key !== this.terrainKey) {
      this.terrainKey = key;
      this.buildTerrain(city);
    }
    this.buildMarkings(city);
    this.paintTerrain(city);
    this.buildDevelopment(city);
    this.refreshPreview();
    this.refreshSchedule();
  }

  private facilityVariant = "p";
  private powerVariant = "c";
  private facilityRotation = 0;
  setFacilityPlacement(variant: string, rotation: number, powerVariant = this.powerVariant) {
    this.facilityVariant = variant;
    this.facilityRotation = rotation;
    this.powerVariant = powerVariant;
    this.refreshPreview();
  }
  setTool(tool: Tool) {
    this.tool = tool;
    this.anchor = null;
    this.stroke = [];
    this.refreshPreview();
    if (this.city && this.detailed) this.buildDevelopment(this.city);
  }

  view() {
    const [x, z] = this.city?.district ?? [0, 0];
    const size = this.city?.size ?? 100;
    return { x: this.controls.target.x + x * size, z: this.controls.target.z + z * size,
      distance: this.camera.position.distanceTo(this.controls.target), terrainShell: this.terrainShell };
  }

  centreDistrict() {
    const centre = (this.city?.size ?? 100) / 2;
    const shift = new THREE.Vector3(centre, 0, centre).sub(this.controls.target);
    this.camera.position.add(shift); this.controls.target.add(shift);
  }

  overview() {
    this.camera.position.sub(this.controls.target).setLength(700).add(this.controls.target);
  }

  startingCity() {
    const [x, z] = this.city?.district ?? [0, 0], size = this.city?.size ?? 100;
    this.controls.target.set(size / 2 - x * size, 0, size / 2 - z * size);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z));
  }

  setRegion(view: RegionView) {
    this.regionView = view;
    this.refreshNeighbours();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = view.fogNear; fog.far = view.fogFar;
  }

  setTileBoundaries(visible: boolean) {
    this.regionRenderer.setBoundaries(visible);
  }

  private refreshNeighbours() {
    const view = this.regionView, city = this.city;
    if (!view || !city || this.shared || view.focus.toString() !== city.district.toString()) return;
    const wanted = new Set<string>();
    if (this.detailed) for (const tile of view.tiles) {
      if (!tile.detail || (tile.x === view.focus[0] && tile.z === view.focus[1])) continue;
      const key = `${tile.x}:${tile.z}`;
      wanted.add(key);
      const stamp = `${city.session}:${tile.detail.stamp}`;
      let neighbour = this.neighbours.get(key);
      if (!neighbour) {
        const world = new CityWorld(this.container, () => {}, () => {}, () => {},
          { renderer: this.renderer, controls: this.controls });
        world.lodDistanceScale = this.lodDistanceScale;
        neighbour = { world, stamp: "", x: tile.x, z: tile.z };
        this.neighbours.set(key, neighbour);
        this.scene.add(world.detail);
      }
      if (neighbour.stamp !== stamp) {
        neighbour.world.update(detailedCity(tile, city));
        neighbour.stamp = stamp;
      }
      neighbour.world.detail.position.set((tile.x - view.focus[0]) * view.size, 0, (tile.z - view.focus[1]) * view.size);
      if (neighbour.world.overlay !== this.overlay) neighbour.world.setOverlay(this.overlay);
    }
    for (const [key, neighbour] of this.neighbours) {
      if (!wanted.has(key)) { neighbour.world.dispose(); this.neighbours.delete(key); }
    }
    this.regionRenderer.group.position.set(0, 0, 0);
    this.regionRenderer.update(view, this.detailed, wanted);
  }

  setOverlay(overlay: Overlay) {
    this.overlay = overlay;
    if (this.city && this.detailed) {
      this.paintTerrain(this.city);
      this.buildDevelopment(this.city);
    }
    this.setBuildingsGhosted(overlay === "desirability");
    this.regionRenderer.setBuildingsGhosted(overlay === "desirability");
    for (const neighbour of this.neighbours.values()) neighbour.world.setOverlay(overlay);
  }

  private setBuildingsGhosted(ghosted: boolean) {
    for (const mesh of [this.buildings, this.cylinders, this.panes, this.windRotors]) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        material.transparent = ghosted;
        material.opacity = ghosted ? .5 : 1;
        material.depthWrite = !ghosted;
        material.needsUpdate = true;
      }
    }
  }

  /** Server clock in minutes since the start of the month; extrapolated locally between polls. */
  setClock(clock: number, speed: Speed) {
    const predicted = this.clock();
    const drift = clock - predicted;
    // Small drift is eased out so cars never jump backwards; month rollovers and loads snap.
    this.clockBase = Math.abs(drift) < 6 && this.running ? predicted + drift * .25 : clock;
    this.clockAt = performance.now();
    this.running = speed !== 0;
  }

  setTraffic(traffic: TrafficData) {
    this.traffic = traffic;
    this.refreshSchedule();
  }

  private scheduled = "";
  private refreshSchedule() {
    const city = this.city, traffic = this.traffic;
    if (!city || !traffic || city.trafficRevision !== traffic.revision) return;
    const key = `${traffic.revision}:${this.markingsKey}`;
    if (key === this.scheduled) return;
    this.scheduled = key;
    const sim = new TrafficSim(buildFleet(traffic, tile => city.tiles[tile]?.kind === "road"));
    // Keep cars that are mid-journey when only the plan changes, by restarting from the same clock.
    if (this.sim) sim.reset(this.sim.time);
    this.sim = sim;
  }

  /** White centre lines on plain roads and stop lines where each lane meets a junction. */
  private buildMarkings(city: CityState) {
    const surface = this.surface;
    if (!surface) return;
    let roads = 0, digest = 0;
    city.tiles.forEach((tile, i) => {
      if (tile.kind === "road") { roads++; digest = (Math.imul(digest, 31) + i + (tile.variant || "r").charCodeAt(0)) | 0; }
    });
    const key = `${this.terrainKey}:${roads}:${digest}`;
    if (key === this.markingsKey) return;
    this.markingsKey = key;
    const size = city.size, isRoad = (tile: number) => city.tiles[tile]?.kind === "road";
    const marks: [number, number, number, number, number][] = [];  // centre x, z, direction x, z, length
    this.junctions.clear();
    city.tiles.forEach((tile, i) => {
      if (tile.kind !== "road") return;
      const mask = roadSides(i, size, isRoad), cx = tile.x + .5, cz = tile.z + .5;
      const junction = isJunction(mask);
      if (junction) this.junctions.add(i);
      for (let side = 0; side < 4; side++) {
        if (!(mask & 1 << side)) continue;
        const sx = [0, 1, 0, -1][side]!, sz = [-1, 0, 1, 0][side]!;
        if (junction) {
          // Across the lane arriving from this side: heading -side, its right is (sz, -sx).
          marks.push([cx + sx * .42 + sz * LANE, cz + sz * .42 - sx * LANE, sz, -sx, .3]);
        } else if (tile.variant !== "s") {
          marks.push([cx + sx * .25, cz + sz * .25, sx, sz, .22]);
        }
      }
    });
    this.markings = this.ensure(this.markings, marks.length);
    const dummy = this.dummy, target = new THREE.Vector3();
    marks.forEach(([x, z, dx, dz, length], i) => {
      const half = length / 2;
      const y0 = surface.groundAt(x - dx * half, z - dz * half), y1 = surface.groundAt(x + dx * half, z + dz * half);
      dummy.position.set(x, (y0 + y1) / 2 + .012, z);
      dummy.scale.set(.035, .006, Math.hypot(length, y1 - y0));
      dummy.lookAt(target.set(x + dx * half, y1 + .012, z + dz * half));
      dummy.updateMatrix();
      this.markings.setMatrixAt(i, dummy.matrix);
    });
    dummy.rotation.set(0, 0, 0);
    this.markings.count = marks.length;
    this.markings.instanceMatrix.needsUpdate = true;
    this.paintTerrain(city);
  }

  private clock() {
    return this.clockBase + (this.running ? (performance.now() - this.clockAt) / 1000 * CLOCK_MINUTES_PER_SECOND : 0);
  }

  private drive(clock: number) {
    const sim = this.sim, surface = this.surface, size = this.city?.size ?? 0;
    if (!this.detailed || !sim || !surface) { this.vehicles.count = this.wheels.count = this.lamps.count = this.beams.count = 0; return 0; }
    sim.sync(clock);
    this.vehicles = this.ensure(this.vehicles, sim.cars.length);
    const mesh = this.vehicles, matrix = mesh.instanceMatrix.array as Float32Array, p = this.placement;
    sim.cars.forEach((car, i) => {
      sim.place(car, size, p);
      const kind = car.driver.kind, truck = kind === VehicleKind.Truck;
      const long = truck ? 1.7 : 1, tall = truck ? 1.5 : 1;
      writeVehicleTransform(surface, p.x, p.z, p.dx, p.dz, long, tall, matrix, i * 16);
      const palette = truck ? TRUCK_COLORS : kind === VehicleKind.Shopper ? SHOPPER_COLORS : CAR_COLORS;
      mesh.setColorAt(i, palette[Math.floor(car.driver.shade * palette.length)]!);
    });
    mesh.count = sim.cars.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.wheels = this.ensure(this.wheels, sim.cars.length);
    (this.wheels.instanceMatrix.array as Float32Array).set(matrix.subarray(0, sim.cars.length * 16));
    this.wheels.count = sim.cars.length;
    this.wheels.instanceMatrix.needsUpdate = true;
    // Lights share each car's transform; they are only drawn between dusk and dawn.
    const lit = this.night > .05 ? sim.cars.length : 0;
    this.lamps = this.ensure(this.lamps, lit);
    this.beams = this.ensure(this.beams, lit);
    for (const lights of [this.lamps, this.beams]) {
      lights.count = lit;
      if (!lit) continue;
      (lights.instanceMatrix.array as Float32Array).set(matrix.subarray(0, lit * 16));
      lights.instanceMatrix.needsUpdate = true;
    }
    return sim.cars.length;
  }

  /** Sun and sky follow the time of day; nights stay readable rather than realistic. */
  private light(minute: number) {
    const hours = minute / 60;
    const daylight = THREE.MathUtils.smoothstep(hours, 5, 7.5) * (1 - THREE.MathUtils.smoothstep(hours, 18, 20.5));
    const dusk = Math.max(0, 1 - Math.abs(hours - 19.3) / 1.3) + Math.max(0, 1 - Math.abs(hours - 6.2) / 1.1);
    this.night = 1 - daylight;
    this.sky.copy(NIGHT_SKY).lerp(DAY_SKY, daylight).lerp(DUSK_SKY, Math.min(.45, dusk * .45));
    (this.scene.background as THREE.Color).copy(this.sky);
    (this.scene.fog as THREE.Fog).color.copy(this.sky);
    this.hemisphere.intensity = .7 + daylight * .85;
    this.hemisphere.color.copy(SKY_NIGHT).lerp(SKY_DAY, daylight);
    this.hemisphere.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, daylight);

    const sun = sunDirection(minute, this.sunDirection);
    const height = THREE.MathUtils.smoothstep(sun.y, -.02, .14);
    this.sun.intensity = height * 2.3;
    this.sun.color.copy(SUN_LOW).lerp(SUN_HIGH, THREE.MathUtils.smoothstep(sun.y, 0, .45));
    // The shadow camera follows the view, sized to what the camera can see.
    const target = this.controls.target;
    const half = THREE.MathUtils.clamp(this.camera.position.distanceTo(target) * 1.1, 20, 180);
    const shadow = this.sun.shadow.camera;
    if (shadow.right !== half) {
      shadow.left = shadow.bottom = -half;
      shadow.right = shadow.top = half;
      shadow.updateProjectionMatrix();
    }
    // Snap to shadow-map texels so shadows don't shimmer while panning.
    const texel = 2 * half / SHADOW_MAP;
    this.sun.target.position.set(Math.round(target.x / texel) * texel, target.y, Math.round(target.z / texel) * texel);
    this.sun.target.updateMatrixWorld();
    const up = Math.max(sun.y, .02);
    this.sun.position.set(sun.x, up, sun.z).normalize().multiplyScalar(220).add(this.sun.target.position);

    this.lampMaterial.color.setScalar(.4 + this.night * .6);
    this.beamMaterial.opacity = this.night * .55;
    this.starMaterial.uniforms.opacity!.value = THREE.MathUtils.smoothstep(this.night, .45, .95);
    this.stars.visible = this.night > .45;
    this.stars.position.copy(this.camera.position);
    this.stars.quaternion.setFromAxisAngle(skyAxis, skyAngle(minute));
  }

  /** Grows an instanced mesh to hold at least `count` instances, keeping its settings. */
  private ensure(mesh: THREE.InstancedMesh, count: number) {
    if (count <= mesh.instanceMatrix.count) return mesh;
    const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, Math.ceil(count * 1.25));
    grown.count = 0;
    grown.frustumCulled = false;
    grown.castShadow = mesh.castShadow;
    grown.receiveShadow = mesh.receiveShadow;
    grown.renderOrder = mesh.renderOrder;
    grown.customDepthMaterial = mesh.customDepthMaterial;
    grown.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.parent?.remove(mesh);
    mesh.dispose();
    this.detail.add(grown);
    return grown;
  }

  dispose() {
    for (const neighbour of this.neighbours.values()) neighbour.world.dispose();
    this.neighbours.clear();
    // Return a shared detail group to its own scene before releasing its assets.
    if (this.shared) this.scene.add(this.detail);
    this.regionRenderer.dispose();
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.pointerDown);
    canvas.removeEventListener("pointermove", this.pointerMove);
    canvas.removeEventListener("pointerup", this.pointerUp);
    canvas.removeEventListener("pointerleave", this.pointerLeave);
    canvas.removeEventListener("contextmenu", this.preventMenu);
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    window.removeEventListener("blur", this.clearKeys);
    if (!this.shared) {
      this.controls.removeEventListener("change", this.clampTarget);
      this.controls.dispose();
    }
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) object.geometry.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    this.materials.forEach(m => m.dispose());
    this.starMaterial.dispose();
    this.sun.shadow.dispose();
    if (!this.shared) {
      this.renderer.dispose();
      canvas.remove();
    }
  }

  private heightAt = (x: number, z: number) => this.city?.tiles[z * this.city.size + x]?.height ?? 0;

  /** One continuous sloped mesh: each tile is an 8-triangle fan around its centre. */
  private buildTerrain(city: CityState) {
    const size = city.size, n = 2 * size + 1;
    const surface = createSurface(size, this.heightAt, city.terrainEdges);
    this.surface = surface;
    const levels = surface.levels;
    const tileVertices = size * size * VERTICES_PER_TILE;
    const total = tileVertices + 4 * 2 * size * 6;
    const positions = new Float32Array(total * 3);
    let p = 0;
    const put = (i: number, j: number, y = groundY(levels[j * n + i]!)) => {
      positions[p++] = i / 2; positions[p++] = y; positions[p++] = j / 2;
    };
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        for (let k = 0; k < 8; k++) {
          const next = (k + 1) % 8;
          put(2 * x + 1, 2 * z + 1);
          put(2 * x + RING_I[next]!, 2 * z + RING_J[next]!);
          put(2 * x + RING_I[k]!, 2 * z + RING_J[k]!);
        }
      }
    }
    // Skirts close the map edges down to the seabed so the region reads as a solid slab.
    const last = n - 1;
    const edges: [number, number, number, number][] = [[0, 0, 1, 0], [0, last, 1, 0], [0, 0, 0, 1], [last, 0, 0, 1]];
    for (const [i0, j0, di, dj] of edges) {
      for (let s = 0; s < last; s++) {
        const ai = i0 + di * s, aj = j0 + dj * s, bi = ai + di, bj = aj + dj;
        put(ai, aj); put(bi, bj); put(bi, bj, COLUMN_BOTTOM);
        put(ai, aj); put(bi, bj, COLUMN_BOTTOM); put(ai, aj, COLUMN_BOTTOM);
      }
    }
    const colorsAttribute = new THREE.BufferAttribute(new Uint8Array(total * 3), 3, true);
    this.color.set("#6f5f4c");
    const skirt = this.color.toArray().map(v => Math.round(v * 255));
    for (let v = tileVertices; v < total; v++) colorsAttribute.array.set(skirt, v * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", colorsAttribute);
    geometry.computeVertexNormals();
    this.terrain.geometry.dispose();
    this.terrain.geometry = geometry;
  }

  private terrainColor(tile: Tile) {
    const c = this.color;
    switch (this.overlay) {
      case "desirability":
        return c.set("#647574");
      case "water":
        return c.set(tile.pipe ? "#20d6ed" : "#647574");
      case "elevation":
        ramp(elevationStops, tile.height, c);
        if (tile.height >= 0 && tile.height % 3 === 0) c.multiplyScalar(.82);
        return c;
      case "power":
        return tile.water ? ramp(terrainStops, tile.height, c) : c.set(tile.powered ? "#9bd58a" : "#c98c7c");
      case "access":
      case "zones":
        ramp(terrainStops, tile.height, c);
        return c.lerp(MUTED, .65);
      default:
        ramp(terrainStops, tile.height, c);
        return (tile.x + tile.z) % 2 ? c.multiplyScalar(.965) : c;
    }
  }

  /** Roads and zone lots are painted directly onto the terrain so they follow its slopes. */
  private paintTerrain(city: CityState) {
    const attribute = this.terrain.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (!attribute) return;
    const array = attribute.array as Uint8Array;
    city.tiles.forEach((tile, i) => {
      const c = tile.kind === "empty" ? this.terrainColor(tile) : this.lotColor(tile);
      const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
      for (let v = i * VERTICES_PER_TILE * 3, end = v + VERTICES_PER_TILE * 3; v < end; v += 3) {
        array[v] = r; array[v + 1] = g; array[v + 2] = b;
      }
    });
    attribute.needsUpdate = true;
  }

  private lotColor(tile: Tile) {
    const c = this.color.set(tile.kind === "road" ? roadType(tile).color : zoneColor(tile));
    if (this.overlay === "desirability") {
      const score = tile.desirability?.score;
      return c.set(score === undefined ? "#647574" : score < 40 ? "#d55948" : score < 50 ? "#eacb66" : score < 70 ? "#91bd75" : "#42bcaa");
    }
    if (this.overlay === "water") return c.set(tile.pipe ? "#20d6ed" : tile.kind === "waterworks" ?
      (tile.facility?.operating ? "#60ce8f" : "#d55948") : tile.waterService ?
      (tile.waterService.fraction >= .999 ? "#60ce8f" : tile.waterService.fraction > 0 ? "#eacb66" : "#d55948") : "#647574");
    if (this.overlay === "power") return c.set(tile.powered ? "#57b46d" : "#d0533f");
    if (this.overlay === "access") return c.set(tile.connected ? "#57b46d" : "#d0533f");
    if (this.overlay === "elevation") return c.lerp(WHITE, .35);
    if (this.overlay === "traffic") {
      return tile.kind === "road" ? ramp(trafficRamp, tile.traffic / roadType(tile).capacity, c) : c.lerp(PALE, .6);
    }
    if (this.overlay === "normal" && tile.kind !== "road") c.lerp(LOT_TINT, .45);
    if (tile.kind === "road" && this.junctions.has(tile.z * (this.city?.size ?? 0) + tile.x)) c.lerp(WHITE, .1);
    return c;
  }

  private buildDevelopment(city: CityState) {
    let buildings = 0;
    let cylinders = 0;
    let serviceRings = 0;
    const trees: Tree[] = [];
    const slots: number[] = [], ids: number[] = [], spills: number[] = [], spillOf: number[] = [];
    const windowPower: number[] = [];
    const rotorAngles = new Map<number, number>(this.windRotorPositions.map(rotor => [rotor.index, rotor.angle] as [number, number]));
    this.chimneys = [];
    this.windRotorPositions = [];
    const powerLines = visualPowerLines(city.tiles, city.powerLines ?? []);
    const models = city.tiles.map((tile, i) => {
      if (tile.kind === "powerline" && !powerLines.supports.has(i)) return null;
      const model = buildingModel(tile, city.seed);
      return model ? buildingModelLod(model, tile, this.lodAt(tile.x + .5, tile.z + .5)) : null;
    });
    const showsRadius = (tile: Tile) => {
      const selected = this.tool === "inspect" && this.selectedCell?.x === tile.x && this.selectedCell?.z === tile.z;
      if (selected) return tile.kind === "service" || tile.kind === "park" || tile.kind === "power" && ["c", "n"].includes(tile.variant);
      return this.overlay === "desirability" && (tile.kind === "service" || tile.kind === "park" ||
        tile.kind === "power" && ["c", "n"].includes(tile.variant) && (tile.installationPart ?? -1) === 0);
    };
    this.serviceRings = this.ensure(this.serviceRings, Math.max(1, city.tiles.filter(showsRadius).length));
    const required = models.reduce((sum, model) => sum + (model?.parts.filter(p => p.shape !== "cylinder").length ?? 0), 0);
    const roundRequired = models.reduce((sum, model) => sum + (model?.parts.filter(p => p.shape === "cylinder").length ?? 0), 0);
    this.buildings = this.ensure(this.buildings, required);
    this.cylinders = this.ensure(this.cylinders, roundRequired);
    this.panes = this.ensure(this.panes, models.reduce((sum, model) => sum + (model?.windows.length ?? 0), 0));
    const capacity = this.panes.instanceMatrix.count;
    if ((this.paneGeometry.getAttribute("glow")?.count ?? 0) < capacity)
      this.paneGeometry.setAttribute("glow", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
    let paneCount = 0;
    const uses: number[] = [];
    const walks: [number, number, number, number, number, number][] = [];  // edge centre x, z, direction, end extensions
    const surface = this.surface;
    const place = (mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: THREE.Color) => {
      this.dummy.position.set(x, y, z);
      this.dummy.scale.set(sx, sy, sz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(index, this.dummy.matrix);
      mesh.setColorAt(index, color);
    };
    for (const [i, tile] of city.tiles.entries()) {
      const ground = groundY(tile.height), cx = tile.x + .5, cz = tile.z + .5;
      if (tile.kind === "empty") {
        if (!tile.water) {
          const start = trees.length, ox = city.district[0] * city.size, oz = city.district[1] * city.size;
          wildTrees(tile.x + ox, tile.z + oz, tile.height, trees);
          for (let j = start; j < trees.length; j++) { trees[j]!.x -= ox; trees[j]!.z -= oz; }
        }
        continue;
      }
      const facilityHeights = tile.facility?.footprint.map(([x, z]) => surfaceY(city.tiles[z * city.size + x]!.height));
      const base = facilityHeights ? Math.max(...facilityHeights) : ground;
      const bottom = (facilityHeights ? Math.min(...facilityHeights) : ground) - FOUNDATION;
      if (showsRadius(tile)) {
        const service = subtype(tile);
        let radius = 2, ringX = cx, ringZ = cz;
        if (tile.kind === "service") {
          radius = service === "f" ? 12 : 10;
          this.color.set(service === "f" ? "#e2bc4f" : service === "p" ? "#5d8fd4" : "#65ad72");
        } else if (tile.kind === "power") {
          radius = tile.variant === "n" ? 20 : 12;
          if (tile.variant === "n") {
            const part = Math.max(0, tile.installationPart ?? 0);
            ringX = tile.x - part % 4 + 2; ringZ = tile.z - Math.floor(part / 4) + 2;
          } else if ((tile.installationPart ?? -1) >= 0) {
            const part = tile.installationPart!;
            ringX = tile.x - part % 2 + 1; ringZ = tile.z - Math.floor(part / 2) + 1;
          }
          this.color.set(tile.variant === "n" ? "#d85d70" : "#9d6048");
        } else {
          this.color.set("#76bd69");
        }
        place(this.serviceRings, serviceRings++, ringX, ground + .035, ringZ, radius, 1, radius, this.color);
      }
      if (tile.kind === "park" || (tile.kind !== "powerline" && models[i])) {
        for (let side = 0; side < 4; side++) {
          const sx = [0, 1, 0, -1][side]!, sz = [-1, 0, 1, 0][side]!;
          if (city.tiles[(tile.z + sz) * city.size + tile.x + sx]?.kind !== "road" ||
            tile.x + sx < 0 || tile.x + sx >= city.size) continue;
          const ax = Math.abs(sz), az = Math.abs(sx), road = (dx: number, dz: number) => {
            const nx = tile.x + dx, nz = tile.z + dz;
            return nx >= 0 && nz >= 0 && nx < city.size && nz < city.size && city.tiles[nz * city.size + nx]?.kind === "road";
          };
          // Where the pavement meets a side road, run it on to the far kerb so the two strips meet at the corner.
          walks.push([cx + sx * SIDEWALK_OUT, cz + sz * SIDEWALK_OUT, ax, az,
            road(-ax, -az) ? CORNER : 0, road(ax, az) ? CORNER : 0]);
        }
      }
      if (tile.kind === "park") {
        parkTrees(tile.x, tile.z, trees);
      } else {
        const model = models[i];
        if (!model) continue;
        const decay = tile.kind === "residential" || tile.kind === "power" || tile.kind === "powerline" ? 0 : (100 - tile.condition) / 100;
        if (tile.kind === "power" && tile.variant === "w")
          this.windRotorPositions.push({ index: i, x: cx + WIND_ROTOR.x, y: base + WIND_ROTOR.y, z: cz + WIND_ROTOR.z, angle: rotorAngles.get(i) ?? 0 });
        // Every pane is drawn as glass; the ones with people behind them may also light up.
        const staffed = tile.kind === "residential" || tile.kind === "power" || tile.workers > 0;
        for (const pane of model.windows) {
          const across = pane.face % 2 ? .008 : pane.width, deep = pane.face % 2 ? pane.width : .008;
          this.color.copy(PANE_COLORS[pane.use]);
          if (this.overlay !== "normal") this.color.lerp(PALE, .55);
          place(this.panes, paneCount++, cx + pane.x, base + pane.y, cz + pane.z, across, pane.height, deep, this.color);
          if (pane.use === "boarded" || (pane.use !== "home" && !staffed)) continue;
          slots.push(paneCount - 1);
          ids.push(i * ROOMS + pane.room);
          uses.push(USES.indexOf(pane.use));
          windowPower.push(tile.powered ? 1 : 0);
          // Street-level venue rooms and low signs light the pavement in front of them.
          if ((pane.use === "venue" && pane.y < .25) || (pane.use === "neon" && pane.y < .9)) {
            const dx = FACE_X[pane.face]!, dz = FACE_Z[pane.face]!, px = cx + pane.x, pz = cz + pane.z;
            const wide = Math.max(.1, pane.width) + .02, reach = Math.min(.6, .4 + pane.y * .3);
            const y = Math.max(base, surface?.groundAt(px + dx * .3, pz + dz * .3) ?? base) + .03;
            spills.push(dx * reach, 0, dz * reach, 0, 0, 1, 0, 0, -dz * wide, 0, dx * wide, 0, px, y, pz, 1);
            spillOf.push(slots.length - 1);
          }
        }
        for (const stack of model.chimneys) {
          if (!stack.always && !(tile.kind === "industrial" && tile.workers > 0)) continue;
          if (tile.kind === "power" && (tile.variant === "" || tile.variant === "c" || tile.variant === "n") && !tile.powered) continue;
          const r = hash(tile.x, tile.z, 9);
          this.chimneys.push({ x: cx + stack.x, y: base + stack.top, z: cz + stack.z, width: stack.width, steam: !!stack.steam,
            start: stack.always ? 0 : 330 + r * 60, end: stack.always ? DAY : 1080 + hash(tile.x, tile.z, 10) * 120,
            phase: hash(tile.x + stack.x * 7, tile.z + stack.z * 5, 11) });
        }
        for (const part of model.parts) {
          this.color.set(part.color).lerp(MUTED, decay * .75).multiplyScalar(1 - decay * .3);
          if (this.overlay !== "normal") this.color.lerp(PALE, .55);
          const low = part.bottom === 0 ? bottom : base + part.bottom;
          const top = base + part.bottom + part.height;
          const mesh = part.shape === "cylinder" ? this.cylinders : this.buildings;
          const index = part.shape === "cylinder" ? cylinders++ : buildings++;
          place(mesh, index, cx + part.x, (low + top) / 2, cz + part.z,
            part.width, top - low, part.depth, this.color);
        }
      }
    }
    this.buildings.count = buildings;
    this.buildings.instanceMatrix.needsUpdate = true;
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;
    this.cylinders.count = cylinders;
    this.cylinders.instanceMatrix.needsUpdate = true;
    if (this.cylinders.instanceColor) this.cylinders.instanceColor.needsUpdate = true;
    this.serviceRings.count = serviceRings;
    this.serviceRings.instanceMatrix.needsUpdate = true;
    if (this.serviceRings.instanceColor) this.serviceRings.instanceColor.needsUpdate = true;
    this.panes.count = paneCount;
    this.panes.instanceMatrix.needsUpdate = true;
    if (this.panes.instanceColor) this.panes.instanceColor.needsUpdate = true;
    this.layWalks(walks);
    this.plant(trees);
    this.windowSlots = Uint32Array.from(slots);
    this.windowPower = Uint8Array.from(windowPower);
    this.spillWindows = Uint32Array.from(spillOf);
    this.spills = this.ensure(this.spills, spillOf.length);
    (this.spills.instanceMatrix.array as Float32Array).set(spills);
    this.spills.instanceMatrix.needsUpdate = true;
    const spillCapacity = this.spills.instanceMatrix.count;
    if ((this.spills.instanceColor?.count ?? 0) < spillCapacity)
      this.spills.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spillCapacity * 3), 3);
    this.windowIds = Uint32Array.from(ids);
    this.windowUses = Uint8Array.from(uses);
    this.windowStep = -1;
    this.smoke = this.ensure(this.smoke, this.chimneys.length * PUFFS);
    this.placeWindRotors();
    this.buildPowerWires(city, powerLines.spans);
  }

  /** Distance from the shared camera to a point in this district's local
   * coordinates. Neighbour worlds have their detail group translated into the
   * focused world's scene, so include that translation before measuring. */
  private lodAt(x: number, z: number): BuildingLod {
    const dx = x + this.detail.position.x - this.camera.position.x;
    const dz = z + this.detail.position.z - this.camera.position.z;
    return distanceLod(Math.hypot(dx, this.camera.position.y, dz), this.lodDistanceScale);
  }

  private placeWindRotors() {
    this.windRotors = this.ensure(this.windRotors, this.windRotorPositions.length);
    this.windRotors.count = this.windRotorPositions.length;
    this.windRotorPositions.forEach((rotor, i) => {
      this.dummy.position.set(rotor.x, rotor.y, rotor.z);
      this.dummy.rotation.set(rotor.angle, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.windRotors.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.rotation.set(0, 0, 0);
    this.windRotors.instanceMatrix.needsUpdate = true;
  }

  private buildPowerWires(city: CityState, visualSpans: readonly (readonly [number, number])[]) {
    const key = `${city.session}:${city.district}:${city.size}:${city.terrainRevision}:${(city.powerLines ?? []).map(([a, b]) => `${a}-${b}`).join(",")}`;
    if (key === this.powerWireKey) return;
    this.powerWireKey = key;
    const spans: THREE.BufferGeometry[] = [];
    for (const [from, to] of visualSpans) {
      const a = city.tiles[from], b = city.tiles[to];
      if (!a || !b) continue;
      const start = new THREE.Vector3(a.x + .5, groundY(a.height) + POWER_WIRE_HEIGHT, a.z + .5);
      const end = new THREE.Vector3(b.x + .5, groundY(b.height) + POWER_WIRE_HEIGHT, b.z + .5);
      const distance = Math.hypot(end.x - start.x, end.z - start.z);
      const y = powerWireControlY(start.y, end.y, distance, t => {
        const x = THREE.MathUtils.lerp(start.x, end.x, t), z = THREE.MathUtils.lerp(start.z, end.z, t);
        return Math.max(WATER_Y, this.surface?.groundAt(x, z) ?? WATER_Y);
      });
      const control = new THREE.Vector3((start.x + end.x) / 2,
        y, (start.z + end.z) / 2);
      const curve = new THREE.QuadraticBezierCurve3(start, control, end);
      spans.push(new THREE.TubeGeometry(curve, Math.max(8, Math.ceil(distance * 4)), .007, 5, false));
    }
    const merged = spans.length ? mergeGeometries(spans, false) : null;
    spans.forEach(geometry => geometry.dispose());
    this.powerWires.geometry.dispose();
    this.powerWires.geometry = merged ?? new THREE.BufferGeometry();
    this.powerWires.visible = !!merged;
  }

  /**
   * Pavement along each lot edge that faces a road, laid on the road's outer verge (clear of the
   * lanes) and over the lot boundary. Each edge is two slabs, as the ground bends at the edge midpoint.
   */
  private layWalks(walks: [number, number, number, number, number, number][]) {
    const surface = this.surface;
    if (!surface) return;
    this.sidewalks = this.ensure(this.sidewalks, walks.length * 2);
    const dummy = this.dummy, target = new THREE.Vector3(), half = SIDEWALK_WIDTH / 2;
    this.color.set(SIDEWALK);
    if (this.overlay !== "normal") this.color.lerp(PALE, .55);
    let n = 0;
    for (const [x, z, ax, az, before, after] of walks) {
      for (const [from, to] of [[-.5 - before, 0], [0, .5 + after]] as const) {
        const x0 = x + ax * from, z0 = z + az * from, x1 = x + ax * to, z1 = z + az * to, length = to - from;
        // Sample both kerbs at each end, so the slab covers the ground on cross-slopes too.
        const ends = [[x0, z0], [x1, z1]].map(([px, pz]) => {
          const a = surface.groundAt(px! - az * half, pz! - ax * half), b = surface.groundAt(px! + az * half, pz! + ax * half);
          return [Math.min(a, b) - .01, Math.max(a, b) + .022];
        });
        const low = (ends[0]![0]! + ends[1]![0]!) / 2, high = (ends[0]![1]! + ends[1]![1]!) / 2;
        const rise = ends[1]![1]! - ends[0]![1]!, mid = (low + high) / 2;
        dummy.position.set((x0 + x1) / 2, mid, (z0 + z1) / 2);
        dummy.scale.set(SIDEWALK_WIDTH, high - low, Math.hypot(length, rise));
        dummy.lookAt(target.set(x1, mid + rise / 2, z1));
        dummy.updateMatrix();
        this.sidewalks.setMatrixAt(n, dummy.matrix);
        this.sidewalks.setColorAt(n++, this.color);
      }
    }
    dummy.rotation.set(0, 0, 0);
    this.sidewalks.count = n;
    this.sidewalks.instanceMatrix.needsUpdate = true;
    if (this.sidewalks.instanceColor) this.sidewalks.instanceColor.needsUpdate = true;
  }

  /** Homes, offices, shops and venues light a changing selection of rooms, each on its own schedule. */
  private lightWindows(clock: number) {
    const step = Math.floor(clock / 2);
    if (step === this.windowStep) return;
    this.windowStep = step;
    const ids = this.windowIds, uses = this.windowUses, slots = this.windowSlots;
    const attribute = this.paneGeometry.getAttribute("glow") as THREE.InstancedBufferAttribute;
    const out = attribute.array as Float32Array;
    out.fill(0);
    const day = Math.floor(clock / DAY), minute = ((clock % DAY) + DAY) % DAY;
    // Lit glass barely shows by day; neon is bright enough to show from dusk.
    const glow = Math.min(1, this.night * 1.4), neonGlow = Math.min(1, .35 + this.night * 1.4);
    const cycle = Math.floor(clock / NEON_CYCLE);
    for (let i = 0; i < ids.length; i++) {
      if (!this.windowPower[i]) continue;
      const use = USES[uses[i]!]!, id = ids[i]!;
      if (!windowLit(id, day, minute, use)) continue;
      const tint = Math.imul(id, 0x9e3779b1) >>> 7;
      if (use === "neon") {
        // A third of the tubes chase through the palette; the rest hold one colour.
        const shift = tint % 3 === 0 ? cycle + (id & 3) : 0;
        this.color.copy(NEON_GLOW[(tint + shift) % NEON_GLOW.length]!).multiplyScalar(neonGlow);
      } else {
        this.color.copy(use === "venue" ? VENUE_GLOW[tint % VENUE_GLOW.length]! : WINDOW_GLOW).multiplyScalar(glow);
      }
      this.color.toArray(out, slots[i]! * 3);
    }
    attribute.needsUpdate = true;
    // Pavement spills carry their sign's current colour, only once it is dark enough to see them.
    const spill = Math.min(1, this.night * 1.6) * .55, tints = this.spills.instanceColor;
    this.spills.count = spill > .05 && tints ? this.spillWindows.length : 0;
    if (this.spills.count && tints) {
      const colors = tints.array as Float32Array;
      this.spillWindows.forEach((window, i) => {
        const from = slots[window]! * 3;
        for (let k = 0; k < 3; k++) colors[i * 3 + k] = out[from + k]! * spill;
      });
      tints.needsUpdate = true;
    }
  }

  /** Staffed factories send smoke downwind through the working day; puffs grow, lighten and fade. */
  private puff(clock: number) {
    const mesh = this.smoke, matrix = mesh.instanceMatrix.array as Float32Array;
    let n = 0;
    for (const stack of this.chimneys) {
      for (let k = 0; k < PUFFS; k++) {
        const age = ((clock / PUFF_LIFE + k / PUFFS + stack.phase) % 1 + 1) % 1;
        const born = (((clock - age * PUFF_LIFE) % DAY) + DAY) % DAY;
        if (born < stack.start || born > stack.end) continue;
        const size = (stack.width * 1.1 + age * (stack.steam ? .9 : .5)) * (age > .75 ? (1 - age) / .25 : 1);
        const sway = Math.sin((clock / PUFF_LIFE + k) * 1.7) * .08 * age;
        const o = n * 16;
        matrix.fill(0, o, o + 16);
        matrix[o] = matrix[o + 5] = matrix[o + 10] = size;
        matrix[o + 12] = stack.x + WIND_X * age * 1.6 + sway;
        matrix[o + 13] = stack.y + age * (stack.steam ? 1.6 : 1.2);
        matrix[o + 14] = stack.z + WIND_Z * age * 1.6 - sway;
        matrix[o + 15] = 1;
        mesh.setColorAt(n++, stack.steam ? this.color.copy(STEAM)
          : this.color.copy(SMOKE_DARK).lerp(SMOKE_LIGHT, Math.min(1, age * 1.6)));
      }

    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private spinWindRotors(seconds: number) {
    const wind = THREE.MathUtils.clamp(this.city?.powerWind ?? .5, 0, 1);
    for (const [i, rotor] of this.windRotorPositions.entries()) {
      rotor.angle += seconds * (.15 + wind * 2.5);
      this.dummy.position.set(rotor.x, rotor.y, rotor.z);
      this.dummy.rotation.set(rotor.angle, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.windRotors.setMatrixAt(i, this.dummy.matrix);
    }
    if (this.windRotorPositions.length) this.windRotors.instanceMatrix.needsUpdate = true;
    this.dummy.rotation.set(0, 0, 0);
  }

  /** Trees are distributed among full, simplified and low-poly instance pools
   * independently, based on their true distance from the camera. */
  private plant(trees: Tree[]) {
    const surface = this.surface, dummy = this.dummy, tint = this.overlay === "normal" ? 0 : .45;
    const counts = Array.from({ length: 3 }, () => new Array<number>(CROWN_COUNT).fill(0));
    for (const tree of trees) counts[this.lodAt(tree.x, tree.z)]![tree.crown]!++;
    for (let lod = 0; lod < 3; lod++) for (let c = 0; c < CROWN_COUNT; c++) {
      this.crowns[lod]![c] = this.ensure(this.crowns[lod]![c]!, counts[lod]![c]!);
      this.crowns[lod]![c]!.count = 0;
    }
    for (let lod = 0; lod < 2; lod++) {
      this.trunks[lod] = this.ensure(this.trunks[lod]!, trees.length);
      this.trunks[lod]!.count = 0;
    }
    for (const tree of trees) {
      const lod = this.lodAt(tree.x, tree.z);
      const ground = (surface?.groundAt(tree.x, tree.z) ?? 0) - .03;
      const mesh = this.crowns[lod]![tree.crown]!;
      dummy.position.set(tree.x, ground + tree.crownBase, tree.z);
      dummy.rotation.set(0, tree.yaw, 0);
      dummy.scale.set(tree.width, tree.height - tree.crownBase, tree.width);
      dummy.updateMatrix();
      mesh.setMatrixAt(mesh.count, dummy.matrix);
      mesh.setColorAt(mesh.count++, this.color.set(tree.color).lerp(PALE, tint));
      if (tree.crownBase <= 0 || lod === 2) continue;
      const girth = .05 + tree.width * .06;
      dummy.position.set(tree.x, ground - .05, tree.z);
      dummy.scale.set(girth, tree.crownBase + (tree.height - tree.crownBase) * .3 + .05, girth);
      dummy.updateMatrix();
      const trunk = this.trunks[lod]!;
      trunk.setMatrixAt(trunk.count, dummy.matrix);
      trunk.setColorAt(trunk.count++, this.color.set(tree.bark));
    }
    dummy.rotation.set(0, 0, 0);
    for (const mesh of [...this.crowns.flat(), ...this.trunks]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private pick(event: PointerEvent): Cell | null {
    if (!this.detailed) return null;
    if (!this.surface) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return pickCell(this.raycaster.ray, this.surface);
  }

  private cellsFor(a: Cell, b: Cell): Cell[] {
    if (this.tool === "road" || this.tool === "powerline" || this.tool === "pipe" || this.tool === "remove_pipe") return roadLine(a, b);
    if (this.tool === "power" || this.tool === "waterworks") return [b];
    return this.tool === "level" ? levelRectangle(a, b) : rectangle(a, b);
  }

  private refreshPreview() {
    let cells = this.anchor ? this.stroke : this.hovered ? [this.hovered] : [];
    let entrance: Cell | null = null;
    let invalidFacility = false;
    if (this.tool === "waterworks" && cells.length) {
      const layout = facilityLayout(cells[cells.length - 1]!, this.facilityVariant, this.facilityRotation);
      cells = layout.cells;
      entrance = layout.entrance;
      if (this.city) {
        const city = this.city;
        const footprint = cells.map(c => c.x > 0 && c.z > 0 && c.x < city.size - 1 && c.z < city.size - 1 ? city.tiles[c.z * city.size + c.x] : undefined);
        invalidFacility = footprint.some(t => !t || t.water || t.kind !== "empty") ||
          Math.max(...footprint.map(t => t?.height ?? 0)) - Math.min(...footprint.map(t => t?.height ?? 0)) > 1;
      }
      cells = [...cells, entrance];
    } else if (this.tool === "power" && ["c", "n"].includes(this.powerVariant) && cells.length) {
      const anchor = cells[cells.length - 1]!;
      const size = this.powerVariant === "n" ? 4 : 2;
      cells = Array.from({ length: size * size }, (_, i) => ({ x: anchor.x + i % size, z: anchor.z + Math.floor(i / size) }));
      if (this.city) invalidFacility = cells.some(c => c.x < 0 || c.z < 0 || c.x >= this.city!.size || c.z >= this.city!.size ||
        this.city!.tiles[c.z * this.city!.size + c.x]?.kind !== "empty" || this.city!.tiles[c.z * this.city!.size + c.x]?.water);
    }
    const city = this.city;
    let count = 0;
    if (city) {
      for (const cell of cells) {
        if (cell.x < 0 || cell.z < 0 || cell.x >= city.size || cell.z >= city.size) continue;
        const tile = city.tiles[cell.z * city.size + cell.x];
        if (!tile) continue;
        const terraform = this.tool === "raise" || this.tool === "lower" || this.tool === "level";
        const isEntrance = entrance === cell;
        const blocked = tile.water && !terraform && this.tool !== "inspect" ||
          (this.tool === "waterworks" && !isEntrance || this.tool === "power" && ["c", "n"].includes(this.powerVariant)) && invalidFacility;
        this.color.set(isEntrance ? (tile.kind === "road" ? "#8af595" : "#f0dc80") : blocked ? "#e0523d" : previewColors[this.tool] ?? colors[this.tool as keyof typeof colors] ?? "#ffffff");
        // Tall enough to stay visible above the uphill edge of a sloped tile.
        this.dummy.position.set(cell.x + .5, surfaceY(tile.height) + .08, cell.z + .5);
        this.dummy.scale.set(this.tool === "inspect" ? 1.02 : .94, LEVEL_HEIGHT + .1, this.tool === "inspect" ? 1.02 : .94);
        this.dummy.updateMatrix();
        this.preview.setMatrixAt(count, this.dummy.matrix);
        this.preview.setColorAt(count++, this.color);
      }
    }
    this.preview.count = count;
    this.preview.instanceMatrix.needsUpdate = true;
    if (this.preview.instanceColor) this.preview.instanceColor.needsUpdate = true;
  }

  private placeSelection(cell: Cell | null) {
    this.selectedCell = cell;
    if (!cell || !this.city || this.showcase) { this.selection.visible = false; return; }
    const tile = this.city.tiles[cell.z * this.city.size + cell.x];
    this.selection.position.set(cell.x + .5, surfaceY(tile?.height ?? 0) + .25, cell.z + .5);
    this.selection.visible = true;
    if (this.detailed) this.buildDevelopment(this.city);
  }

  private readonly pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) { this.cancel(); return; }
    if (event.button !== 0 || !this.enabled || this.showcase) return;
    const cell = this.pick(event);
    if (!cell) return;
    if (this.tool === "inspect") {
      this.placeSelection(cell);
      this.onSelect(cell);
      return;
    }
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.anchor = cell;
    this.stroke = this.cellsFor(cell, cell);
    this.refreshPreview();
  };

  private readonly pointerMove = (event: PointerEvent) => {
    if (!event.isPrimary || this.showcase) return;
    const cell = this.pick(event);
    if (cell?.x !== this.hovered?.x || cell?.z !== this.hovered?.z) {
      this.hovered = cell;
      this.onHover(cell);
      if (this.anchor && cell) this.stroke = this.cellsFor(this.anchor, cell);
      this.refreshPreview();
    }
  };

  private readonly pointerUp = (event: PointerEvent) => {
    if (!event.isPrimary || !this.anchor) return;
    const cells = this.stroke;
    this.cancel();
    if (cells.length && this.enabled) this.onStroke(cells);
  };

  private readonly pointerLeave = () => {
    if (this.anchor) return;
    this.hovered = null;
    this.onHover(null);
    this.refreshPreview();
  };

  private readonly preventMenu = (event: Event) => event.preventDefault();

  private cancel() {
    this.anchor = null;
    this.stroke = [];
    this.refreshPreview();
  }

  private readonly keyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (event.key === "Escape") { this.cancel(); return; }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
      this.keys.add(key);
      event.preventDefault();
    }
  };

  private readonly keyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  };

  private readonly clearKeys = () => this.keys.clear();

  private groundInView(x: number, z: number): number | null {
    const size = this.city?.size ?? 100;
    if (!this.detailDirty && this.surface && x >= 0 && z >= 0 && x <= size && z <= size)
      return Math.max(WATER_Y, this.surface.groundAt(x, z));
    for (const { world } of this.neighbours.values()) {
      const lx = x - world.detail.position.x, lz = z - world.detail.position.z;
      if (world.surface && lx >= 0 && lz >= 0 && lx <= size && lz <= size)
        return Math.max(WATER_Y, world.surface.groundAt(lx, lz));
    }
    return null;
  }

  private readonly clampTarget = () => {
    const target = this.controls.target;
    const [cx, cz] = this.city?.district ?? [0, 0];
    const size = this.city?.size ?? 100;
    const clamped = new THREE.Vector3(THREE.MathUtils.clamp(target.x, -1999000 - cx * size, 1999000 - cx * size),
      this.groundInView(target.x, target.z) ?? target.y, THREE.MathUtils.clamp(target.z, -1999000 - cz * size, 1999000 - cz * size));
    const shift = clamped.sub(target);
    if (shift.lengthSq() > 1e-8) {
      target.add(shift);
      this.camera.position.add(shift);
    }
    const ground = this.groundInView(this.camera.position.x, this.camera.position.z);
    if (ground !== null && this.camera.position.y < ground + 1) {
      this.camera.position.y = ground + 1;
      this.camera.lookAt(target);
    }
  };

  private panWithKeys(seconds: number) {
    if (!this.keys.size) return;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    if (this.keys.has("w") || this.keys.has("ArrowUp")) move.add(forward);
    if (this.keys.has("s") || this.keys.has("ArrowDown")) move.sub(forward);
    if (this.keys.has("d") || this.keys.has("ArrowRight")) move.add(right);
    if (this.keys.has("a") || this.keys.has("ArrowLeft")) move.sub(right);
    if (!move.lengthSq()) return;
    const speed = this.camera.position.distanceTo(this.controls.target) * .9;
    move.normalize().multiplyScalar(speed * seconds);
    this.controls.target.add(move);
    this.camera.position.add(move);
    this.clampTarget();
  }

  private fit() {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Showcase mode: the camera circles the current view centre once every 12 game hours, slowly
   * rising and falling (dipping toward the horizon at night to show the stars) and zooming in and out.
   */
  setShowcase(on: boolean) {
    if (on === !!this.showcase) return;
    if (on) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      // Start each oscillation at the phase matching the current view, so the tour begins where you are.
      const phase = (value: number, low: number, high: number, period: number) =>
        Math.acos(1 - 2 * THREE.MathUtils.clamp((value - low) / (high - low), 0, 1)) / (Math.PI * 2) * period;
      // Zoom breathes around the starting distance, so a wide shot stays wide and a close-up stays close.
      const near = Math.max(8, spherical.radius * TOUR.near), far = Math.min(330, spherical.radius * TOUR.far);
      this.showcase = {
        angle: spherical.theta, clock: this.clock(), polar: spherical.phi, distance: spherical.radius, near, far,
        polarPhase: phase(spherical.phi, TOUR.polar[0], TOUR.polar[1], TOUR.polarPeriod),
        zoomPhase: phase(spherical.radius, far, near, TOUR.zoomPeriod), progress: 0,
      };
      this.selection.visible = false;
      this.cancel();
    } else {
      this.showcase = null;
    }
    this.controls.enabled = !on;
  }

  private tour(clock: number, seconds: number) {
    const show = this.showcase!;
    // Game time drives the orbit, capped at the Day speed so faster speeds don't spin the view.
    const step = THREE.MathUtils.clamp(clock - show.clock, 0, CLOCK_MINUTES_PER_SECOND * seconds * 1.5);
    show.clock = clock;
    show.angle += step / 720 * Math.PI * 2;
    show.progress += step;
    const wave = (offset: number, period: number) => .5 - .5 * Math.cos((show.progress + offset) / period * Math.PI * 2);
    const polar = THREE.MathUtils.lerp(THREE.MathUtils.lerp(TOUR.polar[0], TOUR.polar[1], wave(show.polarPhase, TOUR.polarPeriod)),
      1.33, this.night * .7);
    const distance = THREE.MathUtils.lerp(show.far, show.near, wave(show.zoomPhase, TOUR.zoomPeriod));
    // Ease toward the targets so entering the tour, and nightfall tilting toward the stars, never jump.
    const ease = 1 - Math.exp(-seconds * .8);
    show.polar += (polar - show.polar) * ease;
    show.distance += (distance - show.distance) * ease;
    const target = this.controls.target;
    this.camera.position.setFromSphericalCoords(show.distance, show.polar, show.angle).add(target);
    this.camera.lookAt(target);
  }

  /** Re-bin instances after meaningful camera movement. Rebuilding is throttled
   * because the LOD bands are deliberately broad and do not need frame-level
   * updates while the camera is moving. */
  private refreshDistanceLods(now: number, force = false) {
    if (this.shared || !this.detailed || !this.city) return;
    if (!force && (now - this.lodRefreshedAt < 900 || this.lodCamera.distanceToSquared(this.camera.position) < 100)) return;
    this.lodRefreshedAt = now;
    this.lodCamera.copy(this.camera.position);
    this.buildDevelopment(this.city);
    for (const { world } of this.neighbours.values()) {
      world.lodDistanceScale = this.lodDistanceScale;
      if (world.city && world.detailed) world.buildDevelopment(world.city);
    }
  }

  /** Contract LOD radii only after five continuous seconds materially below
   * 60 FPS. Sustained headroom extends them up to a safe cap just inside the
   * detailed-district cutoff. A small dead band avoids reacting to 59.x Hz
   * browser timing as if it were a performance problem. */
  private adaptLodDistances(fps: number, elapsedMs: number, now: number) {
    if (this.shared || document.visibilityState !== "visible" || fps <= 0) {
      this.lowFpsFor = this.highFpsFor = 0;
      return;
    }
    if (fps < 58) {
      this.lowFpsFor += elapsedMs / 1000;
      this.highFpsFor = 0;
    } else if (fps >= 59.5) {
      this.highFpsFor += elapsedMs / 1000;
      this.lowFpsFor = 0;
    } else {
      this.lowFpsFor = this.highFpsFor = 0;
    }
    if (this.lowFpsFor >= 5 && now - this.lodAdjustedAt >= 5000 && this.lodDistanceScale > .35) {
      this.lodDistanceScale = Math.max(.35, this.lodDistanceScale * .82);
      this.lowFpsFor = 0;
      this.lodAdjustedAt = now;
      this.refreshDistanceLods(now, true);
    } else if (this.highFpsFor >= 10 && now - this.lodAdjustedAt >= 10000 && this.lodDistanceScale < 1.35) {
      this.lodDistanceScale = Math.min(1.35, this.lodDistanceScale * 1.08);
      this.highFpsFor = 0;
      this.lodAdjustedAt = now;
      this.refreshDistanceLods(now, true);
    }
  }

  /** Progressively add coarse, terrain-only region rings when there is sustained
   * headroom. This is deliberately independent of building LOD adaptation. */
  private adaptTerrainShell(fps: number, elapsedMs: number, now: number) {
    if (this.shared || document.visibilityState !== "visible" || fps <= 0) {
      this.lowTerrainFpsFor = this.highTerrainFpsFor = 0;
      return;
    }
    if (fps < 45) {
      this.lowTerrainFpsFor += elapsedMs / 1000;
      this.highTerrainFpsFor = 0;
    } else if (fps >= 52) {
      this.highTerrainFpsFor += elapsedMs / 1000;
      this.lowTerrainFpsFor = 0;
    } else {
      this.lowTerrainFpsFor = this.highTerrainFpsFor = 0;
    }
    if (this.terrainShell > 0 && this.lowTerrainFpsFor >= 4 && now - this.terrainShellAdjustedAt >= 4000) {
      this.terrainShell -= 1;
      this.lowTerrainFpsFor = 0;
      this.terrainShellAdjustedAt = now;
    } else if (this.terrainShell < 3 && this.highTerrainFpsFor >= 4 && now - this.terrainShellAdjustedAt >= 4000) {
      this.terrainShell += 1;
      this.highTerrainFpsFor = 0;
      this.terrainShellAdjustedAt = now;
    }
  }

  private readonly animate = (now: number) => {
    this.frame = requestAnimationFrame(this.animate);
    this.reportedFrames += 1;
    const seconds = Math.min(.1, (now - this.last) / 1000);
    this.last = now;
    this.swayTime.value = now / 1000;
    this.panWithKeys(seconds);
    const clock = this.clock();
    if (this.showcase) this.tour(clock, seconds);
    else this.controls.update();
    this.clampTarget();
    updateCityCameraDepth(this.camera, this.controls.target);
    const distance = this.camera.position.distanceTo(this.controls.target);
    const detailed = this.regionView === null || distance < (this.detailed ? 300 : 260);
    if (detailed !== this.detailed) {
      this.detailed = detailed; this.detail.visible = detailed;
      if (detailed && this.detailDirty && this.city) this.update(this.city);
      if (!detailed) this.cancel();
      this.refreshNeighbours();
    }
    this.refreshDistanceLods(now);
    const minute = ((clock % DAY) + DAY) % DAY;
    this.light(minute);
    if (this.detailed) {
      this.lightWindows(clock);
      this.puff(clock);
      this.spinWindRotors(seconds);
      for (const { world } of this.neighbours.values()) {
        world.swayTime.value = this.swayTime.value;
        world.night = this.night;
        world.lightWindows(clock);
        world.puff(clock);
        world.spinWindRotors(seconds);
      }
    }
    const active = this.drive(clock);
    if (now - this.reported > 500) {
      const elapsed = now - this.reported;
      const fps = this.reported ? this.reportedFrames * 1000 / elapsed : 0;
      this.reported = now;
      this.reportedFrames = 0;
      this.adaptLodDistances(fps, elapsed, now);
      this.adaptTerrainShell(fps, elapsed, now);
      this.onTick?.(active, clock, this.sim?.stats().queued ?? 0, this.sim?.fleet.peoplePerCar ?? 1, fps);
    }
    this.renderer.render(this.scene, this.camera);
  };
}
