import { useState } from "react";
import type { CityState, Overlay } from "./types";

export type AdviserId = "planning" | "finance" | "health" | "industry";
type Tone = "good" | "watch" | "urgent";
interface AdviserReport { headline: string; detail: string; metric: string; tone: Tone; overlay: Overlay }
export interface Adviser { id: AdviserId; name: string; role: string; image: string }

export const ADVISERS: Adviser[] = [
  { id: "planning", name: "Mara", role: "City planning", image: "/city-adviser.png" },
  { id: "finance", name: "Elias", role: "Finance & economy", image: "/finance-adviser.png" },
  { id: "health", name: "Dr Amara", role: "Health & environment", image: "/health-adviser.png" },
  { id: "industry", name: "Kenji", role: "Industry & transport", image: "/industry-adviser.png" },
];

export function adviserReports(city: CityState): Record<AdviserId, AdviserReport> {
  const lots = Object.values(city.desirability?.lots ?? {});
  const unsuitable = lots.filter(lot => lot.score < 50).length, declining = lots.filter(lot => lot.declining).length;
  const net = city.income - city.expenses;
  const pollution = city.tiles.reduce((sum, tile) => sum + tile.pollution, 0) / Math.max(1, city.tiles.length);
  const polluted = city.tiles.filter(tile => tile.pollution >= 20).length;
  const trees = city.tiles.reduce((sum, tile) => sum + tile.trees, 0);
  const trash = city.tiles.reduce((sum, tile) => sum + (tile.kind === "landfill" ? 0 : tile.trash ?? 0), 0);
  const landfill = city.tiles.filter(tile => tile.kind === "landfill");
  const remaining = landfill.reduce((sum, tile) => sum + Math.max(0, 300 - (tile.trash ?? 0)), 0);
  return {
    planning: {
      headline: declining ? `${declining} neighbourhoods are declining` : unsuitable ? `${unsuitable} zoned lots need attention` : "Development locations look healthy",
      detail: declining ? "Inspect the lowest-scoring lots first. Essential services and large land-use penalties should be resolved before adding more zoning." : unsuitable ? "Demand alone cannot develop unsuitable land. Use the desirability map and inspect individual blockers." : "Serviced land is locally eligible; new development now depends on demand and monthly growth rolls.",
      metric: `${unsuitable} below 50`, tone: declining ? "urgent" : unsuitable ? "watch" : "good", overlay: "desirability",
    },
    finance: {
      headline: net < 0 ? "The monthly budget is in deficit" : "The monthly budget is sustainable",
      detail: net < 0 ? "Pause optional construction and grow serviced taxpayers before taking on more upkeep." : city.money < city.expenses * 3 ? "The budget balances, but reserves cover less than three months of upkeep." : "Current revenue covers upkeep with a useful operating margin.",
      metric: `${net >= 0 ? "+" : "−"}$${Math.abs(net).toLocaleString()}/month`, tone: net < 0 ? "urgent" : city.money < city.expenses * 3 ? "watch" : "good", overlay: "zones",
    },
    health: {
      headline: trash ? `${trash.toLocaleString()} trash units are uncollected` : polluted ? `${polluted} tiles have elevated pollution` : "Air quality is currently good",
      detail: trash ? `Add road-connected landfill capacity. ${remaining.toLocaleString()} units remain; accumulated trash damages buildings.` : polluted ? "Reduce the strongest emitters and preserve woodland near affected neighbourhoods. Trees accelerate local dissipation." : "Pollution remains low. Existing trees are providing ongoing environmental capacity.",
      metric: trash ? `${trash.toLocaleString()} backlog · ${remaining.toLocaleString()} capacity` : `${pollution.toFixed(1)} avg · ${trees.toLocaleString()} trees`, tone: trash ? "urgent" : polluted > 30 ? "urgent" : polluted ? "watch" : "good", overlay: trash ? "trash" : "pollution",
    },
    industry: {
      headline: city.congested ? `${city.congested} road tiles are congested` : city.vacancies > city.workforce ? "Employers need a larger workforce" : "Industry and transport are moving",
      detail: city.congested ? "Inspect the traffic layer for overloaded corridors before adding more jobs to the same road network." : city.vacancies ? "Add occupied homes to employer road networks and keep commutes practical." : "Current networks are carrying workers and freight without recorded congestion.",
      metric: `${Math.round(city.demand.industrial)} demand · ${city.avgCommute.toFixed(1)} min`, tone: city.congested ? "urgent" : city.vacancies ? "watch" : "good", overlay: "traffic",
    },
  };
}

export function AdviserPanel({ city, onOverlay }: { city?: CityState | undefined; onOverlay: (overlay: Overlay) => void }) {
  const [selected, setSelected] = useState<AdviserId>("planning");
  if (!city) return null;
  const reports = adviserReports(city), adviser = ADVISERS.find(row => row.id === selected)!, report = reports[selected];
  return <section className="panel adviser-board">
    <div className="section-label">CITY ADVISERS <span className={`adviser-status ${report.tone}`}>{report.tone}</span></div>
    <div className="adviser-roster" role="tablist" aria-label="City advisers">
      {ADVISERS.map(row => <button key={row.id} role="tab" aria-selected={selected === row.id}
        className={selected === row.id ? "selected" : ""} title={`${row.name} · ${row.role}`} onClick={() => setSelected(row.id)}>
        <img src={row.image} alt="" /><span>{row.name}</span>
      </button>)}
    </div>
    <div className="adviser-board-report">
      <div className="adviser-board-heading"><img src={adviser.image} alt={`${adviser.name}, ${adviser.role} adviser`} />
        <div><strong>{adviser.name}</strong><small>{adviser.role}</small></div></div>
      <div className="adviser-board-speech"><strong>{report.headline}</strong><p>{report.detail}</p>
        <div><span>{report.metric}</span><button onClick={() => onOverlay(report.overlay)}>Show map</button></div></div>
    </div>
  </section>;
}
