"""Synthetic first-party controls only: no upstream source/SDK/compiler execution."""
from pathlib import Path
import copy,hashlib,io,json,os,plistlib,stat,sys,tempfile,unittest
from contextlib import redirect_stdout
from unittest import mock
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
import admission as A,host_probe as H,launch as L,process_supervisor as N,producer as P,retention as R,sequence as S,volume as V

def profile():return json.loads((HERE/'profile.json').read_bytes())
def qualified(p):
 # Explicitly synthetic contract evidence, never a real host admission receipt.
 p['originalSccache']['sha256']='f'*64;net='(version 1)(deny network*)'
 return {'evidenceKind':'actual-standard-github-host','platform':'Darwin','arch':'arm64','macOS':'15.8.2','developerDir':A.DEVELOPER,'xcodeVersion':'26.2','CPUs':3,'RAMBytes':7*A.GIB,'scratchFreeBytes':49_422_606_336,'controllerProtected':True,'sdkAndToolsProtectedFromBuildUid':True,'allDeclaredSDKToolBytesHashed':True,'buildUid':4294967294,'buildGid':4294967294,'buildUser':'nobody','runnerUid':501,'sudoDenied':True,'buildUidProcesses':[],'caseSensitiveWorkspace':True,'originalSLATextRetained':True,'SLABodyRootReviewed':True,'tools':{t:{'path':'/usr/bin/'+t} for t in A.TOOLS},'sccache':{'path':'/synthetic/sccache','version':'0.10.0','artifactSHA256':'f'*64,'originalSourceNoticeClosure':True,'MachOArchitecture':'x86_64','stockRosettaRuntimeObserved':True,'stopServerCommandQualified':True},'networkIPCProbeQualified':True,'qualifiedNetworkProfile':net,'operatorQualifiedNetworkProfileSHA256':hashlib.sha256(net.encode()).hexdigest(),'sdkPath':A.DEVELOPER+'/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.2.sdk'}

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
  original=Path.lstat
  def fake_lstat(path):
   s=original(path)
   if path!=file:return s
   v=list(s);v[4]=0;return os.stat_result(v)
  def call():return A.validate_operator_grant(file,hashlib.sha256(file.read_bytes()).hexdigest(),'p',{'r':'1'},'c','h','a',self.root/'work')
  with mock.patch.object(Path,'lstat',fake_lstat):
   self.assertEqual(value,call())
   for key,bad in [('MCPOrModelArgumentAuthority',True),('hostReceiptSHA256','other'),('runContext',{'r':'2'}),('archiveMappingSHA256','other'),('workNamespace','/other'),('controllerCodeSHA256','other')]:
    altered={**value,key:bad};file.chmod(0o600);file.write_text(json.dumps(altered));file.chmod(0o400)
    with self.assertRaises(ValueError):call()
  file.chmod(0o600);file.write_text(json.dumps(value));file.chmod(0o444)
  with mock.patch.object(Path,'lstat',fake_lstat),self.assertRaisesRegex(ValueError,'root-owned'):call()
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
  developer=self.root/'Xcode.app/Contents/Developer';sdk=developer/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.2.sdk';sdk.mkdir(parents=True);(sdk/'SDKSettings.json').write_text('{"Version":"26.2"}');(sdk.parent/'MacOSX.sdk').symlink_to(sdk.name);(developer.parent/'Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'26.2'}));(developer.parent/'version.plist').write_bytes(plistlib.dumps({'ProductBuildVersion':'synthetic'}));license=developer.parent/'Resources/English.lproj/License.rtf';license.parent.mkdir(parents=True);license.write_bytes(b'{synthetic original SLA}');tool=self.root/'tool';tool.write_bytes(b'synthetic tool bytes, never executed');tool.chmod(0o755)
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
      Path(argv[-1]).write_text(json.dumps({'originalCommandsComplete':True,'phases':[{'phase':name,'status':'command-passed','exitCode':0} for name in ['configure','prepare-attempt-1','original-dist']]}))
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
  def root_owner(s):v=list(s);v[4]=0;return os.stat_result(v)
  def fake_stat(p,*args,**kwargs):return root_owner(original(p,*args,**kwargs))
  def fake_lstat(p,*args,**kwargs):return root_owner(original_lstat(p,*args,**kwargs))
  with mock.patch.object(Path,'stat',fake_stat),mock.patch.object(Path,'lstat',fake_lstat):
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

class ToolTelemetryTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
 def tearDown(self):self.tmp.cleanup()
 def refusal(self,file,name='clang'):
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
  file=self.root/'valid';file.write_bytes(b'x');file.chmod(0o755);value=H.hash_tool(file,float('inf'),'clang');self.assertEqual(hashlib.sha256(b'x').hexdigest(),value['sha256']);self.assertEqual(1,value['bytes'])
  sparse=self.root/'exact-cap'
  with sparse.open('wb') as stream:stream.truncate(256*1024**2)
  sparse.chmod(0o755);value=H.hash_tool(sparse,float('inf'),'clang');expected=hashlib.sha256()
  for _ in range(4096):expected.update(bytes(65536))
  self.assertEqual(256*1024**2,value['bytes']);self.assertEqual(expected.hexdigest(),value['sha256'])
 def test_resolution_and_identifier_refusals_are_closed_no_paths_or_exception_body(self):
  secret='unbounded-private-path-or-source-body'
  with self.assertRaises(H.ToolGuardRefusal) as raised:H.resolve_tool('ninja',self.root/secret)
  value=H.refusal_summary(raised.exception);self.assertEqual('unresolved',value['toolGuardObservation']['resolveStatus']);self.assertEqual('not-observed',value['toolGuardObservation']['lstatStatus']);self.assertIsNone(value['toolGuardObservation']['bytes']);self.assertNotIn(secret,json.dumps(value));self.assertFalse(value['originalSDKOrSLABodyEmitted']);self.assertFalse(value['guardOrCapRelaxed'])
  with self.assertRaisesRegex(ValueError,'Closed selected'):H.resolve_tool('ninja-suffix',self.root/secret)
 def test_main_emits_bounded_refusal_json_and_exit1_without_traceback(self):
  file=self.root/'empty';file.touch();file.chmod(0o755);observation=H.tool_observation('clang','resolved','observed',file.lstat());error=H.ToolGuardRefusal(observation);output=io.StringIO();env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_RUN_ID':'7','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40}
  with mock.patch.dict(os.environ,env),mock.patch.object(H.os,'getuid',return_value=0),mock.patch.object(H.platform,'system',return_value='Darwin'),mock.patch.object(H.platform,'machine',return_value='arm64'),mock.patch.object(H,'collect_metadata',side_effect=error),mock.patch.object(sys,'argv',['host_probe',str(self.root/'out')]),redirect_stdout(output):code=H.main()
  self.assertEqual(1,code);text=output.getvalue();self.assertLess(len(text.encode()),4096);self.assertNotIn('Traceback',text);value=json.loads(text);self.assertEqual(observation,value['toolGuardObservation']);self.assertFalse(value['metadataObserved']);self.assertFalse(value['nativeAdmissionGranted']);self.assertFalse(value['SDKCompilerOrSourceExecuted']);self.assertFalse(value['originalSDKOrSLABodyEmitted'])

if __name__=='__main__':unittest.main()
