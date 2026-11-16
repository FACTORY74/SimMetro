# SimMetro Architecture

## Goals

SimMetro is a deterministic city simulation over streamed 256 x 256-cell districts.
The architecture must keep commands responsive, exploit multiple CPU cores where
that produces measured gains, retain reproducible saves, and avoid making the UI
wait for a complete simulation update.

The central rule is **single ownership, parallel calculation**. A district has one
authoritative owner for a simulation generation. Workers may calculate independent
districts or phase results concurrently, but they do not make uncontrolled writes
to shared tiles.

## Current components

- `backend/simulation.py` owns a district's authoritative `City` state and domain
  rules: construction, connectivity, utilities, traffic inputs, desirability,
  growth and finances.
- `backend/region.py` owns materialised districts, camera-driven detail, terrain
  streaming, activity levels and district scheduling.
- `backend/controller.py` defines the ordered command boundary.
- `backend/workers.py` defines the persistent region-owner process protocol. City
  state crosses a process boundary only when ownership changes or a checkpoint is
  requested; ordinary advances remain inside the owning process.
- `backend/app.py` is the FastAPI adapter, real-time clock and current coordination
  lock. Expensive encoding, compression, terrain generation and disk I/O occur off
  the event loop.
- `src/` owns presentation and the non-authoritative vehicle micro-simulation.

## Region lifecycle and simulation levels

Every materialised district is assigned an explicit activity level:

- **HOT**: focused or camera-near. It receives ordinary fine-grained simulation.
- **COLD**: developed but distant. Time is accumulated and dispatched in batches;
  detailed traffic rendering and snapshots are not produced.
- **DORMANT**: empty, paused, or otherwise without scheduled simulation work.
  Pristine districts can be evicted and regenerated from their seed.

Camera thresholds use a retention band so movement around a boundary does not
continually promote and demote districts. Camera visibility is a scheduling input,
not authority over whether a developed district exists.

`Region` uses a bounded worker count, never a thread per domain or district. On a
normal GIL-enabled CPython build CPU-bound Python jobs default to one worker. A
free-threaded build selects a bounded number of cores automatically. The
`KSC_SIM_WORKERS` environment variable is an explicit profiling/deployment override.
Independent district updates are suitable first jobs because current utility,
budget and transport networks are district-local.

## Deterministic update model

The present `City.run` remains the reference transaction. As domains are extracted,
one generation will use explicit phases:

1. Apply ordered player and system commands.
2. Commit terrain and topology changes.
3. Calculate connectivity and utility/transport graphs.
4. Calculate power, water and traffic from the committed topology.
5. Calculate service reliability and desirability.
6. Commit growth, employment, condition and finances.
7. Perform explicit cross-region reductions.
8. Publish generation N+1.

Jobs consume state from one completed generation and return typed results. Only the
region owner commits those results, in a fixed order. Domains must not acquire tile
locks and mutate the same `Tile` instances concurrently.

The serial executor remains the correctness oracle. Parallel and future process
executors must produce identical scenario and save results.

## Commands

All externally requested mutations cross `CommandQueue`. It assigns a monotonic
sequence before execution and returns that sequence in mutation responses. The
first implementation drains synchronously while `SIM_LOCK` is held, preserving the
existing API and low latency. This boundary is intentionally compatible with a
future controller actor that drains commands at deterministic phase boundaries.

Rejected commands consume a sequence number. This makes logs unambiguous and avoids
reusing identities after partial validation. A later persistent journal will store
the sequence, target district, expected generation, operation and payload for replay
and recovery.

Autoplay uses the ordinary simulation model, but its individual generated build
operations should eventually cross the same journal boundary.

## Published state and UI transport

The UI must read completed generations, never live objects halfway through a commit.
The target design uses immutable, double-buffered published state:

```
authoritative mutable state -> build inactive snapshot -> atomic publication
                                      UI reads previous snapshot --------^
```

The existing lock-and-copy response path is the transitional implementation. JSON
encoding and gzip already happen after releasing the simulation lock. The next step
is a publisher holding immutable per-region buffers and generation numbers so HTTP
readers only acquire a reference.

Published state will be divided into:

- dense tile fields;
- low-frequency district metadata;
- changed chunks/dirty rectangles;
- traffic animation data;
- clock and generation cursors.

The client should receive binary or compact chunk deltas and request a full snapshot
only on initial connection or resynchronisation. A moving clock alone must not cause
all 65,536 cells to be serialized again.

## Multicore roadmap

1. Record timings per domain, snapshot, encoding and transfer using deterministic
   benchmark worlds.
2. Keep the activity scheduler and serial correctness path covered by tests.
3. Introduce immutable published snapshots and generation cursors.
4. Move hot tile fields from Python objects to dense typed arrays.
5. Extract pure domain jobs with explicit inputs and results.
6. Parallelise independent districts, then only measured independent phases within
   a district.
7. Add a process/shared-memory executor for standard CPython and benchmark it against
   the free-threaded executor.
8. Add aggregate cold simulation and explicit cross-region exchange barriers.
9. Add incremental/binary delivery and client resynchronisation.

Worker counts come from profiling and hardware limits. Work is prioritised by
focused region, command latency and state age, and obsolete camera-driven jobs may
be coalesced. There is at most one authoritative update in flight per district.

## Invariants

- A district is mutated by at most one authoritative job at a time.
- Published generations are immutable.
- Commands have a total order and are applied at a documented phase boundary.
- Saves represent a complete committed generation.
- Loading replaces the whole region atomically.
- Parallel execution does not change seeded results.
- Empty procedural terrain is not materialised as a `City` merely for rendering.
- Cross-region systems exchange explicit boundary data; they never reach into a
  neighbouring district's mutable state.

## Performance gates

Changes must report benchmark hardware and scenario data. Track at least simulation
p50/p95, command acknowledgement p95, snapshot construction, encoded bytes, browser
frame p95 and memory per developed district. Parallelism is retained only where it
improves a measured bottleneck without breaking deterministic replay or UI latency.
