"""N2 original-state/NEW-SDK scope controls. No SDK, Docker or service call."""
import importlib.util,json,os,stat,tempfile,time,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
def load(name):
 p=ROOT/'scripts/producer-qualification'/name;s=importlib.util.spec_from_file_location(p.stem.replace('-','_'),p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
s=load('gcc-native05-retention-scope.py')

class Scope(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='gcc-native05-synthetic-scope-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
  self.native=self.root/'native-frame';self.state=self.native/'state';self.sdk=self.root/'sdk-frame';self.prepared=self.native/'controls/prepared-sdk'
  for p in [self.state/'source',self.state/'__carrier_work',self.sdk/'observations',self.prepared,self.native/'observations']:p.mkdir(parents=True,exist_ok=True)
  self.baseline=b'{"original-historical-software": "synthetic-only"}\n';(self.state/s.BASELINE).write_bytes(self.baseline)
  self.raw=[b'{"NEW-sdk-generation-a": 11}\n',b'{"NEW-sdk-generation-b": 29}\n']
  for i,body in enumerate(self.raw):(self.sdk/'observations'/('new-'+str(i)+'.json')).write_bytes(body)
  (self.prepared/'SDK-METADATA.json').write_text('{"new-validated-sdk": true}\n')
  (self.state/'source/main.c').write_text('int synthetic_original(void) { return 7; }\n')
  for target,relative in s.MAIN_SOURCES.items():(self.native/relative).write_text('synthetic original GCC '+target+'\n')
  self.pin=s.historical_baseline(self.state)
 def inspect(self):return s.inspect_state(self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5)
 def plan(self):return s.evidence_plan(self.native,self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5)
 def test_valid_two_families_preserve_historical_baseline_and_exact_three_main_sources(self):
  before={str(p.relative_to(self.sdk)):p.read_bytes() for p in self.sdk.rglob('*') if p.is_file()}
  result=self.plan();self.assertEqual(set(result['mainSources']),{'main-native.log','main-resource-samples.json','original-commands.jsonl'});self.assertTrue(result['scope']['historicalBaselineRetainedByteIdentically'])
  self.assertFalse(result['checkpointOrCacheExportAuthorized']);self.assertEqual((self.state/s.BASELINE).read_bytes(),self.baseline)
  self.assertEqual(before,{str(p.relative_to(self.sdk)):p.read_bytes() for p in self.sdk.rglob('*') if p.is_file()})
 def test_valid_near_name_with_different_bytes_is_original_state_not_a_guessed_prefix(self):
  (self.state/'source/sdk-observed-helper.c').write_text('int still_original(void) { return 19; }\n');self.inspect()
 def test_n2_whole_new_sdk_bodies_copied_under_other_source_names_refuse(self):
  for i,body in enumerate(self.raw):
   with self.subTest(member=i):
    p=self.state/'source'/('foreign-'+str(i));p.write_bytes(body)
    try:
     with self.assertRaisesRegex(ValueError,'NEW SDK family body'):self.inspect()
    finally:p.unlink()
 def test_sdk_body_cannot_be_relabelled_as_main_native_log(self):
  (self.native/'native.log').write_bytes(self.raw[1])
  with self.assertRaisesRegex(ValueError,'SDK raw body'):self.plan()
 def test_historical_baseline_exact_scope_is_distinct_even_when_new_observation_has_same_bytes(self):
  (self.sdk/'observations/same-historical.json').write_bytes(self.baseline);self.inspect()
  (self.state/'source/copied-historical.json').write_bytes(self.baseline)
  with self.assertRaisesRegex(ValueError,'NEW SDK family body'):self.inspect()
 def test_baseline_byte_or_mode_changes_never_become_a_new_baseline(self):
  p=self.state/s.BASELINE;p.write_bytes(self.baseline+b' ')
  with self.assertRaisesRegex(ValueError,'Historical'):self.inspect()
  p.write_bytes(self.baseline);p.chmod(self.pin['mode']^0o100)
  with self.assertRaisesRegex(ValueError,'Historical'):self.inspect()
 def test_old_exporter_directory_is_refused_even_before_any_raw_body_is_copied(self):
  p=self.state/s.FORBIDDEN_STATE_PATHS[0];p.mkdir()
  with self.assertRaisesRegex(ValueError,'SDK exporter directory'):self.inspect()
 def test_alias_into_new_sdk_family_refuses_without_following_its_body(self):
  (self.state/'source/alias').symlink_to(self.sdk/'observations/new-1.json')
  with self.assertRaisesRegex(ValueError,'link targets NEW SDK'):self.inspect()
 def test_hardlink_cross_scope_refuses_and_never_mutates_original_sdk(self):
  src=self.sdk/'observations/new-0.json';before=src.read_bytes();os.link(src,self.state/'source/alias')
  with self.assertRaisesRegex(ValueError,'file/link scope'):self.inspect()
  self.assertEqual(src.read_bytes(),before)
 def test_sdk_family_child_directory_alias_cannot_hide_an_unchecked_family(self):
  (self.sdk/'observations/alias-directory').symlink_to(self.prepared,target_is_directory=True)
  with self.assertRaisesRegex(ValueError,'child alias'):self.inspect()
 def test_missing_or_linked_main_source_preflights_before_any_evidence_publication(self):
  p=self.native/'native.log';p.unlink()
  with self.assertRaises(Exception):self.plan()
  self.assertFalse((self.state/'__carrier_work/native05-gcc-only-evidence').exists())
 def test_expired_scope_budget_has_no_positive_result(self):
  with self.assertRaisesRegex(ValueError,'deadline'):s.inspect_state(self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()-1)
 def test_actual_main_only_copy_has_no_raw_stage_dump_or_new_sdk_family(self):
  (self.native/'observations/SELECTED-PHASE-STAGE.json').write_bytes(self.raw[0])
  record=s.retain_main_only(self.native,self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5)
  output=self.state/'__carrier_work/native05-gcc-only-evidence';self.assertEqual(set(p.name for p in output.iterdir()),{'main-native.log','main-resource-samples.json','original-commands.jsonl','INVENTORY.json'})
  self.assertFalse(record['newRawSdkFamilyCopied']);self.assertEqual((self.state/s.BASELINE).read_bytes(),self.baseline)
  for p in output.iterdir():
   for body in self.raw:self.assertNotEqual(p.read_bytes(),body)
 def test_existing_main_evidence_destination_never_overwrites_or_drops_source_state(self):
  output=self.state/'__carrier_work/native05-gcc-only-evidence';output.mkdir();(output/'owned').write_text('keep')
  with self.assertRaisesRegex(ValueError,'Fresh main-only'):s.retain_main_only(self.native,self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5)
  self.assertEqual((output/'owned').read_text(),'keep');self.assertEqual((self.state/s.BASELINE).read_bytes(),self.baseline)

if __name__=='__main__':unittest.main(verbosity=2)
