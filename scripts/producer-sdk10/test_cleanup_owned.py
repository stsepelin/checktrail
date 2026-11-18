import contextlib
import copy
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common
import cleanup_owned as cleanup
from test_live_resource import Clock

class Controller:
    def __init__(self, root, clock):
        self.root, self.clock = root, clock
        (root / 'evidence').mkdir()
        self.ctx = {'run': 123, 'nonce': 'synthetic'}
        self.state = {'volume': 'owned-work', 'tempVolume': 'owned-temp', 'operatorFullRoundtripAcknowledged': True,
                      'captureReady': True, 'cleanupDeadline': 21000, 'phaseDeadline': 300}
        self.owned = {'Name': 'owned-work', 'Labels': {'context': 'synthetic'}}
        self.reads = [copy.deepcopy(self.owned), None]
        self.remove = {'exitCode': -9, 'reason': 'owned command deadline', 'ownedChildReaped': True}
        self.calls = []
    def volume_owned(self, name):
        self.calls.append(('ownership', name))
        self.clock.advance(1)
        return {**self.owned, 'Name': name}
    def docker(self, argv, seconds, check):
        self.calls.append(('delete', argv, seconds, check))
        self.clock.advance(30)
        return self.remove, None
    def inspect(self, kind, name):
        self.calls.append(('read', kind, name))
        self.clock.advance(1)
        result = self.reads.pop(0) if self.reads else self.owned
        if isinstance(result, BaseException):
            raise result
        return result

class Cleanup(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        clock = Clock()
        c = Controller(pathlib.Path(temp.name), clock)
        return c, clock
    def run_cleanup(self, c, clock, name='owned-work'):
        with patch.object(common.time, 'monotonic', clock), contextlib.redirect_stdout(io.StringIO()):
            return cleanup.remove_volume(c, name, clock=clock, sleep=clock.advance)
    def test_one_ambiguous_delete_then_positive_absence(self):
        c, clock = self.fixture()
        result = self.run_cleanup(c, clock)
        self.assertTrue(result['positiveOwnedAbsenceObserved'])
        self.assertEqual(result['removeCommand']['exitCode'], -9)
        self.assertEqual(sum(x[0] == 'delete' for x in c.calls), 1)
        self.assertEqual(sum(x[0] == 'read' for x in c.calls), 2)
        self.assertEqual(c.state['phaseDeadline'], 300)
        request = c.root / 'evidence/CLEANUP-work-DELETE-REQUEST.json'
        self.assertTrue(json.loads(request.read_text())['oneDeleteReserved'])
        self.assertFalse(result['privacySafeProjection']['sourceBuildOrCustodyCredit'])
    def test_repeated_cleanup_refuses_before_any_api_or_second_delete(self):
        c, clock = self.fixture()
        self.run_cleanup(c, clock)
        before = copy.deepcopy(c.calls)
        with self.assertRaisesRegex(common.Refusal, 'already reserved'):
            self.run_cleanup(c, clock)
        self.assertEqual(c.calls, before)
    def test_unknown_or_unrelated_volume_refuses_before_effects(self):
        c, clock = self.fixture()
        with self.assertRaisesRegex(common.Refusal, 'exact two'):
            self.run_cleanup(c, clock, 'foreign-cache-volume')
        self.assertEqual(c.calls, [])
    def test_full_custody_and_capture_both_required(self):
        for field in ('operatorFullRoundtripAcknowledged', 'captureReady'):
            c, clock = self.fixture()
            c.state[field] = False
            with self.subTest(field=field), self.assertRaisesRegex(common.Refusal, 'independent full recovery'):
                self.run_cleanup(c, clock)
            self.assertEqual(c.calls, [])
    def test_both_marker_families_including_dangling_symlink_refuse(self):
        for name in ('CLEANUP-work-DELETE-REQUEST.json', 'CLEANUP-work-RESULT.json'):
            c, clock = self.fixture()
            (c.root / 'evidence' / name).symlink_to(c.root / 'missing')
            with self.subTest(name=name), self.assertRaisesRegex(common.Refusal, 'already reserved'):
                self.run_cleanup(c, clock)
            self.assertEqual(c.calls, [])
    def test_foreign_replacement_stops_without_second_delete_or_more_reads(self):
        c, clock = self.fixture()
        c.reads = [{'Name': 'owned-work', 'Labels': {'context': 'foreign'}}, None]
        result = self.run_cleanup(c, clock)
        self.assertFalse(result['positiveOwnedAbsenceObserved'])
        self.assertEqual(sum(x[0] == 'delete' for x in c.calls), 1)
        self.assertEqual(sum(x[0] == 'read' for x in c.calls), 1)
    def test_read_unavailable_does_not_mean_absent(self):
        c, clock = self.fixture()
        c.reads = [OSError('first-party read unavailable')] * 16
        result = self.run_cleanup(c, clock)
        self.assertFalse(result['positiveOwnedAbsenceObserved'])
        self.assertEqual(len(result['absenceReads']), 16)
        self.assertTrue(all('inspectionErrorType' in row for row in result['absenceReads']))
        self.assertEqual(sum(x[0] == 'delete' for x in c.calls), 1)
    def test_still_present_after_finite_reads_is_not_cleanup_credit(self):
        c, clock = self.fixture()
        c.reads = [copy.deepcopy(c.owned)] * 16
        result = self.run_cleanup(c, clock)
        self.assertFalse(result['positiveOwnedAbsenceObserved'])
        self.assertEqual(len(result['absenceReads']), 16)
    def test_actual_missing_after_global_cleanup_deadline_not_credited(self):
        c, clock = self.fixture()
        c.state['phaseDeadline'] = 10
        c.reads = [None]
        result = self.run_cleanup(c, clock)
        self.assertFalse(result['positiveOwnedAbsenceObserved'])
        self.assertTrue(result['cleanupBudgetExhausted'])
        self.assertEqual(sum(x[0] == 'delete' for x in c.calls), 1)
    def test_request_persistence_deadline_refuses_before_delete(self):
        c, clock = self.fixture()
        real = cleanup.freeze
        def delayed(path, body):
            real(path, body)
            if pathlib.Path(path).name.endswith('DELETE-REQUEST.json'):
                clock.advance(11)
        with patch.object(cleanup, 'freeze', delayed):
            result = self.run_cleanup(c, clock)
        self.assertFalse(result['deleteAttempted'])
        self.assertFalse(result['positiveOwnedAbsenceObserved'])
        self.assertEqual(sum(x[0] == 'delete' for x in c.calls), 0)
    def test_late_result_fsync_does_not_leave_cleanup_credited(self):
        c, clock = self.fixture()
        c.reads = [None]
        real = common.freeze
        def delayed(path, body):
            real(path, body)
            if pathlib.Path(path).name == 'CLEANUP-work-RESULT.json':
                clock.advance(400)
        with patch.object(common, 'freeze', delayed):
            result = self.run_cleanup(c, clock)
        self.assertFalse(result['positiveOwnedAbsenceObserved'])
        self.assertTrue(result['completionBudgetExhausted'])
        self.assertEqual(result['removeCommand']['exitCode'], -9)
        self.assertFalse(result['privacySafeProjection']['positiveOwnedAbsenceObserved'])

if __name__ == '__main__':
    unittest.main()
