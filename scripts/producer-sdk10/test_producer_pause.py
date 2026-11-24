"""Synthetic controller state + inert filesystem churn; no Docker/native SDK."""
import copy
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import producer_pause as p
import common
FROZEN = Path(__file__).resolve().parent / 'meter.py'
# A second, unchanged instance of the meter, from the same verified bytes the bundle runs.
meter = types.ModuleType('unchanged_sdk_meter'); meter.__file__ = str(FROZEN)
exec(compile(common.bundle_bytes(FROZEN), str(FROZEN), 'exec'), meter.__dict__)
BINDING = {'id': 'a' * 64, 'name': 'ct-sdk10-synthetic-original-build', 'labels': {'run': '1', 'nonce': 'synthetic', 'head': 'b' * 40}}

class API:
    def __init__(self, fault=None):
        self.fault, self.calls = fault, []
        self.obj = {'Id': BINDING['id'], 'Name': '/' + BINDING['name'], 'Config': {'Labels': copy.deepcopy(BINDING['labels'])}, 'State': {'Running': True, 'Paused': False}}
    def inspect_id(self, identity, deadline):
        self.calls.append(('inspect', identity, deadline))
        if self.fault == 'inspect-after-pause' and self.obj is not None and self.obj['State']['Paused']: raise TimeoutError('synthetic unavailable identity')
        if self.fault == 'cleanup-inspect-unavailable' and sum(x[0] == 'inspect' for x in self.calls) >= 4: raise TimeoutError('synthetic cleanup read unavailable')
        return copy.deepcopy(self.obj)
    def pause_id(self, identity, deadline):
        self.calls.append(('pause', identity, deadline))
        if self.fault == 'pause-fail': return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': 1, 'reason': None}
        if self.fault == 'terminal-during-pause': self.obj['State'].update(Running=False, Paused=False); return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': 1, 'reason': None}
        if self.fault == 'terminal-after-successful-pause': self.obj['State'].update(Running=False, Paused=False); return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': 0, 'reason': None}
        self.obj['State']['Paused'] = True
        if self.fault == 'pause-exception': raise TimeoutError('synthetic ambiguous pause')
        return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': -9 if self.fault == 'pause-timeout' else 0, 'reason': 'owned command deadline' if self.fault == 'pause-timeout' else None}
    def unpause_id(self, identity, deadline):
        self.calls.append(('unpause', identity, deadline))
        if self.fault in ['unpause-fail', 'abort-fail', 'preserve-false', 'preserve-raises']: return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': 1, 'reason': None}
        self.obj['State']['Paused'] = False
        return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': -9 if self.fault == 'unpause-timeout' else 0, 'reason': 'owned command deadline' if self.fault == 'unpause-timeout' else None}
    def preserve_protected_metadata(self, binding, deadline):
        self.calls.append(('preserve', binding['id'], deadline))
        if self.fault == 'preserve-false': return False
        if self.fault == 'preserve-raises': raise OSError('synthetic protected evidence unavailable')
        return True
    def force_remove_id(self, identity, deadline):
        self.calls.append(('force_remove', identity, deadline))
        if self.fault == 'abort-fail': return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': 1, 'reason': None}
        self.obj = None; return {'ownedChildStarted': True, 'ownedChildReaped': True, 'exitCode': 0, 'reason': None}

class Protocol(unittest.TestCase):
    def run_case(self, api, scan=None, clock=lambda: 0):
        return p.run(copy.deepcopy(BINDING), api, scan or (lambda: {'samplingComplete': True}), 100, 90, clock)
    def test_successful_exact_owned_pause_sample_resume_uses_one_absolute_budget(self):
        api = API(); row = self.run_case(api)
        self.assertEqual(row['outcome'], 'complete-sample-lifecycle'); self.assertTrue(row['lifecycleVerified']); self.assertFalse(api.obj['State']['Paused'])
        self.assertEqual([x[0] for x in api.calls if x[0] != 'inspect'], ['pause', 'unpause'])
        self.assertTrue(all(x[1] == BINDING['id'] and x[2] <= 90 for x in api.calls))
        self.assertFalse(row['sourceBuildOrTestOrQuotaPassingCredit'])
    def test_actual_strict_meter_churn_restarts_then_expires_but_paused_model_completes(self):
        def exercise(paused):
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve()
                for index in range(3): (root / ('entry-' + str(index))).write_bytes(b'inert synthetic bytes')
                clock, raced = [0.0], [False]
                api = API(); original_stat = meter.os.stat
                def observed_stat(name, *args, **kwargs):
                    if type(name) is str and name.startswith('entry-') and not api.obj['State']['Paused']:
                        if not raced[0]:
                            raced[0] = True; clock[0] = 14.0; meter.os.unlink(name, dir_fd=kwargs['dir_fd'])
                        else: clock[0] = 20.0
                    return original_stat(name, *args, **kwargs)
                with patch.object(meter.os, 'stat', side_effect=observed_stat), patch.object(meter.time, 'monotonic', side_effect=lambda: clock[0]):
                    if paused: return self.run_case(api, lambda: meter.sample(str(root)), lambda: clock[0])
                    return meter.sample(str(root))
        baseline = exercise(False)
        self.assertFalse(baseline['samplingComplete']); self.assertEqual(len(baseline['attempts']), 2)
        self.assertEqual([row['incompleteCode'] for row in baseline['attempts']], ['entry-vanished-during-sample', 'sampler-deadline'])
        paused = exercise(True)
        self.assertEqual(paused['outcome'], 'complete-sample-lifecycle'); self.assertTrue(paused['sample']['samplingComplete'])
        self.assertEqual(len(paused['sample']['attempts']), 1); self.assertFalse(paused['sourceBuildOrTestOrQuotaPassingCredit'])
    def test_terminal_before_pause_has_distinct_no_sample_state(self):
        api = API(); api.obj['State']['Running'] = False; calls = []
        row = self.run_case(api, lambda: calls.append(1))
        self.assertEqual(row['outcome'], 'producer-terminal-no-sample'); self.assertFalse(row['samplingComplete']); self.assertEqual(calls, [])
        self.assertFalse(any(v[0] in ['pause', 'unpause', 'force_remove'] for v in api.calls))
    def test_terminal_race_during_pause_has_no_sampler_or_passing_credit(self):
        api = API('terminal-after-successful-pause'); calls = []
        row = self.run_case(api, lambda: calls.append(1))
        self.assertEqual(row['outcome'], 'producer-terminal-no-sample'); self.assertEqual(calls, []); self.assertFalse(row['samplingComplete'])
    def test_terminal_readback_never_erases_incomplete_pause_transport_in_either_role(self):
        for role in ['build', 'tests']:
            with self.subTest(role=role), patch.dict(BINDING, {'name': 'ct-sdk10-synthetic-original-' + role}):
                api = API('terminal-during-pause'); calls = []
                row = self.run_case(api, lambda: calls.append(1))
                self.assertEqual(row['outcome'], 'refused'); self.assertEqual(row['primaryError'], 'pause-transport-incomplete')
                self.assertTrue(row['lifecycleVerified']); self.assertEqual(calls, []); self.assertFalse(row['samplingComplete'])
    def test_failed_protected_preservation_blocks_removal_in_either_role(self):
        for role in ['build', 'tests']:
            for fault in ['preserve-false', 'preserve-raises']:
                with self.subTest(role=role, fault=fault), patch.dict(BINDING, {'name': 'ct-sdk10-synthetic-original-' + role}):
                    api = API(fault); row = self.run_case(api)
                    self.assertEqual(row['outcome'], 'producer-cleanup-unproven'); self.assertFalse(row['lifecycleVerified'])
                    self.assertIn('protected-evidence-preservation-unproven', row['lifecycleErrors'])
                    self.assertFalse(any(call[0] == 'force_remove' for call in api.calls)); self.assertTrue(api.obj['State']['Paused'])
                    self.assertFalse(row['forcedRemovalAttempted']); self.assertFalse(row['sourceBuildOrTestOrQuotaPassingCredit'])
    def test_unavailable_state_refusal_keeps_inverse_but_positive_foreign_state_forbids_it(self):
        class APIRefusal(API):
            def inspect_id(self, identity, deadline):
                if self.obj['State']['Paused']:
                    self.calls.append(('inspect', identity, deadline))
                    raise p.Refusal('producer-state-unassessed')
                return super().inspect_id(identity, deadline)
        api = APIRefusal(); row = self.run_case(api)
        self.assertTrue(any(item[0] == 'unpause' for item in api.calls)); self.assertFalse(api.obj['State']['Paused'])
        self.assertNotEqual(row['outcome'], 'complete-sample-lifecycle'); self.assertIn('producer-state-unassessed', row['errors'])
    def test_prepaused_producer_is_not_resumed_by_an_operation_that_never_paused_it(self):
        api = API(); api.obj['State']['Paused'] = True
        row = self.run_case(api)
        self.assertEqual(row['outcome'], 'refused'); self.assertIn('producer-prepaused', row['errors'])
        self.assertFalse(any(v[0] in ['pause', 'unpause', 'force_remove'] for v in api.calls))
    def test_foreign_id_name_or_labels_refuse_before_mutations(self):
        for field in ['Id', 'Name', 'Labels']:
            api = API()
            if field == 'Labels': api.obj['Config']['Labels']['run'] = '2'
            else: api.obj[field] = 'foreign'
            row = self.run_case(api)
            self.assertEqual(row['outcome'], 'refused'); self.assertFalse(any(v[0] in ['pause', 'unpause', 'force_remove'] for v in api.calls))
    def test_pause_nonzero_and_ambiguous_results_are_refused_and_source_is_resumed(self):
        for fault in ['pause-fail', 'pause-timeout', 'pause-exception']:
            api = API(fault); scans = []
            row = self.run_case(api, lambda: scans.append(1))
            self.assertEqual(row['outcome'], 'refused'); self.assertEqual(scans, [])
            self.assertTrue(row['lifecycleVerified']); self.assertFalse(api.obj['State']['Paused'])
            self.assertEqual(sum(x[0] == 'pause' for x in api.calls), 1)
    def test_strict_scan_failure_or_incomplete_result_always_resumes(self):
        for raises in [False, True]:
            api = API()
            def scan():
                if raises: raise ValueError('synthetic strict scan refusal')
                return {'samplingComplete': False, 'members': 42, 'incompleteCode': 'sampler-deadline'}
            row = self.run_case(api, scan)
            self.assertEqual(row['outcome'], 'refused'); self.assertFalse(api.obj['State']['Paused']); self.assertFalse(row['samplingComplete'])
    def test_foreign_identity_after_pause_is_never_mutated_or_given_cleanup_credit(self):
        api = API()
        def scan(): api.obj['Id'] = 'c' * 64; return {'samplingComplete': True}
        row = self.run_case(api, scan)
        self.assertEqual(row['outcome'], 'producer-cleanup-unproven'); self.assertFalse(row['lifecycleVerified'])
        self.assertFalse(any(x[0] in ['unpause', 'force_remove'] for x in api.calls))
    def test_temporarily_unavailable_inspection_still_attempts_inverse_on_captured_id(self):
        api = API('inspect-after-pause'); row = self.run_case(api)
        self.assertEqual(row['outcome'], 'refused'); self.assertTrue(row['lifecycleVerified']); self.assertFalse(api.obj['State']['Paused'])
        self.assertEqual(sum(x[0] == 'unpause' and x[1] == BINDING['id'] for x in api.calls), 1)
    def test_unpause_timeout_does_not_become_success_despite_positive_resumption(self):
        api = API('unpause-timeout'); row = self.run_case(api)
        self.assertEqual(row['outcome'], 'refused'); self.assertTrue(row['lifecycleVerified']); self.assertFalse(api.obj['State']['Paused'])
        self.assertIn('unpause-transport-incomplete', row['errors'])
    def test_unpause_failure_preserves_metadata_before_exact_owned_abort(self):
        api = API('unpause-fail'); row = self.run_case(api)
        self.assertEqual(row['outcome'], 'refused'); self.assertTrue(row['lifecycleVerified']); self.assertIsNone(api.obj)
        effects = [x[0] for x in api.calls if x[0] != 'inspect']; self.assertEqual(effects, ['pause', 'unpause', 'preserve', 'force_remove'])
        self.assertIn('producer-forced-abort-original-exit-unknown', row['errors'])
    def test_unproven_abort_or_inspection_failure_never_returns_accepted_lifecycle(self):
        for fault in ['abort-fail', 'cleanup-inspect-unavailable']:
            row = self.run_case(API(fault)); self.assertEqual(row['outcome'], 'producer-cleanup-unproven'); self.assertFalse(row['lifecycleVerified'])
    def test_zero_exit_without_owned_start_and_reap_is_not_transport_success(self):
        for field in ['ownedChildStarted', 'ownedChildReaped']:
            api = API(); real = api.pause_id
            def pause(identity, deadline):
                row = real(identity, deadline); row[field] = False; return row
            api.pause_id = pause
            row = self.run_case(api)
            self.assertEqual(row['outcome'], 'refused'); self.assertFalse(api.obj['State']['Paused']); self.assertTrue(row['lifecycleVerified'])
    def test_measurement_and_resume_errors_are_both_preserved(self):
        api = API('unpause-fail')
        row = self.run_case(api, lambda: {'samplingComplete': False, 'incompleteCode': 'sampler-deadline'})
        self.assertEqual(row['primaryError'], 'strict-sampler-incomplete')
        self.assertIn('unpause-transport-incomplete', row['lifecycleErrors'])
        self.assertIn('strict-sampler-incomplete', row['errors']); self.assertIn('unpause-transport-incomplete', row['errors'])
        self.assertEqual(row['outcome'], 'refused'); self.assertFalse(row['sourceBuildOrTestOrQuotaPassingCredit'])
    def test_original_deadline_and_resume_reserve_never_get_reset(self):
        api = API(); row = self.run_case(api, clock=lambda: 45)
        self.assertEqual(row['outcome'], 'refused'); self.assertFalse(any(x[0] == 'pause' for x in api.calls))
        clock = [0.0]; api = API()
        def scan(): clock[0] = 51; return {'samplingComplete': True}
        row = self.run_case(api, scan, lambda: clock[0]); self.assertEqual(row['outcome'], 'refused'); self.assertFalse(api.obj['State']['Paused'])
        self.assertTrue(all(x[2] <= 90 for x in api.calls))

if __name__ == '__main__': unittest.main()
