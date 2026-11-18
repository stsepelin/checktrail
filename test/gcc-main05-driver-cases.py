"""Actual local capture/transport bytes with mocked SDK/native and service authority."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);return v

m=load(ROOT/'scripts/producer-qualification/gcc-hosted-main05.py')
r=load(ROOT/'test/gcc-main05-retain-cases.py')


class Driver(unittest.TestCase):
 def fixture(self,root):
  args=r.Retention().fixture(root/'gcc-main05');frame,sdk,original,ledger,config,observed,stage,cleanup=args
  original['externalSdkSha256']='d'*64
  observed['containerId']='b'*64
  output=root/'gcc-main05';(output/'NATIVE-PREPARED.json').write_text('{"controls":[]}')
  (frame/'observations/MAIN05-STAGE.json').write_text(json.dumps(stage))
  selected={'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'12','GITHUB_RUN_ATTEMPT':'1','GITHUB_REF':'refs/heads/diagnostic/synthetic'}
  clock={'capturedMonotonic':time.monotonic(),'remainingSeconds':20000,'jobId':123}
  runtime={'output':output,'nativeFrame':frame,'sdkFrame':sdk,'name':'synthetic-owned-name','containerId':'b'*64,
           'root':original,'ledger':ledger,'configuration':config,'resources':{'context':selected},'api':object(),
           'admitted':{'maximumNativeBodyAndAttachSeconds':10},'service':{'clock':clock},'sdkPreparationSecondsCharged':50}
  environment={'RUNNER_TEMP':str(root),'SUDO_UID':str(os.getuid() or 1001),'SUDO_GID':str(os.getgid() or 1001)}
  return output,runtime,observed,environment

 def active(self,root,*,observer_error=None,observer_transform=None,save_error=None):
  import contextlib
  output,runtime,observed,environment=self.fixture(root);stack=contextlib.ExitStack()
  if observer_transform:observer_transform(observed)
  if observer_error is not None:(runtime['nativeFrame']/'MAIN05-ATTEMPT.json').unlink()
  stack.enter_context(mock.patch.dict(os.environ,environment))
  stack.enter_context(mock.patch.object(m.start,'create_runtime',return_value=runtime))
  observe=stack.enter_context(mock.patch.object(m.observer,'observe',side_effect=observer_error,return_value=observed))
  native_cleanup=stack.enter_context(mock.patch.object(m.start,'cleanup_native',return_value={'ownedNativeCleanupComplete':True,'quiescenceAfterOwnedRemovalObserved':True}))
  image_cleanup=stack.enter_context(mock.patch.object(m.start.image,'cleanup_owned',return_value={'ownedImageCleanupComplete':True}))
  stack.enter_context(mock.patch.object(m.retain.planner,'read_configuration',return_value=runtime['configuration']))
  stack.enter_context(mock.patch.object(m.retain.shutil,'disk_usage',return_value=SimpleNamespace(free=100*m.service.GIB)))
  def fresh(*_):
   now=time.monotonic();return {'clock':{'capturedMonotonic':now,'remainingSeconds':20000,'jobId':123},
    'cache':{'observedOccupiedBytes':6044189091,'capturedMonotonic':now,'completeUniqueListingObserved':True}}
  stack.enter_context(mock.patch.object(m.service,'capture_service',side_effect=fresh))
  if save_error:stack.enter_context(mock.patch.object(m.service,'admit_measured_save',side_effect=save_error))
  # Root ownership is explicit synthetic metadata. Bytes, archive verification,
  # actual root-directory moving and independent physical readback stay real.
  original_stat=Path.stat;expected_paths={runtime['nativeFrame']/'TRANSPORT-EXPECTED.json',runtime['nativeFrame']/'SERVICE-RESTORE-REQUEST.json'}
  def root_owned(path,*args,**kwargs):
   value=original_stat(path,*args,**kwargs)
   if path in expected_paths:
    fields=list(value);fields[4]=0;return os.stat_result(fields)
   return value
  stack.enter_context(mock.patch.object(Path,'stat',root_owned));stack.enter_context(mock.patch.object(m.transport.os,'chown'));stack.enter_context(mock.patch.object(m.transport.os,'getuid',return_value=0))
  return stack,output,runtime,observed,observe,native_cleanup,image_cleanup

 def test_full_driver_connects_original_observation_real_whole_state_replay_and_provisional_transport(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,observed,observe,native,image=self.active(root)
   with stack:result=m.capture(root,root,output)
   observe.assert_called_once();native.assert_called_once_with(runtime['nativeFrame']);image.assert_called_once_with(runtime['sdkFrame'])
   self.assertTrue(result['localCheckpointCapturedAndPhysicallyRestored']);self.assertNotIn('checkpointPublished',result)
   self.assertFalse(result['cacheSaveCompleted']);self.assertFalse(result['cacheRestoreReplayQualified']);self.assertTrue(result['localLedgerIsProvisionalUntilServiceReplay'])
   self.assertTrue(result['originalGccTargetInvoked']);self.assertFalse(result['gateAComplete'])
   self.assertTrue((runtime['nativeFrame']/'checkpoint/tree.tar.gz').is_file());self.assertTrue((root/'gcc-main05-transport/tree.tar.gz').is_file())
   root_record=json.loads((runtime['nativeFrame']/'CHECKPOINT-ROOT.json').read_bytes())
   self.assertEqual(root_record['sourceServiceContext'],runtime['resources']['context']);self.assertTrue(root_record['externalSdkIdentityIsOriginalSoftwareBaseline'])
   self.assertFalse(root_record['wholeRootIdentityClaimed']);self.assertFalse(root_record['fullCompilerSdkBootstrapClosureVerified'])

 def test_observer_refusal_or_missing_terminal_never_invents_an_original_gcc_exit(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,_,_,native,image=self.active(root,observer_error=ValueError('Synthetic prestart/observer failure'))
   with stack:
    with self.assertRaisesRegex(ValueError,'prestart/observer'):m.capture(root,root,output)
   native.assert_called_once();image.assert_called_once();result=json.loads((output/'CARRIER.json').read_bytes())
   self.assertIsNone(result['originalGccTargetInvoked']);row=result['failedPhaseLedger']['attempts'][-1]
   self.assertIsNone(row['exitCode']);self.assertFalse(row['terminalObserved']);self.assertEqual(row['outcome'],'timeout-incomplete')
   self.assertIsNone(row['checkpointSha256']);self.assertFalse(result['localCheckpointCapturedAndPhysicallyRestored'])

 def test_genuine_nonzero_original_is_not_the_wrapper_exit_and_never_gets_a_checkpoint(self):
  def nonzero(observed):
   observed.update(originalCommandExitCode=3,attachExitCode=1);observed['originalCommandTerminal']['exitCode']=3
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,*_=self.active(root,observer_transform=nonzero)
   with stack:
    with self.assertRaisesRegex(ValueError,'genuine original main05'):m.capture(root,root,output)
   result=json.loads((output/'CARRIER.json').read_bytes());row=result['failedPhaseLedger']['attempts'][-1]
   self.assertEqual(row['exitCode'],3);self.assertEqual(row['nativeSeconds'],150);self.assertIsNone(row['checkpointSha256'])
   self.assertTrue(result['originalGccTargetInvoked']);self.assertFalse(result['localCheckpointCapturedAndPhysicallyRestored'])
   self.assertFalse((runtime['nativeFrame']/'checkpoint').exists())

 def test_missing_complete_sdk_log_preserves_zero_and_charge_but_withholds_all_transport_credit(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,*_=self.active(root);(runtime['sdkFrame']/'native.log').unlink()
   with stack:
    with self.assertRaises((ValueError,FileNotFoundError)):m.capture(root,root,output)
   result=json.loads((output/'CARRIER.json').read_bytes());row=result['failedPhaseLedger']['attempts'][-1]
   self.assertEqual(row['exitCode'],0);self.assertTrue(row['terminalObserved']);self.assertIsNone(row['checkpointSha256']);self.assertEqual(row['nativeSeconds'],150)
   self.assertFalse(result['cacheSaveCompleted']);self.assertFalse((root/'gcc-main05-transport').exists())

 def test_later_transport_refusal_keeps_actual_local_checkpoint_distinct_from_service_publication(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,*_=self.active(root,save_error=ValueError('Synthetic changed unreserved cache headroom'))
   with stack:
    with self.assertRaisesRegex(ValueError,'cache headroom'):m.capture(root,root,output)
   result=json.loads((output/'CARRIER.json').read_bytes());self.assertTrue(result['localCheckpointCapturedAndPhysicallyRestored'])
   self.assertFalse(result['cacheSaveCompleted']);self.assertFalse(result['cacheRestoreReplayQualified']);self.assertTrue(result['localLedgerIsProvisionalUntilServiceReplay'])
   row=result['failedPhaseLedger']['attempts'][-1];self.assertEqual(row['outcome'],'retention-failed');self.assertEqual(row['retentionStage'],'transport-admission')
   self.assertEqual(row['nativeSeconds'],150);self.assertIsNone(row['checkpointSha256'])

 def test_failed_or_partial_carrier_cannot_enter_any_post_capture_operation(self):
  for mode in ['pre-save','prepare-restore','verify-restore']:
   with self.subTest(mode=mode),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();output=root/'gcc-main05';(output/'native-frame').mkdir(parents=True)
    (output/'CARRIER.json').write_text(json.dumps({'state':'native05-failed-or-incomplete','localCheckpointCapturedAndPhysicallyRestored':False,'localLedgerIsProvisionalUntilServiceReplay':True}))
    with mock.patch.object(m.service,'context',return_value={}),mock.patch.object(m.h,'verify_repository'),mock.patch.object(m.transport,'prepare_restore') as restore,mock.patch.object(m.transport,'verify') as verify,mock.patch.object(m.service,'GitHub') as api:
     with self.assertRaisesRegex(ValueError,'complete provisional'):m.post_capture(mode,root,output)
     restore.assert_not_called();verify.assert_not_called();api.assert_not_called()

 def test_valid_known_zero_survives_later_observer_failure_and_charges_the_later_interval(self):
  with tempfile.TemporaryDirectory() as name:
   _,runtime,observed,_=self.fixture(Path(name).resolve())
   (runtime['nativeFrame']/'MAIN05-ATTEMPT.json').write_text(json.dumps(observed))
   result=m.observation_after_error(runtime,110,ValueError('Synthetic final daemon failure'))
   self.assertTrue(result['priorObserverReceiptValidated']);self.assertTrue(result['originalCommandTerminalObserved'])
   self.assertEqual(result['originalCommandExitCode'],0);self.assertEqual(result['combinedSdkAndMainObservedSeconds'],160)
   self.assertFalse(result['quiescenceObserved']);self.assertIsNone(result['containerState'])

 def test_partial_stale_symlinked_and_undercharged_receipts_cannot_invent_original_completion(self):
  for kind in ['partial','container','elapsed','command','signal','link','oversized']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();_,runtime,observed,_=self.fixture(root);path=runtime['nativeFrame']/'MAIN05-ATTEMPT.json'
    if kind=='container':observed['containerId']='c'*64
    if kind=='elapsed':observed['observerElapsedSeconds']=111
    if kind=='command':observed['originalCommand']=['false']
    if kind=='signal':observed['originalCommandSignal']=15
    path.write_text('{' if kind=='partial' else ' '* (256*1024+1) if kind=='oversized' else json.dumps(observed))
    if kind=='link':
     path.rename(root/'foreign.json');path.symlink_to(root/'foreign.json')
    result=m.observation_after_error(runtime,110,ValueError('Synthetic observer failure'))
    self.assertFalse(result['priorObserverReceiptValidated']);self.assertIsNone(result['originalCommandExitCode'])
    self.assertFalse(result['originalCommandTerminalObserved']);self.assertEqual(result['combinedSdkAndMainObservedSeconds'],160)
    self.assertTrue(result['priorObserverReceiptError'])

 def test_late_service_failure_keeps_genuine_zero_charge_and_no_service_or_phase_credit(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,*_=self.active(root)
   with stack:result=m.capture(root,root,output)
   frame=runtime['nativeFrame'];(frame/'controls/EXPECTED-PHASE-LEDGER.json').write_bytes(m.codec.canonical(runtime['ledger']))
   with mock.patch.object(m.service,'context',return_value=runtime['resources']['context']),mock.patch.object(m.h,'verify_repository'),mock.patch.object(m.service,'GitHub'),mock.patch.object(m.transport,'verify',side_effect=ValueError('Synthetic late service metadata failure')),mock.patch.object(m.ledger_builder.planner,'read_configuration',return_value=runtime['configuration']):
    with self.assertRaisesRegex(ValueError,'late service metadata'):m.post_capture('verify-restore',root,output)
   result=json.loads((output/'CARRIER.json').read_bytes());self.assertTrue(result['localCheckpointCapturedAndPhysicallyRestored'])
   self.assertFalse(result['cacheRestoreReplayQualified']);self.assertFalse(result['cacheSaveCompleted']);self.assertTrue(result['localLedgerIsProvisionalUntilServiceReplay'])
   self.assertEqual(result['state'],'native05-service-retention-incomplete');self.assertIn('failedPhaseLedger',result,result.get('failedLedgerEvidenceError'));row=result['failedPhaseLedger']['attempts'][-1]
   self.assertEqual(row['outcome'],'retention-failed');self.assertEqual(row['nativeSeconds'],150);self.assertEqual(row['exitCode'],0);self.assertIsNone(row['checkpointSha256'])
   self.assertEqual(m.ledger_builder.planner.validate_ledger(result['failedPhaseLedger'],runtime['configuration'])[3],1)

 def test_real_zero_with_failed_owned_cleanup_is_charged_without_claiming_quiescence_or_retry(self):
  def unclosed(observed):observed['quiescenceObserved']=False
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,_,_,native,*_=self.active(root,observer_transform=unclosed)
   native.side_effect=ValueError('Synthetic owned family cleanup remains unconfirmed')
   with stack:
    with self.assertRaisesRegex(ValueError,'cleanup remains unconfirmed'):m.capture(root,root,output)
   result=json.loads((output/'CARRIER.json').read_bytes());row=result['failedPhaseLedger']['attempts'][-1]
   self.assertEqual(row['outcome'],'terminal-incomplete');self.assertEqual(row['exitCode'],0);self.assertTrue(row['terminalObserved'])
   self.assertFalse(row['quiescenceObserved']);self.assertEqual(row['nativeSeconds'],150);self.assertIsNone(row['checkpointSha256'])
   self.assertFalse(result['localCheckpointCapturedAndPhysicallyRestored']);self.assertFalse(result['cacheRestoreReplayQualified'])
   self.assertTrue(m.ledger_builder.planner.completion(result['failedPhaseLedger'],runtime['configuration'])['continuationInhibitedByUnresolvedFamily'])

 def test_only_proven_owned_cleanup_can_close_an_observation_before_retention_failure(self):
  def unclosed(observed):observed['quiescenceObserved']=False;observed['containerState']['Running']=True;observed['containerState']['Pid']=123
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,*_=self.active(root,observer_transform=unclosed)
   with stack:
    with self.assertRaisesRegex(ValueError,'genuine original main05'):m.capture(root,root,output)
   result=json.loads((output/'CARRIER.json').read_bytes());row=result['failedPhaseLedger']['attempts'][-1]
   self.assertEqual(row['exitCode'],0);self.assertEqual(row['outcome'],'retention-failed');self.assertTrue(row['quiescenceObserved'])
   self.assertTrue(result['observed']['quiescenceWasConfirmedByOwnedCleanup']);self.assertEqual(row['nativeSeconds'],150)


if __name__=='__main__':unittest.main(verbosity=2)
