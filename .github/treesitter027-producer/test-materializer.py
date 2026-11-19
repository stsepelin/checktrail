import hashlib,importlib.util,io,json,os,shutil,stat,tarfile,tempfile,unittest,subprocess,sys
from pathlib import Path
HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('materialize',HERE/'materialize-native-inputs.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Controls(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='synthetic-native-inputs-');self.root=Path(self.temp.name).resolve()
 def tearDown(self):
  for path in self.root.rglob('*'):
   if path.is_dir() and not path.is_symlink():path.chmod(0o700)
  self.temp.cleanup()
 def archive(self,name='sdk',extra=None,component=None,with_link=True):
  path=self.root/(name+'.tgz');prefix=name;component_path=prefix+('/'+component if component else '')
  rows=[(component_path,tarfile.DIRTYPE,b'',None),(component_path+'/lib',tarfile.DIRTYPE,b'',None),(component_path+'/bin',tarfile.DIRTYPE,b'',None),(component_path+'/lib/original.txt',tarfile.REGTYPE,b'original synthetic SDK bytes',None),(component_path+'/bin/tool',tarfile.REGTYPE,b'inert synthetic executable',None),(component_path+'/bin/link',tarfile.SYMTYPE,b'','tool')]
  if not with_link:rows=[r for r in rows if r[1]!=tarfile.SYMTYPE]
  if extra:rows.append(extra)
  with tarfile.open(path,'w:gz') as archive:
   for member_name,kind,body,link in rows:
    item=tarfile.TarInfo(member_name);item.type=kind;item.mode=0o755 if member_name.endswith('tool') or kind in (tarfile.DIRTYPE,tarfile.SYMTYPE) else 0o644;item.size=len(body)
    if link:item.linkname=link
    archive.addfile(item,io.BytesIO(body) if kind==tarfile.REGTYPE else None)
  row={'id':name,'archivePrefix':prefix,'bytes':path.stat().st_size,'sha256':m.digest(path),'materialization':{'destination':'runtime','strip':2 if component else 1}}
  if component:row['materialization']['component']=component
  return path,row
 def test_original_bytes_modes_and_symlinks_are_materialized_without_execution(self):
  path,row=self.archive();result=m.prepare({'sdk':path},[row],self.root/'prepared');target=self.root/'prepared/runtime'
  self.assertTrue(result['materialized']);self.assertTrue(result['allSourceAndSDKCodeUnexecuted']);self.assertFalse(result['nativeExecutionGranted']);self.assertEqual((target/'lib/original.txt').read_bytes(),b'original synthetic SDK bytes');self.assertEqual((target/'bin/link').resolve(),target/'bin/tool');self.assertEqual(stat.S_IMODE((target/'bin/tool').stat().st_mode),0o555);self.assertEqual(stat.S_IMODE((target/'lib/original.txt').stat().st_mode),0o444)
 def test_every_archive_is_preflighted_before_any_payload_stage_exists(self):
  path,row=self.archive();other,second=self.archive('second');second['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'archive identity'):m.prepare({'sdk':path,'second':other},[row,second],self.root/'prepared')
  self.assertFalse((self.root/'prepared').exists());self.assertEqual(list(self.root.glob('tree027-input-stage-*')),[])
 def test_overlapping_files_escaping_links_and_link_parent_traversal_refuse(self):
  for label,extra in [('escaping',('sdk/bin/out',tarfile.SYMTYPE,b'','../../outside')),('parent',('sdk/bin/link/child',tarfile.REGTYPE,b'bad',None)),('duplicate',('sdk/lib/original.txt',tarfile.REGTYPE,b'bad',None))]:
   path,row=self.archive(extra=extra)
   with self.subTest(case=label),self.assertRaises(ValueError):m.prepare({'sdk':path},[row],self.root/'prepared')
   self.assertFalse((self.root/'prepared').exists())
 def test_missing_and_cyclic_link_targets_refuse_before_copy(self):
  for target in ['absent','cycle']:
   path,row=self.archive(extra=('sdk/bin/cycle',tarfile.SYMTYPE,b'',target))
   with self.subTest(target=target),self.assertRaisesRegex(ValueError,'Missing/cyclic'):m.plan({'sdk':path},[row])
 def test_overlapping_original_component_files_are_refused(self):
  first,row=self.archive('first',component='rustc');second,other=self.archive('second',component='std')
  # Same parent directories may merge; original file collisions remain refused.
  with self.assertRaisesRegex(ValueError,'Overlapping'):m.plan({'first':first,'second':second},[row,other])
 def test_compatible_component_directories_merge_without_losing_original_payloads(self):
  first,row=self.archive('first',component='rustc');second,other=self.archive('second',component='std')
  # Give the std component its own original tool/data paths while preserving common directories.
  with tarfile.open(second,'r:gz') as source:members=[(member,source.extractfile(member).read() if member.isfile() else b'') for member in source]
  with tarfile.open(second,'w:gz') as target:
   for member,body in members:
    if member.name.endswith('/original.txt'):member.name=member.name[:-12]+'stdlib.txt'
    if member.name.endswith('/tool'):member.name=member.name[:-4]+'stdtool'
    if member.name.endswith('/link'):member.name=member.name[:-4]+'stdlink';member.linkname='stdtool'
    target.addfile(member,io.BytesIO(body) if member.isfile() else None)
  other.update(bytes=second.stat().st_size,sha256=m.digest(second));m.prepare({'first':first,'second':second},[row,other],self.root/'prepared');prefix=self.root/'prepared/runtime'
  self.assertEqual((prefix/'bin/tool').read_bytes(),b'inert synthetic executable');self.assertEqual((prefix/'bin/stdtool').read_bytes(),b'inert synthetic executable');self.assertEqual((prefix/'bin/stdlink').resolve(),prefix/'bin/stdtool');self.assertTrue((prefix/'lib/original.txt').is_file());self.assertTrue((prefix/'lib/stdlib.txt').is_file())
 def test_original_cargo_checksum_file_is_derived_from_preserved_payload_bytes(self):
  path,row=self.archive(with_link=False);row['cargoPackageChecksum']='a'*64;result=m.prepare({'sdk':path},[row],self.root/'prepared');checksum=json.loads((self.root/'prepared/runtime/.cargo-checksum.json').read_text());self.assertEqual(checksum['package'],'a'*64);self.assertEqual(checksum['files']['lib/original.txt'],hashlib.sha256(b'original synthetic SDK bytes').hexdigest());self.assertNotIn('bin/link',checksum['files'])
 def test_all_public_controls_run_with_a_locked_carrier_without_writes(self):
  self.assertNotEqual(os.geteuid(),0,'Effective readonly-carrier proof requires the ordinary nonroot CI control user')
  carrier=self.root/'locked-carrier';carrier.mkdir();scratch=self.root/'independent-system-temp';scratch.mkdir();cohort=json.loads((HERE/'COHORT.json').read_bytes())
  for row in cohort:
   source=HERE/row['file'];self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),row['sha256']);target=carrier/row['file'];target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);target.chmod(0o444)
  shutil.copyfile(HERE/'COHORT.json',carrier/'COHORT.json');(carrier/'COHORT.json').chmod(0o444)
  for directory in sorted([x for x in carrier.rglob('*') if x.is_dir()],key=lambda x:-len(x.parts)):directory.chmod(0o555)
  carrier.chmod(0o555)
  def snapshot():return [{'path':x.relative_to(carrier).as_posix(),'mode':stat.S_IMODE(x.lstat().st_mode),'sha256':hashlib.sha256(x.read_bytes()).hexdigest() if x.is_file() else None} for x in sorted(carrier.rglob('*'))]
  before=snapshot()
  try:
   with self.assertRaises(PermissionError):(carrier/'unpermitted-write').write_bytes(b'guard must be armed')
   tests=[name for name in unittest.defaultTestLoader.getTestCaseNames(Controls) if name!='test_all_public_controls_run_with_a_locked_carrier_without_writes']
   commands=[['test-materializer.py',*['Controls.'+name for name in tests]],['test-native-controller.py'],['test-encrypted-capture.py']]
   commands.extend([[name] for name in ['test-lifecycle.py', 'test-common-lifecycle.py', 'test-lifecycle-regression.py', 'test-common-lifecycle-regression.py']])
   for command in commands:
    result=subprocess.run([sys.executable,'-I','-S','-B',str(carrier/command[0]),*command[1:]],cwd=self.root,env={**os.environ,'TMPDIR':str(scratch)},capture_output=True,timeout=90)
    self.assertEqual(result.returncode,0,'Locked '+command[0]+' must succeed without carrier writes:\n'+(result.stdout+result.stderr).decode(errors='replace'))
   self.assertEqual(snapshot(),before);self.assertFalse((carrier/'unpermitted-write').exists())
  finally:
   # Only the synthetic copied fixture is made removable; actual HERE is untouched.
   for directory in [carrier,*[x for x in carrier.rglob('*') if x.is_dir()]]:directory.chmod(0o700)
 def test_existing_destination_is_preserved(self):
  path,row=self.archive();target=self.root/'prepared';target.mkdir();(target/'original').write_bytes(b'preserve')
  with self.assertRaisesRegex(ValueError,'Fresh'):m.prepare({'sdk':path},[row],target)
  self.assertEqual((target/'original').read_bytes(),b'preserve')
if __name__=='__main__':unittest.main(verbosity=2)
