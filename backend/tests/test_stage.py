import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from types import SimpleNamespace

from pydantic import ValidationError

from app.stage import SimulatedStage, StageAction, StageConfig, StageController, StageError, StageJog, StageMove


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

    async def test_unwritable_stage_config_names_directory_and_permission(self):
        failure = PermissionError(13, "Permission denied")
        with patch.object(Path, "write_text", side_effect=failure):
            with self.assertRaises(StageError) as caught:
                await self.stage.configure(StageConfig(mode="simulation"), "test")
        message = str(caught.exception)
        self.assertIn(str(self.stage.path), message)
        self.assertIn("写入权限", message)
        self.assertFalse(self.stage.path.exists())

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
        await self.pause_polling()
        driver = self.stage.driver
        original = driver.status
        for changes in ({"moving": True}, {"moving": None}, {"ready": False, "error": "位移台类型不匹配"}):
            rows = original()
            rows[0].update(changes)
            driver.status = lambda: rows
            # Cached-sample fast path: force a fresh read so the mocked state applies.
            self.stage._last_sample = None
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

    def move_results(self):
        return [call.args[4] for call in self.events.call_args_list if call.args[0] == "stage_move"]

    async def pause_polling(self):
        self.stage._poll_task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await self.stage._poll_task
        self.stage._poll_task = None

    async def test_move_waits_for_a_later_complete_idle_sample(self):
        await self.simulate()
        await self.pause_polling()
        command = StageMove(axis="x", direction=1, steps=10)
        response = await self.stage.move(command, "test")
        self.assertTrue(response["motion_pending"])
        with self.assertRaises(StageError):
            await self.stage.move(command, "other_operator")
        original = self.stage.driver.status
        for moving in (True, None):
            rows = original()
            rows[0]["moving"] = moving
            self.stage.driver.status = lambda: rows
            await self.stage._poll_once()
            self.assertTrue(self.stage.motion_pending)
        self.stage.driver.status = lambda: original()[:2]
        await self.stage._poll_once()
        self.assertTrue(self.stage.motion_pending)
        self.stage.driver.status = original
        await self.stage._poll_once()
        self.assertFalse(self.stage.motion_pending)
        await self.stage.move(command, "test")
        self.assertEqual(self.stage.driver.counts[1], 20)
        self.assertEqual([row["result"] for row in self.move_results()], ["submitted", "rejected", "submitted"])

    async def test_move_results_distinguish_rejection_and_ambiguous_send(self):
        command = StageMove(axis="y", direction=-1, steps=5)
        with self.assertRaises(StageError):
            await self.stage.move(command, "test")
        self.assertEqual(self.move_results()[-1]["result"], "rejected")
        await self.simulate(axes={"x": 3, "y": 1, "z": 2}, inverted={"x": False, "y": True, "z": False})
        await self.pause_polling()
        driver = self.stage.driver
        original = driver.status
        driver.status = Mock(side_effect=OSError("preflight read failed"))
        driver.move = Mock()
        self.stage._last_sample = None
        with self.assertRaises(StageError):
            await self.stage.move(command, "test")
        driver.move.assert_not_called()
        self.assertEqual(self.move_results()[-1]["result"], "rejected")
        driver.status = original
        self.stage.connected = True
        driver.move.side_effect = OSError("ack lost")
        driver.stop = Mock()
        with self.assertRaises(StageError):
            await self.stage.move(command, "test")
        result = self.move_results()[-1]
        self.assertEqual((result["result"], result["channel"], result["hardware_direction"], result["mode"]),
                         ("unconfirmed", 1, 1, "simulation"))
        self.assertIn("ack lost", result["reason"])
        self.assertTrue(self.stage.motion_pending)
        self.assertFalse(self.stage.connected)
        driver.move.assert_called_once_with(1, 1, 5)
        await self.stage.stop("test")
        self.assertFalse(self.stage.motion_pending)
        self.assertFalse(self.stage.connected)  # A stop never silently reconnects a faulted driver.

    async def test_concurrent_move_is_rejected_without_queueing(self):
        await self.simulate()
        await self.pause_polling()
        driver = self.stage.driver
        entered, release = threading.Event(), threading.Event()
        def blocked_move(*_):
            entered.set()
            if not release.wait(2):
                raise TimeoutError("test worker timed out")
        driver.move = Mock(side_effect=blocked_move)
        command = StageMove(axis="x", direction=1, steps=3)
        first = asyncio.create_task(self.stage.move(command, "first"))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            with self.assertRaises(StageError):
                await asyncio.wait_for(self.stage.move(command, "second"), .1)
        finally:
            release.set()
        await first
        driver.move.assert_called_once()
        self.assertEqual(self.move_results()[0]["result"], "rejected")

    async def test_stop_cancels_admitted_move_still_waiting_for_preflight(self):
        await self.simulate()
        await self.pause_polling()
        driver = self.stage.driver
        original = driver.status
        self.stage._last_sample = None
        entered, release = threading.Event(), threading.Event()
        calls = 0
        def blocked_status():
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                if not release.wait(2):
                    raise TimeoutError("test worker timed out")
            return original()
        driver.status = blocked_status
        driver.move, driver.stop = Mock(), Mock()
        first = asyncio.create_task(self.stage.move(StageMove(axis="x", direction=1, steps=3), "test"))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        stop = asyncio.create_task(self.stage.stop("test"))
        await asyncio.sleep(0)
        release.set()
        with self.assertRaisesRegex(StageError, "未下发"):
            await first
        response = await stop
        driver.move.assert_not_called()
        driver.stop.assert_called_once()
        self.assertFalse(response["motion_pending"])

    async def test_failed_stop_keeps_pending_and_successful_disconnect_resets_it(self):
        await self.simulate()
        await self.stage.move(StageMove(axis="z", direction=1, steps=1), "test")
        self.stage.driver.stop = Mock(side_effect=OSError("stop failed"))
        with self.assertRaises(StageError):
            await self.stage.stop("test")
        self.assertTrue(self.stage.snapshot()["motion_pending"])
        self.stage.driver.stop = Mock()
        await self.stage.disconnect("test")
        self.assertFalse(self.stage.snapshot()["motion_pending"])

    async def test_move_reuses_fresh_poll_sample_without_preflight_read(self):
        await self.simulate()
        await self.pause_polling()
        driver = self.stage.driver
        original = driver.status
        driver.status = Mock(side_effect=AssertionError("fresh poll sample must be reused"))
        try:
            response = await self.stage.move(StageMove(axis="x", direction=1, steps=4), "test")
            self.assertTrue(response["motion_pending"])
            self.assertEqual(driver.counts[1], 4)
        finally:
            driver.status = original

    async def test_stale_sample_forces_one_fresh_preflight_read(self):
        await self.simulate()
        await self.pause_polling()
        driver = self.stage.driver
        original = driver.status
        calls = []
        driver.status = lambda: (calls.append(1), original())[1]
        self.stage._last_sample = 0
        await self.stage.move(StageMove(axis="x", direction=1, steps=1), "test")
        self.assertEqual(len(calls), 1)
        self.assertEqual(driver.counts[1], 1)

    async def test_continuous_jog_runs_until_stop_without_deadline(self):
        await self.simulate()
        await self.pause_polling()
        response = await self.stage.jog(StageJog(axis="y", direction=-1), "test")
        self.assertTrue(response["motion_pending"])
        self.assertEqual(response["jogging"], {"axis": "y", "channel": 2, "direction": -1})
        self.assertEqual(self.stage._motion_deadline, 0)
        self.assertTrue(any(row["moving"] for row in self.stage.driver.status()))
        with self.assertRaises(StageError):
            await self.stage.jog(StageJog(axis="y", direction=1), "test")
        results = self.move_results()
        self.assertTrue(results[-2].get("continuous"))
        self.assertEqual(results[-2]["result"], "submitted")
        self.assertEqual(results[-1]["result"], "rejected")
        await self.stage.stop("test")
        snapshot = self.stage.snapshot()
        self.assertFalse(snapshot["motion_pending"])
        self.assertIsNone(snapshot["jogging"])
        self.assertFalse(any(row["moving"] for row in snapshot["channels"]))
        self.assertEqual(self.stage.driver.counts, {1: 0, 2: 0, 3: 0})

    async def test_home_instant_return_reports_counter_zero_only(self):
        await self.simulate()
        await self.pause_polling()
        driver = self.stage.driver
        driver.home = Mock()  # Firmware answers instantly; no motion observed.
        response = await self.stage.control(StageAction(axis="x", operation="home", confirmed=True), "test")
        self.assertFalse(response["motion_pending"])
        driver.home.assert_called_once_with(1, -1)  # default direction from config
        actions = [call.args for call in self.events.call_args_list if call.args[0] == "stage_action"]
        self.assertEqual(actions[-1][4]["result"], "zeroed_only")

    async def test_home_motion_waits_for_completion_and_honours_direction(self):
        await self.simulate(inverted={"x": True, "y": False, "z": False})
        await self.pause_polling()
        driver = self.stage.driver
        driver.home = Mock(side_effect=lambda channel, direction: SimulatedStage.home(driver, channel, direction))
        response = await self.stage.control(
            StageAction(axis="x", operation="home", confirmed=True, home_direction=1), "test")
        self.assertTrue(response["motion_pending"])
        driver.home.assert_called_once_with(1, -1)  # UI +1 inverted maps to hardware −1
        self.assertEqual(driver.counts[1], 0)
        self.stage._operation_at = time.monotonic() - 5
        await asyncio.sleep(0.9)  # Let the simulated search motion finish.
        await self.stage._poll_once()
        self.assertFalse(self.stage.motion_pending)
        actions = [call.args for call in self.events.call_args_list if call.args[0] == "stage_action"]
        self.assertEqual(actions[-1][4]["result"], "completed")

    async def test_step_presets_editable_while_connected_and_persisted(self):
        await self.simulate()
        response = await self.stage.set_presets([2, 20, 200], "test")
        self.assertEqual(response["config"]["step_presets"], [2, 20, 200])
        reloaded = StageController(Path(self.temp.name), Mock())
        self.assertEqual(reloaded.config.step_presets, [2, 20, 200])
        for bad in ([1], [1] * 7, [0, 2], [2, 2]):
            with self.assertRaises(StageError):
                await self.stage.set_presets(bad, "test")
        self.assertEqual(self.stage.config.step_presets, [2, 20, 200])


class DriverTests(unittest.TestCase):
    def test_move_uses_verified_single_step_jog_with_no_wait(self):
        from app.drivers.thorlabs_pdxc3 import Pdxc3Driver
        from thorlabs_xa.shared.enums import TLMC_MoveMode
        driver = Pdxc3Driver("129123456")
        channel = Mock()
        channel.get_stage_axis_params.return_value.part_number = "PD1V/M"
        driver.channels = {3: channel}
        driver.stage_names = {3: "PD1V/M"}
        driver._set_setting = Mock()
        channel.get_setting.side_effect = lambda key, _: SimpleNamespace(is_value_set=True, value={'jog.mode':2,'jog.openLoopStepSize':23,'jog.openLoopMaxVelocity':5000,'jog.openLoopAcceleration':1000}[key])
        driver.move(3, -1, 23)
        channel.move.assert_called_once_with(TLMC_MoveMode.TLMC_MoveMode_JogReverse, 0, 0)
        self.assertEqual(driver._set_setting.call_args_list[1].args, (3, 'jog.openLoopStepSize', 23))
        self.assertEqual(driver._set_setting.call_args_list[0].args, (3, 'jog.mode', 2))
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
