"""Synthetic finite graph/ledger and real stamp data tests; no producer executes."""
import copy
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

m=load(ROOT/'scripts/producer-qualification/gcc-staged-phase-contract.py')
f=load(ROOT/'test/gcc-staged-cases.py')


class PhaseContract(unittest.TestCase):
 def fixture(self,index):
  config=f.configuration(hppa64=True);selected=m.planner.plan(config);sha=selected['configurationSha256'];ledger=m.planner.new_ledger(config)
  for i in range(index):
   row=f.completed(ledger,config);row['checkpointSha256']=m.codec.sha(('Synthetic completed archive '+str(i)).encode())
   ledger=m.planner.append_attempt(ledger,config,row)
  prior=ledger['attempts'][-1];root={'binding':f.binding(configurationSha256=sha,phase=selected['phases'][index-1]['phase'],sequence=index-1,predecessorSha256=prior['predecessorSha256']),
   'archiveSha256':prior['checkpointSha256'],'externalSdkSha256':'d'*64}
  contract=m.next_contract(config,ledger,root,frozen_configuration_sha256=sha)
  terminal={'command':contract['command'],'label':contract['terminalLabel'],'cwd':'/build/source','state':'terminal','terminalObserved':True,'exitCode':0,'signal':None,'elapsedSeconds':6}
  observation={'phase':contract['phase'],'originalCommand':contract['command'],'originalCommandTerminalObserved':True,
   'originalCommandExitCode':0,'originalCommandSignal':None,'originalCommandTerminal':terminal,'quiescenceObserved':True,
   'sdkPreparationSecondsCharged':5,'observerElapsedSeconds':7,'combinedSdkAndPhaseObservedSeconds':12,
   'containerState':{'Running':False,'Pid':0,'Status':'exited','ExitCode':0,'OOMKilled':False},'attachExitCode':0,
   'cutoffOrRetentionError':None,'sdkBeforeMaterialProjectionMatches':True,'sdkAfterMaterialProjectionMatches':True,
   'originalTestReportEvidence':{'reports':1,'logicalBytes':128,'inventorySha256':'e'*64,'allOriginalTestsPassRequired':False},
   'packageOutputKinds':['deb','changes','buildinfo']}
  binding={**root['binding'],'phase':contract['phase'],'sequence':index,'predecessorSha256':contract['predecessorSha256']}
  checkpoint={'binding':binding,'archiveSha256':m.codec.sha(('Synthetic next archive '+str(index)).encode()),'checkpointValidated':True}
  restore={'binding':binding,'archiveSha256':checkpoint['archiveSha256'],'physicalTreeVerified':True}
  return config,ledger,root,sha,contract,observation,checkpoint,restore

 def finish(self,args,state):
  config,ledger,root,sha,contract,observation,checkpoint,restore=args
  outputs=m.physical_outputs(state,contract)
  return m.completed(config,ledger,root,contract,observation,checkpoint,restore,outputs,frozen_configuration_sha256=sha)

 def state(self,root,contract):
  state=root.resolve()/'state';(state/'source/stamps').mkdir(parents=True)
  for name in contract['requiredStamps']:(state/'source'/name).write_bytes(b'Synthetic already-existing valid original stamp')
  return state

 def test_all_eight_remaining_exact_original_commands_derive_from_ledger_without_phase_argument(self):
  phases=[]
  for index in range(1,9):
   with self.subTest(index=index):
    config,ledger,root,sha,contract,*_=self.fixture(index);phases.append(contract['phase'])
    self.assertEqual(contract['command'],m.planner.plan(config)['phases'][index]['command'])
    self.assertEqual(contract['sequence'],index);self.assertEqual(contract['remainingSelectedPhasesIncludingThis'],9-index)
    self.assertFalse(contract['operatorExecutionTrustGranted']);self.assertFalse(contract['phaseResourceCapacityQualified'])
    self.assertFalse(contract['nativeEvidenceOriginAssessed']);self.assertFalse(contract['gateAComplete'])
  self.assertEqual(phases,list(m.PHASES))
  self.assertEqual(self.fixture(7)[4]['command'],[*m.planner.DPKG,'--rules-target=build'])
  self.assertEqual(self.fixture(8)[4]['command'],[*m.planner.DPKG,'-nc'])
  self.assertEqual(self.fixture(3)[4]['command'][-1],'--rules-target=stamps/05-build-nvptx-stamp,stamps/06-install-nvptx-stamp')

 def test_default_and_package_repeated_required_stamps_are_valid_not_fabricated_freshness(self):
  default=self.fixture(7)[4];packages=self.fixture(8)[4]
  self.assertEqual(default['additionalRequiredStamps'],['stamps/05-build-doxygen-stamp','stamps/05-build-gnatdoc-stamp','stamps/05-build-html-stamp'])
  self.assertEqual(len(default['requiredStampsAlsoRequiredEarlier']),6)
  self.assertEqual(packages['additionalRequiredStamps'],['stamps/07-install-jit-stamp','stamps/07-install-stamp'])
  self.assertEqual(len(packages['requiredStampsAlsoRequiredEarlier']),3)
  for index in [7,8]:
   with tempfile.TemporaryDirectory() as name:
    args=self.fixture(index);state=self.state(Path(name),args[4]);result=self.finish(args,state)
    self.assertTrue(result['localLedgerIsProvisionalUntilServiceReplay']);self.assertFalse(result['packageOutputClosureVerified'])
    self.assertFalse(result['nativeEvidenceOriginAssessed']);self.assertFalse(result['gateAComplete'])
    if index==8:self.assertTrue(m.planner.completion(result['phaseLedger'],args[0])['allSelectedPhasesReported'])

 def test_each_phase_observes_complete_physical_stamps_and_appends_only_immediate_provisional_success(self):
  for index in range(1,9):
   with self.subTest(index=index),tempfile.TemporaryDirectory() as name:
    args=self.fixture(index);state=self.state(Path(name),args[4]);result=self.finish(args,state)
    self.assertEqual(m.planner.validate_ledger(result['phaseLedger'],args[0])[3],index+1)
    row=result['phaseLedger']['attempts'][-1];self.assertEqual(row['command'],args[4]['command']);self.assertEqual(row['nativeSeconds'],12)
    self.assertEqual(row['checkpointSha256'],args[6]['archiveSha256'])
    self.assertFalse(m.physical_outputs(state,args[4])['newlyGeneratedStampsClaimed'])

 def test_caller_command_phase_stamp_label_or_recomputed_hash_cannot_select_another_action(self):
  for key,value in [('phase','packages'),('command',['true']),('requiredStamps',[]),('terminalLabel','original-packages'),('attempt',99)]:
   args=self.fixture(2);contract=copy.deepcopy(args[4]);contract[key]=value
   nohash={k:v for k,v in contract.items() if k!='contractSha256'};contract['contractSha256']=m.codec.sha(m.codec.canonical(nohash))
   with self.subTest(key=key),self.assertRaisesRegex(ValueError,'caller-selected'):
    m.verify_contract(contract,args[0],args[1],args[2],args[3])

 def test_changed_configuration_predecessor_phase_sequence_hash_and_software_sdk_refuse(self):
  for kind in ['configuration','archive','phase','sequence','chain','sdk']:
   config,ledger,root,sha,*_=self.fixture(4)
   if kind=='configuration':config['passedVariableValues'][next(iter(config['passedVariableValues']))]+=' synthetic changed'
   if kind=='archive':root['archiveSha256']='f'*64
   if kind=='phase':root['binding']['phase']='jit'
   if kind=='sequence':root['binding']['sequence']=1
   if kind=='chain':root['binding']['predecessorSha256']='f'*64
   if kind=='sdk':root['externalSdkSha256']='missing'
   with self.subTest(kind=kind),self.assertRaises(ValueError):m.next_contract(config,ledger,root,frozen_configuration_sha256=sha)

 def test_genuine_nonzero_signal_unknown_and_later_zero_failure_keep_each_phase_and_all_charges(self):
  for index in range(1,9):
   for kind in ['nonzero','signal','unknown','retention']:
    with self.subTest(index=index,kind=kind):
     config,ledger,root,sha,contract,observation,*_=self.fixture(index)
     if kind=='nonzero':observation['originalCommandExitCode']=3;observation['originalCommandTerminal']['exitCode']=3;observation['attachExitCode']=1
     if kind=='signal':
      observation.update(originalCommandExitCode=None,originalCommandSignal=15);observation['originalCommandTerminal'].update(exitCode=None,signal=15)
     if kind=='unknown':observation.update(originalCommandTerminalObserved=False,originalCommandExitCode=None,originalCommandSignal=None,originalCommandTerminal=None,attachExitCode=137)
     after=m.failed(config,ledger,root,contract,observation,ValueError('Synthetic phase retention failure'),frozen_configuration_sha256=sha)
     row=after['attempts'][-1];self.assertEqual(row['nativeSeconds'],12);self.assertEqual(row['phase'],contract['phase']);self.assertIsNone(row['checkpointSha256'])
     self.assertEqual(m.planner.validate_ledger(after,config)[3],index)
     self.assertEqual(row['outcome'],'retention-failed' if kind=='retention' else 'timeout-incomplete' if kind=='unknown' else 'failed')
     if kind=='signal':self.assertEqual(row['signal'],15);self.assertIsNone(row['exitCode'])
     if kind=='nonzero':self.assertEqual(row['exitCode'],3)

 def test_partial_or_wrong_output_archive_restore_sdk_or_wrapper_cannot_complete(self):
  for kind in ['stamp','archive','restore','sdk','wrapper','container','terminal','charge']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args=list(self.fixture(5));state=self.state(Path(name),args[4])
    if kind=='stamp':(state/'source'/args[4]['requiredStamps'][0]).unlink()
    if kind=='archive':args[6]['binding']={**args[6]['binding'],'phase':'gcn'}
    if kind=='restore':args[7]['physicalTreeVerified']=False
    if kind=='sdk':args[5]['sdkAfterMaterialProjectionMatches']=False
    if kind=='wrapper':args[5]['attachExitCode']=1
    if kind=='container':args[5]['containerState']['Pid']=123
    if kind=='terminal':args[5]['originalCommandTerminal']['label']='original-gcn'
    if kind=='charge':args[5]['combinedSdkAndPhaseObservedSeconds']=7
    with self.assertRaises((ValueError,FileNotFoundError)):self.finish(args,state)

 def test_physical_stamp_links_and_path_escape_are_never_read_as_required_outputs(self):
  for kind in ['link','directory','escape','absolute','near-name']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name);contract=self.fixture(2)[4];state=self.state(root,contract);path=state/'source'/contract['requiredStamps'][0]
    if kind=='link':path.unlink();path.symlink_to(root/'unknown')
    if kind=='directory':path.unlink();path.mkdir()
    if kind=='escape':contract['requiredStamps']=['../outside']
    if kind=='absolute':contract['requiredStamps']=['/etc/passwd']
    if kind=='near-name':contract['requiredStamps']=['stamps/05-build-jit-stamp-extra']
    with self.assertRaises(ValueError):m.physical_outputs(state,contract)

 def test_failed_attempt_changes_chain_and_attempt_number_but_keeps_original_immediate_source(self):
  config,ledger,root,sha,contract,observation,*_=self.fixture(6)
  after=m.failed(config,ledger,root,contract,observation,ValueError('Synthetic retained-zero failure'),frozen_configuration_sha256=sha)
  next=m.next_contract(config,after,root,frozen_configuration_sha256=sha)
  self.assertEqual(next['phase'],'check');self.assertEqual(next['restoreArchiveSha256'],contract['restoreArchiveSha256'])
  self.assertEqual(next['attempt'],contract['attempt']+1);self.assertNotEqual(next['predecessorSha256'],contract['predecessorSha256'])
  with self.assertRaisesRegex(ValueError,'stale'):m.verify_contract(contract,config,after,root,sha)

 def test_original_report_evidence_and_exact_binary_output_families_remain_required(self):
  for index,kind in [(2,'empty'),(6,'bool'),(6,'all-green'),(8,'missing-family'),(8,'near-name'),(8,'duplicate')]:
   with self.subTest(index=index,kind=kind),tempfile.TemporaryDirectory() as name:
    args=list(self.fixture(index));state=self.state(Path(name),args[4])
    if kind=='empty':args[5]['originalTestReportEvidence']['reports']=0
    if kind=='bool':args[5]['originalTestReportEvidence']['reports']=True
    if kind=='all-green':args[5]['originalTestReportEvidence']['allOriginalTestsPassRequired']=True
    if kind=='missing-family':args[5]['packageOutputKinds'].remove('buildinfo')
    if kind=='near-name':args[5]['packageOutputKinds']=['deb-extra','changes','buildinfo']
    if kind=='duplicate':args[5]['packageOutputKinds'].append('deb')
    with self.assertRaisesRegex(ValueError,'report inventory|package output families'):self.finish(args,state)

 def test_actual_firstparty_zero_terminal_with_live_owned_child_is_charged_and_blocks_all_continuation(self):
  # Only first-party Python stand-ins run. Their real zero/live-child condition
  # supplies this synthetic protocol fixture; no dpkg or SDK tool executes.
  background=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(90)'],start_new_session=True)
  try:
   started=time.monotonic();native=subprocess.run([sys.executable,'-I','-B','-c','pass'],timeout=5)
   self.assertEqual(native.returncode,0);self.assertIsNone(background.poll())
   config,ledger,root,sha,contract,observation,*_=self.fixture(2)
   observation['quiescenceObserved']=background.poll() is not None
   observation['originalCommandTerminal']['elapsedSeconds']=time.monotonic()-started
   after=m.failed(config,ledger,root,contract,observation,ValueError('Synthetic zero terminal; owned child remains unclosed'),frozen_configuration_sha256=sha)
   row=after['attempts'][-1];self.assertEqual(row['outcome'],'terminal-incomplete');self.assertEqual(row['exitCode'],0)
   self.assertTrue(row['terminalObserved']);self.assertFalse(row['quiescenceObserved']);self.assertEqual(row['nativeSeconds'],12);self.assertIsNone(row['checkpointSha256'])
   self.assertEqual(m.planner.validate_ledger(after,config)[2],m.planner.validate_ledger(ledger,config)[2]+12)
   self.assertTrue(m.planner.completion(after,config)['continuationInhibitedByUnresolvedFamily'])
   with self.assertRaisesRegex(ValueError,'Unresolved'):m.next_contract(config,after,root,frozen_configuration_sha256=sha)
   with self.assertRaisesRegex(ValueError,'Unresolved'):m.planner.next_phase(after,config,{})
   forged=f.completed(after,config)
   with self.assertRaisesRegex(ValueError,'Unresolved'):m.planner.append_attempt(after,config,forged)
   claimed=copy.deepcopy(after);claimed['attempts'][-1]['quiescenceReconciled']=True
   with self.assertRaisesRegex(ValueError,'Unresolved'):m.next_contract(config,claimed,root,frozen_configuration_sha256=sha)
   claimed=copy.deepcopy(after);claimed['attempts'][-1]['quiescenceObserved']=True
   with self.assertRaisesRegex(ValueError,'Terminal-incomplete'):m.planner.validate_ledger(claimed,config)
  finally:
   background.terminate()
   try:background.wait(timeout=5)
   except subprocess.TimeoutExpired:background.kill();background.wait(timeout=5)

 def test_every_unconfirmed_failure_family_is_charged_and_cannot_resume(self):
  for kind in ['zero','nonzero','unknown']:
   with self.subTest(kind=kind):
    config,ledger,root,sha,contract,observation,*_=self.fixture(4);observation['quiescenceObserved']=False
    if kind=='nonzero':observation['originalCommandExitCode']=3;observation['originalCommandTerminal']['exitCode']=3
    if kind=='unknown':observation.update(originalCommandTerminalObserved=False,originalCommandExitCode=None,originalCommandSignal=None,originalCommandTerminal=None)
    after=m.failed(config,ledger,root,contract,observation,ValueError('Synthetic unclosed family'),frozen_configuration_sha256=sha)
    self.assertEqual(after['attempts'][-1]['nativeSeconds'],12)
    self.assertEqual(after['attempts'][-1]['exitCode'],0 if kind=='zero' else 3 if kind=='nonzero' else None)
    with self.assertRaisesRegex(ValueError,'Unresolved'):m.next_contract(config,after,root,frozen_configuration_sha256=sha)

 def test_operator_frozen_history_preserves_failed_charges_and_rejects_phase0_only_reset(self):
  config,configure,root,sha,contract,observation,*_=self.fixture(1)
  history=m.failed(config,configure,root,contract,observation,ValueError('Synthetic closed retained-zero failure'),frozen_configuration_sha256=sha)
  frozen=m.codec.sha(m.codec.canonical(history));selected=m.select_frozen_history(config,configure,history,frozen_history_sha256=frozen)
  self.assertEqual(selected['allAttemptNativeSeconds'],m.planner.validate_ledger(configure,config)[2]+12)
  next=m.next_contract(config,selected['phaseLedger'],root,frozen_configuration_sha256=sha)
  self.assertEqual(next['allAttemptNativeSecondsAlreadyCharged'],selected['allAttemptNativeSeconds']);self.assertEqual(next['attempt'],2)
  with self.assertRaisesRegex(ValueError,'phase0 reset refused'):m.select_frozen_history(config,configure,configure,frozen_history_sha256=frozen)
  changed=copy.deepcopy(history);changed['attempts'][-1]['nativeSeconds']=0
  with self.assertRaisesRegex(ValueError,'complete attempt history'):m.select_frozen_history(config,configure,changed,frozen_history_sha256=frozen)
  self.assertFalse(selected['operatorExecutionTrustGranted']);self.assertFalse(selected['nativeEvidenceOriginAssessed'])

 def test_all_prior_failed_charges_count_toward_the_unchanged_twelve_hour_allowance(self):
  config,ledger,root,sha,contract,observation,*_=self.fixture(1)
  ledger['attempts'][0]['nativeSeconds']=14400
  contract=m.next_contract(config,ledger,root,frozen_configuration_sha256=sha)
  observation['sdkPreparationSecondsCharged']=1200;observation['observerElapsedSeconds']=13200;observation['combinedSdkAndPhaseObservedSeconds']=14400
  once=m.failed(config,ledger,root,contract,observation,ValueError('Synthetic closed charged failure'),frozen_configuration_sha256=sha)
  contract=m.next_contract(config,once,root,frozen_configuration_sha256=sha);self.assertEqual(contract['allAttemptNativeSecondsAlreadyCharged'],28800)
  twice=m.failed(config,once,root,contract,observation,ValueError('Synthetic second charged failure'),frozen_configuration_sha256=sha)
  self.assertEqual(m.planner.validate_ledger(twice,config)[2],43200)
  with self.assertRaisesRegex(ValueError,'Aggregate'):m.next_contract(config,twice,root,frozen_configuration_sha256=sha)
  extra=f.completed(twice,config);extra['nativeSeconds']=1
  with self.assertRaisesRegex(ValueError,'Aggregate'):m.planner.append_attempt(twice,config,extra)


if __name__=='__main__':unittest.main(verbosity=2)
