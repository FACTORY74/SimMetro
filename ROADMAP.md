# SimMetro: feature inventory and progression timeline

## Goal and scope

Build an original city simulator with the systemic depth of SimCity 4, using our
own code, buildings, plants, UI, and other assets. "SC4-style parity" below means
comparable playable systems, not identical algorithms, binary save compatibility,
or copied copyrighted content. Include Rush Hour-style transport depth in the
target; label extensions beyond that separately.

This is the planning baseline, not a claim that the listed features already
exist. The timeline is ordered by dependencies and playable outcomes, not
calendar dates. Delivery dates require measured development capacity, asset
production throughput, and benchmark results; this is a substantial multi-release
project, not a short patch.

## Where we are now

**Planning revision: 14 November 2026.** P0 is playable; parts of P1, P2,
P3, P4 and P8 already exist. The P-numbers remain feature-area references, not
an instruction to finish every item in one phase before starting the next.
The release sequence below is the implementation priority.

**Current delivery:** R1 water-facility foundations and R2 core water supply are
implemented: rotated footprints/entrances, independent pipes, pumps/towers,
shortages, inspection/overlay, v7 migration, named saves, three rotating autosaves,
and water-aware autoplay. Existing power facilities retain their single-tile
schema; adjustable facility funding and broader shared civic allocation remain
future extensions. Browser visual verification is still outstanding because the
available computer-use runtime blocked browser control. **R3a is now implemented:** shared per-use desirability, named contribution
breakdowns, commute feedback, reachable parks, monthly service reliability,
smoothed growth/decline/recovery, inspection/overlay and v8 persistence.
**Next: R3b**, air/noise fields and water-quality/treatment.

- Streamed 256 x 256 districts with seeded world-coordinate gradient-Perlin
  terrain, naturally generated from -12 to +32 levels and editable from -32 to +96:
  sea, lakes, beaches, hills, and peaks. Slopes are limited to one level per tile.
- Raise and lower terrain tools with automatic slope cascades that protect
  development. Water is any tile below sea level.
- Perspective Three.js renderer, camera orbit/pan/zoom and keyboard panning,
  height-aware ray picking.
- Art style "SC4 without textures": continuous faceted terrain with flat
  plateaus and ramps between levels. Roads and lots are painted onto the
  surface, so roads climb hills, at most one level per tile. Buildings have
  foundations on slopes.
- Shared flat-color materials and instanced procedural buildings and trees.
- Local road networks serve adjacent zones without district-edge connections.
- Streets, local roads, avenues and express roads have distinct construction and
  upkeep costs, routing speeds, capacities and surface colours. Existing roads
  can be replaced in place; old saves retain local roads.
- Residential, commercial, and industrial zones with up to four growth levels and
  subtypes: low/medium/high-density housing; retail, office and entertainment
  commerce; manufacturing, high-tech and farming industry. Subtypes set level
  caps, jobs per level, shift patterns and smoke.
- Connected electrical grids with automatic road/lot distribution and power-line
  pylons spanning up to eight tiles. Coal/nuclear supply, daily solar output,
  weather-dependent wind, battery storage, capacity shortages and darkened lots.
- Power inspection, live source/load/storage totals, daily demand/generation
  projections, 48-hour meter history and monthly total demand graphs.
- Residential occupancy fills gradually according to local desirability; aggregate
  jobs, basic demand, tax income, and infrastructure upkeep.
- 69 zone/power building archetypes plus pump and tower models across zones, subtypes and growth levels,
  including five utility models, plus pylons and wires. They have distinct silhouettes,
  storey-by-storey facades (lit windows by use, balconies, shopfronts, curtain
  walls), seeded palettes and orientations.
- A showcase camera that orbits the view for recording, with the zoom centred on
  the starting distance.
- Aggregate hiring within connected road networks, employment/vacancy reporting,
  workforce-gated business growth and condition-scaled business taxes.
- Understaffed businesses deteriorate visibly, become derelict and recover when
  workers return. Saves v8 persist water infrastructure plus desirability scores, decline
  counters and partial service samples; v2-v7 saves migrate, with 24 months of water grace when infrastructure is absent.
- Road-reachable parks with capped use-specific amenity effects; desirability
  inspection, overlay and summary. Parks do not yet have visitor capacities.
- Pause, live Day mode (one day per minute) and 1×/3× speeds, a time-of-day
  clock with day/night lighting, population history, named manual saves and three rotating autosave slots.
- Daily trip plan: home-to-work matching and road routes per network, shift
  times, shopping and freight trips, per-road volume/capacity, BPR congestion
  and commute times with congestion-aware route splitting. A car-following
  micro-sim with lanes, junction priority and queues, a traffic-volume
  layer and inspectable daily routines.
- Deterministic simulation and validated, all-or-nothing building commands.
- Continuous stress autoplay for one district: large connected neighbourhoods,
  all implemented construction types, no population cap, reserve-only spending,
  workload timings and catalogue coverage; optional targeted growth mode;
  a seeded headless runner exports monthly reports, commands and loadable saves.

**Important simplifications:** no lane changing or transit. Commute times now
affect suitability and growth, but do not yet limit job matching.
No water quality/treatment, wealth classes, land-value effects, rivers, bridges,
or civic/waste service simulation. Water supply and finite storage are implemented.
Hiring has no individual agents, education matching or commute-time limits yet.
Building levels are not a complete development model. Desirability now controls
growth eligibility, arrivals and gradual losses using separate use profiles;
happiness, land value, pollution transport and wealth transitions remain planned. Python runs in one process; full snapshots are
polled rather than streamed as chunk deltas.

## Full feature inventory

Everything below is **planned** unless explicitly identified above. P-numbers
refer to the delivery timeline. Each simulated system needs construction and
demolition tools, costs/upkeep, meaningful capacity constraints, overlays,
inspection/explanations, statistics, persistence, and deterministic tests.

### World, terrain, and natural environment [P1, P2, P8]

- Seeded heightmaps; terrain levels, hills, valleys, cliffs, coastlines, rivers,
  lakes, sea level, and drainage-aware water placement.
- Raise/lower, flatten, smooth, slope, and brush tools with price previews.
- Terrain-following roads and buildings; slope limits, foundations, retaining
  walls, cut/fill, bridge clearances, and tunnel portals.
- Regional map creation, city boundaries, different city sizes, terrain import
  and export through a documented format.
- Biomes, fertile land, forests, tree planting, and species distributions.
- Terrain changes must reconcile occupied lots, utility networks, and roads
  without leaving floating buildings or disconnected hidden edges.

### Construction, zoning, and development [P1, P4, P7]

- Low/medium/high-density residential and commercial zoning; industrial and
  agricultural zoning, de-zoning, lot subdivision and consolidation.
- Lot footprints, frontage, entrances, orientation, setbacks, street access,
  occupancy, capacity, construction time, and visible construction stages.
- Residential wealth tiers; commercial service/office types and wealth tiers;
  agriculture, dirty industry, manufacturing, and high-tech industry.
- Demand by development category, workforce qualifications, regional demand,
  unlocks/caps, and constraints on redevelopment.
- Desirability, vacancy, abandonment, dilapidation, demolition, rehabilitation,
  displacement, and historical/preserve-building controls.
- Rectangle/brush/line tools, rotation, placement validity, estimated costs,
  reversible construction commands where simulation consequences permit.
- Named streets, districts and buildings; development controls and useful
  growable-versus-ploppable distinctions.

### Electricity [P2]

- Power lines, poles, substations, connected network components, local
  distribution, and isolation when a line is cut.
- Generation versus demand, output capacity, load growth, plant age/condition,
  maintenance funding, outages, and brownouts.
- Distinct original coal, gas, oil, waste-to-energy, wind, solar, and nuclear
  facilities; hydropower only where terrain/water rules support it.
- Plant-specific costs, footprints, emissions, staffing, lifespan, and risk.
- Regional electricity purchase/sale, interconnect capacity, and contracts [P8].
- Coverage/connectivity, load, generation, and outage overlays; power-line
  crossings and building/service consumption.

### Water and waste [P2, P5]

- Underground pipes, pumps, water towers, reservoirs, treatment plants, and
  network connectivity/capacity.
- Water availability, consumption, shortages, water quality, groundwater
  contamination, and pumping penalties near pollution.
- Water infrastructure age, funding, failures, and pipe-burst incidents.
- Landfills with finite capacity, garbage collection/access, recycling, waste
  reduction, and incineration/waste-to-energy tradeoffs.
- Water import/export deals and landfill/waste contracts [P8].
- Explicit scope extension: hydraulic pressure, sewage pipes, and stormwater
  can be added later; they are not prerequisites for an SC4-style water model.

### Transport, traffic, and commuting [P3, P8]

- Streets, roads, avenues, one-way roads, highways, ramps, intersections,
  crossings, bridges, tunnels, and grade-separated junctions.
- Directed, mode-aware network graphs with speed, capacity, length, turn costs,
  access restrictions, intersections, and congestion penalties.
- Household-to-job matching; walk/drive/transit mode choice; complete commute
  routes and door-to-door travel times, transfers, and failed trips.
- Travel-time feedback into employment, demand, desirability, and abandonment;
  congestion must not be just a decorative car counter.
- Buses and stops, passenger rail, elevated rail, subway, monorail, stations,
  interchanges, park-and-ride facilities, and parking/access rules.
- Freight routes from farms/industry, trucking, freight rail and stations,
  seaports, airports, ferries, and external connections.
- Transit fares, operating budgets, service capacity, station catchments, and
  network upgrades.
- Route query tools, traffic volumes, congestion, commute-time distributions,
  mode shares, and freight-access overlays.
- Sampled visual cars, buses, trains, ships, and pedestrians driven by simulation
  outputs; rendering agents must not be the authoritative economic simulation.
- Regional commuting and freight must resolve cross-city destinations without
  cyclic "infinite commuter" loops [P8].

### Population, economy, finance, and government [P4, P8]

- Households/cohorts, age distribution, birth/death rates, migration, employment,
  unemployment, income/wealth, education, and health.
- Labour markets by qualification, job vacancies, business occupancy, and
  economic transitions rather than guaranteed perpetual growth.
- Residential, commercial and industrial tax rates by relevant classes;
  operating/capital budgets, facility funding, loans, interest, debt, and
  bankruptcy/recovery rules.
- Ordinances, incentives, policy costs and effects; civic strikes and service
  degradation from underfunding.
- Balanced regional trade, business demand, agricultural/freight access and
  neighbour deals rather than invented money from circular transactions.
- Mayor rating, petitions/adviser warnings, milestones and reward eligibility;
  transparent explanations of what changed and why.

### Education and healthcare [P5]

- Elementary/high schools, libraries, colleges/universities, museums, and
  distinct capacities, catchments, staffing, and funding.
- Enrolment by age cohort, attendance/accessibility, graduation, education
  accumulation over time, and education-to-workforce feedback.
- Clinics/hospitals, patient capacity, coverage, funding and health outcomes.
- Healthcare and pollution effects on life expectancy, population and
  desirability; shortages and overcrowding visible to the player.

### Crime, policing, fire, and emergencies [P6]

- Crime risk influenced by population, wealth/employment, education, and
  policing; separate risk, incidents and resolved cases.
- Police stations, precincts, patrol reach, capacity, funding, dispatch, jails
  and prisons.
- Fire stations, coverage and reachable response times; risk from building
  type, condition, density, industry, and vegetation.
- Incidents, emergency vehicles, fire spread, damage, suppression, recovery,
  and reconstruction; street connectivity affects actual response.
- Event/alert queue, actionable dispatch controls and incident inspection.

### Happiness, land value, pollution, and city environment [P4, P5, P6]

- Household happiness and mayor approval are distinct from land value and
  development demand; each needs an explainable component breakdown.
- Land value/desirability from access to jobs, commute times, services, parks,
  waterfronts, terrain, pollution, taxes, and nearby nuisances.
- Air pollution sources, spatial transport/decay, traffic emissions, plant and
  industrial emissions; water contamination; garbage and noise effects.
- Parks, plazas, sports grounds, recreation, trees and green belts with
  measurable effects, maintenance and accessibility.
- Environmental overlays with units, sources, trends, and mitigation options;
  avoid a single unexplained "happiness number."
- Feedback loops must remain stable: clean, educated neighbourhoods can attract
  higher-value development, but not without demand and service capacity.

### Farms and crops [P4, P7]

- Agricultural zoning, contiguous farm lots, farmhouses, barns, silos,
  greenhouses, orchards, pasture and field layouts.
- Multiple original crop types and plant stages; field variation and farm jobs.
- Agricultural desirability, fertility, pollution sensitivity, freight access,
  production and operating economics.
- Scope extension beyond core parity: seasonal sow/grow/harvest cycles, yield
  simulation, irrigation, livestock, and weather-driven crop failure.

### Special buildings, rewards, and disasters [P7, P8, P9]

- Original civic centres, city hall, courthouses, libraries, museums, universities,
  stadiums, convention centres, landmarks and tourist attractions.
- Reward buildings gated by population, finances, services, approval, or
  industries, with ongoing effects and costs.
- Business deals and facilities such as prisons, military installations, and
  research centres, each with explicit benefits and externalities.
- Ports, airports, major passenger hubs, utilities and other multi-tile
  facilities with network entrances and upgrade paths.
- Fire, earthquakes, tornadoes, meteors, and volcanic events; damage to terrain,
  buildings and networks, emergency response and recovery. Floods may be an
  original extension where the water model supports them.
- Disaster sandbox controls and an option to disable random disasters.
- Optional SC4-inspired mission/vehicle-control activities only after the core
  city systems work; not a substitute for systemic traffic and services.

### Building, plant, and visual diversity [P1 onward; concentrated in P7]

- Owned parametric asset definitions: dimensions, footprints, entrances, growth
  categories, materials/colors, capacities and seeded variations.
- Small homes, rowhouses, apartments, towers, shops, offices, warehouses,
  factories, farms and all civic/infrastructure categories.
- Multiple architectural families and eras; roofs, facades, setbacks, courtyards,
  street furniture, construction sites and abandonment variants.
- Several trees, shrubs, flowers, hedges, grasses, crops and orchard species;
  mature/young forms and biome-appropriate placement.
- All assets use geometry, vertex colors and shared flat-color materials,
  **not image textures**.
- Generator previews, asset catalogue, validation of footprints/entrances,
  OBJ/MTL export for editing and GLB for optional runtime delivery.
- Instancing, chunk batches, distance-based detail, culling, streaming, and
  variation rules to prevent obvious repetition.
- Day/night lighting, emissive geometry windows, seasons and optional weather,
  animation, soundscape and accessibility-friendly visual modes.

### Region, tools, UX, persistence, and engineering [P1 onward, P8, P9]

- Region view with connected cities, shared terrain boundaries, inter-city
  utilities, commuters, freight and compatible simulation clocks.
- Multiple named saves, autosave, versioned migrations, recovery/backups,
  import/export, save thumbnails and reproducible seeds.
- Command journal, sequence IDs, deterministic replay, diagnostics and
  safe handling of incompatible/corrupt saves.
- Overlays, legends and units; long-term charts; city budget/ordinance panels;
  facility queries; minimap; notifications; tutorials and contextual help.
- Keyboard remapping, touch support, readable UI scale, color-blind-safe
  overlays, sound controls and performance settings.
- Headless benchmark worlds and profiler instrumentation; dense field arrays;
  chunk ownership and halo exchange; multi-rate deterministic simulation.
- Persistent CPU worker processes with shared-memory input/output buffers,
  bounded scheduling and explicit barriers for global reductions.
- Incremental transport graphs, chunk delta delivery, client resynchronization,
  renderer LOD and budgets; avoid serializing the whole region every tick.
- Balance/scenario tests, long simulations, save-migration tests, network
  invariants, race/determinism checks, accessibility and browser compatibility.
- Data-driven configuration and a documented asset/scenario/mod interface;
  untrusted executable mods and online multiplayer are not core parity goals.

## Implementation strategy

Build a city-management loop before expanding the transport catalogue: residents
and businesses consume services, failures have visible consequences, the player
can diagnose and fix them, and the budget reflects those choices. Each release
must leave a playable city, with original procedural models and working UI.

Keep three concepts separate:

- **Demand:** how much residential or business expansion the economy supports.
- **Desirability:** how suitable a particular location is for a particular use.
- **Service eligibility:** whether a lot has the access and essential supply
  required to operate or develop. A park bonus cannot cancel a water outage.

Use aggregate households, demand and service assignments initially. Individual
citizen agents, realistic hydraulics, a complete cohort model and process workers
are not prerequisites for water, garbage or useful civic buildings.

## Ordered playable releases

Release IDs R1-R10 define work order; P references map to the inventory above.
All releases include costs, inspection, overlays, persistence and targeted tests.
No dates are promised until the first slices have measured delivery times.

| Release | Player-visible outcome | Prerequisites | Completion scenario |
| --- | --- | --- | --- |
| **R1 - Facility and service foundations (water slice implemented)** [P1/P2] | Reliable facility placement, entrances, operating state and itemised costs; named saves and autosave protect growing cities. | Existing construction, power and roads. | Place, rotate, save, reload and demolish a multi-tile test facility; blocked footprints spend nothing and demolition clears every occupied cell. |
| **R2 - Water supply (core implemented)** [P2] | Build a powered pump, pipes and a tower; connect neighbourhoods and manage shortages. | R1 facility records and underground network layer. | Cut a pipe to isolate one neighbourhood, exhaust its stored water, then reconnect it; supply, consumption, storage and money reconcile. |
| **R3 - Desirability and environmental feedback** [P3/P4] | Inspect why a location grows or declines; parks, pollution, jobs, commute and service reliability matter. | R2 service results and existing commute data. | A polluted or poorly served home loses attractiveness and eventually occupants; fixing the cause produces gradual recovery. |
| **R4 - Waste collection and disposal** [P2/P5] | Place a landfill and collection depot, manage accumulated rubbish, add recycling. | R1 facilities, road reachability, R3 nuisance fields. | Cut a collection route or fill a landfill: rubbish accumulates, desirability falls, and restoring capacity clears the backlog over time. |
| **R5 - Civic services** [P5] | Clinics, schools, libraries and maintained recreation serve reachable residents within capacity and funding. | R1 allocation framework, R3 outcomes; R4 gives a complete basic-service city. | Two neighbourhoods compete for limited school/clinic capacity; adding a reachable facility or funding improves actual service, without double-counting residents. |
| **R6 - Special buildings and city identity** [P7] | City hall, civic plaza, museum, stadium and research campus have explicit unlocks, costs and effects. | R1 multi-tile lots, R3 desirability, R5 service/education measures. | Earn an unlock, inspect its conditions, place its reward once where appropriate, and verify its operating costs and capped effects survive reload. |
| **R7 - Economy and development depth** [P4] | Wealth/qualification categories, redevelopment, useful taxes and loans, and contraction/recovery. | Stable R2-R6 service and desirability feedback. | A city can decline and recover without unlimited growth, instant education or circular job creation. |
| **R8 - Safety and transport expansion** [P3/P6] | Police/fire services and incidents; then buses, bridges, one-way roads and rail as separately gated slices. | R5 service allocation, R7 risk inputs; directed graphs before one-way networks. | Emergency reach follows real roads; a bus corridor reduces car trips while conserving commuters; bridges respect terrain and clearance. |
| **R9 - Connected regional economy** [P8] | Cross-district utilities, commuting, freight, contracts, ports and airports. | Stable local systems and measured scale budgets. | Imports equal exports, jobs cannot be filled twice, disconnected borders break service correctly, and save/reload preserves contracts. |
| **R10 - Breadth, scenarios and resilience** [P7/P9] | More assets, disasters, recovery, tutorials, accessibility, balance and supported extension interfaces. | R1-R9 core scenarios. | Long-running and damaged cities remain recoverable; inventory and performance audits pass without placeholder systems. |

### R1: shared foundations, kept deliberately small

Introduce a facility definition catalogue and separate placed facility records:
ID, type, anchor, rotation, footprint, road entrance, network connectors, build
cost, upkeep, capacity, funding and operating status. Occupied tiles reference a
facility ID; one facility is charged and simulated once, regardless of footprint.
Existing single-tile power plants remain valid through a migration adapter.

Add underground infrastructure as a separate layer, starting with pipes. A pipe
can coexist with a road or building; the active layer determines what a bulldoze
command removes. Validate complete footprints and network edits atomically.
Do not encode every service as another one-character surface tile kind.

Define common service results (requested, served, unmet, provider and reason),
facility inspection and budget categories. Reuse those interfaces, but keep the
water graph, road collection and civic catchments as distinct algorithms.
Extract new modules from `backend/simulation.py`; avoid a speculative universal
simulation framework. Add named saves, bounded rotating autosaves and migration
fixtures before new failures can destabilise an established city.

**Gate:** footprint/rotation/entrance invariants, atomic construction, independent
surface/underground deletion, save migration and basic frame/tick measurements.
A facility test fixture validates the machinery; do not ship a placeholder civic
building as a completed system. Water provides its first new playable use in R2.

### R2: water as the next functional system

- Begin with a groundwater pump on dry land, an explicitly documented abstraction
  of available groundwater, a water tower with finite storage, and underground
  pipes. Power and road access are required for operating facilities.
- Pipes form independent connected components; a documented short service radius
  connects nearby lots. Each lot belongs to one component with deterministic
  tie-breaking, so overlapping coverage cannot duplicate supply.
- Define consistent units: supply/consumption in cubic metres per game day,
  storage in cubic metres. Demand comes from occupied homes, staffed businesses
  and operating facilities; apply deterministic shortage allocation.
- Integrate production and consumption over elapsed game time. Storage smooths
  outages but cannot create water. Save stored volumes; do not recalculate them
  from capacity on load. Offscreen batching must preserve the same balance.
- Show pipe connectivity, supply coverage, delivered fraction and shortage cause;
  inspect power failure, disconnection and inadequate production separately.
- Gate new development on water and apply gradual consequences to established
  buildings. Ship a serviced starter town. For old saves, provide an explicit,
  finite migration grace period with a visible countdown and setup guidance;
  sandbox may offer a clearly labelled opt-out. Persist the grace state.

Defer pressure simulation, sewage, bursts and plant ageing. Treatment and water
quality follow R3 pollution fields; source extraction limits can follow without
changing the storage and consumption contract.

### R3: explainable desirability, pollution and growth

Replace the current inline residential move-in rule with one shared calculation
used by simulation and inspection. Return named contributions, not only a score:
road/job access, commute, power and water reliability, parks, air pollution,
noise, terrain/waterfront amenity and nearby facility nuisances. Introduce only
inputs backed by a working system; add waste and civic factors in R4/R5.

Start with separate residential, commercial and industrial suitability profiles.
Industry tolerates different nuisances from housing; high tech and farming need
cleaner conditions. Keep initial weights in a versioned balance configuration.
Use bounded scores, smoothing, thresholds and recovery delays to prevent a
single bad tick from causing an abandonment cascade.

Implement air pollution and noise as bounded spatial fields with documented
source strengths, distance falloff and decay. These are gameplay indices, not
claims of physical concentration. Industry, plants and traffic contribute;
parks provide capped local amenity rather than magically deleting emissions.
Add contamination and treatment as a follow-up R3 slice before water quality
penalties are enabled. Garbage pollution arrives with actual waste in R4.

First use desirability to govern move-in, move-out and growth eligibility while
keeping demand and infrastructure gates separate. Derive and display land value
as a distinct smoothed measure; defer wealth transitions and land-value taxation
to R7. Never feed land value back into its own desirability calculation.

**Gate:** controlled park, pollution, commute and supply experiments change the
relevant contributions and outcomes; overlays match inspection; growth respects
vacancies and capacity; saves reproduce decline and recovery.

### R4: garbage is a flow and a finite stock

Track waste generated per lot, uncollected backlog, collected quantity, recycled
quantity and disposed quantity. Use tonnes and tonnes per game day consistently.
Landfills have remaining lifetime space as well as daily intake capacity.
Recycling has processing throughput and a residual stream that still needs
disposal; it must not silently erase all incoming waste.

A collection depot has daily collection capacity and a road-reachable service
area. A usable disposal destination must also be reachable. Assign capacity
without serving the same lot twice. Start with aggregate routing/access costs;
visible garbage trucks are sampled feedback, not the source of truth. An isolated
or full landfill cannot accept collection merely because a depot exists.

Accumulated rubbish creates local nuisance and a desirability penalty. Collection
reduces backlogs at its actual rate after service returns. Landfills create
pollution and incur upkeep; closing one retains its filled stock and nuisance
until a defined remediation process completes. Bulldozing cannot reset waste.

**Gate:** generated waste equals the change in backlogs plus recycled/disposed
waste over each interval; capacity, storage, road cuts, underfunding, landfill
closure and save/reload are tested. Add waste-to-energy only after residual waste
and electrical output can be accounted for together.

### R5-R6: services and special buildings with real purposes

Bring new buildings in with the systems they support, rather than postponing all
content until P7. R2 supplies pumps/towers, R4 supplies depots/landfills/recycling,
and R5 supplies clinics, schools, libraries and recreation. Use small original
procedural asset families for each release.

Civic facilities combine road-reachable catchments, demand, capacity and funding.
Coverage is not the same as service: being inside two catchments does not create
two patients or students. Start with aggregate eligible residents; education and
health change slowly. Detailed age cohorts can be introduced in R7, with a
migration for accumulated educational/health state.

| Special building | First release | Initial role and constraint |
| --- | --- | --- |
| Clinic, school, library | R5 | Capacity-limited health/education services with upkeep; no instant workforce qualification. |
| Civic plaza / larger park | R5 | Maintained, reachable amenity with capped overlapping effects. |
| City hall | R6 | Population-and-budget milestone; modest capped civic amenity, upkeep and unique-per-city placement. Basic management UI remains available without it. |
| Museum | R6 | Cultural amenity and education support, limited by service reach and funding. |
| Stadium | R6 | Recreation/event attraction with upkeep, noise and additional trip demand; delay events until those trips are represented. |
| Research campus | R6 foundation / R7 full effect | Education-linked reward; qualification-dependent jobs activate only when the labour model supports them. |
| Port, airport, major freight hub | R9 | Regional freight/passenger capacity; no arbitrary demand bonus before external destinations exist. |

Unlock conditions must be inspectable before purchase. Distinguish eligibility
from ongoing operation, define which rewards are unique, and persist awarded
status. Avoid uncapped overlapping bonuses or a requirement to own a reward
building to solve a basic utility failure.

### What we should implement next

1. **R1a (water slice implemented):** facility/footprint records, independent pipe layer, atomic commands,
   migration fixtures, service-result contract and baseline measurements.
2. **R1b (implemented):** facility inspection/budget grouping, named saves and rotating autosaves.
3. **R2a (implemented):** pump, pipes, connected supply/demand, water overlay and starter/save transition.
4. **R2b (implemented):** tower storage, outage/shortage behaviour and offscreen balance tests.
5. **R3a (implemented):** shared desirability breakdown, parks, commute and supply reliability;
   gradual move-out/recovery and suitability overlay.
6. **R3b (next):** air/noise fields, nuisance sources and water-quality/treatment slice.
7. **R4a:** landfill, depot, generation/backlog, road reachability and finite disposal.
8. **R4b:** recycling, funding controls, closure/remediation and waste dashboard.
9. **R5:** clinic, school, library and recreation, one validated service at a time.
10. **R6:** milestone/unlock framework and the first complete civic rewards.

Per-road grade limits, auto-grading, retaining walls and richer transit remain
planned, but do not block water or waste. Fix placement/terrain defects when
found; avoid turning all remaining P1 work into a prerequisite. Region rendering
already exists; regional economic connectivity does not. Do not rebuild the
former or imply the latter is complete.

## Simulation integration and release rules

- Use explicit schedules: utility flow/storage over elapsed game time; waste
  collection and service allocation on a documented daily schedule; growth,
  education, health and budgets on monthly schedules. UI frames never drive
  authoritative service outcomes.
- Define phase order and use previous committed values to break cycles. For
  example, operating demand uses committed occupancy; power dispatch precedes
  powered pumping; waste and service results feed environmental/desirability
  updates; growth commits occupancy for the next interval. No same-tick circular
  recalculation until a city happens to stabilise.
- Recompute connectivity after network edits; cache catchments and dirty spatial
  fields. Avoid a full-map scan per facility or a route search per resident.
- Initially keep systems district-local, matching roads and power. Indicate
  unsupported border connections in the UI. Every service definition must state
  its future regional boundary inputs/outputs without pretending they exist now.
- Extend the autoplay policy alongside each mandatory service (water, waste,
  civic needs). Keep fixed-seed starter and empty-city runs as development
  scenarios; report target attainment, wait reasons, treasury and service deficits.
  Autoplay must use normal commands and never hide failures by granting resources.
- Every release covers focused and offscreen districts, pause/speed changes,
  fractional elapsed time, and save/reload. Batching must conserve water, waste
  and money; document any approximation in timing or allocation.
- Add bounded history and alerts with actionable causes. Do not send every
  derived field for every tile on every poll; use on-demand overlays or revised
  compact state fields, then measure payloads before changing the transport.
- A save migration must specify defaults, derived-state rebuilds and transition
  policy. Never load an established city into immediate mass abandonment because
  a newly introduced mandatory service did not exist in its save.
- Run a small connected town, a disconnected neighbourhood, a capacity-starved
  dense district and a multi-district/offscreen scenario for each new service.
  Follow with long-run balance scenarios before enabling harsher decline rules.

### Continuous stress autoplay (current default)

- `continuous-stress-v5` spends above the construction reserve without population, inventory or monthly gates. Large connected neighbourhoods exercise all implemented construction variants.
- Live construction yields between commands (four per update, soft 50 ms budget). The dashboard reports construction/simulation times, queued work and missing catalogue types.
- Repeatable isolated runs accept an explicit initial treasury and command workload, recording complete commands, road/zone counts and simulation p95. No live grants; operating costs can cross the construction reserve.
- One-district terrain limits remain explicit; automatic regional expansion and multicore simulation are separate future work.
- Wealthy stress validation: seed 42, $2.7m initial treasury, $5,001 reserve, 128 commands/month for 12 months produced 20,257 road tiles and 26,838 zoned tiles, covering all implemented types. Construction spent $1,640,337 across 1,408 commands. Simulation p95 was 2,258 ms per headless month on this machine. Operating losses subsequently drove the treasury negative: this exposes the cost of rapid unoccupied sprawl; the construction reserve is not an operating solvency guarantee. Report/save: `runs/stress-v5-wealthy/`.

### Assertive autoplay validation record (retained growth mode)

- Policy `assertive-blocks-v4` replaces two-lot zoning and the 96-place housing
  wait threshold with neighbourhood batches and a larger prospective pipeline.
- Roads form connected 12-by-6 blocks with a central street; blocked/wet layouts
  are rejected without demolition. Affordable expansion opens ahead of zoning.
- Reserve and six-month operating runway remain; full blocks also reserve $1,000
  plus pipe costs for servicing. Autoplay stops placing at its population target;
  existing lots can keep growing afterward.
- At month 120 with the default $5,000 reserve / 2,000 target: empty seed 7 reached
  2,705 residents, 87 road tiles, 74 zoned tiles and $419,641 (previous population
  453). Starter seed 42 reached 2,406 residents, 95 road tiles, 76 zoned tiles and
  $469,387 (previous population 1,659 and 66 road tiles). Both had full water
  service and positive operating balances. These are fixed-seed observations.

### Desirability milestone validation record

- Tests cover contribution totals and profile differences, disconnected parks,
  weighted/failed commutes, service gates, time-weighted reliability, read-only
  inspection, decline without double water penalties, business deterioration,
  gradual recovery, migration, save replay and offscreen sample equivalence.
- The map and inspector consume backend values rather than duplicating scoring
  rules in the renderer. Neighbour rendering keeps each district's scores local.
- 120-month autoplay checks: seed 7 from empty reached 453 residents and $45,366;
  seed 42 starter reached 1,659 residents and $299,738, with two amenity additions.
  Both remained solvent and fully supplied with water. These are observations,
  not target guarantees. Browser visual verification remains unavailable.

### Water milestone validation record

- Automated scenarios cover rotated/atomic footprints, independent underground
  demolition, road and power failures, pipe isolation, tower depletion and refill,
  mass balance, growth/decline/recovery, migration, save replay and offscreen flow.
- At 120 months, seeded autoplay runs had no meaningful unmet water demand:
  seed 7 from empty reached 453 residents and $45,366; starter seed 42 reached
  1,659 residents and $299,994. Both had 600 m3 stored and positive operating cash
  flow. These are observations, not guaranteed targets for arbitrary terrain.
- Development Windows 11 workspace, Intel family 6/model 183 CPU, 65,536 tiles,
  seed 42 starter after 2.5 simulated real-time seconds: ten 250 ms steps averaged
  3.72 ms; snapshot generation was 36.02 ms; uncompressed JSON was 2,329,792 bytes.
  This is a small smoke measurement, not a p95 benchmark or a rendering result.
- Existing local v6 save restored successfully with 24-month water grace, without
  rewriting the source. An isolated server produced a rotating autosave.
- UI visual check remains pending: browser access host unavailable; native browser
  control was subsequently stopped by the runtime's URL-policy enforcement limit.

## Architecture and performance gates

- **P1 baseline:** record hardware, browser, viewport, seed, map size, population,
  tile/building counts, tick timings, frame timings, memory and snapshot bytes.
- **Before P8 scope is committed:** benchmark a proposed reference world of
  512 x 512 tiles and 100,000 aggregate residents on a named reference PC.
  Initial targets: p95 rendering frame time <= 33 ms at 1080p, p95 interactive
  command acknowledgement <= 200 ms, and a one-month simulation step <= 1 second.
  These are targets, not claims about the current code or unnamed machines.
- Route assignments and regional reductions may use slower explicit schedules;
  show progress and state age instead of silently blocking all UI commands.
- Choose worker counts from profiling, not one process per chunk. Compiled
  kernels/NumPy and process workers should be introduced only where they improve
  measured bottlenecks. CPython threads alone are not the CPU-scaling plan.
- Every phase needs headless deterministic scenarios, targeted browser checks,
  documented budgets, and save migration before it is considered delivered.

## What "complete" means

An inventory checklist alone is insufficient. A system is complete when its
player tools work, simulation effects feed dependent systems, capacity and money
are accounted for, failures are visible and recoverable, overlays explain the
outcome, saves preserve it, and regression/performance tests pass.

Detailed seasonal farming, hydraulic sewage/stormwater, highly realistic weather,
and optional vehicle missions can extend the game after the parity-critical
systems. Online multiplayer, mobile-native apps, photorealistic textures and
compatibility with proprietary SC4 assets/saves are not assumed requirements.
