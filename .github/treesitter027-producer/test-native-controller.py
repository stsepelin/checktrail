"""Synthetic first-party composition controls; no SDK/project execution or GET."""
import contextlib,hashlib,importlib.util,io,json,os,shutil,stat,struct,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('controller_under_test',HERE/'native-controller.py');C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
MANIFEST=json.loads((HERE/'native-inputs.json').read_bytes())
LOCKS={'Cargo.lock':'bf2323906cebdc3c72d307d70c0b5da58d83098590a842ee3deb7f5a7af5db82','package-lock.json':'79e6bf76f4898222e1359af392c9f49504987a4061f5c9dd57dea203dfe97980'}
MACHO=struct.pack('<8I',0xfeedfacf,0x0100000c,0,2,1,24,0,0)+struct.pack('<6I',0x32,24,1,11<<16,15<<16|5<<8,0)
class Response(io.BytesIO):
 status=200
 headers={}
 def __enter__(self):return self
 def __exit__(self,*args):self.close()
class Tests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='tree-firstparty-controls-');self.root=Path(self.temp.name).resolve()
 def tearDown(self):
  for f in self.root.rglob('*'):
   if f.is_dir() and not f.is_symlink():f.chmod(0o700)
  self.temp.cleanup()
 def write_outputs(self,source):
  for relative in C.OUTPUTS:
   path=source/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(MACHO if relative==C.OUTPUTS[0] else b'fresh synthetic output')
 def test_all_original_profiles_and_scopes(self):
  profiles=C.D.profiles(self.root/'source',self.root/'emsdk');self.assertEqual(len(profiles),14);self.assertEqual(profiles[-1]['argv'],['cargo','build','--release','--target=aarch64-apple-darwin','--features=wasm']);self.assertEqual(profiles[0]['argv'],['./emsdk','install','4.0.15']);self.assertEqual(profiles[0]['env'],{'EMSDK_KEEP_DOWNLOADS':'1'})
  self.assertEqual([p['env'].get('CJS') for p in profiles[9:13]],['true','true',None,None]);self.assertEqual([p['id'] for p in profiles if 'CFLAGS' in p['env']],['original-c-make']);self.assertTrue(all('test' not in p['argv'] for p in profiles));self.assertEqual([p['argv'][p['argv'].index('-DBUILD_SHARED_LIBS=OFF')] for p in profiles if '-DBUILD_SHARED_LIBS=OFF' in p['argv']],['-DBUILD_SHARED_LIBS=OFF'])
 def test_source_git_tree_modes_and_symlink(self):
  source=self.root/'source';source.mkdir();(source/'regular').write_bytes(b'original');(source/'executable').write_bytes(b'run');(source/'executable').chmod(0o755);(source/'link').symlink_to('regular');entries={'regular':('100644',C.G.git_blob(b'original')),'executable':('100755',C.G.git_blob(b'run')),'link':('120000',C.G.git_blob(b'regular'))};tree=C.G.git_tree(entries);proof=C.source_tree_proof(source,tree);self.assertEqual(proof['blobs'],3);(source/'executable').chmod(0o644)
  with self.assertRaisesRegex(ValueError,'Git tree'):C.source_tree_proof(source,tree)
 def test_installed_sdk_bound_file_and_escaping_link(self):
  root=self.root/'emsdk';root.mkdir();(root/'target').write_bytes(b'fixed');(root/'node').symlink_to('target');manifest={'installedSDKKeyFiles':[{'installedPath':'node','bytes':5,'sha256':hashlib.sha256(b'fixed').hexdigest()}]};self.assertEqual(len(C.installed_sdk_identity(self.root,manifest)),1);(root/'target').write_bytes(b'wrong')
  with self.assertRaisesRegex(ValueError,'identity differs'):C.installed_sdk_identity(self.root,manifest)
  (root/'node').unlink();outside=self.root/'outside';outside.write_bytes(b'fixed');(root/'node').symlink_to('../outside')
  with self.assertRaisesRegex(ValueError,'escaped'):C.installed_sdk_identity(self.root,manifest)
 def test_capture_all_original_outputs_and_bound_cmake_link(self):
  source=self.root/'source';source.mkdir();(self.root/'capture').mkdir();self.write_outputs(source);link=source/'build/shared/libtree-sitter.dylib';physical=link.with_name('libtree-sitter.0.27.dylib');link.rename(physical);link.symlink_to(physical.name);rows=C.capture_outputs(self.root,MANIFEST,{'buildUid':os.getuid()});self.assertEqual(len(rows),len(C.OUTPUTS));row=next(x for x in rows if x['sourcePath']=='build/shared/libtree-sitter.dylib');self.assertEqual(row['originalSourceLink'],physical.name);self.assertEqual((self.root/'capture/outputs'/row['sourcePath']).read_bytes(),physical.read_bytes());self.assertFalse((self.root/'capture/outputs'/row['sourcePath']).is_symlink())
 def test_missing_make_output_exports_nothing(self):
  source=self.root/'source';source.mkdir();(self.root/'capture').mkdir();self.write_outputs(source);(source/'libtree-sitter.a').unlink()
  with self.assertRaises(FileNotFoundError):C.capture_outputs(self.root,MANIFEST,{'buildUid':os.getuid()})
  self.assertFalse((self.root/'capture/outputs').exists())
 def test_escaping_or_hardlinked_outputs_export_nothing(self):
  source=self.root/'source';source.mkdir();(self.root/'capture').mkdir();self.write_outputs(source);path=source/C.OUTPUTS[-1];path.unlink();outside=self.root/'outside';outside.write_bytes(b'escape');path.symlink_to(outside)
  with self.assertRaisesRegex(ValueError,'escaping'):C.capture_outputs(self.root,MANIFEST,{'buildUid':os.getuid()})
  self.assertFalse((self.root/'capture/outputs').exists());path.unlink();os.link(outside,path)
  with self.assertRaisesRegex(ValueError,'hardlinked'):C.capture_outputs(self.root,MANIFEST,{'buildUid':os.getuid()})
 def test_wrong_cli_sdk_refuses_complete_capture(self):
  source=self.root/'source';source.mkdir();(self.root/'capture').mkdir();self.write_outputs(source);(source/C.OUTPUTS[0]).write_bytes(MACHO[:-8]+struct.pack('<2I',26<<16|2<<8,0))
  with self.assertRaisesRegex(ValueError,'15.5'):C.capture_outputs(self.root,MANIFEST,{'buildUid':os.getuid()})
 def test_manifest_partition_and_all_pin_validation(self):
  self.assertEqual(len(C.I.validate(MANIFEST)),543)
  for modify in [lambda m:m['cargo'].pop(),lambda m:m['primary'][0].update(sha256='g'*64),lambda m:m['primary'][0].update(url='https://nodejs.org.evil.invalid/input'),lambda m:m['primary'][0].update(bytes=m['primary'][0]['bytes']+1),lambda m:m['cargo'][0].update(sha256=m['cargo'][1]['sha256'])]:
   m=json.loads(json.dumps(MANIFEST));modify(m)
   with self.assertRaises(ValueError):C.I.validate(m)
 def synthetic_inputs(self):
  rows=[];bodies={}
  for i in range(543):
   body=('synthetic '+str(i)).encode();row={'id':'in'+str(i),'url':'https://registry.npmjs.org/synthetic/'+str(i),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'kind':'npm'};rows.append(row);bodies[row['url']]=body
  return rows,bodies
 def test_actual_whole_transport_result_reconciles_all543(self):
  rows,bodies=self.synthetic_inputs();opener=type('Opener',(),{'open':lambda s,req,**kw:Response(bodies[req.full_url])})()
  with patch.object(C.I,'validate',return_value=rows),patch.object(C.I.urllib.request,'build_opener',return_value=opener):proof=C.I.acquire({},self.root/'archives',C.P.Budget)
  saved=json.loads((self.root/'archives/CURATOR-RESULT.json').read_bytes());self.assertTrue(saved['complete']);self.assertEqual({r['id'] for r in saved['records']},{r['id'] for r in rows});self.assertEqual(saved['actualTransportBytes'],sum(r['bytes'] for r in rows));self.assertEqual(proof,saved)
  for r in saved['records']:self.assertEqual(C.M.digest(Path(r['file'])),r['sha256'])
 def test_transport_hash_failure_never_complete(self):
  rows,bodies=self.synthetic_inputs();bodies[rows[0]['url']]=b'X'*len(bodies[rows[0]['url']]);opener=type('Opener',(),{'open':lambda s,req,**kw:Response(bodies[req.full_url])})()
  with patch.object(C.I,'validate',return_value=rows),patch.object(C.I.urllib.request,'build_opener',return_value=opener):
   with self.assertRaisesRegex(ValueError,'incomplete'):C.I.acquire({},self.root/'archives',C.P.Budget)
  saved=json.loads((self.root/'archives/CURATOR-RESULT.json').read_bytes());self.assertFalse(saved['complete']);self.assertLess(len(saved['records']),543);self.assertIsNotNone(saved['failure'])
 def test_original_lock_guard_before_any_stage(self):
  source=self.root/'source';(source/'lib/binding_web').mkdir(parents=True);(source/'Cargo.lock').write_bytes(b'wrong');(source/'lib/binding_web/package-lock.json').write_bytes(b'wrong');native=type('Never',(),{'run':lambda *a: self.fail('lock failure must precede execution')})()
  with self.assertRaisesRegex(ValueError,'Cargo.lock differs'):C.D.run(native,source,self.root/'emsdk',{'RUSTFLAGS':'-D warnings','CARGO_NET_OFFLINE':'true'},lambda:None,lambda v:None)
 def test_output_byte_bound_precedes_any_export(self):
  source=self.root/'source';source.mkdir();(self.root/'capture').mkdir();self.write_outputs(source)
  with patch.dict(C.LIMITS,{'outputBytes':1}):
   with self.assertRaisesRegex(ValueError,'output bound'):C.capture_outputs(self.root,MANIFEST,{'buildUid':os.getuid()})
  self.assertFalse((self.root/'capture/outputs').exists())
 def test_offline_capture_failure_and_hash_corruption(self):
  spec=importlib.util.spec_from_file_location('capture_validator',HERE/'validate-capture.py');V=importlib.util.module_from_spec(spec);spec.loader.exec_module(V);root=self.root/'capture';root.mkdir();head='a'*40;result={'run':'1','attempt':'1','controllerCommit':head,'sourceCommit':MANIFEST['sourceCommit'],'sourceTree':MANIFEST['sourceTree'],'complete':False,'failure':{'reason':'observed refusal'}};file=root/'RESULT.json';file.write_text(json.dumps(result));index={'runId':'1','attempt':'1','controllerCommit':head,'files':[{'relativePath':'RESULT.json','bytes':file.stat().st_size,'sha256':C.M.digest(file)}]};(root/'CAPTURE-INDEX.json').write_text(json.dumps(index));self.assertFalse(V.validate(root,MANIFEST,'1','1',head)['acceptedOriginalProducerObservation']);file.write_bytes(file.read_bytes()+b' ')
  with self.assertRaisesRegex(ValueError,'hash mismatch'):V.validate(root,MANIFEST,'1','1',head)
 def test_offline_capture_missing_extra_link_and_owner(self):
  spec=importlib.util.spec_from_file_location('capture_validator2',HERE/'validate-capture.py');V=importlib.util.module_from_spec(spec);spec.loader.exec_module(V);root=self.root/'capture';root.mkdir();(root/'CAPTURE-INDEX.json').write_text(json.dumps({'runId':'1','attempt':'1','controllerCommit':'a'*40,'files':[]}));(root/'unexpected').write_bytes(b'extra')
  with self.assertRaisesRegex(ValueError,'Unindexed'):V.validate(root,MANIFEST,'1','1','a'*40)
  with self.assertRaisesRegex(ValueError,'owner'):V.validate(root,MANIFEST,'1','1','b'*40)
 def test_foreign_namespace_refused_before_any_file_access(self):
  with patch.object(C,'namespace',return_value=self.root/'owned'):
   with self.assertRaisesRegex(ValueError,'Foreign'):C.owned_marker(self.root/'foreign',{})
 def composition(self,failing=None,late=False):
  root=self.root/'run';calls=[];env={'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1'};real_digest=C.D.digest
  def digest(path):return LOCKS[path.name] if path.name in LOCKS else real_digest(path)
  def ready(work,env):(work/'control/build-home').mkdir();return {'allDeclaredHostChecksObserved':True}
  def prepare(work,manifest,curated):
   for name in ['source','emsdk','cargo-home','npm-tool','downloads','inputs/node24/bin','inputs/rust/bin']:(work/name).mkdir(parents=True,exist_ok=True)
   (work/'source/lib/binding_web').mkdir(parents=True);(work/'source/Cargo.lock').write_bytes(b'synthetic lock');(work/'source/lib/binding_web/package-lock.json').write_bytes(b'synthetic lock')
  def acquire(manifest,out,budget):out.mkdir();return {'complete':True,'records':[]}
  testcase=self
  class Native:
   def __init__(self,work,host):self.work=work;self.receipts=[];self.baseline_nobody=set()
   def run(self,name,args,environment,cwd,seconds):
    calls.append((name,args,dict(environment)));record={'phase':name,'success':False};self.receipts.append(record)
    if name==failing:raise ValueError('synthetic actual phase refusal')
    work=self.work
    text={'sdk-runtime-rustc':'release: 1.98.0\nhost: aarch64-apple-darwin\n','sdk-runtime-cargo':'release: 1.98.0\n','sdk-runtime-node':'v24.18.0\n','sdk-runtime-npm':'11.16.0\n'}.get(name,'synthetic phase complete\n');log=work/'capture'/(name+'.log');log.write_text(text);record.update(success=True,log={'path':str(log)})
    if name=='sdk-npm-cache':(work/'npm-cache/proof.json').write_text(json.dumps({'lockedPaths':253,'uniqueArchives':245,'offlineReads':245,'corruptPayloadRejected':True,'restoredReads':245}))
    if name=='original-wasmtime-version':Path(environment['CHECKTRAIL_WASMTIME_VERSION_RECEIPT']).write_bytes(b'48.0.1\n')
    if name=='original-rust-cli':testcase.write_outputs(work/'source')
    return record
  fake_host={'buildUid':os.getuid(),'buildGid':os.getgid(),'buildHome':str(root/'home'),'tools':{k:{'path':'/usr/bin/'+k} for k in ['cmake','git','python3']},'developerDir':'/fixed/developer','sdk':'/fixed/sdk'}
  # Explicit injected metadata/transport/UID boundaries; real original-stage driver,
  # result writer, SDK version guard, output bytes/Mach-O checks remain exercised.
  with contextlib.ExitStack() as stack:
   for obj,name,value in [(C,'namespace',lambda e:root),(C.I,'validate',lambda m:[]),(C.N,'ps_rows',lambda:[]),(C.pwd,'getpwnam',lambda n:type('Account',(),{'pw_uid':os.getuid()})()),(C,'fresh_host',ready),(C,'runtime_host',lambda *a:fake_host),(C.I,'acquire',acquire),(C,'prepare_payload',prepare),(C,'own_tree',lambda *a:None),(C.N,'Native',Native),(C,'permission_admission',lambda *a,**k:None),(C,'freeze_emsdk',lambda *a:{'EMSDK_NODE':str(root/'emsdk/node/22.16.0_64bit/bin/node')}),(C.D,'digest',digest),(C,'owned_marker',lambda *a:{}),(C.signal,'setitimer',lambda *a:None)]:stack.enter_context(patch.object(obj,name,value))
   stack.enter_context(patch.dict(C.os.environ,env,clear=True))
   if late:
    start=[0]
    def clock():start[0]+=1;return 0 if start[0]==1 else 3601
    stack.enter_context(patch.object(C.time,'monotonic',clock))
   work,result=C.observe(MANIFEST)
  self.assertEqual(result,json.loads((work/'capture/RESULT.json').read_bytes()));return work,result,calls
 def test_whole_composition_physical_result_and_no_flag_leak(self):
  work,result,calls=self.composition();self.assertTrue(result['complete']);self.assertEqual(len(result['phases']),19);self.assertFalse(result['fullCompilerSDKSourceBuildLegalOrGateAClosureClaimed']);self.assertEqual(len(json.loads((work/'capture/OUTPUTS.json').read_bytes())['records']),12)
  byname={name:env for name,args,env in calls};self.assertEqual(byname['original-c-make']['CC'],'gcc');self.assertNotIn('CFLAGS',byname['original-rust-cli']);self.assertNotIn('CJS',byname['original-esm-debug']);self.assertEqual(byname['original-cjs-debug']['CJS'],'true');self.assertNotIn(str(work/'inputs/node24/bin'),byname['original-emsdk-install']['PATH'].split(':'));self.assertNotIn('EM_CACHE',byname['original-emsdk-install']);self.assertIn(str(work/'inputs/node24/bin'),byname['original-rust-cli']['PATH'].split(':'))
 def test_complete_capture_validator_reads_real_files_and_rejects_missing_stage(self):
  work,result,calls=self.composition();capture=work/'capture'
  for file in capture.rglob('*'):
   if file.is_file():file.chmod(0o644)
  spec=importlib.util.spec_from_file_location('capture_whole_success',HERE/'validate-capture.py');V=importlib.util.module_from_spec(spec);spec.loader.exec_module(V)
  names=['input-permissions','input-permissions-counterfactual','sdk-runtime-rustc','sdk-runtime-cargo','sdk-runtime-node','sdk-runtime-npm','sdk-npm-cache','original-emsdk-install','original-emsdk-activate','activated-sdk-permissions','activated-sdk-permissions-counterfactual','sdk-runtime-emsdk-node','sdk-runtime-emsdk-python']+[p['id'] for p in C.D.profiles(Path('/source'),Path('/emsdk'))][2:]
  result['phases']=[{'phase':n,'success':True,'exitCode':0,'unreapedBuildUidProcesses':[]} for n in names];(capture/'RESULT.json').write_text(json.dumps(result));(capture/'host-readiness').mkdir();(capture/'host-readiness/admission.json').write_text(json.dumps({'allDeclaredHostChecksObserved':True,'checks':{str(i):True for i in range(14)}}))
  for name in ['input-permissions','activated-sdk-permissions']:(capture/(name+'.json')).write_text(json.dumps({'metadataEndpointMatched':True,'observed':{'allSelectedEntriesReadableExecutableAndProtected':True,'failureCount':0}}))
  (capture/'ORIGINAL-SOURCE-TREES.json').write_text(json.dumps([{'id':r['id'],'observedTree':r['materialization']['sourceGitTree'],'complete':True} for r in MANIFEST['primary'] if r['materialization'].get('sourceGitTree')]))
  (capture/'CURATOR-RESULT.json').write_text(json.dumps({'complete':True,'records':[{'id':r['id'],'sha256':r['sha256'],'bytes':r['bytes']} for r in C.I.validate(MANIFEST)]}));(capture/'EMSDK-INSTALLED-IDENTITIES.json').write_text(json.dumps({'keyFiles':[{**r,'observed':{'bytes':r['bytes'],'sha256':r['sha256']}} for r in MANIFEST['installedSDKKeyFiles']]}))
  def index():
   rows=[{'relativePath':p.relative_to(capture).as_posix(),'bytes':p.stat().st_size,'sha256':C.M.digest(p)} for p in capture.rglob('*') if p.is_file() and p.name!='CAPTURE-INDEX.json'];(capture/'CAPTURE-INDEX.json').write_text(json.dumps({'runId':'1','attempt':'1','controllerCommit':'a'*40,'files':rows}))
  index();self.assertTrue(V.validate(capture,MANIFEST,'1','1','a'*40)['acceptedOriginalProducerObservation']);result['phases'].pop(3);(capture/'RESULT.json').write_text(json.dumps(result));index()
  with self.assertRaisesRegex(ValueError,'completion/order'):V.validate(capture,MANIFEST,'1','1','a'*40)
 def test_whole_composition_phase_failure_writes_unaccepted_result(self):
  work,result,calls=self.composition('original-cmake-static-build');self.assertFalse(result['complete']);self.assertIn('refusal',result['failure']['reason']);self.assertFalse((work/'capture/outputs').exists());self.assertNotIn('original-rust-cli',[x[0] for x in calls])
 def test_late_zero_is_revoked_in_physical_result(self):
  work,result,calls=self.composition(late=True);self.assertFalse(result['complete']);self.assertEqual(result['failure']['type'],'TimeoutError');self.assertIn('apparent completion',result['failure']['reason'])
if __name__=='__main__':unittest.main()
