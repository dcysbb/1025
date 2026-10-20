import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.configuration import ConfigurationStore
from app.drivers.adam6050 import ModbusError
from app.engine import InterlockEngine
from app.models import AppConfig, ChannelConfig
from app.storage import HistoryStore


class AutoPressureRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ConfigurationStore(Path(self.temp.name))
        self.store.update(AppConfig(
            mode="real", tpg_connection="usb", tpg_serial_port="COM3", dam_serial_port="COM9",
            fail_closed_confirmed=True, pressure_trip_latched=False, recovery_hold_s=5,
            channels=[ChannelConfig(enabled=i == 3, trip_pa=.01, reset_pa=.005) for i in range(6)],
        ))
        self.history = HistoryStore(Path(self.temp.name) / "history.sqlite3")
        self.e = InterlockEngine(self.store, self.history)
        self.e.tpg = AsyncMock()
        self.e._channels = [{"channel": 4, "pressure_pa": .001, "valid": True,
                             "status": "正常", "status_code": 0}]
        self.coils = [False] * 8
        self.inputs = [True] + [False] * 7
        self.e.adam = AsyncMock()
        self.e.adam.read_inputs.side_effect = lambda: list(self.inputs)
        self.e.adam.read_outputs.side_effect = lambda: list(self.coils)

        async def write(channel, value):
            self.coils[channel] = value
            self.inputs[0] = value != self.e.config.valve_open_on_energized

        self.e.adam.write_output.side_effect = write

        async def sample():
            self.e._last_tpg_read = time.monotonic()
            self.e._tpg_connected = True

        self.poll = patch.object(self.e, "_poll_tpg", side_effect=sample)
        self.poll.start()
        await self.e._poll_io()
        await self.e._poll_tpg()

    async def asyncTearDown(self):
        await self.e.stop()
        self.poll.stop()
        self.history.close()
        self.temp.cleanup()

    async def tick(self):
        self.e._next_io_poll = 0
        await self.e._tick(time.monotonic())

    async def pressure_trip(self):
        await self.e.arm()
        await self.e.open_valve()
        self.e._channels[0]["pressure_pa"] = .01
        await self.tick()
        self.assertEqual(self.e.interlock, "tripped", self.e.trip_reason)
        self.assertFalse(self.e._open_output)

    async def stable(self):
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        if self.e._recovery_since is not None:
            self.e._recovery_since -= 6
        await self.tick()

    async def test_threshold_closes_then_stable_recovery_reopens_once(self):
        await self.pressure_trip()
        self.assertTrue(self.e.snapshot()["auto_reopen_pending"])
        self.assertIsNone(self.e.snapshot()["recovery_remaining_s"])
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        self.assertFalse(self.coils[0])
        self.assertGreater(self.e.snapshot()["recovery_remaining_s"], 4)
        self.e._recovery_since -= 6
        await self.tick()
        self.assertEqual(self.e.interlock, "armed")
        self.assertTrue(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])
        writes = self.e.adam.write_output.await_count
        await self.tick()
        self.assertEqual(self.e.adam.write_output.await_count, writes)
        events = self.history.list_events(None, None, 100)
        self.assertEqual(sum(e["type"] == "interlock_auto_recovered" for e in events), 1)
        self.assertTrue(any(e["type"] == "valve_open_command" and e["actor"] == "system" for e in events))

    async def test_latched_mode_keeps_closed_after_recovery(self):
        self.e.config.pressure_trip_latched = True
        await self.pressure_trip()
        await self.stable()
        self.assertEqual(self.e.interlock, "tripped")
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_hysteresis_and_every_protected_channel_must_recover(self):
        await self.pressure_trip()
        self.e._channels[0]["pressure_pa"] = .005
        await self.tick()
        self.assertIsNone(self.e._recovery_since)
        self.e._channels[0]["pressure_pa"] = .004
        await self.tick()
        self.assertIsNotNone(self.e._recovery_since)
        self.e._channels[0]["pressure_pa"] = .006
        await self.tick()
        self.assertIsNone(self.e._recovery_since)
        self.e.config.channels[0].enabled = True
        self.e._channels.append({"channel": 1, "pressure_pa": .006, "valid": True, "status": "正常"})
        self.e._channels[0]["pressure_pa"] = .001
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertIsNone(self.e._recovery_since)

    async def test_pressure_spike_remains_eligible_after_next_sample_recovers(self):
        await self.e.arm()
        await self.e.open_valve()
        self.e._channels[0]["pressure_pa"] = .02
        await self.e._gauge_cycle(time.monotonic())
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        self.assertTrue(self.e.snapshot()["auto_reopen_pending"])
        await self.stable()
        self.assertTrue(self.coils[0])

    async def test_brief_hysteresis_excursion_resets_stability_between_ticks(self):
        await self.pressure_trip()
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        self.e._recovery_since -= 6
        self.e._channels[0]["pressure_pa"] = .006
        await self.e._gauge_cycle(time.monotonic())
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        self.assertFalse(self.coils[0])
        self.assertGreater(self.e.snapshot()["recovery_remaining_s"], 4)

    async def test_manual_close_cancels_auto_reopen(self):
        await self.pressure_trip()
        await self.e.close_valve()
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_disarm_cancels_auto_reopen(self):
        await self.pressure_trip()
        await self.e.disarm()
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_configuration_change_cancels_recovery(self):
        await self.pressure_trip()
        await self.e.patch_config({"pressure_trip_latched": True})
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_previously_closed_valve_is_not_automatically_opened(self):
        await self.e.arm()
        self.e._channels[0]["pressure_pa"] = .02
        await self.tick()
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_invalid_measurement_never_auto_recovers(self):
        await self.e.arm()
        await self.e.open_valve()
        self.e._channels[0]["valid"] = False
        await self.tick()
        self.e._channels[0]["valid"] = True
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_transient_invalid_reading_during_recovery_cancels_it(self):
        await self.pressure_trip()
        self.e._channels[0]["valid"] = False
        await self.e._gauge_cycle(time.monotonic())
        self.e._channels[0]["valid"] = True
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertEqual(self.e.interlock, "fault")

    async def test_io_outage_cancels_even_if_link_recovers_before_tick(self):
        await self.pressure_trip()
        self.e._begin_io_recovery("timeout")
        self.e._finish_io_recovery()
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_stale_pressure_during_recovery_requires_manual_reset(self):
        await self.pressure_trip()
        self.e._last_tpg_read = time.monotonic() - 10
        with patch.object(self.e, "_poll_tpg", new=AsyncMock()):
            await self.tick()
        await self.stable()
        self.assertFalse(self.coils[0])
        self.assertEqual(self.e.interlock, "fault")

    async def test_failed_automatic_open_is_not_retried(self):
        await self.pressure_trip()
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        self.e._recovery_since -= 6
        write = self.e.adam.write_output.side_effect

        async def fail_open(channel, value):
            if value:
                raise ModbusError("open acknowledgement lost")
            await write(channel, value)

        self.e.adam.write_output.side_effect = fail_open
        await self.tick()
        await self.stable()
        opens = [call for call in self.e.adam.write_output.await_args_list if call.args[1]]
        self.assertEqual(len(opens), 2)  # Initial manual open, then one automatic attempt.
        self.assertEqual(self.e.interlock, "fault")
        self.assertFalse(self.coils[0])

    async def test_reverse_relay_mapping_is_used_on_auto_open(self):
        self.e.config.valve_open_on_energized = False
        self.coils[0] = True
        await self.pressure_trip()
        self.assertTrue(self.coils[0])
        await self.stable()
        self.assertTrue(self.e._open_output)
        self.assertFalse(self.coils[0])

    async def test_restart_never_restores_auto_open_intent(self):
        await self.pressure_trip()
        restarted = InterlockEngine(self.store, self.history)
        self.assertEqual(restarted.interlock, "disarmed")
        self.assertFalse(restarted.snapshot()["auto_reopen_pending"])

    async def test_close_feedback_failure_prevents_automatic_open(self):
        await self.pressure_trip()
        self.inputs[0] = False
        self.e._valve_command_at -= 3
        await self.stable()
        self.assertEqual(self.e.interlock, "fault")
        self.assertFalse(self.coils[0])
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])

    async def test_fault_clear_cancels_auto_open_and_leaves_disarmed(self):
        await self.pressure_trip()
        await self.e.clear_fault()
        await self.stable()
        self.assertEqual(self.e.interlock, "disarmed")
        self.assertFalse(self.coils[0])

    async def test_io_close_failure_cancels_auto_open(self):
        await self.e.arm()
        await self.e.open_valve()
        self.e.adam.write_output.side_effect = ModbusError("close acknowledgement lost")
        self.e._channels[0]["pressure_pa"] = .02
        await self.tick()
        self.assertFalse(self.e.snapshot()["auto_reopen_pending"])
        self.assertTrue(self.e._off_retry_pending)

    async def test_bad_sample_at_final_reset_check_prevents_open(self):
        await self.pressure_trip()
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        self.e._recovery_since -= 6
        poll = self.e._poll_tpg.side_effect
        reads = 0

        async def final_bad_sample():
            nonlocal reads
            await poll()
            reads += 1
            if reads == 2:
                self.e._channels[0]["pressure_pa"] = .02

        self.e._poll_tpg.side_effect = final_bad_sample
        await self.tick()
        self.assertEqual(self.e.interlock, "fault")
        self.assertFalse(self.coils[0])

    async def test_storage_fault_cancels_auto_recovery(self):
        await self.pressure_trip()
        self.e._history_error = "audit unavailable"
        await self.stable()
        self.assertEqual(self.e.interlock, "fault")
        self.assertFalse(self.coils[0])

    async def test_stability_reset_during_final_poll_prevents_open(self):
        await self.pressure_trip()
        self.e._channels[0]["pressure_pa"] = .001
        await self.tick()
        self.e._recovery_since -= 6
        poll = self.e._poll_tpg.side_effect
        reads = 0

        async def interrupted_stability():
            nonlocal reads
            await poll()
            reads += 1
            if reads == 2:
                self.e._recovery_since = None

        self.e._poll_tpg.side_effect = interrupted_stability
        await self.tick()
        self.assertEqual(self.e.interlock, "fault")
        self.assertFalse(self.coils[0])

    async def test_legacy_configuration_defaults_to_latched(self):
        self.assertTrue(AppConfig.model_validate({}).pressure_trip_latched)
        with self.assertRaises(ValueError):
            AppConfig(pressure_trip_latched="false")
