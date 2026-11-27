import { useState, type ReactNode } from "react";
import { ADVISERS, adviserReports, type AdviserId } from "./advisers";
import { tileAdvice } from "./desirabilityAdvice";
import type { CityState, Tile } from "./types";

interface Speech { headline: string; detail: string; actions: { action: string; reason: string }[] }

function tileSpeech(id: AdviserId, tile: Tile, city: CityState): Speech {
  if (id === "planning") {
    const desirability = tile.desirability;
    if (!desirability) return { headline: "This tile is not zoned for development", detail: "There is no location-suitability assessment here yet. Zone the land if you want a development report.", actions: [] };
    const gap = Math.max(0, 50 - desirability.target);
    return {
      headline: gap ? `${desirability.profile.replaceAll("_", " ")} development is blocked here` : "This location is eligible for development",
      detail: gap ? `Current conditions are ${gap.toFixed(1)} points short of the growth threshold. City-wide demand is ${Math.round(desirability.demand)}, but demand cannot override this local score.` : "The local threshold is met. Demand, staffing and the monthly development roll determine what happens next.",
      actions: tileAdvice(desirability, tile),
    };
  }
  if (id === "finance") {
    const developed = tile.level > 0;
    return { headline: developed ? "This property contributes to the local economy" : "This tile is not producing taxable activity yet",
      detail: developed ? `It is development level ${tile.level}${tile.kind === "residential" ? ` with ${tile.residents} residents` : tile.workers ? ` with ${tile.workers} workers` : ""}. Condition and utility reliability determine whether that contribution lasts.` : "Servicing land creates future opportunity, but infrastructure upkeep begins before an empty zone produces revenue.",
      actions: developed ? [{ action: "Protect occupancy and condition", reason: "Reliable services and staffing preserve the economic return from existing development." }] : [{ action: "Avoid over-servicing unused land", reason: "Expand roads and utilities in step with demand and eligible zoning." }], };
  }
  if (id === "health") {
    if (tile.kind === "landfill") return { headline: (tile.trash ?? 0) >= 300 ? "This landfill is full" : "Landfill capacity is available",
      detail: `Stored trash: ${tile.trash ?? 0} / 300. A road connection is required for collection; stored waste leaks pollution into nearby land.`,
      actions: (tile.trash ?? 0) >= 300 ? [{ action: "Add another landfill tile", reason: "A full landfill cannot accept more waste." }] : [], };
    if (tile.trash) return { headline: "Trash is damaging this building",
      detail: `${tile.trash} units remain uncollected. The buildup lowers condition each month and can drive residents away.`,
      actions: [{ action: "Add connected landfill capacity", reason: "Collection needs road access on the same network." }], };
    return { headline: tile.pollution >= 20 ? "Local pollution is elevated" : tile.trees ? "Tree cover is improving local air quality" : "No immediate environmental warning",
      detail: `Pollution is ${tile.pollution.toFixed(1)} / 100 and this tile supports ${tile.trees} tree${tile.trees === 1 ? "" : "s"}. ${tile.waterService && tile.waterService.fraction < 1 ? "Water service is also incomplete." : "Pollution dissipates over time while the simulation runs."}`,
      actions: tile.pollution >= 20 ? [{ action: "Reduce nearby emissions", reason: "Coal, manufacturing and busy infrastructure are the strongest sources." }, { action: "Preserve or add trees", reason: "Each tree increases pollution removal on its square." }] : tile.trees ? [{ action: "Preserve this tree resource", reason: "Building here removes its additional pollution-cleaning capacity." }] : [], };
  }
  const capacity = tile.level ? tile.workers : 0;
  return { headline: tile.kind === "road" ? "This corridor carries city movement" : tile.kind === "industrial" ? "This industrial site depends on workers and freight access" : "This tile has no immediate industrial role",
    detail: tile.kind === "road" ? `Peak traffic is ${Math.round(tile.traffic)} vehicles. Use the traffic map to compare that with the road type's capacity.` : tile.kind === "industrial" ? `The site is development level ${tile.level}, currently employing ${capacity} workers. Its condition is ${tile.condition}%.` : `The city's industrial demand is ${Math.round(city.demand.industrial)} and average commute is ${city.avgCommute.toFixed(1)} minutes.`,
    actions: tile.kind === "road" && tile.traffic > 0 ? [{ action: "Check connected bottlenecks", reason: "Capacity failures often occur at junctions or on the next road type along the route." }] : tile.kind === "industrial" ? [{ action: "Keep workforce housing on this road network", reason: "Industrial growth and maintenance both depend on accessible workers." }] : [], };
}

export function TileInspectorDialog({ tile, city, metrics, onClose }: { tile: Tile; city: CityState; metrics: ReactNode; onClose: () => void }) {
  const [tab, setTab] = useState<"advisers" | "metrics">("advisers");
  const [selected, setSelected] = useState<AdviserId>("planning");
  const [scope, setScope] = useState<"tile" | "city">("tile");
  const adviser = ADVISERS.find(row => row.id === selected)!;
  const general = adviserReports(city)[selected];
  const speech = scope === "tile" ? tileSpeech(selected, tile, city) : { headline: general.headline, detail: general.detail, actions: [] };
  return <section className="panel inspect-dialog">
    <button className="close" aria-label="Close inspector" onClick={onClose}>×</button>
    <header><div><span>INSPECTING TILE {tile.x}, {tile.z}</span><h3>{tile.water ? "Open water" : tile.kind === "empty" ? "Undeveloped land" : tile.kind}</h3></div>
      <nav aria-label="Inspector sections"><button className={tab === "advisers" ? "selected" : ""} onClick={() => setTab("advisers")}>Advisers</button><button className={tab === "metrics" ? "selected" : ""} onClick={() => setTab("metrics")}>Metrics</button></nav></header>
    {tab === "metrics" ? <div className="inspect-metrics">{metrics}</div> : <div className="tile-adviser-layout">
      <aside className="tile-adviser-list" aria-label="Advisers">{ADVISERS.map(row => <button key={row.id} className={selected === row.id ? "selected" : ""} onClick={() => setSelected(row.id)}>
        <img src={row.image} alt="" /><span><strong>{row.name}</strong><small>{row.role}</small></span>
      </button>)}</aside>
      <div className="tile-adviser-conversation">
        <div className="advice-scope"><button className={scope === "tile" ? "selected" : ""} onClick={() => setScope("tile")}>This tile</button><button className={scope === "city" ? "selected" : ""} onClick={() => setScope("city")}>General advice</button></div>
        <div className="conversation-speaker"><div className="large-adviser-portrait"><img src={adviser.image} alt={`${adviser.name}, ${adviser.role} adviser`} /></div><span><strong>{adviser.name}</strong><small>{adviser.role}</small></span></div>
        <div className="conversation-bubble"><div className="adviser-kicker">{scope === "tile" ? `TILE ${tile.x}, ${tile.z}` : "CITY REPORT"}</div><h4>{speech.headline}</h4><p>{speech.detail}</p>
          {!!speech.actions.length && <><div className="adviser-kicker">WHAT I WOULD DO</div><ol>{speech.actions.slice(0, 4).map((item, i) => <li key={item.action}><span>{i + 1}</span><div><strong>{item.action}</strong><small>{item.reason}</small></div></li>)}</ol></>}
          {scope === "city" && <div className="general-metric">{general.metric}</div>}
        </div>
      </div>
    </div>}
  </section>;
}
