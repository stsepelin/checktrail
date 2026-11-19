"""Real local codecs on synthetic state; no Docker, SDK, project or service runs."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent


def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


r=load(ROOT/'scripts/producer-qualification/gcc-staged-host-retain.py')
o=load(ROOT/'scripts/producer-qualification/gcc-staged-host-observation.py')
b=load(ROOT/'test/gcc-staged-selected-body-cases.py')
c=r.host
LIMITS={**r.legacy.policy.CHECKPOINT_LIMITS,'treeBytes':16*1024**2,'memberBytes':16*1024**2,
        'archiveBytes':16*1024**2,'expandedBytes':32*1024**2,'manifestBytes':2*1024**2,'entries':10000,'seconds':60}
NAME='checktrail-gcc-staged-'+'a'*32
IDENTIFIER='b'*64


class HostBridge(unittest.TestCase):
 def fixture(self,root,index=1,*,preexisting=False,prior_failure=False):
  root=root.resolve()
  args=list(b.SelectedBody().fixture(root,index,preexisting=preexisting))
  config,ledger,old,contract,state,controls,output=args
  if prior_failure:
   row={'phase':contract['phase'],'command':contract['command'],'attempt':contract['attempt'],'sequence':contract['sequence'],
        'predecessorSha256':contract['predecessorSha256'],'nativeSeconds':19,'exitCode':3,'signal':None,
        'terminalObserved':True,'quiescenceObserved':True,'requiredStamps':contract['requiredStamps'],
        'stampIdentities':[],'checkpointSha256':None,'outcome':'failed'}
   ledger=c.planner.append_attempt(ledger,config,row)
   contract=c.family.next_contract(config,ledger,old,frozen_configuration_sha256=contract['configurationSha256'])
   args[1]=ledger;args[3]=contract;(controls/'SELECTED-PHASE-CONTRACT.json').write_bytes(c.codec.canonical(contract))
  policy={'schemaVersion':1,'profile':c.planner.PROFILE,'allowedOriginalPhase':contract['phase'],
          'historySourceIsOperatorFrozenNotToolArguments':True,'operatorExecutionTrustGranted':False,'gateAComplete':False,
          'configuration':config,'configureLedger':{**ledger,'attempts':ledger['attempts'][:1]},
          'phaseLedger':ledger,'predecessorRoot':old}
  pin=root/'synthetic-operator-history.json';pin.write_bytes(c.codec.canonical(policy))
  stack=contextlib.ExitStack()
  for host in [c,o.host]:
   history=host.body.history
   for key,value in [('POLICY_PATH',pin),('POLICY_SHA256',c.codec.sha(pin.read_bytes())),
                     ('HISTORY_SHA256',c.codec.sha(c.codec.canonical(ledger))),
                     ('CONFIGURATION_SHA256',contract['configurationSha256']),('ALLOWED_ORIGINAL_PHASE',contract['phase'])]:
    stack.enter_context(mock.patch.object(history,key,value))
   stack.enter_context(mock.patch.object(host.planner,'read_configuration',return_value=config))
  return args,stack

 def owner(self,*,running=False):
  return {'Id':IDENTIFIER,'Config':{'Labels':{'io.checktrail.gcc-staged-owner':NAME},'Entrypoint':['/usr/bin/env'],
          'Cmd':['-i',*[k+'='+v for k,v in c.body.legacy.stage.FIXED_ENVIRONMENT.items()],*o.BODY]},
          'HostConfig':{'NetworkMode':'none','Privileged':False,'Init':True,'NanoCpus':4000000000,'Memory':6*1024**3,'PidsLimit':1024},
          'State':{'Running':running,'Pid':71 if running else 0,'Status':'running' if running else 'exited',
                   'ExitCode':0,'OOMKilled':False}}

 def context(self,args):return c.before(args[4],args[2],args[1],args[5])

 def records(self,args,*,code=0,signal=None,label=None,terminal=True):
  contract=args[3];request={'state':'requested','command':contract['command'],'label':label or contract['terminalLabel'],
                          'cwd':'/build/source'}
  rows=[request]
  if terminal:rows.append({**request,'state':'terminal','terminalObserved':True,'exitCode':code,'signal':signal,'elapsedSeconds':6})
  (args[6]/'original-commands.jsonl').write_bytes(b''.join(c.codec.canonical(row) for row in rows))

 def observation(self,args,context,*,owner=None,finish=107,maximum=100,remaining=20000,cutoff=None):
  with mock.patch.object(o.time,'monotonic',side_effect=[100,finish]):
   return o.reconcile(args[4].parent,context,name=NAME,identifier=IDENTIFIER,container=owner or self.owner(),
           attach_exit_code=0,sdk_seconds=5,observer_started_monotonic=100,
           service_clock={'capturedMonotonic':99,'remainingSeconds':remaining},maximum_body_seconds=maximum,cutoff_error=cutoff)

 def ready(self,args,context,*,write_stamps=True):
  if write_stamps:
   for name in args[3]['requiredStamps']:(args[4]/'source'/name).write_bytes(b'Synthetic complete phase stamp')
  self.records(args);observation=self.observation(args,context)
  contract=args[3];stage={'state':'original-selected-phase-zero-terminal-and-material-observed-not-retained',
    'phase':contract['phase'],'originalCommand':contract['command'],'contractSha256':contract['contractSha256'],
    'configurationSha256':contract['configurationSha256'],'originalCommandAttempted':True,'originalCommandTerminalObserved':True,
    'originalCommandExitCode':0,'originalCommandSignal':None,'native':observation['originalCommandTerminal'],
    'sdkBefore':{'materialProjectionMatches':True,'timestampOnlyMaterialPaths':0},
    'sdkAfter':{'materialProjectionMatches':True,'timestampOnlyMaterialPaths':0},
    'requiredOutputs':c.family.physical_outputs(args[4],contract)}
  if contract['originalTestReportInventoryRequired']:stage.update(c.body.evidence.collect_reports(args[4],args[6]))
  if contract['packageOutputClosureAdditionallyRequired']:
   stage['packageOutputs']=c.body.evidence.package_outputs(args[4]);stage['packageOutputKinds']=stage['packageOutputs']['packageOutputKinds']
  frame=args[4].parent;sdk=frame/'sdk';(sdk/'observations').mkdir(parents=True);(args[5]/'prepared-sdk').mkdir()
  for path in [frame/'native.log',sdk/'native.log']:path.write_bytes(b'Synthetic complete stdout\xff\n')
  for path in [frame/'resource-samples.json',sdk/'resource-samples.json',sdk/'ATTEMPT.json']:
   path.write_bytes(b'{"synthetic":true}')
  (sdk/'observations/SDK.json').write_bytes(b'{"synthetic":true}')
  (args[5]/'prepared-sdk/SDK.json').write_bytes(b'{"synthetic":true}')
  self.receipts(args,observation,stage)
  return observation,stage,sdk

 def receipts(self,args,observation,stage):
  (args[4].parent/'PHASE-ATTEMPT.json').write_bytes(c.codec.canonical(observation))
  (args[6]/'SELECTED-PHASE-STAGE.json').write_bytes(c.codec.canonical(stage))

 def capture(self,args,context,observation,stage,sdk):
  return r.capture(args[4].parent,sdk,context,observation,stage,{'ownedNativeCleanupComplete':True},
                   limits=LIMITS,deadline=time.monotonic()+180)

 def failed(self,args,*,expected='retention-failed'):
  frame=args[4].parent;self.assertFalse((frame/'LOCAL-PROVISIONAL').exists())
  ledger=json.loads((frame/'LOCAL-FAILURE/FAILED-PHASE-LEDGER.json').read_bytes());row=ledger['attempts'][-1]
  self.assertEqual(row['outcome'],expected);self.assertEqual(row['exitCode'],0);self.assertEqual(row['nativeSeconds'],12)
  self.assertIsNone(row['checkpointSha256']);self.assertEqual(c.planner.validate_ledger(ledger,args[0])[3],args[3]['sequence'])
  return ledger

 def test_all_eight_original_contracts_capture_complete_state_and_only_publish_local_provisional_results(self):
  for index in range(1,9):
   with self.subTest(index=index),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name),index)
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context)
     result=self.capture(args,context,observation,stage,sdk)
    self.assertTrue(result['localCheckpointCapturedAndPhysicallyRestored']);self.assertTrue(result['localLedgerIsProvisionalUntilServiceReplay'])
    self.assertFalse(result['committedPhasePass']);self.assertFalse(result['cacheSaveCompleted']);self.assertFalse(result['cacheRestoreReplayQualified'])
    self.assertFalse(result['hostedCapacityQualified']);self.assertFalse(result['gateAComplete'])
    local=args[4].parent/'LOCAL-PROVISIONAL';self.assertEqual(json.loads((local/'PHASE-LEDGER.json').read_bytes()),result['phaseLedger'])
    self.assertEqual(result['phaseLedger']['attempts'][-1]['nativeSeconds'],12)
    copied=args[4].parent/'local-physical-readback';self.assertEqual(c.codec.snapshot(args[4],c.codec.Budget()),c.codec.snapshot(copied,c.codec.Budget()))
    evidence=result['evidence']['directory'];self.assertEqual((copied/evidence/'phase-native.log').read_bytes(),b'Synthetic complete stdout\xff\n')
    for name,original in [('phase-observations',args[6]),('sdk-observations',sdk/'observations'),('prepared-sdk',args[5]/'prepared-sdk')]:
     retained=copied/evidence/name;self.assertTrue(retained.is_dir())
     self.assertEqual(c.codec.snapshot(original,c.codec.Budget()),c.codec.snapshot(retained,c.codec.Budget()))
    self.assertFalse((args[4].parent/'PHASE-LEDGER.json').exists())

 def test_physical_modes_links_and_nanosecond_timestamps_survive_complete_independent_replay(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name));source=args[4]/'source';path=source/'synthetic-executable';path.write_bytes(b'Synthetic data')
   path.chmod(0o751);os.utime(path,ns=(1700000000123456789,1700000000123456789));(source/'synthetic-link').symlink_to('synthetic-executable')
   tree=c.codec.snapshot(args[4],c.codec.Budget());args[2]['manifestSha256']=c.codec.sha(c.codec.canonical({'schemaVersion':1,'binding':args[2]['binding'],'tree':tree}))
   # Re-pin the deliberately changed synthetic predecessor before the source policy is read.
   pin=Path(name)/'synthetic-operator-history.json';policy=json.loads(pin.read_bytes());policy['predecessorRoot']=args[2];pin.write_bytes(c.codec.canonical(policy))
   with stack,contextlib.ExitStack() as extra:
    for host in [c,o.host]:extra.enter_context(mock.patch.object(host.body.history,'POLICY_SHA256',c.codec.sha(pin.read_bytes())))
    context=self.context(args);observation,stage,sdk=self.ready(args,context);self.capture(args,context,observation,stage,sdk)
   replay=args[4].parent/'local-physical-readback/source';self.assertEqual((replay/path.name).stat().st_mode&0o7777,0o751)
   self.assertEqual((replay/path.name).stat().st_mtime_ns,1700000000123456789);self.assertEqual(os.readlink(replay/'synthetic-link'),'synthetic-executable')

 def test_same_phase_with_different_terminal_label_is_not_relabelled_or_completed(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);self.records(args,label='original-native');observation=self.observation(args,context)
   self.assertFalse(observation['originalCommandTerminalObserved']);self.assertIsNone(observation['originalCommandExitCode'])
   self.assertIn('Exact original selected',observation['terminalEvidenceError']);self.assertFalse(observation['phaseCompletionAssessed'])

 def test_missing_terminal_never_borrows_zero_attach_or_container_exit(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);self.records(args,terminal=False);observed=self.observation(args,context)
   self.assertEqual(observed['attachExitCode'],0);self.assertFalse(observed['originalCommandTerminalObserved'])
   self.assertIsNone(observed['originalCommandTerminal']);self.assertEqual(observed['combinedSdkAndPhaseObservedSeconds'],12)

 def test_nonzero_and_signal_original_terminals_survive_a_different_attach_status(self):
  for code,signal in [(3,None),(None,15)]:
   with self.subTest(code=code,signal=signal),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name))
    with stack:
     context=self.context(args);self.records(args,code=code,signal=signal);observed=self.observation(args,context)
     ledger=c.family.failed(args[0],args[1],args[2],args[3],observed,ValueError('Synthetic real original failure'),
                            frozen_configuration_sha256=args[3]['configurationSha256'])
    self.assertEqual(observed['attachExitCode'],0);self.assertTrue(observed['originalCommandTerminalObserved'])
    self.assertEqual(ledger['attempts'][-1]['exitCode'],code);self.assertEqual(ledger['attempts'][-1]['signal'],signal)
    self.assertEqual(ledger['attempts'][-1]['outcome'],'failed');self.assertEqual(ledger['attempts'][-1]['nativeSeconds'],12)

 def test_late_observer_and_whole_service_failures_keep_genuine_zero_and_charge_evidence_read_time(self):
  for finish,maximum,remaining,message in [(108,7,20000,'observer/body'),(107,100,7267,'finalization/cleanup')]:
   with self.subTest(message=message),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name))
    with stack:
     context=self.context(args);self.records(args);observed=self.observation(args,context,finish=finish,maximum=maximum,remaining=remaining)
    self.assertEqual(observed['originalCommandExitCode'],0);self.assertTrue(observed['originalCommandTerminalObserved'])
    self.assertEqual(observed['combinedSdkAndPhaseObservedSeconds'],5+finish-100)
    self.assertIsInstance(observed['cutoffOrRetentionError'],str);self.assertIn(message,observed['cutoffOrRetentionError'])

 def test_exact_clock_boundary_is_valid_and_stale_start_envelope_refuses(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);self.records(args);observed=self.observation(args,context,maximum=7,remaining=7268)
    self.assertIsNone(observed['cutoffOrRetentionError']);self.assertEqual(observed['sourceJobSecondsRemaining'],7260)
    with mock.patch.object(o.time,'monotonic',return_value=100),self.assertRaisesRegex(ValueError,'clock envelope'):
     o.reconcile(args[4].parent,context,name=NAME,identifier=IDENTIFIER,container=self.owner(),attach_exit_code=0,sdk_seconds=5,
       observer_started_monotonic=100,service_clock={'capturedMonotonic':69,'remainingSeconds':20000},maximum_body_seconds=100)

 def test_prior_failed_attempt_and_its_charge_survive_real_source_pinned_history_and_local_success(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name),prior_failure=True)
   with stack:
    context=self.context(args);observation,stage,sdk=self.ready(args,context);result=self.capture(args,context,observation,stage,sdk)
   ledger=result['phaseLedger'];self.assertEqual(ledger['attempts'][:2],args[1]['attempts']);self.assertEqual(ledger['attempts'][-2]['nativeSeconds'],19)
   self.assertEqual(ledger['attempts'][-1]['attempt'],2);self.assertEqual(result['evidence']['directory'],'__carrier_work/phase-1-native-attempt-2-carrier-evidence')

 def test_phase0_reset_stale_predecessor_rehashed_label_and_caller_trust_do_not_replace_operator_source(self):
  for kind in ['phase0-reset','predecessor','label','trust']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name),prior_failure=True)
    with stack:
     context=self.context(args);changed=copy.deepcopy(context)
     if kind=='phase0-reset':changed['phaseLedger']['attempts']=changed['phaseLedger']['attempts'][:1]
     if kind=='predecessor':changed['predecessorRoot']['archiveSha256']='e'*64
     if kind=='label':
      changed['contract']['terminalLabel']='original-native';raw={k:v for k,v in changed['contract'].items() if k!='contractSha256'}
      changed['contract']['contractSha256']=c.codec.sha(c.codec.canonical(raw))
     if kind=='trust':changed['operatorExecutionTrustGranted']=True
     with self.assertRaises(ValueError):c.verify(changed)

 def test_genuine_zero_unclosed_family_is_charged_and_inhibits_all_continuation(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);observation,stage,sdk=self.ready(args,context);observation['quiescenceObserved']=False
    observation['containerState']=self.owner(running=True)['State'];self.receipts(args,observation,stage)
    with self.assertRaisesRegex(ValueError,'must be closed'):self.capture(args,context,observation,stage,sdk)
    ledger=self.failed(args,expected=c.planner.TERMINAL_INCOMPLETE)
    self.assertFalse(ledger['attempts'][-1]['quiescenceObserved']);self.assertTrue(ledger['attempts'][-1]['terminalObserved'])
    with self.assertRaisesRegex(ValueError,'Unresolved'):c.family.next_contract(args[0],ledger,args[2],frozen_configuration_sha256=args[3]['configurationSha256'])

 def test_default_and_package_repeated_stamps_keep_actual_old_timestamps_and_need_the_exact_real_terminal(self):
  for index in [7,8]:
   with self.subTest(index=index),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name),index,preexisting=True)
    old=c.family.physical_outputs(args[4],args[3])
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context,write_stamps=False)
     result=self.capture(args,context,observation,stage,sdk)
    self.assertEqual(old,result['physicalProofs']['physicalOutputs']);self.assertTrue(args[3]['requiredStampsAlsoRequiredEarlier'])
    self.assertFalse(result['physicalProofs']['physicalOutputs']['newlyGeneratedStampsClaimed'])

 def test_missing_or_changed_physical_reports_and_packages_preserve_zero_without_advancement(self):
  for index,kind in [(2,'report-chunk'),(6,'report-inventory'),(8,'package')]:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name),index)
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context)
     if kind=='report-chunk':next((args[6]/'original-test-reports').rglob('*.gz')).unlink()
     if kind=='report-inventory':(args[6]/'test-reports.json').unlink()
     if kind=='package':(args[4]/'synthetic.deb').unlink()
     with self.assertRaises((ValueError,FileNotFoundError)):self.capture(args,context,observation,stage,sdk)
    self.failed(args)

 def test_missing_stamp_or_changed_current_sdk_postcondition_preserves_zero_without_local_success(self):
  for kind in ['stamp','sdk-before','sdk-after','sdk-timestamp']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name))
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context)
     if kind=='stamp':(args[4]/'source'/args[3]['requiredStamps'][0]).unlink()
     elif kind=='sdk-timestamp':stage['sdkAfter']['timestampOnlyMaterialPaths']=1
     else:stage['sdkBefore' if kind=='sdk-before' else 'sdkAfter']['materialProjectionMatches']=False
     self.receipts(args,observation,stage)
     with self.assertRaises((ValueError,FileNotFoundError)):self.capture(args,context,observation,stage,sdk)
    self.failed(args)

 def test_changed_physical_body_observer_or_command_receipt_cannot_be_replaced_by_caller_json(self):
  for kind in ['body','observer','command']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name))
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context)
     if kind=='body':(args[6]/'SELECTED-PHASE-STAGE.json').write_bytes(b'{}')
     if kind=='observer':(args[4].parent/'PHASE-ATTEMPT.json').write_bytes(b'{}')
     if kind=='command':self.records(args,code=3)
     with self.assertRaises(ValueError):self.capture(args,context,observation,stage,sdk)
    self.failed(args)

 def test_failed_physical_restore_never_publishes_pass_or_checkpoint_credit_and_keeps_actual_charge(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);observation,stage,sdk=self.ready(args,context)
    with mock.patch.object(r.codec,'restore',side_effect=ValueError('Synthetic independent restore incomplete')):
     with self.assertRaisesRegex(ValueError,'restore incomplete'):self.capture(args,context,observation,stage,sdk)
   self.assertTrue((args[4].parent/'checkpoint/receipt.json').exists());self.failed(args)

 def test_unconfirmed_physical_restore_and_changed_stamps_cannot_publish_a_provisional_ledger(self):
  for kind in ['unconfirmed','stamp']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name));real=r.codec.restore
    def restore(*a,**kw):
     value=real(*a,**kw)
     if kind=='unconfirmed':value['physicalTreeVerified']=False
     else:(args[4].parent/'local-physical-readback/source'/args[3]['requiredStamps'][0]).write_bytes(b'Synthetic corrupted replay')
     return value
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context)
     with mock.patch.object(r.codec,'restore',side_effect=restore),self.assertRaises(ValueError):self.capture(args,context,observation,stage,sdk)
    self.failed(args)

 def test_late_cutoff_or_wrapper_failure_keeps_the_original_zero_and_cannot_pass_after_capture(self):
  for kind in ['cutoff','wrapper','oom']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name))
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context)
     if kind=='cutoff':observation['cutoffOrRetentionError']='Synthetic actual observer cutoff'
     if kind=='wrapper':observation['attachExitCode']=1
     if kind=='oom':observation['containerState']['OOMKilled']=True
     self.receipts(args,observation,stage)
     with self.assertRaises(ValueError):self.capture(args,context,observation,stage,sdk)
    self.failed(args)

 def test_atomic_all_file_publication_failure_leaves_only_failed_charge_never_partial_completed_ledger(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name));real=r.codec.rename_no_replace
   def rename(source,target):
    if target.name=='LOCAL-PROVISIONAL':raise OSError('Synthetic final all-files publication failure')
    return real(source,target)
   with stack:
    context=self.context(args);observation,stage,sdk=self.ready(args,context)
    with mock.patch.object(r.codec,'rename_no_replace',side_effect=rename),self.assertRaisesRegex(OSError,'all-files'):
     self.capture(args,context,observation,stage,sdk)
   self.failed(args);self.assertEqual(list(args[4].parent.glob('.phase-result-*')),[])

 def test_late_retention_deadline_and_missing_complete_stdout_do_not_skip_evidence_to_fit(self):
  for kind in ['deadline','stdout']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args,stack=self.fixture(Path(name))
    with stack:
     context=self.context(args);observation,stage,sdk=self.ready(args,context)
     if kind=='stdout':(sdk/'native.log').unlink()
     with self.assertRaises((ValueError,FileNotFoundError)):
      r.capture(args[4].parent,sdk,context,observation,stage,{'ownedNativeCleanupComplete':True},limits=LIMITS,
                deadline=time.monotonic()-1 if kind=='deadline' else time.monotonic()+180)
    self.failed(args)

 def test_source_changed_after_predecessor_admission_cannot_be_confused_with_legitimate_phase_outputs(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);observation,stage,sdk=self.ready(args,context)
    changed=copy.deepcopy(args[0]);changed['variables']['CONFARGS']+=' --disable-multilib'
    with mock.patch.object(c.planner,'read_configuration',return_value=changed),self.assertRaisesRegex(ValueError,'configuration changed'):
     self.capture(args,context,observation,stage,sdk)
   self.failed(args)

 def test_constructor_inspection_enforces_fixed_generic_body_and_boolean_typed_process_state(self):
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);owner=self.owner();owner['State'].update(Status='created')
    result=o.prestart(context,owner,NAME,IDENTIFIER);self.assertTrue(result['constructorInspectedOnly']);self.assertFalse(result['nativeCapacityQualified'])
    for kind in ['body','owner','network','pid']:
     bad=copy.deepcopy(owner)
     if kind=='body':bad['Config']['Cmd'][-1]='main05'
     if kind=='owner':bad['Id']='c'*64
     if kind=='network':bad['HostConfig']['NetworkMode']='bridge'
     if kind=='pid':bad['State']['Pid']=False
     with self.subTest(kind=kind),self.assertRaises(ValueError):o.prestart(context,bad,NAME,IDENTIFIER)

 def test_no_module_exposes_native_entry_cache_promotion_or_caller_phase_or_trust_switch(self):
  for module in [c,o,r]:
   self.assertFalse(hasattr(module,'main'));self.assertFalse(hasattr(module,'dispatch'));self.assertFalse(hasattr(module,'save_cache'))
  with tempfile.TemporaryDirectory() as name:
   args,stack=self.fixture(Path(name))
   with stack:
    context=self.context(args);extra={**context,'phase':'packages','operatorTrust':True}
    with self.assertRaisesRegex(ValueError,'shape'):c.verify(extra)


if __name__=='__main__':unittest.main(verbosity=2)
