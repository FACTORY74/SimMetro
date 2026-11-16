"""Temporary: measure live HTTP latency while the simulation runs at speed 3."""
import statistics
import time

import httpx

BASE = "http://127.0.0.1:8123/api"
client = httpx.Client(timeout=30)

print("load:", client.post(f"{BASE}/load", json={"name": "city"}).status_code)
print("speed:", client.post(f"{BASE}/speed", json={"speed": 3}).status_code)
time.sleep(1)

session = client.get(f"{BASE}/state").json()["session"]


def measure(label, fn, seconds=12):
    latencies = []
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        start = time.perf_counter()
        response = fn()
        latencies.append((time.perf_counter() - start) * 1000)
        assert response.status_code in (200, 409), response.text
        time.sleep(0.3)
    latencies.sort()
    print(f"{label:28s} n={len(latencies):3d}  p50={statistics.median(latencies):7.1f} ms  "
          f"p90={latencies[int(len(latencies)*.9)]:7.1f} ms  max={latencies[-1]:7.1f} ms")


measure("GET /api/view", lambda: client.get(
    f"{BASE}/view", params={"x": 128, "z": 128, "distance": 75, "session": session}))
measure("GET /api/state (poll)", lambda: client.get(f"{BASE}/state", params={"session": session, "since": 0}))

row = [20]
def build_one():
    z = row[0]
    row[0] += 1
    return client.post(f"{BASE}/build", json={"tool": "road", "cells": [{"x": 3, "z": z}]})

measure("POST /api/build (stroke)", build_one, seconds=12)
measure("GET /api/power", lambda: client.get(f"{BASE}/power"))
print("done")
