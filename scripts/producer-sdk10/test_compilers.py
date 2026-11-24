"""Synthetic proc metadata and first-party inert files; no compiler executes."""
import hashlib,io,json,os,sys,tempfile,time,types,unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import common,driver

class CompilerControls(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-compiler-synthetic-');self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def test_native_whole_identifier_family_includes_versions_triplets_and_cc1plus(self):
  for name in ['clang','clang-20','clang++-20.1','gcc-14','g++-14','cc1','cc1plus','ilc','aarch64-linux-musl-gcc-14','x86_64-linux-gnu-g++-13','x86_64-pc-linux-gnu-gcc']:
   with self.subTest(name=name):row=driver.compiler_invocation('/synthetic/'+name,[name]);self.assertEqual(row['kind'],'native-compiler-executable');self.assertFalse(row['compilerVersionInferredFromNameOrArguments'])
 def test_ordinary_commands_keyword_arguments_and_prefix_suffix_near_misses_are_not_compilers(self):
  for executable,argv in [('bash',['bash','-c','echo gcc clang-20 csc.dll']),('grep',['grep','csc.dll']),('notclang-20',['notclang-20']),('gcc-wrapper',['gcc-wrapper']),('clang-tidy',['clang-tidy']),('cc1plus-helper',['cc1plus-helper']),('my-ilc',['my-ilc']),('dotnet-tool',['dotnet-tool','csc.dll'])]:
   with self.subTest(executable=executable):self.assertIsNone(driver.compiler_invocation('/synthetic/'+executable,argv))
 def test_managed_application_position_and_supported_host_options_are_exact(self):
  rows=[['dotnet','exec','--runtimeconfig','runtime.json','--depsfile=dependencies.json','/sdk/csc.dll','/noconfig'],['dotnet','/sdk/fsc.dll'],['dotnet','exec','--','/sdk/ilc.dll'],['corerun','/sdk/csc.dll']]
  for argv in rows:
   with self.subTest(argv=argv):role=driver.compiler_invocation('/synthetic/'+argv[0],argv);self.assertEqual(role['kind'],'managed-compiler-in-runtime-host');self.assertFalse(role['compilerVersionInferredFromNameOrArguments'])
  for argv in [['dotnet','build','csc.dll'],['dotnet','tool.dll','csc.dll'],['dotnet','exec','--unknown','csc.dll'],['dotnet','exec','--depsfile'],['dotnet','exec','--depsfile=','csc.dll'],['dotnet','exec','not-csc.dll'],['corerun','other.dll','fsc.dll']]:
   with self.subTest(argv=argv):self.assertIsNone(driver.compiler_invocation('/synthetic/'+argv[0],argv))
 def proc(self,executable='dotnet',argv=None,mapped=True):
  proc=self.root/'proc';proc.mkdir();binary=self.root/executable;binary.write_bytes(b'inert synthetic runtime or compiler executable');(proc/'exe').symlink_to(binary);(proc/'fd').mkdir();(proc/'root/sdk').mkdir(parents=True);(proc/'cwd').symlink_to(proc/'root/sdk',target_is_directory=True);assembly=proc/'root/sdk/csc.dll';assembly.write_bytes(b'distinct inert synthetic compiler assembly');s=assembly.stat();maps='1000-2000 r--p 00000000 '+format(os.major(s.st_dev),'x')+':'+format(os.minor(s.st_dev),'x')+' '+str(s.st_ino)+' /sdk/csc.dll\n' if mapped else ''
  (proc/'maps').write_text(maps);(proc/'cmdline').write_bytes(b'\0'.join(x.encode() for x in (argv or [executable,'/sdk/csc.dll']))+b'\0');(proc/'stat').write_text('222 (synthetic process name) '+' '.join(['S']+['0']*18+['12345']+['0']*5));return proc,binary,assembly
 def test_managed_physical_assembly_is_distinct_from_host_and_mapping_binds_actual_inode(self):
  proc,binary,assembly=self.proc();row=driver.compiler_assembly_identity(proc,'/sdk/csc.dll');self.assertTrue(row['actualAssemblyMappedInObservedProcess']);self.assertEqual(row['physicalIdentity']['sha256'],hashlib.sha256(assembly.read_bytes()).hexdigest());self.assertNotEqual(row['physicalIdentity']['sha256'],hashlib.sha256(binary.read_bytes()).hexdigest());self.assertFalse(row['compilerAssemblyVersionInferred'])
  relative=driver.compiler_assembly_identity(proc,'csc.dll');self.assertTrue(relative['actualAssemblyMappedInObservedProcess'])
 def test_unavailable_unmapped_or_foreign_inode_assembly_stays_explicitly_unassessed(self):
  proc,binary,assembly=self.proc(mapped=False);row=driver.compiler_assembly_identity(proc,'/sdk/csc.dll');self.assertFalse(row['actualAssemblyMappedInObservedProcess']);self.assertIn('physicalIdentity',row)
  (proc/'maps').write_text('1000-2000 r--p 0 00:00 999 /sdk/csc.dll\n');self.assertFalse(driver.compiler_assembly_identity(proc,'/sdk/csc.dll')['actualAssemblyMappedInObservedProcess']);assembly.unlink();row=driver.compiler_assembly_identity(proc,'/sdk/csc.dll');self.assertEqual(row['state'],'UNASSESSED');self.assertNotIn('physicalIdentity',row)
 def sample(self,proc):
  c=object.__new__(driver.Controller);c.state={};path=self.root/'docker-top';path.write_text('PID PPID COMMAND ARGS\n222 1 forged-comm a human display mentioning gcc csc.dll\n');n,h=common.hash_file(path);c.docker=lambda *a,**kw:({'exitCode':0,'stdoutBytes':n,'stdoutSHA256':h},path);seen={};events=io.StringIO()
  with mock.patch.object(driver,'process_directory',return_value=proc):c.compiler_processes('owned-synthetic',seen,{},events)
  return seen,[json.loads(x) for x in events.getvalue().splitlines()]
 def test_real_observer_does_not_turn_bash_keyword_display_into_compiler_evidence(self):
  proc,binary,assembly=self.proc(executable='bash',argv=['bash','-c','echo gcc csc.dll']);seen,events=self.sample(proc);self.assertEqual(seen,{});self.assertEqual(events,[])
 def test_real_observer_binds_native_executable_and_managed_host_assembly_roles(self):
  proc,binary,assembly=self.proc();seen,events=self.sample(proc);self.assertEqual(list(seen.values()),[True]);self.assertEqual(events[0]['executableIdentityRole'],'managed-runtime-host');self.assertIsNone(events[0]['actualCompilerExecutableSHA256']);self.assertTrue(events[0]['compilerAssemblyIdentity']['actualAssemblyMappedInObservedProcess']);self.assertEqual(events[0]['actualExecutableSHA256'],common.hash_file(binary)[1]);self.assertEqual(events[0]['compilerAssemblyIdentity']['physicalIdentity']['sha256'],common.hash_file(assembly)[1])
 def test_real_observer_retains_unmapped_managed_invocation_without_actual_compiler_credit(self):
  proc,binary,assembly=self.proc(mapped=False);seen,events=self.sample(proc);self.assertEqual(list(seen.values()),[False]);self.assertFalse(events[0]['actualSourceCompilerProcessObserved']);self.assertEqual(events[0]['compilerAssemblyIdentity']['state'],'PHYSICAL_ARGUMENT_BOUND_MAPPING_UNASSESSED')
 def test_real_native_observer_hashes_actual_compiler_executable_and_never_uses_display_comm(self):
  proc,binary,assembly=self.proc(executable='clang-20',argv=['clang-20','-c','synthetic.c']);seen,events=self.sample(proc);self.assertEqual(list(seen.values()),[True]);self.assertEqual(events[0]['executableIdentityRole'],'compiler-executable');self.assertIsNone(events[0]['compilerAssemblyIdentity']);self.assertEqual(events[0]['actualCompilerExecutableSHA256'],common.hash_file(binary)[1])
 def test_managed_assembly_changed_after_mapping_snapshot_gets_no_actual_compiler_credit(self):
  proc,binary,assembly=self.proc();real=driver.file_identity;calls=[]
  def changing(*a,**kw):
   row=real(*a,**kw);calls.append(row)
   if len(calls)==2:row={**row,'sha256':'0'*64}
   return row
  with mock.patch.object(driver,'file_identity',side_effect=changing):row=driver.compiler_assembly_identity(proc,'/sdk/csc.dll')
  self.assertFalse(row['actualAssemblyMappedInObservedProcess']);self.assertEqual(row['state'],'PHYSICAL_ARGUMENT_BOUND_MAPPING_UNASSESSED')
 def test_final_executable_physical_stamp_change_prevents_compiler_event_even_with_same_display_path(self):
  proc,binary,assembly=self.proc(executable='clang-20',argv=['clang-20','-c','synthetic.c']);real=Path.stat;calls=[]
  def changing(path,*a,**kw):
   result=real(path,*a,**kw)
   if path==proc/'exe':
    calls.append(True)
    if len(calls)==3:return types.SimpleNamespace(st_dev=result.st_dev,st_ino=result.st_ino+1,st_size=result.st_size,st_mtime_ns=result.st_mtime_ns,st_ctime_ns=result.st_ctime_ns)
   return result
  with mock.patch.object(Path,'stat',changing):seen,events=self.sample(proc)
  self.assertEqual(seen,{});self.assertEqual(events,[]);self.assertEqual(len(calls),3)

 def sampler(self,proc):
  # Repeated docker-top samples of one live process share seen/events, as
  # successive iterations of the native polling loop do.
  c=object.__new__(driver.Controller);c.state={};seen={};events=io.StringIO();path=self.root/'docker-top'
  def docker(*a,**kw):
   path.write_text('PID PPID COMMAND ARGS\n222 1 forged-comm a human display mentioning gcc csc.dll\n');n,h=common.hash_file(path);return {'exitCode':0,'stdoutBytes':n,'stdoutSHA256':h},path
  c.docker=docker
  def sample():
   with mock.patch.object(driver,'process_directory',return_value=proc):c.compiler_processes('owned-synthetic',seen,{},events)
   return seen,[json.loads(x) for x in events.getvalue().splitlines()]
  return sample
 def map_assembly(self,proc,assembly):
  s=assembly.stat();(proc/'maps').write_text('1000-2000 r--p 00000000 '+format(os.major(s.st_dev),'x')+':'+format(os.minor(s.st_dev),'x')+' '+str(s.st_ino)+' /sdk/csc.dll\n')
 def test_managed_host_sampled_before_its_assembly_mapping_qualifies_on_a_later_sample(self):
  proc,binary,assembly=self.proc(mapped=False);sample=self.sampler(proc)
  seen,events=sample();self.assertEqual(seen,{(222,'12345'):False});self.assertEqual([x['actualSourceCompilerProcessObserved'] for x in events],[False])
  self.map_assembly(proc,assembly);seen,events=sample()
  self.assertEqual(seen,{(222,'12345'):True});self.assertEqual([(x['pid'],x['processStartTicks'],x['actualSourceCompilerProcessObserved']) for x in events],[(222,'12345',False),(222,'12345',True)])
  self.assertEqual(events[1]['compilerAssemblyIdentity']['physicalIdentity']['sha256'],common.hash_file(assembly)[1])
 def test_managed_host_never_mapped_stays_unqualified_and_is_recorded_once(self):
  proc,binary,assembly=self.proc(mapped=False);sample=self.sampler(proc)
  for _ in range(3):seen,events=sample()
  self.assertEqual(seen,{(222,'12345'):False});self.assertEqual([x['actualSourceCompilerProcessObserved'] for x in events],[False])
 def test_qualified_identity_is_neither_reexamined_nor_recounted(self):
  proc,binary,assembly=self.proc();sample=self.sampler(proc)
  with mock.patch.object(driver,'compiler_assembly_identity',wraps=driver.compiler_assembly_identity) as examined:
   for _ in range(3):seen,events=sample()
  self.assertEqual(examined.call_count,1);self.assertEqual(seen,{(222,'12345'):True});self.assertEqual([x['actualSourceCompilerProcessObserved'] for x in events],[True])

if __name__=='__main__':unittest.main(verbosity=2)
