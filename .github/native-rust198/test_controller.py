"""Synthetic first-party controls only: no upstream source/SDK/compiler execution."""
from pathlib import Path
import _io,ast,builtins,subprocess,contextlib,copy,hashlib,io,json,os,plistlib,re,signal,stat,sys,tempfile,types,unittest
from contextlib import redirect_stdout
from unittest import mock
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
import admission as A,host_probe as H,launch as L,process_supervisor as N,producer as P,retention as R,sequence as S,volume as V

def profile():return json.loads((HERE/'profile.json').read_bytes())
def qualified(p):
 # Explicitly synthetic contract evidence, never a real host admission receipt.
 p['originalSccache']['sha256']='f'*64;net='(version 1)(deny network*)'
 return {'evidenceKind':'actual-standard-github-host','platform':'Darwin','arch':'arm64','macOS':'15.8.2','developerDir':A.DEVELOPER,'xcodeVersion':'26.2','CPUs':3,'RAMBytes':7*A.GIB,'scratchFreeBytes':49_422_606_336,'controllerProtected':True,'sdkAndToolsProtectedFromBuildUid':True,'allDeclaredSDKToolBytesHashed':True,'buildUid':4294967294,'buildGid':4294967294,'buildUser':'nobody','runnerUid':501,'sudoDenied':True,'buildUidProcesses':[],'caseSensitiveWorkspace':True,'originalSLATextRetained':True,'SLABodyRootReviewed':True,'tools':{t:{'path':'/usr/bin/'+t} for t in A.TOOLS},'sccache':{'path':'/synthetic/sccache','version':'0.10.0','artifactSHA256':'f'*64,'originalSourceNoticeClosure':True,'MachOArchitecture':'x86_64','stockRosettaRuntimeObserved':True,'stopServerCommandQualified':True},'networkIPCProbeQualified':True,'qualifiedNetworkProfile':net,'operatorQualifiedNetworkProfileSHA256':hashlib.sha256(net.encode()).hexdigest(),'sdkPath':A.DEVELOPER+'/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.2.sdk'}

def root_owned_descriptor(file):
 """os.fstat() reporting root ownership for descriptors open on file's current inode only."""
 original=os.fstat
 def fstat(fd):
  s=original(fd);now=os.lstat(file)
  if (s.st_dev,s.st_ino)!=(now.st_dev,now.st_ino):return s
  v=list(s);v[4]=0;return os.stat_result(v,{'st_mtime_ns':s.st_mtime_ns,'st_ctime_ns':s.st_ctime_ns})
 return fstat

class ControlTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.p=profile()
 def tearDown(self):self.temp.cleanup()
 def test_exact_profile_original36_args_enzyme_and_defaults(self):
  self.assertTrue(P.validate_profile(self.p));self.assertEqual(36,len(self.p['configure'])-1);self.assertIn('enzyme',self.p['dist']);self.assertEqual(['llvm','cranelift'],self.p['configuredCodegenBackends'])
  for modify in [lambda p:p['configure'].pop(),lambda p:p['dist'].remove('enzyme'),lambda p:p.update(prepareAttempts=1),lambda p:p.update(sourceVersion='1.97.1'),lambda p:p.update(configuredCodegenBackends=['llvm']),lambda p:p.update(originalFeaturesTargetsOrDefaultComponentsReduced=True),lambda p:p['inputs'].pop()]:
   p=copy.deepcopy(self.p);modify(p)
   with self.assertRaises(ValueError):P.validate_profile(p)
 def test_actual_profile_never_admits_unknown_sccache(self):
  h=qualified(copy.deepcopy(self.p));value=A.assess(self.p,h);self.assertFalse(value['nativeEligible']);self.assertIn('original-sccache-Rosetta-source-notice-admission',value['failures']);self.assertFalse(value['memoryHardLimitClaimed'])
 def test_metadata_family_every_runtime_guard_armed(self):
  h=qualified(self.p);self.assertTrue(A.assess(self.p,h)['nativeEligible'])
  cases={'evidenceKind':'synthetic','xcodeVersion':'16.4','RAMBytes':7*A.GIB-1,'CPUs':2,'scratchFreeBytes':self.p['bounds']['admissionFreeBytes']-1,'controllerProtected':False,'sdkAndToolsProtectedFromBuildUid':False,'allDeclaredSDKToolBytesHashed':False,'buildUid':501,'sudoDenied':False,'buildUidProcesses':[{'pid':42}],'caseSensitiveWorkspace':False,'originalSLATextRetained':False,'SLABodyRootReviewed':False,'networkIPCProbeQualified':False,'operatorQualifiedNetworkProfileSHA256':'0'*64,'tools':{}}
  for key,value in cases.items():
   with self.subTest(key=key):bad=copy.deepcopy(h);bad[key]=value;self.assertFalse(A.assess(self.p,bad)['nativeEligible'])
  bad=copy.deepcopy(h);bad['sccache']['stopServerCommandQualified']=False;self.assertFalse(A.assess(self.p,bad)['nativeEligible']);bad=copy.deepcopy(h);bad['sccache']['MachOArchitecture']='arm64';self.assertFalse(A.assess(self.p,bad)['nativeEligible'])
 def test_synthetic_case_probe_positive_or_truthful_case_insensitive(self):
  result=A.case_probe(self.root);self.assertEqual(result['caseSensitive'],result['caseSensitivePositiveControl']);self.assertFalse(list(self.root.iterdir()));aliases=A.potential_aliases([{'path':'a/ABCD'},{'path':'a/abcd'},{'path':'b/abcd'}]);self.assertEqual([['a/ABCD','a/abcd']],aliases)
 def test_operator_grant_owner_context_hash_and_model_authority(self):
  file=self.root/'grant.json';value={'authority':'explicit-reviewed-workflow-startup','profileSHA256':'p','controllerCodeSHA256':'c','runContext':{'r':'1'},'allowedOperation':'original-rust198-producer','hostReceiptSHA256':'h','archiveMappingSHA256':'a','workNamespace':str(self.root/'work'),'MCPOrModelArgumentAuthority':False};file.write_text(json.dumps(value));file.chmod(0o400)
  # Physical owner refusal is real under this nonroot test UID.
  if os.getuid()!=0:
   with self.assertRaisesRegex(ValueError,'root-owned'):A.validate_operator_grant(file,'x','p',{'r':'1'},'c','h','a',self.root/'work')
  fake_fstat=root_owned_descriptor(file)
  def call():return A.validate_operator_grant(file,hashlib.sha256(file.read_bytes()).hexdigest(),'p',{'r':'1'},'c','h','a',self.root/'work')
  with mock.patch.object(A.os,'fstat',fake_fstat):
   self.assertEqual(value,call())
   for key,bad in [('MCPOrModelArgumentAuthority',True),('hostReceiptSHA256','other'),('runContext',{'r':'2'}),('archiveMappingSHA256','other'),('workNamespace','/other'),('controllerCodeSHA256','other')]:
    altered={**value,key:bad};file.chmod(0o600);file.write_text(json.dumps(altered));file.chmod(0o400)
    with self.assertRaises(ValueError):call()
  file.chmod(0o600);file.write_text(json.dumps(value));file.chmod(0o444)
  with mock.patch.object(A.os,'fstat',fake_fstat),self.assertRaisesRegex(ValueError,'root-owned'):call()
 def test_sequence_original_retry_order_and_shutdown(self):
  calls=[];slept=[];prepares=[1,2,0]
  def run(args,cwd,seconds):calls.append(args);return prepares.pop(0) if args==['make','prepare'] else 0
  value=S.run_sequence(self.p,self.root,'/synthetic/sccache',self.root/'report',run,sleep=slept.append);self.assertTrue(value['originalCommandsComplete']);self.assertEqual([self.p['configure'],self.p['prepare'],self.p['prepare'],self.p['prepare'],self.p['dist'],['/synthetic/sccache','--stop-server']],calls);self.assertEqual([1,2],slept)
 def test_sequence_exhaustion_failed_configure_and_cache_stop(self):
  for failing in ['configure','prepare','cache']:
   calls=[];report=self.root/failing
   def run(args,cwd,seconds):calls.append(args);return 1 if (failing=='configure' and args==self.p['configure']) or (failing=='prepare' and args==self.p['prepare']) or (failing=='cache' and args[-1]=='--stop-server') else 0
   value=S.run_sequence(self.p,self.root,'/synthetic/sccache',report,run,sleep=lambda _:None);self.assertFalse(value['originalCommandsComplete']);self.assertEqual(5 if failing=='prepare' else (0 if failing=='configure' else 1),calls.count(self.p['prepare']));self.assertEqual([''+'/synthetic/sccache','--stop-server'],calls[-1]);self.assertEqual(failing=='cache',self.p['dist'] in calls)
 def test_sequence_late_zero_and_timeout_do_not_retry(self):
  now=[0];calls=[]
  def clock():return now[0]
  def late(args,cwd,seconds):calls.append(args);now[0]=self.p['bounds']['nativeSeconds']+1;return 0
  value=S.run_sequence(self.p,self.root,'cache',self.root/'late',late,clock=clock);self.assertFalse(value['originalCommandsComplete']);self.assertNotIn(self.p['prepare'],calls)
  def timeout(args,cwd,seconds):calls.append(args);raise TimeoutError('synthetic deadline')
  value=S.run_sequence(self.p,self.root,'cache',self.root/'timeout',timeout);self.assertFalse(value['originalCommandsComplete']);self.assertEqual('TimeoutError',value['failure']['type'])
 def test_volume_finite_plan_exact_identity_and_context(self):
  context={'run':'123','attempt':'1','head':'a'*40};calls=[]
  def run(args,seconds):
   calls.append(args)
   if args[1]=='create':Path(args[-1]).write_bytes(b'synthetic image')
   return {'imagePath':str(self.root/'source-work.sparseimage'),'mountPoint':str(self.root/'case-work'),'device':'/dev/disk42s1','ownedAttachmentAbsent':True}
  record=V.prepare(self.root,context,run,probe=lambda _: {'caseSensitive':True});self.assertIn('JHFS+X',calls[0]);self.assertEqual('40g',calls[0][calls[0].index('-size')+1]);current={'imagePath':record['image'],'mountPoint':record['mount'],'device':record['device']};self.assertTrue(V.detach_owned(record,context,run,current)['detachedOwnedImage']);self.assertEqual(['/usr/bin/hdiutil','detach',record['mount']],calls[-1])
  for changed in [{**current,'device':'/dev/disk9'},{**current,'imagePath':'/other'}]:
   with self.assertRaises(ValueError):V.detach_owned(record,context,run,changed)
  with self.assertRaises(ValueError):V.detach_owned(record,{**context,'attempt':'2'},run,current)
 def test_volume_refuses_case_collapse_and_unrelated_device(self):
  for mode in ['case','device']:
   root=self.root/mode;root.mkdir()
   def run(args,seconds):
    if args[1]=='create':Path(args[-1]).write_bytes(b'x')
    return {'imagePath':str(root/'source-work.sparseimage'),'mountPoint':str(root/'case-work'),'device':'/dev/disk4' if mode=='case' else '/dev/disk4;rm'}
   with self.assertRaises(ValueError):V.prepare(root,{'run':'1','attempt':'1'},run,probe=lambda _:{'caseSensitive':False})
 def test_phase_passes_revoked_when_outer_incomplete(self):
  child={'originalCommandsComplete':True,'phases':[{'phase':n,'status':'command-passed','exitCode':0} for n in ['configure','prepare-attempt-1','original-dist']]};self.assertTrue(all(r['status']=='command-passed' for r in P.phase_summary(child,True).values()));self.assertTrue(all(r['status']=='incomplete' for r in P.phase_summary(child,False).values()))
 def test_environment_does_not_inherit_tokens_or_compiler_override(self):
  h=qualified(self.p)
  with mock.patch.dict(os.environ,{'SECRET_TOKEN':'secret','RUSTC':'/ambient/rustc','CARGO':'/ambient/cargo'}):env=P.clean_environment(self.root,self.root,h,self.p)
  self.assertFalse(any(k in env for k in ['SECRET_TOKEN','RUSTC','CARGO']));self.assertEqual('true',env['CARGO_NET_OFFLINE']);self.assertEqual('1',env['DIST_REQUIRE_ALL_TOOLS']);self.assertEqual('llvm,cranelift',env['CODEGEN_BACKENDS'])
 def test_observe_rejects_ineligible_host_before_any_workspace_write(self):
  class NoOperations:
   def __getattr__(self,name):raise AssertionError('must not reach '+name)
  work=self.root/'rust198-1-1-synthetic';h=qualified(copy.deepcopy(self.p))
  with self.assertRaisesRegex(ValueError,'sccache'):P.observe(self.p,h,{},work,{'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1'},NoOperations())
  self.assertFalse(work.exists())
 def test_retention_whole_success_readback_every_body(self):
  root=self.root/'outputs';root.mkdir();(root/'a').write_bytes(b'alpha');(root/'b').write_bytes(b'beta');limits={'captureBytes':2*1024**2,'captureFiles':2};result=R.retain_private({'dist':root},self.root/'out.tar',limits,{'allBuildUidProcessesStopped':True});self.assertEqual(2,result['membersVerified']);self.assertTrue(result['allMemberBodiesRehashed']);self.assertFalse(result['encryptionOrExportPerformed']);self.assertEqual(0o400,stat.S_IMODE((self.root/'out.tar').stat().st_mode))
 def test_retention_quiescence_alias_hardlink_and_prewrite_budget(self):
  root=self.root/'outputs';root.mkdir();(root/'a').write_bytes(b'alpha');limits={'captureBytes':2*1024**2,'captureFiles':2}
  with self.assertRaisesRegex(ValueError,'quiescence'):R.retain_private({'dist':root},self.root/'q',limits,{'allBuildUidProcessesStopped':False})
  with self.assertRaisesRegex(ValueError,'TAR'):R.retain_private({'dist':root},self.root/'budget',{'captureBytes':10,'captureFiles':2},{'allBuildUidProcessesStopped':True})
  self.assertFalse((self.root/'budget.unaccepted').exists());os.link(root/'a',root/'hard')
  with self.assertRaisesRegex(ValueError,'single-link'):R.catalog({'dist':root},limits)
  (root/'hard').unlink();(root/'link').symlink_to('a')
  with self.assertRaisesRegex(ValueError,'single-link'):R.catalog({'dist':root},limits)
 def test_retention_detects_same_size_mutant_and_late_zero(self):
  row={'bytes':5,'sha256':hashlib.sha256(b'alpha').hexdigest()};import io
  reader=R.HashedReader(io.BytesIO(b'bravo'),row,lambda:0,1);reader.read(5)
  with self.assertRaisesRegex(ValueError,'changed'):reader.finish()
  file=self.root/'data';file.write_bytes(b'x');calls=[0]
  def clock():calls[0]+=1;return 0 if calls[0]<4 else 601
  with self.assertRaisesRegex(ValueError,'deadline'):R.retain_private({'dist':self.root},self.root/'late.tar',{'captureBytes':2*1024**2,'captureFiles':5},{'allBuildUidProcessesStopped':True},clock)
  self.assertFalse((self.root/'late.tar').exists())
 def test_native_rejects_unknown_network_before_process_probe(self):
  with mock.patch.object(N,'ps_rows',side_effect=AssertionError('unqualified host cannot invoke ps')):
   with self.assertRaisesRegex(ValueError,'network'):N.Native(self.root,{'buildUid':99})
 def test_host_metadata_fixture_no_sdk_or_source_execution(self):
  developer=self.root/'Xcode.app/Contents/Developer';sdk=developer/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.2.sdk';sdk.mkdir(parents=True);(sdk/'SDKSettings.json').write_text('{"Version":"26.2"}');(sdk.parent/'MacOSX.sdk').symlink_to(sdk.name);(developer.parent/'Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'26.2'}));(developer.parent/'version.plist').write_bytes(plistlib.dumps({'ProductBuildVersion':'synthetic'}));license=developer.parent/'Resources/en.lproj/License.rtf';license.parent.mkdir(parents=True);license.write_bytes(b'{synthetic original SLA}');tool=self.root/'tool';tool.write_bytes(b'synthetic tool bytes, never executed');tool.chmod(0o755)
  with mock.patch.object(H.shutil,'which',return_value=str(tool)),mock.patch.object(H.subprocess,'run',side_effect=AssertionError('no executable permitted')):value=H.collect_metadata(developer,self.root/'metadata',{'test':'synthetic'},lambda:{'CPUs':3,'RAMBytes':7*A.GIB,'macOS':'15.8.2'})
  self.assertEqual('26.2',value['xcodeVersion']);self.assertEqual(14,len(value['tools']));self.assertTrue(value['originalSLATextRetained']);self.assertFalse(value['SLABodyRootReviewed']);self.assertFalse(value['nativeAdmissionGranted']);self.assertFalse(value['SDKCompilerOrSourceExecuted']);self.assertFalse(value['allDeclaredSDKToolBytesHashed'])

 def test_whole_observe_success_and_source_uid_native_failure_family(self):
  context={'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40};p=self.p;h=qualified(p)
  class SyntheticOps:
   def __init__(self,mode):self.mode=mode;self.started=False;self.detached=False
   def processes(self):return [{'uid':h['buildUid'],'pid':7}] if self.mode=='survivor' and self.started else []
   def volume(self,work,ctx,host):
    vc={'run':ctx['GITHUB_RUN_ID'],'attempt':ctx['GITHUB_RUN_ATTEMPT'],'head':ctx['GITHUB_SHA']}
    def run(args,seconds):
     if args[1]=='create':Path(args[-1]).write_bytes(b'synthetic inert image')
     return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk42s1'}
    return V.prepare(work,vc,run,probe=lambda _:{'caseSensitive':True})
   def materialize(self,pins,archives,destination):
    destination.mkdir();source=destination/'source';source.mkdir();file=source/'original.txt';file.write_bytes(b'synthetic source fixture');file.chmod(0o644);self.source=source;self.records=[{'path':'original.txt','type':'regular','mode':0o644,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}];membermap=destination/'original-source-members.json';membermap.write_text(json.dumps(self.records));return {'source':str(source),'memberMap':str(membermap)}
   def activate(self,source,host):pass
   def native(self,work,host):
    outer=self
    class SyntheticNative:
     receipts=[{'syntheticOnly':True}]
     def run(self,name,argv,env,cwd,seconds):
      outer.started=True
      if outer.mode=='native-failure':raise TimeoutError('synthetic phase deadline')
      (cwd/'bootstrap.toml').write_text("profile='dist'\n# synthetic configuration only\n");dist=cwd/'build/dist';dist.mkdir(parents=True)
      for filename in p['minimumSDKArtifactNames']:(dist/filename).write_bytes(b'synthetic output, no SDK executed')
      if outer.mode=='source-mutant':(cwd/'original.txt').write_bytes(b'mutant')
      Path(argv[-1]).write_text(json.dumps({'originalCommandsComplete':True,'failure':None,'cacheStopExitCode':0,'phases':[{'phase':name,'argv':P.phase_command(p,name),'status':'command-passed','exitCode':0} for name in ['configure','prepare-attempt-1','original-dist']]}))
    return SyntheticNative()
   def source_matches(self,source,records):return P.M.original_frame_matches(source,records)
   def detach(self,record,ctx,host,work):
    self.detached=True;vc={'run':ctx['GITHUB_RUN_ID'],'attempt':ctx['GITHUB_RUN_ATTEMPT'],'head':ctx['GITHUB_SHA']};current={'imagePath':record['image'],'mountPoint':record['mount'],'device':record['device']};return V.detach_owned(record,vc,lambda *_:{'ownedAttachmentAbsent':True},current)
  for mode in ['success','source-mutant','survivor','native-failure']:
   ops=SyntheticOps(mode);work=self.root/('rust198-1-1-synthetic-'+mode);old_umask=os.umask(0o077)
   try:result=P.observe(p,h,{},work,context,ops)
   finally:os.umask(old_umask)
   self.assertEqual(0o755,stat.S_IMODE(work.stat().st_mode));self.assertEqual(0o755,stat.S_IMODE((work/'control').stat().st_mode));self.assertEqual(0o700,stat.S_IMODE((work/'capture').stat().st_mode));self.assertEqual(mode=='success',result['originalCommandBuildWitnessComplete']);self.assertFalse(result['wholeProducerSDKLegalHistoricalEqualityOrGateAClosureClaimed']);self.assertEqual(mode!='survivor',result['quiescence']['allBuildUidProcessesStopped']);lifecycle=P.finish_private(p,result,work,context,h,ops);self.assertEqual(mode=='success',lifecycle['controllerLifecycleComplete']);self.assertEqual(mode!='survivor',ops.detached)
   if mode!='success':self.assertTrue(all(row['status']=='incomplete' for row in result['phaseAccounting'].values()))
 def test_private_lifecycle_rejects_wrong_context_and_whole_deadline(self):
  work=self.root/'owned';(work/'control').mkdir(parents=True);(work/'control/OWNERSHIP.json').write_text(json.dumps({'runContext':{'run':'1'},'work':str(work),'selection':self.p['selection']}))
  with self.assertRaisesRegex(ValueError,'marker'):P.finish_private(self.p,{},work,{'run':'2'},{},object())
  result={'originalCommandBuildWitnessComplete':False,'elapsedSeconds':self.p['bounds']['wholeSeconds'],'failure':{'type':'WholeDeadline'}};value=P.finish_private(self.p,result,work,{'run':'1'},{},object());self.assertFalse(value['privateRetentionComplete']);self.assertFalse(value['controllerLifecycleComplete']);self.assertFalse((work/'PRIVATE-OUTPUTS.tar').exists())
 def test_real_firstparty_process_limits_and_cleanup(self):
  # Only a first-party Python one-liner is executed, never upstream/SDK code.
  h=qualified(self.p);h['buildUid']=os.getuid()+1_000_000;(self.root/'capture').mkdir();limits={**N.LIMITS,'minimumFreeBytes':0,'logBytes':64,'sampledRssBytes':A.GIB,'wholeSeconds':30}
  with mock.patch.dict(N.LIMITS,limits),mock.patch.object(N,'ps_rows',return_value=[]):
   native=N.Native(self.root,h);record=native.run('synthetic-pass',[sys.executable,'-I','-c',"print('synthetic')"],{'PATH':'/usr/bin:/bin'},self.root,5,as_build=False);self.assertTrue(record['success']);self.assertEqual(os.getuid(),record['uid']);self.assertEqual([],record['unreapedBuildUidProcesses'])
   with self.assertRaisesRegex(ValueError,'log ceiling'):native.run('synthetic-flood',[sys.executable,'-I','-c',"print('x'*1000)"],{'PATH':'/usr/bin:/bin'},self.root,5,as_build=False)
   with self.assertRaisesRegex(ValueError,'deadline'):native.run('synthetic-timeout',[sys.executable,'-I','-c','import time;time.sleep(2)'],{'PATH':'/usr/bin:/bin'},self.root,0.05,as_build=False)
   self.assertEqual(3,len(native.receipts));self.assertFalse(native.receipts[1]['success']);self.assertFalse(native.receipts[2]['success']);self.assertTrue(all(not r['unreapedBuildUidProcesses'] for r in native.receipts))

 def test_retention_late_readback_preserves_unaccepted_only(self):
  outputs=self.root/'outputs';outputs.mkdir();(outputs/'a').write_bytes(b'alpha');now=[0]
  def late(*args,**kwargs):now[0]=601;return {'bytes':10240,'sha256':'0'*64,'membersVerified':1,'allMemberBodiesRehashed':True}
  with mock.patch.object(R,'readback_private',late),self.assertRaisesRegex(ValueError,'Late private archive readback'):R.retain_private({'dist':outputs},self.root/'late-result.tar',{'captureBytes':2*1024**2,'captureFiles':1},{'allBuildUidProcessesStopped':True},clock=lambda:now[0])
  self.assertFalse((self.root/'late-result.tar').exists());self.assertTrue((self.root/'late-result.tar.unaccepted').is_file())
 def test_host_metadata_read_refuses_symlink_and_changed_tool(self):
  body=self.root/'body';body.write_bytes(b'synthetic');link=self.root/'link';link.symlink_to(body)
  with self.assertRaisesRegex(ValueError,'physical'):H.bounded_read(link,100)
  body.chmod(0o644)
  with self.assertRaisesRegex(ValueError,'executable'):H.hash_tool(body,float('inf'))
  body.chmod(0o755)
  with self.assertRaisesRegex(ValueError,'deadline'):H.hash_tool(body,0)

 def test_frozen_cohort_binding_detects_hash_mode_extra_and_symlink(self):
  root=self.root/'readonly';root.mkdir();code=root/'producer.py';code.write_bytes(b'first-party synthetic code');code.chmod(0o444);manifest=root/'COHORT.json';rows=[{'file':code.name,'bytes':code.stat().st_size,'sha256':hashlib.sha256(code.read_bytes()).hexdigest()}];manifest.write_text(json.dumps(rows));manifest.chmod(0o444);root.chmod(0o555);sha=hashlib.sha256(manifest.read_bytes()).hexdigest();original=Path.stat;original_lstat=Path.lstat
  def root_owner(s):v=list(s);v[4]=0;return os.stat_result(v,{'st_mtime_ns':s.st_mtime_ns,'st_ctime_ns':s.st_ctime_ns})
  def fake_stat(p,*args,**kwargs):return root_owner(original(p,*args,**kwargs))
  def fake_lstat(p,*args,**kwargs):return root_owner(original_lstat(p,*args,**kwargs))
  def fake_fstat(fd):return root_owner(original_fstat(fd))
  original_fstat=os.fstat
  with mock.patch.object(Path,'stat',fake_stat),mock.patch.object(Path,'lstat',fake_lstat),mock.patch.object(L.os,'fstat',fake_fstat):
   self.assertEqual(rows,L.verify(root,manifest,sha))
   with self.assertRaisesRegex(ValueError,'manifest hash'):L.verify(root,manifest,'0'*64)
   code.chmod(0o600)
   with self.assertRaisesRegex(ValueError,'mode'):L.verify(root,manifest,sha)
   code.chmod(0o444);root.chmod(0o755);(root/'extra.py').write_bytes(b'new');root.chmod(0o555)
   with self.assertRaisesRegex(ValueError,'unexpected'):L.verify(root,manifest,sha)
  root.chmod(0o755)

 def test_generated_configuration_precedence_physical_and_no_false_equality(self):
  capture=self.root/'capture';capture.mkdir()
  with self.assertRaisesRegex(ValueError,'absent'):P.retain_generated_configuration(self.root,capture)
  (self.root/'config.toml').write_text("profile='dist'\n");(self.root/'bootstrap.toml').write_text("profile='synthetic-first'\n");value=P.retain_generated_configuration(self.root,capture);self.assertTrue(value['originalWorkingPath'].endswith('/bootstrap.toml'));self.assertFalse(value['semanticEqualityToPublisherBuilderConfigClaimed']);self.assertTrue(value['rootSemanticAndDefaultReviewStillRequired']);(capture/'generated-original-bootstrap.toml').unlink();(self.root/'bootstrap.toml').unlink();(self.root/'bootstrap.toml').symlink_to('config.toml')
  with self.assertRaisesRegex(ValueError,'Physical'):P.retain_generated_configuration(self.root,capture)

 def test_materialization_actual_free_reserve_guard_arms_independently_of_file_cap(self):
  from types import SimpleNamespace
  limits={**self.p['bounds'],'materializationCapacityRoots':[self.root]};budget=P.M.PassBudget({'decoded':0},float('inf'),limits)
  with mock.patch.object(P.M.shutil,'disk_usage',return_value=SimpleNamespace(free=limits['minimumFreeBytes']-1)),self.assertRaisesRegex(ValueError,'free-space'):budget.check()
  with mock.patch.object(P.M.shutil,'disk_usage',return_value=SimpleNamespace(free=limits['minimumFreeBytes'])):budget.check()
 def test_native_two_row_aggregate_rss_and_initial_disk_reserve(self):
  from types import SimpleNamespace
  h=qualified(self.p);h['buildUid']=os.getuid()+1_000_000;(self.root/'capture').mkdir();limits={**N.LIMITS,'minimumFreeBytes':0,'logBytes':1024,'sampledRssBytes':64*1024,'wholeSeconds':30};rows=[{'uid':h['buildUid'],'pid':1,'pgid':0,'rssKiB':36},{'uid':h['buildUid'],'pid':2,'pgid':0,'rssKiB':36}];calls=[0]
  def observed():calls[0]+=1;return rows if calls[0]==2 else []
  with mock.patch.dict(N.LIMITS,limits),mock.patch.object(N,'ps_rows',side_effect=observed):
   native=N.Native(self.root,h)
   with self.assertRaisesRegex(ValueError,'RSS ceiling'):native.run('synthetic-rss',[sys.executable,'-I','-c',"print('synthetic')"],{'PATH':'/usr/bin:/bin'},self.root,5,as_build=False)
   self.assertEqual(72*1024,native.receipts[0]['sampledAggregateRssBytes']);self.assertFalse(native.receipts[0]['success'])
  with mock.patch.object(N,'ps_rows',return_value=[]),mock.patch.object(N.shutil,'disk_usage',return_value=SimpleNamespace(free=N.LIMITS['minimumFreeBytes']-1)),mock.patch.object(N.subprocess,'Popen',side_effect=AssertionError('must refuse before spawn')):
   native=N.Native(self.root,h)
   with self.assertRaisesRegex(ValueError,'capacity'):native.run('synthetic-disk',[sys.executable,'-I','-c','pass'],{},self.root,5,as_build=False)

class SyntheticProducerOps:
 """Synthetic stand-in for the build-UID child; it only writes fixture files."""
 def __init__(self,p,h,report,artifacts,exit_failure=None,survivor=False):self.p=p;self.h=h;self.report=report;self.artifacts=artifacts;self.exit_failure=exit_failure;self.survivor=survivor;self.started=False;self.detached=False
 def processes(self):return [{'uid':self.h['buildUid'],'pid':7}] if self.survivor and self.started else []
 def volume(self,work,ctx,host):
  vc={'run':ctx['GITHUB_RUN_ID'],'attempt':ctx['GITHUB_RUN_ATTEMPT'],'head':ctx['GITHUB_SHA']}
  def run(args,seconds):
   if args[1]=='create':Path(args[-1]).write_bytes(b'synthetic inert image')
   return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk42s1'}
  return V.prepare(work,vc,run,probe=lambda _:{'caseSensitive':True})
 def materialize(self,pins,archives,destination):
  destination.mkdir();source=destination/'source';source.mkdir();file=source/'original.txt';file.write_bytes(b'synthetic source fixture');file.chmod(0o644);records=[{'path':'original.txt','type':'regular','mode':0o644,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}];membermap=destination/'original-source-members.json';membermap.write_text(json.dumps(records));return {'source':str(source),'memberMap':str(membermap)}
 def activate(self,source,host):pass
 def native(self,work,host):
  outer=self
  class SyntheticNative:
   receipts=[{'syntheticOnly':True}]
   def run(self,name,argv,env,cwd,seconds):
    outer.started=True;(cwd/'bootstrap.toml').write_text("profile='dist'\n# synthetic configuration only\n");dist=cwd/'build/dist';dist.mkdir(parents=True)
    for filename,body in outer.artifacts.items():(dist/filename).write_bytes(body)
    Path(argv[-1]).write_bytes(outer.report)
    # Native.run() raises on any nonzero child exit, after the child wrote its report.
    if outer.exit_failure:raise ValueError(outer.exit_failure)
  return SyntheticNative()
 def source_matches(self,source,records):return P.M.original_frame_matches(source,records)
 def detach(self,record,ctx,host,work):
  self.detached=True;vc={'run':ctx['GITHUB_RUN_ID'],'attempt':ctx['GITHUB_RUN_ATTEMPT'],'head':ctx['GITHUB_SHA']};current={'imagePath':record['image'],'mountPoint':record['mount'],'device':record['device']};return V.detach_owned(record,vc,lambda *_:{'ownedAttachmentAbsent':True},current)

class ProducerEvidenceTests(unittest.TestCase):
 context={'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40}
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.p=profile();self.h=qualified(self.p);self.count=0
 def tearDown(self):self.temp.cleanup()
 def report(self,rows,complete=False,failure=None,cache=0,argv=None):return json.dumps({'originalCommandsComplete':complete,'phases':[{'phase':n,'argv':(argv or {}).get(n,P.phase_command(self.p,n)),'exitCode':c,'status':'command-passed' if c==0 else 'command-failed'} for n,c in rows],'failure':failure if complete or failure else {'type':'ValueError','reason':'synthetic'},'cacheStopExitCode':cache}).encode()
 def artifacts(self,empty=None):return {name:(b'' if name==empty else ('synthetic archive %d for %s' % (4096+i,name)).encode()) for i,name in enumerate(self.p['minimumSDKArtifactNames'])}
 def observe(self,ops):
  self.count+=1;work=self.root/('rust198-1-1-synthetic-evidence-'+str(self.count));old_umask=os.umask(0o077)
  try:result=P.observe(self.p,self.h,{},work,self.context,ops)
  finally:os.umask(old_umask)
  return result,P.finish_private(self.p,result,work,self.context,self.h,ops)
 def staged_child(self,loader=None):
  argv=[];outer=self
  class Recording(SyntheticProducerOps):
   def native(self,work,host):
    inner=super().native(work,host);run=inner.run
    class Recorder:
     receipts=inner.receipts
     def run(self,name,args,env,cwd,seconds):argv.append(args);return run(name,args,env,cwd,seconds)
    return Recorder()
  ops=Recording(self.p,self.h,self.report([('configure',0),('prepare-attempt-1',0),('original-dist',0)],complete=True,failure=None),self.artifacts())
  with contextlib.ExitStack() as stack:
   if loader:stack.enter_context(mock.patch.object(P,'__loader__',loader))
   result,_=self.observe(ops)
  self.assertTrue(result['originalCommandBuildWitnessComplete']);self.assertEqual(1,len(argv));script=Path(argv[0][3]);folder=script.parent
  self.assertEqual(('sequence.py',self.root/('rust198-1-1-synthetic-evidence-'+str(self.count))/'control/child'),(script.name,folder))
  self.assertEqual(0o755,stat.S_IMODE(folder.stat().st_mode));self.assertEqual({'sequence.py':0o444,'admission.py':0o444},{f.name:stat.S_IMODE(f.stat().st_mode) for f in folder.iterdir()})
  return {f.name:f.read_bytes() for f in folder.iterdir()}
 def test_build_child_runs_copies_of_the_bytes_the_controller_loader_holds(self):
  held={'sequence.py':b'# held sequence bytes 6151\n','admission.py':b'# held admission bytes 6151\n'}
  self.assertEqual(held,self.staged_child(VerifiedLoaderStub(held)))
 def test_build_child_copies_match_the_controller_files_when_unchanged(self):
  self.assertEqual({name:(HERE/name).read_bytes() for name in ['sequence.py','admission.py']},self.staged_child())
 def test_failed_sequence_keeps_actual_command_exit_and_stays_failed(self):
  for rows,failed,code in [([('configure',0),('prepare-attempt-1',0),('original-dist',137)],'original-dist',137),([('configure',23)],'configure',23),([('configure',0),('prepare-attempt-1',0),('original-dist',-9)],'original-dist',-9)]:
   with self.subTest(failed=failed):
    ops=SyntheticProducerOps(self.p,self.h,self.report(rows),self.artifacts(),exit_failure='Native phase failed: original-source-producer');result,lifecycle=self.observe(ops);phases=result['phaseAccounting']
    self.assertEqual({'status':'command-failed','exitCode':code},phases[failed]);self.assertEqual({'accepted':True},result['failurePathChildReport'])
    self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertIn('Native phase failed',result['failure']['reason']);self.assertFalse(lifecycle['controllerLifecycleComplete']);self.assertNotIn('command-passed',[row['status'] for row in phases.values()])
    for name,_ in rows:
     key='prepare' if name.startswith('prepare') else name
     if key!=failed:self.assertEqual({'status':'incomplete','exitCode':0,'reason':'outer completion/quiescence not qualified'},phases[key])
    if failed=='configure':self.assertEqual({'status':'incomplete','reason':'not-established'},phases['original-dist'])
 def test_failure_path_report_refused_when_malformed_oversized_forged_or_not_quiescent(self):
  valid=self.report([('configure',0),('prepare-attempt-1',0),('original-dist',137)]);padding=P.CHILD_REPORT_BYTES+1-len(valid)
  cases={'malformed':(b'{"phases":[{"phase":"original-dist"',False),'oversized':(valid[:-1]+b',"padding":"'+b'x'*(padding-13)+b'"}',False),'string-exit':(valid.replace(b'"exitCode": 137',b'"exitCode": "137"'),False),'pass-with-failed-exit':(valid.replace(b'"command-failed"',b'"command-passed"'),False),'unknown-phase':(valid.replace(b'original-dist',b'synthetic-extra'),False),'dist-after-failed-configure':(self.report([('configure',23),('original-dist',137)]),False),'dist-before-any-prepare':(self.report([('configure',0),('original-dist',137)]),False),'skipped-prepare-attempt':(self.report([('configure',0),('prepare-attempt-2',0),('original-dist',137)]),False),'exit-beyond-status-byte':(self.report([('configure',256)]),False),'build-uid-still-live':(valid,True)}
  self.assertGreater(len(cases['oversized'][0]),P.CHILD_REPORT_BYTES);self.assertIn(b'"exitCode": "137"',cases['string-exit'][0]);self.assertIn(b'"exitCode": 137',valid)
  for label,(body,survivor) in cases.items():
   with self.subTest(case=label):
    ops=SyntheticProducerOps(self.p,self.h,body,self.artifacts(),exit_failure='Native phase failed: original-source-producer',survivor=survivor);result,lifecycle=self.observe(ops)
    self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertFalse(lifecycle['controllerLifecycleComplete']);self.assertIn('Native phase failed',result['failure']['reason'])
    self.assertEqual({name:{'status':'incomplete','reason':'not-established'} for name in ['configure','prepare','original-dist']},result['phaseAccounting'])
    if survivor:self.assertIsNone(result['failurePathChildReport'])
    else:self.assertFalse(result['failurePathChildReport']['accepted'])
 def test_interrupted_prepare_retry_is_not_attributed_to_the_earlier_exit(self):
  timeout={'type':'TimeoutError','reason':'synthetic retry deadline 5813'}
  for rows,later in [([('configure',0),('prepare-attempt-1',37)],True),([('configure',0)]+[('prepare-attempt-'+str(n),37) for n in range(1,6)],False)]:
   with self.subTest(attempts=len(rows)-1):
    ops=SyntheticProducerOps(self.p,self.h,self.report(rows,failure=timeout),self.artifacts(),exit_failure='Native phase failed: original-source-producer');result,lifecycle=self.observe(ops)
    self.assertEqual({'status':'command-failed','exitCode':37,'attempt':len(rows)-1,'laterAttemptWithoutExitCode':later},result['phaseAccounting']['prepare']);self.assertEqual(timeout,result['childFailure'])
    self.assertEqual({'status':'incomplete','reason':'not-established'},result['phaseAccounting']['original-dist']);self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertFalse(lifecycle['controllerLifecycleComplete'])
 def test_complete_report_without_every_passing_phase_is_refused(self):
  passed=[('configure',0),('prepare-attempt-1',0),('original-dist',0)];shutdown={'type':'ValueError','reason':'Owned cache shutdown failed'}
  for label,body,message in [('no-rows',self.report([],complete=True),'history impossible'),('no-dist',self.report(passed[:2],complete=True),'history impossible'),('failed-dist',self.report([*passed[:2],('original-dist',137)],complete=True),'history impossible'),('cache-shutdown-failed',self.report(passed,complete=True,failure=shutdown,cache=1),'cache shutdown'),('cache-exit-only',self.report(passed,complete=True,cache=1),'cache shutdown')]:
   with self.subTest(case=label):
    ops=SyntheticProducerOps(self.p,self.h,body,self.artifacts());result,lifecycle=self.observe(ops)
    self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertIn(message,result['failure']['reason']);self.assertFalse(lifecycle['controllerLifecycleComplete']);self.assertNotIn('command-passed',[row['status'] for row in result['phaseAccounting'].values()])
 def test_failure_path_report_at_exact_byte_bound_is_still_read(self):
  valid=self.report([('configure',0),('prepare-attempt-1',0),('original-dist',137)]);body=valid[:-1]+b',"padding":"'+b'x'*(P.CHILD_REPORT_BYTES-len(valid)-13)+b'"}';self.assertEqual(P.CHILD_REPORT_BYTES,len(body))
  ops=SyntheticProducerOps(self.p,self.h,body,self.artifacts(),exit_failure='Native phase failed: original-source-producer');result,lifecycle=self.observe(ops)
  self.assertEqual({'status':'command-failed','exitCode':137},result['phaseAccounting']['original-dist']);self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertFalse(lifecycle['controllerLifecycleComplete'])
 def test_successful_sequence_records_passes_without_failure_path_read(self):
  for label,rows in [('first-prepare',[('configure',0),('prepare-attempt-1',0),('original-dist',0)]),('retried-prepare',[('configure',0),('prepare-attempt-1',2),('prepare-attempt-2',2),('prepare-attempt-3',0),('original-dist',0)])]:
   with self.subTest(case=label):
    ops=SyntheticProducerOps(self.p,self.h,self.report(rows,complete=True),self.artifacts());result,lifecycle=self.observe(ops)
    self.assertTrue(result['originalCommandBuildWitnessComplete']);self.assertIsNone(result['failure']);self.assertIsNone(result['failurePathChildReport']);self.assertIsNone(result['childFailure']);self.assertEqual({name:{'status':'command-passed','exitCode':0} for name in ['configure','prepare','original-dist']},result['phaseAccounting']);self.assertTrue(lifecycle['controllerLifecycleComplete'])
    self.assertEqual(sorted(len(body) for body in self.artifacts().values()),sorted(r['bytes'] for r in result['producedDistInventory']))
 def test_empty_required_archive_beside_nonempty_siblings_is_not_a_witness(self):
  for empty in self.p['minimumSDKArtifactNames']:
   with self.subTest(empty=empty):
    ops=SyntheticProducerOps(self.p,self.h,self.report([('configure',0),('prepare-attempt-1',0),('original-dist',0)],complete=True),self.artifacts(empty));result,lifecycle=self.observe(ops)
    self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertIn('outputs empty',result['failure']['reason']);self.assertFalse(lifecycle['controllerLifecycleComplete'])
    self.assertEqual(1,sum(1 for body in self.artifacts(empty).values() if body==b''))

 def expected_argv(self,name):return {'configure':self.p['configure'],'original-dist':self.p['dist']}.get(name,self.p['prepare'])
 def assert_refused(self,body,message,failed_exit):
  ops=SyntheticProducerOps(self.p,self.h,body,self.artifacts(),exit_failure='Native phase failed: original-source-producer' if failed_exit else None);result,lifecycle=self.observe(ops)
  self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertFalse(lifecycle['controllerLifecycleComplete'])
  self.assertEqual({name:{'status':'incomplete','reason':'not-established'} for name in ['configure','prepare','original-dist']},result['phaseAccounting']);self.assertIsNone(result['childFailure'])
  # A refused success-path read leaves no accepted child, so the report is read
  # once more after quiescence and refused there too.
  self.assertFalse(result['failurePathChildReport']['accepted']);self.assertIn(message,result['failurePathChildReport']['reason'])
  self.assertIn('Native phase failed: original-source-producer' if failed_exit else message,result['failure']['reason'])
 def test_phase_rows_carry_exactly_the_validated_profile_commands(self):
  self.assertEqual(37,len(self.p['configure']));rows=[('configure',0),('prepare-attempt-1',29),('prepare-attempt-2',0),('original-dist',0)]
  for name,_ in rows:self.assertEqual(self.expected_argv(name),P.phase_command(self.p,name))
  self.assertEqual(self.p['configure'],json.loads(self.report(rows))['phases'][0]['argv'])
  ops=SyntheticProducerOps(self.p,self.h,self.report(rows,complete=True),self.artifacts());result,lifecycle=self.observe(ops)
  self.assertTrue(result['originalCommandBuildWitnessComplete']);self.assertEqual({'status':'command-passed','exitCode':0},result['phaseAccounting']['configure']);self.assertTrue(lifecycle['controllerLifecycleComplete'])
 def test_forged_phase_argv_is_refused_on_success_and_failure_paths(self):
  forged={'appended-flag':lambda n:[*self.expected_argv(n),'--synthetic-forged-5813'],'other-phase-command':lambda n:self.p['dist'] if n=='configure' else self.p['configure'],'dropped-last-argument':lambda n:self.expected_argv(n)[:-1],'string-not-list':lambda n:' '.join(self.expected_argv(n)),'absent':lambda n:None}
  paths={'success':([('configure',0),('prepare-attempt-1',0),('original-dist',0)],True,False),'failure':([('configure',0),('prepare-attempt-1',0),('original-dist',137)],False,True)}
  for path,(rows,complete,failed_exit) in paths.items():
   for target in ['configure','prepare-attempt-1','original-dist']:
    for label,make in forged.items():
     with self.subTest(path=path,phase=target,forgery=label):
      body=json.loads(self.report(rows,complete=complete));row=next(r for r in body['phases'] if r['phase']==target)
      if label=='absent':del row['argv']
      else:row['argv']=make(target)
      self.assertNotEqual(self.expected_argv(target),row.get('argv'))
      self.assert_refused(json.dumps(body).encode(),'argv differs from validated profile command',failed_exit)
 def test_failed_report_without_failure_or_cache_shutdown_fields_is_refused(self):
  rows=[('configure',0),('prepare-attempt-1',0),('original-dist',137)];failure={'type':'ValueError','reason':'Original full default dist failed 5813'}
  cases={'both-absent':(('failure','cacheStopExitCode'),{},'fields absent'),'failure-absent':(('failure',),{},'fields absent'),'cache-absent':(('cacheStopExitCode',),{},'fields absent'),'null-failure-null-cache':((),{'failure':None,'cacheStopExitCode':None},'unclean cache shutdown'),'null-failure-failed-cache':((),{'failure':None,'cacheStopExitCode':41},'unclean cache shutdown'),'string-cache':((),{'cacheStopExitCode':'0'},'cache shutdown exit shape'),'cache-beyond-status-byte':((),{'cacheStopExitCode':256},'cache shutdown exit shape'),'null-failure-clean-stop-failed-dist':((),{'failure':None,'cacheStopExitCode':0},'unsuccessful command history')}
  for label,(dropped,changed,message) in cases.items():
   with self.subTest(case=label):
    body=json.loads(self.report(rows,failure=failure))
    for key in dropped:del body[key]
    body.update(changed);self.assert_refused(json.dumps(body).encode(),message,True)
 def test_failed_report_fields_the_real_child_writes_are_still_accepted(self):
  rows=[('configure',0),('prepare-attempt-1',0),('original-dist',137)];failure={'type':'ValueError','reason':'Original full default dist failed 5813'}
  # A stop that raised leaves no exit code; a phase that finished just before the
  # deadline leaves no failure beside a clean stop. sequence.py writes both shapes.
  for label,changed in {'failure-and-clean-stop':{},'failure-and-stop-without-exit':{'cacheStopExitCode':None},'failure-and-failed-stop':{'cacheStopExitCode':41},'late-without-failure':{'failure':None,'cacheStopExitCode':0}}.items():
   with self.subTest(case=label):
    body=json.loads(self.report(rows,failure=failure));body.update(changed)
    if label=='late-without-failure':body['phases'][-1].update(exitCode=0,status='command-passed')
    ops=SyntheticProducerOps(self.p,self.h,json.dumps(body).encode(),self.artifacts(),exit_failure='Native phase failed: original-source-producer');result,lifecycle=self.observe(ops)
    self.assertEqual({'accepted':True},result['failurePathChildReport']);self.assertEqual({'status':'incomplete','exitCode':0,'reason':'outer completion/quiescence not qualified'} if label=='late-without-failure' else {'status':'command-failed','exitCode':137},result['phaseAccounting']['original-dist']);self.assertIn('Native phase failed',result['failure']['reason']);self.assertFalse(result['originalCommandBuildWitnessComplete'])
    self.assertEqual(failure if body['failure'] else None,result['childFailure'])
 def test_real_sequence_failure_reports_are_accepted_by_the_reader(self):
  # Each report is written by sequence.py itself, so the reader's required
  # fields and argv equality are pinned to what the real child produces.
  failing={'configure':lambda a:23 if a==self.p['configure'] else 0,'prepare':lambda a:19 if a==self.p['prepare'] else 0,'dist':lambda a:137 if a==self.p['dist'] else 0,'cache':lambda a:41 if a[-1]=='--stop-server' else 0}
  for label,code in failing.items():
   with self.subTest(case=label):
    report=self.root/('sequence-'+label+'.json');S.run_sequence(self.p,self.root,'/synthetic/sccache',report,lambda argv,cwd,seconds:code(argv),sleep=lambda _:None)
    value=P.read_child_report(report,self.p);self.assertFalse(value['originalCommandsComplete']);self.assertIsNotNone(value['failure'])
  def raising(argv,cwd,seconds):
   if argv[-1]=='--stop-server':raise TimeoutError('synthetic cache stop 5813')
   return 0
  report=self.root/'sequence-stop-raised.json';S.run_sequence(self.p,self.root,'/synthetic/sccache',report,raising,sleep=lambda _:None);value=P.read_child_report(report,self.p);self.assertIsNone(value['cacheStopExitCode']);self.assertEqual('TimeoutError',value['failure']['type'])
  report=self.root/'sequence-pass.json';S.run_sequence(self.p,self.root,'/synthetic/sccache',report,lambda *_:0,sleep=lambda _:None);self.assertTrue(P.read_child_report(report,self.p)['originalCommandsComplete'])

class RetentionTraversalTests(unittest.TestCase):
 limits={'captureBytes':2*1024**2,'captureFiles':16}
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.outputs=self.root/'outputs';self.outputs.mkdir();(self.outputs/'visible.txt').write_bytes(b'readable sibling 4217');self.nested=self.outputs/'nested';self.nested.mkdir();(self.nested/'hidden.bin').write_bytes(b'n'*137)
 def tearDown(self):self.nested.chmod(0o700);self.temp.cleanup()
 def test_unreadable_directory_beside_readable_sibling_fails_retention(self):
  if os.geteuid()!=0:
   self.nested.chmod(0)
   with self.assertRaises(PermissionError):os.listdir(self.nested)
   refused=contextlib.nullcontext()
  else:
   # Root reads a mode-000 directory, so the same refusal is injected at os.walk()'s scandir.
   original=os.scandir;nested=str(self.nested)
   def scandir(path):
    if str(path)==nested:raise PermissionError(13,'synthetic unreadable directory',nested)
    return original(path)
   refused=mock.patch.object(os,'scandir',scandir)
  with refused:
   with self.assertRaisesRegex(ValueError,'traversal failed: PermissionError'):R.catalog({'dist':self.outputs},self.limits)
   with self.assertRaisesRegex(ValueError,'traversal failed'):R.retain_private({'dist':self.outputs},self.root/'out.tar',self.limits,{'allBuildUidProcessesStopped':True})
  self.assertFalse((self.root/'out.tar').exists());self.assertFalse((self.root/'out.tar.unaccepted').exists())
 def test_readable_nested_directory_is_cataloged_in_full(self):
  rows=R.catalog({'dist':self.outputs},self.limits);self.assertEqual({'dist/visible.txt':21,'dist/nested/hidden.bin':137},{r['member']:r['bytes'] for r in rows})
  result=R.retain_private({'dist':self.outputs},self.root/'out.tar',self.limits,{'allBuildUidProcessesStopped':True});self.assertEqual(2,result['membersVerified'])

class ToolTelemetryTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
 def tearDown(self):self.tmp.cleanup()
 def refusal(self,file,name='python3'):
  with mock.patch.object(H.os,'open',side_effect=AssertionError('guard must refuse before tool-body open')):
   with self.assertRaises(H.ToolGuardRefusal) as raised:H.hash_tool(file,float('inf'),name)
  value=raised.exception.observation;self.assertEqual(name,value['toolIdentifier']);self.assertEqual('resolved',value['resolveStatus']);self.assertEqual('observed',value['lstatStatus']);self.assertEqual(256*1024**2,value['capBytes']);self.assertEqual({'toolIdentifier','resolveStatus','lstatStatus','isRegular','hasExecuteModeBits','isNonempty','bytes','capBytes'},set(value));return value
 def test_wrong_physical_type_reports_flags_without_open(self):
  file=self.root/'directory';file.mkdir();file.chmod(0o755);value=self.refusal(file);self.assertFalse(value['isRegular']);self.assertTrue(value['hasExecuteModeBits'])
 def test_nonexecutable_regular_reports_exact_one_byte(self):
  file=self.root/'body';file.write_bytes(b'x');file.chmod(0o600);value=self.refusal(file);self.assertTrue(value['isRegular']);self.assertFalse(value['hasExecuteModeBits']);self.assertTrue(value['isNonempty']);self.assertEqual(1,value['bytes'])
 def test_empty_executable_reports_zero_without_read(self):
  file=self.root/'body';file.touch();file.chmod(0o755);value=self.refusal(file);self.assertTrue(value['isRegular']);self.assertTrue(value['hasExecuteModeBits']);self.assertFalse(value['isNonempty']);self.assertEqual(0,value['bytes'])
 def test_overcap_sparse_fixture_keeps_original_cap_and_never_opens(self):
  file=self.root/'sparse'
  with file.open('wb') as stream:stream.truncate(256*1024**2+1)
  file.chmod(0o755);value=self.refusal(file);self.assertEqual(256*1024**2+1,value['bytes']);self.assertTrue(value['isRegular'] and value['hasExecuteModeBits'] and value['isNonempty'])
 def test_valid_nonempty_and_exact_cap_near_misses_hash_unchanged(self):
  file=self.root/'valid';file.write_bytes(b'x');file.chmod(0o755);value=H.hash_tool(file,float('inf'),'python3');self.assertEqual(hashlib.sha256(b'x').hexdigest(),value['sha256']);self.assertEqual(1,value['bytes'])
  sparse=self.root/'exact-cap'
  with sparse.open('wb') as stream:stream.truncate(256*1024**2)
  sparse.chmod(0o755);value=H.hash_tool(sparse,float('inf'),'python3');expected=hashlib.sha256()
  for _ in range(4096):expected.update(bytes(65536))
  self.assertEqual(256*1024**2,value['bytes']);self.assertEqual(expected.hexdigest(),value['sha256'])
 def test_resolution_and_identifier_refusals_are_closed_no_paths_or_exception_body(self):
  secret='unbounded-private-path-or-source-body'
  with self.assertRaises(H.ToolGuardRefusal) as raised:H.resolve_tool('ninja',self.root/secret)
  value=H.refusal_summary(raised.exception);self.assertEqual('unresolved',value['toolGuardObservation']['resolveStatus']);self.assertEqual('not-observed',value['toolGuardObservation']['lstatStatus']);self.assertIsNone(value['toolGuardObservation']['bytes']);self.assertNotIn(secret,json.dumps(value));self.assertFalse(value['originalSDKOrSLABodyEmitted']);self.assertFalse(value['otherPhysicalExecutableReadConsistencyGuardsRelaxed']);self.assertEqual('selected-clang-512MiB-others-256MiB',value['measurementPolicy'])
  with self.assertRaisesRegex(ValueError,'Closed selected'):H.resolve_tool('ninja-suffix',self.root/secret)
 def test_main_emits_bounded_refusal_json_and_exit1_without_traceback(self):
  file=self.root/'empty';file.touch();file.chmod(0o755);observation=H.tool_observation('clang','resolved','observed',file.lstat());error=H.ToolGuardRefusal(observation);output=io.StringIO();env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_RUN_ID':'7','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40}
  with mock.patch.dict(os.environ,env),mock.patch.object(H.os,'getuid',return_value=0),mock.patch.object(H.platform,'system',return_value='Darwin'),mock.patch.object(H.platform,'machine',return_value='arm64'),mock.patch.object(H,'collect_metadata',side_effect=error),mock.patch.object(sys,'argv',['host_probe',str(self.root/'out')]),redirect_stdout(output):code=H.main()
  self.assertEqual(1,code);text=output.getvalue();self.assertLess(len(text.encode()),4096);self.assertNotIn('Traceback',text);value=json.loads(text);self.assertEqual(observation,value['toolGuardObservation']);self.assertFalse(value['metadataObserved']);self.assertFalse(value['nativeAdmissionGranted']);self.assertFalse(value['SDKCompilerOrSourceExecuted']);self.assertFalse(value['originalSDKOrSLABodyEmitted'])

class ClangMeasurementPolicyTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
 def tearDown(self):self.tmp.cleanup()
 def sparse(self,name,size,mode=0o755):
  file=self.root/name
  with file.open('wb') as stream:stream.truncate(size)
  file.chmod(mode);return file
 def zero_sha(self,size):
  h=hashlib.sha256();block=bytes(65536)
  for _ in range(size//len(block)):h.update(block)
  h.update(block[:size%len(block)]);return h.hexdigest()
 def test_exact_selected_family_enumerates_all14_without_prefix_or_suffix_admission(self):
  self.assertEqual(('python3','git','make','cmake','ninja','clang','clang++','ar','ranlib','ld','strip','xar','pkgbuild','hdiutil'),H.D.TOOLS)
  self.assertEqual(('clang','clang++'),H.CLANG_TOOL_IDENTIFIERS)
  for name in H.D.TOOLS:self.assertEqual((512 if name in ('clang','clang++') else 256)*1024**2,H.tool_cap(name))
  for name in ('clang-suffix','prefix-clang','cc','c++','llvm-ar','llvm-ranlib'):
   with self.assertRaisesRegex(ValueError,'Closed selected'):H.tool_cap(name)
 def test_actual_observed_size_is_hashable_for_clang_and_resolved_synthetic_alias_not_a_vendor_pin(self):
  file=self.sparse('clang',271279344);alias=self.root/'clang++';alias.symlink_to(file.name);expected=self.zero_sha(271279344)
  for name,candidate in [('clang',file),('clang++',alias)]:
   resolved=H.resolve_tool(name,candidate);self.assertEqual(file,resolved);value=H.hash_tool(resolved,float('inf'),name);self.assertEqual(271279344,value['bytes']);self.assertEqual(expected,value['sha256'])
 def test_exact_new_512mib_cap_is_a_real_hash_near_miss(self):
  file=self.sparse('clang-boundary',512*1024**2);value=H.hash_tool(file,float('inf'),'clang++');self.assertEqual(512*1024**2,value['bytes']);self.assertEqual(self.zero_sha(512*1024**2),value['sha256'])
 def test_over_new_cap_refuses_both_identifiers_before_any_body_open(self):
  file=self.sparse('too-large',512*1024**2+1)
  for name in ('clang','clang++'):
   with mock.patch.object(H.os,'open',side_effect=AssertionError('overcap must not read body')),self.assertRaises(H.ToolGuardRefusal) as raised:H.hash_tool(file,float('inf'),name)
   self.assertEqual(512*1024**2,raised.exception.observation['capBytes']);self.assertEqual(512*1024**2+1,raised.exception.observation['bytes'])
 def test_every_unrelated_selected_tool_keeps_old_256mib_refusal(self):
  file=self.sparse('old-ceiling-plus-one',256*1024**2+1)
  for name in ('python3','git','make','cmake','ninja','ar','ranlib','ld','strip','xar','pkgbuild','hdiutil'):
   with mock.patch.object(H.os,'open',side_effect=AssertionError('unrelated overcap must not read')),self.assertRaises(H.ToolGuardRefusal) as raised:H.hash_tool(file,float('inf'),name)
   self.assertEqual(256*1024**2,raised.exception.observation['capBytes'])
 def test_clang_family_still_refuses_wrong_type_nonexecutable_and_empty_before_open(self):
  directory=self.root/'directory';directory.mkdir();directory.chmod(0o755)
  cases=[directory,self.sparse('nonexec',1,0o600),self.sparse('empty',0)]
  for name in ('clang','clang++'):
   for file in cases:
    with mock.patch.object(H.os,'open',side_effect=AssertionError('physical guard before open')),self.assertRaises(H.ToolGuardRefusal) as raised:H.hash_tool(file,float('inf'),name)
    self.assertEqual(512*1024**2,raised.exception.observation['capBytes'])
 def test_larger_cap_never_relaxes_hash_deadline_or_physical_endpoint_consistency(self):
  file=self.sparse('small',1)
  with self.assertRaisesRegex(ValueError,'metadata hash deadline'):H.hash_tool(file,-1,'clang')
  original=H.os.fstat
  def changed(fd):
   value=original(fd);values=list(value);values[1]+=1;return os.stat_result(values)
  with mock.patch.object(H.os,'fstat',changed),self.assertRaisesRegex(ValueError,'endpoint changed'):H.hash_tool(file,float('inf'),'clang++')


# Sibling producers admitted a container, volume or image by its immutable ID and
# then acted on it by name, so a rebound name reached a foreign object. These
# producers issue no container-engine command at all; any that is added must
# address the admitted ID and be reviewed against that rename/rebind race.
ENGINES=('docker','podman','nerdctl','docker-compose')
ENGINE_WORD=re.compile(r'(?:^|[/\s])(?:'+'|'.join(map(re.escape,ENGINES))+r')(?=$|\s)')
# Comments are consumed as tokens so quotes inside them are never strings;
# template literals may span lines.
JS_TOKEN=re.compile(r'//[^\n]*|/\*.*?\*/|\'((?:\\.|[^\'\\\n])*)\'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`',re.S)
def engine_literals(source,suffix):
 if suffix=='.mjs':return [body for m in JS_TOKEN.finditer(source) for body in m.groups() if body is not None and ENGINE_WORD.search(body)]
 tree=ast.parse(source);docstrings=set()
 for node in ast.walk(tree):
  if isinstance(node,(ast.Module,ast.ClassDef,ast.FunctionDef,ast.AsyncFunctionDef)) and node.body and isinstance(node.body[0],ast.Expr) and isinstance(node.body[0].value,ast.Constant):docstrings.add(id(node.body[0].value))
 return [node.value for node in ast.walk(tree) if isinstance(node,ast.Constant) and type(node.value) in (str,bytes) and id(node) not in docstrings and ENGINE_WORD.search(node.value.decode('ascii','replace') if type(node.value) is bytes else node.value)]
def producer_sources():
 return [f for d in [HERE,HERE.parent/'native-rust198-notices'] for f in sorted(d.rglob('*')) if f.suffix in ('.py','.mjs') and not f.name.startswith('test_')]

class ContainerEngineGuard(unittest.TestCase):
 def test_no_producer_source_names_a_container_engine_command(self):
  files=producer_sources();names={f.relative_to(HERE.parent).as_posix() for f in files}
  # The scan must reach every executable module, including the reused pinned copies.
  for expected in ['native-rust198/process_supervisor.py','native-rust198/producer.py','native-rust198/host_probe.py','native-rust198/placement.py','native-rust198/retention.py','native-rust198/materializer.py','native-rust198/volume.py','native-rust198/reused_admission.py','native-rust198/reused-inventory/common.py','native-rust198-notices/notice_custody.py','native-rust198-notices/reused-crypto/common.py','native-rust198-notices/reused-crypto/envelope.mjs']:self.assertIn(expected,names)
  self.assertEqual({},{f.relative_to(HERE.parent).as_posix():found for f in files for found in [engine_literals(f.read_text(),f.suffix)] if found})
 def test_engine_detector_finds_every_command_form_by_name_or_path(self):
  broken={'argv-list':"subprocess.run(['docker','start',name])",'absolute-path':"argv=['/usr/local/bin/docker','rm','-f',ident]",'shell-string':"command='docker container kill '+name",'podman':"run(['podman','exec',name,'true'])",'f-string':"cmd=f'docker logs {name}'",'compose':"run(['docker-compose','down'])",'nerdctl-path':"run(['/opt/bin/nerdctl','inspect',name])",'bytes-argv':"subprocess.run([b'docker',b'version'])"}
  for label,source in broken.items():
   with self.subTest(case=label):self.assertTrue(engine_literals(source,'.py'),source)
  for label,source in {'mjs-argv':"spawn('docker', ['start', name]);",'mjs-template':"execSync(`docker rm ${id}`);",'mjs-multiline-template':"execSync(`\n  docker rm ${id}\n`);"}.items():
   with self.subTest(case=label):self.assertTrue(engine_literals(source,'.mjs'),source)
 def test_engine_detector_ignores_prose_and_lookalike_names(self):
  near={'comment':"# Docker's original public image ENV remains\nx=1",'docstring':'def f():\n """Mirrors docker start semantics without running it."""\n return 1','module-docstring':'"""Never runs docker."""\nx=1','capitalised':"label='Docker image ENV'",'label-key':"key='org.dockerproject.name'",'file-name':"name='dockerfile'",'hyphenated-note':"name='docker-ce-notes-9137.txt'",'suffix-word':"word='undocker'"}
  for label,source in near.items():
   with self.subTest(case=label):self.assertEqual([],engine_literals(source,'.py'))
  for label,source in {'mjs-comment':"// docker is never started here\nconst a = 1;",'mjs-lookalike':"const n = 'dockerfile-9137';",'mjs-quoted-comment':"// 'docker' is documentation\nconst a = 1;",'mjs-block-comment':"/* run `docker rm` by hand */\nconst b = 2;"}.items():
   with self.subTest(case=label):self.assertEqual([],engine_literals(source,'.mjs'))

class SecondOpenSwap:
 """Every open of a tracked file after its first finds a replacement file there.

 os.open, built-in open, io.open (pathlib's Path.open and read_bytes) and
 open_code (source reads by the import system and runpy) are all counted, so code that reopens a path by
 any of them reads the replacement bytes, not the ones it read first.
 """
 def __init__(self,replacements):self.replacements={str(path):body for path,body in replacements.items()};self.opens={key:0 for key in self.replacements};self.patches=[]
 def note(self,path):
  if isinstance(path,int):return
  key=os.fsdecode(os.fspath(path))
  if key not in self.opens:return
  self.opens[key]+=1
  if self.opens[key]==2 and self.replacements[key] is not None:
   target=Path(key);mode=stat.S_IMODE(os.lstat(key).st_mode);part=target.with_name(target.name+'.replacement-6151')
   fd=self.real_os_open(str(part),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'wb') as stream:stream.write(self.replacements[key])
   os.chmod(part,mode);os.replace(part,target)
 def __enter__(self):
  self.real_os_open=os.open;real_io_open=io.open;real_builtin_open=builtins.open;real_open_code=_io.open_code
  def os_open(path,*args,**kwargs):self.note(path);return self.real_os_open(path,*args,**kwargs)
  def io_open(file,*args,**kwargs):self.note(file);return real_io_open(file,*args,**kwargs)
  def builtin_open(file,*args,**kwargs):self.note(file);return real_builtin_open(file,*args,**kwargs)
  def open_code(path):self.note(path);return real_open_code(path)
  self.patches=[mock.patch.object(os,'open',os_open),mock.patch.object(io,'open',io_open),mock.patch.object(builtins,'open',builtin_open),mock.patch.object(_io,'open_code',open_code),mock.patch.object(io,'open_code',open_code)]
  for item in self.patches:item.start()
  return self
 def __exit__(self,*args):
  for item in reversed(self.patches):item.stop()

VERIFIED_PRODUCER=b'# verified producer bytes 6151\n'
class VerifiedLoaderStub:
 """Stands in for launch.VerifiedModules: serves fixed bytes by file name."""
 controllerBytesVerified=True
 def __init__(self,bodies):self.bodies=bodies
 def get_data(self,path):return self.bodies[Path(path).name]

class SecondOpenSwapHarnessTests(unittest.TestCase):
 def test_every_open_api_after_the_first_reads_the_replacement(self):
  with tempfile.TemporaryDirectory() as folder:
   file=Path(folder).resolve()/'tracked-6151';opens=[lambda:os.close(os.open(file,os.O_RDONLY)),lambda:open(file,'rb').close(),lambda:io.open(file,'rb').close(),lambda:file.read_bytes(),lambda:io.open_code(str(file)).close()]
   for first in range(len(opens)):
    for second in range(len(opens)):
     with self.subTest(first=first,second=second):
      file.write_bytes(b'original 6151');swap=SecondOpenSwap({file:b'replacement 6151'})
      with swap:opens[first]();opens[second]()
      self.assertEqual({str(file):2},swap.opens);self.assertEqual(b'replacement 6151',file.read_bytes())

class InputCustodyTests(unittest.TestCase):
 """Bytes a grant or pin approves are the bytes used, read through one open."""
 context={'GITHUB_RUN_ID':'6151','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'b'*40}
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.p=profile()
 def tearDown(self):
  if (self.root/'cohort').is_dir():(self.root/'cohort').chmod(0o755)
  self.temp.cleanup()
 def producer_inputs(self):
  host={**qualified(copy.deepcopy(self.p)),'runContext':self.context};files={'profile':(self.root/'profile-6151.json',(HERE/'profile.json').read_bytes()),'host':(self.root/'host-6151.json',json.dumps(host).encode()),'archives':(self.root/'archives-6151.json',json.dumps({'rustc-source198':'/synthetic/source-6151.tar.xz'}).encode())}
  for path,body in files.values():path.write_bytes(body);path.chmod(0o400)
  replacements={files['profile'][0]:json.dumps({**self.p,'sourceVersion':'9.99.6151'}).encode(),files['host'][0]:json.dumps({**host,'syntheticReplacement':6151}).encode(),files['archives'][0]:json.dumps({'rustc-source198':'/synthetic/replaced-6151.tar.xz'}).encode()}
  return files,replacements
 def run_main(self,files,swap,loader=None):
  grants=[];observed=[];work=self.root/'rust198-6151-1-synthetic-custody';loader=loader or VerifiedLoaderStub({'producer.py':VERIFIED_PRODUCER})
  argv=['producer.py','observe',str(files['profile'][0]),'--operator-grant',str(self.root/'grant-6151.json'),'--grant-sha256','f'*64,'--host-receipt',str(files['host'][0]),'--archives',str(files['archives'][0]),'--work',str(work)]
  def observe(p,host,archives,*args):observed.append((p,host,archives));return {}
  with mock.patch.object(sys,'argv',argv),mock.patch.dict(os.environ,self.context),mock.patch.object(P.os,'getuid',return_value=0),mock.patch.object(P.PL,'require_native_work'),mock.patch.object(P.A,'validate_operator_grant',side_effect=lambda *args:grants.append(args)),mock.patch.object(P,'observe',side_effect=observe),mock.patch.object(P,'finish_private',return_value={'controllerLifecycleComplete':True}),mock.patch.object(P,'enforce_whole_deadline',return_value=signal.getsignal(signal.SIGALRM)),mock.patch.object(P,'__loader__',loader),swap:
   self.assertEqual(0,P.main())
  return grants,observed
 def assert_approved_bytes_used(self,files,grants,observed):
  digest=lambda body:hashlib.sha256(body).hexdigest()
  self.assertEqual(1,len(grants));_,_,profile_sha,context,code_sha,host_sha,archives_sha,_=grants[0]
  self.assertEqual((digest(files['profile'][1]),digest(files['host'][1]),digest(files['archives'][1])),(profile_sha,host_sha,archives_sha))
  self.assertEqual(digest(VERIFIED_PRODUCER),code_sha);self.assertEqual(self.context,context)
  self.assertEqual([(json.loads(files['profile'][1]),json.loads(files['host'][1]),json.loads(files['archives'][1]))],observed)
 def test_inputs_replaced_after_their_first_read_never_reach_the_grant_or_observer(self):
  files,replacements=self.producer_inputs();swap=SecondOpenSwap(replacements)
  grants,observed=self.run_main(files,swap);self.assert_approved_bytes_used(files,grants,observed)
  self.assertEqual({str(path):1 for path in replacements},swap.opens)
 def test_unchanged_inputs_are_hashed_and_used_from_one_read(self):
  files,replacements=self.producer_inputs();swap=SecondOpenSwap({path:None for path in replacements})
  grants,observed=self.run_main(files,swap);self.assert_approved_bytes_used(files,grants,observed)
  self.assertEqual({str(path):1 for path in replacements},swap.opens)
 def test_direct_observe_without_the_verified_loader_is_refused_before_reading_granted_inputs(self):
  files,replacements=self.producer_inputs();swap=SecondOpenSwap({path:None for path in replacements})
  with self.assertRaisesRegex(ValueError,'^Observe requires the launch.py verified controller loader$'):self.run_main(files,swap,loader=P.__loader__)
  self.assertEqual({str(files['profile'][0]):1,str(files['host'][0]):0,str(files['archives'][0]):0},swap.opens)
 def test_linked_or_symlinked_input_is_refused_before_the_grant_is_checked(self):
  for kind in ['hardlink','symlink']:
   with self.subTest(kind=kind):
    files,_=self.producer_inputs();host=files['host'][0]
    if kind=='hardlink':os.link(host,self.root/'second-name-6151.json')
    else:moved=self.root/'real-host-6151.json';host.rename(moved);host.symlink_to(moved)
    try:
     with self.assertRaisesRegex(ValueError,'^Physical bounded single-link host receipt$'):self.run_main(files,SecondOpenSwap({}))
    finally:
     for path in self.root.iterdir():path.unlink()
 def test_grant_replaced_after_its_ownership_check_is_refused(self):
  file=self.root/'grant-6151.json';value={'authority':'explicit-reviewed-workflow-startup','profileSHA256':'p','controllerCodeSHA256':'c','runContext':{'r':'6151'},'allowedOperation':'original-rust198-producer','hostReceiptSHA256':'h','archiveMappingSHA256':'a','workNamespace':str(self.root/'work'),'MCPOrModelArgumentAuthority':False}
  body=json.dumps(value).encode();file.write_bytes(body);file.chmod(0o400);sha=hashlib.sha256(body).hexdigest();granted=os.lstat(file)
  replaced=[]
  def root_if_granted(s):
   # The grant inode reads as root-owned and its replacement as owned by a nonroot
   # account, whichever account runs the suite.
   if (s.st_dev,s.st_ino)==(granted.st_dev,granted.st_ino):owner=0
   elif replaced and (s.st_dev,s.st_ino)==replaced[0]:owner=6151
   else:return s
   v=list(s);v[4]=owner;return os.stat_result(v,{'st_mtime_ns':s.st_mtime_ns,'st_ctime_ns':s.st_ctime_ns})
  real_fstat=os.fstat;real_lstat=Path.lstat;real_open=os.open
  def replace_once():
   if not replaced:
    part=self.root/'replacement-6151';part.write_bytes(body);part.chmod(0o400);moved=os.lstat(part);os.replace(part,file);replaced.append((moved.st_dev,moved.st_ino))
  def lstat(path):
   s=real_lstat(path)
   if path==file:replace_once()
   return root_if_granted(s)
  def opening(path,*args,**kwargs):
   if os.fspath(path)==str(file):replace_once()
   return real_open(path,*args,**kwargs)
  def call():return A.validate_operator_grant(file,sha,'p',{'r':'6151'},'c','h','a',self.root/'work')
  with mock.patch.object(A.os,'fstat',lambda fd:root_if_granted(real_fstat(fd))):
   with mock.patch.object(Path,'lstat',lambda path:root_if_granted(real_lstat(path))):self.assertEqual(value,call())
   self.assertEqual([],replaced)
   with mock.patch.object(Path,'lstat',lstat),mock.patch.object(A.os,'open',opening),self.assertRaisesRegex(ValueError,'^Physical root-owned startup operator grant required$'):call()
  self.assertEqual(1,len(replaced))
 def test_reused_permission_helper_runs_from_the_bytes_matching_its_pin(self):
  copied=self.root/'controller';copied.mkdir();original=(HERE/'reused_admission.py').read_bytes();(copied/'reused_admission.py').write_bytes(original)
  for replacement,expected in [(original+b'\nSWAPPED_6151=True\n',1),(None,1)]:
   with self.subTest(replaced=replacement is not None):
    swap=SecondOpenSwap({copied/'reused_admission.py':replacement})
    with mock.patch.object(H,'HERE',copied),swap:module=H.guard()
    self.assertFalse(hasattr(module,'SWAPPED_6151'));self.assertEqual({str(copied/'reused_admission.py'):expected},swap.opens);self.assertTrue(callable(module.inspect_as_build))
    (copied/'reused_admission.py').write_bytes(original)
 def cohort(self):
  root=self.root/'cohort';root.mkdir();bodies={'producer.py':b"import hashlib,synthetic_helper_6151 as helper\nraise SystemExit(repr((helper.VALUE,hashlib.sha256(__loader__.get_data(__file__)).hexdigest())))\n",'synthetic_helper_6151.py':b"VALUE='verified-6151'\n"}
  for name,body in bodies.items():(root/name).write_bytes(body);(root/name).chmod(0o444)
  manifest=root/'COHORT.json';manifest.write_text(json.dumps([{'file':name,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()} for name,body in bodies.items()]));manifest.chmod(0o444);root.chmod(0o555);return root,manifest,bodies
 def root_owned(self):
  def owner(s):v=list(s);v[4]=0;return os.stat_result(v,{'st_mtime_ns':s.st_mtime_ns,'st_ctime_ns':s.st_ctime_ns})
  real_stat,real_lstat,real_fstat=Path.stat,Path.lstat,os.fstat
  return [mock.patch.object(Path,'stat',lambda p,*a,**k:owner(real_stat(p,*a,**k))),mock.patch.object(Path,'lstat',lambda p,*a,**k:owner(real_lstat(p,*a,**k))),mock.patch.object(L.os,'fstat',lambda fd:owner(real_fstat(fd)))]
 def test_launch_runs_the_verified_cohort_bytes_after_the_files_are_replaced(self):
  root,manifest,bodies=self.cohort();verified={}
  with contextlib.ExitStack() as stack:
   for item in self.root_owned():stack.enter_context(item)
   L.verify(root,manifest,hashlib.sha256(manifest.read_bytes()).hexdigest(),verified)
  self.assertEqual(bodies,verified)
  root.chmod(0o755)
  for name in bodies:(root/name).chmod(0o644);(root/name).write_bytes(b"VALUE='replaced-6151'\nraise SystemExit('replaced-6151')\n")
  swap=SecondOpenSwap({root/name:None for name in bodies})
  with mock.patch.object(sys,'meta_path',list(sys.meta_path)),mock.patch.object(sys,'path_hooks',list(sys.path_hooks)),mock.patch.object(sys,'path',list(sys.path)),mock.patch.object(sys,'argv',list(sys.argv)),mock.patch.dict(sys.modules),mock.patch.dict(sys.path_importer_cache),swap:
   with self.assertRaises(SystemExit) as raised:L.run_verified(root,verified,['observe'])
  self.assertEqual(repr(('verified-6151',hashlib.sha256(bodies['producer.py']).hexdigest())),raised.exception.code)
  self.assertEqual({str(root/name):0 for name in bodies},swap.opens)
 def test_launch_never_imports_a_controller_file_that_appears_after_verification(self):
  root,manifest,bodies=self.cohort()
  producer=b"import os,sys\nsys.path.insert(0,os.path.dirname(__file__))\nimport synthetic_helper_6151 as helper\ntry:\n import synthetic_planted_6151\nexcept ImportError:\n raise SystemExit('refused-6151 '+helper.VALUE)\nraise SystemExit('imported-'+synthetic_planted_6151.VALUE)\n"
  bodies={**bodies,'producer.py':producer};root.chmod(0o755);(root/'synthetic_planted_6151.py').write_bytes(b"VALUE='planted-6151'\n")
  with mock.patch.object(sys,'meta_path',list(sys.meta_path)),mock.patch.object(sys,'path_hooks',list(sys.path_hooks)),mock.patch.object(sys,'path',list(sys.path)),mock.patch.object(sys,'argv',list(sys.argv)),mock.patch.dict(sys.modules),mock.patch.dict(sys.path_importer_cache):
   with self.assertRaises(SystemExit) as raised:L.run_verified(root,bodies,['observe'])
  self.assertEqual('refused-6151 verified-6151',raised.exception.code)
 def test_launch_never_imports_from_a_directory_added_after_verification(self):
  # A controller module whose __file__ resolves through a replaced symlink adds a
  # directory outside the cohort; nothing in it may be imported.
  root,manifest,bodies=self.cohort();elsewhere=self.root/'elsewhere-6151';elsewhere.mkdir();(elsewhere/'synthetic_planted_6151.py').write_bytes(b"VALUE='planted-elsewhere-6151'\n")
  producer=("import sys\nsys.path.insert(0,%r)\ntry:\n import synthetic_planted_6151\nexcept ImportError:\n raise SystemExit('refused-6151')\nraise SystemExit('imported-'+synthetic_planted_6151.VALUE)\n" % str(elsewhere)).encode()
  with mock.patch.object(sys,'meta_path',list(sys.meta_path)),mock.patch.object(sys,'path_hooks',list(sys.path_hooks)),mock.patch.object(sys,'path',list(sys.path)),mock.patch.object(sys,'argv',list(sys.argv)),mock.patch.dict(sys.modules),mock.patch.dict(sys.path_importer_cache):
   with self.assertRaises(SystemExit) as raised:L.run_verified(root,{**bodies,'producer.py':producer},['observe'])
  self.assertEqual('refused-6151',raised.exception.code)
 def test_launch_never_searches_a_controller_directory_reached_through_a_link(self):
  root,manifest,bodies=self.cohort();root.chmod(0o755);(root/'synthetic_planted_6151.py').write_bytes(b"VALUE='planted-through-link-6151'\n");link=self.root/'linked-controller-6151';link.symlink_to(root)
  # The link is already on sys.path before verification, so only its resolved target refuses it.
  producer=b"try:\n import synthetic_planted_6151\nexcept ImportError:\n raise SystemExit('refused-6151')\nraise SystemExit('imported-'+synthetic_planted_6151.VALUE)\n"
  with mock.patch.object(sys,'meta_path',list(sys.meta_path)),mock.patch.object(sys,'path_hooks',list(sys.path_hooks)),mock.patch.object(sys,'path',[str(link),*sys.path]),mock.patch.object(sys,'argv',list(sys.argv)),mock.patch.dict(sys.modules),mock.patch.dict(sys.path_importer_cache):
   with self.assertRaises(SystemExit) as raised:L.run_verified(root,{**bodies,'producer.py':producer},['observe'])
  self.assertEqual('refused-6151',raised.exception.code)
 def test_launch_refuses_a_cohort_module_imported_before_verification(self):
  root,manifest,bodies=self.cohort();stale=types.ModuleType('synthetic_helper_6151');stale.VALUE='unverified-6151'
  with mock.patch.object(sys,'meta_path',list(sys.meta_path)),mock.patch.object(sys,'path_hooks',list(sys.path_hooks)),mock.patch.object(sys,'path',list(sys.path)),mock.patch.object(sys,'argv',list(sys.argv)),mock.patch.dict(sys.modules,{'synthetic_helper_6151':stale}),mock.patch.dict(sys.path_importer_cache):
   with self.assertRaisesRegex(ValueError,'^Controller module imported before cohort verification$'):L.run_verified(root,bodies,['observe'])

LAUNCH_DRIVER="""
import importlib.util,sys
from pathlib import Path
here=Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('verified_launcher_6151',here/'launch.py');L=importlib.util.module_from_spec(spec);spec.loader.exec_module(L)
bodies={p.relative_to(here).as_posix():p.read_bytes() for p in here.rglob('*') if p.is_file() and '__pycache__' not in p.parts}
if len(sys.argv)>2:bodies['producer.py']=sys.argv[2].encode();L.run_verified(here,bodies,['observe'])
else:L.run_verified(here,bodies,['plan',str(here/'profile.json')])
"""
def through_launcher(*body):
 """Run the launcher in a fresh isolated interpreter over the checked-in controller files."""
 return subprocess.run([sys.executable,'-I','-S','-B','-c',LAUNCH_DRIVER,str(HERE),*body],cwd='/',input=b'',capture_output=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},timeout=120,check=False)
def first_party_imports():
 """(module, imported name) for every absolute import in a cohort Python file."""
 rows=json.loads((HERE/'PUBLIC-COHORT.json').read_bytes());files=[row['file'] for row in rows if row['file'].endswith('.py')]
 local={Path(name).stem for name in files}|{'common'};found=set()
 for name in files:
  for node in ast.walk(ast.parse((HERE/name).read_bytes())):
   if isinstance(node,ast.Import):found.update((alias.name,None) for alias in node.names)
   elif isinstance(node,ast.ImportFrom) and node.level==0:found.update((node.module,alias.name) for alias in node.names)
 return sorted((row for row in found if row[0].split('.')[0] not in local),key=lambda row:(row[0],row[1] or ''))

class LauncherImportTests(unittest.TestCase):
 """The launcher's import restrictions still admit the standard library."""
 def test_fresh_interpreter_runs_the_real_producer_through_the_launcher(self):
  result=through_launcher();self.assertEqual(0,result.returncode,result.stderr[-600:])
  value=json.loads(result.stdout);self.assertTrue(value['profileValidated']);self.assertFalse(value['nativeExecutionGranted'])
 def test_fresh_interpreter_completes_materializer_and_host_probe_entry_imports(self):
  result=through_launcher("import host_probe,materializer\nmaterializer.primitives()\nraise SystemExit('entry-imports-complete-6151')\n")
  self.assertEqual((1,b'',b'entry-imports-complete-6151\n'),(result.returncode,result.stdout,result.stderr),result.stderr[-600:])
 def test_every_module_a_controller_file_imports_loads_through_the_launcher(self):
  wanted=first_party_imports();self.assertIn(('plistlib',None),wanted);self.assertIn(('unittest','mock'),wanted)
  body="import importlib,json\nfailed=[]\nfor module,name in %r:\n try:\n  value=importlib.import_module(module)\n  if name is not None and name!='*' and not hasattr(value,name):importlib.import_module(module+'.'+name)\n except Exception as error:failed.append([module,name,type(error).__name__+': '+str(error)])\nraise SystemExit(json.dumps(failed))\n" % (wanted,)
  result=through_launcher(body);self.assertEqual((1,b''),(result.returncode,result.stdout));self.assertEqual([],json.loads(result.stderr))
if __name__=='__main__':unittest.main()
