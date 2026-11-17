"""Genuine zero-exit command + unavailable retention cannot advance a phase."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('existing_controls',Path(__file__).with_name('gcc-staged-cases.py'))
existing=importlib.util.module_from_spec(spec);spec.loader.exec_module(existing)
p=existing.p


def failed(ledger,config,**changes):
    selected,previous,_,index,_=p.validate_ledger(ledger,config);phase=selected['phases'][index]
    return {'phase':phase['phase'],'command':phase['command'],'attempt':len(ledger['attempts']),
            'sequence':index,'predecessorSha256':previous,'nativeSeconds':1000,
            'outcome':'retention-failed','exitCode':0,'terminalObserved':True,'quiescenceObserved':True,
            'checkpointSha256':None,'retentionStage':'physical-restore',
            'retentionFailure':'Synthetic physical readback differed',**changes}


class Retention(unittest.TestCase):
    def test_genuine_zero_exit_unretained_attempt_charges_time_without_advancing(self):
        config=existing.configuration();ledger=p.new_ledger(config)
        ledger=p.append_attempt(ledger,config,failed(ledger,config))
        _,_,spent,index,checkpoint=p.validate_ledger(ledger,config)
        self.assertEqual((spent,index,checkpoint),(1000,0,None))
        self.assertEqual(ledger['attempts'][0]['exitCode'],0)
        self.assertTrue(ledger['attempts'][0]['terminalObserved'])
        self.assertEqual(p.next_phase(ledger,config,existing.job())['phase'],'configure')
        self.assertFalse(p.completion(ledger,config)['allSelectedPhasesReported'])

    def test_failed_retention_cannot_invent_checkpoint_exit_or_unknown_terminal(self):
        config=existing.configuration();ledger=p.new_ledger(config)
        for values in [{'checkpointSha256':'c'*64},{'exitCode':1},{'exitCode':None},{'exitCode':False},{'exitCode':0.0},
                       {'terminalObserved':False},{'quiescenceObserved':False},
                       {'retentionFailure':''},{'retentionFailure':'x'*2049},
                       {'retentionStage':'original-tests-disabled'}]:
            with self.subTest(values=values),self.assertRaises((ValueError,KeyError)):
                p.append_attempt(ledger,config,failed(ledger,config,**values))

    def test_completed_sibling_also_requires_a_real_integer_native_exit(self):
        config=existing.configuration();ledger=p.new_ledger(config)
        for value in [False,0.0,None]:
            row=existing.completed(ledger,config);row['exitCode']=value
            with self.subTest(value=value),self.assertRaises(ValueError):p.append_attempt(ledger,config,row)

    def test_all_closed_retention_stages_keep_the_real_native_terminal(self):
        config=existing.configuration();ledger=p.new_ledger(config)
        for stage in ['capture','archive-verification','physical-restore','transport-admission','transport','cleanup']:
            current=p.append_attempt(ledger,config,failed(ledger,config,retentionStage=stage))
            self.assertEqual(p.validate_ledger(current,config)[2:5],(1000,0,None))

    def test_retry_follows_failed_receipt_and_last_completed_checkpoint(self):
        config=existing.configuration();ledger=p.new_ledger(config)
        ledger=p.append_attempt(ledger,config,existing.completed(ledger,config))
        original_checkpoint=p.validate_ledger(ledger,config)[4]
        ledger=p.append_attempt(ledger,config,failed(ledger,config))
        self.assertEqual(p.validate_ledger(ledger,config)[3:5],(1,original_checkpoint))
        current=p.next_phase(ledger,config,existing.job(restoredCheckpointSha256=original_checkpoint))
        self.assertEqual(current['phase'],'native');self.assertEqual(current['attempt'],2)
        self.assertEqual(current['predecessorSha256'],p.sha(p.canonical(ledger['attempts'][-1])))
        ledger=p.append_attempt(ledger,config,existing.completed(ledger,config))
        self.assertEqual(p.validate_ledger(ledger,config)[2:4],(1200,2))

    def test_repeated_retention_failures_exhaust_aggregate_without_a_success(self):
        config=existing.configuration();ledger=p.new_ledger(config)
        for _ in range(2):ledger=p.append_attempt(ledger,config,failed(ledger,config,nativeSeconds=14440))
        with self.assertRaisesRegex(ValueError,'Aggregate native allowance'):
            p.append_attempt(ledger,config,failed(ledger,config,nativeSeconds=14400))
        self.assertEqual(p.completion(ledger,config)['reportedCompletedPhases'],0)

    def test_final_package_zero_exit_cannot_close_with_failed_retention(self):
        config=existing.configuration();ledger=p.new_ledger(config)
        while p.plan(config)['phases'][p.validate_ledger(ledger,config)[3]]['phase']!='packages':
            ledger=p.append_attempt(ledger,config,existing.completed(ledger,config))
        ledger=p.append_attempt(ledger,config,failed(ledger,config))
        value=p.completion(ledger,config)
        self.assertFalse(value['allSelectedPhasesReported']);self.assertFalse(value['gateAComplete'])
        self.assertFalse(value['fullCompilerSdkBootstrapClosureVerified'])


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Retention))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
                     'skips':len(result.skipped),'sourceOrCompilerExecuted':False}))
    raise SystemExit(not result.wasSuccessful())
