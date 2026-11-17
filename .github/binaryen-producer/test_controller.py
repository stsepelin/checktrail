"""Synthetic fixtures only. No upstream materialization, sudo or compiler runs."""
import contextlib,copy,errno,gzip,hashlib,importlib.util,io,json,os,shutil,stat,struct,sys,tarfile,tempfile,types,unittest,uuid,zlib
from pathlib import Path
from unittest import mock

HERE=Path(__file__).parent.resolve()
sys.path.insert(0,str(HERE))
import capsule as c
import controller as n
import prepare_capsule as p

def fixture():
 objects={};roots=[];expected=[]
 def pin(body):objects[c.sha(body)]=body;return {'bytes':len(body),'sha256':c.sha(body)}
 mounts=['.','modules/a','modules/b','modules/c','modules/d','modules/e','modules/f','modules/f/nested']
 for index in reversed(range(8)):
  files=[{'path':'LICENSE','mode':'100644','gitBlob':c.git_hash('blob',b'Original synthetic notice\n'),'body':pin(b'Original synthetic notice\n')},
         {'path':'bin/control','mode':'100755','gitBlob':c.git_hash('blob',b'inert bytes'),'body':pin(b'inert bytes')},
         {'path':'logical-link','mode':'120000','gitBlob':c.git_hash('blob',b'../../outside'),'body':pin(b'../../outside')}]
  links=[]
  if index==0:links=[{'path':mounts[x],'commit':roots[7-x]['commit']} for x in range(1,7)]
  elif index==6:links=[{'path':'nested','commit':roots[0]['commit']}]
  if links:
   modules=''
   for link in links:
    global_mount=link['path'] if index==0 else mounts[index]+'/'+link['path'];child_index=mounts.index(global_mount)
    modules+='[submodule "'+link['path']+'"]\n path = '+link['path']+'\n url = https://github.com/synthetic/source'+str(child_index)+'\n'
   body=modules.encode();files.append({'path':'.gitmodules','mode':'100644','gitBlob':c.git_hash('blob',body),'body':pin(body)})
  root={'id':'synthetic-'+str(index),'mountPath':mounts[index],'repository':'synthetic/source'+str(index),'commit':'0'*40,'tree':'0'*40,'rawCommit':{},'files':files,'gitlinks':links,'notices':[{'path':'LICENSE','body':files[0]['body']}]}
  # Independent fixture encoder; production's root check is not its oracle.
  entries={}
  for row in files:entries[row['path']]=(row['mode'],row['gitBlob'])
  for row in links:entries[row['path']]=('160000',row['commit'])
  for path in list(entries):
   parent=path.rpartition('/')[0]
   while parent:entries.setdefault(parent,('040000',None));parent=parent.rpartition('/')[0]
  child={}
  for path,(mode,sha) in entries.items():parent,_,leaf=path.rpartition('/');child.setdefault(parent,[]).append((leaf,path,mode,sha))
  treeids={}
  for directory in sorted({'',*child.keys()},key=lambda p:(-p.count('/'),-len(p))):
   body=b''
   for leaf,path,mode,identity in sorted(child.get(directory,[]),key=lambda x:x[0].encode()+(b'/' if x[2]=='040000' else b'')):
    body+=mode.lstrip('0').encode()+b' '+leaf.encode()+b'\0'+bytes.fromhex(treeids[path] if mode=='040000' else identity)
   treeids[directory]=hashlib.sha1(b'tree '+str(len(body)).encode()+b'\0'+body).hexdigest()
  root['tree']=treeids[''];raw=('tree '+root['tree']+'\nauthor Synthetic <fixture@example.invalid> 1 +0000\ncommitter Synthetic <fixture@example.invalid> 1 +0000\n\nOriginal synthetic commit '+str(index)+'\n').encode()
  root['rawCommit']=pin(raw);root['commit']=c.git_hash('commit',raw);roots.append(root)
 roots.reverse();expected=[(r['id'],r['mountPath'],r['repository'],r['commit']) for r in roots]
 return {'schemaVersion':1,'selection':c.SELECTION,'roots':roots,'evidence':[]},objects,expected

def archive(manifest,objects,extra=()):
 buffer=io.BytesIO()
 with tarfile.open(fileobj=buffer,mode='w',format=tarfile.USTAR_FORMAT) as tar:
  for name,body in [('manifest.json',json.dumps(manifest).encode())]+[('objects/'+k,v) for k,v in objects.items()]+list(extra):
   item=tarfile.TarInfo(name);item.size=len(body);item.mode=0o400;tar.addfile(item,io.BytesIO(body))
 return gzip.compress(buffer.getvalue(),mtime=0)

class CapsuleTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='synthetic-',dir=HERE);self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def test_eight_roots_exact_gitlinks_blobs_notices_and_raw_commits(self):
  m,o,e=fixture();facts=c.validate_manifest(m,o,e)
  self.assertEqual((facts['roots'],facts['files']),(8,26));self.assertEqual(len(facts['gitTrees']),8)
  for index,root in enumerate(m['roots']):self.assertIn(root['tree'],facts['gitTrees'][root['id']])
 def test_missing_foreign_nested_and_changed_source_refuse(self):
  m,o,e=fixture()
  for change,label in [(lambda x:x['roots'].pop(),'Missing selected source root'),(lambda x:x['roots'][6]['gitlinks'][0].update(commit='f'*40),'Canonical source tree differs'),(lambda x:x['roots'][1]['files'][1].update(gitBlob='f'*40),'Canonical source blob differs'),(lambda x:x['roots'][3].update(rawCommit=x['roots'][2]['rawCommit']),'Raw commit identity/tree differs')]:
   bad=copy.deepcopy(m);change(bad)
   with self.subTest(label=label),self.assertRaisesRegex(ValueError,label):c.validate_manifest(bad,o,e)
 def test_duplicate_case_alias_notice_and_path_refuse_before_writes(self):
  m,o,e=fixture()
  for change in [lambda x:x['roots'][0]['files'].append(copy.deepcopy(x['roots'][0]['files'][0])),lambda x:x['roots'][1]['files'][1].update(path='../outside'),lambda x:x['roots'][2].update(notices=[]),lambda x:x['roots'][3]['notices'][0].update(body=x['roots'][3]['files'][1]['body'])]:
   bad=copy.deepcopy(m);change(bad)
   with self.assertRaises(ValueError):c.validate_manifest(bad,o,e)
  self.assertEqual(list(self.root.iterdir()),[])
 def test_capsule_binds_wire_bytes_and_rejects_duplicate_traversal_or_changed_objects(self):
  m,o,e=fixture();good=archive(m,o);path=self.root/'capsule.gz';path.write_bytes(good)
  parsed,_,facts=c.load_capsule(path,c.sha(good),len(good),e);self.assertEqual(facts['roots'],8)
  with self.assertRaisesRegex(ValueError,'Capsule wire identity'):c.load_capsule(path,'0'*64,len(good),e)
  for extra in [[('manifest.json',b'{}')],[('../outside',b'x')],[('objects/'+'a'*64,b'wrong')]]:
   bad=archive(m,o,extra);path.write_bytes(bad)
   with self.assertRaises(ValueError):c.load_capsule(path,c.sha(bad),len(bad),e)
  self.assertFalse((self.root.parent/'outside').exists())
 def test_materializer_stages_exact_modes_symlinks_objects_and_shallow_tag(self):
  m,o,e=fixture();facts=c.validate_manifest(m,o,e);control=self.root/'control';control.mkdir();(control/'empty-home').mkdir();(control/'empty-hooks').mkdir();calls=[]
  result=c.materialize(m,o,facts,self.root/'source','/synthetic/git',lambda args,**kw:calls.append((args,kw)),control,e)
  self.assertEqual(result['roots'],8);self.assertEqual(len(calls),8)
  source=self.root/'source';self.assertEqual((source/'logical-link').readlink(),Path('../../outside'));self.assertEqual(stat.S_IMODE((source/'bin/control').stat().st_mode),0o755)
  self.assertFalse((self.root/'.source.next').exists());self.assertEqual((source/'.git/refs/tags/version_132').read_text(),m['roots'][0]['commit']+'\n')
  self.assertEqual((source/'.git/shallow').read_text(),m['roots'][0]['commit']+'\n')
  for root in m['roots']:
   repo=source/'.git' if root['mountPath']=='.' else source/'.git/modules'/root['mountPath']
   raw=zlib.decompress((repo/'objects'/root['commit'][:2]/root['commit'][2:]).read_bytes())
   self.assertEqual(hashlib.sha1(raw).hexdigest(),root['commit']);self.assertIn('hooksPath = '+str(control/'empty-hooks'),(repo/'config').read_text())
  for args,options in calls:
   self.assertEqual(args[0],'/synthetic/git');self.assertEqual(args[-3:],['read-tree','--reset','HEAD']);self.assertEqual(options['env']['GIT_CONFIG_GLOBAL'],'/dev/null')
 def test_failed_index_preparation_never_publishes_source_destination(self):
  m,o,e=fixture();facts=c.validate_manifest(m,o,e);control=self.root/'control';control.mkdir();calls=[]
  def failing(args,**kw):calls.append(args);raise ValueError('synthetic index failure')
  with self.assertRaisesRegex(ValueError,'synthetic index failure'):c.materialize(m,o,facts,self.root/'source','/synthetic/git',failing,control,e)
  self.assertFalse((self.root/'source').exists());self.assertTrue((self.root/'.source.next').is_dir());self.assertEqual(len(calls),1)
 def captured(self):
  m,o,e=fixture();parent=self.root/'parent';nested=self.root/'nested';raw=self.root/'raw';raw.mkdir()
  pins=[{'file':'objects/'+identity,'bytes':len(body),'sha256':identity} for identity,body in o.items()]
  for base in [parent,nested]:
   (base/'objects').mkdir(parents=True)
   for identity,body in o.items():(base/'objects'/identity).write_bytes(body)
  for root in m['roots']:(raw/(root['commit']+'.raw')).write_bytes(o[root['rawCommit']['sha256']])
  def body(pin):return {'file':'objects/'+pin['sha256'],**pin}
  def captured(root):return {'id':root['id'],'mountPath':root['mountPath'],'repository':root['repository'],'commit':root['commit'],'declaredRootTree':root['tree'],'retainedOrdinaryBodyIndex':[{'path':x['path'],'mode':x['mode'],'gitBlob':x['gitBlob'],'retained':body(x['body'])} for x in root['files']],'noticePathAndBodyIndex':[{'path':x['path'],'body':body(x['body'])} for x in root['notices']],'typedGitlinkInventory':root['gitlinks']}
  parent_record={'state':'seven-root-custody-verified-not-producer-complete','independentRetainedReread':{'allRehashed':True},'retainedObjectPins':pins,'sources':[captured(x) for x in m['roots'][:-1]]};pb=json.dumps(parent_record).encode();(parent/'TERMINAL.json').write_bytes(pb)
  last=captured(m['roots'][-1]);nested_record={'wholeTreeRecomputed':True,'independentRetainedReread':{'allRehashed':True},'nestedGitlinks':[],'binding':{'commit':e[-1][3],'path':'nested','parentTerminalSHA256':c.sha(pb)},'rootTree':last['declaredRootTree'],'retainedOrdinaryBodyIndex':last['retainedOrdinaryBodyIndex'],'originalNoticeCandidates':last['noticePathAndBodyIndex'],'retainedObjectPins':pins};(nested/'TERMINAL.json').write_text(json.dumps(nested_record))
  return m,o,e,parent,nested,raw
 def test_data_only_adapter_validates_entire_cohort_then_publishes_capsule_and_receipt_together(self):
  m,o,e,parent,nested,raw=self.captured();output=self.root/'capsule'
  receipt=p.prepare(parent,nested,raw,output,e)
  self.assertEqual((receipt['roots'],receipt['ordinaryFiles']),(8,26));self.assertFalse(receipt['sourceExtracted']);self.assertFalse(receipt['producerExecuted'])
  wire=receipt['capsule'];parsed,objects,facts=c.load_capsule(output/wire['file'],wire['sha256'],wire['bytes'],e)
  self.assertEqual(facts['roots'],8);self.assertEqual(parsed['roots'],m['roots']);self.assertTrue((output/'CAPSULE.json').is_file());self.assertFalse((self.root/'.capsule.next').exists())
 def test_missing_raw_object_or_late_publication_failure_publishes_no_output(self):
  m,o,e,parent,nested,raw=self.captured();missing=raw/(e[-1][3]+'.raw');retained=missing.read_bytes();missing.unlink()
  with self.assertRaises(FileNotFoundError):p.prepare(parent,nested,raw,self.root/'capsule',e)
  self.assertFalse((self.root/'capsule').exists());self.assertFalse((self.root/'.capsule.next').exists());missing.write_bytes(retained)
  with mock.patch.object(p.os,'rename',side_effect=OSError('synthetic publish failure')),self.assertRaisesRegex(OSError,'synthetic publish failure'):p.prepare(parent,nested,raw,self.root/'capsule',e)
  self.assertFalse((self.root/'capsule').exists());self.assertTrue((self.root/'.capsule.next/CAPSULE.json').is_file())

class NativeContractTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='synthetic-',dir=HERE);self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def cache(self):
  source=self.root/'source';sdk=self.root/'sdk';tools={'clang':{'path':'/synthetic/clang'},'cc-shim':{'path':'/synthetic/cc'},'clang++':{'path':'/synthetic/clang++'},'cxx-shim':{'path':'/synthetic/c++'}}
  values={'BUILD_TESTS':'ON','BUILD_FUZZTEST':'OFF','CMAKE_BUILD_TYPE':'Release','CMAKE_C_COMPILER':'/synthetic/clang','CMAKE_CXX_COMPILER':'/synthetic/clang++','CMAKE_OSX_SYSROOT':str(sdk),'CMAKE_OSX_ARCHITECTURES':'arm64','CMAKE_OSX_DEPLOYMENT_TARGET':'10.15','CMAKE_INSTALL_PREFIX':str(source/'out-arm64/install')}
  return source,{'sdk':str(sdk),'tools':tools},values
 def test_cmake_actual_defaults_arch_sysroot_and_driver_boundaries(self):
  source,host,values=self.cache();text=lambda v:'\n'.join(k+':STRING='+value for k,value in v.items())
  self.assertEqual(n.validate_cache(text(values),source,host),values)
  for key,value in [('BUILD_TESTS','OFF'),('BUILD_FUZZTEST','ON'),('CMAKE_BUILD_TYPE','Debug'),('CMAKE_OSX_ARCHITECTURES','arm64e'),('CMAKE_OSX_DEPLOYMENT_TARGET','11.0'),('CMAKE_OSX_SYSROOT','/foreign/sdk'),('CMAKE_C_COMPILER','/project/custom-driver'),('CMAKE_INSTALL_PREFIX','/outside')]:
   bad={**values,key:value}
   with self.subTest(key=key),self.assertRaises(ValueError):n.validate_cache(text(bad),source,host)
  with self.assertRaisesRegex(ValueError,'Duplicate CMake'):n.validate_cache(text(values)+'\nBUILD_TESTS:BOOL=OFF',source,host)
 def test_native_arm64_output_parser_retains_actual_sdk_without_execution(self):
  command=struct.pack('<IIIIII',0x32,24,1,11<<16,(15<<16)+(5<<8),0)
  header=struct.pack('<IiiIIIII',0xfeedfacf,0x0100000c,0,2,1,len(command),0,0)
  p=self.root/'native';p.write_bytes(header+command)
  result=n.macho_identity(p,2);self.assertFalse(result['binaryExecuted']);self.assertEqual(result['buildVersion']['sdk'],(15<<16)+(5<<8))
  for body in [struct.pack('<IiiIIIII',0xfeedfacf,0x01000007,0,2,1,len(command),0,0)+command,header+command[:-1],header+struct.pack('<IIIIII',0x32,24,2,0,0,0)]:
   p.write_bytes(body)
   with self.assertRaises(ValueError):n.macho_identity(p,2)
 def test_output_freeze_refuses_world_write_external_symlinks_and_hardlinks_before_chown(self):
  out=self.root/'out';out.mkdir();p=out/'item';p.write_bytes(b'inert');calls=[]
  with mock.patch.object(n.os,'chown',lambda *a:calls.append(a)),mock.patch.object(n.os,'lchown',lambda *a:calls.append(a)):
   p.chmod(0o666)
   with self.assertRaisesRegex(ValueError,'World-writable'):n.freeze_output(out,os.getuid())
   self.assertEqual(calls,[]);p.chmod(0o644)
   outside=self.root/'outside';outside.write_bytes(b'other');(out/'link').symlink_to(outside)
   with self.assertRaisesRegex(ValueError,'symlink escaped'):n.freeze_output(out,os.getuid())
   self.assertEqual(calls,[]);(out/'link').unlink();os.link(p,out/'hardlink')
   with self.assertRaisesRegex(ValueError,'hardlinked'):n.freeze_output(out,os.getuid())
   self.assertEqual(calls,[])
 def test_native_resource_limits_are_exact_not_global_test_side_effects(self):
  calls=[]
  with mock.patch.object(n.os,'umask',lambda v:calls.append(('umask',v))),mock.patch.object(n.resource,'setrlimit',lambda k,v:calls.append((k,v))):n.child_limits()
  self.assertEqual(calls,[('umask',0o022),(n.resource.RLIMIT_NOFILE,(256,256)),(n.resource.RLIMIT_NPROC,(256,256)),(n.resource.RLIMIT_FSIZE,(n.GIB,n.GIB)),(n.resource.RLIMIT_CPU,(12000,12000))])
 def run_native(self,code,seconds=2,limit=None):
  work=self.root/('work'+str(len(list(self.root.iterdir()))));work.mkdir();(work/'capture').mkdir()
  with mock.patch.object(n,'ps_rows',lambda:[]),mock.patch.object(n,'child_limits',lambda:None),mock.patch.dict(n.LIMITS,{'minimumFreeBytes':0,**({'logBytes':limit} if limit is not None else {})}):
   native=n.Native(work,{'buildUid':65533})
   try:result=native.run('synthetic',[sys.executable,'-I','-c',code],dict(os.environ),work,seconds,as_build=False)
   except Exception as e:return e,native,work
  return result,native,work
 def test_real_trusted_fixture_exit_failure_timeout_and_log_bounds(self):
  result,native,work=self.run_native("print('first-party synthetic fixture')")
  self.assertTrue(result['success']);self.assertEqual((work/'capture/synthetic.log').read_bytes(),b'first-party synthetic fixture\n')
  error,native,work=self.run_native("raise SystemExit(7)");self.assertIsInstance(error,ValueError);self.assertEqual(native.receipts[0]['exitCode'],7);self.assertFalse(native.receipts[0]['success'])
  error,native,work=self.run_native("import time; time.sleep(60)",0.03);self.assertIsInstance(error,ValueError);self.assertFalse(native.receipts[0]['success']);self.assertEqual(native.receipts[0]['unreapedBuildUidProcesses'],[])
  error,native,work=self.run_native("print('x'*100)",2,16);self.assertIsInstance(error,ValueError);self.assertFalse(native.receipts[0]['success']);self.assertEqual((work/'capture/synthetic.log').read_bytes(),b'x'*16)
  error,native,work=self.run_native("import os,time;os.close(1);os.close(2);time.sleep(.1)",0.03);self.assertIsInstance(error,ValueError);self.assertFalse(native.receipts[0]['success'])
 def test_original_commands_keep_defaults_and_static_pack_ownership_difference_explicit(self):
  self.assertEqual(n.CONFIGURE,['-S','.','-B','out-arm64','-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX=out-arm64/install','-DCMAKE_OSX_ARCHITECTURES=arm64'])
  self.assertEqual(n.BUILD,['--build','out-arm64','-v','--config','Release','--target','install'])
  self.assertIn('rm -rf binaryen-$VERSION\nmv out-arm64/install binaryen-$VERSION',n.PACK)
  self.assertNotIn('ctest',n.PACK);self.assertNotIn('--parallel',n.BUILD)
 def test_pack_entire_external_family_resolves_to_admitted_physical_tools_without_execution(self):
  tools={};folder=self.root/'stock-bin';folder.mkdir()
  for name in ['rm','mv','tar','sed','cmake']:
   path=folder/name;path.write_bytes(('inert synthetic '+name).encode());path.chmod(0o755);tools[name]=n.physical_file(path)
  actual=n.verify_pack_tools({'tools':tools},{'PATH':str(folder)})
  self.assertEqual(set(actual),{'rm','mv','tar','sed','cmake'})
  self.assertTrue(all(actual[name]['physicalTool']==tools[name] for name in tools))
 def test_pack_foreign_path_changed_tools_and_missing_rm_or_mv_refuse(self):
  tools={};folder=self.root/'stock-bin';folder.mkdir();foreign=self.root/'foreign-bin';foreign.mkdir()
  for name in ['rm','mv','tar','sed','cmake']:
   path=folder/name;path.write_bytes(('inert synthetic '+name).encode());path.chmod(0o755);tools[name]=n.physical_file(path)
  for name in ['rm','mv']:
   with self.subTest(missingAdmission=name),self.assertRaisesRegex(ValueError,'not admitted'):n.verify_pack_tools({'tools':{k:v for k,v in tools.items() if k!=name}},{'PATH':str(folder)})
   path=folder/name;hidden=folder/(name+'-hidden');path.rename(hidden)
   with self.subTest(missingExecutable=name),self.assertRaisesRegex(ValueError,'unavailable'):n.verify_pack_tools({'tools':tools},{'PATH':str(folder)})
   hidden.rename(path)
  path=foreign/'rm';path.write_bytes((folder/'rm').read_bytes());path.chmod(0o755)
  with self.assertRaisesRegex(ValueError,'foreign physical tool'):n.verify_pack_tools({'tools':tools},{'PATH':str(foreign)+':'+str(folder)})
  (folder/'mv').write_bytes(b'changed admitted tool')
  with self.assertRaisesRegex(ValueError,'foreign physical tool'):n.verify_pack_tools({'tools':tools},{'PATH':str(folder)})
 def test_wrong_platform_refuses_before_stock_tool_or_source_calls(self):
  runner=mock.Mock()
  with mock.patch.object(n.platform,'system',lambda:'Linux'),self.assertRaisesRegex(ValueError,'Native Darwin x86_64'):n.host_admission({},runner)
  runner.assert_not_called()
 def test_darwin_negative_ps_uid_normalizes_to_native_uid_t_for_cleanup_and_rss(self):
  with mock.patch.object(n,'quick',lambda args:'123 1 123 -2 16 synthetic fixture\n124 1 124 501 8 other'):
   rows=n.ps_rows()
  self.assertEqual(rows[0]['uid'],4294967294);self.assertEqual(rows[1]['uid'],501)
 def test_permission_probe_program_requires_every_parent_and_each_replace_operation_to_be_denied(self):
  manifest,objects,expected=fixture();control=self.root/'control';control.mkdir();source=self.root/'source'
  c.materialize(manifest,objects,c.validate_manifest(manifest,objects,expected),source,'/synthetic/git',lambda *a,**kw:None,control,expected)
  host={'tools':{'python3':{'path':sys.executable}},'sdk':str(self.root/'sdk'),'developerDir':str(self.root/'developer'),'protectedWorkflowPaths':[],'buildUid':65533}
  payloads=[];operations=[];original_open=open
  class Probe:
   writable=False;allow_unlink=False;unreadable=False;write_target=None
   def run(inner,name,args,env,cwd,seconds):
    data=json.loads(Path(args[-1]).read_text());payloads.append(data);canaries=set(data['canaries'])
    def opening(path,*pos,**kw):
     if str(path) in canaries or str(path).endswith('.checktrail-write-guard.new'):
      operations.append(('write',str(path)));raise PermissionError(errno.EACCES,'synthetic deny')
     return original_open(path,*pos,**kw)
    def unlink(path):
     operations.append(('unlink',str(path)))
     if not inner.allow_unlink:raise PermissionError(errno.EACCES,'synthetic deny')
    def rename(before,after):operations.append(('rename',str(before)));raise PermissionError(errno.EACCES,'synthetic deny')
    def access(path,mode):return not inner.unreadable if mode==os.R_OK else inner.writable and str(path)==str(inner.write_target or source)
    with mock.patch('builtins.open',opening),mock.patch.object(n.os,'getuid',lambda:65533),mock.patch.object(n.os,'access',access),mock.patch.object(n.os,'unlink',unlink),mock.patch.object(n.os,'rename',rename),mock.patch.object(sys,'argv',['probe',args[-1]]),contextlib.redirect_stdout(io.StringIO()):exec(compile(args[-2],'<trusted-permission-probe>','exec'),{})
  probe=Probe();n.permission_admission(self.root,source,manifest,host,{},probe,[])
  self.assertEqual(len(payloads[-1]['canaries']),8);self.assertEqual(len(operations),32)
  self.assertIn(str(source/'modules'/'f'),payloads[-1]['paths'])
  self.assertFalse(list(source.rglob('.checktrail-write-guard')))
  probe.writable=True
  with self.assertRaisesRegex(AssertionError,'parent writable'):n.permission_admission(self.root,source,manifest,host,{},probe,[])
  probe.writable=False;probe.allow_unlink=True
  with self.assertRaisesRegex(AssertionError,'replacement/write unexpectedly permitted'):n.permission_admission(self.root,source,manifest,host,{},probe,[])
  probe.allow_unlink=False;probe.unreadable=True
  with self.assertRaisesRegex(AssertionError,'required source/request is unreadable'):n.permission_admission(self.root,source,manifest,host,{},probe,[])
  probe.unreadable=False;probe.writable=True
  for root in [host['sdk'],str(self.root/'cmake-modules'),str(self.root/'git-helper-root')]:
   probe.write_target=root
   with self.subTest(root=root),self.assertRaisesRegex(AssertionError,'parent writable'):n.permission_admission(self.root,source,manifest,host,{},probe,[{'root':root,'entries':[]}])
   self.assertIn(root,payloads[-1]['paths'])
 def test_cmake_actual_app_and_brew_reported_module_layouts_are_queried_without_guessing(self):
  for style,relative in [('app','CMake.app/Contents'),('brew','Cellar/cmake/4.4.5')]:
   installation=self.root/relative;tool=installation/'bin/cmake';tool.parent.mkdir(parents=True);tool.write_bytes(b'inert stock-tool identity');modules=installation/'actual-not-guessed-data/Modules';modules.mkdir(parents=True);record={};calls=[]
   def query(folder,name,args,env,**kwargs):
    calls.append((args,env,kwargs));self.assertEqual(Path(args[-1]).read_bytes(),b'message(STATUS "CHECKTRAIL_CMAKE_ROOT=${CMAKE_ROOT}")\n');self.assertEqual(args[:2],[str(tool),'-P']);self.assertEqual(kwargs['cwd'],folder);return 0,('-- CHECKTRAIL_CMAKE_ROOT='+str(modules.parent)+'\n').encode(),b''
   self.assertEqual(n.cmake_root_metadata({'path':str(tool)},record,query),modules.parent)
   self.assertEqual(len(calls),1);self.assertEqual(record['physicalRoot'],str(modules.parent));self.assertFalse(record['projectCompilerOrSdkExecuted'])
 def test_cmake_foreign_missing_module_root_and_unknown_query_preserve_refusal_metadata(self):
  installation=self.root/'stock';tool=installation/'bin/cmake';tool.parent.mkdir(parents=True);tool.write_bytes(b'inert');missing=installation/'missing';foreign=self.root/'foreign';(foreign/'Modules').mkdir(parents=True);empty=installation/'empty';empty.mkdir()
  escaped=installation/'escaped';escaped.mkdir();(escaped/'Modules').symlink_to(foreign/'Modules',target_is_directory=True)
  for selected in [missing,foreign,empty,escaped]:
   record={}
   with self.subTest(selected=selected),self.assertRaises((ValueError,FileNotFoundError)):n.cmake_root_metadata({'path':str(tool)},record,lambda *a,**kw:(0,('-- CHECKTRAIL_CMAKE_ROOT='+str(selected)+'\n').encode(),b''))
   self.assertEqual(record['reportedRoot'],str(selected))
  record={}
  with self.assertRaisesRegex(ValueError,'root metadata query failed'):n.cmake_root_metadata({'path':str(tool)},record,lambda *a,**kw:(1,b'unknown format\n',b'bounded native diagnostic\n'))
  self.assertEqual(record['stdout'],'unknown format\n');self.assertEqual(record['stderr'],'bounded native diagnostic\n')
 def test_sdk_cmake_and_git_helper_root_identity_changes_are_detected_even_with_same_children(self):
  for name in ['sdk','cmake-modules','git-helpers']:
   root=self.root/name;root.mkdir();root.chmod(0o755);(root/'same').write_bytes(b'identical stock data');before=n.input_catalog(root,1024,10);root.chmod(0o700);changed=n.input_catalog(root,1024,10)
   self.assertNotEqual(before,changed);self.assertEqual(before['entries'],changed['entries'])
   root.rename(self.root/(name+'-old'));root.mkdir();(root/'same').write_bytes(b'identical stock data');replaced=n.input_catalog(root,1024,10);self.assertNotEqual(changed['rootIdentity']['inode'],replaced['rootIdentity']['inode'])
 def test_early_actual_host_refusal_retains_versions_and_roots_readably_under_umask077(self):
  env={'GITHUB_ACTIONS':'true','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':'stsepelin/checktrail','GITHUB_RUN_ID':'123','GITHUB_SHA':'a'*40,'RUNNER_TEMP':str(self.root),'SUDO_UID':str(os.getuid())}
  def refuse(environment,admission):admission.update(cmakeVersion='cmake version 4.4.5',cmakeRootQuery={'reportedRoot':'/observed/stock/root'},physicalTools={'cmake':{'path':'/observed/stock/cmake'}});raise ValueError('synthetic layout refusal')
  prior=os.umask(0o077)
  try:
   with mock.patch.dict(n.os.environ,env,clear=True),mock.patch.object(n.os,'getuid',lambda:0),mock.patch.object(n,'host_admission',refuse),self.assertRaisesRegex(ValueError,'synthetic layout refusal'):n.observe(types.SimpleNamespace(work=str(self.root/'uncreated-source')))
  finally:os.umask(prior)
  path=self.root/'binaryen-host-admission.json';row=json.loads(path.read_bytes());self.assertFalse(row['complete']);self.assertEqual(row['cmakeVersion'],'cmake version 4.4.5');self.assertEqual(row['cmakeRootQuery']['reportedRoot'],'/observed/stock/root');self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o644);self.assertFalse((self.root/'uncreated-source').exists())
 def test_actual_umask_077_modes_keep_source_git_and_requests_readable_and_capture_private(self):
  manifest,objects,expected=fixture();prior=os.umask(0o077)
  try:
   work=self.root/'work';n.owned_directory(work);n.owned_directory(work/'control');n.owned_directory(work/'capture',0o700)
   n.owned_directory(work/'control/empty-home');n.owned_directory(work/'control/empty-hooks')
   c.materialize(manifest,objects,c.validate_manifest(manifest,objects,expected),work/'source','/synthetic/git',lambda *a,**kw:None,work/'control',expected)
   n.atomic_json(work/'control/permission-inputs.json',{'synthetic':True},mode=0o444)
   n.atomic_json(work/'control/frozen-output-paths.json',[],mode=0o444)
   n.atomic_json(work/'capture/TERMINAL.json',{'complete':False})
  finally:os.umask(prior)
  for folder,dirs,files in os.walk(work/'source',followlinks=False):
   self.assertEqual(stat.S_IMODE(Path(folder).stat().st_mode),0o755)
   for name in files:
    p=Path(folder)/name
    if p.is_symlink():continue
    expected_mode=0o444 if work/'source/.git' in p.parents or p.name=='.git' else 0o755 if p.name=='control' else 0o644
    self.assertEqual(stat.S_IMODE(p.stat().st_mode),expected_mode,str(p))
  for name in ['permission-inputs.json','frozen-output-paths.json']:
   self.assertEqual(stat.S_IMODE((work/'control'/name).stat().st_mode),0o444)
   self.assertTrue((work/'control'/name).read_bytes())
  self.assertEqual(stat.S_IMODE((work/'capture').stat().st_mode),0o700)
  self.assertEqual(stat.S_IMODE((work/'capture/TERMINAL.json').stat().st_mode),0o600)
 def test_sudo_policy_parser_accepts_only_standalone_denial_and_preserves_streams(self):
  denial=b'User nobody is not allowed to run sudo on selected-host.\n'
  for code in [0,1]:
   for stdout,stderr in [(denial,b''),(b'',denial)]:self.assertTrue(n.deny_only_sudo_policy(code,stdout,stderr)['standaloneDenialVerified'])
  for code,stdout,stderr in [(2,denial,b''),(0,b' '+denial,b''),(0,denial,b'warning\n'),(0,denial+denial,b''),(0,denial[:-1]+b' ALL\n',b''),(0,b'User nobody may run sudo on host.\n',b''),(0,denial[:20],denial[20:])]:
   with self.subTest(code=code,stdout=stdout),self.assertRaisesRegex(ValueError,'Unknown or permissive'):n.deny_only_sudo_policy(code,stdout,stderr)
 def test_sudo_wrapped_hostname_denial_accepts_only_exact_observed_eight_space_layout(self):
  wrapped=b'User nobody is not allowed to run sudo on\n        synthetic-long-host.invalid.\n'
  self.assertTrue(n.deny_only_sudo_policy(0,wrapped,b'')['standaloneDenialVerified'])
  self.assertTrue(n.deny_only_sudo_policy(1,b'',wrapped)['standaloneDenialVerified'])
  for invalid in [wrapped.replace(b'\n        ',b'\n    '),wrapped.replace(b'\n        ',b'\n\t'),wrapped.replace(b'\n        ',b'\n\n        '),wrapped+b'additional command permission\n',wrapped.replace(b'not allowed',b'allowed')]:
   with self.subTest(invalid=invalid),self.assertRaisesRegex(ValueError,'Unknown or permissive'):n.deny_only_sudo_policy(0,invalid,b'')
 def test_metadata_query_retains_separate_actual_streams_exit_and_failure_receipt(self):
  capture=self.root/'capture';capture.mkdir()
  code,out,err=n.capture_control_query(capture,'synthetic-query',[sys.executable,'-I','-c',"import sys;print('stdout');print('stderr',file=sys.stderr);sys.exit(1)"],dict(os.environ))
  self.assertEqual((code,out,err),(1,b'stdout\n',b'stderr\n'))
  receipt=json.loads((capture/'synthetic-query.json').read_text());self.assertEqual(receipt['exitCode'],1);self.assertFalse(receipt['timedOut'])
  self.assertEqual(receipt['streams'][0]['sha256'],c.sha(out));self.assertEqual(receipt['streams'][1]['sha256'],c.sha(err))
  with self.assertRaisesRegex(ValueError,'query deadline'):n.capture_control_query(capture,'synthetic-late',[sys.executable,'-I','-c',"import time;time.sleep(60)"],dict(os.environ),seconds=0.03)
  self.assertTrue(json.loads((capture/'synthetic-late.json').read_text())['timedOut'])
  with self.assertRaisesRegex(ValueError,'query output limit'):n.capture_control_query(capture,'synthetic-flood',[sys.executable,'-I','-c',"import os;os.write(1,b'x'*70000)"],dict(os.environ))
  self.assertEqual((capture/'synthetic-flood.stdout').stat().st_size,65536)
 def test_capture_staging_requires_quiescent_owner_and_validates_all_targets_before_modes(self):
  work=self.root/'work';capture=work/'capture';capture.mkdir(parents=True,mode=0o700);log=capture/'metadata';log.write_bytes(b'inert retained metadata');log.chmod(0o600)
  outside=self.root/'outside';outside.write_bytes(b'preserve');link=capture/'escape';link.symlink_to(outside)
  owner=os.getuid();real_lstat=n.Path.lstat;real_stat=n.Path.stat
  def root_owned(method):
   def read(path,*args,**kw):
    result=method(path,*args,**kw);fields=list(result);fields[4]=0;return os.stat_result(fields)
   return read
  with mock.patch.object(n,'owned_marker',return_value={'buildUid':65533}),mock.patch.object(n.Path,'stat',root_owned(real_stat)),mock.patch.object(n.Path,'lstat',root_owned(real_lstat)):
   with self.assertRaisesRegex(ValueError,'symbolic capture'):n.stage_capture(work,{})
   self.assertEqual(stat.S_IMODE(real_stat(log).st_mode),0o600);link.unlink()
   result=n.stage_capture(work,{})
  self.assertTrue(result['staged']);self.assertEqual(stat.S_IMODE(capture.stat().st_mode),0o755);self.assertEqual(stat.S_IMODE(log.stat().st_mode),0o444);self.assertEqual(outside.read_bytes(),b'preserve')
  with mock.patch.object(n,'owned_marker',side_effect=ValueError('Unreaped build-UID process')),self.assertRaisesRegex(ValueError,'Unreaped build-UID'):n.stage_capture(work,{})
 def test_cleanup_refuses_foreign_or_surviving_work_and_deletes_only_bound_synthetic_namespace(self):
  env={'GITHUB_ACTIONS':'true','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ID':'1','GITHUB_SHA':'a'*40}
  work=Path('/private/tmp')/('checktrail-binaryen-1-'+uuid.uuid4().hex);self.assertFalse(work.exists());(work/'control').mkdir(parents=True)
  marker=work/'control/OWNERSHIP.json';marker.write_text(json.dumps({'selection':c.SELECTION,'work':str(work),'runId':'1','sourceCommit':'a'*40,'buildUid':65533,'baselineBuildUidPids':[91]}))
  outside=self.root/'outside';outside.write_bytes(b'preserve');original=n.Path.stat
  def owned(path,*args,**kwargs):
   result=original(path,*args,**kwargs)
   if path in [work,marker]:
    fields=list(result);fields[4]=0;return os.stat_result(fields)
   return result
  try:
   with mock.patch.object(n.os,'getuid',lambda:0),mock.patch.object(n.Path,'stat',owned):
    with self.assertRaisesRegex(ValueError,'Foreign cleanup namespace'):n.cleanup(self.root,env)
    with mock.patch.object(n,'ps_rows',lambda:[{'pid':91,'uid':65533},{'pid':92,'uid':65533}]),self.assertRaisesRegex(ValueError,'Unreaped build-UID'):n.cleanup(work,env)
    self.assertTrue(marker.exists())
    with mock.patch.object(n,'ps_rows',lambda:[{'pid':91,'uid':65533}]):result=n.cleanup(work,env)
    self.assertTrue(result['deleted']);self.assertFalse(result['sdkOrToolInputsDeleted'])
   self.assertFalse(work.exists());self.assertEqual(outside.read_bytes(),b'preserve')
  finally:
   if work.exists():shutil.rmtree(work)

if __name__=='__main__':unittest.main(verbosity=2)
