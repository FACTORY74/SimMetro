"""Persistent region-owner workers.

Messages deliberately contain save/checkpoint data only when ownership changes.
Ordinary advances stay inside the owning process, avoiding per-tick City pickling.
"""
from __future__ import annotations

from dataclasses import dataclass
import multiprocessing as mp
from multiprocessing.connection import Connection
from typing import Any

from backend.simulation import City


RegionKey = tuple[int, int]


class RegionWorkerState:
    """Protocol implementation shared by local tests and child processes."""

    def __init__(self):
        self.cities: dict[RegionKey, City] = {}

    def handle(self, message: dict[str, Any]):
        operation = message["operation"]
        if operation == "load":
            key = tuple(message["key"])
            if key in self.cities:
                raise ValueError(f"Region {key} is already loaded by this worker.")
            self.cities[key] = City.restore(message["state"])
            return {"loaded": key}
        if operation == "advance":
            for key_data, seconds, power_step in message["jobs"]:
                city = self.cities[tuple(key_data)]
                city.run(seconds, power_step=power_step)
            return {"advanced": len(message["jobs"])}
        if operation == "set_speed":
            for key_data in message["keys"]:
                self.cities[tuple(key_data)].set_speed(message["speed"])
            return {"changed": len(message["keys"])}
        if operation == "checkpoint":
            return {key: self.cities[key].save_data() for key in map(tuple, message["keys"])}
        if operation == "unload":
            key = tuple(message["key"])
            city = self.cities.pop(key)
            return city.save_data()
        if operation == "stats":
            return {"regions": len(self.cities), "keys": sorted(self.cities)}
        raise ValueError(f"Unknown worker operation {operation!r}.")


def _worker_main(connection: Connection):
    state = RegionWorkerState()
    try:
        while True:
            message = connection.recv()
            if message["operation"] == "shutdown":
                connection.send({"ok": True, "result": {"regions": len(state.cities)}})
                return
            try:
                connection.send({"ok": True, "result": state.handle(message)})
            except Exception as exc:  # Keep the worker alive and report a typed failure.
                connection.send({"ok": False, "error": type(exc).__name__, "message": str(exc)})
    except EOFError:
        return
    finally:
        connection.close()


@dataclass
class _ProcessWorker:
    process: mp.Process
    connection: Connection


class ProcessRegionPool:
    """Fixed persistent processes with stable region ownership."""

    def __init__(self, workers: int = 4):
        self.worker_count = max(1, min(16, workers))
        context = mp.get_context("spawn")
        self._workers: list[_ProcessWorker] = []
        self._owners: dict[RegionKey, int] = {}
        for index in range(self.worker_count):
            parent, child = context.Pipe()
            process = context.Process(target=_worker_main, args=(child,), name=f"ksc-region-{index}", daemon=True)
            process.start()
            child.close()
            self._workers.append(_ProcessWorker(process, parent))

    def owner(self, key: RegionKey) -> int:
        return self._owners.get(key, ((key[0] * 73856093) ^ (key[1] * 19349663)) % self.worker_count)

    def _request(self, worker: int, message: dict[str, Any]):
        connection = self._workers[worker].connection
        connection.send(message)
        response = connection.recv()
        if not response["ok"]:
            raise RuntimeError(f"Region worker {response['error']}: {response['message']}")
        return response["result"]

    def load(self, key: RegionKey, city: City):
        worker = self.owner(key)
        result = self._request(worker, {"operation": "load", "key": key, "state": city.save_data()})
        self._owners[key] = worker
        return result

    def advance(self, jobs: list[tuple[RegionKey, float, int]]):
        grouped: dict[int, list[tuple[RegionKey, float, int]]] = {}
        for job in jobs:
            grouped.setdefault(self.owner(job[0]), []).append(job)
        # Dispatch every shard before waiting, so processes calculate concurrently.
        for worker, worker_jobs in grouped.items():
            self._workers[worker].connection.send({"operation": "advance", "jobs": worker_jobs})
        for worker in sorted(grouped):
            response = self._workers[worker].connection.recv()
            if not response["ok"]:
                raise RuntimeError(f"Region worker {response['error']}: {response['message']}")

    def checkpoint(self, keys: list[RegionKey]):
        grouped: dict[int, list[RegionKey]] = {}
        for key in keys:
            grouped.setdefault(self.owner(key), []).append(key)
        result = {}
        for worker, worker_keys in grouped.items():
            result.update(self._request(worker, {"operation": "checkpoint", "keys": worker_keys}))
        return result

    def unload(self, key: RegionKey) -> City:
        worker = self.owner(key)
        data = self._request(worker, {"operation": "unload", "key": key})
        self._owners.pop(key, None)
        return City.restore(data)

    def close(self):
        for worker in self._workers:
            if worker.process.is_alive():
                try:
                    self._request(self._workers.index(worker), {"operation": "shutdown"})
                except (EOFError, BrokenPipeError, OSError):
                    pass
            worker.connection.close()
        for worker in self._workers:
            worker.process.join(timeout=5)
            if worker.process.is_alive():
                worker.process.terminate()
                worker.process.join(timeout=2)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

