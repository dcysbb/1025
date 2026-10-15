import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from pydantic import ValidationError

from app.stage import SimulatedStage, StageConfig, StageController, StageError, StageMove


class StageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.events = Mock()
        self.stage = StageController(Path(self.temp.name), self.events)

    async def asyncTearDown(self):
        try:
            await self.stage.disconnect()
        finally:
            self.temp.cleanup()

    async def simulate(self, **config):
        await self.stage.configure(StageConfig(mode="simulation", **config), "test")
        await self.stage.connect("test")

    async def test_no_connection_or_motion_on_construction(self):
        self.assertFalse(self.stage.connected)
        self.assertIsNone(self.stage.driver)
        self.assertEqual(self.stage.config.mode, "real")
        self.assertFalse(self.stage.path.exists())

    async def test_axis_permutation_and_inversion_route_exact_channel(self):
        await self.simulate(axes={"x": 3, "y": 1, "z": 2}, inverted={"x": True, "y": False, "z": False})
        await self.stage.move(StageMove(axis="x", direction=1, steps=25), "test")
        self.assertEqual(self.stage.driver.counts, {1: 0, 2: 0, 3: -25})
        self.assertFalse(self.stage.snapshot()["position_feedback"])

    async def test_mapping_survives_reload_without_autoconnect(self):
        config = StageConfig(axes={"x": 2, "y": 3, "z": 1})
        await self.stage.configure(config, "test")
        other = StageController(Path(self.temp.name), self.events)
        self.assertEqual(other.config.axes, config.axes)
        self.assertFalse(other.connected)

    async def test_invalid_mapping_and_ip_rejected(self):
        for axes in ({"x": 1, "y": 1, "z": 3}, {"x": 1, "y": 2}, {"x": 0, "y": 2, "z": 3}):
            with self.assertRaises(ValidationError):
                StageConfig(axes=axes)
        for host in ("COM3", "127.0.0.1:8770", "not-an-ip"):
            with self.assertRaises(ValidationError):
                StageConfig(host=host)

    async def test_connection_requires_real_serial_and_never_falls_back(self):
        with self.assertRaises(StageError):
            await self.stage.connect("test")
        driver = Mock()
        driver.connect.side_effect = OSError("offline")
        self.stage.driver_factory = lambda _: driver
        await self.stage.configure(StageConfig(serial_number="129123456"), "test")
        with self.assertRaisesRegex(StageError, "offline"):
            await self.stage.connect("test")
        self.assertFalse(self.stage.connected)
        self.assertEqual(self.stage.config.mode, "real")
        driver.close.assert_called_once()
        driver.move.assert_not_called()

    async def test_reject_moves_before_connect_and_above_limit(self):
        command = StageMove(axis="z", direction=-1, steps=11)
        with self.assertRaises(StageError):
            await self.stage.move(command, "test")
        await self.simulate(max_steps=10)
        with self.assertRaises(StageError):
            await self.stage.move(command, "test")
        self.assertEqual(self.stage.driver.counts, {1: 0, 2: 0, 3: 0})

    async def test_block_remap_until_disconnected(self):
        await self.simulate()
        with self.assertRaises(StageError):
            await self.stage.configure(StageConfig(), "test")

    async def test_busy_unknown_and_fault_states_block_motion(self):
        await self.simulate()
        driver = self.stage.driver
        original = driver.status
        for changes in ({"moving": True}, {"moving": None}, {"ready": False, "error": "位移台类型不匹配"}):
            rows = original()
            rows[0].update(changes)
            driver.status = lambda: rows
            with self.assertRaises(StageError):
                await self.stage.move(StageMove(axis="x", direction=1, steps=5), "test")
        driver.status = original
        self.assertEqual(driver.counts[1], 0)

    async def test_ambiguous_move_is_not_retried_and_stop_remains_available(self):
        await self.simulate()
        driver = self.stage.driver
        driver.move = Mock(side_effect=OSError("lost acknowledgement"))
        driver.stop = Mock()
        with self.assertRaises(StageError):
            await self.stage.move(StageMove(axis="y", direction=1, steps=5), "test")
        self.assertFalse(self.stage.connected)
        self.assertIn("未确认", self.stage.error)
        driver.move.assert_called_once_with(2, 1, 5)
        driver.stop.assert_called_once()
        await self.stage.stop("test")
        self.assertEqual(driver.stop.call_count, 2)

    async def test_failed_stop_does_not_release_connection_or_allow_remap(self):
        await self.simulate()
        await self.stage.move(StageMove(axis="x", direction=1, steps=1), "test")
        driver = self.stage.driver
        driver.stop = Mock(side_effect=OSError("lost stop"))
        with self.assertRaises(StageError):
            await self.stage.disconnect("test")
        self.assertIs(self.stage.driver, driver)
        with self.assertRaises(StageError):
            await self.stage.configure(StageConfig(), "test")
        driver.stop = Mock()

    async def test_steps_must_be_positive_integer(self):
        for steps in (0, -1, 1.5, True, "10", 100001):
            with self.assertRaises(ValidationError):
                StageMove(axis="x", direction=1, steps=steps)


class DriverTests(unittest.TestCase):
    def test_move_uses_signed_finite_relative_pulses_with_no_wait(self):
        from app.drivers.thorlabs_pdxc3 import Pdxc3Driver
        from thorlabs_xa.shared.enums import TLMC_MoveMode
        driver = Pdxc3Driver("129123456")
        channel = Mock()
        channel.get_stage_axis_params.return_value.part_number = "PD1V/M"
        driver.channels = {3: channel}
        driver.move(3, -1, 23)
        channel.move.assert_called_once_with(TLMC_MoveMode.TLMC_MoveMode_Relative, -23, 0)
        channel.home.assert_not_called()

    def test_stop_attempts_all_channels_even_when_one_fails(self):
        from app.drivers.thorlabs_pdxc3 import Pdxc3Driver
        driver = Pdxc3Driver("129123456")
        driver.channels = {n: Mock() for n in (1, 2, 3)}
        driver.channels[1].stop.side_effect = OSError("offline")
        with self.assertRaises(RuntimeError):
            driver.stop()
        for channel in driver.channels.values():
            channel.stop.assert_called_once()
