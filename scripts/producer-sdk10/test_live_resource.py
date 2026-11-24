import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common
import live_resource as live
from test_producer_pause import API as BaseAPI, BINDING
import copy
class FakeAPI(BaseAPI):
    def __init__(self, c, name):
        super().__init__()
        self.binding = copy.deepcopy(BINDING)
        self.c = c
    def inspect_id(self, identity, deadline):
        self.c.clock.advance(0.1)
        return super().inspect_id(identity, deadline)

class Clock:
    def __init__(self):
        self.now = 0.0
    def __call__(self):
        return self.now
    def advance(self, seconds):
        self.now += seconds

def meter():
    return {'members': 270000, 'regularLogicalBytes': 12 * 1024**3,
            'allocatedBytesWithHardlinkDoubleCounting': 13 * 1024**3, 'allocatedBytesUniqueInodes': 13 * 1024**3,
            'uniqueObservedInodes': 270000, 'repeatedInodePaths': 0, 'allocationAccounting': 'stable-dev-inode-once', 'elapsedSeconds': 15.0,
            'samplingComplete': True, 'incompleteCode': None, 'incompleteReason': None,
            'attempts': [{'samplingComplete': True}], 'wholeSampleRetries': 0, 'failedAttemptCountersCredited': False}

class Controller:
    def __init__(self, root, clock):
        self.root, self.clock = root, clock
        (root / 'evidence').mkdir()
        self.ctx = {'run': 123, 'attempt': 1, 'head': 'a' * 40, 'nonce': 'synthetic'}
        self.state = {'nativeDeadline': 14400, 'cleanupDeadline': 21000, 'phaseDeadline': 14400,
                      'prefix': 'fixture', 'containers': [], 'uid': 123, 'gid': 456, 'capacityAdmission': {'DockerRootDir': '/synthetic/docker'}}
        self.profile = {'limits': {'workBytes': 24 * 1024**3}}
        self.calls = []
        self.startup_seconds = 5.0
        self.attach_seconds = 21.0
        self.force_transport_failure = False
        self.write_meter = True
        self.value = meter()
        self.physical_space = {'accepted':True,'actualFreeBytes':40*1024**3,'requiredFreeBytes':36775657472}
    def inspect(self, kind, name):
        self.calls.append(('inspect', kind, name))
        self.clock.advance(0.2)
        return None
    def save(self):
        pass
    def container_args(self, name, entry, *flags):
        self.calls.append(('containerArgs', name, entry, flags))
        return ['create', '--name', name]
    def docker(self, args, seconds):
        self.calls.append(('docker', args, seconds))
        self.clock.advance(self.startup_seconds)
        return {'exitCode': 0}, None
    def own_container(self, name):
        self.clock.advance(0.2)
        return {'Id': '6' * 64, 'Name': name}
    def bind_owned_id(self, name, obj):
        self.calls.append(('bind', name, obj['Id']))
        return obj['Id']
    def validate_container(self, *args):
        pass
    def cmd(self, args, seconds, check=False):
        self.calls.append(('attach', args, seconds, self.state['phaseDeadline']))
        self.clock.advance(self.attach_seconds)
        if self.write_meter:
            (self.root / 'evidence/LIVE-METER.json').write_text(json.dumps(self.value))
        expired = self.clock() >= self.state['phaseDeadline'] or self.force_transport_failure
        return {'exitCode': -9 if expired else 0, 'reason': 'owned command deadline' if expired else None,
                'elapsedSeconds': self.attach_seconds, 'ownedChildStarted': True, 'ownedChildReaped': True}, None
    def stop_owned(self, name):
        self.calls.append(('reap', name))
        self.clock.advance(10.0)
        return True

class Resource(unittest.TestCase):
    def run_observation(self, configure=None, whole=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        clock = Clock()
        c = Controller(pathlib.Path(temporary.name), clock)
        if configure:
            configure(c)
        captured = io.StringIO()
        with patch.object(common.time, 'monotonic', clock), patch.object(live, 'ProducerAPI', FakeAPI), patch.object(live, 'observe_space', side_effect=lambda *args: c.physical_space), contextlib.redirect_stdout(captured):
            limits = live.LIMITS.copy()
            if whole is not None:
                limits['wholeSeconds'] = whole
            try:
                with patch.dict(live.LIMITS, limits):
                    result = live.observe(c, 'meter-594', c.state['nativeDeadline'], clock=clock, producer_binding=copy.deepcopy(BINDING))
                error = None
            except live.ObservationIncomplete as refusal:
                error = refusal
                result = json.loads((c.root / 'evidence/meter-594-LIVE-OPERATION.json').read_text())
        return c, result, error, captured.getvalue()
    def test_synthetic_startup_sample_attach_reap_fits_explicit_phases(self):
        c, result, error, output = self.run_observation()
        self.assertIsNone(error)
        self.assertTrue(result['complete'])
        self.assertEqual(result['attach']['exitCode'], 0)
        self.assertEqual(result['meter']['elapsedSeconds'], 15.0)
        self.assertGreater(result['elapsedSeconds'], 35)
        self.assertEqual([x['stage'] for x in result['phases']], ['startup', 'attach', 'readback', 'reap'])
        self.assertEqual(c.state['phaseDeadline'], 14400)
        self.assertEqual(c.state['nativeDeadline'], 14400)
        self.assertIn('CHECKTRAIL_SDK10_OBSERVER_STATUS=', output)
    def test25second_total_envelope_refuses_same_synthetic_phase_work(self):
        _, result, error, _ = self.run_observation(whole=25)
        self.assertIsInstance(error, live.ObservationIncomplete)
        self.assertFalse(result['complete'])
        self.assertIsNone(result['attach'])
        self.assertFalse(result['producerLifecycle']['pauseAttempted'])
        self.assertIn('scan-reserve-budget', result['producerLifecycle']['errors'])
    def test_timed_out_transport_with_complete_meter_never_credited(self):
        _, result, error, _ = self.run_observation(lambda c: setattr(c, 'force_transport_failure', True))
        self.assertIsNotNone(error)
        self.assertFalse(result['complete'])
        self.assertTrue(result['meter']['samplingComplete'])
        self.assertEqual(result['guard'], 'attach')
    def test_incomplete_meter_never_credited(self):
        def setup(c):
            c.value = {**meter(), 'samplingComplete': False, 'incompleteCode': 'entry-vanished-during-sample'}
        _, result, error, _ = self.run_observation(setup)
        self.assertIsNotNone(error)
        self.assertEqual(result['guard'], 'sampler-complete')
        self.assertEqual(result['privacySafeProjection']['samplerCode'], 'entry-vanished-during-sample')
    def test_complete_but_over_bound_is_refused(self):
        def setup(c):
            c.value = {**meter(), 'regularLogicalBytes': 24 * 1024**3 + 1}
        _, result, error, _ = self.run_observation(setup)
        self.assertIsNotNone(error)
        self.assertEqual(result['guard'], 'sample-bounds')
    def test_fresh_sample_required_and_prior_retained(self):
        def setup(c):
            (c.root / 'evidence/LIVE-METER.json').write_text(json.dumps(meter()))
            c.write_meter = False
        c, result, error, _ = self.run_observation(setup)
        self.assertIsNotNone(error)
        self.assertIsNone(result['meter'])
        self.assertTrue((c.root / 'evidence/meter-594-PRIOR-LIVE-METER.json').exists())
    def test_original_native_deadline_caps_all_phases(self):
        def setup(c):
            c.state['nativeDeadline'] = c.state['phaseDeadline'] = 10
        _, result, error, _ = self.run_observation(setup)
        self.assertIsNotNone(error)
        self.assertFalse(result['complete'])
        self.assertTrue(all(row['deadline'] <= 10 for row in result['phases']))
    def test_terminal_producer_returns_distinct_no_sample_and_reaps_only_helper(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        clock = Clock(); c = Controller(pathlib.Path(temporary.name), clock)
        class TerminalAPI(FakeAPI):
            def __init__(self, c, name):
                super().__init__(c, name); self.obj['State']['Running'] = False
        with patch.object(common.time, 'monotonic', clock), patch.object(live, 'ProducerAPI', TerminalAPI), contextlib.redirect_stdout(io.StringIO()):
            result = live.observe(c, 'meter-594', 14400, clock=clock, producer_binding=copy.deepcopy(BINDING))
        self.assertTrue(result['producerTerminal']); self.assertFalse(result['complete']); self.assertIsNone(result['meter'])
        self.assertFalse(any(row[0] == 'attach' for row in c.calls)); self.assertTrue(result['helperPositivelyAbsent'])
        self.assertEqual(result['guard'], 'producer-terminal')
    def test_real_protocol_resumes_after_sampler_failure_in_outer_observer(self):
        retained = []
        class RetainingAPI(FakeAPI):
            def __init__(self, c, name): super().__init__(c, name); retained.append(self)
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        clock = Clock(); c = Controller(pathlib.Path(temporary.name), clock)
        c.value = {**meter(), 'samplingComplete': False, 'incompleteCode': 'entry-vanished-during-sample'}
        with patch.object(common.time, 'monotonic', clock), patch.object(live, 'ProducerAPI', RetainingAPI), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(live.ObservationIncomplete):
            live.observe(c, 'meter-594', 14400, clock=clock, producer_binding=copy.deepcopy(BINDING))
        result = json.loads((c.root / 'evidence/meter-594-LIVE-OPERATION.json').read_text())
        self.assertFalse(retained[0].obj['State']['Paused']); self.assertTrue(result['producerLifecycle']['lifecycleVerified'])
        self.assertFalse(result['complete']); self.assertTrue(result['helperPositivelyAbsent'])
    def test_no_arbitrary_error_or_identifier_data_in_projection(self):
        values = {'guard': ['private/route'], 'attach': {'reason': '/private/password', 'exitCode': '0'},
                  'meter': {'incompleteReason': 'SOURCE BODY', 'incompleteCode': {'secret': True}, 'samplingComplete': 'true',
                            'members': '/private/path', 'attempts': [1, 2, 3]}, 'privateErrorMessage': 'credential arbitrary'}
        result = live.projection(values)
        encoded = json.dumps(result)
        self.assertNotIn('/private', encoded)
        self.assertNotIn('SOURCE BODY', encoded)
        self.assertNotIn('credential', encoded)
        self.assertIsNone(result['helperExit'])
        self.assertIsNone(result['samplingComplete'])
        self.assertFalse(result['sourceOriginalExitOrBuildPassCredited'])
    def test_sampler20s_and_numeric_contract_family(self):
        for key, value in [('elapsedSeconds', 20), ('elapsedSeconds', float('nan')), ('members', True), ('regularLogicalBytes', -1), ('allocatedBytesWithHardlinkDoubleCounting', '10')]:
            with self.subTest(key=key, value=value), self.assertRaises(common.Refusal):
                live.validate_meter({**meter(), key: value}, 24 * 1024**3)
    def test_contradictory_complete_or_failed_final_attempt_gets_no_credit(self):
        for patch_value in ({'incompleteCode': 'entry-vanished-during-sample'}, {'failedAttemptCountersCredited': True}, {'attempts': []}, {'attempts': [{'samplingComplete': False}]}):
            with self.subTest(value=patch_value), self.assertRaises(common.Refusal):
                live.validate_meter({**meter(), **patch_value}, 24 * 1024**3)
    def test_unstarted_or_unreaped_helper_never_gets_transport_credit(self):
        for change in ({'ownedChildStarted': False}, {'ownedChildReaped': False}, {'exitCode': False}):
            def setup(c):
                original = c.cmd
                def modified(*args, **kwargs):
                    row, path = original(*args, **kwargs)
                    return {**row, **change}, path
                c.cmd = modified
            _, result, error, _ = self.run_observation(setup)
            self.assertIsNotNone(error)
            self.assertFalse(result['complete'])
            self.assertEqual(result['guard'], 'attach')
    def test_late_durable_operation_receipt_cannot_credit_complete(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        clock = Clock()
        c = Controller(pathlib.Path(temporary.name), clock)
        real = common.freeze
        def slow(path, body):
            real(path, body)
            if pathlib.Path(path).name == 'meter-594-LIVE-OPERATION.json':
                clock.advance(100)
        with patch.object(common.time, 'monotonic', clock), patch.object(live, 'ProducerAPI', FakeAPI), patch.object(common, 'freeze', slow), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(live.ObservationIncomplete):
            live.observe(c, 'meter-594', 14400, clock=clock, producer_binding=copy.deepcopy(BINDING))
        retained = json.loads((c.root / 'evidence/meter-594-LIVE-OPERATION.json').read_text())
        self.assertFalse(retained['complete'])
        self.assertEqual(retained['attach']['exitCode'], 0)
        self.assertTrue(retained['completionBudgetExhausted'])
        self.assertFalse(retained['privacySafeProjection']['complete'])

if __name__ == '__main__':
    unittest.main()
