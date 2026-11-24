"""Actual local capture/transport bytes with mocked SDK/native and service authority."""
import copy
import email.utils
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
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
scope_fixture=load(ROOT/'test/gcc-native05-synthetic-fixture.py')
# Every key the real hosted-context validator reads. The checkout SHA is the one
# the synthetic SDK receipt is bound to; the other identities are distinctive.
HOSTED={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','RUNNER_ARCH':'X64',
        'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':m.service.base.REPOSITORY,
        'GITHUB_REF':'refs/heads/diagnostic/synthetic-main05-137','GITHUB_SHA':scope_fixture.HEAD,'GITHUB_RUN_ID':'918273645',
        'GITHUB_RUN_ATTEMPT':'1','GITHUB_JOB':m.service.base.JOB}
WRONG_HOSTED=[('GITHUB_ACTIONS','false'),('RUNNER_ENVIRONMENT','self-hosted'),('RUNNER_OS','macOS'),('RUNNER_ARCH','ARM64'),
              ('GITHUB_EVENT_NAME','push'),('GITHUB_REPOSITORY','synthetic-fork/checktrail'),('GITHUB_REF','refs/heads/main'),
              ('GITHUB_SHA',scope_fixture.HEAD.upper()),('GITHUB_RUN_ID','0918273645'),('GITHUB_RUN_ATTEMPT','0'),('GITHUB_JOB','gcc-staged-first-shadow'),
              ('GITHUB_JOB',None)]


def hosted(key=None,value=None):
 environment=dict(HOSTED)
 if key is not None:
  if value is None:del environment[key]
  else:environment[key]=value
 return environment


class SyntheticServiceResponse:
 def __init__(self,raw):self.raw=raw;self.status=200;self.headers={'Date':email.utils.formatdate(usegmt=True)}
 def __enter__(self):return self
 def __exit__(self,*_):return False
 def read(self,_):return self.raw


class SyntheticServiceOpener:
 """Answers each real GitHub client request with a body naming the operation."""
 def __init__(self):self.operation=None;self.urls=[]
 def open(self,request,timeout):
  self.urls.append(request.full_url)
  return SyntheticServiceResponse(json.dumps({'syntheticOperation':self.operation,'request':len(self.urls)}).encode())


class Driver(unittest.TestCase):
 def fixture(self,root):
  args=r.Retention().fixture(root/'gcc-main05');frame,sdk,original,ledger,config,observed,stage,cleanup=args
  original['externalSdkSha256']='d'*64
  observed['containerId']='b'*64
  output=root/'gcc-main05';(output/'NATIVE-PREPARED.json').write_text('{"controls":[]}')
  (frame/'observations/MAIN05-STAGE.json').write_text(json.dumps(stage))
  selected=m.service.h.capacity.context(HOSTED)
  clock={'capturedMonotonic':time.monotonic(),'remainingSeconds':20000,'jobId':123}
  runtime={'output':output,'nativeFrame':frame,'sdkFrame':sdk,'name':'synthetic-owned-name','containerId':'b'*64,
           'root':original,'ledger':ledger,'configuration':config,'resources':{'context':selected},'api':object(),
           'admitted':{'maximumNativeBodyAndAttachSeconds':10},'service':{'clock':clock},'sdkPreparationSecondsCharged':50}
  runtime['sdkScope']=scope_fixture.make_scope((frame,sdk,original))
  environment={**HOSTED,'RUNNER_TEMP':str(root),'SUDO_UID':str(os.getuid() or 1001),'SUDO_GID':str(os.getgid() or 1001),
               'CHECKTRAIL_GITHUB_JOB_TOKEN':'synthetic-job-token-137'}
  return output,runtime,observed,environment

 def active(self,root,*,observer_error=None,observer_transform=None,save_error=None):
  import contextlib
  output,runtime,observed,environment=self.fixture(root);stack=contextlib.ExitStack()
  if observer_transform:observer_transform(observed)
  if observer_error is not None:
   (runtime['nativeFrame']/'MAIN05-ATTEMPT.json').unlink()
   (runtime['nativeFrame']/'observations/original-commands.jsonl').unlink()
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
    with mock.patch.dict(os.environ,hosted()),mock.patch.object(m.h,'verify_repository'),mock.patch.object(m.transport,'prepare_restore') as restore,mock.patch.object(m.transport,'verify') as verify,mock.patch.object(m.service,'GitHub') as api:
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
    # This case has only the stale wrapper receipt. Independent original
    # terminal evidence would legitimately establish a genuine exit instead.
    (runtime['nativeFrame']/'observations/original-commands.jsonl').unlink()
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

 def test_independent_original_terminal_can_supply_genuine_zero_despite_stale_wrapper_receipt(self):
  with tempfile.TemporaryDirectory() as name:
   _,runtime,_,_=self.fixture(Path(name).resolve())
   (runtime['nativeFrame']/'MAIN05-ATTEMPT.json').write_bytes(b'{')
   result=m.observation_after_error(runtime,110,ValueError('Synthetic later observer error'))
   self.assertFalse(result['priorObserverReceiptValidated']);self.assertTrue(result['originalCommandTerminalObserved'])
   self.assertEqual(result['originalCommandExitCode'],0);self.assertEqual(result['combinedSdkAndMainObservedSeconds'],160)
   self.assertFalse(result['quiescenceObserved']);self.assertIsNone(result['containerState'])

 def test_late_service_failure_keeps_genuine_zero_charge_and_no_service_or_phase_credit(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,*_=self.active(root)
   with stack:result=m.capture(root,root,output)
   frame=runtime['nativeFrame'];(frame/'controls/EXPECTED-PHASE-LEDGER.json').write_bytes(m.codec.canonical(runtime['ledger']))
   with mock.patch.dict(os.environ,hosted()),mock.patch.object(m.h,'verify_repository') as repository,mock.patch.object(m.service,'GitHub'),mock.patch.object(m.transport,'verify',side_effect=ValueError('Synthetic late service metadata failure')):
    with self.assertRaisesRegex(ValueError,'late service metadata'):m.post_capture('verify-restore',root,output)
    repository.assert_called_once_with(root,runtime['resources']['context'])
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


 def test_every_service_operation_keeps_its_own_raw_receipts_under_the_real_hosted_context(self):
  opener=SyntheticServiceOpener();usage='/repos/'+m.service.base.REPOSITORY+'/actions/cache/usage'
  def fresh(api,selected):
   self.assertEqual(selected,m.service.h.capacity.context(HOSTED));api.get(usage);now=time.monotonic()
   return {'clock':{'capturedMonotonic':now,'remainingSeconds':20000,'jobId':123},
           'cache':{'observedOccupiedBytes':6044189091,'capturedMonotonic':now,'completeUniqueListingObserved':True}}
  def replay(frame,selected,capacity,codec,planner,api,environment):
   capacity.capture_service(api,selected);return {'syntheticReplay':'service-cache-restored-137'}
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,*_=self.active(root);frame=runtime['nativeFrame']
   with stack,mock.patch.object(m.service.base.urllib.request,'build_opener',return_value=opener):
    stack.enter_context(mock.patch.object(m.service,'capture_service',side_effect=fresh))
    # The client create_runtime retains for the later capture-time admission.
    runtime['api']=m.service.GitHub(os.environ['CHECKTRAIL_GITHUB_JOB_TOKEN'],frame)
    opener.operation='initial-admission';runtime['api'].get(usage)
    opener.operation='capture-admission';m.capture(root,root,output)
    with mock.patch.object(m.h,'verify_repository') as repository,mock.patch.object(m.transport,'verify',side_effect=replay):
     opener.operation='pre-save';admission=m.post_capture('pre-save',root,output)
     # A prepared carrier may refresh its capacity measurement before saving.
     opener.operation='pre-save-refresh';self.assertTrue(m.post_capture('pre-save',root,output)['newCacheSaveRequired'])
     opener.operation='prepare-restore';m.post_capture('prepare-restore',root,output)
     opener.operation='verify-restore';self.assertEqual(m.post_capture('verify-restore',root,output),{'syntheticReplay':'service-cache-restored-137'})
    self.assertEqual(repository.call_args_list,[mock.call(root,m.service.h.capacity.context(HOSTED))]*4)
   self.assertTrue(admission['newCacheSaveRequired']);self.assertEqual(len(opener.urls),5)
   self.assertEqual(json.loads((output/'CARRIER.json').read_bytes())['state'],'original-main05-source-cache-physically-replayed')
   self.assertFalse((frame/'FAILED-PHASE-LEDGER.json').exists())
   retained={}
   for raw in frame.rglob('service-*.json'):
    if raw.name.endswith('.receipt.json'):continue
    receipt=json.loads(raw.with_suffix('.receipt.json').read_bytes())
    self.assertEqual(receipt['rawSha256'],hashlib.sha256(raw.read_bytes()).hexdigest());self.assertEqual(receipt['url'],'https://api.github.com'+usage)
    retained[raw.relative_to(frame).as_posix()]=json.loads(raw.read_bytes())['syntheticOperation']
   self.assertEqual(retained,{'service-000.json':'initial-admission','service-001.json':'capture-admission',
                              'service-pre-save-000/service-000.json':'pre-save','service-pre-save-001/service-000.json':'pre-save-refresh',
                              'service-verify-restore-000/service-000.json':'verify-restore'})

 def test_one_wrong_hosted_context_key_is_refused_before_any_post_capture_or_history_operation(self):
  for key,value in [(None,None),*WRONG_HOSTED]:
   with self.subTest(key=key,value=value),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();output=root/'gcc-main05';(output/'native-frame').mkdir(parents=True)
    carrier=json.dumps({'state':'native05-failed-or-incomplete','localCheckpointCapturedAndPhysicallyRestored':False,'localLedgerIsProvisionalUntilServiceReplay':True})
    (output/'CARRIER.json').write_text(carrier);history=root/'gcc-main05-operator-history.json'
    argv=['gcc-hosted-main05.py','--repository',str(root),'--inputs',str(root),'--output',str(output),'--mode','preflight-history']
    with mock.patch.dict(os.environ,{**hosted(key,value),'RUNNER_TEMP':str(root)},clear=True),mock.patch.object(m.h,'verify_repository') as repository,\
         mock.patch.object(m.service,'GitHub') as api,mock.patch.object(m.start.operator_history,'inspect',return_value={'syntheticHistory':'operator-frozen-137'}) as inspect,\
         mock.patch.object(m.os,'getuid',return_value=0),mock.patch.object(sys,'argv',argv):
     if key is None:
      with self.assertRaisesRegex(ValueError,'complete provisional'):m.post_capture('pre-save',root,output)
      self.assertEqual(m.main(),{'syntheticHistory':'operator-frozen-137'})
      self.assertEqual(repository.call_args_list,[mock.call(root,m.service.h.capacity.context(HOSTED))]*2)
      inspect.assert_called_once_with();self.assertEqual(json.loads(history.read_bytes()),{'syntheticHistory':'operator-frozen-137'})
     else:
      with self.assertRaises(ValueError):m.post_capture('pre-save',root,output)
      with self.assertRaises(ValueError):m.main()
      repository.assert_not_called();inspect.assert_not_called();self.assertFalse(history.exists())
     api.assert_not_called();self.assertEqual((output/'CARRIER.json').read_text(),carrier)

 def test_incomplete_changed_or_late_checkpoint_after_transport_preparation_writes_the_failed_phase_ledger(self):
  for kind,mode,message in [('changed','pre-save','Restored GCC evidence bytes'),('missing-root','prepare-restore','No such file.*CHECKPOINT-ROOT'),
                            ('deadline','verify-restore','V2 restored scope deadline')]:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();stack,output,runtime,*_=self.active(root);frame=runtime['nativeFrame']
    with stack:m.capture(root,root,output)
    (frame/'controls/EXPECTED-PHASE-LEDGER.json').write_bytes(m.codec.canonical(runtime['ledger']))
    if kind=='changed':
     with (frame/'state'/m.retain.profile.EVIDENCE/'main-native.log').open('ab') as log:log.write(b'Synthetic late mutation 137\n')
    if kind=='missing-root':(frame/'CHECKPOINT-ROOT.json').unlink()
    with mock.patch.dict(os.environ,hosted()),mock.patch.object(m.h,'verify_repository'),mock.patch.object(m.service,'GitHub') as api,\
         mock.patch.object(m.transport,'prepare_restore') as restore,mock.patch.object(m.transport,'verify') as verify,\
         mock.patch.object(m.service.policy,'POST_CAPTURE_SECONDS',-1 if kind=='deadline' else m.service.policy.POST_CAPTURE_SECONDS):
     with self.assertRaisesRegex((ValueError,OSError),message):m.post_capture(mode,root,output)
     api.assert_not_called();restore.assert_not_called();verify.assert_not_called()
    result=json.loads((output/'CARRIER.json').read_bytes())
    self.assertEqual(result['state'],'native05-service-retention-incomplete');self.assertEqual(result['serviceFailure']['mode'],mode)
    self.assertIn('failedPhaseLedger',result,result.get('failedLedgerEvidenceError'))
    self.assertEqual(json.loads((frame/'FAILED-PHASE-LEDGER.json').read_bytes()),result['failedPhaseLedger'])
    row=result['failedPhaseLedger']['attempts'][-1]
    self.assertEqual(row['outcome'],'retention-failed');self.assertEqual(row['retentionStage'],'transport')
    self.assertEqual(row['exitCode'],0);self.assertEqual(row['nativeSeconds'],150);self.assertIsNone(row['checkpointSha256'])
    self.assertFalse(result['cacheSaveCompleted']);self.assertTrue(result['localLedgerIsProvisionalUntilServiceReplay'])

 def lose_state_after_transport_preparation(self,root,prepare=None,frame_setup=None):
  """Real capture, then the whole native state tree disappears before pre-save.

  read_configuration is not stubbed for the failure handler: the configuration
  can only come from the copy frozen in the frame or not at all.
  """
  stack,output,runtime,*_=self.active(root);frame=runtime['nativeFrame']
  if frame_setup:frame_setup(frame,runtime)
  with stack:m.capture(root,root,output)
  (frame/'controls/EXPECTED-PHASE-LEDGER.json').write_bytes(m.codec.canonical(runtime['ledger']))
  if prepare:prepare(frame,runtime)
  shutil.rmtree(frame/'state');self.assertFalse(os.path.lexists(frame/'state'))
  with mock.patch.dict(os.environ,hosted()),mock.patch.object(m.h,'verify_repository'),mock.patch.object(m.service,'GitHub') as api:
   with self.assertRaises((ValueError,OSError)):m.post_capture('pre-save',root,output)
   api.assert_not_called()
  result=json.loads((output/'CARRIER.json').read_bytes())
  self.assertEqual(result['state'],'native05-service-retention-incomplete');self.assertFalse(result['cacheSaveCompleted'])
  self.assertNotIn('failedLedgerEvidenceError',result,result.get('failedLedgerEvidenceError'))
  written=json.loads((frame/'FAILED-PHASE-LEDGER.json').read_bytes());self.assertEqual(written,result['failedPhaseLedger'])
  return result,written,runtime

 def test_whole_state_removed_after_transport_preparation_still_writes_the_failed_phase_ledger_from_the_trusted_copy(self):
  with tempfile.TemporaryDirectory() as name:
   result,written,runtime=self.lose_state_after_transport_preparation(Path(name).resolve())
   digest=m.ledger_builder.planner.plan(runtime['configuration'])['configurationSha256']
   self.assertEqual(result['retained']['binding']['configurationSha256'],digest);self.assertEqual(result['trustedConfigurationSha256'],digest)
   self.assertEqual((runtime['nativeFrame']/m.TRUSTED_CONFIGURATION).read_bytes(),m.ledger_builder.planner.canonical(runtime['configuration']))
   row=written['attempts'][-1]
   self.assertEqual(row['outcome'],'retention-failed');self.assertEqual(row['retentionStage'],'transport')
   self.assertEqual(row['exitCode'],0);self.assertEqual(row['nativeSeconds'],150);self.assertIsNone(row['checkpointSha256'])
   self.assertEqual(m.ledger_builder.planner.validate_ledger(written,runtime['configuration'])[3],1)

 def test_tampered_missing_or_aliased_trusted_copy_records_the_configuration_as_unavailable(self):
  def tamper(frame,runtime):
   changed=copy.deepcopy(runtime['configuration']);changed['variables']['CONFARGS']+=' --synthetic-tampered-137'
   (frame/m.TRUSTED_CONFIGURATION).write_bytes(m.ledger_builder.planner.canonical(changed))
  def tamper_with_ledger(frame,runtime):
   # A consistent rewrite of the expected ledger as well leaves only the
   # carrier-bound digest to refuse the substituted configuration.
   planner=m.ledger_builder.planner;changed=copy.deepcopy(runtime['configuration']);changed['variables']['CONFARGS']+=' --synthetic-tampered-137'
   ledger=planner.new_ledger(changed);ledger=planner.append_attempt(ledger,changed,r.f.completed(ledger,changed))
   (frame/'controls/EXPECTED-PHASE-LEDGER.json').write_bytes(m.codec.canonical(ledger))
   (frame/m.TRUSTED_CONFIGURATION).write_bytes(planner.canonical(changed))
  def remove(frame,runtime):(frame/m.TRUSTED_CONFIGURATION).unlink()
  def alias(frame,runtime):
   # Identical bytes behind a link are still not the frame's own frozen copy.
   moved=frame.parent/'synthetic-aliased-configuration-137.json';(frame/m.TRUSTED_CONFIGURATION).rename(moved)
   (frame/m.TRUSTED_CONFIGURATION).symlink_to(moved)
  def hardlink(frame,runtime):os.link(frame/m.TRUSTED_CONFIGURATION,frame.parent/'synthetic-second-link-137.json')
  def fifo(frame,runtime):
   # A FIFO with no writer must be refused, not waited on.
   (frame/m.TRUSTED_CONFIGURATION).unlink();os.mkfifo(frame/m.TRUSTED_CONFIGURATION)
  for kind,prepare,message in [('tampered',tamper,'differs from the carrier-bound'),('tampered-with-ledger',tamper_with_ledger,'differs from the carrier-bound'),
                             ('missing',remove,'No such file'),('symlink',alias,'symbolic links|Too many levels'),
                             ('hardlink',hardlink,'unaliased ordinary file'),('fifo',fifo,'unaliased ordinary file')]:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    result,written,runtime=self.lose_state_after_transport_preparation(Path(name).resolve(),prepare)
    digest=m.ledger_builder.planner.plan(runtime['configuration'])['configurationSha256']
    self.assertEqual(written['state'],'transport-retention-failed-configuration-unavailable')
    self.assertIs(written['configurationAvailable'],False);self.assertRegex(written['configurationError'],message)
    self.assertEqual(written['carrierBoundConfigurationSha256'],digest);self.assertEqual(written['retentionStage'],'transport')
    self.assertEqual(written['observed'],result['observed']);self.assertEqual(written['observed']['combinedSdkAndMainObservedSeconds'],150)
    self.assertIs(written['phaseLedgerRowRecorded'],False);self.assertIs(written['phaseAdvanced'],False);self.assertIs(written['gateAComplete'],False)
    # No ledger shape, configuration value or attempt row is invented.
    self.assertNotIn('attempts',written);self.assertNotIn('configurationSha256',written)
    self.assertNotIn('--synthetic-tampered-137',json.dumps(written))

 def test_a_preexisting_trusted_copy_is_never_overwritten_and_cannot_supply_the_configuration(self):
  # Identical bytes isolate the failed creation: capture never established them.
  for kind,message in [('different','Capture did not freeze'),('identical','Capture did not freeze')]:
   def preexisting(frame,runtime):
    stale=(b'{"synthetic":"preexisting-configuration-137"}\n' if kind=='different' else m.ledger_builder.planner.canonical(runtime['configuration']))
    (frame/m.TRUSTED_CONFIGURATION).write_bytes(stale);runtime['syntheticStale']=stale
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    result,written,runtime=self.lose_state_after_transport_preparation(Path(name).resolve(),frame_setup=preexisting)
    self.assertEqual((runtime['nativeFrame']/m.TRUSTED_CONFIGURATION).read_bytes(),runtime['syntheticStale'])
    self.assertIn('File exists',result['trustedConfigurationError']);self.assertNotIn('trustedConfigurationSha256',result)
    self.assertTrue(result['localCheckpointCapturedAndPhysicallyRestored'])
    self.assertEqual(written['state'],'transport-retention-failed-configuration-unavailable')
    self.assertRegex(written['configurationError'],message);self.assertNotIn('attempts',written)

 def test_an_interrupt_while_freezing_the_configuration_never_starts_the_native_body(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();stack,output,runtime,_,observe,native,image=self.active(root)
   with stack,mock.patch.object(m,'freeze_configuration',side_effect=KeyboardInterrupt('Synthetic operator interrupt 137')):
    with self.assertRaises(KeyboardInterrupt):m.capture(root,root,output)
   observe.assert_not_called();native.assert_called_once_with(runtime['nativeFrame']);image.assert_called_once_with(runtime['sdkFrame'])
   result=json.loads((output/'CARRIER.json').read_bytes())
   self.assertEqual(result['state'],'native05-failed-or-incomplete');self.assertIn('Synthetic operator interrupt 137',result['error'])
   self.assertNotIn('trustedConfigurationError',result)


if __name__=='__main__':unittest.main(verbosity=2)
