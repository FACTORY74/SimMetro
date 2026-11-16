"""Atomic construction and validated persistence for water infrastructure."""
import math
from backend.facilities import Facility, FACILITIES
from backend.water import PIPE_COST


def valid_facility(city, facility, size):
    points = facility.footprint()
    if any(not (0 < x < size-1 and 0 < z < size-1) for x, z in points):
        raise ValueError("Facility footprint must stay inside the district border.")
    if any(city.at(x, z).kind != "empty" or city.at(x, z).water for x, z in points):
        raise ValueError("Facility needs a dry, empty footprint. Bulldoze existing development first.")
    heights = [city.at(x, z).height for x, z in points]
    if max(heights) - min(heights) > 1:
        raise ValueError("Facility footprint is too steep; grade the site first.")


def install(city, facility):
    city.facilities[facility.id] = facility
    for x, z in facility.footprint():
        tile = city.at(x, z)
        tile.kind, tile.variant = "waterworks", facility.variant
        tile.facility_id = facility.id
        tile.facility_root = (x, z) == (facility.x, facility.z)


def build_water(city, tool, cells, variant, rotation, size):
    if tool == "waterworks":
        if len(cells) != 1:
            raise ValueError("Place one water facility at a time.")
        if variant not in FACILITIES or type(rotation) is not int or rotation not in range(4):
            raise ValueError("Invalid water facility type or rotation.")
        x, z = cells[0]
        facility = Facility(city.next_facility_id, variant, x, z, rotation)
        valid_facility(city, facility, size)
        cost = FACILITIES[variant].cost
        if city.money < cost:
            raise ValueError(f"Insufficient funds: this facility costs ${cost:,}.")
        install(city, facility)
        city.next_facility_id += 1
    else:
        indices = {z * size + x for x, z in cells}
        if tool == "pipe":
            if any(city.tiles[i].water for i in indices):
                raise ValueError("Pipes require dry land in this water-network release.")
            changed = indices - city.pipes
            cost = len(changed) * PIPE_COST
        else:
            changed = indices & city.pipes
            cost = len(changed)
        if city.money < cost:
            raise ValueError(f"Insufficient funds: this stroke costs ${cost:,}.")
        if tool == "pipe":
            city.pipes.update(changed)
        else:
            city.pipes.difference_update(changed)
    city.money -= cost
    city._changed()
    return cost


def starter_water(city, size):
    # Pipes under the starter streets serve adjacent lots; no surface lots move.
    city.pipes = {i for i, t in enumerate(city.tiles) if t.kind == "road"}
    for i in sorted(city.pipes, reverse=True):
        x, z = i % size, i // size
        for rotation in range(4):
            probe = Facility(city.next_facility_id, "p", 0, 0, rotation)
            dx, dz = probe.entrance
            facility = Facility(city.next_facility_id, "p", x-dx, z-dz, rotation)
            try:
                valid_facility(city, facility, size)
            except ValueError:
                continue
            install(city, facility)
            city.next_facility_id += 1
            # For rotated entrances, connect all footprint cells to the street.
            city.pipes.update(b*size+a for a, b in facility.footprint())
            return
    raise ValueError("No dry footprint for starter water supply.")


def restore_water(city, data, size):
    raw = data.get("water")
    if data["version"] < 7 and raw is None:
        city.water_grace = 24
        return
    if not isinstance(raw, dict):
        raise ValueError("Invalid saved water infrastructure.")
    pipes, facilities = raw.get("pipes"), raw.get("facilities")
    grace, next_id, shortages = raw.get("grace"), raw.get("next_id"), raw.get("shortages")
    if (not isinstance(pipes, list) or
            any(type(i) is not int or not 0 <= i < size*size or city.tiles[i].water for i in pipes) or len(pipes) != len(set(pipes))):
        raise ValueError("Invalid saved pipes.")
    if (type(grace) is not int or not 0 <= grace <= 24 or type(next_id) is not int or next_id < 1
            or not isinstance(facilities, list) or not isinstance(shortages, dict)):
        raise ValueError("Invalid saved water state.")
    expected = {i for i, t in enumerate(city.tiles) if t.kind == "waterworks"}
    # Clear the occupied water tiles for shared placement validation, then rebuild IDs.
    variants = {i: city.tiles[i].variant for i in expected}
    for i in expected:
        city.tiles[i].kind = "empty"
    occupied = set()
    for entry in facilities:
        if not isinstance(entry, dict) or set(entry) != {"id", "variant", "x", "z", "rotation", "stored"}:
            raise ValueError("Invalid saved facility record.")
        if (any(type(entry[k]) is not int for k in ("id", "x", "z", "rotation")) or
                not 0 < entry["id"] < next_id or entry["id"] in city.facilities or
                not isinstance(entry["variant"], str) or entry["variant"] not in FACILITIES or entry["rotation"] not in range(4) or
                type(entry["stored"]) not in (int, float) or not math.isfinite(entry["stored"]) or
                not 0 <= entry["stored"] <= FACILITIES[entry["variant"]].storage):
            raise ValueError("Invalid saved facility values.")
        f = Facility(**entry)
        valid_facility(city, f, size)
        points = {z*size+x for x, z in f.footprint()}
        if any(variants.get(i) != f.variant for i in points):
            raise ValueError("Saved facility does not match its occupied tiles.")
        occupied.update(points)
        install(city, f)
    if occupied != expected:
        raise ValueError("Saved facility footprints do not match the map.")
    city.water_shortages = {}
    for key, count in shortages.items():
        if (not isinstance(key, str) or not key.isdecimal() or str(int(key)) != key or
                not 0 <= int(key) < size*size or type(count) is not int or not 0 <= count <= 120 or
                city.tiles[int(key)].kind not in ("residential", "commercial", "industrial")):
            raise ValueError("Invalid saved water shortage duration.")
        city.water_shortages[int(key)] = count
    city.pipes, city.water_grace, city.next_facility_id = set(pipes), grace, next_id
