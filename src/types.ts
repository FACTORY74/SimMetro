export type Zone = "residential" | "commercial" | "industrial";
export type Kind = Zone | "empty" | "road" | "power" | "park" | "powerline" | "waterworks" | "service";
export type Tool = Exclude<Kind, "empty"> | "bulldoze" | "inspect" | "terrain" | "raise" | "lower" | "level" | "pipe" | "remove_pipe";
export type Overlay = "normal" | "power" | "access" | "zones" | "elevation" | "traffic" | "water" | "desirability";
export type Speed = 0 | "day" | 1 | 3;
export interface Cell { x: number; z: number }
export interface Tile extends Cell {
  height: number;
  water: boolean;
  kind: Kind;
  /** Subtype code within the kind (see `variants`), or "" for kinds without subtypes. */
  variant: string;
  level: number;
  powered: boolean;
  connected: boolean;
  workers: number;
  residents: number;
  condition: number;
  traffic: number;
  powerDemand: number;
  powerSupply: number;
  powerGrid: number | null;
  batteryCharge: number;
  installationPart?: number;
  facility?: WaterFacility;
  pipe?: boolean;
  waterService?: WaterService;
  desirability?: DesirabilityLot;
}
export interface PowerSummary {
  demand: number; generation: number; served: number; unserved: number;
  charging: number; discharging: number; solar: number; wind: number;
  coal: number; nuclear: number; capacity: number;
  storage: number; storageCapacity: number; grids: number; energizedGrids: number; windFactor: number;
}
export interface PowerHistory {
  month: number; population: number; money: number;
  powerDemand?: number; powerPeak?: number; powerCapacity?: number;
}
export interface PowerData {
  clock: number;
  summary: PowerSummary;
  daily: { minute: number; demand: number; generation: number }[];
  recent: (PowerSummary & { time: number })[];
  history: PowerHistory[];
  lineSpan: number;
  stepMinutes: number;
}
export interface WaterService { requested: number; served: number; fraction: number; network: number | null; reason: string }
export interface WaterFacility {
  id: number; variant: string; x: number; z: number; rotation: number; stored: number;
  footprint: [number, number][]; entrance: [number, number]; operating: boolean;
  reason: string; network: number | null; production: number; capacity: number; storageCapacity: number; upkeep: number;
}
export interface WaterData {
  pipes: number[]; facilities: WaterFacility[]; services: Record<string, WaterService>; radius: number;
  summary: { demand: number; production: number; served: number; unserved: number; charging: number;
    discharging: number; spilled: number; storage: number; storageCapacity: number; networks: number; graceMonths: number };
}
/** Attach sparse network data to renderable tiles, including neighbour districts. */
export function attachWater(tiles: Tile[], size: number, water?: WaterData) {
  if (!water) return tiles;
  for (const i of water.pipes) if (tiles[i]) tiles[i]!.pipe = true;
  for (const [i, service] of Object.entries(water.services)) if (tiles[Number(i)]) tiles[Number(i)]!.waterService = service;
  for (const facility of water.facilities) for (const [x, z] of facility.footprint)
    if (tiles[z * size + x]) tiles[z * size + x]!.facility = facility;
  return tiles;
}
export interface DesirabilityLot {
  score: number; target: number; profile: string;
  components: { label: string; points: number; detail: string }[];
  powerReliability: number; waterReliability: number; poorMonths: number; commuteMinutes: number | null;
  demand: number; blockers: string[]; eligible: boolean; declining: boolean; updatedMonth: number | null;
}
export interface DesirabilityData {
  version: number; growthThreshold: number; declineThreshold: number; recoveryThreshold: number;
  smoothing: number; lots: Record<string, DesirabilityLot>;
}
export function attachDesirability(tiles: Tile[], data?: DesirabilityData | undefined) {
  if (data) for (const [i, row] of Object.entries(data.lots)) if (tiles[Number(i)]) tiles[Number(i)]!.desirability = row;
  return tiles;
}
interface CitySummary {
  desirability?: DesirabilityData | undefined;
  water?: WaterData | undefined;
  session: string;
  district: [number, number];
  terrainEdges?: number[][] | null;
  size: number;
  seed: number;
  tick: number;
  revision: number;
  speed: Speed;
  /** Minutes since the start of the current month (30 days). */
  clock: number;
  trafficRevision: number;
  roadCapacity: number;
  commuters: number;
  avgCommute: number;
  congested: number;
  money: number;
  population: number;
  jobs: number;
  workforce: number;
  employed: number;
  unemployed: number;
  vacancies: number;
  distressed: number;
  income: number;
  expenses: number;
  demand: Record<Zone, number>;
  unpowered: number;
  disconnected: number;
  history: PowerHistory[];
  power: PowerSummary;
  powerWind: number;
  powerLines: [number, number][];
}
export interface CityState extends CitySummary {
  terrainRevision: number;
  tiles: Tile[];
}
/** Compact column-oriented wire format sent by the Python server. */
export interface RawCityState extends Omit<CitySummary, "trafficRevision" | "roadCapacity" | "avgCommute" | "powerWind" | "powerLines"> {
  terrain_revision: number;
  traffic_revision: number;
  road_capacity: number;
  avg_commute: number;
  power_wind: number;
  power_lines: [number, number][];
  tiles: { height: number[]; kind: string; variant: string; level: string; powered: string; connected: string;
    workers: number[]; residents: number[]; condition: number[]; traffic: number[];
    power_demand: number[]; power_supply: number[]; power_grid: number[]; battery_charge: number[]; installation_part?: number[] };
}
export interface UnchangedState { unchanged: true; session: string; revision: number; clock: number }
/** Daily trips, one column per field. Routes are N/E/S/W moves from the origin tile. */
export interface TrafficData {
  revision: number;
  size: number;
  road_capacity: number;
  kind: string;
  origin: number[];
  destination: number[];
  count: number[];
  start: number[];
  end: number[];
  minutes: number[];
  route: string[];
}
const kindByCode: Record<string, Kind> = {
  ".": "empty", "=": "road", r: "residential", c: "commercial", i: "industrial", p: "power", k: "park", l: "powerline", w: "waterworks", s: "service",
};
export function decodeState(raw: RawCityState): CityState {
  const { terrain_revision, traffic_revision, road_capacity, avg_commute, power_wind, power_lines, tiles, ...summary } = raw;
  return {
    ...summary,
    terrainRevision: terrain_revision,
    trafficRevision: traffic_revision,
    roadCapacity: road_capacity,
    avgCommute: avg_commute,
    powerWind: power_wind,
    powerLines: power_lines,
    tiles: attachDesirability(attachWater(tiles.height.map((height, i) => ({
      x: i % raw.size, z: Math.floor(i / raw.size), height, water: height < 0,
      kind: kindByCode[tiles.kind[i] ?? "."] ?? "empty", variant: tiles.variant?.[i]?.replace(".", "") ?? "",
      level: Number(tiles.level[i] ?? 0),
      powered: tiles.powered[i] === "1", connected: tiles.connected[i] === "1",
      workers: tiles.workers[i]!, residents: tiles.residents[i]!, condition: tiles.condition[i]!, traffic: tiles.traffic[i]!,
      powerDemand: tiles.power_demand[i]!, powerSupply: tiles.power_supply[i]!,
      powerGrid: tiles.power_grid[i] === -1 ? null : tiles.power_grid[i]!,
      batteryCharge: tiles.battery_charge[i]!,
      installationPart: tiles.installation_part?.[i] ?? -1,
    })), raw.size, raw.water), raw.desirability),
  };
}
export const tools: { id: Tool; label: string; key: string; icon: string; cost: number; hint: string }[] = [
  { id: "inspect", label: "Inspect", key: "1", icon: "i", cost: 0, hint: "Click a tile to see its development and services." },
  { id: "road", label: "Road", key: "2", icon: "=", cost: 12, hint: "Drag to lay roads connecting local homes, businesses and services." },
  { id: "residential", label: "Residential", key: "3", icon: "R", cost: 8, hint: "Paint homes next to a connected road, within reach of power." },
  { id: "commercial", label: "Commercial", key: "4", icon: "C", cost: 10, hint: "Paint shops beside roads. Residents create demand for commerce." },
  { id: "industrial", label: "Industrial", key: "5", icon: "I", cost: 10, hint: "Paint industry beside roads to provide jobs and attract residents." },
  { id: "power", label: "Power station", key: "6", icon: "P", cost: 900, hint: "Needs a connected road. Roads and adjacent lots share power; lines bridge gaps." },
  { id: "powerline", label: "Power lines", key: "L", icon: "↯", cost: 15, hint: "Drag a route, or place aligned pylons up to 8 tiles apart across open land, roads or water." },
  { id: "waterworks", label: "Water facility", key: "U", icon: "W", cost: 1000, hint: "Place a pump or tower. Connect its entrance to a road, power it, and pipe its northwest anchor. Choose rotation below." },
  { id: "service", label: "Public services", key: "V", icon: "S", cost: 800, hint: "Place fire, police and education buildings beside roads. Their visible radius improves desirability while powered." },
  { id: "pipe", label: "Water pipes", key: "J", icon: "~", cost: 3, hint: "Drag underground pipes on dry land. Serve lots within two tiles; can coexist with roads and buildings." },
  { id: "remove_pipe", label: "Remove pipes", key: "K", icon: "x~", cost: 1, hint: "Remove underground pipes only. Surface bulldozing leaves pipes intact." },
  { id: "park", label: "Park", key: "7", icon: "+", cost: 60, hint: "A little breathing room. Parks cost $8 per month to maintain." },
  { id: "bulldoze", label: "Bulldoze", key: "8", icon: "x", cost: 5, hint: "Remove development before replacing it. There are no refunds." },
  { id: "terrain", label: "Terrain", key: "9", icon: "△", cost: 20, hint: "Raise, lower, or level empty terrain. Nearby slopes adjust automatically." },
];
export const colors: Record<Kind, string> = {
  empty: "#789c78", road: "#46535b", residential: "#6dc991",
  commercial: "#72b7df", industrial: "#dfb85b", power: "#cb8370", park: "#8cbf64", powerline: "#c5b88a", waterworks: "#59bad3", service: "#907bc5",
};
/** Zoning subtypes retain their familiar family colour while remaining legible
 * without opening the inspector. */
export const zoneColors: Record<Zone, Record<string, string>> = {
  residential: { l: "#91d7a3", m: "#62bd7d", h: "#398f5c" },
  commercial: { r: "#91cce8", o: "#579fc8", e: "#3977a8" },
  industrial: { f: "#ead889", t: "#d8b955", m: "#b58b32" },
};
export const zoneColor = (tile: Pick<Tile, "kind" | "variant">) =>
  tile.kind === "residential" || tile.kind === "commercial" || tile.kind === "industrial"
    ? zoneColors[tile.kind][subtype(tile)] ?? colors[tile.kind]
    : colors[tile.kind];
export interface Variant { id: string; label: string; detail: string; cost?: number }
/** Subtypes offered for each tool, in display order; mirrors VARIANTS in backend/simulation.py. */
export const variants: Partial<Record<Kind | "terrain", Variant[]>> = {
  terrain: [
    { id: "raise", label: "Raise", detail: "Lift empty land or fill water by one level" },
    { id: "lower", label: "Lower", detail: "Dig empty land by one level; below sea level becomes water" },
    { id: "level", label: "Level", detail: "Flatten the painted area to the first selected tile's elevation" },
  ],
  service: [
    { id: "f", label: "Fire station", detail: "12-tile coverage · strongest for industry · $80/month", cost: 800 },
    { id: "p", label: "Police station", detail: "10-tile coverage · strongest for commerce · $90/month", cost: 900 },
    { id: "e", label: "School", detail: "10-tile catchment · strongest for homes · $100/month", cost: 1000 },
  ],
  waterworks: [
    { id: "p", label: "Groundwater pump", detail: "2 x 1 footprint / 1,200 m3 per day / 12 kW / $60 per month", cost: 1000 },
    { id: "t", label: "Water tower", detail: "2 x 2 footprint / 600 m3 storage / 2 kW / $15 per month", cost: 650 },
  ],
  road: [
    { id: "s", label: "Street", detail: "150 capacity ? slower local access ? $1/month", cost: 6 },
    { id: "r", label: "Local road", detail: "400 capacity ? standard speed ? $2/month", cost: 12 },
    { id: "a", label: "Avenue", detail: "900 capacity ? faster travel ? $5/month", cost: 30 },
    { id: "e", label: "Express road", detail: "1,400 capacity ? fastest travel ? $8/month", cost: 50 },
  ],
  residential: [
    { id: "l", label: "Low density", detail: "Houses and terraces, up to level 2" },
    { id: "m", label: "Medium density", detail: "Up to mid-rise apartments, level 3" },
    { id: "h", label: "High density", detail: "Grows into residential towers, level 4" },
  ],
  commercial: [
    { id: "r", label: "Retail", detail: "Shops to shopping centres · 12 jobs per level, up to 3" },
    { id: "o", label: "Office", detail: "Offices to skyscrapers · 16 jobs per level" },
    { id: "e", label: "Entertainment", detail: "Diners, cinemas, theatres, arenas · open evenings" },
  ],
  industrial: [
    { id: "m", label: "Manufacturing", detail: "Workshops to steel mills · 20 jobs per level, smoky" },
    { id: "t", label: "High tech", detail: "Clean labs and campuses · 14 jobs per level" },
    { id: "f", label: "Farming", detail: "Crops, barns and silos · 6 jobs per level, up to 3" },
  ],
  power: [
    { id: "c", label: "Coal", detail: "800 kW steady output, $180/month", cost: 900 },
    { id: "s", label: "Solar", detail: "180 kW at noon, none at night, $40/month", cost: 500 },
    { id: "n", label: "Nuclear", detail: "4,000 kW steady output, $450/month", cost: 4000 },
    { id: "w", label: "Wind", detail: "120 kW rated, variable day and night, $25/month", cost: 450 },
    { id: "b", label: "Battery", detail: "1,200 kWh storage, 200 kW charge/discharge, $15/month", cost: 700 },
  ],
};
export const defaultVariant: Partial<Record<Kind | "terrain", string>> = { terrain: "raise", service: "f", waterworks: "p", road: "r", residential: "h", commercial: "r", industrial: "m", power: "c" };
/** Keyed by kind initial + subtype; mirror MAX_LEVEL and JOBS_PER_LEVEL in backend/simulation.py. */
export const MAX_LEVEL: Record<string, number> = { rh: 4, rm: 3, rl: 2, cr: 3, co: 4, ce: 4, im: 4, it: 4, if: 3 };
export const JOBS: Record<string, number> = { cr: 12, co: 16, ce: 10, im: 20, it: 14, if: 6 };
/** The tile's subtype, falling back to its kind's default. */
export const subtype = (tile: Pick<Tile, "kind" | "variant">) => tile.variant || defaultVariant[tile.kind] || "";

/** Mirrors backend/roads.py; capacities describe aggregate routing, not animated lane counts. */
export const ROAD_TYPES: Record<string, { capacity: number; color: string }> = {
  s: { capacity: 150, color: "#777b79" },
  r: { capacity: 400, color: "#46535b" },
  a: { capacity: 900, color: "#3e4854" },
  e: { capacity: 1400, color: "#303840" },
};
export const roadType = (tile: Pick<Tile, "variant">) => ROAD_TYPES[tile.variant] ?? ROAD_TYPES.r!;
