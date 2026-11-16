import type { WaterData } from "./types";

const n = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 1 });

export function WaterStatus({ data, onOverlay }: { data?: WaterData | undefined; onOverlay: () => void }) {
  if (!data) return null;
  const s = data.summary;
  return <section className="panel water-panel">
    <div className="section-label">WATER SUPPLY</div>
    <div className="budget-row"><span>Demand / supplied</span><strong>{n(s.demand)} / {n(s.served)} m³/day</strong></div>
    <div className="budget-row"><span>Production</span><span>{n(s.production)} m³/day</span></div>
    <div className="budget-row"><span>Unmet demand</span><span className={s.unserved > .01 ? "negative" : "positive"}>{n(s.unserved)} m³/day</span></div>
    <div className="budget-row"><span>Tower storage</span><span>{n(s.storage)} / {n(s.storageCapacity)} m³</span></div>
    <div className="budget-row"><span>Filling / drawing</span><span>{n(s.charging)} / {n(s.discharging)} m³/day</span></div>
    <div className="budget-row"><span>Water facility upkeep</span><span>${n(data.facilities.reduce((sum, f) => sum + f.upkeep, 0))}/month</span></div>
    {s.graceMonths > 0 && <p role="status">Legacy-save grace: {s.graceMonths} months remaining. Connect water before growth stops and sustained shortages cause decline.</p>}
    <p className="muted">Pipes serve lots within {data.radius} tiles (Manhattan distance). Pumps and towers need power, a road at their marked entrance, and a pipe under the northwest anchor. Storage follows the game-day clock.</p>
    <button onClick={onOverlay}>Show water network</button>
    <details><summary>Facilities ({data.facilities.length})</summary>{data.facilities.map(f => <p key={f.id}>
      <strong>{f.variant === "p" ? "Pump" : "Tower"} at {f.x}, {f.z}</strong><br />
      {f.reason} / entrance {f.entrance.join(", ")} / {f.variant === "p" ? `${n(f.production)} m³/day` : `${n(f.stored)} m³ stored`}
    </p>)}</details>
  </section>;
}
