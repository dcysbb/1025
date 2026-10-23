import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from pydantic import ValidationError
from app.stage import StageConfig, StageController, StagePresentation, StageError


class PresentationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stage = StageController(self.root, Mock())

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_partial_channel_name_merge_is_persistent_and_read_only_for_driver(self):
        self.stage.config = StageConfig(axes={'x': 3, 'y': 1, 'z': 2})
        self.stage.driver = Mock()
        self.stage.connected = True
        await self.stage.set_presentation(StagePresentation(channel_names={'1': '样品台'}), 'test')
        await self.stage.set_presentation(StagePresentation(channel_names={'2': '探针'}, card_order=[2, 3, 1]), 'test')
        self.stage.driver.assert_not_called()
        self.assertEqual(self.stage.driver.mock_calls, [])
        reloaded = StageController(self.root, Mock())
        self.assertEqual(reloaded.config.channel_names, {'1': '样品台', '2': '探针', '3': ''})
        self.assertEqual(reloaded.config.card_order, [2, 3, 1])
        self.assertEqual(reloaded.config.axes, {'x': 3, 'y': 1, 'z': 2})
        self.assertFalse(reloaded.connected)

    async def test_bad_names_and_duplicate_order_do_not_replace_config(self):
        previous = self.stage.config.model_dump()
        for values in ({'channel_names': {'4': 'bad'}}, {'channel_names': {'1': 'x'*33}}, {'card_order': [1, 1, 3]}):
            with self.assertRaises(StageError):
                await self.stage.set_presentation(StagePresentation(**values), 'test')
            self.assertEqual(self.stage.config.model_dump(), previous)

    def test_legacy_config_preserves_the_existing_axis_order(self):
        config = StageConfig(axes={'x': 3, 'y': 1, 'z': 2})
        self.assertEqual(config.card_order, [3, 1, 2])
        self.assertEqual(config.channel_names, {'1': '', '2': '', '3': ''})
        with self.assertRaises(ValidationError):
            StagePresentation(axes={'x': 1})
