import hashlib,importlib.util,io,json,lzma,os,shutil,sys,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
from test_controller import SecondOpenSwap
s=importlib.util.spec_from_file_location('producer_materializer',HERE/'materializer.py');M=importlib.util.module_from_spec(s);s.loader.exec_module(M)
class Controls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='synthetic-rust-producer-');self.root=Path(self.tmp.name).resolve();self.limits={'materializationSeconds':30,'materializationDecodedBytes':1024**2,'materializationMembersPerPass':100,'materializationFileAndIndexBytes':1024**2,'materializationIndexBytes':65536};self.I=M.primitives()
 def tearDown(self):self.tmp.cleanup()
 def fixture(self,extra=None):
  stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT) as tar:
   for name in ['source','source/src']:
    x=tarfile.TarInfo(name);x.type=tarfile.DIRTYPE;x.mode=0o755;tar.addfile(x)
   for name,body,mode in [('source/version',b'1.98.0 synthetic',0o644),('source/src/item.rs',b'synthetic inert fixture bytes',0o644),('source/x.py',b'# synthetic fixture, never executed\n',0o755)]:
    x=tarfile.TarInfo(name);x.size=len(body);x.mode=mode;tar.addfile(x,io.BytesIO(body))
   for x,body in extra or []:tar.addfile(x,io.BytesIO(body) if body is not None else None)
  f=self.root/'source.xz';f.write_bytes(lzma.compress(stream.getvalue()));c=self.root/'cache.xz';c.write_bytes(b'synthetic opaque bootstrap cache');return {'id':'source','prefix':'source','bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()},[{'id':'cache','bytes':c.stat().st_size,'sha256':hashlib.sha256(c.read_bytes()).hexdigest(),'originalURL':'https://fixture.invalid/cargo-synthetic.tar.xz'}],{'source':str(f),'cache':str(c)}
 def invoke(self,fixture):return M.materialize(*fixture,self.root/'payload',self.limits,self.I)
 def test_whole_two_pass_bundle_contains_exact_source_map_and_unchanged_cache(self):
  result=self.invoke(self.fixture());self.assertTrue(result['completeSourceMaterialization']);self.assertFalse(result['nativeBuildPassCredit']);source=Path(result['source']);records=json.loads(Path(result['memberMap']).read_bytes());self.assertTrue(M.original_frame_matches(source,records));self.assertEqual((source/'build/cache/2026-07-16/cargo-synthetic.tar.xz').read_bytes(),b'synthetic opaque bootstrap cache');self.assertEqual(len(records),4);self.assertEqual(result['originalMaterialMembersIncludingArchiveRoot'],5)
 def test_valid_internal_link_and_dangerous_near_misses(self):
  x=tarfile.TarInfo('source/src/link');x.type=tarfile.SYMTYPE;x.linkname='../version';x.mode=0o777;r=self.invoke(self.fixture([(x,None)]));self.assertEqual(os.readlink(Path(r['source'])/'src/link'),'../version')
  for link in ['/outside','../../outside']:
   with self.subTest(link=link),self.assertRaisesRegex(ValueError,'Relative|leaves'):M.validate_layout([{'path':'link','type':'symlink','link':link,'mode':0o777}])
 def test_cycle_and_missing_link_targets_refused(self):
  with self.assertRaisesRegex(ValueError,'cycle'):M.validate_layout([{'path':'a','type':'symlink','link':'b','mode':0o777},{'path':'b','type':'symlink','link':'a','mode':0o777}])
  with self.assertRaisesRegex(ValueError,'absent'):M.validate_layout([{'path':'a','type':'symlink','link':'missing','mode':0o777}])
 def test_non_directory_parent_and_privileged_mode_refused(self):
  with self.assertRaisesRegex(ValueError,'parent'):M.validate_layout([{'path':'a','type':'regular','mode':0o644},{'path':'a/b','type':'regular','mode':0o644}])
  with self.assertRaisesRegex(ValueError,'Privileged'):M.validate_layout([{'path':'a','type':'regular','mode':0o4755}])
 def test_physical_reservation_refuses_before_any_bundle_write(self):
  f=self.fixture();self.limits['materializationFileAndIndexBytes']=65536
  with self.assertRaisesRegex(ValueError,'reserved'):self.invoke(f)
  self.assertFalse((self.root/'payload').exists());self.assertFalse((self.root/'payload.unaccepted').exists())
 def test_index_and_aggregate_two_pass_decoded_bounds(self):
  f=self.fixture();self.limits['materializationIndexBytes']=1
  with self.assertRaisesRegex(ValueError,'member-map'):self.invoke(f)
  self.limits['materializationIndexBytes']=65536;self.limits['materializationDecodedBytes']=10240
  with self.assertRaisesRegex(ValueError,'two-pass decoded'):self.invoke(f)
  self.assertFalse((self.root/'payload').exists())
 def test_missing_original_parent_and_duplicate_member_are_not_partial_success(self):
  x=tarfile.TarInfo('source/version');x.size=4;x.mode=0o644
  with self.assertRaisesRegex(ValueError,'Duplicate'):self.invoke(self.fixture([(x,b'bad!')]))
  self.assertFalse((self.root/'payload').exists())
 def test_wrong_source_or_cache_pin_refuses_before_activation(self):
  a,b,c=self.fixture();a['sha256']='a'*64
  with self.assertRaisesRegex(ValueError,'source archive pin'):self.invoke((a,b,c))
  a,b,c=self.fixture();b[0]['sha256']='b'*64
  with self.assertRaisesRegex(ValueError,'cache pin'):self.invoke((a,b,c))
  self.assertFalse((self.root/'payload').exists())
 def test_second_pass_failure_preserves_only_unaccepted_private_bundle(self):
  f=self.fixture();real=M.source_pass;calls={'n':0}
  def changed(*args,**kwargs):
   calls['n']+=1
   if calls['n']==2:raise ValueError('synthetic changed second pass')
   return real(*args,**kwargs)
  with patch.object(M,'source_pass',side_effect=changed),self.assertRaisesRegex(ValueError,'second pass'):self.invoke(f)
  self.assertFalse((self.root/'payload').exists());self.assertTrue((self.root/'payload.unaccepted').is_dir());self.assertFalse((self.root/'payload.unaccepted/control/original-source-members.json').exists())
 def test_source_modification_and_parent_symlink_replacement_are_detected(self):
  r=self.invoke(self.fixture());source=Path(r['source']);records=json.loads(Path(r['memberMap']).read_bytes());(source/'version').write_bytes(b'changed')
  with self.assertRaisesRegex(ValueError,'file changed'):M.original_frame_matches(source,records)
  (source/'version').write_bytes(b'1.98.0 synthetic');(source/'src/item.rs').unlink();(source/'src').rmdir();os.symlink(self.root,source/'src')
  with self.assertRaisesRegex(ValueError,'directory changed'):M.original_frame_matches(source,records)
 def replaced_source(self):
  stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT) as tar:
   for name in ['source','source/src']:
    x=tarfile.TarInfo(name);x.type=tarfile.DIRTYPE;x.mode=0o755;tar.addfile(x)
   for name,body,mode in [('source/version',b'9.99.6151 replaced',0o644),('source/src/item.rs',b'replaced inert fixture 6151',0o644),('source/x.py',b'# replaced fixture 6151\n',0o755)]:
    x=tarfile.TarInfo(name);x.size=len(body);x.mode=mode;tar.addfile(x,io.BytesIO(body))
  return lzma.compress(stream.getvalue())
 def test_archives_replaced_after_their_pin_check_are_never_read_again(self):
  a,b,archives=self.fixture();swap=SecondOpenSwap({archives['source']:self.replaced_source(),archives['cache']:b'replaced opaque bootstrap cache 6151'})
  with swap:result=self.invoke((a,b,archives))
  source=Path(result['source']);self.assertEqual(b'1.98.0 synthetic',(source/'version').read_bytes());self.assertEqual(b'synthetic inert fixture bytes',(source/'src/item.rs').read_bytes())
  self.assertEqual(b'synthetic opaque bootstrap cache',(source/'build/cache/2026-07-16/cargo-synthetic.tar.xz').read_bytes());self.assertEqual({archives['source']:1,archives['cache']:1},swap.opens)
 def test_unchanged_archives_are_read_once_each(self):
  a,b,archives=self.fixture();swap=SecondOpenSwap({archives['source']:None,archives['cache']:None})
  with swap:result=self.invoke((a,b,archives))
  self.assertTrue(result['completeSourceMaterialization']);self.assertEqual({archives['source']:1,archives['cache']:1},swap.opens)
 def test_second_link_to_a_pinned_archive_is_refused_before_any_bundle_write(self):
  for key,message in [('source','source archive pin'),('cache','cache pin')]:
   with self.subTest(archive=key):
    a,b,archives=self.fixture();os.link(archives[key],self.root/'second-name-6151')
    try:
     with self.assertRaisesRegex(ValueError,message):self.invoke((a,b,archives))
    finally:os.unlink(self.root/'second-name-6151')
    self.assertFalse((self.root/'payload').exists());self.assertFalse((self.root/'payload.unaccepted').exists())
 def reused_copy(self):
  copied=self.root/'reused-inventory';shutil.copytree(HERE/'reused-inventory',copied);return {name:copied/name for name in M.REUSE}
 def load_copied_primitives(self,swap):
  with patch.object(M,'HERE',self.root),patch.object(sys,'path',list(sys.path)),patch.dict(sys.modules),swap:
   sys.modules.pop('common',None);module=M.primitives();return module,sys.modules['common']
 def test_reused_primitives_run_from_the_bytes_matching_their_pins(self):
  files=self.reused_copy();swap=SecondOpenSwap({files[name]:files[name].read_bytes()+b'\nSWAPPED_6151=True\n' for name in ['inventory.py','common.py']})
  module,common=self.load_copied_primitives(swap)
  self.assertFalse(hasattr(module,'SWAPPED_6151'));self.assertFalse(hasattr(common,'SWAPPED_6151'));self.assertEqual({str(files['inventory.py']):1,str(files['common.py']):1},swap.opens)
 def test_reused_policy_replaced_after_its_verified_read_has_no_effect(self):
  files=self.reused_copy();pinned=set(json.loads(files['POLICY.json'].read_bytes())['sourceMetadataPaths']);policy=json.loads(files['POLICY.json'].read_bytes());policy['sourceMetadataPaths']=['replaced-6151']
  swap=SecondOpenSwap({files['POLICY.json']:json.dumps(policy).encode()});module,_=self.load_copied_primitives(swap)
  self.assertEqual(pinned,module.METADATA);self.assertNotIn('replaced-6151',module.METADATA);self.assertEqual({str(files['POLICY.json']):1},swap.opens)
 def test_unchanged_reused_primitives_load_with_the_pinned_policy(self):
  files=self.reused_copy();swap=SecondOpenSwap({path:None for path in files.values()})
  module,common=self.load_copied_primitives(swap)
  self.assertEqual(set(json.loads(files['POLICY.json'].read_bytes())['sourceMetadataPaths']),module.METADATA);self.assertEqual(M.REUSE['common.py'],common.__verifiedSHA256__)
  self.assertEqual({str(files['inventory.py']):1,str(files['common.py']):1,str(files['POLICY.json']):1},swap.opens)
if __name__=='__main__':unittest.main()
