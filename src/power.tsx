import { useEffect, useRef, useState } from "react";
import type { PowerData, PowerSummary } from "./types";

const value = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const hour = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
interface Row { label: string; values: number[] }
interface Series { name: string; color: string }

function PowerChart({ label, rows, series }: { label: string; rows: Row[]; series: Series[] }) {
  const maximum = Math.max(1, ...rows.flatMap(r => r.values));
  const x = (i: number) => 48 + i * 520 / Math.max(1, rows.length - 1);
  const y = (v: number) => 143 - v / maximum * 122;
  return <section className="power-chart">
    <h3>{label}</h3>
    <div className="power-legend">{series.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>
    {rows.length ? <>
      <svg viewBox="0 0 600 172" role="img" aria-label={`${label}. Maximum axis ${value(maximum)} kW. Data table below.`}>
        {[0, .5, 1].map(f => <g key={f}>
          <line x1="48" x2="568" y1={y(maximum * f)} y2={y(maximum * f)} stroke="#395050" />
          <text x="43" y={y(maximum * f) + 3} textAnchor="end">{value(maximum * f)}</text>
        </g>)}
        {series.map((s, j) => <polyline key={s.name} fill="none" stroke={s.color} strokeWidth="2"
          points={rows.map((r, i) => `${x(i)},${y(r.values[j]!)}`).join(" ")} />)}
        {rows.length === 1 && series.map((s, j) =>
          <circle key={s.name} cx={x(0)} cy={y(rows[0]!.values[j]!)} r="3" fill={s.color} />)}
        {[...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])].map(i =>
          <text key={i} x={x(i)} y="163" textAnchor="middle">{rows[i]!.label}</text>)}
      </svg>
      <details><summary>View graph data (kW)</summary><div className="power-table-scroll"><table>
        <thead><tr><th>Time</th>{series.map(s => <th key={s.name}>{s.name}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><th>{r.label}</th>{r.values.map((v, j) => <td key={j}>{value(v)}</td>)}</tr>)}</tbody>
      </table></div></details>
    </> : <p className="muted">Samples will appear as the simulation runs.</p>}
  </section>;
}

export function PowerReport({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<PowerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/power", { signal: controller.signal });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const next = await response.json() as PowerData;
        if (!controller.signal.aborted) { setData(next); setError(null); }
      } catch (e) {
        if (!controller.signal.aborted) setError(`Power data unavailable: ${e instanceof Error ? e.message : "request failed"}. Retrying.`);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const s = data?.summary;
  return <dialog ref={dialog} className="power-report panel" aria-labelledby="power-title" onCancel={onClose}>
    <button className="close" aria-label="Close power report" onClick={onClose}>×</button>
    <div className="section-label">INFRASTRUCTURE · POWER</div>
    <h2 id="power-title">The city's electricity</h2>
    {error && <p role="alert" className="negative">{error}</p>}
    {!data && !error && <p role="status">Reading grid meters…</p>}
    {s && data && <>
      <div className="power-metrics">
        <div><small>DEMAND</small><strong>{value(s.demand)} kW</strong></div>
        <div><small>GENERATION</small><strong>{value(s.generation)} kW</strong></div>
        <div><small>UNSERVED LOAD</small><strong className={s.unserved > .01 ? "negative" : "positive"}>{value(s.unserved)} kW</strong></div>
        <div><small>STORED ENERGY</small><strong>{value(s.storage)} / {value(s.storageCapacity)} kWh</strong></div>
      </div>
      <div className="power-source-list">
        <span>Coal {value(s.coal)} kW</span><span>Nuclear {value(s.nuclear)} kW</span>
        <span>Solar {value(s.solar)} kW</span><span>Wind {value(s.wind)} kW</span>
        <span>Battery charging {value(s.charging)} kW</span><span>Battery supplying {value(s.discharging)} kW</span>
      </div>
      <p className="muted">{s.energizedGrids} of {s.grids} electrical islands energized. Each island must meet its own demand;
        surplus elsewhere cannot cross a missing connection. Whole buildings lose service when capacity runs out, with homes served first.</p>
      <PowerChart label="Daily cycle · current city's demand and generation"
        rows={data.daily.map(p => ({ label: p.minute === 1440 ? "24:00" : hour(p.minute), values: [p.demand, p.generation] }))}
        series={[{ name: "Demand", color: "#ffc276" }, { name: "Generation before batteries", color: "#99dfad" }]} />
      <p className="muted">A 24-hour projection for today's buildings and weather model, not recorded consumption.
        Solar peaks at noon and stops at night; wind varies day and night. Batteries and outages are excluded from this projection.</p>
      <PowerChart label="Recent operation · last 48 hours"
        rows={data.recent.map(p => ({ label: `D${Math.floor(p.time / 1440) + 1} ${hour(p.time % 1440)}`,
          values: [p.demand, p.generation, p.discharging, p.unserved] }))}
        series={[{ name: "Demand", color: "#ffc276" }, { name: "Generation", color: "#99dfad" },
          { name: "Battery supply", color: "#8bcdf1" }, { name: "Unserved", color: "#ef8b92" }]} />
      <PowerChart label="City growth · monthly total demand"
        rows={data.history.filter(p => p.powerDemand !== undefined).map(p => ({
          label: `Month ${p.month + 1}`, values: [p.powerDemand!, p.powerPeak!, p.powerCapacity!],
        }))}
        series={[{ name: "Daily average demand", color: "#ffc276" }, { name: "Daily peak demand", color: "#ef8b92" },
          { name: "Road-served nameplate capacity", color: "#99dfad" }]} />
      <p className="muted">Power balances every {data.stepMinutes} game minutes, with half-hour meter readings.
        Electrical time follows the visible day at every speed; pause freezes storage too.
        Batteries start empty, charge from surplus and supply shortfalls (92% efficiency each way).
        Facilities require an adjacent road.</p>
      <p className="muted">Roads and adjacent lots connect automatically. Use Power lines (L) to bridge gaps:
        aligned pylons span up to {data.lineSpan} tiles over open ground, roads or water; supports must be on dry empty land.</p>
    </>}
  </dialog>;
}

export function PowerStatus({ summary, onOpen }: { summary: PowerSummary | undefined; onOpen: () => void }) {
  return <section className="panel power-panel">
    <div className="section-label">POWER GRID <span className="badge">{summary && summary.unserved > .01 ? "SHORTFALL" : "LIVE"}</span></div>
    <div className="budget-row"><span>Demand / generation</span><span>{value(summary?.demand ?? 0)} / {value(summary?.generation ?? 0)} kW</span></div>
    <div className="budget-row"><span>Unserved demand</span><span className={summary && summary.unserved > .01 ? "negative" : ""}>{value(summary?.unserved ?? 0)} kW</span></div>
    <div className="budget-row"><span>Battery stored</span><span>{value(summary?.storage ?? 0)} kWh</span></div>
    <button className="power-open" onClick={onOpen}>Power grid &amp; graphs</button>
  </section>;
}
