"""Daily trip planning, routing and congestion on the city's road network.

The monthly economy decides how many people work at each business. This module
turns that aggregate result into concrete daily trips: which homes send
commuters to which workplaces, along which roads, on which shift. Shoppers and
freight trucks are added for the rest of the day's routine.
"""

from backend.roads import ROADS, road_type

import heapq
from collections import deque
from typing import NamedTuple


ROAD_CAPACITY = 400        # Peak-period passenger-car units one road tile carries comfortably.
TILE_MINUTES = .3          # Free-flow driving time across one tile.
TERMINAL_MINUTES = 3       # Walking to and from the car at both ends.
TRUCK_PCU = 2              # A truck occupies the road like two cars.
MAX_MATCH_ROUNDS = 48
ASSIGN_ROUNDS = 4          # Commuters are routed in slices so later slices avoid roads earlier ones filled.
MIN_ROAD_MINUTES = min(road.minutes for road in ROADS.values())


class Trip(NamedTuple):
    kind: str          # "w" commute, "s" shopping, "f" freight
    origin: int        # Tile index where the outbound trip starts.
    destination: int   # Tile index where the outbound trip ends.
    count: int         # People (or trucks) making this trip each day.
    start: int         # Minute of day: shift start, shop arrival, or truck departure.
    end: int           # Minute of day the return trip begins.
    route: str         # Moves from origin to destination: N, E, S, W. Empty if unrouted.


class TrafficPlan(NamedTuple):
    trips: list[Trip]
    minutes: list[float]   # Door-to-door one-way travel time for each trip.
    volume: list[int]      # Peak passenger-car units on each tile.
    commuters: int
    avg_commute: float
    congested: int


def _mix(*values: int) -> int:
    n = 0x9E3779B9
    for value in values:
        n = ((n ^ (value & 0xFFFFFFFF)) * 0x85EBCA6B) & 0xFFFFFFFF
        n ^= n >> 13
    return n


def delay_factor(volume: int, capacity: int = ROAD_CAPACITY) -> float:
    """BPR-style travel time multiplier for a road tile's peak volume."""
    ratio = volume / capacity
    return 1 + .15 * ratio ** 4


def _search(seeds, components, district, adj, scratch, generation):
    """Multi-source breadth-first search over one road network. Seeds are (road, owner)
    in priority order. Results land in the generation-stamped `scratch` arrays."""
    stamp, owner, parent, dist = scratch
    queue = deque()
    for road, label in seeds:
        if stamp[road] != generation:
            stamp[road] = generation
            owner[road], parent[road], dist[road] = label, -1, 0
            queue.append(road)
    while queue:
        i = queue.popleft()
        label, depth = owner[i], dist[i] + 1
        for j in adj[i]:
            if stamp[j] != generation and components[j] == district:
                stamp[j] = generation
                owner[j], parent[j], dist[j] = label, i, depth
                queue.append(j)


def _encode(tiles: list[int], size: int) -> str:
    moves = []
    for a, b in zip(tiles, tiles[1:]):
        delta = b - a
        moves.append("E" if delta == 1 else "W" if delta == -1 else "S" if delta == size else "N")
    return "".join(moves)


def _proportional(weights: list[int], total: int) -> list[int]:
    """Split `total` by weight, distributing the remainder to the largest fractions."""
    whole = sum(weights)
    if not whole:
        return [0] * len(weights)
    shares = [w * total // whole for w in weights]
    order = sorted(range(len(weights)), key=lambda k: (-(weights[k] * total % whole), k))
    for k in order[:total - sum(shares)]:
        shares[k] += 1
    return shares


def _road_costs(tiles):
    """Per-tile free-flow minutes and capacity for road tiles, resolved once per plan."""
    minutes = [0.] * len(tiles)
    capacity = [ROAD_CAPACITY] * len(tiles)
    for i, tile in enumerate(tiles):
        if tile.kind == "road":
            road = road_type(tile)
            minutes[i], capacity[i] = road.minutes, road.capacity
    return minutes, capacity


def plan_traffic(tiles, adj, components, districts, size) -> TrafficPlan:
    road_minutes, road_capacity = _road_costs(tiles)
    # Generation-stamped scratch arrays shared by every search in this plan.
    n = len(tiles)
    scratch = ([0] * n, [0] * n, [-1] * n, [0] * n)
    stamp, owner, parent, dist = scratch
    generation = 0
    by_district: dict[int, dict[str, list[int]]] = {}
    for index, district in sorted(districts.items()):
        by_district.setdefault(district, {"residential": [], "commercial": [], "industrial": []})[
            tiles[index].kind].append(index)
    trips: list[Trip] = []
    commutes = []
    for district, zones in sorted(by_district.items()):
        access = {i: [j for j in adj[i] if components[j] == district]
                  for zone in zones.values() for i in zone}
        homes = zones["residential"]
        businesses = [i for i in zones["commercial"] + zones["industrial"] if tiles[i].workers]
        businesses.sort()
        employed = _proportional([tiles[h].labor for h in homes],
                                 sum(tiles[b].workers for b in businesses))

        # Each round, every unfilled workplace hires from the nearest home that still has workers.
        remaining = {h: e for h, e in zip(homes, employed) if e}
        pending = [(b, tiles[b].workers) for b in businesses]
        pairs: dict[tuple[int, int], int] = {}
        rounds = 0
        while pending and remaining and rounds < MAX_MATCH_ROUNDS:
            rounds += 1
            generation += 1
            _search([(r, h) for h in sorted(remaining) for r in access[h]],
                    components, district, adj, scratch, generation)
            unfilled = []
            for b, need in pending:
                reachable = [(dist[r], r) for r in access[b] if stamp[r] == generation]
                if not reachable:
                    continue
                home = owner[min(reachable)[1]]
                take = min(need, remaining.get(home, 0))
                if take:
                    pairs[home, b] = pairs.get((home, b), 0) + take
                    remaining[home] -= take
                    if not remaining[home]:
                        del remaining[home]
                    need -= take
                if need:
                    unfilled.append((b, need))
            pending = unfilled
        commutes.append((pairs, access, district))
        # Rare overflow from very large networks is still counted, just not routed.
        for b, need in pending:
            for home in sorted(remaining):
                take = min(need, remaining[home])
                if take:
                    trips.append(_commute(tiles, home, b, take, ""))
                    remaining[home] -= take
                    need -= take
                if not need:
                    break
            remaining = {h: n for h, n in remaining.items() if n}

        shops = [c for c in zones["commercial"] if tiles[c].level]
        if shops and homes:
            generation += 1
            _search([(r, c) for c in shops for r in access[c]], components, district, adj, scratch, generation)
            for home, works in zip(homes, employed):
                shoppers = (tiles[home].residents - works) // 4
                reachable = [(dist[r], r) for r in access[home] if stamp[r] == generation]
                if not shoppers or not reachable:
                    continue
                road = min(reachable)[1]
                shop = owner[road]
                path = [home] + _chain_array(road, parent) + [shop]
                start = 600 + _mix(home, shop, 3) % 109 * 5     # 10:00 to 19:00
                trips.append(Trip("s", home, shop, shoppers, start, start + 50, _encode(path, size)))

        factories = [i for i in zones["industrial"] if tiles[i].workers]
        if shops and factories:
            generation += 1
            _search([(r, shop) for shop in shops for r in access[shop]], components, district, adj, scratch, generation)
            for factory in factories:
                reachable = [(dist[r], r) for r in access[factory] if stamp[r] == generation]
                if not reachable:
                    continue
                road = min(reachable)[1]
                shop = owner[road]
                path = [factory] + _chain_array(road, parent) + [shop]
                trucks = max(1, tiles[factory].workers // 10)
                start = 480 + _mix(factory, 7) % 97 * 5           # 08:00 to 16:00
                trips.append(Trip("f", factory, path[-1], trucks, start, start + 120,
                                  _encode(path, size)))

    # Freight is loaded first; commuters then route around it and each other.
    volume = [0] * len(tiles)
    for trip in trips:
        if trip.kind == "f" and trip.route:
            for road in _route_roads(trip, size):
                volume[road] += trip.count * TRUCK_PCU
    for pairs, access, district in commutes:
        trips.extend(_assign(tiles, pairs, access, components, district, adj, volume, size,
                             road_minutes, road_capacity))

    volume = [0] * len(tiles)
    for trip in trips:
        if trip.kind == "s" or not trip.route:
            continue
        load = trip.count * (TRUCK_PCU if trip.kind == "f" else 1)
        for road in _route_roads(trip, size):
            volume[road] += load
    minutes = []
    commuters = weighted = 0
    for trip in trips:
        if trip.route:
            travel = sum(road_minutes[r] * delay_factor(volume[r], road_capacity[r]) for r in _route_roads(trip, size))
        else:
            ox, oz, dx, dz = trip.origin % size, trip.origin // size, \
                trip.destination % size, trip.destination // size
            travel = (abs(ox - dx) + abs(oz - dz)) * TILE_MINUTES
        minutes.append(round(TERMINAL_MINUTES + travel, 1))
        if trip.kind == "w":
            commuters += trip.count
            weighted += minutes[-1] * trip.count
    congested = sum(v > road_capacity[i] for i, (t, v) in enumerate(zip(tiles, volume)) if t.kind == "road")
    return TrafficPlan(trips, minutes, volume, commuters,
                       round(weighted / commuters, 1) if commuters else 0.0, congested)


def _assign(tiles, pairs, access, components, district, adj, volume, size,
            road_minutes=None, road_capacity=None) -> list[Trip]:
    """Route commuters in slices along congestion-aware quickest paths, so busy roads shed
    traffic onto alternatives. `volume` is updated in place as each slice joins the network."""
    if road_minutes is None:
        road_minutes, road_capacity = _road_costs(tiles)
    # Congested per-tile travel times, maintained incrementally as volume changes,
    # so each Dijkstra relaxation is a plain array lookup.
    cost = [m and m * delay_factor(volume[i], road_capacity[i]) for i, m in enumerate(road_minutes)]
    # Generation-stamped scratch arrays replace per-search dict allocation.
    n = len(cost)
    stamp, target_stamp = [0] * n, [0] * n
    dist_arr, parent_arr = [0.] * n, [-1] * n
    generation = 0
    slices = {pair: _proportional([1] * ASSIGN_ROUNDS, count) for pair, count in pairs.items()}
    by_home: dict[int, list[int]] = {}
    for home, business in sorted(pairs):
        by_home.setdefault(home, []).append(business)
    routes: dict[tuple[int, int, str], int] = {}
    for round_ in range(ASSIGN_ROUNDS):
        for home, businesses in by_home.items():
            loads = [(b, slices[home, b][round_]) for b in businesses if slices[home, b][round_]]
            if not loads:
                continue
            targets = {r for b, _ in loads for r in access[b]}
            generation += 1
            _quickest_array(access[home], targets, components, district, adj, cost, size,
                            stamp, target_stamp, dist_arr, parent_arr, generation)
            for business, load in loads:
                reachable = [(dist_arr[r], r) for r in access[business] if stamp[r] == generation]
                route = ""
                if reachable:
                    roads = _chain_array(min(reachable)[1], parent_arr)[::-1]
                    for road in roads:
                        volume[road] += load
                        cost[road] = road_minutes[road] * delay_factor(volume[road], road_capacity[road])
                    route = _encode([home] + roads + [business], size)
                routes[home, business, route] = routes.get((home, business, route), 0) + load
    return [_commute(tiles, home, business, count, route)
            for (home, business, route), count in routes.items()]


def _chain_array(road: int, parent: list) -> list[int]:
    """Roads from `road` back to the search seed it was reached from."""
    roads = []
    while road != -1:
        roads.append(road)
        road = parent[road]
    return roads


def _quickest_array(sources, targets, components, district, adj, cost, size,
                    stamp, target_stamp, dist_arr, parent_arr, generation):
    """A* over one road network with precomputed per-tile costs.

    The heuristic is the Manhattan distance to the targets' bounding box at the
    fastest road's free-flow speed: an admissible, consistent lower bound, so
    settled travel times are exactly the Dijkstra ones. Settled nodes are marked
    in `stamp` with the current generation; their travel time and predecessor
    are in `dist_arr`/`parent_arr`."""
    if not targets:
        return
    x0 = x1 = z0 = z1 = -1
    for r in targets:
        target_stamp[r] = generation
        x, z = r % size, r // size
        if x0 < 0:
            x0 = x1 = x
            z0 = z1 = z
        else:
            if x < x0: x0 = x
            elif x > x1: x1 = x
            if z < z0: z0 = z
            elif z > z1: z1 = z
    def remaining(j):
        x, z = j % size, j // size
        gap = (x0 - x if x < x0 else x - x1 if x > x1 else 0) + \
              (z0 - z if z < z0 else z - z1 if z > z1 else 0)
        return gap * MIN_ROAD_MINUTES
    heap = [(cost[r] + remaining(r), cost[r], r, -1) for r in sources]
    heapq.heapify(heap)
    heappush, heappop = heapq.heappush, heapq.heappop
    left = len(targets)
    while heap and left:
        _, d, road, via = heappop(heap)
        if stamp[road] == generation:
            continue
        stamp[road] = generation
        dist_arr[road], parent_arr[road] = d, via
        if target_stamp[road] == generation:
            left -= 1
        for j in adj[road]:
            if stamp[j] != generation and components[j] == district:
                g = d + cost[j]
                heappush(heap, (g + remaining(j), g, j, road))


def _quickest(sources, targets, allowed, adj, volume, tiles=None):
    """Dijkstra over road tiles, costing each tile by its congested travel time."""
    def cost(j):
        return (road_type(tiles[j]).minutes * delay_factor(volume[j], road_type(tiles[j]).capacity)
                if tiles is not None else TILE_MINUTES * delay_factor(volume[j]))
    dist, parent, heap = {}, {}, [(cost(r), r, -1) for r in sources]
    heapq.heapify(heap)
    left = set(targets)
    while heap and left:
        d, road, via = heapq.heappop(heap)
        if road in dist:
            continue
        dist[road], parent[road] = d, via
        left.discard(road)
        for j in adj[road]:
            if j not in dist and allowed(j):
                heapq.heappush(heap, (d + cost(j), j, road))
    return dist, parent


def _commute(tiles, home: int, business: int, count: int, route: str) -> Trip:
    salt = _mix(home, business)
    length = 480 + salt // 7 % 4 * 30                        # 8 to 9.5 hours with breaks.
    if tiles[business].kind == "commercial" and tiles[business].subtype == "e":
        start, length = 960 + salt % 12 * 15, 420              # Venues staff the evening from 16:00-18:45.
    elif tiles[business].kind == "commercial":
        if salt % 7 == 0:                                    # Part-time afternoon staff.
            start, length = 720 + salt // 11 % 4 * 30, 300
        else:
            start = 450 + salt % 16 * 10                     # Shops and offices open 07:30 to 10:00.
    elif salt % 4 == 0:
        start = 840 + salt // 5 % 4 * 15                     # A quarter of industry works the late shift.
    else:
        start = 330 + salt % 9 * 15                          # Early shift 05:30 to 07:30.
    return Trip("w", home, business, count, start, start + length, route)


def _route_roads(trip: Trip, size: int) -> list[int]:
    """Road tiles visited by a trip, excluding the origin and destination lots."""
    steps = {"E": 1, "W": -1, "S": size, "N": -size}
    tile, roads = trip.origin, []
    for move in trip.route[:-1]:
        tile += steps[move]
        roads.append(tile)
    return roads
