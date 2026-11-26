"""Synthetic ownership/ACL providers; real own-file nonempty access, no /opt writes."""
from pathlib import Path
import copy,hashlib,json,os,stat,subprocess,sys,tempfile,time,unittest
from types import SimpleNamespace
from unittest import mock
import placement as P
class Placement(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.root.chmod(0o755);self.parent=self.root/'parent';self.parent.mkdir(mode=0o755);self.parent.chmod(0o755);self.context={'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40};self.identity={'uid':os.getuid()+1000000,'gid':20,'groups':[20]};self.real_status=P.status
 def tearDown(self):self.tmp.cleanup()
 def root_view(self,path):
  # This explicit synthetic provider models the stock root-owned traversable
  # ancestors; fixture-owned modes remain real so their mutations still fail.
  s=self.real_status(path);mode=stat.S_IFDIR|0o755 if path in self.root.parents else s.st_mode
  return SimpleNamespace(st_uid=0,st_mode=mode)
 def layout(self):
  paths=P.paths(self.context,self.parent);paths['base'].mkdir(mode=0o755);paths['base'].chmod(0o755);paths['controller'].mkdir(mode=0o755);(paths['controller']/'reused_admission.py').write_bytes(b'# SYNTHETIC first-party metadata script\n');(paths['controller']/'reused_admission.py').chmod(0o444);paths['controller'].chmod(0o555);paths['host'].mkdir(mode=0o700);paths['host'].chmod(0o700);return paths
 def fake_module(self):
  def metadata(path):
   s=path.lstat();return {'device':s.st_dev,'inode':s.st_ino,'bytes':s.st_size,'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'links':s.st_nlink}
  def snapshot(paths,bounds):
   rows=[]
   for p in paths:
    bounds.entry();body=p.read_bytes();bounds.bytes+=len(body);rows.append({'path':str(p),'type':'file','sha256':hashlib.sha256(body).hexdigest(),**metadata(p)})
   return rows
  class Bounds:
   def __init__(self):self.deadline=time.monotonic()+5;self.clock=time.monotonic;self.bytes=0;self.entries=0
   def tick(self):
    if self.clock()>=self.deadline:raise ValueError('synthetic-existing-phase-deadline')
   def entry(self):self.tick();self.entries+=1
  def encoded(value):return json.dumps(value,sort_keys=True).encode()
  def current(frame):
   result=[]
   for row in frame:
    now=metadata(Path(row['path']));self.assertEqual(now,{k:row[k] for k in now});result.append({'path':row['path'],**now})
   return result
  helper=b'# SYNTHETIC verified permission helper 4729\n'
  return SimpleNamespace(metadata=metadata,snapshot=snapshot,encoded=encoded,current_endpoint=current,digest=lambda b:hashlib.sha256(b).hexdigest(),verifiedSource=helper,verifiedSHA256=hashlib.sha256(helper).hexdigest()),Bounds()
 def observe(self,*,deny=False,blank=False,change_parent=False,changed=None):
  def run(module,argv,env,receipts,timeout):
   self.assertEqual('--inner',argv[-2]);self.assertEqual('/usr/bin/sudo',argv[0]);self.assertGreater(timeout,0);self.assertLessEqual(timeout,30);request=Path(argv[-1]);data=json.loads(request.read_text());body=Path(data['controller']['file']).read_bytes();self.assertGreater(len(body),0);self.assertLessEqual(len(body),4096);self.assertEqual({'firstPartyAccessCanary':1,'runContext':self.context},json.loads(body));self.assertEqual(hashlib.sha256(body).hexdigest(),data['controller']['sha256']);self.assertEqual(self.identity,data['identity']);self.assertFalse(any('/SDK' in r['path'] for r in data['frame']));self.assertTrue(any(r['type']=='directory' for r in data['frame']));receipts.append({'syntheticFirstPartyOnly':True})
   if change_parent:request.parent.chmod(0o750)
   end=module.current_endpoint(data['frame'])
   # The full shape inspect_as_build() returns; a denial is the canary entry
   # failing its read check, since an unprotected controller raises instead.
   denied=[{'path':r['path'],'readable':False,'executableWhenRequired':True,'writablePaths':[]} for r in data['frame'] if r['path'].endswith('/FIRSTPARTY-ACCESS-CANARY')] if deny else []
   value={'identity':data['identity'],'selectedEntriesChecked':len(data['frame']),'failureCount':len(denied),'firstFailures':denied,'allSelectedEntriesReadableExecutableAndProtected':not denied,'controllerProtected':True,'metadataEndpointSha256':module.digest(module.encoded(end)),'permissionProbeOnly':True,'projectCodeExecuted':False}
   return changed(value,data['frame']) if changed else value
  return run
 def test_exact_shared_paths_context_and_native_work(self):
  p=P.paths(self.context,self.parent);self.assertEqual(p['base']/'controller',p['controller']);self.assertEqual(p['base']/'host',p['host']);self.assertEqual('rust198-123-1-aaaaaaaaaaaa',p['nativeWork'].name);self.assertNotIn('RUNNER_TEMP',str(p));self.assertEqual(4,len({p[k] for k in ['controller','host','nativeWork','base']}))
 def test_bad_or_prefix_suffix_context_cannot_choose_namespace(self):
  for key,value in [('GITHUB_RUN_ID','0'),('GITHUB_RUN_ID','123x'),('GITHUB_RUN_ATTEMPT','01'),('GITHUB_SHA','a'*40+'x'),('GITHUB_SHA','A'*40)]:
   c={**self.context,key:value}
   with self.subTest(key=key,value=value),self.assertRaisesRegex(ValueError,'^closed-host-placement-context$'):P.paths(c,self.parent)
 def test_existing_parent_symlink_or_nonroot_or_nontraversable_refused(self):
  link=self.root/'link';link.symlink_to(self.parent)
  with self.assertRaisesRegex(ValueError,'^physical-existing-placement-parent$'):P.validate_parent(link)
  with mock.patch.object(P,'status',side_effect=lambda p:SimpleNamespace(st_uid=123,st_mode=stat.S_IFDIR|0o755)),self.assertRaisesRegex(ValueError,'^root-owned-traversable-existing-placement-ancestor$'):P.validate_parent(self.parent)
  with mock.patch.object(P,'status',side_effect=lambda p:SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)),self.assertRaisesRegex(ValueError,'^root-owned-traversable-existing-placement-ancestor$'):P.validate_parent(self.parent)
 def test_create_modes_only_fresh_own_child_and_never_existing_parent(self):
  # Ownership is an explicit synthetic provider; no actual root/nobody claim.
  calls=[];real_chmod=Path.chmod
  def chmod(path,mode,*args,**kwargs):calls.append((path,mode));return real_chmod(path,mode,*args,**kwargs)
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),mock.patch.object(P.os,'getuid',return_value=0),mock.patch.object(P,'validate_parent',return_value=[]),mock.patch.object(Path,'chmod',chmod),mock.patch.object(P.os,'chown',side_effect=AssertionError('no chown')):p=P.create_namespace(self.context)
  self.assertEqual([(p['base'],0o755)],calls);self.assertNotEqual(self.parent,p['base']);self.assertEqual(0o755,stat.S_IMODE(p['base'].stat().st_mode))
 def test_existing_directory_or_symlink_namespace_refuses_no_overwrite(self):
  p=P.paths(self.context,self.parent);p['base'].mkdir()
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'validate_parent',return_value=[]),mock.patch.object(P.os,'getuid',return_value=0),self.assertRaises(FileExistsError):P.create_namespace(self.context)
  p['base'].rmdir();p['base'].symlink_to(self.parent)
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'validate_parent',return_value=[]),mock.patch.object(P.os,'getuid',return_value=0),self.assertRaises(FileExistsError):P.create_namespace(self.context)
 def test_runtime_controller_output_and_private_mode_near_misses_refuse(self):
  p=self.layout()
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view):
   self.assertEqual(p,P.validate_runtime(self.context,p['controller'],p['host']))
   for control,output in [(self.root/'old-temp-control',p['host']),(p['controller'],self.root/'old-temp-host')]:
    with self.assertRaisesRegex(ValueError,'^exact-own-run-controller-and-output-placement$'):P.validate_runtime(self.context,control,output)
   p['host'].chmod(0o755)
   try:
    with self.assertRaisesRegex(ValueError,'^private-owned-host-output-placement$'):P.validate_runtime(self.context,p['controller'],p['host'])
   finally:p['host'].chmod(0o700)
 def test_early_canary_snapshot_failure_closes_exact_owned_request_fd(self):
  p=self.layout();module,bounds=self.fake_module();module.snapshot=lambda *args:(_ for _ in ()).throw(ValueError('synthetic-firstparty-snapshot-failure'));opened=[];real_open=os.open
  def observed(path,*args,**kwargs):
   fd=real_open(path,*args,**kwargs)
   if Path(path).name=='FIRSTPARTY-CANARY-REQUEST.json':opened.append(fd)
   return fd
  try:
   with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),mock.patch.object(P.os,'open',side_effect=observed),self.assertRaisesRegex(ValueError,'^synthetic-firstparty-snapshot-failure$'):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe())
   self.assertEqual(1,len(opened))
   with self.assertRaises(OSError) as caught:os.fstat(opened[0])
   self.assertEqual(9,caught.exception.errno);self.assertEqual([],list(p['host'].iterdir()));self.assertEqual(0o700,stat.S_IMODE(p['host'].stat().st_mode))
  finally:
   for fd in opened:
    try:os.close(fd)
    except OSError:pass
 def test_native_work_contract_refuses_old_temp_or_wrong_context(self):
  p=self.layout()
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),mock.patch.object(P,'validate_parent',return_value=[]):
   self.assertEqual(p,P.require_native_work(self.context,p['controller'],p['nativeWork']))
   for wrong in [self.root/'RUNNER_TEMP'/p['nativeWork'].name,p['base']/('prefix-'+p['nativeWork'].name)]:
    with self.assertRaisesRegex(ValueError,'^shared-native-controller-work-placement$'):P.require_native_work(self.context,p['controller'],wrong)
 def test_nonempty_firstparty_canary_real_own_file_read_no_sdk_credit_and_cleanup(self):
  p=self.layout();module,bounds=self.fake_module()
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view):r=P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe())
  self.assertTrue(r['firstPartyOnlyNonemptyAccessCanaryObserved']);self.assertGreater(r['payloadReadBytesVerifiedByLegacyHashCheck'],0);self.assertGreater(bounds.bytes,0);self.assertFalse(r['SDKFrameOrNativeAdmissionCredit']);self.assertEqual(0,r['SDKBytesReadByThisCanary']);self.assertEqual(0o700,stat.S_IMODE(p['host'].stat().st_mode));self.assertEqual([],list(p['host'].iterdir()))
 def test_canary_probe_runs_the_staged_verified_helper_and_frames_it(self):
  p=self.layout();module,bounds=self.fake_module();seen=[];base=self.observe()
  def run(module,argv,env,receipts,timeout):
   helper=Path(argv[-4]);frame=json.loads(Path(argv[-1]).read_text())['frame']
   seen.append((helper,helper.read_bytes(),argv[-3],str(helper) in {r['path'] for r in frame},str(p['controller']/'reused_admission.py') in {r['path'] for r in frame}))
   return base(module,argv,env,receipts,timeout)
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),run)
  self.assertEqual([(p['host']/P.INNER_HELPER,module.verifiedSource,module.verifiedSHA256,True,True)],seen);self.assertEqual([],list(p['host'].iterdir()))
 def test_output_turns_private_again_when_staged_helper_cleanup_fails(self):
  p=self.layout();module,bounds=self.fake_module();base=self.observe(deny=True)
  def run(module,argv,env,receipts,timeout):
   helper=Path(argv[-4]);helper.unlink();helper.mkdir();(helper/'occupied-3307').write_bytes(b'3307')
   return base(module,argv,env,receipts,timeout)
  try:
   with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),self.assertRaises(OSError):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),run)
   self.assertEqual(0o700,stat.S_IMODE(p['host'].stat().st_mode))
  finally:
   occupied=p['host']/P.INNER_HELPER
   if occupied.is_dir():(occupied/'occupied-3307').unlink();occupied.rmdir()
 def test_helper_bytes_that_do_not_match_their_pin_are_never_staged(self):
  p=self.layout();module,bounds=self.fake_module();module.verifiedSource=b'# replaced helper 4729\n'
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),self.assertRaisesRegex(ValueError,'^verified-permission-helper-bytes$'):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe())
  self.assertEqual([],list(p['host'].iterdir()));self.assertEqual(0o700,stat.S_IMODE(p['host'].stat().st_mode))
 def test_empty_canary_is_not_a_passing_access_probe(self):
  p=self.layout();module,bounds=self.fake_module();module.encoded=lambda value:b''
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),self.assertRaisesRegex(ValueError,'^nonempty-small-firstparty-canary$'):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe())
 def test_denied_acl_or_effective_write_canary_stops_before_sdk_and_cleans(self):
  p=self.layout();module,bounds=self.fake_module()
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),self.assertRaisesRegex(ValueError,'^firstparty-canary-access-refused$'):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe(deny=True))
  self.assertEqual([],list(p['host'].iterdir()));self.assertEqual(0o700,stat.S_IMODE(p['host'].stat().st_mode))
 def test_contradictory_canary_reply_earns_no_canary_credit(self):
  # Every case keeps both protection flags true, the matching endpoint digest
  # and the full entry count: the reply contradicts only itself.
  def canary_row(frame):return {'path':next(r['path'] for r in frame if r['path'].endswith('/FIRSTPARTY-ACCESS-CANARY')),'readable':False,'executableWhenRequired':True,'writablePaths':[]}
  def without(key):return lambda v,f:{k:x for k,x in v.items() if k!=key}
  cases={'seven-failures-none-listed':(lambda v,f:{**v,'failureCount':7},'inconsistent: failure count$'),'one-listed-failure-all-protected':(lambda v,f:{**v,'failureCount':1,'firstFailures':[canary_row(f)]},'inconsistent: all-protected flag and failure count$'),'listed-row-outside-frame':(lambda v,f:{**v,'failureCount':1,'firstFailures':[{**canary_row(f),'path':'/synthetic/foreign-9137'}],'allSelectedEntriesReadableExecutableAndProtected':False},'inconsistent: listed failure outside request frame order$'),'other-build-identity':(lambda v,f:{**v,'identity':{**v['identity'],'uid':v['identity']['uid']+9137}},'inconsistent: build identity$'),'project-code-executed':(lambda v,f:{**v,'projectCodeExecuted':True},'inconsistent: controller/probe-only claims$'),'probe-only-claim-absent':(without('permissionProbeOnly'),'fields$'),'boolean-failure-count':(lambda v,f:{**v,'failureCount':False},'fields$')}
  for label,(changed,message) in cases.items():
   with self.subTest(case=label):
    self.tmp.cleanup();self.setUp();p=self.layout();module,bounds=self.fake_module()
    with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),self.assertRaisesRegex(ValueError,'^First-party inner result '+message):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe(changed=changed))
    self.assertEqual([],list(p['host'].iterdir()));self.assertEqual(0o700,stat.S_IMODE(p['host'].stat().st_mode))
 def test_consistent_canary_reply_with_a_reordered_copy_earns_canary_credit(self):
  # A reply rebuilt field by field, not the observer's own object, still passes.
  p=self.layout();module,bounds=self.fake_module()
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view):r=P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe(changed=lambda v,f:{k:copy.deepcopy(v[k]) for k in sorted(v,reverse=True)}))
  self.assertTrue(r['firstPartyOnlyNonemptyAccessCanaryObserved']);self.assertEqual(self.identity,r['identity']);self.assertGreater(r['selectedFirstpartyAndAncestorEntries'],2);self.assertEqual([],list(p['host'].iterdir()))
 def test_parent_change_refuses_and_still_closes_owned_request_descriptor(self):
  p=self.layout();module,bounds=self.fake_module()
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),self.assertRaises(AssertionError):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe(change_parent=True))
  self.assertEqual([],list(p['host'].iterdir()));self.assertEqual(0o700,stat.S_IMODE(p['host'].stat().st_mode))
 def test_canary_cost_is_charged_inside_existing_permission_deadline(self):
  p=self.layout();module,bounds=self.fake_module();bounds.deadline=time.monotonic()-1
  with mock.patch.object(P,'PARENT',self.parent),mock.patch.object(P,'status',side_effect=self.root_view),self.assertRaisesRegex(ValueError,'^synthetic-existing-phase-deadline$'):P.access_canary(module,bounds,p['controller'],p['host'],self.identity,self.context,os.getuid(),self.observe())
  self.assertEqual([],list(p['host'].iterdir()))
 def test_actual_native_startup_checks_shared_placement_before_grant_or_native(self):
  import producer
  environment={**self.context};args=['producer','observe',str(Path(__file__).resolve().parent/'profile.json'),'--operator-grant','/synthetic/grant','--grant-sha256','a'*64,'--host-receipt','/synthetic/host','--archives','/synthetic/archives','--work','/synthetic/old-temp-work']
  with mock.patch.dict(os.environ,environment),mock.patch.object(producer.os,'getuid',return_value=0),mock.patch.object(producer.PL,'require_native_work',side_effect=ValueError('synthetic-placement-refusal')) as required,mock.patch.object(producer.A,'validate_operator_grant',side_effect=AssertionError('must refuse placement first')),mock.patch.object(__import__('sys'),'argv',args),self.assertRaisesRegex(ValueError,'^synthetic-placement-refusal$'):producer.main()
  required.assert_called_once()
 def test_failed_canary_stops_before_bulk_sdk_snapshot(self):
  import host_probe as H
  p=self.layout()
  class Bounds:
   def __init__(self):self.deadline=time.monotonic()+5;self.clock=time.monotonic
   def tick(self):pass
  def command(argv,env,receipts,codes=(0,),timeout=30):
   import subprocess
   if argv[0]=='/usr/bin/id':return subprocess.CompletedProcess(argv,0,b'20\n',b'')
   if argv[:3]==['/usr/bin/sudo','-n','-l']:return subprocess.CompletedProcess(argv,1,b'synthetic-policy',b'')
   if argv[0]=='/bin/ps':return subprocess.CompletedProcess(argv,0,b'',b'')
   raise AssertionError('No inner or SDK operation after canary refusal')
  module=SimpleNamespace(Bounds=Bounds,command=command,group_id=int,sudo_denial=lambda value:True,snapshot=mock.Mock(side_effect=AssertionError('bulkSDKsnapshotmustnotrun')));account=SimpleNamespace(pw_uid=self.identity['uid'],pw_gid=20)
  with mock.patch.object(H,'guard',return_value=module),mock.patch.object(H.pwd,'getpwnam',return_value=account),mock.patch.dict(os.environ,{'CHECKTRAIL_CONTROLLER_UID':str(os.getuid())}),mock.patch.object(H.PL,'access_canary',side_effect=ValueError('synthetic-canary-refusal')) as canary,self.assertRaisesRegex(ValueError,'^synthetic-canary-refusal$'):H.permission_observation(p['controller'],p['controller']/'SDK',p['controller']/'Toolchain',{},p['host'],self.context)
  canary.assert_called_once();module.snapshot.assert_not_called()
 def test_isolated_producer_plan_starts_without_ambient_script_path_and_does_not_execute(self):
  here=Path(__file__).resolve().parent;profile=json.loads((here/'profile.json').read_bytes());result=subprocess.run([sys.executable,'-I','-B',str(here/'producer.py'),'plan',str(here/'profile.json')],cwd=self.root,capture_output=True,timeout=10)
  self.assertEqual(0,result.returncode,result.stderr.decode('utf-8','replace'));self.assertEqual(b'',result.stderr);plan=json.loads(result.stdout)
  self.assertEqual({'profileValidated':True,'nativeExecutionGranted':False,'originalCommands':[profile['configure'],profile['prepare'],profile['dist']],'unassessed':['SDK262/SLA/toolphysicalprotection','sourcecasevolume','originalsccache/Rosetta/IPC','buildmemory/disk/time/capturefit'],'anySDKOrSourceExecuted':False},plan)
 def test_isolated_metadata_help_starts_without_ambient_script_path(self):
  result=subprocess.run([sys.executable,'-I','-B',str(Path(__file__).resolve().parent/'host_probe.py'),'--help'],cwd=self.root,capture_output=True,timeout=10)
  self.assertEqual(0,result.returncode,result.stderr.decode('utf-8','replace'));self.assertEqual(b'',result.stderr);self.assertIn(b'usage: host_probe.py',result.stdout);self.assertIn(b'No SDK/compiler/source executable is run.',b' '.join(result.stdout.split()))
 def test_isolated_startup_gate_help_needs_no_unqualified_local_import(self):
  result=subprocess.run([sys.executable,'-I','-B',str(Path(__file__).resolve().parent/'launch.py'),'--help'],cwd=self.root,capture_output=True,timeout=10)
  self.assertEqual(0,result.returncode,result.stderr.decode('utf-8','replace'));self.assertEqual(b'',result.stderr);self.assertIn(b'usage: launch.py',result.stdout);self.assertIn(b'--manifest-sha256',result.stdout)
if __name__=='__main__':unittest.main()
