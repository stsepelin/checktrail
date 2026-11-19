import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent.parent

def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


m=load(ROOT/'scripts/producer-qualification/gcc-main05-capacity.py')
f=load(Path(__file__).with_name('gcc-staged-cases.py'))


class MainAdmission(unittest.TestCase):
    def fixture(self):
        config=f.configuration(hppa64=True);ledger=m.planner.new_ledger(config)
        ledger=m.planner.append_attempt(ledger,config,f.completed(ledger,config))
        resources={'architecture':'x86_64','cpus':4,'memoryBytes':16*m.GIB,'availableMemoryBytes':10*m.GIB,
                   'activeTreeBytes':2*m.GIB,'activeTreeLogicalBytes':2*m.GIB,'activeTreeAllocatedBytes':2*m.GIB,'freeDiskBytes':80*m.GIB,'dockerRootFilesystemFreeBytes':80*m.GIB}
        service={'clock':{'capturedMonotonic':1000,'remainingSeconds':20000},
                 'cache':{'observedOccupiedBytes':6044189091,'completeUniqueListingObserved':True,'capturedMonotonic':1000}}
        physical={'restoredPhysicalTreeVerified':True,'restoredCheckpointSha256':'0'*64,'sourceAndImagePinsVerified':True,
                  'packageInventoryUnchanged':True,'sdkMaterialPhysicallyReconstructed':True}
        return [ledger,config,resources,service,physical]

    def admit(self,args,**kw):return m.admit(*args,sdk_elapsed_seconds=kw.get('sdk',50),now_monotonic=kw.get('now',1000))

    def test_exact_original_target_full_graph_and_real_cache_units(self):
        args=self.fixture();result=self.admit(args)
        self.assertEqual(result['command'],['dpkg-buildpackage','-b','-us','-uc','--jobs=4',
            '--rules-file=/controller/gcc-staged-rules2.sh','--rules-target=stamps/05-build-stamp'])
        self.assertEqual(result['phase'],'native');self.assertEqual(result['sequence'],1)
        self.assertEqual(result['maximumNativeBodyAndAttachSeconds'],12620)
        self.assertEqual(result['requiredUnreservedCacheBytes'],4437573632)
        self.assertEqual(result['requiredObservedFreeDiskBytes'],74*m.GIB)
        self.assertEqual(m.planner.plan(args[1])['phases'][-1]['phase'],'packages')
        self.assertFalse(result['actualCheckpointSizeMeasured']);self.assertFalse(result['hostOrCompressionFitGuaranteed'])
        self.assertFalse(result['cacheCapacityReserved']);self.assertFalse(result['gateAComplete'])
        self.assertFalse(result['originalCommandWindowPromised']);self.assertTrue(result['originalCommandDurationMustBeObservedSeparately'])
        self.assertEqual(result['prestartAndCleanupReserveSeconds'],180)
        self.assertEqual(sum(result['finalizationStageBounds'].values()),7200)
        self.assertEqual(result['finalizationReserveSeconds'],7200)

    def test_exact_scratch_and_cache_boundaries(self):
        args=self.fixture();baseline=self.admit(args)
        required=baseline['requiredObservedFreeDiskBytes'];cache=baseline['requiredUnreservedCacheBytes']
        args[2]['freeDiskBytes']=args[2]['dockerRootFilesystemFreeBytes']=required
        args[3]['cache']['observedOccupiedBytes']=10*m.GIB-cache
        self.admit(args)
        for key in ['freeDiskBytes','dockerRootFilesystemFreeBytes']:
            changed=copy.deepcopy(args);changed[2][key]-=1
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'scratch'):self.admit(changed)
        args[3]['cache']['observedOccupiedBytes']+=1
        with self.assertRaisesRegex(ValueError,'cache capacity'):self.admit(args)

    def test_growth_deducts_only_the_minimum_actual_logical_and_allocated_state(self):
        for larger in ['activeTreeLogicalBytes','activeTreeAllocatedBytes']:
            args=self.fixture();args[2][larger]=4*m.GIB
            self.assertEqual(self.admit(args)['requiredObservedFreeDiskBytes'],74*m.GIB)
            args[2]['activeTreeBytes']=4*m.GIB
            with self.assertRaisesRegex(ValueError,'physical disk'):self.admit(args)
        for key in ['activeTreeLogicalBytes','activeTreeAllocatedBytes']:
            for value in [0,True,m.STATE_BYTES+1]:
                args=self.fixture();args[2][key]=value
                with self.subTest(key=key,value=value),self.assertRaisesRegex(ValueError,'physical disk'):self.admit(args)

    def test_genuine_six_hour_remaining_and_sdk_time_reduce_main_budget(self):
        args=self.fixture();args[3]['clock']['remainingSeconds']=m.FINALIZE_SECONDS+m.OBSERVER_OVERHEAD_RESERVE_SECONDS+101
        self.assertEqual(self.admit(args,now=1001)['maximumNativeBodyAndAttachSeconds'],100)
        args[3]['clock']['remainingSeconds']=m.FINALIZE_SECONDS+m.OBSERVER_OVERHEAD_RESERVE_SECONDS+1
        with self.assertRaisesRegex(ValueError,'No original main time'):self.admit(args,now=1001)
        for sdk in [-1,True,float('nan'),1201]:
            with self.subTest(sdk=sdk),self.assertRaisesRegex(ValueError,'SDK preparation'):self.admit(self.fixture(),sdk=sdk)

    def test_each_physical_predecessor_axis_and_phase_order(self):
        for key in self.fixture()[4]:
            args=self.fixture();args[4][key]=False if key!='restoredCheckpointSha256' else 'f'*64
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'physical evidence'):self.admit(args)
        args=self.fixture();args[0]['attempts']=[]
        with self.assertRaisesRegex(ValueError,'Only the immediate'):self.admit(args)
        args=self.fixture();args[0]=m.planner.append_attempt(args[0],args[1],f.completed(args[0],args[1]))
        with self.assertRaisesRegex(ValueError,'Only the immediate'):self.admit(args)

    def test_fresh_clock_and_complete_cache_observations(self):
        for section in ['clock','cache']:
            for stamp in [969,1001,float('nan'),True]:
                args=self.fixture();args[3][section]['capturedMonotonic']=stamp
                with self.subTest(section=section,stamp=stamp),self.assertRaisesRegex(ValueError,'Fresh'):self.admit(args)
        args=self.fixture();args[3]['cache']['completeUniqueListingObserved']=False
        with self.assertRaisesRegex(ValueError,'Complete fresh'):self.admit(args)
        args=self.fixture();args[3]['cache']['observedOccupiedBytes']=True
        with self.assertRaisesRegex(ValueError,'Complete fresh'):self.admit(args)

    def test_actual_memory_architecture_cpu_and_disk_admission(self):
        for key,value in [('architecture','aarch64'),('cpus',3),('memoryBytes',12*m.GIB-1),('availableMemoryBytes',8*m.GIB-1)]:
            args=self.fixture();args[2][key]=value
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'host capacity'):self.admit(args)
        args=self.fixture();args[2]['activeTreeBytes']=m.STATE_BYTES+1
        with self.assertRaisesRegex(ValueError,'physical disk'):self.admit(args)


if __name__=='__main__':unittest.main(verbosity=2)
