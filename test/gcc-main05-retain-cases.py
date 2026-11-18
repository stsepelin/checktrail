"""Real bounded synthetic whole-state archives/replay; no producer/Docker execution."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);return v

m=load(ROOT/'scripts/producer-qualification/gcc-main05-retain.py')
f=load(ROOT/'test/gcc-staged-cases.py')
a=load(ROOT/'test/gcc-main05-attempt-cases.py')


class Retention(unittest.TestCase):
 def fixture(self,root):
  frame=root/'native-frame';sdk=root/'sdk-frame';state=frame/'state';source=state/'source';(source/'stamps').mkdir(parents=True)
  (source/'stamps/04-configure-stamp').write_bytes(b'Synthetic configure');(source/'stamps/05-build-stamp').write_bytes(b'Synthetic completed bootstrap')
  (source/'object').write_bytes(b'Synthetic whole original compiled object');os.link(source/'object',source/'alias')
  (source/'pointer').symlink_to('/inert/synthetic-header')
  (state/'__carrier_work/gcc-staged-configuration').mkdir(parents=True);(state/'__carrier_apt_lists').mkdir();(state/'__carrier_apt_lists/source').write_bytes(b'Synthetic original APT state')
  (state/'__carrier_work/original-phase0-report').write_bytes(b'Synthetic preserved original report')
  for path in [frame/'observations',sdk/'observations',frame/'controls/prepared-sdk']:path.mkdir(parents=True)
  for directory in [frame/'observations',sdk/'observations',frame/'controls/prepared-sdk']:(directory/'synthetic.json').write_text('{"synthetic":true}')
  for directory in [frame,sdk]:
   (directory/'native.log').write_bytes(b'Synthetic complete opaque original output\xff\n')
   (directory/'resource-samples.json').write_text('{"samples":[],"synthetic":true}')
  config=f.configuration(hppa64=True)
  config['variables']['CONFARGS']='--enable-languages='+m.body.stage.LANGUAGES+' --enable-multilib --enable-offload-targets=nvptx-none,amdgcn-amdhsa'
  ledger=m.planner.new_ledger(config);ledger=m.planner.append_attempt(ledger,config,f.completed(ledger,config))
  root_binding={'binding':f.binding(configurationSha256=m.planner.plan(config)['configurationSha256']),'archiveSha256':'0'*64}
  observation=a.Attempts().fixture()[2];stage=a.Attempts().fixture()[5]
  (frame/'MAIN05-ATTEMPT.json').write_text(json.dumps(observation));(sdk/'ATTEMPT.json').write_text('{"nativePhase":"sdk-reconstruction","elapsedSeconds":50}')
  return frame,sdk,root_binding,ledger,config,observation,stage,{'ownedNativeCleanupComplete':True}

 def capture(self,args):
  with mock.patch.object(m.planner,'read_configuration',return_value=args[4]),mock.patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=100*m.policy.GIB)):
   return m.capture(*args)

 def test_complete_source_sdk_main_logs_reports_links_and_metadata_are_physically_replayed(self):
  with tempfile.TemporaryDirectory() as name:
   args=self.fixture(Path(name).resolve());frame,sdk=args[:2];state=frame/'state';before=m.codec.snapshot(state,m.codec.Budget())
   result=self.capture(args);self.assertTrue(result['restore']['physicalTreeVerified']);self.assertEqual(result['binding']['phase'],'native')
   self.assertEqual(m.planner.validate_ledger(result['phaseLedger'],args[4])[3],2)
   evidence=state/'__carrier_work/main05-carrier-evidence'
   self.assertEqual((evidence/'main-native.log').read_bytes(),(frame/'native.log').read_bytes())
   self.assertEqual((evidence/'sdk-native.log').read_bytes(),(sdk/'native.log').read_bytes())
   self.assertTrue((evidence/'main-observations/synthetic.json').is_file());self.assertTrue((evidence/'sdk-observations/synthetic.json').is_file())
   self.assertTrue((evidence/'prepared-sdk/synthetic.json').is_file());self.assertEqual((state/'__carrier_work/original-phase0-report').read_bytes(),b'Synthetic preserved original report')
   self.assertEqual((state/'source/object').stat().st_ino,(state/'source/alias').stat().st_ino);self.assertEqual(os.readlink(state/'source/pointer'),'/inert/synthetic-header')
   self.assertFalse((frame/'local-physical-readback').exists())
   retained=json.loads((frame/'RETENTION.json').read_bytes());self.assertTrue(retained['localLedgerIsProvisionalUntilServiceReplay'])
   self.assertFalse(retained['cacheSaveCompleted']);self.assertFalse(retained['cacheRestoreReplayQualified']);self.assertFalse(retained['gateAComplete'])
   self.assertTrue(before['entries']);self.assertNotEqual(result['checkpoint']['archiveSha256'],'0'*64)

 def test_missing_sdk_stdout_cannot_be_silently_omitted_and_genuine_zero_failure_is_charged(self):
  with tempfile.TemporaryDirectory() as name:
   args=self.fixture(Path(name).resolve());(args[1]/'native.log').unlink()
   with self.assertRaises((ValueError,FileNotFoundError)):self.capture(args)
   self.assertFalse((args[0]/'checkpoint').exists());self.assertFalse((args[0]/'state/__carrier_work/main05-carrier-evidence').exists())
   failed=json.loads((args[0]/'FAILED-PHASE-LEDGER.json').read_bytes());row=failed['attempts'][-1]
   self.assertEqual(row['outcome'],'retention-failed');self.assertEqual(row['exitCode'],0);self.assertTrue(row['terminalObserved']);self.assertIsNone(row['checkpointSha256'])
   self.assertEqual(row['nativeSeconds'],150);self.assertEqual(m.planner.validate_ledger(failed,args[4])[3],1)

 def test_physical_restore_failure_keeps_actual_zero_and_archive_but_never_advances_ledger(self):
  with tempfile.TemporaryDirectory() as name:
   args=self.fixture(Path(name).resolve())
   with mock.patch.object(m.codec,'restore',side_effect=ValueError('Synthetic independent replay failure')):
    with self.assertRaisesRegex(ValueError,'independent replay failure'):self.capture(args)
   self.assertTrue((args[0]/'checkpoint/tree.tar.gz').is_file());self.assertFalse((args[0]/'PHASE-LEDGER.json').exists())
   result=json.loads((args[0]/'RETENTION.json').read_bytes());self.assertFalse(result['localCheckpointCapturedAndPhysicallyRestored']);self.assertEqual(result['retentionStage'],'physical-restore')
   row=result['failedPhaseLedger']['attempts'][-1];self.assertEqual(row['exitCode'],0);self.assertIsNone(row['checkpointSha256']);self.assertEqual(row['nativeSeconds'],150)

 def test_wrong_config_missing_stamp_and_unclosed_family_refuse_before_large_archive(self):
  for kind in ['configuration','stamp','cleanup','native-nonzero']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    args=list(self.fixture(Path(name).resolve()))
    if kind=='stamp':(args[0]/'state/source/stamps/05-build-stamp').unlink()
    if kind=='cleanup':args[7]['ownedNativeCleanupComplete']=False
    if kind=='native-nonzero':
     args[5]['originalCommandExitCode']=3;args[5]['originalCommandTerminal']['exitCode']=3
    with mock.patch.object(m.planner,'read_configuration',return_value={} if kind=='configuration' else args[4]),mock.patch.object(m.codec,'capture') as capture:
     with self.assertRaises((ValueError,FileNotFoundError)):m.capture(*args)
     capture.assert_not_called()
    self.assertFalse((args[0]/'PHASE-LEDGER.json').exists())

 def test_interrupted_evidence_copy_never_publishes_partial_family_and_preserves_all_source_bytes(self):
  with tempfile.TemporaryDirectory() as name:
   args=self.fixture(Path(name).resolve());state=args[0]/'state';source_before=(state/'source/object').read_bytes();actual=m.h.copy_pinned;calls=[0]
   def copy(source,target,pin):
    calls[0]+=1
    if calls[0]==3:raise OSError('Synthetic third evidence copy failed')
    return actual(source,target,pin)
   with mock.patch.object(m.h,'copy_pinned',side_effect=copy):
    with self.assertRaisesRegex(OSError,'third evidence copy'):self.capture(args)
   self.assertEqual((state/'source/object').read_bytes(),source_before)
   self.assertFalse((state/'__carrier_work/main05-carrier-evidence').exists())
   self.assertFalse(any(path.name.startswith('.main05-evidence-') for path in (state/'__carrier_work').iterdir()))
   self.assertEqual(json.loads((args[0]/'FAILED-PHASE-LEDGER.json').read_bytes())['attempts'][-1]['nativeSeconds'],150)

 def test_exhausted_whole_retention_clock_cannot_be_reset_by_a_new_codec_operation(self):
  with tempfile.TemporaryDirectory() as name:
   args=self.fixture(Path(name).resolve())
   with mock.patch.object(m.planner,'read_configuration',return_value=args[4]),mock.patch.object(m.codec,'capture') as capture:
    with self.assertRaisesRegex(ValueError,'source-service deadline'):
     m.capture(*args,deadline=m.time.monotonic()-1)
    capture.assert_not_called()
   row=json.loads((args[0]/'FAILED-PHASE-LEDGER.json').read_bytes())['attempts'][-1]
   self.assertEqual(row['exitCode'],0);self.assertEqual(row['nativeSeconds'],150);self.assertEqual(row['outcome'],'retention-failed')
   self.assertFalse((args[0]/'PHASE-LEDGER.json').exists())

 def test_physical_clone_and_later_replay_budgets_share_one_decreasing_deadline(self):
  bounded=m.EvidenceCodec(130)
  with mock.patch.object(m.time,'monotonic',return_value=100):self.assertEqual(bounded.Budget({'seconds':180}).limits['seconds'],30)
  with mock.patch.object(m.time,'monotonic',return_value=110):self.assertEqual(bounded.Budget({'seconds':180}).limits['seconds'],20)
  with mock.patch.object(m.time,'monotonic',return_value=131),self.assertRaisesRegex(ValueError,'source-service deadline'):bounded.Budget({'seconds':180})


if __name__=='__main__':unittest.main(verbosity=2)
