"""N2 original-state/NEW-SDK scope controls. No SDK, Docker or service call."""
import hashlib,importlib.util,json,os,stat,tempfile,time,unittest
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
  # Genuine shape after a successful SDK reconstruction: the predecessor's
  # configure-time inventory and every later dpkg-query observation agree.
  self.packages=b'synthetic-gcc-build-dep\t12.2.0-14+deb12u1\tamd64\nsynthetic-libc6-dev\t2.36-9+deb12u7\tamd64\n'
  self.package_sha=hashlib.sha256(self.packages).hexdigest()
  (self.state/s.PACKAGE_INVENTORY).write_bytes(self.packages)
  (self.sdk/'observations/installed-package-identities.txt').write_bytes(self.packages)
  for label in ['before','after']:(self.native/('observations/installed-package-identities-'+label+'.txt')).write_bytes(self.packages)
  self.pin=s.historical_baseline(self.state)
 def inspect(self):return s.inspect_state(self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5,package_inventory_sha256=self.package_sha)
 def plan(self):return s.evidence_plan(self.native,self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5,package_inventory_sha256=self.package_sha)
 def retain(self):return s.retain_main_only(self.native,self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5,package_inventory_sha256=self.package_sha)
 def test_reconstructed_predecessor_package_inventory_is_admitted_only_at_its_bound_path(self):
  self.assertIn((len(self.packages),self.package_sha),s.raw_sdk_pins(self.sdk,self.prepared,native_frame=self.native))
  self.assertTrue(self.retain()['wholeOriginalStateRetained'])
  self.assertEqual((self.state/s.PACKAGE_INVENTORY).read_bytes(),self.packages)
 def test_predecessor_package_inventory_copied_to_another_path_refuses(self):
  for relative in ['source/installed-build-package-identities.txt','__carrier_work/installed-package-identities.txt']:
   with self.subTest(relative=relative):
    p=self.state/relative;p.write_bytes(self.packages)
    try:
     with self.assertRaisesRegex(ValueError,'NEW SDK family body'):self.inspect()
    finally:p.unlink()
  self.inspect()
 def test_predecessor_package_inventory_path_with_other_or_missing_bytes_refuses(self):
  p=self.state/s.PACKAGE_INVENTORY
  for body in [self.packages.replace(b'2.36-9+deb12u7',b'2.36-9+deb12u8'),None]:
   with self.subTest(missing=body is None):
    if body is None:p.unlink()
    else:p.write_bytes(body)
    with self.assertRaisesRegex(ValueError,'Historical predecessor package inventory'):self.inspect()
  p.write_bytes(self.packages);self.inspect()
  for binding in [hashlib.sha256(b'other synthetic inventory').hexdigest(),None,self.package_sha.upper()]:
   with self.subTest(binding=binding),self.assertRaisesRegex(ValueError,'package inventory'):
    s.inspect_state(self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()+5,package_inventory_sha256=binding)
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
  with self.assertRaisesRegex(ValueError,'deadline'):s.inspect_state(self.state,self.sdk,self.prepared,self.pin,deadline=time.monotonic()-1,package_inventory_sha256=self.package_sha)
 def test_actual_main_only_copy_has_no_raw_stage_dump_or_new_sdk_family(self):
  (self.native/'observations/SELECTED-PHASE-STAGE.json').write_bytes(self.raw[0])
  record=self.retain()
  output=self.state/'__carrier_work/native05-gcc-only-evidence';self.assertEqual(set(p.name for p in output.iterdir()),{'main-native.log','main-resource-samples.json','original-commands.jsonl','INVENTORY.json'})
  self.assertFalse(record['newRawSdkFamilyCopied']);self.assertEqual((self.state/s.BASELINE).read_bytes(),self.baseline)
  for p in output.iterdir():
   for body in self.raw:self.assertNotEqual(p.read_bytes(),body)
 def test_existing_main_evidence_destination_never_overwrites_or_drops_source_state(self):
  output=self.state/'__carrier_work/native05-gcc-only-evidence';output.mkdir();(output/'owned').write_text('keep')
  with self.assertRaisesRegex(ValueError,'Fresh main-only'):self.retain()
  self.assertEqual((output/'owned').read_text(),'keep');self.assertEqual((self.state/s.BASELINE).read_bytes(),self.baseline)

if __name__=='__main__':unittest.main(verbosity=2)
