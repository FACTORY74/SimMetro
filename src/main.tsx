import { DesirabilityInspector, DesirabilityStatus } from "./desirability";
import { WaterStatus } from "./water";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CityWorld } from "./world";
import { buildingModel } from "./buildings";
import { PowerReport, PowerStatus } from "./power";
import { StateCursor, retryUntilSuccess } from "./sync";
import type { RegionView } from "./region";
import { roadType, colors, decodeState, defaultVariant, JOBS, MAX_LEVEL, subtype, tools, variants } from "./types";
import type { Cell, CityState, Kind, Overlay, RawCityState, Speed, Tile, Tool, TrafficData, UnchangedState } from "./types";
import "./style.css";

const number = (value: number) => Math.round(value).toLocaleString("en-US");
const dollars = (value: number) => `${value < 0 ? "-" : ""}$${number(Math.abs(value))}`;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const SPEEDS: { speed: Speed; label: string; title: string }[] = [
  { speed: 0, label: "Ⅱ", title: "Pause simulation" },
  { speed: "day", label: "Day", title: "Live: one day per minute, one month every 30 minutes" },
  { speed: 1, label: "1×", title: "Fast: one month every 2 seconds" },
  { speed: 3, label: "3×", title: "Fastest: three months every 2 seconds" },
];
/** Minute of the day as HH:MM. */
const time = (minute: number) => {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

interface Routine { label: string; detail: string }
/** What the people living or working on a tile do each day, derived from the trip plan. */
function routines(tile: Tile, index: number, city: CityState, traffic: TrafficData | null): Routine[] {
  if (!traffic) return [];
  const trips = [...traffic.kind].map((kind, i) => ({
    kind, i, origin: traffic.origin[i]!, destination: traffic.destination[i]!, count: traffic.count[i]!,
    start: traffic.start[i]!, end: traffic.end[i]!, minutes: traffic.minutes[i]!,
  }));
  const place = (target: number) => {
    const t = city.tiles[target]!;
    return `${buildingModel(t, city.seed)?.name ?? t.kind} (${t.x}, ${t.z})`;
  };
  if (tile.kind === "residential") {
    const work = trips.filter(t => t.kind === "w" && t.origin === index);
    const shop = trips.filter(t => t.kind === "s" && t.origin === index);
    // Busy commutes are split over several routes; show one row per workplace and shift.
    const groups = new Map<string, { t: typeof work[number]; count: number; routes: number; minutes: number }>();
    for (const t of work) {
      const key = `${t.destination}:${t.start}:${t.end}`;
      const group = groups.get(key) ?? { t, count: 0, routes: 0, minutes: 0 };
      group.count += t.count;
      group.routes += 1;
      group.minutes += t.minutes * t.count;
      groups.set(key, group);
    }
    const rows = [...groups.values()].map(({ t, count, routes, minutes }) => {
      const drive = Math.round(minutes / count);
      return {
        label: `${count} commute${count === 1 ? "s" : ""}`,
        detail: `Around ${time(t.start - drive)} to ${place(t.destination)} · shift ${time(t.start)}–${time(t.end)} · ${drive} min drive${routes > 1 ? ` over ${routes} routes` : ""} · times vary day to day`,
      };
    });
    for (const t of shop) rows.push({ label: `${t.count} shopper${t.count === 1 ? "" : "s"}`,
      detail: `Drive to ${place(t.destination)} around ${time(t.start - t.minutes)}, home by ${time(t.end + t.minutes)}` });
    const stayers = tile.residents - work.reduce((sum, t) => sum + t.count, 0) - shop.reduce((sum, t) => sum + t.count, 0);
    if (stayers > 0) rows.push({ label: `${stayers} at home`, detail: "Children, retirees and people between jobs stay local." });
    return rows;
  }
  if (tile.kind === "commercial" || tile.kind === "industrial") {
    const staff = trips.filter(t => t.kind === "w" && t.destination === index);
    const shifts = [...new Map(staff.map(t => [`${t.start}:${t.end}`, [t.start, t.end] as const])).values()].sort((a, b) => a[0] - b[0]);
    const rows = staff.length ? [{
      label: `${staff.reduce((sum, t) => sum + t.count, 0)} staff`,
      detail: `From ${new Set(staff.map(t => t.origin)).size} home${new Set(staff.map(t => t.origin)).size === 1 ? "" : "s"} · ${shifts.map(([a, b]) => `${time(a)}–${time(b)}`).join(", ")}`,
    }] : [];
    const customers = trips.filter(t => t.kind === "s" && t.destination === index).reduce((sum, t) => sum + t.count, 0);
    if (customers) rows.push({ label: `${customers} shoppers`, detail: "Visit each day between 10:00 and 19:00." });
    const trucks = trips.filter(t => t.kind === "f" && t.origin === index);
    for (const t of trucks) rows.push({ label: `${t.count} truck${t.count === 1 ? "" : "s"}`,
      detail: `Freight leaves from ${time(t.start)} for ${place(t.destination)}, ${t.minutes} min away.` });
    return rows;
  }
  return [];
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error: { detail?: unknown } = await response.json();
    throw new Error(typeof error.detail === "string" ? error.detail : `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}
const requestState = async (path: string, body?: unknown) => decodeState(await request<RawCityState>(path, body));

interface AutoplayStatus {
  enabled: boolean; reserve: number; target: number; actions: number; spent: number; reason: string; actionsPerMonth: number | null; blocksBuilt: number; mode: "stress" | "growth"; pendingActions: number; workMs: number; simulationMs: number; missingTypes: string[];
  log: { month: number; tool: string; cost: number; reason: string }[];
}

function App() {
  const [saveName, setSaveName] = useState("city");
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const poll = () => request<{ saves: { name: string }[]; autosave: { error: string | null } }>("saves")
      .then(data => { if (!stopped) { setSavedNames(data.saves.map(s => s.name)); setAutosaveError(data.autosave.error); } }).catch(() => {});
    void poll();
    const timer = setInterval(poll, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const [autoplay, setAutoplay] = useState<AutoplayStatus | null>(null);
  const [autoReserve, setAutoReserve] = useState(5000);
  const [autoTarget, setAutoTarget] = useState(2000);
  const [autoMode, setAutoMode] = useState<"stress" | "growth">("stress");
  useEffect(() => {
    let disposed = false;
    const poll = () => request<AutoplayStatus>("autoplay").then(value => { if (!disposed) { setAutoplay(value); if (value.enabled) { setAutoMode(value.mode); setAutoReserve(value.reserve); setAutoTarget(value.target); } } }).catch(() => {});
    void poll();
    const timer = setInterval(poll, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const [city, setCity] = useState<CityState | null>(null);
  const [facilityRotation, setFacilityRotation] = useState(0);
  const rotationRef = useRef(0);
  rotationRef.current = facilityRotation;
  const [tool, setTool] = useState<Tool>("inspect");
  const [overlay, setOverlay] = useState<Overlay>("normal");
  const [hover, setHover] = useState<Cell | null>(null);
  const [selected, setSelected] = useState<Cell | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [connection, setConnection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showcase, setShowcase] = useState(false);
  const [powerReport, setPowerReport] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<TrafficData | null>(null);
  const [region, setRegion] = useState<RegionView | null>(null);
  const district = useRef<[number, number]>([0, 0]);
  const [live, setLive] = useState<{ vehicles: number; clock: number; queued: number; perCar: number }>({ vehicles: 0, clock: 360, queued: 0, perCar: 1 });
  const [performanceMetrics, setPerformanceMetrics] = useState({ fps: 0, updatesPerSecond: 0, simulationMs: 0, latencyMs: 0 });
  const lastSpeed = useRef<Exclude<Speed, 0>>("day");
  const map = useRef<HTMLDivElement>(null);
  const world = useRef<CityWorld | null>(null);
  const [choice, setChoice] = useState<Partial<Record<Tool, string>>>({ ...defaultVariant, residential: "m" });
  const currentTool = useRef(tool);
  const currentChoice = useRef(choice);
  const locked = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  currentTool.current = tool;
  currentChoice.current = choice;

  const notify = useCallback((text: string, error = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(() => setNotice(null), error ? 8000 : 4000);
  }, []);

  const cursor = useRef(new StateCursor());
  const accept = useCallback((next: CityState) => {
    const restarted = cursor.current.session !== null && cursor.current.session !== next.session;
    if (!cursor.current.accept(next)) return;
    if (district.current.toString() !== next.district.toString()) { setTraffic(null); setSelected(null); }
    district.current = next.district;
    if (restarted) { setTraffic(null); setSelected(null); }
    if (next.speed !== 0) lastSpeed.current = next.speed;
    world.current?.setClock(next.clock, next.speed);
    world.current?.update(next);
    setCity(next);
  }, []);
  const speedRef = useRef<Speed>(0);
  speedRef.current = city?.speed ?? 0;

  const action = useCallback(async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    if (world.current) world.current.enabled = false;
    try { await operation(); }
    catch (error) { notify(error instanceof Error ? error.message : "Unexpected request failure.", true); }
    finally {
      locked.current = false;
      setBusy(false);
      if (world.current) world.current.enabled = true;
    }
  }, [notify]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      const requestedAt = performance.now();
      try {
        const view = world.current?.view() ?? { x: 128, z: 128, distance: 75 };
        const query = new URLSearchParams(cursor.current.query().replace(/^\?/, ""));
        query.set("x", String(view.x)); query.set("z", String(view.z)); query.set("distance", String(Math.max(8, Math.min(900, view.distance))));
        const response = await fetch(`/api/view?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const result = await response.json() as { state: RawCityState | UnchangedState; region: RegionView };
        const latencyMs = performance.now() - requestedAt;
        const state = result.state;
        if (!stopped) {
          setPerformanceMetrics(value => ({ ...value, latencyMs,
            updatesPerSecond: result.region.performance?.updatesPerSecond ?? value.updatesPerSecond,
            simulationMs: result.region.performance?.simulationMs ?? value.simulationMs }));
          if ("unchanged" in state) {
            if (cursor.current.matches(state)) world.current?.setClock(state.clock, speedRef.current);
          }
          else accept(decodeState(state));
          if (cursor.current.matches(state) && district.current.toString() === result.region.focus.toString()) {
            world.current?.setRegion(result.region); setRegion(result.region);
          }
          setConnection(null);
        }
      } catch (error) {
        if (!stopped) setConnection(`Cannot reach the simulation. ${error instanceof Error ? error.message : "Connection failed"}. Retrying...`);
      } finally {
        if (!stopped) timer = setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [accept]);

  useEffect(() => {
    if (!map.current) return;
    try {
      world.current = new CityWorld(map.current, cells => {
        const chosen = currentTool.current;
        if (chosen === "inspect") return;
        void action(async () => {
          const result = await request<{ cost: number; state: RawCityState }>("build", { tool: chosen, cells, variant: currentChoice.current[chosen] ?? null, district: district.current, rotation: rotationRef.current });
          accept(decodeState(result.state));
          notify(result.cost ? `Construction complete · ${dollars(result.cost)}` : "Nothing changed.");
        });
      }, setHover, setSelected);
      world.current.onTick = (vehicles, clock, queued, perCar, fps) => {
        setLive({ vehicles, clock, queued, perCar });
        setPerformanceMetrics(value => ({ ...value, fps }));
      };
    } catch (error) {
      setRenderError(`Unable to start the 3D renderer: ${error instanceof Error ? error.message : "WebGL unavailable"}. Enable hardware acceleration and reload.`);
    }
    return () => { world.current?.dispose(); world.current = null; };
  }, [accept, action, notify]);

  const trafficRevision = city?.trafficRevision;
  const session = city?.session;
  useEffect(() => {
    if (trafficRevision === undefined) return;
    return retryUntilSuccess(async signal => {
      const response = await fetch("/api/traffic", { signal });
      if (!response.ok) throw new Error(`${response.status}`);
      const data = await response.json() as TrafficData & { session: string; district: [number, number] };
      if (data.session !== session || data.district.toString() !== district.current.toString()) throw new Error("Simulation changed");
      return data;
    }, data => { setTraffic(data); world.current?.setTraffic(data); });
  }, [trafficRevision, session]);
  useEffect(() => {
    world.current?.setTool(tool);
    if (tool === "pipe" || tool === "remove_pipe") setOverlay("water");
  }, [tool]);
  useEffect(() => { world.current?.setFacilityPlacement(choice.waterworks ?? "p", facilityRotation); }, [choice.waterworks, facilityRotation]);
  useEffect(() => { world.current?.setOverlay(overlay); }, [overlay]);
  useEffect(() => {
    world.current?.setShowcase(showcase);
    if (showcase) setSelected(null);
  }, [showcase]);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (showcase && event.key === "Escape") { setShowcase(false); return; }
      if (event.target instanceof HTMLElement &&
          ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName)) return;
      if (powerReport) return;
      const chosen = tools.find(t => t.key.toLowerCase() === event.key.toLowerCase());
      if (chosen && !showcase) setTool(chosen.id);
      if (event.code === "Space" && city) {
        event.preventDefault();
        void action(async () => accept(await requestState("speed", { speed: city.speed ? 0 : lastSpeed.current })));
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [city, action, accept, showcase, powerReport]);

  const active = tools.find(t => t.id === tool)!;
  const options = variants[tool as Kind];
  const option = options?.find(v => v.id === choice[tool]);
  const tile = city && selected ? city.tiles[selected.z * city.size + selected.x] : null;
  const tileVariant = tile ? variants[tile.kind]?.find(v => v.id === subtype(tile)) : undefined;
  const jobsPerLevel = tile ? JOBS[`${tile.kind[0]}${subtype(tile)}`] ?? 0 : 0;
  const building = tile && city ? buildingModel(tile, city.seed) : null;
  const business = tile?.kind === "commercial" || tile?.kind === "industrial";
  const net = city ? city.income - city.expenses : 0;
  const date = city ? `${MONTHS[city.tick % 12]} ${2000 + Math.floor(city.tick / 12)}` : "JAN 2000";
  const day = Math.floor(live.clock / 1440) % 30 + 1;
  const routine = tile && city && selected ? routines(tile, selected.z * city.size + selected.x, city, traffic) : [];
  const validSaveName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(saveName);
  const save = () => void action(async () => {
    const result = await request<{ message: string }>("save", { name: saveName });
    notify(result.message);
  });
  const load = () => {
    if (!confirm(`Load "${saveName}"? Unsaved changes in all districts will be lost.`)) return;
    void action(async () => {
      accept(await requestState("load", { name: saveName }));
      world.current?.centreDistrict();
      setSelected(null);
      notify("Saved region restored.");
    });
  };
  const history = city?.history ?? [];
  const maximum = Math.max(1, ...history.map(h => h.population));
  const points = history.map((h, i) => `${i * 220 / Math.max(1, history.length - 1)},${45 - h.population / maximum * 37}`).join(" ");

  return <main className={`app ${showcase ? "showcase" : ""}`}>
    <div ref={map} className="world" />
    <header className="topbar">
      <div className="brand"><div className="brand-mark">S<span>M</span></div><div><h1>SimMetro</h1><p>CITY WORKSHOP</p></div></div>
      <div className="city-name"><span className="live-dot" /> New Harbourside <small>YOUR CITY, TAKING SHAPE</small></div>
      <div className="top-stat"><span>TREASURY</span><strong>{city ? dollars(city.money) : "—"}</strong></div>
      <div className="top-stat population"><span>RESIDENTS</span><strong>{number(city?.population ?? 0)}</strong></div>
      <div className="save-actions"><label className="save-name">Save slot<input aria-label="Save slot name" list="save-slots" value={saveName} maxLength={48}
        onChange={e => setSaveName(e.target.value)} /><datalist id="save-slots">{savedNames.map(name => <option key={name} value={name} />)}</datalist></label><button onClick={save} disabled={!city || busy || !validSaveName || /^autosave-[123]$/.test(saveName)}>Save region</button><button onClick={load} disabled={!city || busy || !validSaveName}>Load</button></div>
    </header>

    <aside className="tool-panel panel">
      <div className="section-label">BUILD YOUR CITY</div>
      <div className="tools">{tools.map(t => <button key={t.id} className={`tool ${tool === t.id ? "active" : ""}`}
        onClick={() => setTool(t.id)} aria-label={t.label} aria-pressed={tool === t.id} title={`${t.label} (${t.key})`}>
        <span className={`tool-icon ${t.id}`}>{t.icon}</span>
        <span className="tool-label">{t.label}<small>{t.cost ? `${dollars(t.cost)} / ${t.id === "waterworks" ? "facility" : "tile"}` : "Explore your city"}</small></span>
        <kbd>{t.key}</kbd>
      </button>)}</div>
      {options && <div className="subtypes" role="radiogroup" aria-label={`${active.label} type`}>
        <div className="section-label">{active.label.toUpperCase()} TYPE</div>
        {options.map(v => <button key={v.id} role="radio" aria-checked={choice[tool] === v.id}
          className={`subtype ${choice[tool] === v.id ? "active" : ""}`} title={v.detail}
          onClick={() => setChoice(c => ({ ...c, [tool]: v.id }))}>
          {v.label}{v.cost ? <small>{dollars(v.cost)}</small> : null}
        </button>)}
      </div>}
      {tool === "waterworks" && <div className="subtypes"><label>Entrance orientation
        <select aria-label="Facility rotation" value={facilityRotation} onChange={e => setFacilityRotation(Number(e.target.value))}>
          <option value="0">West</option><option value="1">North</option><option value="2">East</option><option value="3">South</option>
        </select></label><p className="muted">Yellow preview marks the road entrance; green means connected. Cost is per facility.</p></div>}
      <div className="tool-footer"><span className="tiny-dot" /> Original procedural models<br /><span className="muted">No textures. Just possibilities.</span></div>
    </aside>

    <aside className="dashboard">
      <section className="panel region-status">
        <p className="muted">Autosave every two minutes; three rotating slots. Choose a saved slot above to load it.</p>
        {autosaveError && <p role="alert" className="negative">{autosaveError}</p>}
        <div className="section-label">REGION EXPLORER</div>
        <div className="budget-row"><span>Focused district</span><strong>{city?.district.join(", ") ?? "0, 0"}</strong></div>
        <div className="budget-row"><span>Detailed simulation</span><span>{region?.detailed.length ?? 1} district(s)</span></div>
        <div className="budget-row"><span>Explored / developed</span><span>{region?.explored ?? 1} / {region?.inhabited ?? 1}</span></div>
        <p className="muted">Pan beyond the edge to explore. Zoom out for the region; zoom in to build. Budget and services belong to the focused district.</p>
        <div className="region-actions"><button disabled={!city} onClick={() => world.current?.overview()}>Region view</button>
          <button disabled={!city} onClick={() => world.current?.startingCity()}>Starting city</button></div>
      </section>
      <section className="panel autoplay-panel">
        <div className="section-label">AUTOPLAY / DEVELOPMENT HELPER</div>
        <label>Mode <select value={autoMode} disabled={autoplay?.enabled} onChange={e => setAutoMode(e.target.value as "stress" | "growth")}>
          <option value="stress">Continuous stress test</option><option value="growth">Targeted growth</option>
        </select></label>
        <p className="muted">{autoMode === "stress" ? "Continuously spends available construction funds on large serviced neighbourhoods and every implemented building type. No population cap. Uses the current game speed; pause stops construction." : "Expands towards a population target, preserving six months of projected deficit."}</p>
        <label>Construction reserve <input type="number" min="0" max="10000000" value={autoReserve} disabled={autoplay?.enabled}
          onChange={e => setAutoReserve(Number(e.target.value))} /></label>
        {autoMode === "growth" && <label>Population target <input type="number" min="1" max="1000000" value={autoTarget} disabled={autoplay?.enabled}
          onChange={e => setAutoTarget(Number(e.target.value))} /></label>}
        <button disabled={!city || busy || !Number.isInteger(autoReserve) || autoReserve < 0 || !Number.isInteger(autoTarget) || autoTarget < 1}
          onClick={() => void action(async () => setAutoplay(await request<AutoplayStatus>("autoplay", {
            enabled: !autoplay?.enabled, reserve: autoReserve, target: autoTarget, mode: autoMode,
          })))}>{autoplay?.enabled ? "Stop autoplay" : "Start autoplay"}</button>
        <p role="status">{autoplay?.enabled && city?.speed === 0 ? "Paused with the simulation" : autoplay?.reason ?? "Connecting..."}</p>
        <p className="muted">{autoplay?.actions ?? 0} actions / {autoplay?.blocksBuilt ?? 0} street blocks / {dollars(autoplay?.spent ?? 0)} spent. Stops on district change or load.</p>
        {autoMode === "stress" && <p className="muted">{autoplay?.pendingActions ?? 0} queued commands. Construction {(autoplay?.workMs ?? 0).toFixed(1)} ms / simulation {(autoplay?.simulationMs ?? 0).toFixed(1)} ms per last update. Operating costs can spend below the construction reserve.</p>}
        {autoMode === "stress" && !!autoplay?.actions && <p className="muted">{autoplay.missingTypes.length ? `Types still to build: ${autoplay.missingTypes.join(", ")}` : "All implemented construction types exercised."}</p>}
        <details><summary>Recent actions</summary><ol>{autoplay?.log.slice(-8).reverse().map((entry, i) =>
          <li key={i}>Month {entry.month}: {entry.tool} ({dollars(entry.cost)}) - {entry.reason}</li>)}</ol></details>
      </section>
      <DesirabilityStatus data={city?.desirability} onOverlay={() => setOverlay("desirability")} />
      <WaterStatus data={city?.water} onOverlay={() => setOverlay("water")} />
      <PowerStatus summary={city?.power} onOpen={() => setPowerReport(true)} />
      <section className="panel overview">
        <div className="section-label">CITY PULSE <span className="badge">LIVE</span></div>
        <h2>A place to call home.</h2>
        <p className="muted intro">Connect roads. Power opportunity.<br />Watch your neighbourhoods grow.</p>
        <div className="metric-row"><span>Population</span><strong>{number(city?.population ?? 0)} <small>people</small></strong></div>
        <svg className="chart" viewBox="0 0 220 50" role="img" aria-label="Population history">
          <path d="M0 48H220" stroke="#394a4e" /><polyline points={points} fill="none" stroke="#9cdeb0" strokeWidth="2" />
        </svg>
        <div className="two-metrics"><div><span>LOCAL JOBS</span><strong>{number(city?.jobs ?? 0)}</strong></div>
          <div><span>MONTHLY BALANCE</span><strong className={net >= 0 ? "positive" : "negative"}>{net >= 0 ? "+" : ""}{dollars(net)}</strong></div></div>
        <div className="budget-row"><span>Tax revenue</span><span>{dollars(city?.income ?? 0)}</span></div>
        <div className="budget-row"><span>City upkeep</span><span>−{dollars(city?.expenses ?? 0)}</span></div>
        <div className="budget-row employment"><span>Employed / workforce</span><span>{number(city?.employed ?? 0)} / {number(city?.workforce ?? 0)}</span></div>
        <div className="budget-row employment"><span>Unemployed / vacancies</span><span>{number(city?.unemployed ?? 0)} / {number(city?.vacancies ?? 0)}</span></div>
        <div className="budget-row employment"><span>Businesses in disrepair</span><span>{number(city?.distressed ?? 0)}</span></div>
      </section>
      <section className="panel traffic-panel">
        <div className="section-label">TRAFFIC <span className="badge">{time(live.clock)}</span></div>
        <div className="budget-row"><span>Vehicles on the road</span><span>{number(live.vehicles)}</span></div>
        <div className="budget-row"><span>Stopped in queues</span><span>{number(live.queued)}</span></div>
        <div className="budget-row"><span>Each car shown is</span><span>≈ {live.perCar < 1.5 ? "1 person" : `${Math.round(live.perCar)} people`}</span></div>
        <div className="budget-row"><span>Daily commuters</span><span>{number(city?.commuters ?? 0)}</span></div>
        <div className="budget-row"><span>Average commute</span><span>{city?.avgCommute ?? 0} min</span></div>
        <div className="budget-row"><span>Congested road tiles</span><span className={city?.congested ? "negative" : ""}>{number(city?.congested ?? 0)}</span></div>
      </section>
      <section className="panel demand">
        <div className="section-label">DEVELOPMENT DEMAND</div>
        {(["residential", "commercial", "industrial"] as const).map(zone => <div className="demand-row" key={zone}>
          <span>{zone}</span><div className="meter"><div style={{ width: `${city?.demand[zone] ?? 0}%`, background: colors[zone] }} /></div>
          <small>{Math.round(city?.demand[zone] ?? 0)}%</small>
        </div>)}
      </section>
      <section className="panel map-layers">
        <div className="section-label">MAP LAYERS</div>
        <select aria-label="Map layer" value={overlay} onChange={event => setOverlay(event.target.value as Overlay)}>
          <option value="normal">City view</option><option value="zones">Land use</option>
          <option value="desirability">Desirability</option><option value="water">Water pipes &amp; supply</option><option value="power">Power grid</option><option value="access">Road access</option>
          <option value="elevation">Terrain elevation</option><option value="traffic">Traffic volume</option>
        </select>
        {overlay !== "normal" && <p className="layer-help">{overlay === "desirability" ? "Red: below 40 / yellow: 40-49 / green: 50-69 / teal: 70+. Grey: not zoned. Suitability only; essential services and demand still apply." : overlay === "water" ? "Cyan: underground pipe / green: supplied / yellow: partial / red: shortage / grey: no consumer. Pipe colour takes precedence; inspect for supply." : overlay === "zones" ? "Green: homes · Blue: shops · Gold: industry" :
          overlay === "elevation" ? "Blue: below sea level · Sand: shore · Green to white: higher ground" :
          overlay === "traffic" ? "Daily peak: green quiet / yellow busy / red over each road type's capacity" :
          "Green: served · Red: not served"}</p>}
      </section>
      <section className="adviser">
        <span className="adviser-icon">i</span><div><strong>From your city adviser</strong>
          <p>{city?.unpowered ? `${city.unpowered} zoned tiles need power. Check grid connections and supply in Power grid & graphs.` :
            city?.water && city.water.summary.unserved > .01 ? "Some lots lack water. Check pipes, facility entrances, power and production in Water supply." :
            city?.disconnected ? `${city.disconnected} zoned tiles need local road access.` :
            city?.distressed ? "Businesses are deteriorating. Add powered homes on the same road network to supply workers." :
            city?.vacancies ? "Businesses need staff. Zone homes on their road network; only 55% of residents join the workforce." :
            net < 0 ? "Upkeep exceeds taxes. Develop more serviced zones before adding infrastructure." :
            "Your city is connected and powered. Paint more zones alongside roads to welcome new residents."}</p></div>
      </section>
    </aside>

    {tile && <section className="panel inspector">
      <button className="close" aria-label="Close inspector" onClick={() => setSelected(null)}>×</button>
      <div className="section-label">TILE {tile.x}, {tile.z}</div>
      <h3>{tile.water ? "Open water" : tile.kind === "empty" ? "Undeveloped land" : tile.kind}</h3>
      {tile.desirability && <DesirabilityInspector data={tile.desirability} />}
      {tile.pipe && <p>Underground water pipe. Use Remove pipes (K) to cut it.</p>}
      {tile.waterService && <p>Water: {tile.waterService.served.toFixed(1)} / {tile.waterService.requested.toFixed(1)} m?/day<br />
        {tile.waterService.reason} / network {tile.waterService.network ?? "none"}</p>}
      {tile.facility && <p>Facility #{tile.facility.id}: {tile.facility.reason}<br />
        Entrance: {tile.facility.entrance.join(", ")} / pipe connector: {tile.facility.x}, {tile.facility.z}<br />
        {tile.facility.variant === "t" ? `${tile.facility.stored.toFixed(1)} / ${tile.facility.storageCapacity} m? stored` : `${tile.facility.production} / ${tile.facility.capacity} m?/day`}<br />
        ${tile.facility.upkeep}/month. Bulldozing any footprint cell removes the whole facility for $5; pipes remain.</p>}
      {tileVariant && <p className="subtype-line">{tileVariant.label} · {tileVariant.detail}</p>}
      <p>{tile.water ? `Depth ${-tile.height} level${tile.height < -1 ? "s" : ""} below sea level` : `Elevation level ${tile.height}`}</p>
      <p>{tile.level ? `Development level ${tile.level} / ${MAX_LEVEL[`${tile.kind[0]}${subtype(tile)}`] ?? 4}` : "No developed building"}</p>
      {tile.kind === "residential" && <p>Residents: {tile.residents} / {tile.level * 24}</p>}
      {building && <p><strong>{building.name}</strong></p>}
      {business && tile.level > 0 && <>
        <p>Staff: {tile.workers} / {tile.level * jobsPerLevel}</p>
        <p className={tile.condition < 60 ? "negative" : ""}>Condition: {tile.condition}% · {tile.condition <= 20 ? "Derelict" : tile.condition < 60 ? "Disrepair" : "Maintained"}</p>
        <p>80% staffing maintains and repairs this building.</p>
      </>}
      {tile.kind === "road" && city && <p>Peak traffic: {number(tile.traffic)} cars · {Math.round(tile.traffic / roadType(tile).capacity * 100)}% of capacity</p>}
      {tile.kind !== "empty" && <>
        <p>Electrical grid: {tile.powerGrid === null ? "Disconnected" : `#${tile.powerGrid + 1}`}</p>
        <p>Power demand: {tile.powerDemand.toFixed(2)} kW</p>
        {tile.kind === "power" && <p>{tile.powerSupply < 0 ? "Charging" : "Output"}: {Math.abs(tile.powerSupply).toFixed(1)} kW</p>}
        {tile.kind === "power" && subtype(tile) === "b" && <p>Stored energy: {tile.batteryCharge.toFixed(1)} / 1,200 kWh</p>}
      </>}
      {routine.length > 0 && <div className="routine"><div className="section-label">DAILY ROUTINE</div>
        {routine.map((r, i) => <p key={i}><strong>{r.label}</strong><br /><span>{r.detail}</span></p>)}</div>}
      <div className="inspector-services"><span className={tile.powered ? "positive" : "negative"}>{tile.powered ? "Powered" : "No power"}</span>
        <span className={tile.connected ? "positive" : "negative"}>{tile.connected ? "Road access" : "No road access"}</span></div>
    </section>}

    <div className="map-caption"><span className="compass">N ↑</span><span>NEW HARBOURSIDE<br /><small>{city?.size ?? 256} × {city?.size ?? 256} · COASTAL REGION</small></span></div>
    <footer className="bottom-bar panel">
      <div className="active-tool"><span className={`tool-icon ${active.id}`}>{active.icon}</span><div><strong>{active.label}{option ? ` · ${option.label}` : ""}</strong><p>{option ? `${option.detail}. ` : ""}{active.hint}</p></div></div>
      <div className="performance-metrics" aria-label="Live performance">
        <span title="Rendered frames per second"><strong>{Math.round(performanceMetrics.fps)}</strong><small>FPS</small></span>
        <span title="Authoritative simulation updates per second"><strong>{performanceMetrics.updatesPerSecond.toFixed(1)}</strong><small>UPS</small></span>
        <span title="Time spent on the latest simulation update"><strong>{performanceMetrics.simulationMs.toFixed(1)}</strong><small>SIM ms</small></span>
        <span title="Latest complete region response time"><strong>{Math.round(performanceMetrics.latencyMs)}</strong><small>PING ms</small></span>
      </div>
      <div className="time-controls"><span className="date">{date}<small>Day {day} · {time(live.clock)}</small></span><div className="speed-buttons">
        {SPEEDS.map(({ speed, label, title }) => <button key={speed} aria-label={title} title={title}
          aria-pressed={city?.speed === speed} className={city?.speed === speed ? "selected" : ""}
          disabled={!city || busy} onClick={() => void action(async () => accept(await requestState("speed", { speed })))}>
          {label}
        </button>)}
      </div><button className="showcase-button" title="Showcase camera: orbit the view centre for recording (Esc to exit)"
        disabled={!city} onClick={() => setShowcase(true)}>▶ Showcase</button></div>
    </footer>
    {showcase && <button className="showcase-exit" onClick={() => setShowcase(false)}>Exit showcase · Esc</button>}
    {powerReport && <PowerReport onClose={() => setPowerReport(false)} />}
    <div className="navigation-hint">Scroll to zoom <span>·</span> Right-drag to orbit <span>·</span> Middle-drag or WASD to pan <span>·</span> Esc cancels
      <span className="coordinates">{hover ? `${hover.x}, ${hover.z}` : "—, —"}</span></div>
    {notice && <div className={`toast ${notice.error ? "error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}</div>}
    {busy && <div className="working" role="status">Updating city…</div>}
    {connection && <div className="connection" role="alert">{connection}</div>}
    {(!city || renderError) && <div className="loading"><div className="panel"><div className="brand-mark">K<span>4</span></div><h2>{renderError ? "Renderer unavailable" : "Preparing your city"}</h2><p>{renderError ?? connection ?? "Connecting to the Python simulation…"}</p></div></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
