"""Synthetic data controls. No HTTP, image, compiler or source process runs."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('capacity', Path(__file__).resolve().parent.parent / 'scripts/producer-qualification/gcc-hosted-capacity.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def selected():
    return c.context({'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
        'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_REPOSITORY': c.REPOSITORY, 'GITHUB_REF': 'refs/heads/diagnostic/synthetic',
        'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '12', 'GITHUB_RUN_ATTEMPT': '2', 'GITHUB_JOB': c.JOB})


def data():
    repository = {'full_name': c.REPOSITORY, 'private': False}
    run = {'id': 12, 'run_attempt': 2, 'head_sha': 'a' * 40, 'event': 'workflow_dispatch',
           'workflow_id': c.WORKFLOW_ID, 'head_branch': 'diagnostic/synthetic'}
    jobs = {'total_count': 1, 'jobs': [{'id': 13, 'name': c.JOB, 'status': 'in_progress',
        'conclusion': None, 'run_id': 12, 'labels': ['ubuntu-26.04'], 'started_at': '2026-11-17T10:00:00Z'}]}
    capture = {'serviceDate': '2026-11-17T10:10:00+00:00', 'requestSeconds': 1}
    return repository, run, jobs, capture


def cache():
    return {'max_cache_size_gb': 10}, {'active_caches_size_in_bytes': 1000000000, 'active_caches_count': 1}, {
        'total_count': 1, 'actions_caches': [{'id': 1, 'size_in_bytes': 1000000000}]}


class Capacity(unittest.TestCase):
    def test_full_service_clock_charges_checkout_and_preparation(self):
        clock = c.service_clock(selected(), *data())
        self.assertEqual(clock['remainingSeconds'], 21600 - 603)
        self.assertTrue(clock['includesCheckoutPreparationCaptureUploadFinalization'])
        probe = c.service_clock(selected(), *data(), configured_job_seconds=900)
        self.assertEqual(probe['remainingSeconds'], 297)
        self.assertEqual(probe['configuredJobSeconds'], 900)

    def test_expired_future_and_wrong_source_service_observations_refuse(self):
        for mutate in [lambda r, run, jobs, cap: run.update(head_sha='b' * 40),
            lambda r, run, jobs, cap: run.update(workflow_id=99),
            lambda r, run, jobs, cap: run.update(run_attempt=1),
            lambda r, run, jobs, cap: run.update(head_branch='main'),
            lambda r, run, jobs, cap: r.update(private=True),
            lambda r, run, jobs, cap: jobs.update(total_count=2),
            lambda r, run, jobs, cap: jobs['jobs'][0].update(labels=['self-hosted']),
            lambda r, run, jobs, cap: jobs['jobs'][0].update(started_at='2026-11-17T10:20:00Z'),
            lambda r, run, jobs, cap: jobs['jobs'][0].update(started_at='2026-11-17T03:00:00Z')]:
            values = data(); mutate(*values)
            with self.assertRaises((ValueError, KeyError)): c.service_clock(selected(), *values)

    def test_wrong_host_event_ref_job_and_repository_refuse(self):
        for key, value in [('RUNNER_ENVIRONMENT','self-hosted'), ('GITHUB_EVENT_NAME','pull_request'),
            ('GITHUB_REPOSITORY','other/repository'), ('GITHUB_REF','refs/heads/main'),
            ('GITHUB_SHA','invalid'), ('GITHUB_JOB','test'), ('GITHUB_RUN_ATTEMPT','0')]:
            environment = selected(); environment[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): c.context(environment)

    def test_actual_cache_occupancy_uses_conservative_usage_and_listing(self):
        policy, usage, listing = cache()
        value = c.cache_capacity(policy, usage, listing)
        self.assertEqual(value['availableCacheBytes'], 9000000000)
        self.assertTrue(value['headroomAdmitted']); self.assertFalse(value['reservationGuaranteed'])
        listing['actions_caches'][0]['size_in_bytes'] = 3000000000
        value = c.cache_capacity(policy, usage, listing)
        self.assertEqual(value['availableCacheBytes'], 7000000000)
        self.assertFalse(value['headroomAdmitted'])
        usage['active_caches_size_in_bytes'] = 4000000000
        self.assertEqual(c.cache_capacity(policy, usage, listing)['availableCacheBytes'], 6000000000)

    def test_paid_quota_missing_partial_and_duplicate_cache_inventory_refuse(self):
        for mutate in [lambda p,u,l:p.update(max_cache_size_gb=11),
            lambda p,u,l:p.update(max_cache_size_gb=0), lambda p,u,l:l.update(total_count=2),
            lambda p,u,l:l.update(total_count=2, actions_caches=l['actions_caches'] * 2),
            lambda p,u,l:l['actions_caches'][0].update(size_in_bytes=-1)]:
            values = cache(); mutate(*values)
            with self.assertRaises(ValueError): c.cache_capacity(*values)

    def test_real_scratch_cache_memory_and_service_cutoffs_precede_native(self):
        resources = {'cpus':4, 'memoryBytes':16*c.GIB, 'availableMemoryBytes':12*c.GIB,
                     'freeDiskBytes':64*c.GIB}
        service = {'clock':c.service_clock(selected(), *data()), 'cache':c.cache_capacity(*cache())}
        admitted = c.admit(resources, service, state_bytes=2*c.GIB, state_ceiling_bytes=8*c.GIB)
        self.assertEqual(admitted['requiredScratchBytes'], 14*c.GIB + c.CHECKPOINT_BYTES)
        self.assertTrue(admitted['noNativeProducerInvokedByAdmission'])
        for change in [{'freeDiskBytes':8*c.GIB},{'cpus':2},{'availableMemoryBytes':4*c.GIB}]:
            with self.assertRaises(ValueError):c.admit({**resources,**change},service,state_bytes=0,state_ceiling_bytes=8*c.GIB)
        changed = copy.deepcopy(service); changed['cache']['headroomAdmitted'] = False
        with self.assertRaises(ValueError):c.admit(resources,changed,state_bytes=0,state_ceiling_bytes=8*c.GIB)
        changed = copy.deepcopy(service); changed['clock']['remainingSeconds'] = 3300
        with self.assertRaises(ValueError):c.admit(resources,changed,state_bytes=0,state_ceiling_bytes=8*c.GIB)

    def test_cache_pagination_is_bounded_complete_and_changes_refuse(self):
        repository, run, jobs, capture = data(); policy, usage, listing = cache()
        listing = {'total_count':101, 'actions_caches':[{'id':i,'size_in_bytes':1} for i in range(100)]}
        following = {'total_count':101, 'actions_caches':[{'id':100,'size_in_bytes':1}]}
        class API:
            def __init__(self, changed=False):self.paths=[];self.changed=changed
            def get(self,path):
                self.paths.append(path)
                if path.endswith('/checktrail'):return repository, capture
                if '/runs/12/attempts/2/jobs' in path:return jobs,capture
                if path.endswith('/runs/12'):return run,capture
                if path.endswith('/storage-limit'):return policy,capture
                if path.endswith('/usage'):return usage,capture
                if path.endswith('page=1'):return copy.deepcopy(listing),capture
                if path.endswith('page=2'):return ({**following,'total_count':102} if self.changed else following),capture
                raise AssertionError(path)
        api=API();self.assertTrue(c.capture_service(api,selected())['cache']['headroomAdmitted'])
        self.assertEqual(len(api.paths),7)
        with self.assertRaisesRegex(ValueError,'changed during pagination'):c.capture_service(API(changed=True),selected())

    def test_transport_redirect_is_refused_without_retrying_credentials(self):
        with self.assertRaisesRegex(ValueError,'redirect refused'):
            c.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://example.invalid')


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Capacity))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
                     'skips':len(result.skipped),'sourceOrCompilerExecuted':False,'httpRequested':False}))
    raise SystemExit(not result.wasSuccessful())
