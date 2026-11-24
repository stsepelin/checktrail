"""Measured admission boundaries and valid near misses; no Docker/source action."""
import ast
import copy
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import capacity_admission as space
import common
import live_resource as live
import test_live_resource as fixtures

HERE = Path(__file__).resolve().parent

def profile():
    return json.loads((HERE / 'profile.json').read_bytes())

def node(dev=4, inode=10):
    return SimpleNamespace(st_dev=dev, st_ino=inode, st_mode=stat.S_IFDIR | 0o700)

class Capacity(unittest.TestCase):
    def observed(self, free, stage='paused-native-sample', devices=(4, 4), changed=None):
        stats = [node(devices[0],10),node(devices[1],20),node(devices[0],10),node(devices[1],20)]
        if changed is not None:stats[changed] = node(devices[0],999)
        with patch.object(space.os,'stat',side_effect=stats), patch.object(space.shutil,'disk_usage',return_value=SimpleNamespace(free=free)):
            return space.observe_space('/synthetic/control','/synthetic/docker',profile(),stage)

    def test_exact_composed_admission_charges_four_gib_and_preserves_full_capture(self):
        p = space.plan(profile())
        self.assertEqual(p['workingLogicalAndUniqueInodeAllocationMaximumBytes'],30064771072)
        self.assertEqual(p['minimumFreeBeforeInputs'],79725330432 + 4294967296)
        self.assertEqual(p['remainingCaptureScratchAndReserveBytes'],36775657472)
        self.assertEqual(p['postMaterializationFreeRequiredBytes'],66840428544)
        self.assertEqual(p['fullStoppedLogicalMaximumBytes'],32*space.GIB)
        self.assertEqual(p['plaintextMaximumBytes'],12*space.GIB-65536)
        self.assertEqual(p['encryptedMaximumBytes'],12*space.GIB)
        self.assertEqual(p['startupAncillaryAllowanceBytes'],16*space.GIB)

    def test_standard_sized_snapshots_are_admission_near_misses_not_peak_proof(self):
        p=space.plan(profile());self.assertGreaterEqual(93493387264,p['minimumFreeBeforeInputs'])
        observed=self.observed(84748820480,'post-materialization-before-native')
        self.assertTrue(observed['accepted']);self.assertFalse(observed['continuousQuotaOrNativePeakFitProven'])
        self.assertTrue(observed['fullWorkingAllowanceChargedAgainWithoutAssumedReclaim'])

    def test_post_materialization_exact_full_work_and_capture_boundary_and_one_less(self):
        self.assertTrue(self.observed(66840428544,'post-materialization-before-native')['accepted'])
        row=self.observed(66840428543,'post-materialization-before-native')
        self.assertFalse(row['accepted']);self.assertTrue(row['observationComplete'])
        self.assertEqual(row['actualFreeBytes'],66840428543)

    def test_both_paused_and_stopped_reserve_boundaries_refuse_one_less(self):
        for stage in ['paused-native-sample','stopped-before-capture']:
            with self.subTest(stage=stage):
                self.assertTrue(self.observed(36775657472,stage)['accepted'])
                row=self.observed(36775657471,stage);self.assertFalse(row['accepted'])
                self.assertEqual(row['requiredFreeBytes'],36775657472)

    def test_free_space_alone_cannot_admit_a_different_docker_filesystem(self):
        row=self.observed(100*space.GIB,devices=(4,5))
        self.assertFalse(row['accepted']);self.assertFalse(row['sameFilesystem']);self.assertTrue(row['observationComplete'])
        self.assertTrue(self.observed(100*space.GIB,devices=(4,4))['accepted'])

    def test_changed_capture_or_docker_root_observation_never_earns_admission(self):
        for changed in [2,3]:
            with self.subTest(changed=changed):
                row=self.observed(100*space.GIB,changed=changed)
                self.assertFalse(row['accepted']);self.assertFalse(row['observationComplete'])
                self.assertEqual(row['observationErrorType'],'Refusal')

    def test_unavailable_or_malformed_free_space_is_not_zero_or_passing(self):
        with patch.object(space.os,'stat',side_effect=PermissionError(13,'synthetic')):
            row=space.observe_space('/synthetic/a','/synthetic/b',profile(),'paused-native-sample')
        self.assertFalse(row['accepted']);self.assertIsNone(row['actualFreeBytes']);self.assertEqual(row['observationErrno'],13)
        for free in [True,-1,'999999999999']:
            with self.subTest(free=free):
                row=self.observed(free);self.assertFalse(row['accepted']);self.assertFalse(row['observationComplete'])

    def test_old_minimum_boolean_or_unreviewed_cap_refuses_before_observation(self):
        for key,value in [('minimumFreeBeforeInputs',79725330432),('workBytes',24*space.GIB),('captureBytes',13*space.GIB),('freeReserve',True)]:
            p=profile();p['limits'][key]=value
            with self.subTest(key=key),patch.object(space.os,'stat') as statcall,self.assertRaises(RuntimeError):
                space.observe_space('/a','/b',p,'paused-native-sample')
            statcall.assert_not_called()

    def test_above_old_bound_observation_fits_new_guard_without_native_credit(self):
        meter={**fixtures.meter(),'regularLogicalBytes':25706896021,'allocatedBytesWithHardlinkDoubleCounting':26520236032,'allocatedBytesUniqueInodes':26520236032}
        live.validate_meter(meter,profile()['limits']['workBytes'])
        with self.assertRaisesRegex(RuntimeError,'work byte bound'):live.validate_meter(meter,24*space.GIB)

    def test_logical_and_physical_28gib_each_exact_or_one_more(self):
        maximum=profile()['limits']['workBytes']
        exact={**fixtures.meter(),'regularLogicalBytes':maximum,'allocatedBytesWithHardlinkDoubleCounting':maximum,'allocatedBytesUniqueInodes':maximum}
        live.validate_meter(exact,maximum)
        for fields in [{'regularLogicalBytes':maximum+1},{'allocatedBytesUniqueInodes':maximum+1,'allocatedBytesWithHardlinkDoubleCounting':maximum+1}]:
            with self.subTest(fields=fields),self.assertRaisesRegex(RuntimeError,'work byte bound'):live.validate_meter({**exact,**fields},maximum)

    def test_failed_sample_reserve_still_resumes_and_reaps_without_completion_credit(self):
        case=fixtures.Resource('runTest');self.addCleanup(case.doCleanups)
        def configure(c):c.physical_space={'accepted':False,'actualFreeBytes':36775657471,'requiredFreeBytes':36775657472}
        c,result,error,output=case.run_observation(configure)
        self.assertIsNotNone(error);self.assertFalse(result['complete']);self.assertEqual(result['guard'],'reserve-bounds')
        self.assertTrue(result['producerLifecycle']['lifecycleVerified']);self.assertTrue(result['helperPositivelyAbsent'])
        self.assertFalse(result['privacySafeProjection']['physicalReserveAccepted'])
        self.assertEqual(result['privacySafeProjection']['physicalFreeBytes'],36775657471)

    def test_successful_sample_records_numeric_reserve_without_quota_credit(self):
        case=fixtures.Resource('runTest');self.addCleanup(case.doCleanups)
        c,result,error,output=case.run_observation()
        self.assertIsNone(error);self.assertTrue(result['complete']);self.assertTrue(result['physicalReserve']['accepted'])
        self.assertTrue(result['privacySafeProjection']['physicalReserveAccepted'])

    def test_actual_driver_wires_post_materialization_before_native_and_final_capture(self):
        tree=ast.parse(common.bundle_bytes(HERE/'driver.py'))
        function=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='produce')
        calls=[x for x in ast.walk(function) if isinstance(x,ast.Call)]
        observations={x.args[-1].value:(x.lineno,x.col_offset) for x in calls if isinstance(x.func,ast.Name) and x.func.id=='observe_space'}
        native=[(x.lineno,x.col_offset) for x in calls if isinstance(x.func,ast.Attribute) and x.func.attr=='native']
        self.assertEqual(set(observations),{'post-materialization-before-native','stopped-before-capture'})
        self.assertLess(observations['post-materialization-before-native'],min(native))
        self.assertGreater(observations['stopped-before-capture'],max(native))

if __name__=='__main__':unittest.main(verbosity=2)
