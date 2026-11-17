"""First-party synthetic effects only; all ACK/Docker API effects are mocked."""
import base64,copy,hashlib,json,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import common,driver,git_ack

class IntegrationControls(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-integration-synthetic-');self.root=Path(self.temp.name);self.ctx={'run':123,'attempt':1,'head':'a'*40,'nonce':'synthetic-test'}
 def tearDown(self):self.temp.cleanup()
 def native(self,label='original-build',limit=32,body=b'synthetic output',prior=b'',cleanup=None):
  bundle=self.root/'bundle';bundle.mkdir(mode=0o755);bundle.chmod(0o755)
  for name in ['native_entry.py','common.py','profile.json']:(bundle/name).write_bytes(b'first-party synthetic descriptor');(bundle/name).chmod(0o644)
  c=object.__new__(driver.Controller);c.root=self.root;c.ctx=self.ctx;c.state={'prefix':'synthetic','uid':os.getuid(),'gid':os.getgid(),'manifestSHA256':'b'*64,'containers':[],'volume':'work','tempVolume':'temp'};c.profile={'limits':{'nativeMemory':1024,'logBytes':limit,'freeReserve':0}};c.save=lambda:None
  evidence=self.root/'evidence';evidence.mkdir();(self.root/'protected').mkdir()
  if prior:(evidence/'original-build.stdout').write_bytes(prior)
  helper_calls=[];c.helper=lambda *a,**kw:helper_calls.append((a,kw));c.inspect=lambda *a:None;c.container_args=lambda *a:['create','synthetic'];c.validate_container=lambda *a:True;c.stop_owned=lambda name:cleanup() if cleanup else True
  argv=['./build.sh','--synthetic-original'];name='synthetic-'+label;binding={'context':self.ctx,'manifestSHA256':'b'*64,'phase':'build' if label=='original-build' else 'test','profileSHA256':common.hash_file(bundle/'profile.json')[1],'supervisorSHA256':common.hash_file(bundle/'native_entry.py')[1]}
  base={'schemaVersion':2,'binding':binding,'originalArgv':argv,'originalCommandStarted':True,'originalChildPID':222,'originalStartedWallTime':123.0,'originalStartedMonotonic':45.0,'ownChildReaped':True,'timedOut':False,'interrupted':False,'supervisorErrorType':None}
  obj={'Config':{'User':'0:0'},'State':{'Running':False,'ExitCode':0,'OOMKilled':False},'HostConfig':{'PidMode':'','Privileged':False,'Memory':1024,'CapAdd':['CHOWN','SETUID','SETGID']}}
  c.own_container=lambda name:copy.deepcopy(obj)
  def docker(args,**kwargs):
   if args[0]=='cp':
    member='START' if 'START.json' in args[1] else 'RESULT';value={**base,'originalExitCode':None if member=='START' else 0,'supervisorExitCode':0};Path(args[2]).write_bytes(common.encoded(value))
   return {'exitCode':0,'reason':None},None
  c.docker=docker
  class Child:
   pid=99999999
   def __init__(self,args,stdout,stderr,**kw):stdout.write(body);stdout.flush()
   def poll(self):return 0
   def wait(self,**kw):return 0
  deadline=time.monotonic()+60
  with mock.patch.object(driver,'HERE',bundle),mock.patch.object(driver.subprocess,'Popen',Child):result=c.native(label,argv,deadline)
  return result,helper_calls,deadline
 def test_actual_native_wrapper_mock_integrates_precommand_snapshot_and_protected_terminal(self):
  result,calls,deadline=self.native();self.assertEqual(result['exitCode'],0);self.assertIsNone(result['stopReason']);self.assertTrue(result['originalCodeExecuted']);self.assertEqual(calls[0][0][0],'before-original-build');self.assertIn('before-build',calls[0][0][1]);self.assertEqual(calls[0][0][2],deadline)
 def test_terminal_log_flood_after_immediate_exit_is_not_credited_as_success(self):
  result,calls,deadline=self.native(limit=4,body=b'flood after final poll');self.assertEqual(result['exitCode'],0);self.assertEqual(result['stopReason'],'terminal cumulative original log bound')
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
  with mock.patch.dict(driver.os.environ,env),mock.patch.object(driver,'manifest_check',return_value=profile),mock.patch.object(driver,'context',return_value=self.ctx),mock.patch.object(driver,'root_path',return_value=folder),mock.patch.object(driver,'Controller',Controller),mock.patch.object(driver,'GitHub',API),mock.patch.object(driver,'AckAPI',API),mock.patch.object(driver,'operation',return_value={}),mock.patch.object(driver,'capacity',return_value={}),mock.patch.object(driver,'prove_image'),mock.patch.object(driver.shutil,'disk_usage',return_value=type('Usage',(),{'free':10**13})()),mock.patch.object(driver.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(driver,'output'),mock.patch('builtins.print'),self.assertRaises(SystemExit):driver.produce('synthetic-test','c'*64)
  self.assertEqual([x[:2] for x in calls],[('original-build',profile['buildArgv']),('original-tests',profile['testArgv'])]);self.assertEqual([x[2] for x in calls],[15400,15400]);self.assertEqual(calls[1][3],4000);self.assertEqual(instances[0].state['cleanupDeadline'],22000);self.assertFalse(instances[0].state['captureReady'])
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
