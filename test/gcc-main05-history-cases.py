"""Synthetic operator-history pins and actual pre-SDK runtime refusal wiring."""
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

start=load(ROOT/'scripts/producer-qualification/gcc-main05-start.py');m=start.operator_history
f=load(ROOT/'test/gcc-staged-cases.py')


class OperatorHistory(unittest.TestCase):
 def fixture(self,root,*,failure=None):
  config=f.configuration(hppa64=True);sha=m.codec.sha(m.codec.canonical(config));configure=m.family.planner.new_ledger(config)
  configure=m.family.planner.append_attempt(configure,config,f.completed(configure,config));ledger=copy.deepcopy(configure)
  if failure:
   row=f.completed(ledger,config);row.update(checkpointSha256=None,stampIdentities=[],nativeSeconds=12)
   if failure=='unclosed':row.update(outcome='terminal-incomplete',exitCode=0,terminalObserved=True,quiescenceObserved=False,incompleteStage='cleanup',incompleteReason='Synthetic still-live owned family')
   else:row.update(outcome='retention-failed',exitCode=0,terminalObserved=True,quiescenceObserved=True,retentionStage='capture',retentionFailure='Synthetic closed-family retention failure')
   ledger=m.family.planner.append_attempt(ledger,config,row)
  binding=f.binding(configurationSha256=sha);original={'binding':binding,'archiveSha256':'0'*64,'externalSdkSha256':'d'*64}
  policy={'schemaVersion':1,'profile':m.family.planner.PROFILE,'allowedOriginalPhase':'native','configuration':config,'configureLedger':configure,
   'phaseLedger':ledger,'predecessorRoot':original,'historySourceIsOperatorFrozenNotToolArguments':True,'operatorExecutionTrustGranted':False,'gateAComplete':False}
  path=root/'synthetic-operator-history.json';path.write_bytes(m.codec.canonical(policy))
  return policy,path,sha,m.codec.sha(m.codec.canonical(ledger))

 def active(self,fixture):
  policy,path,sha,history=fixture;stack=contextlib.ExitStack()
  stack.enter_context(mock.patch.object(m,'POLICY_PATH',path));stack.enter_context(mock.patch.object(m,'POLICY_SHA256',m.codec.sha(path.read_bytes())))
  stack.enter_context(mock.patch.object(m,'CONFIGURATION_SHA256',sha));stack.enter_context(mock.patch.object(m,'HISTORY_SHA256',history));return stack

 def test_pinned_full_history_and_actual_configuration_are_selected_without_execution_authority(self):
  with tempfile.TemporaryDirectory() as name:
   fixture=self.fixture(Path(name).resolve(),failure='closed')
   with self.active(fixture):
    result=m.inspect();contract=m.verify_selected_history(fixture[0]['configuration'],fixture[0]['phaseLedger'])
   self.assertEqual(result['phaseLedger'],fixture[0]['phaseLedger']);self.assertEqual(contract['attempt'],2);self.assertEqual(contract['phase'],'native')
   self.assertEqual(contract['allAttemptNativeSecondsAlreadyCharged'],m.family.planner.validate_ledger(fixture[0]['configureLedger'],fixture[0]['configuration'])[2]+12);self.assertFalse(result['operatorExecutionTrustGranted']);self.assertFalse(result['gateAComplete'])

 def test_source_replacement_symlink_and_phase0_history_reset_refuse(self):
  for kind in ['bytes','symlink','reset']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();fixture=self.fixture(root,failure='closed')
    with self.active(fixture):
     if kind=='bytes':fixture[1].write_bytes(fixture[1].read_bytes()+b' ')
     if kind=='symlink':fixture[1].rename(root/'foreign');fixture[1].symlink_to(root/'foreign')
     if kind=='reset':
      value=copy.deepcopy(fixture[0]);value['phaseLedger']=value['configureLedger'];fixture[1].write_bytes(m.codec.canonical(value))
      # Even an independently resealed policy cannot drop the separately pinned full history.
      m.POLICY_SHA256=m.codec.sha(fixture[1].read_bytes())
     with self.assertRaises(ValueError):m.inspect()

 def test_unclosed_zero_is_durably_recorded_and_refused_before_sdk_preparation_or_docker(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();fixture=self.fixture(root,failure='unclosed');output=root/'gcc-main05'
   with self.active(fixture),mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_RUN_ATTEMPT':'1'}),mock.patch.object(start.os,'getuid',return_value=0),mock.patch.object(start.prepare,'reconstruct_for_main',side_effect=RuntimeError('Synthetic SDK must not be reached')) as sdk,mock.patch.object(start.h,'docker') as docker:
    caught=None
    try:start.create_runtime(ROOT,root,output)
    except Exception as error:caught=error
    self.assertIsInstance(caught,ValueError);self.assertRegex(str(caught),'inhibits every source/native start')
    sdk.assert_not_called();docker.assert_not_called()
   record=json.loads((output/'OPERATOR-HISTORY.json').read_bytes());self.assertTrue(record['continuationInhibitedByUnresolvedFamily'])
   row=record['phaseLedger']['attempts'][-1];self.assertEqual(row['exitCode'],0);self.assertEqual(row['nativeSeconds'],12);self.assertFalse(row['quiescenceObserved'])
   self.assertFalse(json.loads((output/'NATIVE-PREPARED.json').read_bytes())['originalGccTargetInvoked'])

 def test_reconciliation_boolean_cannot_clear_an_operator_frozen_unclosed_row(self):
  with tempfile.TemporaryDirectory() as name:
   fixture=self.fixture(Path(name).resolve(),failure='unclosed')
   with self.active(fixture):
    value=copy.deepcopy(fixture[0]);value['phaseLedger']['attempts'][-1]['quiescenceReconciled']=True
    fixture[1].write_bytes(m.codec.canonical(value));m.POLICY_SHA256=m.codec.sha(fixture[1].read_bytes())
    with self.assertRaisesRegex(ValueError,'complete attempt history'):m.inspect()

 def test_restored_configuration_or_complete_history_mismatch_refuses(self):
  with tempfile.TemporaryDirectory() as name:
   fixture=self.fixture(Path(name).resolve(),failure='closed')
   with self.active(fixture):
    for config,ledger in [({},fixture[0]['phaseLedger']),(fixture[0]['configuration'],fixture[0]['configureLedger'])]:
     with self.assertRaisesRegex(ValueError,'Actual restored'):m.verify_selected_history(config,ledger)

 def test_this_source_cohort_cannot_automatically_advance_to_jit_or_package(self):
  with tempfile.TemporaryDirectory() as name:
   fixture=self.fixture(Path(name).resolve());value=copy.deepcopy(fixture[0]);ledger=value['phaseLedger']
   row=f.completed(ledger,value['configuration']);value['phaseLedger']=m.family.planner.append_attempt(ledger,value['configuration'],row)
   value['predecessorRoot']['archiveSha256']=row['checkpointSha256']
   value['predecessorRoot']['binding']=f.binding(configurationSha256=fixture[2],phase='native',sequence=1,predecessorSha256=row['predecessorSha256'])
   path=fixture[1];path.write_bytes(m.codec.canonical(value));updated=(value,path,fixture[2],m.codec.sha(m.codec.canonical(value['phaseLedger'])))
   with self.active(updated):
    with self.assertRaisesRegex(ValueError,'native only'):m.inspect()

 def test_platform_rerun_refuses_before_any_sdk_or_source_activation(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();fixture=self.fixture(root);output=root/'gcc-main05'
   with self.active(fixture),mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_RUN_ATTEMPT':'2'}),mock.patch.object(start.os,'getuid',return_value=0),mock.patch.object(start.prepare,'reconstruct_for_main',side_effect=RuntimeError('Synthetic SDK must not be reached')) as sdk,mock.patch.object(start.h,'docker') as docker:
    caught=None
    try:start.create_runtime(ROOT,root,output)
    except Exception as error:caught=error
    self.assertIsInstance(caught,ValueError);self.assertRegex(str(caught),'rerun requires independently frozen complete native attempt history')
    sdk.assert_not_called();docker.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)
