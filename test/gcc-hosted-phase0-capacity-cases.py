"""Phase-0 budgets are actual finite bounds, not later-phase qualification."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock
import urllib.error

ROOT=Path(__file__).resolve().parent.parent
MODULE=ROOT/'scripts/producer-qualification'
def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),MODULE/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
c=load('gcc-hosted-phase0-capacity.py')


def listing(size=9727804720):
    return {'active_caches_size_in_bytes':size},{'total_count':1,'actions_caches':[{'id':1,'size_in_bytes':size}]}


def resources():
    return {'cpus':4,'memoryBytes':16758403072,'availableMemoryBytes':15695896576,'freeDiskBytes':93494468608}


def service():
    return {'clock':{'remainingSeconds':21000,'capturedMonotonic':time.monotonic()},'cache':c.cache_capacity(*listing())}


class Phase0Capacity(unittest.TestCase):
    def test_observed_stock_frame_and_binary_free_ceiling_admit_only_phase0(self):
        cache=c.cache_capacity(*listing())
        self.assertEqual(cache['availableCacheBytes'],1009613520)
        self.assertEqual(cache['requiredObservedHeadroomBytes'],947912704)
        self.assertTrue(cache['headroomAdmitted']);self.assertFalse(cache['reservationGuaranteed'])
        self.assertFalse(cache['configuredRepositoryCacheCeilingAssessed'])
        self.assertEqual(cache['historicalPolicyEndpointUnavailable']['httpStatus'],402)
        value=c.admit(resources(),service(),state_bytes=0)
        self.assertEqual(value['compressedCheckpointByteLimit'],768*1024**2)
        self.assertEqual(value['checkpointPredecessorEntries'],0)
        self.assertFalse(value['laterPhaseCapacityQualified'])

    def test_concurrent_cache_growth_refuses_without_eviction_or_quota_change(self):
        cache=c.cache_capacity(*listing(9727804720+128*1024**2))
        self.assertFalse(cache['headroomAdmitted']);self.assertFalse(cache['settingsChanged'])
        with self.assertRaisesRegex(ValueError,'unpaid cache headroom'):
            c.admit(resources(),{**service(),'cache':cache},state_bytes=0)

    def test_fresh_multi_entry_listing_overrides_lagging_usage_and_refuses_partial_pages(self):
        usage={'active_caches_size_in_bytes':1000}
        rows={'total_count':2,'actions_caches':[{'id':1,'size_in_bytes':4900000000},{'id':2,'size_in_bytes':4900000000}]}
        value=c.cache_capacity(usage,rows)
        self.assertEqual(value['observedOccupiedBytes'],9800000000);self.assertFalse(value['headroomAdmitted'])
        for changed in [{**rows,'total_count':3},{'total_count':2,'actions_caches':[rows['actions_caches'][0]]*2}]:
            with self.assertRaises(ValueError):c.cache_capacity(usage,changed)

    def test_live_capture_paginates_111_entries_without_requerying_unavailable_policy(self):
        selected={'GITHUB_RUN_ID':'12','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40,'GITHUB_REF':'refs/heads/diagnostic/synthetic'}
        capture={'serviceDate':'2026-11-17T10:10:00+00:00','requestSeconds':1}
        repository={'full_name':c.base.REPOSITORY,'private':False}
        run={'id':12,'run_attempt':1,'head_sha':'a'*40,'event':'workflow_dispatch','workflow_id':c.base.WORKFLOW_ID,'head_branch':'diagnostic/synthetic'}
        jobs={'total_count':1,'jobs':[{'id':13,'name':c.base.JOB,'status':'in_progress','conclusion':None,'run_id':12,'labels':['ubuntu-26.04'],'started_at':'2026-11-17T10:00:00Z'}]}
        class API:
            def __init__(self,changed=False):self.paths=[];self.changed=changed
            def get(self,path):
                self.paths.append(path)
                if path.endswith('/checktrail'):return repository,capture
                if '/attempts/1/jobs?' in path:return jobs,capture
                if path.endswith('/runs/12'):return run,capture
                if path.endswith('/usage'):return {'active_caches_size_in_bytes':9727804720},capture
                if path.endswith('page=1'):return {'total_count':111,'actions_caches':[{'id':i,'size_in_bytes':1} for i in range(100)]},capture
                if path.endswith('page=2'):return {'total_count':112 if self.changed else 111,'actions_caches':[{'id':i,'size_in_bytes':1} for i in range(100,111)]},capture
                raise AssertionError('Unexpected endpoint '+path)
        api=API();value=c.capture_service(api,selected)
        self.assertTrue(value['cache']['headroomAdmitted']);self.assertEqual(len(api.paths),6)
        self.assertFalse(any('/storage-limit' in path for path in api.paths))
        with self.assertRaisesRegex(ValueError,'changed during pagination'):c.capture_service(API(changed=True),selected)

    def test_real_cpu_memory_disk_and_phase_specific_growth_are_required(self):
        for change in [{'cpus':2},{'availableMemoryBytes':7*c.GIB},{'freeDiskBytes':10*c.GIB}]:
            with self.subTest(change=change),self.assertRaises(ValueError):c.admit({**resources(),**change},service(),state_bytes=0)
        with self.assertRaisesRegex(ValueError,'phase-0 growth'):
            c.admit(resources(),service(),state_bytes=0,state_ceiling_bytes=64*c.GIB)

    def test_scratch_budget_holds_the_restore_tree_beside_original_tree_and_checkpoint(self):
        # The carrier's post-capture readback needs the tree's logical size plus
        # its 8 GiB floor while the original tree and checkpoint still occupy disk.
        state=1234567*4096;preparation=3*c.GIB+137
        exact=(c.STATE_CEILING_BYTES-state)+c.STATE_CEILING_BYTES+c.CHECKPOINT_BYTES+c.ENVELOPE_BYTES+8*c.GIB+preparation
        value=c.admit({**resources(),'freeDiskBytes':exact},service(),state_bytes=state,preparation_bytes=preparation)
        self.assertEqual(value['requiredScratchBytes'],exact)
        self.assertEqual(value['restoreReadbackTreeBytes'],c.STATE_CEILING_BYTES)
        with self.assertRaisesRegex(ValueError,'scratch/capture capacity'):
            c.admit({**resources(),'freeDiskBytes':exact-1},service(),state_bytes=state,preparation_bytes=preparation)

    def test_source_clock_reserves_capture_upload_download_replay_and_cleanup(self):
        value=c.admit(resources(),service(),state_bytes=0)
        self.assertEqual(value['maximumNativeSeconds'],3600)
        short=service();short['clock']['remainingSeconds']=c.FINALIZE_SECONDS
        with self.assertRaisesRegex(ValueError,'finalization reserve'):c.admit(resources(),short,state_bytes=0)
        shorter=service();shorter['clock']['remainingSeconds']=c.FINALIZE_SECONDS+600
        self.assertGreater(c.admit(resources(),shorter,state_bytes=0)['maximumNativeSeconds'],590)
        self.assertLessEqual(c.admit(resources(),shorter,state_bytes=0)['maximumNativeSeconds'],600)

    def test_envelope_is_closed_bounded_and_separately_measured(self):
        files={name:b'{"synthetic":true}\n' for name in ['receipt.json','CHECKPOINT-ROOT.json','PHASE-LEDGER.json']}
        value=c.measure_envelope(files)
        self.assertEqual(value['envelopeLogicalBytesMeasured'],sum(map(len,files.values())))
        self.assertFalse(value['serviceCacheWrapperBytesMeasured'])
        self.assertTrue(value['serviceStoredSizeMustBeVerifiedAfterSave'])
        with self.assertRaises(ValueError):c.measure_envelope({**files,'extra.json':b'{}'})
        with self.assertRaises(ValueError):c.measure_envelope({**files,'receipt.json':b'x'*(1024**2+1)})

    def test_metadata_failure_body_is_retained_without_authentication_headers(self):
        with tempfile.TemporaryDirectory(prefix='gcc-error-synthetic-') as name:
            api=c.GitHub('synthetic-token',name)
            error=urllib.error.HTTPError('https://api.github.com/repos/stsepelin/checktrail/actions/cache/usage',402,
                                         'Payment Required',{},io.BytesIO(b'{"message":"Synthetic unavailable policy"}'))
            with mock.patch.object(c.base.GitHub,'get',side_effect=error),self.assertRaises(urllib.error.HTTPError):
                api.get('/repos/stsepelin/checktrail/actions/cache/usage')
            root=Path(name)
            self.assertEqual(json.loads((root/'service-error-000.json').read_bytes())['message'],'Synthetic unavailable policy')
            receipt=json.loads((root/'service-error-000.receipt.json').read_bytes())
            self.assertEqual(receipt['httpStatus'],402);self.assertFalse(receipt['authenticationHeadersRetained'])
            self.assertNotIn('synthetic-token',''.join(path.read_text() for path in root.iterdir()))


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Phase0Capacity))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),'sourceOrCompilerExecuted':False}))
    raise SystemExit(not result.wasSuccessful())
