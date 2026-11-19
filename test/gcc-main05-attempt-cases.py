"""Synthetic original-terminal/SDK/whole-attempt reconciliation only."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);return v

m=load(ROOT/'scripts/producer-qualification/gcc-main05-ledger.py')
f=load(ROOT/'test/gcc-staged-cases.py')


class Attempts(unittest.TestCase):
 def fixture(self):
  configuration=f.configuration(hppa64=True);ledger=m.planner.new_ledger(configuration)
  ledger=m.planner.append_attempt(ledger,configuration,f.completed(ledger,configuration))
  previous=m.planner.validate_ledger(ledger,configuration)[1]
  terminal={'command':m.body.COMMAND,'label':'original-main05','cwd':'/build/source','state':'terminal',
            'exitCode':0,'signal':None,'terminalObserved':True,'elapsedSeconds':80}
  observed={'phase':'native','originalCommand':m.body.COMMAND,'sdkPreparationSecondsCharged':50,'observerElapsedSeconds':100,
            'combinedSdkAndMainObservedSeconds':150,'originalCommandTerminalObserved':True,'originalCommandExitCode':0,
            'originalCommandSignal':None,'originalCommandTerminal':terminal,'quiescenceObserved':True,
            'cutoffOrRetentionError':None,'attachExitCode':0,
            'containerState':{'Running':False,'Pid':0,'Status':'exited','ExitCode':0,'OOMKilled':False}}
  binding={'phase':'native','sequence':1,'predecessorSha256':previous,'configurationSha256':m.planner.plan(configuration)['configurationSha256']}
  checkpoint={'archiveBytes':123,'archiveSha256':'b'*64,'binding':binding,'checkpointValidated':True}
  restored={'physicalTreeVerified':True,'archiveSha256':'b'*64,'binding':copy.deepcopy(binding)}
  stage={'state':'original-main05-zero-terminal-and-material-observed-not-retained','physicalStamp':'stamps/05-build-stamp',
         'originalCommand':m.body.COMMAND,'originalCommandAttempted':True,'originalCommandTerminalObserved':True,'originalCommandExitCode':0,
         'sdkBefore':{'materialProjectionMatches':True,'timestampOnlyMaterialPaths':0},
         'sdkAfter':{'materialProjectionMatches':True,'timestampOnlyMaterialPaths':0}}
  return ledger,configuration,observed,checkpoint,restored,stage

 def test_completed_local_checkpoint_charges_full_sdk_observer_time_and_exact_next_phase(self):
  args=self.fixture();ledger=m.completed(*args);row=ledger['attempts'][-1]
  self.assertEqual(row['nativeSeconds'],150);self.assertNotEqual(row['nativeSeconds'],args[2]['originalCommandTerminal']['elapsedSeconds'])
  self.assertEqual(row['outcome'],'completed');self.assertEqual(row['checkpointSha256'],'b'*64);self.assertEqual(row['stampIdentities'],['stamps/05-build-stamp'])
  selected,_,_,complete,last=m.planner.validate_ledger(ledger,args[1]);self.assertEqual(complete,2);self.assertEqual(last,'b'*64)
  self.assertEqual(selected['phases'][complete]['phase'],'jit')

 def test_genuine_nonzero_signal_and_unknown_launcher_keep_distinct_facts_without_advancement(self):
  for kind in ['nonzero','signal','unknown-launcher']:
   args=self.fixture();observation=args[2]
   if kind=='nonzero':
    observation.update(originalCommandExitCode=3,attachExitCode=1);observation['originalCommandTerminal']['exitCode']=3
   if kind=='signal':
    observation.update(originalCommandExitCode=None,originalCommandSignal=15,attachExitCode=1)
    observation['originalCommandTerminal'].update(exitCode=None,signal=15)
   if kind=='unknown-launcher':observation.update(originalCommandExitCode=None,originalCommandSignal=None,originalCommandTerminalObserved=False,originalCommandTerminal=None,attachExitCode=128)
   result=m.failed(*args[:3],'Synthetic actual failure');row=result['attempts'][-1]
   self.assertIsNone(row['checkpointSha256']);self.assertEqual(row['nativeSeconds'],150)
   self.assertEqual(m.planner.validate_ledger(result,args[1])[3],1)
   if kind=='nonzero':self.assertEqual(row['exitCode'],3);self.assertIsNone(row['signal'])
   if kind=='signal':self.assertIsNone(row['exitCode']);self.assertEqual(row['signal'],15);self.assertTrue(row['terminalObserved'])
   if kind=='unknown-launcher':self.assertIsNone(row['exitCode']);self.assertIsNone(row['signal']);self.assertFalse(row['terminalObserved']);self.assertEqual(row['outcome'],'timeout-incomplete')

 def test_zero_terminal_retention_failure_preserves_zero_no_checkpoint_and_bounded_unicode_reason(self):
  args=self.fixture();result=m.failed(*args[:3],'я'*2000,retention_stage='physical-restore');row=result['attempts'][-1]
  self.assertEqual(row['exitCode'],0);self.assertTrue(row['terminalObserved']);self.assertTrue(row['quiescenceObserved'])
  self.assertEqual(row['outcome'],'retention-failed');self.assertIsNone(row['checkpointSha256']);self.assertLessEqual(len(row['retentionFailure'].encode()),2048)
  self.assertEqual(m.planner.validate_ledger(result,args[1])[3],1)

 def test_genuine_zero_unclosed_family_preserves_full_charge_and_inhibits_continuation(self):
  args=self.fixture();observation=copy.deepcopy(args[2]);observation['quiescenceObserved']=False
  result=m.failed(args[0],args[1],observation,'Synthetic cleanup still unknown',retention_stage='cleanup');row=result['attempts'][-1]
  self.assertEqual(row['exitCode'],0);self.assertTrue(row['terminalObserved']);self.assertFalse(row['quiescenceObserved'])
  self.assertEqual(row['outcome'],'terminal-incomplete');self.assertEqual(row['nativeSeconds'],150);self.assertIsNone(row['checkpointSha256'])
  self.assertEqual(m.planner.validate_ledger(result,args[1])[3],1)
  with self.assertRaisesRegex(ValueError,'Unresolved'):m.planner.next_phase(result,args[1],{})

 def test_partial_wrong_phase_checkpoint_identity_and_changed_sdk_postconditions_refuse_completion(self):
  changes=[(3,'archiveSha256','c'*64),(3,'checkpointValidated',False),(4,'physicalTreeVerified',False),
           (5,'state','original-main05-zero-terminal-not-retained'),(5,'physicalStamp','stamps/04-configure-stamp'),
           (5,'originalCommandAttempted',False),(2,'cutoffOrRetentionError','Synthetic cutoff'),(2,'attachExitCode',False)]
  for index,key,value in changes:
   args=list(self.fixture());args[index][key]=value
   with self.subTest(index=index,key=key),self.assertRaises(ValueError):m.completed(*args)
  for key,value in [('phase','jit'),('sequence',2),('configurationSha256','d'*64),('predecessorSha256','e'*64)]:
   args=list(self.fixture());args[3]['binding'][key]=value;args[4]['binding'][key]=value
   with self.subTest(key=key),self.assertRaises(ValueError):m.completed(*args)
  args=list(self.fixture());args[5]['sdkAfter']['timestampOnlyMaterialPaths']=1
  with self.assertRaisesRegex(ValueError,'SDK postconditions'):m.completed(*args)

 def test_mixed_terminal_bool_duration_and_undercharged_installer_or_observer_time_refuse(self):
  changes=[('sdkPreparationSecondsCharged',False),('observerElapsedSeconds',float('nan')),('combinedSdkAndMainObservedSeconds',100),
           ('originalCommandTerminalObserved',False),('originalCommandExitCode',False),('originalCommandSignal',15)]
  for key,value in changes:
   args=self.fixture();args[2][key]=value
   with self.subTest(key=key),self.assertRaises(ValueError):m.base_row(*args[:3])
  args=self.fixture();args[2]['originalCommandTerminal']['exitCode']=False
  with self.assertRaisesRegex(ValueError,'terminal differs'):m.base_row(*args[:3])
  args=self.fixture();args[2]['originalCommandTerminal']['elapsedSeconds']=101
  with self.assertRaisesRegex(ValueError,'terminal differs'):m.base_row(*args[:3])


if __name__=='__main__':unittest.main(verbosity=2)
