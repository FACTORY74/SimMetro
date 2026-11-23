import type { DesirabilityLot, Tile } from "./types";

export interface TileAdvice { priority: number; action: string; reason: string }

/** Convert the tile's explainable score into ordered, concrete interventions. */
export function tileAdvice(data: DesirabilityLot, tile?: Tile): TileAdvice[] {
  const advice: TileAdvice[] = [];
  const add = (priority: number, action: string, reason: string) => advice.push({ priority, action, reason });
  if (data.blockers.includes("No road access")) add(100, "Connect this lot to a road", "Development cannot begin without adjacent road access.");
  if (data.blockers.includes("No power")) add(99, "Connect this lot to a powered grid", "Development is blocked until the tile has electricity.");
  if (data.blockers.includes("Water shortage")) add(98, "Extend a supplied water network here", "Development is blocked until its water demand is served.");
  for (const component of data.components) {
    const recovered = Math.abs(component.points);
    if (component.points < 0 && component.label === "Coal power station")
      add(90 + recovered, "Replace or relocate the nearby coal station", `Moving outside its impact radius recovers ${recovered.toFixed(0)} suitability points.`);
    else if (component.points < 0 && component.label === "Industrial nuisance")
      add(80 + recovered, "Separate this lot from manufacturing", `Relocate nearby manufacturing or choose a site farther away to recover up to ${recovered.toFixed(0)} points.`);
    else if (component.points < 0 && component.label === "Local workforce")
      add(85, "Add occupied homes on this road network", "This business area cannot find enough local workers.");
    else if (component.points < 0 && component.label === "Local jobs")
      add(85, "Add staffed businesses on this road network", "Nearby employment improves residential suitability.");
    else if (component.points < 0 && component.label === "Commute")
      add(70 + recovered, "Shorten or add capacity to commuter routes", `Current journeys cost ${recovered.toFixed(0)} suitability points.`);
    else if (component.points < 0 && component.label === "Power reliability")
      add(88, "Increase reliable generation or repair this grid", "Recent power shortfalls are reducing suitability.");
    else if (component.points < 0 && component.label === "Water reliability")
      add(88, "Increase connected water production or storage", "Recent water shortfalls are reducing suitability.");
  }
  const parks = data.components.find(c => c.label === "Parks");
  if (parks?.points === 0 && parks.detail.startsWith("0 "))
    add(45, "Add a road-accessible park within two tiles", "This profile can gain suitability from nearby parks.");
  for (const service of data.components.filter(c => ["Fire station", "Police station", "School"].includes(c.label) && c.detail.startsWith("Not covered")))
    add(35, `Add ${service.label.toLowerCase()} coverage`, service.detail);
  if (tile && tile.pollution >= 20)
    add(30, "Reduce local emissions or preserve more trees", `Pollution is ${tile.pollution.toFixed(1)} / 100; trees accelerate cleanup, though pollution does not yet alter suitability.`);
  return advice.sort((a, b) => b.priority - a.priority).slice(0, 4);
}
