import json
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from app.configuration import ConfigurationStore
from app.engine import InterlockEngine
from app.models import AppConfig
from app.storage import HistoryStore


class TerminalLabels(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        store = ConfigurationStore(Path(self.temp.name))
        self.history = HistoryStore(Path(self.temp.name) / 'history.sqlite3')
        self.e = InterlockEngine(store, self.history)

    async def asyncTearDown(self):
        await self.e.stop()
        self.history.close()
        self.temp.cleanup()

    def test_defaults_are_eight_empty_labels(self):
        self.assertEqual(self.e.config.dam_input_labels, [""] * 8)
        self.assertEqual(self.e.config.dam_output_labels, [""] * 8)

    def test_wrong_item_count_rejected(self):
        with self.assertRaises(ValidationError):
            AppConfig(dam_input_labels=[""] * 7)
        with self.assertRaises(ValidationError):
            AppConfig(dam_output_labels=[""] * 9)

    def test_overlong_label_rejected(self):
        with self.assertRaises(ValidationError):
            AppConfig(dam_output_labels=["x" * 25] + [""] * 7)
        with self.assertRaises(ValidationError):
            AppConfig(dam_input_labels=[""] * 7 + ["端" * 25])

    def test_labels_are_stripped(self):
        config = AppConfig(dam_input_labels=[" 关闭到位 ", " 打开到位 "] + [""] * 6)
        self.assertEqual(config.dam_input_labels[0], "关闭到位")
        self.assertEqual(config.dam_input_labels[1], "打开到位")

    def test_legacy_config_without_labels_keeps_defaults(self):
        root = Path(self.temp.name) / "legacy"
        root.mkdir()
        (root / "config.json").write_text(
            json.dumps({"config": {"mode": "simulation"}, "version": 3}), encoding="utf-8"
        )
        store = ConfigurationStore(root)
        self.assertEqual(store.get_config().dam_input_labels, [""] * 8)
        self.assertEqual(store.get_config().dam_output_labels, [""] * 8)
        self.assertEqual(store.version, 3)

    def test_store_round_trip_preserves_labels(self):
        config = AppConfig(dam_output_labels=["开阀电磁阀"] + [""] * 7,
                           dam_input_labels=["关闭到位"] + [""] * 7)
        store = ConfigurationStore(Path(self.temp.name))
        store.update(config)
        restored = ConfigurationStore(Path(self.temp.name))
        self.assertEqual(restored.get_config().dam_output_labels[0], "开阀电磁阀")
        self.assertEqual(restored.get_config().dam_input_labels[0], "关闭到位")

    async def test_debug_relays_expose_output_labels(self):
        config = AppConfig(mode="simulation",
                           dam_output_labels=["前级阀控制"] + [""] * 7)
        await self.e.apply_config(config)
        result = await self.e.debug_relays()
        self.assertEqual(result["output_labels"][0], "前级阀控制")
        self.assertEqual(len(result["output_labels"]), 8)
