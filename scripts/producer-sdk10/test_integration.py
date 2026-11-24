"""First-party synthetic effects only; all ACK/Docker API effects are mocked."""
import base64,copy,hashlib,json,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import common,driver,git_ack

class IntegrationControls(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-integration-synthetic-');self.root=Path(self.temp.name);self.ctx={'run':123,'attempt':1,'head':'a'*40,'nonce':'synthetic-test'}
 def tearDown(self):self.temp.cleanup()
 def native(self,label='original-build',limit=32,body=b'synthetic output',prior=b'',cleanup=None,caps=None,terminal_caps=None,on_start=None,receipt_change=None,live_poll=None,deadline_seconds=60,owned_abort=False):
  bundle=self.root/'bundle';bundle.mkdir(mode=0o755);bundle.chmod(0o755)
  for name in ['native_entry.py','common.py','profile.json']:(bundle/name).write_bytes(b'first-party synthetic descriptor');(bundle/name).chmod(0o644)
  c=object.__new__(driver.Controller);c.root=self.root;c.ctx=self.ctx;c.state={'prefix':'ct-sdk10-synthetic','uid':os.getuid(),'gid':os.getgid(),'manifestSHA256':'b'*64,'containers':[],'volume':'work','tempVolume':'temp','cleanupDeadline':time.monotonic()+100000,'phaseDeadline':time.monotonic()+100000};c.profile={'limits':{'nativeMemory':1024,'logBytes':limit,'freeReserve':0}};c.save=lambda:None
  self.last_controller=c
  evidence=self.root/'evidence';evidence.mkdir();(self.root/'protected').mkdir()
  if prior:(evidence/'original-build.stdout').write_bytes(prior)
  helper_calls=[];c.helper=lambda *a,**kw:helper_calls.append((a,kw));c.inspect=lambda *a:None;c.container_args=lambda *a:['create','synthetic'];c.validate_container=lambda *a:True;c.stop_owned=lambda name:cleanup() if cleanup else True;c.compiler_processes=lambda *a:None
  argv=['./build.sh','--synthetic-original'];name='ct-sdk10-synthetic-'+label;binding={'context':self.ctx,'manifestSHA256':'b'*64,'phase':'build' if label=='original-build' else 'test','profileSHA256':common.hash_file(bundle/'profile.json')[1],'supervisorSHA256':common.hash_file(bundle/'native_entry.py')[1]}
  base={'schemaVersion':2,'binding':binding,'originalArgv':argv,'originalCommandStarted':True,'originalChildPID':222,'originalStartedWallTime':123.0,'originalStartedMonotonic':45.0,'ownChildReaped':True,'timedOut':False,'interrupted':False,'supervisorErrorType':None}
  obj={'Id':'a'*64,'Name':'/'+name,'Config':{'User':'0:0','Labels':common.owned_labels(self.ctx)},'State':{'Paused':False,'Running':False,'ExitCode':0,'OOMKilled':False},'HostConfig':{'PidMode':'','Privileged':False,'Memory':1024,'CapAdd':['CHOWN','SETUID','SETGID','KILL']}}
  if owned_abort:c.state['nativeRemovalAttempts']={name:{'binding':{'id':'a'*64,'name':name,'labels':common.owned_labels(self.ctx)},'protectedPreservation':{'existingProtectedBodiesPreserved':True}}}
  count=[0]
  def own_container(name):
   if owned_abort and count[0]>0:return None
   value=copy.deepcopy(obj);value['HostConfig']['CapAdd']=caps if count[0]==0 and caps is not None else terminal_caps if count[0]>0 and terminal_caps is not None else obj['HostConfig']['CapAdd'];count[0]+=1;return value
  c.own_container=own_container
  self.inspected_ids=[]
  def cmd(args,seconds=60,check=True,cap=0):
   # Terminal inspection goes through the registered producer ID only.
   out=self.root/('transport-'+str(len(self.inspected_ids)));row={'exitCode':0,'reason':None,'ownedChildStarted':True,'ownedChildReaped':True}
   if args[1:3]==['container','ls']:out.write_bytes(b'');return row,out
   self.assertEqual(args[1:3],['container','inspect']);self.inspected_ids.append(args[3]);value=own_container(name)
   if value is None:out.write_bytes(b'');return {**row,'exitCode':1},out
   out.write_bytes(common.encoded([value]));return row,out
  c.cmd=cmd
  self.docker_calls=[]
  def docker(args,**kwargs):
   self.docker_calls.append(list(args))
   if args[0]=='cp':
    member='START' if 'START.json' in args[1] else 'RESULT';value={**base,'originalExitCode':None if member=='START' else 0,'supervisorExitCode':0}
    if receipt_change:receipt_change(value)
    Path(args[2]).write_bytes(common.encoded(value))
   return {'exitCode':0,'reason':None},None
  c.docker=docker
  class Child:
   pid=99999999
   def __init__(self,args,stdout,stderr,**kw):
    if on_start:on_start()
    stdout.write(body);stdout.flush()
   def poll(self):
    if live_poll and not getattr(self,'observed_live_poll',False):self.observed_live_poll=True;live_poll();return None
    return 0
   def wait(self,**kw):return 0
  deadline=time.monotonic()+deadline_seconds
  with mock.patch.object(driver,'HERE',bundle),mock.patch.object(driver.subprocess,'Popen',Child):result=c.native(label,argv,deadline)
  return result,helper_calls,deadline
 def test_source_preservation_refusal_still_reaps_client_and_retains_both_cleanup_errors(self):
  for role in ['original-build','original-tests']:
   class Client:
    pid=12345
    done=False
    def poll(inner):return 0 if inner.done else None
    def wait(inner,timeout):inner.done=True;return 0
   client=Client();original=common.Refusal('synthetic protected evidence refused')
   def stop():raise original
   with self.subTest(role=role),mock.patch.object(driver.os,'killpg',side_effect=PermissionError(1,'synthetic signal refusal')),self.assertRaises(common.Refusal) as caught:
    driver.settle_native_client(client,stop,self.root,role,time.monotonic()+10)
   self.assertIs(caught.exception,original);self.assertEqual(client.poll(),0)
   receipt=common.read_json(self.root/(role+'-CLIENT-CLEANUP.json'));self.assertTrue(receipt['ownClientReaped']);self.assertEqual(receipt['sourceCleanupErrorType'],'Refusal');self.assertEqual(receipt['signalErrorType'],'PermissionError');self.assertFalse(receipt['sourceOriginalExitOrBuildCredit'])
 def test_actual_native_wrapper_mock_integrates_precommand_snapshot_and_protected_terminal(self):
  result,calls,deadline=self.native();self.assertEqual(result['exitCode'],0);self.assertIsNone(result['stopReason']);self.assertTrue(result['originalCodeExecuted']);self.assertEqual(calls[0][0][0],'before-original-build');self.assertIn('before-build',calls[0][0][1]);self.assertEqual(calls[0][0][2],deadline)
 def test_prefixed_native_capabilities_are_bound_and_recorded_before_source_start(self):
  caps=['CAP_CHOWN','CAP_SETUID','CAP_SETGID','CAP_KILL'];trace=[]
  def started():
   value=common.read_json(self.root/'evidence/original-build-DOCKER-IDENTITY-admission.json');self.assertEqual(value['CapAdd'],caps);self.assertFalse(value['sourceExecutionOrBuildPassCreditedByThisMetadata']);trace.append('started')
  result,_,_=self.native(caps=caps,terminal_caps=caps,on_start=started);self.assertEqual(trace,['started']);self.assertEqual(result['exitCode'],0);self.assertIsNone(result['stopReason'])
 def test_wrong_native_capability_refuses_before_any_source_process(self):
  starts=[]
  with self.assertRaises(common.Refusal):self.native(caps=['CAP_CHOWN','CAP_SETUID','CAP_SYS_ADMIN'],on_start=lambda:starts.append(True))
  self.assertEqual(starts,[]);self.assertTrue((self.root/'evidence/original-build-DOCKER-IDENTITY-admission.json').exists())
 def test_postprocess_identity_failure_retains_protected_status_without_build_credit(self):
  starts=[]
  with self.assertRaises(common.Refusal):self.native(terminal_caps=['CAP_CHOWN','CAP_SETUID','CAP_SYS_ADMIN'],on_start=lambda:starts.append(True))
  self.assertEqual(starts,[True]);value=common.read_json(self.root/'evidence/original-build-PROTECTED-STATUS.json');self.assertTrue(value['receipts']['RESULT']['bindingValidated']);self.assertEqual(value['receipts']['RESULT']['originalExitCode'],0);self.assertFalse(value['sourceExecutionOrBuildPassCreditedByThisMetadata']);self.assertFalse((self.root/'evidence/original-build-TERMINAL.json').exists())
 def test_invalid_protected_binding_still_retains_uncredited_observed_status(self):
  result,_,_=self.native(receipt_change=lambda value:value.update(binding={'synthetic':'wrong'}));self.assertIsNotNone(result['stopReason']);value=common.read_json(self.root/'evidence/original-build-PROTECTED-STATUS.json');self.assertFalse(value['receipts']['RESULT']['bindingValidated']);self.assertEqual(value['receipts']['RESULT']['originalExitCode'],0);self.assertFalse(value['sourceExecutionOrBuildPassCreditedByThisMetadata'])
 def test_terminal_log_flood_after_immediate_exit_is_not_credited_as_success(self):
  result,calls,deadline=self.native(limit=4,body=b'flood after final poll');self.assertEqual(result['exitCode'],0);self.assertEqual(result['stopReason'],'terminal cumulative original log bound')
 def test_supervisor_cleanup_errors_preserve_original_zero_without_phase_success(self):
  for field,value in [('cleanupSignalErrorType','PermissionError'),('cleanupWaitErrorType','TimeoutExpired'),('signalRestoreErrorTypes',['OSError'])]:
   with self.subTest(field=field),self.temp_subdir():
    result,_,_=self.native(receipt_change=lambda row:row.update({field:value}))
    self.assertEqual(result['exitCode'],0);self.assertEqual(result['stopReason'],'protected original timeout/interruption')
 def test_test_phase_prior_build_log_bytes_share_one_cumulative_bound(self):
  result,calls,deadline=self.native(label='original-tests',limit=5,body=b'123',prior=b'456');self.assertEqual(result['originalLogBytesBeforePhase'],3);self.assertEqual(result['originalLogBytesRemainingAtPhaseAdmission'],2);self.assertEqual(result['stopReason'],'terminal cumulative original log bound');self.assertIn('before-test',calls[0][0][1])
 def test_late_phase_metadata_cleanup_preserves_original_zero_but_withholds_completion_credit(self):
  clock=[0]
  with mock.patch.object(driver.time,'monotonic',side_effect=lambda:clock[0]):result,calls,deadline=self.native(cleanup=lambda:clock.__setitem__(0,100) or True)
  self.assertEqual(result['exitCode'],0);self.assertTrue(result['completionBudgetExhausted']);self.assertIsNotNone(result['stopReason'])
 def test_common_terminal_command_flood_is_physically_recorded_and_refused(self):
  with self.assertRaises(common.Refusal):common.process([sys.executable,'-I','-c',"print('x'*100)"],self.root/'flood',time.monotonic()+5,cap=16)
  row=common.read_json(self.root/'flood.receipt.json');self.assertEqual(row['reason'],'terminal command output bound');self.assertTrue(row['ownedChildReaped']);self.assertGreater(row['stdoutBytes'],16)
 def test_producer_build_and_test_keep_original_argv_and_one_shared_14400_second_deadline(self):
  profile=json.loads((Path(driver.__file__).parent/'profile.json').read_bytes());calls=[];clock=[1000.0];instances=[]
  class Controller:
   def __init__(inner,root,ctx,selected):inner.root=root;inner.ctx=ctx;inner.profile=selected;inner.state=None;instances.append(inner)
   def save(inner):pass
   def inspect(inner,*args):return None
   def cmd(inner,*args):pass
   def docker(inner,*args):pass
   def volume_owned(inner,*args):return True
   def helper(inner,label,args,deadline,*flags):
    if label=='after-observer':raise common.Refusal('synthetic stop before private capture; no Docker/source ran')
   def native(inner,label,argv,deadline):calls.append((label,argv,deadline,clock[0]));clock[0]+=3000;return {'exitCode':0,'stopReason':None}
  class API:
   def __init__(inner,*a):pass
   def bind(inner,*a):pass
   def current(inner):return 'b'*40
  folder=self.root/'producer';env={'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':'stsepelin/checktrail','GITHUB_RUN_ATTEMPT':'1','CHECKTRAIL_OPERATOR_ACK':'sdk10-original-e34-240m-'+('c'*12),'CHECKTRAIL_RECIPIENT_JWK':'{"synthetic":true}','CHECKTRAIL_ACK_PARENT':'b'*40}
  with mock.patch.dict(driver.os.environ,env),mock.patch.object(driver,'manifest_check',return_value=profile),mock.patch.object(driver,'context',return_value=self.ctx),mock.patch.object(driver,'root_path',return_value=folder),mock.patch.object(driver,'Controller',Controller),mock.patch.object(driver,'GitHub',API),mock.patch.object(driver,'AckAPI',API),mock.patch.object(driver,'operation',return_value={}),mock.patch.object(driver,'capacity',return_value={'DockerRootDir':'/synthetic/docker'}),mock.patch.object(driver,'observe_space',return_value={'accepted':True,'actualFreeBytes':10**13,'requiredFreeBytes':36775657472}) as disk_admission,mock.patch.object(driver,'prove_image'),mock.patch.object(driver.shutil,'disk_usage',return_value=type('Usage',(),{'free':10**13})()),mock.patch.object(driver.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(driver,'output'),mock.patch('builtins.print'),self.assertRaises(SystemExit):driver.produce('synthetic-test','c'*64)
  self.assertEqual([x[:2] for x in calls],[('original-build',profile['buildArgv']),('original-tests',profile['testArgv'])]);self.assertEqual([x[2] for x in calls],[15400,15400]);self.assertEqual(calls[1][3],4000);self.assertEqual(instances[0].state['cleanupDeadline'],22000);self.assertFalse(instances[0].state['captureReady']);self.assertEqual([call.args[-1] for call in disk_admission.call_args_list],['post-materialization-before-native','stopped-before-capture'])
 def test_rejected_created_native_has_cleanup_binding_before_source_admission(self):
  for role in ['original-build','original-tests']:
   starts=[]
   with self.subTest(role=role),self.temp_subdir(),self.assertRaises(common.Refusal):self.native(label=role,caps=['CHOWN','SETUID','SYS_ADMIN'],on_start=lambda:starts.append(True))
   self.assertEqual(starts,[]);self.assertIn('ct-sdk10-synthetic-'+role,self.last_controller.state['nativeProducers'])
 def test_owned_abort_absence_preserves_unknown_original_exit_despite_client_zero(self):
  for role in ['original-build','original-tests']:
   with self.subTest(role=role),self.temp_subdir(),mock.patch.object(driver.ProducerAPI,'inspect_id',return_value=None):
    result,_,_=self.native(label=role,owned_abort=True)
   self.assertIsNone(result['exitCode']);self.assertEqual(result['dockerClientExitCode'],0);self.assertIn('original exit unknown',result['stopReason']);self.assertIsNone(result['originalCodeExecuted'])
 def test_native_loop_calls_bounded_resource_observer_with_original_absolute_deadline(self):
  clock=[0]
  with mock.patch.object(driver.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(driver.time,'sleep'),mock.patch.object(driver,'observe_live_resource',return_value={'meter':{'samplingComplete':True}}) as observer:
   result,calls,deadline=self.native(live_poll=lambda:clock.__setitem__(0,121),deadline_seconds=360)
  observer.assert_called_once();self.assertEqual(observer.call_args.args[1:],('meter-121',deadline));self.assertEqual(observer.call_args.kwargs['producer_binding'],{'id':'a'*64,'name':'ct-sdk10-synthetic-original-build','labels':common.owned_labels(self.ctx)});self.assertIsNone(result['liveResourceFailure']);self.assertEqual(result['exitCode'],0)
 def test_native_loop_terminal_no_sample_does_not_access_or_credit_missing_meter(self):
  for role in ['original-build','original-tests']:
   with self.subTest(role=role):
    clock=[0]
    # Each phase fixture owns a separate inert directory; no actual Docker.
    with self.temp_subdir(), mock.patch.object(driver.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(driver.time,'sleep'),mock.patch.object(driver,'observe_live_resource',return_value={'producerTerminal':True,'complete':False,'meter':None}):
     result,_,_=self.native(label=role,live_poll=lambda:clock.__setitem__(0,121),deadline_seconds=360)
    self.assertEqual(result['exitCode'],0);self.assertIsNone(result['liveResourceFailure']);self.assertIsNone(result['stopReason'])
 def temp_subdir(self):
  from contextlib import contextmanager
  @contextmanager
  def owned():
   previous=self.root;temporary=__import__('tempfile').TemporaryDirectory();self.root=Path(temporary.name)
   try:yield
   finally:self.root=previous;temporary.cleanup()
  return owned()
 def test_native_loop_retains_resource_category_without_inventing_original_exit(self):
  clock=[0];projection={'guard':'attach','helperExit':-9,'sourceOriginalExitOrBuildPassCredited':False}
  with mock.patch.object(driver.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(driver.time,'sleep'),mock.patch.object(driver,'observe_live_resource',side_effect=driver.ObservationIncomplete(projection)):
   result,calls,deadline=self.native(live_poll=lambda:clock.__setitem__(0,121),deadline_seconds=360)
  self.assertEqual(result['exitCode'],0);self.assertEqual(result['stopReason'],'live resource observation incomplete');self.assertEqual(result['liveResourceFailure']['privacySafeProjection'],projection);self.assertTrue((self.root/'evidence'/'original-build-LIVE-RESOURCE-FAILURE.json').exists())
 def test_input_preparation_child_leaves_no_bytecode_cache_in_the_reviewed_directory(self):
  # Any cache entry in the reviewed directory makes every later --entry step
  # refuse it, finalize included. Runs the real command shape over a scratch
  # copy of input_prep.py and common.py, where importing common writes the cache.
  bundle=self.root/'bundle-3359';bundle.mkdir()
  for name in ['input_prep.py','common.py']:(bundle/name).write_bytes((Path(driver.__file__).parent/name).read_bytes())
  argv=driver.input_prep_command(self.root/'owned-3359',1234.5)
  self.assertEqual(argv[-6:],['--profile',str(driver.HERE/'profile.json'),'--out',str(self.root/'owned-3359'/'inputs'),'--deadline','1234.5'])
  script=argv.index(str(driver.HERE/'input_prep.py'));command=[*argv[:script],str(bundle/'input_prep.py'),'--help']
  # Some builds (macOS system Python) default to a cache prefix outside the
  # script directory; a scratch prefix makes any bytecode write observable.
  prefix=self.root/'pycache-prefix-3359';env={**{k:v for k,v in os.environ.items() if k!='PYTHONDONTWRITEBYTECODE'},'PYTHONPYCACHEPREFIX':str(prefix)}
  done=__import__('subprocess').run(command,stdout=__import__('subprocess').PIPE,stderr=__import__('subprocess').STDOUT,timeout=60,env=env)
  self.assertEqual(done.returncode,0,done.stdout);self.assertEqual(sorted(x.name for x in bundle.iterdir()),['common.py','input_prep.py']);self.assertFalse(prefix.exists())
 def test_resource_cutoff_stops_the_registered_producer_id_not_its_name(self):
  # The first poll is still running, so the loop sees the log flood and cuts off.
  result,_,_=self.native(limit=4,body=b'flood-7741 beyond the remaining log budget',live_poll=lambda:None)
  self.assertIn('log bound',result['stopReason'])
  stops=[x for x in self.docker_calls if x[0]=='stop'];self.assertEqual(stops,[['stop','--time','20','a'*64]])
 def finalize_cleanup(self,refusal=None):
  # Real remove_owned_volume over a synthetic daemon whose inspect object and
  # command receipt carry private host details.
  mount='/var/lib/docker/volumes/private-mount-9157/_data';(self.root/'evidence').mkdir(parents=True)
  c=type('SyntheticController',(),{})();c.root=self.root;c.ctx=self.ctx;c.profile={'limits':{'cleanupSeconds':300}}
  c.state={'phaseDeadline':time.monotonic()+900,'cleanupDeadline':time.monotonic()+900,'operatorFullRoundtripAcknowledged':True,'captureReady':True,'containers':[],'volume':'owned-work-9157','tempVolume':'owned-temp-9157','imageAliasCreated':False,'windows':{},'build':{'exitCode':0,'stopReason':None},'test':{'exitCode':0,'stopReason':None}}
  present={'owned-work-9157','owned-temp-9157'}
  def inspect(kind,name):return {'Name':name,'Labels':common.owned_labels(self.ctx),'Mountpoint':mount,'Driver':'local'} if name in present else None
  def volume_owned(name):
   if refusal:raise common.Refusal(refusal)
   return inspect('volume',name)
  def docker(args,seconds=60,check=True):present.discard(args[-1]);return {'argv':['docker',*args],'exitCode':0,'reason':None,'ownedChildStarted':True,'ownedChildReaped':True,'stderrPath':mount+'/stderr-9157'},None
  c.inspect=inspect;c.volume_owned=volume_owned;c.docker=docker;printed=[]
  with mock.patch.object(driver,'load_controller',return_value=c),mock.patch.object(driver,'finalize_image_inputs'),mock.patch.object(driver,'output'),mock.patch('builtins.print',side_effect=lambda *a,**k:printed.append(' '.join(map(str,a)))),self.assertRaises(SystemExit):driver.finalize('synthetic','a'*64)
  line=[x for x in printed if x.startswith('CHECKTRAIL_SDK10_TERMINAL=')][-1];return json.loads(line.split('=',1)[1]),line,(self.root/'TERMINAL.json').read_text()
 def test_printed_terminal_carries_only_the_volume_cleanup_projection(self):
  for refusal in [None,'private-error-9157 under /home/runner/private-9157']:
   with self.subTest(refusal=refusal),self.temp_subdir():
    terminal,line,stored=self.finalize_cleanup(refusal)
    for text in [line,stored]:
     for private in ['private-mount-9157','private-error-9157','Mountpoint','originalOwnedIdentity','removeCommand','privateCleanupError','argv','stderrPath']:self.assertNotIn(private,text)
    volumes=[x for x in terminal['cleanup'] if x.get('kind')=='sdk10-owned-volume-cleanup-v1']
    self.assertEqual([(x['role'],x['positiveOwnedAbsenceObserved'],x['rawNamesPathsArgvOrErrorBodiesEmitted']) for x in volumes],[('work',refusal is None,False),('temp',refusal is None,False)])
    self.assertIs(terminal['allOwnedCleanupPositivelyObserved'],refusal is None)
    receipt=(self.root/'evidence'/'CLEANUP-work-RESULT.json').read_text()
    self.assertIn('private-error-9157' if refusal else 'private-mount-9157',receipt)

  c=type('SyntheticController',(),{})();c.root=self.root;c.ctx=self.ctx;c.profile={'limits':{'cleanupSeconds':300}};c.state={'phaseDeadline':20000,'cleanupDeadline':21000,'operatorFullRoundtripAcknowledged':True,'captureReady':True,'containers':[],'volume':'owned-work','tempVolume':'owned-temp','imageAliasCreated':False,'windows':{}};c.inspect=lambda kind,name:{'Name':name}
  def removed(controller,name):return {'kind':'volume','name':name,'positiveOwnedAbsenceObserved':True}
  with mock.patch.object(driver,'load_controller',return_value=c),mock.patch.object(driver,'remove_owned_volume',side_effect=removed) as remove,mock.patch.object(driver.time,'monotonic',return_value=1000),mock.patch.object(driver,'output'),mock.patch('builtins.print'),self.assertRaises(SystemExit) as stopped:driver.finalize('synthetic','a'*64)
  self.assertEqual(stopped.exception.code,1);self.assertEqual(remove.call_args_list,[mock.call(c,'owned-work'),mock.call(c,'owned-temp')]);self.assertEqual(c.state['phaseDeadline'],1300);self.assertEqual(c.state['cleanupDeadline'],21000)
 def test_finalize_reports_complete_custody_only_with_the_validated_build_archive_retained(self):
  for retained,code in [(False,1),(True,None)]:
   with self.subTest(retained=retained),self.temp_subdir():
    (self.root/'evidence').mkdir(parents=True)
    common.freeze(self.root/'evidence'/'ORIGINAL-NATURAL-TEST-REPORTS.json',common.encoded({'allCreditedFreshTestsPassed':True}))
    common.freeze(self.root/'evidence'/'FRESH-SELECTED-SDK-OUTPUTS.json',common.encoded({'selectedSDKArchiveMetadataAndAttributionObserved':True,'validatedBuildArchiveBytesUnchangedForStoppedCapture':retained}))
    c=type('SyntheticController',(),{})();c.root=self.root;c.ctx=self.ctx;c.profile={'limits':{'cleanupSeconds':300}}
    c.state={'phaseDeadline':20000,'cleanupDeadline':21000,'operatorFullRoundtripAcknowledged':True,'captureReady':True,'containers':[],'volume':'owned-work-3917','tempVolume':'owned-temp-3917','imageAliasCreated':False,'windows':{},
     'build':{'exitCode':0,'stopReason':None},'test':{'exitCode':0,'stopReason':None}};c.inspect=lambda kind,name:None
    printed=[]
    with mock.patch.object(driver,'load_controller',return_value=c),mock.patch.object(driver,'finalize_image_inputs'),mock.patch.object(driver.time,'monotonic',return_value=1000),mock.patch.object(driver,'output'),mock.patch('builtins.print',side_effect=lambda *a,**k:printed.append(' '.join(map(str,a)))):
     if code is None:driver.finalize('synthetic','a'*64)
     else:
      with self.assertRaises(SystemExit) as stopped:driver.finalize('synthetic','a'*64)
      self.assertEqual(stopped.exception.code,code)
    terminal=json.loads([x for x in printed if x.startswith('CHECKTRAIL_SDK10_TERMINAL=')][-1].split('=',1)[1])
    self.assertIs(terminal['validatedBuildArchiveBytesUnchangedForStoppedCapture'],retained);self.assertEqual(terminal['state'].startswith('COMPLETE'),retained)
 def ack_api(self,change=None):
  ctx=self.ctx;channel={'ref':'heads/diagnostic/sdk10-recovery-synthetic-test','parent':'b'*40};ack={'payload':{'context':ctx,'syntheticHashesOnly':True},'signature':'SYNTHETIC','algorithm':'RSA-PSS-SHA256-salt32'};raw=common.encoded(ack);blob=common.git_blob(raw);events=[]
  documents={'git/ref/'+channel['ref']:{'ref':'refs/'+channel['ref'],'object':{'type':'commit','sha':'f'*40}},'git/commits/'+'f'*40:{'sha':'f'*40,'message':git_ack.MESSAGE,'parents':[{'sha':channel['parent']}],'tree':{'sha':'d'*40}},'git/trees/'+'d'*40:{'sha':'d'*40,'truncated':False,'tree':[{'path':'.checktrail-recovery','mode':'040000','type':'tree','sha':'e'*40}]},'git/trees/'+'e'*40:{'sha':'e'*40,'truncated':False,'tree':[{'path':git_ack.ack_path(ctx).split('/')[-1],'mode':'100644','type':'blob','sha':blob}]},'git/blobs/'+blob:{'encoding':'base64','content':base64.b64encode(raw).decode(),'size':len(raw)}}
  if change:change(documents)
  class API(git_ack.AckAPI):
   def call(inner,suffix,method='GET',payload=None):events.append((suffix,method,payload));return copy.deepcopy(documents[suffix])
  return API(self.root/'ack',time.monotonic()+10,channel,ctx),events,ack,documents
 def test_actual_ack_fetch_reconciles_single_parent_exact_tree_path_mode_and_blob(self):
  api,events,ack,docs=self.ack_api();proof=api.fetch();self.assertEqual(proof['ack'],ack);self.assertEqual(proof['commit'],'f'*40);self.assertTrue(all(x[1]=='GET' for x in events));self.assertEqual(len(events),5)
 def test_ack_fetch_wrong_parent_message_tree_truncation_duplicate_path_and_mode_refuse(self):
  mutations=[lambda d:d['git/commits/'+'f'*40].update(parents=[{'sha':'c'*40}]),lambda d:d['git/commits/'+'f'*40].update(message='unexpected'),lambda d:d['git/trees/'+'e'*40].update(truncated=True),lambda d:d['git/trees/'+'e'*40]['tree'].append(copy.deepcopy(d['git/trees/'+'e'*40]['tree'][0])),lambda d:d['git/trees/'+'e'*40]['tree'][0].update(mode='120000')]
  for index,change in enumerate(mutations):
   case=self.root/str(index);case.mkdir();old=self.root;self.root=case
   try:
    api,events,ack,docs=self.ack_api(change)
    with self.assertRaises(common.Refusal):api.fetch()
    self.assertTrue(all(x[1]=='GET' for x in events))
   finally:self.root=old
 def test_ack_fetch_body_tampering_or_mismatched_declared_size_refuse(self):
  for index in range(2):
   case=self.root/str(index);case.mkdir();old=self.root;self.root=case
   try:
    def change(d):
     key=next(x for x in d if x.startswith('git/blobs/'));d[key]['size']+=1 if index else 0
     if not index:d[key]['content']=base64.b64encode(b'altered').decode()
    api,events,ack,docs=self.ack_api(change)
    with self.assertRaises(common.Refusal):api.fetch()
   finally:self.root=old
 def test_ack_transport_rejects_unselected_effects_before_spawning_any_cli(self):
  channel={'ref':'heads/diagnostic/sdk10-recovery-synthetic-test','parent':'b'*40};api=git_ack.AckAPI(self.root/'ack',time.monotonic()+10,channel,self.ctx,False)
  with mock.patch.object(git_ack,'process') as process:
   for suffix,method,payload in [('git/refs/heads/main','PATCH',{'sha':'c'*40}),('git/blobs','POST',{'content':'x'}),('git/ref/heads/main','GET',None),('actions/runs/123','GET',None)]:
    with self.subTest(suffix=suffix),self.assertRaises(common.Refusal):api.call(suffix,method,payload)
   process.assert_not_called()

if __name__=='__main__':unittest.main(verbosity=2)
