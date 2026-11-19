"""Finite body wiring on synthetic trees; real first-party records, no producer/SDK."""
import contextlib
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

m=load(ROOT/'scripts/producer-qualification/gcc-staged-selected-body.py')
f=load(ROOT/'test/gcc-staged-phase-contract-cases.py')


class SelectedBody(unittest.TestCase):
 def fixture(self,root,index,*,preexisting=False):
  root=root.resolve();args=f.PhaseContract().fixture(index);config,ledger,old,sha,contract=args[:5]
  config['variables']['CONFARGS']='--enable-languages='+m.legacy.stage.LANGUAGES+' --enable-multilib --enable-offload-targets=nvptx-none,amdgcn-amdhsa'
  # Rebind the synthetic phase history to the full original language shape.
  selected=m.planner.plan(config);ledger=m.planner.new_ledger(config)
  for i in range(index):
   row=f.f.completed(ledger,config);ledger=m.planner.append_attempt(ledger,config,row)
  prior=ledger['attempts'][-1]
  old={'binding':f.f.binding(configurationSha256=selected['configurationSha256'],phase=selected['phases'][index-1]['phase'],sequence=index-1,predecessorSha256=prior['predecessorSha256']),
       'archiveSha256':prior['checkpointSha256'],'externalSdkSha256':'d'*64}
  contract=m.family.next_contract(config,ledger,old,frozen_configuration_sha256=selected['configurationSha256'])
  state=root/'state';(state/'source/stamps').mkdir(parents=True);(state/'__carrier_work/gcc-staged-configuration').mkdir(parents=True)
  controls=root/'controls';controls.mkdir();output=root/'observations';output.mkdir()
  for phase in selected['phases'][:index]:
   for name in phase['requiredStamps']:(state/'source'/name).write_bytes(b'Synthetic earlier required stamp')
  if preexisting:
   for name in contract['requiredStamps']:(state/'source'/name).write_bytes(b'Synthetic valid preexisting required stamp')
  if contract['originalTestReportInventoryRequired']:
   folder=state/'source/build-jit/gcc/testsuite';folder.mkdir(parents=True)
   (folder/'synthetic.sum').write_bytes(b'PASS: synthetic-one\nFAIL: synthetic-two\n');(folder/'synthetic.log').write_bytes(b'Synthetic complete associated log\xff\n')
  if contract['packageOutputClosureAdditionallyRequired']:
   for name in ['synthetic.deb','synthetic.changes','synthetic.buildinfo']:(state/name).write_bytes(b'Synthetic opaque artifact')
  tree=m.codec.snapshot(state,m.codec.Budget());old['manifestSha256']=m.codec.sha(m.codec.canonical({'schemaVersion':1,'binding':old['binding'],'tree':tree}))
  (controls/'SELECTED-PHASE-CONTRACT.json').write_bytes(m.codec.canonical(contract))
  return config,ledger,old,contract,state,controls,output

 def active(self,args,*,code=0,spawn_error=None,sdk_error=None,write_stamps=True):
  config,ledger,old,contract,state,controls,output=args;stack=contextlib.ExitStack()
  stack.enter_context(mock.patch.object(m.history,'read_policy',return_value=({'predecessorRoot':old},{})))
  stack.enter_context(mock.patch.object(m.history,'verify_selected_history',return_value=contract))
  stack.enter_context(mock.patch.object(m.history,'ALLOWED_ORIGINAL_PHASE',contract['phase']))
  stack.enter_context(mock.patch.object(m.planner,'read_configuration',return_value=config))
  projection=stack.enter_context(mock.patch.object(m.legacy,'sdk_projection',side_effect=sdk_error,return_value={'materialProjectionMatches':True,'timestampOnlyMaterialPaths':0}))
  def run(command,*,cwd,check):
   self.assertEqual(command,contract['command']);self.assertEqual(cwd,state/'source');self.assertFalse(check)
   if spawn_error:raise spawn_error
   if write_stamps:
    for name in contract['requiredStamps']:(state/'source'/name).write_bytes(b'Synthetic required original stamp')
   return SimpleNamespace(returncode=code)
  original=stack.enter_context(mock.patch.object(m.legacy.stage.subprocess,'run',side_effect=run))
  return stack,projection,original

 def test_every_selected_original_target_uses_its_exact_real_record_and_retains_material_evidence(self):
  for index in range(1,9):
   with self.subTest(index=index),tempfile.TemporaryDirectory() as name:
    args=self.fixture(Path(name),index);stack,sdk,original=self.active(args)
    with stack:result=m.run_stage(args[4],args[2],args[1],args[5],args[6])
    self.assertEqual(result['phase'],args[3]['phase']);self.assertEqual(result['originalCommand'],args[3]['command']);original.assert_called_once()
    self.assertEqual(result['state'],'original-selected-phase-zero-terminal-and-material-observed-not-retained');self.assertEqual(result['originalCommandExitCode'],0)
    self.assertEqual(sdk.call_count,2);self.assertFalse(result['requiredStampFreshnessClaimed']);self.assertFalse(result['gateAComplete'])
    record=m.terminal(args[6]/'original-commands.jsonl',args[4]/'source',args[3]);self.assertEqual(record['exitCode'],0)
    if index in [2,6]:self.assertFalse(result['originalTestReportEvidence']['allOriginalTestsPassRequired'])
    if index==8:self.assertFalse(result['packageOutputs']['packageFormatVerified']);self.assertFalse(result['packageOutputs']['originalNoticeOrLicenseClosureVerified'])

 def test_valid_preexisting_default_and_package_stamps_need_no_fabricated_freshness(self):
  for index in [7,8]:
   with self.subTest(index=index),tempfile.TemporaryDirectory() as name:
    args=self.fixture(Path(name),index,preexisting=True);stack,_,_=self.active(args,write_stamps=False)
    with stack:result=m.run_stage(args[4],args[2],args[1],args[5],args[6])
    self.assertTrue(result['originalCommandTerminalObserved']);self.assertFalse(result['requiredStampFreshnessClaimed'])

 def test_nonzero_and_signal_original_terminals_survive_the_helper_wrapper_failure(self):
  for code in [3,-15]:
   with self.subTest(code=code),tempfile.TemporaryDirectory() as name:
    args=self.fixture(Path(name),3);stack,sdk,_=self.active(args,code=code)
    with stack:
     with self.assertRaisesRegex(ValueError,'Original native command failed'):m.run_stage(args[4],args[2],args[1],args[5],args[6])
    result=json.loads((args[6]/'SELECTED-PHASE-STAGE.json').read_bytes());self.assertTrue(result['originalCommandTerminalObserved'])
    self.assertEqual(result['originalCommandExitCode'],3 if code==3 else None);self.assertEqual(result['originalCommandSignal'],None if code==3 else 15);self.assertEqual(sdk.call_count,1)

 def test_request_without_terminal_never_becomes_wrapper_exit_or_success(self):
  with tempfile.TemporaryDirectory() as name:
   args=self.fixture(Path(name),1);stack,_,_=self.active(args,spawn_error=FileNotFoundError('Synthetic original executable unavailable'))
   with stack:
    with self.assertRaises(FileNotFoundError):m.run_stage(args[4],args[2],args[1],args[5],args[6])
   result=json.loads((args[6]/'SELECTED-PHASE-STAGE.json').read_bytes());self.assertTrue(result['originalCommandAttempted'])
   self.assertFalse(result['originalCommandTerminalObserved']);self.assertIsNone(result['originalCommandExitCode']);self.assertFalse(result['gateAComplete'])

 def test_late_missing_stamp_report_or_package_failure_keeps_genuine_zero_without_completion(self):
  for index,kind in [(1,'stamp'),(2,'reports'),(8,'package')]:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args=self.fixture(Path(name),index)
    if kind=='reports':(args[4]/'source/build-jit/gcc/testsuite/synthetic.sum').write_bytes(b'')
    if kind=='package':(args[4]/'synthetic.deb').unlink()
    # Rebind source snapshot after this synthetic preexisting material change.
    tree=m.codec.snapshot(args[4],m.codec.Budget());args[2]['manifestSha256']=m.codec.sha(m.codec.canonical({'schemaVersion':1,'binding':args[2]['binding'],'tree':tree}))
    stack,_,_=self.active(args,write_stamps=kind!='stamp')
    with stack:
     with self.assertRaises((ValueError,FileNotFoundError)):m.run_stage(args[4],args[2],args[1],args[5],args[6])
    result=json.loads((args[6]/'SELECTED-PHASE-STAGE.json').read_bytes());self.assertEqual(result['originalCommandExitCode'],0)
    self.assertTrue(result['originalCommandTerminalObserved']);self.assertFalse(result['phaseCompletionAssessed'])

 def test_changed_readonly_contract_predecessor_or_allowed_source_phase_refuses_before_sdk_or_original_command(self):
  for kind in ['contract','tree','allowed-phase']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args=self.fixture(Path(name),1);stack,sdk,original=self.active(args)
    if kind=='contract':(args[5]/'SELECTED-PHASE-CONTRACT.json').write_text('{"phase":"packages","command":["true"]}')
    if kind=='tree':(args[4]/'source/new').write_bytes(b'Synthetic changed original tree')
    with stack:
     if kind=='allowed-phase':m.history.ALLOWED_ORIGINAL_PHASE='jit'
     with self.assertRaises(ValueError):m.run_stage(args[4],args[2],args[1],args[5],args[6])
     sdk.assert_not_called();original.assert_not_called()
    result=json.loads((args[6]/'SELECTED-PHASE-STAGE.json').read_bytes());self.assertFalse(result['originalCommandAttempted'])

 def test_sdk_before_failure_prevents_command_and_after_failure_preserves_genuine_zero(self):
  for when in ['before','after']:
   with self.subTest(when=when),tempfile.TemporaryDirectory() as name:
    args=self.fixture(Path(name),1);effects=ValueError('Synthetic SDK material drift') if when=='before' else [{'materialProjectionMatches':True,'timestampOnlyMaterialPaths':0},ValueError('Synthetic SDK material drift')]
    stack,_,original=self.active(args,sdk_error=effects)
    with stack:
     with self.assertRaisesRegex(ValueError,'SDK material drift'):m.run_stage(args[4],args[2],args[1],args[5],args[6])
    result=json.loads((args[6]/'SELECTED-PHASE-STAGE.json').read_bytes())
    if when=='before':original.assert_not_called();self.assertFalse(result['originalCommandAttempted'])
    else:self.assertTrue(result['originalCommandTerminalObserved']);self.assertEqual(result['originalCommandExitCode'],0)
    self.assertFalse(result['phaseCompletionAssessed'])

 def test_native_entry_has_no_phase_command_or_trust_argument(self):
  for arguments in [['body.py','jit'],['body.py','selected-original-phase','--phase','packages'],['body.py','--operator-trust-execution']]:
   with self.subTest(arguments=arguments),mock.patch.object(m.sys,'argv',arguments),mock.patch.object(m,'run_stage') as run:
    with self.assertRaisesRegex(ValueError,'No caller-selected'):m.main()
    run.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)
