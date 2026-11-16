import type { DesirabilityData, DesirabilityLot } from "./types";

export function DesirabilityInspector({ data }: { data: DesirabilityLot }) {
  return <div className="desirability-inspector">
    <h4>Desirability {data.score.toFixed(1)} / 100</h4>
    <p>Current conditions: {data.target.toFixed(1)}. Profile: {data.profile.replaceAll("_", " ")}.
      {data.updatedMonth === null ? " New lot; no monthly history yet." : ` Last monthly update: ${data.updatedMonth}.`}</p>
    <p>Category demand: {Math.round(data.demand)} / 100 (separate from location suitability).</p>
    {data.components.map(c => <div className="desirability-factor" key={c.label}>
      <div><strong>{c.label}</strong><span>{c.points > 0 ? "+" : ""}{c.points.toFixed(1)}</span></div>
      <small>{c.detail}</small>
    </div>)}
    <p>Contributions sum to the bounded conditions score. The monthly score moves 35% toward it; within 0.5 points it settles at the target.</p>
    <p>{data.eligible ? "Location and essential services permit growth. Demand, staffing, condition and the development cap still apply." : `Growth blocked: ${data.blockers.join("; ")}.`}</p>
    <p>{data.declining ? "Declining after sustained low desirability." : `${data.poorMonths} poor months accumulated.`} Below 40 for three monthly assessments triggers gradual losses; reaching 45 clears the counter.</p>
  </div>;
}

export function DesirabilityStatus({ data, onOverlay }: { data?: DesirabilityData | undefined; onOverlay: () => void }) {
  if (!data) return null;
  const lots = Object.values(data.lots);
  const average = lots.length ? lots.reduce((sum, r) => sum+r.score, 0)/lots.length : 0;
  return <section className="panel desirability-panel">
    <div className="section-label">NEIGHBOURHOOD DESIRABILITY</div>
    <div className="budget-row"><span>Average zoned lot</span><strong>{average.toFixed(1)} / 100</strong></div>
    <div className="budget-row"><span>Low suitability / declining</span><span>{lots.filter(r => r.score < 50).length} / {lots.filter(r => r.declining).length}</span></div>
    <p className="muted">Parks, jobs, commute and service reliability shape locations. Inspect a zoned lot for its score and growth blockers. Scores update monthly; actual service failures block growth immediately.</p>
    <button onClick={onOverlay}>Show desirability</button>
  </section>;
}
