import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.storage import HistoryStore


class HistoryResetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = HistoryStore(Path(self.temp.name) / 'history.sqlite3')
        for mode in ('simulation', 'real'):
            self.store.write_sample('2026-10-10T00:00:00+00:00',
                [{'channel':4,'pressure_pa':0.0016,'valid':True}], mode, 1)
        self.store.write_event('trip', 'critical', '保留保护审计')

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def rows(self):
        return self.store.history('2026-01-01', '2027-01-01', [4])

    def test_simulation_reset_preserves_real_samples_and_audit(self):
        self.assertEqual(self.store.reset_history('simulation','operator'),1)
        self.assertEqual([row['mode'] for row in self.rows()], ['real'])
        events = self.store.list_events(None,None)
        self.assertTrue(any(e['type']=='trip' for e in events))
        audit = next(e for e in events if e['type']=='history_reset')
        self.assertEqual(audit['details'], {'scope':'simulation','deleted':1})
        self.assertEqual(audit['actor'],'operator')

    def test_all_reset_and_subsequent_sampling(self):
        self.assertEqual(self.store.reset_history('all','operator'),2)
        self.assertEqual(self.rows(),[])
        self.store.write_sample('2026-10-10T00:01:00+00:00', [{'channel':4,'valid':True}], 'real',1)
        self.assertEqual(len(self.rows()),1)
        self.assertTrue(self.store.list_events(None,None))

    def test_audit_failure_rolls_back_deletion(self):
        self.store._db.execute("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
        with self.assertRaises(sqlite3.Error): self.store.reset_history('all','operator')
        self.assertEqual(len(self.rows()),2)

    def test_invalid_scope_does_not_delete(self):
        with self.assertRaises(ValueError): self.store.reset_history('real','operator')
        self.assertEqual(len(self.rows()),2)
