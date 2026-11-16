import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend import app as module
from backend.saves import autosave, save_path, write_save
from backend.simulation import City
from backend.region import Region


class SaveSlotTests(unittest.TestCase):
    def test_names_stay_in_save_directory_and_rotation_is_bounded(self):
        with TemporaryDirectory() as folder:
            default = Path(folder) / "city.json"
            for name in ("../escape", "", "x/y", "..", "a"*49):
                with self.assertRaises(ValueError):
                    save_path(default, name)
            write_save(default, {"manual": True})
            for i in range(5):
                autosave(default, {"generation": i})
            self.assertEqual(len(list(Path(folder).glob("*.json"))), 4)
            self.assertEqual(json.loads(default.read_text()), {"manual": True})
            self.assertEqual(sorted(json.loads(p.read_text())["generation"] for p in Path(folder).glob("autosave-*.json")), [2, 3, 4])
            self.assertFalse(list(Path(folder).glob("*.tmp")))

    def test_named_api_roundtrip_and_invalid_load_preserves_region(self):
        with TemporaryDirectory() as folder:
            city = City()
            region = Region(city)
            with patch.object(module, "SAVE_PATH", Path(folder)/"city.json"), patch.object(module, "city", city), patch.object(module, "region", region):
                client = TestClient(module.app)
                self.assertEqual(client.post("/api/save", json={"name": "water-test"}).status_code, 200)
                listing = client.get("/api/saves").json()
                self.assertEqual(listing["saves"][0]["name"], "water-test")
                self.assertEqual(client.post("/api/save", json={"name": "../escape"}).status_code, 422)
                self.assertEqual(client.post("/api/save", json={"name": "autosave-1"}).status_code, 400)
                self.assertEqual(client.post("/api/load", json={"name": "missing"}).status_code, 404)
                self.assertIs(module.region, region)
                self.assertEqual(client.post("/api/load", json={"name": "water-test"}).status_code, 200)
                self.assertEqual(module.city.water_network.summary["unserved"], 0)
                self.assertEqual(len(module.city.facilities), 1)

    def test_water_api_build_validation_and_independent_pipe_deletion(self):
        city = City()
        with patch.object(module, "city", city), patch.object(module, "region", Region(city)):
            client = TestClient(module.app)
            f = next(iter(city.facilities.values()))
            cell = {"x": f.x, "z": f.z}
            before = city.money
            self.assertEqual(client.post("/api/build", json={"tool": "waterworks", "cells": [cell], "rotation": 4}).status_code, 422)
            self.assertEqual(city.money, before)
            result = client.post("/api/build", json={"tool": "remove_pipe", "cells": [cell]})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(city.at(f.x, f.z).kind, "waterworks")
            self.assertEqual(result.json()["state"]["water"]["facilities"][0]["reason"], "No connector pipe")
