"""Closed first-party failed-inner metadata, synthetic only; no SDK operations."""
from pathlib import Path
import ast,hashlib,io,json,os,plistlib,subprocess,sys,tempfile,unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import host_probe as H
HERE=Path(__file__).resolve().parent
class InnerFailure(unittest.TestCase):
 def setUp(self):self.module=SimpleNamespace(MAX_COMMAND_BYTES=1024**2);self.argv=['/usr/bin/sudo','-n','-u','nobody','/usr/bin/python3','-I','-S','-B',str(HERE/'reused_admission.py'),'--inner','/synthetic/request'];self.env={'PATH':'/usr/bin:/bin'};self.receipts=[]
 def failed(self,response):
  with mock.patch.object(H.subprocess,'run',return_value=response):
   with self.assertRaises(H.InnerPermissionProbeRefusal) as caught:H.observe_inner(self.module,self.argv,self.env,self.receipts,.25)
  return caught.exception.observation
 def trace(self,reason,script=None):
  script=script or HERE/'reused_admission.py';return b'Traceback (most recent call last):\n  File "'+os.fsencode(script)+b'", line 40, in need\n    if not value:raise ValueError(message)\nValueError: '+reason.encode()+b'\n'
 def test_closed_id_set_equals_all_reachable_original_inner_need_declarations(self):
  tree=ast.parse((HERE/'reused_admission.py').read_text());names={'inner','inspect_as_build','protected_path','metadata'};ids=set()
  for f in tree.body:
   if isinstance(f,ast.FunctionDef) and f.name in names:
    for n in ast.walk(f):
     if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='need' and len(n.args)>1 and isinstance(n.args[1],ast.Constant):ids.add(n.args[1].value)
  self.assertEqual(ids,H.INNER_NEED_IDS);self.assertEqual(15,len(ids))
 def test_all_closed_need_identifiers_classify_without_emitting_trace_or_path(self):
  for reason in sorted(H.INNER_NEED_IDS):
   with self.subTest(reason=reason):
    stderr=self.trace(reason);r=self.failed(subprocess.CompletedProcess([],1,b'',stderr));self.assertEqual({'kind':'closed-firstparty-inner-need-refusal','reasonIdentifier':reason},r['classification']);self.assertEqual(1,r['exitCode']);self.assertEqual(len(stderr),r['stderr']['bytes']);self.assertEqual(hashlib.sha256(stderr).hexdigest(),r['stderr']['sha256']);self.assertNotIn(str(HERE),json.dumps(r));self.assertNotIn('Traceback',json.dumps(r));self.assertFalse(r['descendantQuiescenceProven'])
 def test_exact_selected_raise_pointer_is_classified_without_emitting_it(self):
  pointer=b' '*17+b'^'*25+b'\n'
  for reason in sorted(H.INNER_NEED_IDS):
   with self.subTest(reason=reason):
    raw=self.trace(reason).replace(b'ValueError: ',pointer+b'ValueError: ')
    result=self.failed(subprocess.CompletedProcess([],1,b'',raw))
    self.assertEqual({'kind':'closed-firstparty-inner-need-refusal','reasonIdentifier':reason},result['classification'])
    self.assertNotIn('^',json.dumps(result));self.assertNotIn(str(HERE),json.dumps(result))
 def test_unselected_pointer_content_width_indent_or_repetition_stays_unknown(self):
  good=b' '*17+b'^'*25+b'\n'
  for pointer in [b' '*16+b'^'*25+b'\n',b' '*17+b'^'*24+b'\n',b' '*17+b'^'*26+b'\n',b' '*17+b'~'*25+b'\n',good+good,b'UNSELECTED\n']:
   with self.subTest(pointer=pointer):
    raw=self.trace('root-request-required').replace(b'ValueError: ',pointer+b'ValueError: ')
    result=self.failed(subprocess.CompletedProcess([],1,b'',raw))
    self.assertEqual({'kind':'unknown-inner-failure','reasonIdentifier':None},result['classification'])
 def test_real_pinned_firstparty_need_trace_matches_classifier_without_sdk_execution(self):
  file=HERE/'reused_admission.py';code="import importlib.util;spec=importlib.util.spec_from_file_location('firstparty_permission_fixture',"+repr(str(file))+");module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.need(False,'root-request-required')"
  actual=subprocess.run([sys.executable,'-I','-B','-c',code],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5);self.assertEqual(1,actual.returncode);self.assertEqual(b'',actual.stdout);self.assertLess(len(actual.stderr),65536);r=self.failed(actual);self.assertEqual({'kind':'closed-firstparty-inner-need-refusal','reasonIdentifier':'root-request-required'},r['classification'])
 def test_unknown_reason_suffix_prefix_wrong_script_and_stdout_are_unknown(self):
  reason='root-request-required';good=self.trace(reason)
  for stdout,stderr in [(b'',self.trace('prefix-'+reason)),(b'',self.trace(reason+'-suffix')),(b'',self.trace(reason,Path('/unrelated/firstparty.py'))),(b'',good+b'extra\n'),(b'',good.replace(b'Traceback (most recent call last):\n',b'')),(b'UNEMITTED-SOURCE-OR-SLA',good)]:
   with self.subTest(stderrSHA=hashlib.sha256(stderr).hexdigest()):r=self.failed(subprocess.CompletedProcess([],2,stdout,stderr));self.assertEqual('unknown-inner-failure',r['classification']['kind']);self.assertIsNone(r['classification']['reasonIdentifier']);self.assertNotIn('UNEMITTED',json.dumps(r));self.assertEqual(hashlib.sha256(stdout).hexdigest(),r['stdout']['sha256'])
 def test_exact_python_open_permission_family_only_for_known_alias_and_controller(self):
  script=HERE/'reused_admission.py'
  for number,message in [(13,b'Permission denied'),(1,b'Operation not permitted')]:
   stderr=os.fsencode(sys.executable)+b": can't open file '"+os.fsencode(script)+b"': [Errno "+str(number).encode()+b'] '+message+b'\n';r=self.failed(subprocess.CompletedProcess([],2,b'',stderr));self.assertEqual('stock-python-cannot-open-firstparty-controller-permission-refusal',r['classification']['kind']);self.assertEqual(number,r['classification']['osErrno']);self.assertNotIn(str(script),json.dumps(r))
 def test_permission_message_near_misses_remain_unknown(self):
  good=b"/usr/bin/python3: can't open file '"+os.fsencode(HERE/'reused_admission.py')+b"': [Errno 13] Permission denied\n"
  for bad in [good.replace(b'/usr/bin/python3',b'/unreviewed/python3'),good.replace(b'reused_admission.py',b'other.py'),good.replace(b'Errno 13',b'Errno 2'),good+b'raw-extra',good.replace(b'Permission denied',b'Permission deniedx')]:
   r=self.failed(subprocess.CompletedProcess([],2,b'',bad));self.assertEqual('unknown-inner-failure',r['classification']['kind'])
 def test_success_preserves_exact_original_run_arguments_and_receipt(self):
  body=json.dumps({'metadataEndpointSha256':'a'*64}).encode();response=subprocess.CompletedProcess([],0,body,b'')
  with mock.patch.object(H.subprocess,'run',return_value=response) as called:r=H.observe_inner(self.module,self.argv,self.env,self.receipts,.25)
  called.assert_called_once_with(self.argv,cwd='/',input=b'',capture_output=True,env=self.env,timeout=.25,check=False);self.assertEqual({'metadataEndpointSha256':'a'*64},r);self.assertEqual(1,len(self.receipts));self.assertEqual(self.argv,self.receipts[0]['argv']);self.assertEqual(hashlib.sha256(body).hexdigest(),self.receipts[0]['stdoutSHA256'])
 def test_exact_output_cap_accepted_and_one_over_refused_before_parse(self):
  prefix=b'{"metadataEndpointSha256":"';suffix=b'"}';body=prefix+b'a'*(self.module.MAX_COMMAND_BYTES-len(prefix)-len(suffix))+suffix
  with mock.patch.object(H.subprocess,'run',return_value=subprocess.CompletedProcess([],0,body,b'')):r=H.observe_inner(self.module,self.argv,self.env,self.receipts,.25)
  self.assertEqual(self.module.MAX_COMMAND_BYTES-len(prefix)-len(suffix),len(r['metadataEndpointSha256']))
  r=self.failed(subprocess.CompletedProcess([],0,body+b' ',b''));self.assertFalse(r['outputWithinOriginalBound']);self.assertEqual('original-command-output-bound-refused',r['classification']['kind']);self.assertEqual(len(body)+1,r['stdout']['bytes'])
 def test_timeout_keeps_partial_output_hashes_and_explicit_unknown_exit_lifecycle(self):
  error=subprocess.TimeoutExpired(self.argv,.25,output=b'PARTIAL-UNEMITTED',stderr=None)
  with mock.patch.object(H.subprocess,'run',side_effect=error),self.assertRaises(H.InnerPermissionProbeRefusal) as caught:H.observe_inner(self.module,self.argv,self.env,self.receipts,.25)
  r=caught.exception.observation;self.assertTrue(r['timedOut']);self.assertIsNone(r['exitCode']);self.assertEqual(hashlib.sha256(error.output).hexdigest(),r['stdout']['sha256']);self.assertFalse(r['stderr']['available']);self.assertIsNone(r['stderr']['bytes']);self.assertFalse(r['descendantQuiescenceProven']);self.assertEqual([],self.receipts);self.assertNotIn('PARTIAL',json.dumps(r))
 def test_spawn_lifecycle_and_unknown_errors_never_expose_exception_bodies(self):
  for error in [PermissionError(13,'DO-NOT-EMIT','/private/secret'),RuntimeError('SOURCE-OR-SLA-BODY')]:
   with mock.patch.object(H.subprocess,'run',side_effect=error),self.assertRaises(H.InnerPermissionProbeRefusal) as caught:H.observe_inner(self.module,self.argv,self.env,self.receipts,.25)
   r=caught.exception.observation;self.assertIsNone(r['exitCode']);self.assertFalse(r['stdout']['available']);self.assertEqual('spawn-or-lifecycle-outcome-unknown',r['processOutcome']);self.assertNotIn('DO-NOT',json.dumps(r));self.assertNotIn('SOURCE-OR',json.dumps(r))
 def test_signal_exit_is_preserved_without_group_absence_claim(self):
  r=self.failed(subprocess.CompletedProcess([],-15,b'',b''));self.assertEqual(-15,r['exitCode']);self.assertFalse(r['descendantQuiescenceProven']);self.assertEqual('unknown-inner-failure',r['classification']['kind'])
 def test_malformed_success_json_is_unknown_not_a_pass(self):
  for body in [b'not-json',b'[]',b'{"other":"payload"}']:
   r=self.failed(subprocess.CompletedProcess([],0,body,b''));self.assertEqual(0,r['exitCode']);self.assertEqual('unknown-firstparty-inner-result-format',r['classification']['kind']);self.assertEqual(hashlib.sha256(body).hexdigest(),r['stdout']['sha256'])
 def test_permission_probe_uses_observer_instead_of_losing_failed_inner_output(self):
  error=H.InnerPermissionProbeRefusal({'stage':'synthetic-inner-refusal','exitCode':1})
  class Bounds:
   def __init__(self):self.deadline=H.time.monotonic()+5;self.clock=H.time.monotonic
   def tick(self):pass
  def command(argv,env,receipts,codes=(0,),timeout=30):
   if argv[0]=='/usr/bin/id':return subprocess.CompletedProcess(argv,0,b'20\n',b'')
   if argv[:3]==['/usr/bin/sudo','-n','-l']:return subprocess.CompletedProcess(argv,1,b'synthetic-policy',b'')
   if argv[0]=='/bin/ps':return subprocess.CompletedProcess(argv,0,b'',b'')
   raise AssertionError('Failed inner must use bounded observation, not old opaque command')
  module=SimpleNamespace(Bounds=Bounds,command=command,group_id=int,sudo_denial=lambda value:True,snapshot=lambda roots,bounds:[{'synthetic':'nonempty-firstparty-frame'}],encoded=lambda value:json.dumps(value).encode(),digest=lambda value:hashlib.sha256(value).hexdigest(),MAX_DECODED_METADATA=128*1024**2,MAX_COMMAND_BYTES=1024**2,write_json=lambda path,value:path.write_text(json.dumps(value)))
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();account=SimpleNamespace(pw_uid=os.getuid()+1,pw_gid=20)
   with mock.patch.object(H,'guard',return_value=module),mock.patch.object(H.pwd,'getpwnam',return_value=account),mock.patch.dict(os.environ,{'CHECKTRAIL_CONTROLLER_UID':str(os.getuid())}),mock.patch.object(H.PL,'access_canary',return_value={'firstPartyOnlyNonemptyAccessCanaryObserved':True,'payloadReadBytesVerifiedByLegacyHashCheck':1,'SDKFrameOrNativeAdmissionCredit':False}),mock.patch.object(H,'observe_inner',side_effect=error) as observed,self.assertRaises(H.InnerPermissionProbeRefusal) as caught:H.permission_observation(root/'Developer',root/'SDK',root/'Toolchain',{},root,{})
   self.assertIs(error,caught.exception);observed.assert_called_once();args,kwargs=observed.call_args;self.assertEqual(module,args[0]);self.assertEqual(str(HERE/'reused_admission.py'),args[1][-3]);self.assertEqual('--inner',args[1][-2]);self.assertGreater(kwargs['timeout'],0);self.assertLessEqual(kwargs['timeout'],300)
 def test_main_emits_only_bounded_closed_projection_and_refuses(self):
  observation=self.failed(subprocess.CompletedProcess([],1,b'SOURCE-BODY',b'/private/SLA-BODY'));error=H.InnerPermissionProbeRefusal(observation);out=io.StringIO();environment={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40}
  with mock.patch.dict(os.environ,environment),mock.patch.object(H.os,'getuid',return_value=0),mock.patch.object(H.platform,'system',return_value='Darwin'),mock.patch.object(H.platform,'machine',return_value='arm64'),mock.patch.object(H,'collect_metadata',side_effect=error),mock.patch.object(sys,'argv',['host_probe','/synthetic/out']),redirect_stdout(out):code=H.main()
  text=out.getvalue();r=json.loads(text);self.assertEqual(1,code);self.assertLess(len(text),4096);self.assertFalse(r['nativeAdmissionGranted']);self.assertFalse(r['metadataObserved']);self.assertFalse(r['originalSDKOrSLABodyEmitted']);self.assertNotIn('SOURCE-BODY',text);self.assertNotIn('/private/',text)
 def summary_with_synthetic_original_sla(self,sla):
  result={'platform':'Darwin','arch':'arm64','macOS':'synthetic','CPUs':3,'RAMBytes':7*1024**3,'scratchFreeBytes':123,'xcodeVersion':'26.2','xcodeBuild':'synthetic','SDKVersionObservedNotHistoricalPublisherPin':'26.2','missingTools':[],'originalSLA':sla,'selectedFrame':{'bytes':12,'sha256':'b'*64,'entries':2,'hashReadBytes':34},'permissionObservation':{'failureCount':0},'controllerProtected':True,'sdkAndToolsProtectedFromBuildUid':True};environment={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40};out=io.StringIO()
  with tempfile.TemporaryDirectory() as directory:
   with mock.patch.dict(os.environ,environment),mock.patch.object(H.os,'getuid',return_value=0),mock.patch.object(H.platform,'system',return_value='Darwin'),mock.patch.object(H.platform,'machine',return_value='arm64'),mock.patch.object(H,'collect_metadata',return_value=result) as collected,mock.patch.object(sys,'argv',['host_probe',directory]),redirect_stdout(out):code=H.main()
   collected.assert_called_once();retained=json.loads((Path(directory)/'HOST-OBSERVATION.json').read_bytes());self.assertEqual(sla,retained['originalSLA'])
  return code,json.loads(out.getvalue()),out.getvalue()
 def test_null_original_sla_is_not_reported_retained_and_still_refuses_admission(self):
  code,summary,text=self.summary_with_synthetic_original_sla(None)
  self.assertEqual(1,code);self.assertIsNone(summary['originalSLA']);self.assertFalse(summary['SLAOriginalTextKeptOnHostOnlyNotRootReviewedOrExported']);self.assertTrue(summary['metadataObserved']);self.assertFalse(summary['nativeAdmissionGranted']);self.assertFalse(summary['SDKOrSourceExecuted'])
 def test_retained_original_sla_reports_only_hash_size_without_body_or_private_path(self):
  code,summary,text=self.summary_with_synthetic_original_sla({'file':'/synthetic/private-SLA-BODY','bytes':3,'sha256':'a'*64})
  self.assertEqual(0,code);self.assertEqual({'bytes':3,'sha256':'a'*64},summary['originalSLA']);self.assertTrue(summary['SLAOriginalTextKeptOnHostOnlyNotRootReviewedOrExported']);self.assertFalse(summary['nativeAdmissionGranted']);self.assertNotIn('private-SLA-BODY',text);self.assertNotIn('/synthetic/',text)
 def synthetic_host(self,root,licenses):
  app=root/'Xcode_26.2.app/Contents';developer=app/'Developer';sdk=developer/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk';sdk.mkdir(parents=True)
  (app/'Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'26.2'}));(app/'version.plist').write_bytes(plistlib.dumps({'ProductBuildVersion':'synthetic'}));(sdk/'SDKSettings.json').write_text('{"Version":"26.2"}')
  for localization,body in licenses.items():
   path=app/('Resources/'+localization+'/License.rtf');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)
  return app,developer
 def observed_license(self,root,developer):
  with mock.patch.object(H.shutil,'which',return_value=None):return H.collect_metadata(developer,root/'observation',{'synthetic':True},lambda:{'CPUs':3,'RAMBytes':7*1024**3,'macOS':'synthetic'})
 def test_observed_en_localization_retains_exact_original_synthetic_license(self):
  body=b'SYNTHETIC SELECTED EN ORIGINAL NOTICE\n'
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();app,developer=self.synthetic_host(root,{'en.lproj':body});result=self.observed_license(root,developer);self.assertIsNotNone(result['originalSLA']);sla=result['originalSLA'];self.assertEqual(str(app/'Resources/en.lproj/License.rtf'),sla['originalHostPath']);self.assertEqual(body,Path(sla['file']).read_bytes());self.assertEqual(len(body),sla['bytes']);self.assertEqual(hashlib.sha256(body).hexdigest(),sla['sha256']);self.assertEqual(0o400,Path(sla['file']).stat().st_mode&0o777);self.assertTrue(result['originalSLATextRetained']);self.assertFalse(result['nativeAdmissionGranted']);self.assertFalse(result['SDKCompilerOrSourceExecuted'])
 def test_two_localizations_select_only_observed_en_not_previous_english(self):
  selected=b'SYNTHETIC EN SELECTED';previous=b'SYNTHETIC ENGLISH MUST NOT BE READ'
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();app,developer=self.synthetic_host(root,{'en.lproj':selected,'English.lproj':previous})
   with mock.patch.object(H,'bounded_read',wraps=H.bounded_read) as read:result=self.observed_license(root,developer)
   reads=[call.args[0]for call in read.call_args_list];self.assertIn(app/'Resources/en.lproj/License.rtf',reads);self.assertNotIn(app/'Resources/English.lproj/License.rtf',reads);self.assertEqual(selected,Path(result['originalSLA']['file']).read_bytes());self.assertNotEqual(hashlib.sha256(previous).hexdigest(),result['originalSLA']['sha256'])
 def test_only_previous_english_directory_does_not_fake_selected_en_retention(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();app,developer=self.synthetic_host(root,{'English.lproj':b'SYNTHETIC OLD PATH ONLY'});result=self.observed_license(root,developer);self.assertIsNone(result['originalSLA']);self.assertFalse(result['originalSLATextRetained']);self.assertFalse((root/'observation/original-Xcode-license.rtf').exists())
 def test_selected_en_symlink_and_directory_do_not_gain_physical_body_retention(self):
  for kind in ['symlink','directory']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
    root=Path(directory).resolve();app,developer=self.synthetic_host(root,{'English.lproj':b'SYNTHETIC OLD TARGET'});selected=app/'Resources/en.lproj/License.rtf';selected.parent.mkdir()
    if kind=='symlink':selected.symlink_to(app/'Resources/English.lproj/License.rtf')
    else:selected.mkdir()
    result=self.observed_license(root,developer);self.assertIsNone(result['originalSLA']);self.assertFalse(result['originalSLATextRetained']);self.assertFalse((root/'observation/original-Xcode-license.rtf').exists())
class PermissionAccessRestore(unittest.TestCase):
 """The build account may read the private output only while the inner probe runs."""
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.fresh('metadata');self.frame=[{'synthetic':'firstparty-frame-entry-5813'}]
  class Bounds:
   bytes=5813
   def __init__(self):self.deadline=H.time.monotonic()+5;self.clock=H.time.monotonic
   def tick(self):pass
  def command(argv,env,receipts,codes=(0,),timeout=30):
   if argv[0]=='/usr/bin/id':return subprocess.CompletedProcess(argv,0,b'20\n',b'')
   if argv[:3]==['/usr/bin/sudo','-n','-l']:return subprocess.CompletedProcess(argv,1,b'synthetic-policy',b'')
   if argv[0]=='/bin/ps':return subprocess.CompletedProcess(argv,0,b'',b'')
   raise AssertionError('unexpected synthetic command')
  encoded=lambda value:json.dumps(value).encode();digest=lambda value:hashlib.sha256(value).hexdigest()
  self.module=SimpleNamespace(Bounds=Bounds,command=command,group_id=int,sudo_denial=lambda value:True,snapshot=lambda roots,bounds:self.frame,encoded=encoded,digest=digest,current_endpoint=self.endpoint_after_inner,LimitedCarrier=H.guard().LimitedCarrier,MAX_CAPTURE_BYTES=32*1024**2,MAX_DECODED_METADATA=128*1024**2,MAX_COMMAND_BYTES=1024**2,write_json=lambda path,value:path.write_text(json.dumps(value)))
  self.endpoint=digest(encoded(self.frame))
 def tearDown(self):self.temp.cleanup()
 def fresh(self,label):self.output=self.root/label;self.output.mkdir(mode=0o700);self.output.chmod(0o700);self.during=[];self.after=[]
 def endpoint_after_inner(self,frame):self.after.append((self.mode(self.output),self.mode(self.output/'permission-request.json')));return frame
 def identity(self):return {'uid':os.getuid()+1,'gid':20,'groups':[20]}
 def accepted(self):return {'identity':self.identity(),'selectedEntriesChecked':len(self.frame),'failureCount':0,'firstFailures':[],'allSelectedEntriesReadableExecutableAndProtected':True,'controllerProtected':True,'metadataEndpointSha256':self.endpoint,'permissionProbeOnly':True,'projectCodeExecuted':False}
 def mode(self,path):return path.lstat().st_mode&0o777
 def observed(self,result):
  def inner(module,argv,env,receipts,timeout):
   request=Path(argv[-1]);self.during.append((self.mode(self.output),self.mode(request)))
   if isinstance(result,Exception):raise result
   return result
  return inner
 def probe(self,inner):
  account=SimpleNamespace(pw_uid=self.identity()['uid'],pw_gid=self.identity()['gid'])
  with mock.patch.object(H,'guard',return_value=self.module),mock.patch.object(H.pwd,'getpwnam',return_value=account),mock.patch.dict(os.environ,{'CHECKTRAIL_CONTROLLER_UID':str(os.getuid())}),mock.patch.object(H.PL,'access_canary',return_value={'firstPartyOnlyNonemptyAccessCanaryObserved':True,'payloadReadBytesVerifiedByLegacyHashCheck':1,'SDKFrameOrNativeAdmissionCredit':False}),mock.patch.object(H,'observe_inner',side_effect=inner),redirect_stdout(io.StringIO()):
   return H.permission_observation(self.root/'Developer',self.root/'SDK',self.root/'Toolchain',{},self.output,{'synthetic':True})
 def test_every_failure_kind_restores_private_output_and_keeps_request_root_only(self):
  refusal=H.InnerPermissionProbeRefusal({'stage':'synthetic-inner-refusal','exitCode':77})
  small=SimpleNamespace(**{**vars(self.module),'MAX_CAPTURE_BYTES':7})
  cases=[('inner-refusal',refusal,self.module,H.InnerPermissionProbeRefusal,'inner permission'),('endpoint-mismatch',{**self.accepted(),'metadataEndpointSha256':'0'*64},self.module,ValueError,'endpoint changed'),('compression-bound',self.accepted(),small,ValueError,'metadata-carrier-byte-bound'),('result-without-protection',{'metadataEndpointSha256':self.endpoint},self.module,ValueError,'inner result fields'),('result-without-failure-count',{'metadataEndpointSha256':self.endpoint,'controllerProtected':True,'allSelectedEntriesReadableExecutableAndProtected':True},self.module,ValueError,'inner result fields')]
  for label,result,module,kind,message in cases:
   with self.subTest(case=label):
    self.fresh(label);self.module=module
    with self.assertRaisesRegex(kind,message):self.probe(self.observed(result))
    self.assertEqual([(0o755,0o444)],self.during);self.assertEqual(0o700,self.mode(self.output))
    request=self.output/'permission-request.json';self.assertEqual(0o400,self.mode(request));self.assertEqual(self.frame,json.loads(request.read_bytes())['frame'])
 def test_success_removes_request_and_restores_private_output(self):
  value=self.probe(self.observed(self.accepted()))
  self.assertEqual([(0o755,0o444)],self.during);self.assertEqual([(0o700,0o400)],self.after);self.assertEqual(0o700,self.mode(self.output));self.assertFalse(os.path.lexists(self.output/'permission-request.json'))
  frame=Path(value['selectedFrame']['file']);self.assertEqual(0o400,self.mode(frame));self.assertEqual(1,value['selectedFrame']['entries']);self.assertEqual(5813,value['selectedFrame']['hashReadBytes']);self.assertTrue(value['controllerProtected'])
  import gzip;self.assertEqual(self.frame,json.loads(gzip.decompress(frame.read_bytes())))

 def assert_refused_privately(self,result,message):
  with self.assertRaisesRegex(ValueError,message):self.probe(self.observed(result))
  self.assertEqual([(0o755,0o444)],self.during);self.assertEqual([],self.after);self.assertEqual(0o700,self.mode(self.output));self.assertEqual(0o400,self.mode(self.output/'permission-request.json'))
 def test_contradictory_inner_results_are_refused(self):
  failure_row={'path':'/synthetic/entry-5813','readable':False,'executableWhenRequired':True,'writablePaths':[]}
  cases={'one-failure-all-protected-none-checked':({'failureCount':1,'selectedEntriesChecked':0},'entries checked'),'one-failure-all-protected':({'failureCount':1,'firstFailures':[failure_row]},'all-protected flag'),'no-failure-not-all-protected':({'allSelectedEntriesReadableExecutableAndProtected':False},'all-protected flag'),'none-checked-all-protected':({'selectedEntriesChecked':0},'entries checked'),'more-checked-than-requested':({'selectedEntriesChecked':2},'entries checked'),'more-failures-than-checked':({'failureCount':2,'firstFailures':[failure_row,failure_row],'allSelectedEntriesReadableExecutableAndProtected':False},'failure count'),'negative-failures':({'failureCount':-1,'allSelectedEntriesReadableExecutableAndProtected':False},'failure count'),'failure-without-listed-row':({'failureCount':1,'allSelectedEntriesReadableExecutableAndProtected':False},'failure count'),'listed-row-without-failure':({'firstFailures':[failure_row]},'failure count'),'controller-unprotected':({'controllerProtected':False},'controller/probe-only'),'not-probe-only':({'permissionProbeOnly':False},'controller/probe-only'),'project-code-executed':({'projectCodeExecuted':True},'controller/probe-only'),'other-identity':({'identity':{'uid':5813,'gid':20,'groups':[20]}},'build identity'),'boolean-failure-count':({'failureCount':False},'inner result fields'),'listed-failures-not-list':({'firstFailures':{}},'inner result fields'),'unknown-extra-field':({'nativeAdmissionGranted':True},'inner result fields')}
  for label,(changed,message) in cases.items():
   with self.subTest(case=label):
    self.fresh(label);self.assert_refused_privately({**self.accepted(),**changed},message)
  for label in ['firstFailures','selectedEntriesChecked','permissionProbeOnly']:
   with self.subTest(missing=label):
    self.fresh('missing-'+label);result=self.accepted();del result[label];self.assert_refused_privately(result,'inner result fields')
 def test_consistent_inner_result_with_failures_is_accepted_and_not_protected(self):
  row={'path':'/synthetic/entry-5813','readable':False,'executableWhenRequired':True,'writablePaths':[]}
  value=self.probe(self.observed({**self.accepted(),'failureCount':1,'firstFailures':[row],'allSelectedEntriesReadableExecutableAndProtected':False}))
  self.assertFalse(value['sdkAndToolsProtectedFromBuildUid']);self.assertTrue(value['controllerProtected']);self.assertEqual(1,value['permissionObservation']['failureCount']);self.assertEqual([(0o700,0o400)],self.after)
 def test_real_pinned_inner_results_satisfy_the_consistency_rules(self):
  # The pinned producer, not a fixture, decides which result shapes are reachable.
  module=H.guard();controller=next((Path(c) for c in ['/usr/bin/true','/bin/true'] if os.path.isfile(c) and Path(c).resolve(strict=True)==Path(c) and os.stat(c).st_uid==0),None)
  self.assertIsNotNone(controller,'a root-owned regular controller stand-in is required')
  tree=self.root/'selected-5813';tree.mkdir()
  for n in range(103):(tree/('entry-%03d'%n)).write_bytes(b'synthetic selected entry %d' % (5813+n))
  frame=module.snapshot([tree],module.Bounds());identity={'uid':os.getuid()+1,'gid':20,'groups':[20]};request={'file':str(controller),'sha256':module.digest(controller.read_bytes()),'uid':os.getuid()}
  for label,denied,count in [('all-protected',lambda p:False,0),('one-unreadable',lambda p:p.name=='entry-057',1),('over-listed-cap',lambda p:p.name.startswith('entry-'),103)]:
   with self.subTest(case=label):
    def access(path,mode):return mode!=os.W_OK and not (mode==os.R_OK and denied(Path(path)))
    value=module.inspect_as_build(frame,request,identity,access=access,identity=identity)
    self.assertEqual(count,value['failureCount']);self.assertEqual(min(count,100),len(value['firstFailures']));self.assertEqual(104,value['selectedEntriesChecked'])
    self.assertIsNone(H.require_consistent_inner_result(value,frame,identity))
    with self.assertRaisesRegex(ValueError,'entries checked'):H.require_consistent_inner_result(value,frame[:-1],identity)
 def test_request_is_complete_before_the_build_account_can_traverse_the_output(self):
  partial=[]
  def instrumented(path,value):
   body=json.dumps(value).encode();fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o444)
   with os.fdopen(fd,'wb') as f:
    f.write(body[:len(body)//2]);f.flush();partial.append((self.mode(self.output),self.mode(path),path.stat().st_size));f.write(body[len(body)//2:])
  self.module=SimpleNamespace(**{**vars(self.module),'write_json':instrumented})
  self.probe(self.observed(self.accepted()))
  self.assertEqual(1,len(partial));self.assertEqual((0o700,0o444),partial[0][:2]);self.assertGreater(partial[0][2],0)
  self.assertEqual([(0o755,0o444)],self.during);self.assertEqual(0o700,self.mode(self.output))
 def test_interrupted_request_write_never_opens_the_output(self):
  partial=[]
  def interrupted(path,value):
   fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o444)
   with os.fdopen(fd,'wb') as f:f.write(b'{"frame":');f.flush();partial.append(self.mode(self.output))
   raise OSError(28,'synthetic request write interrupted 5813')
  self.module=SimpleNamespace(**{**vars(self.module),'write_json':interrupted})
  with self.assertRaisesRegex(OSError,'5813'):self.probe(self.observed(self.accepted()))
  self.assertEqual([0o700],partial);self.assertEqual([],self.during);self.assertEqual(0o700,self.mode(self.output));self.assertEqual(0o400,self.mode(self.output/'permission-request.json'))

if __name__=='__main__':unittest.main()
