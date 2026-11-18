"""Synthetic HTTP outcomes only; no real Actions request or source execution."""
import copy,hashlib,io,json,pathlib,sys,tempfile,types,unittest
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import common
import driver
class APIControls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name);self.clock=[0];self.calls=[];self.index=0
  self.clock_patch=mock.patch.object(common.time,'monotonic',side_effect=lambda:self.clock[0]);self.clock_patch.start();self.addCleanup(self.clock_patch.stop)
 def run_api(self,responses,method='GET',missing=False,fresh=False,after_process=None,after_summary=False,sleep_advance=True,path='repos/stsepelin/checktrail/actions/artifacts/12'):
  self.index+=1;api=common.GitHub(self.root/str(self.index),900);pending=iter(responses)
  def process(argv,out,deadline):
   self.calls.append((argv,deadline));value=next(pending);status=value.get('status',200);headers=value.get('headers','');raw=value.get('raw',('HTTP/2 '+str(status)+'\n'+headers+'\n'+json.dumps({'synthetic':True})).encode());p=out.with_suffix('.stdout');p.write_bytes(raw)
   if after_process:after_process()
   return {'exitCode':value.get('exitCode',0 if status in [200,204] else 1),'reason':value.get('reason'),'stdoutBytes':len(raw),'stdoutSHA256':hashlib.sha256(raw).hexdigest(),'stderrBytes':0,'stderrSHA256':hashlib.sha256(b'').hexdigest()},p
  original=common.freeze
  def freezing(path,body):
   original(path,body)
   if after_summary and str(path).endswith('.api-outcome.json'):self.clock[0]=31
  with mock.patch.object(common,'process',side_effect=process),mock.patch.object(common,'freeze',side_effect=freezing),mock.patch.object(common.time,'sleep',side_effect=lambda s:self.clock.__setitem__(0,self.clock[0]+s) if sleep_advance else None),mock.patch('sys.stdout',io.StringIO()) as stdout:
   try:return api.call(path,method,missing,fresh),stdout.getvalue()
   finally:self.last_stdout=stdout.getvalue()
 def test_fresh404_waits_for_owned_caller200_with_one_original_deadline(self):
  value,log=self.run_api([{'status':404},{'status':200}],fresh=True);self.assertEqual(value,{'synthetic':True});self.assertEqual([x[1] for x in self.calls],[30,30]);self.assertEqual(self.clock[0],1);self.assertEqual([json.loads(x.split('=',1)[1])['status'] for x in log.splitlines()],[404,200])
 def test_nonfresh404_is_not_retried_and_missing404_keeps_exact_absence_semantics(self):
  with self.assertRaisesRegex(common.Refusal,'exact Actions API completion'):self.run_api([{'status':404}])
  self.assertEqual(len(self.calls),1);self.calls=[];value,_=self.run_api([{'status':404}],missing=True);self.assertIsNone(value);self.assertEqual(len(self.calls),1)
 def test_429_and_explicit_transient_5xx_retries_are_read_only_and_bounded(self):
  for status in [429,500,502,503,504]:
   self.clock[0]=0;self.calls=[];value,_=self.run_api([{'status':status,'headers':'Retry-After: 2\n'},{'status':200}]);self.assertEqual(value,{'synthetic':True});self.assertEqual(self.clock[0],2);self.assertEqual([x[1] for x in self.calls],[30,30])
 def test_retry_after_http_date_is_respected_without_new_allowance(self):
  with mock.patch.object(common.time,'time',return_value=0):value,_=self.run_api([{'status':503,'headers':'Retry-After: Thu, 01 Jan 1970 00:00:05 GMT\n'},{'status':200}])
  self.assertEqual(self.clock[0],5);self.assertEqual(value,{'synthetic':True})
 def test_invalid_duplicate_or_too_long_retry_after_fails_before_another_request(self):
  for header in ['Retry-After: nonsense\n','Retry-After: 1\nRetry-After: 1\n','Retry-After: 31\n']:
   self.calls=[];self.clock[0]=0
   with self.subTest(header=header),self.assertRaises(common.Refusal):self.run_api([{'status':503,'headers':header}])
   self.assertEqual(len(self.calls),1)
 def test_write_and_auth_failure_never_retry(self):
  for status,method in [(503,'DELETE'),(429,'DELETE'),(404,'DELETE'),(401,'GET'),(403,'GET'),(501,'GET')]:
   self.calls=[];self.clock[0]=0
   with self.subTest(status=status,method=method),self.assertRaises(common.Refusal):self.run_api([{'status':status}],method=method)
   self.assertEqual(len(self.calls),1)
 def test_cli_failure_reason_or_signal_is_not_absence_or_retry_authority(self):
  for status,rc,reason in [(404,0,None),(404,-9,None),(503,-9,None),(200,0,'late deadline')]:
   self.calls=[];self.clock[0]=0
   with self.subTest(status=status,rc=rc),self.assertRaises(common.Refusal):self.run_api([{'status':status,'exitCode':rc,'reason':reason}],missing=status==404)
   self.assertEqual(len(self.calls),1)
 def test_fresh_pending_is_only_allowed_for_exact_positive_artifact_get(self):
  for path,method,missing in [('repos/stsepelin/checktrail/actions/runs/12','GET',False),('repos/stsepelin/checktrail/actions/artifacts/0','GET',False),('repos/stsepelin/checktrail/actions/artifacts/12?extra=1','GET',False),('repos/stsepelin/checktrail/actions/artifacts/12','DELETE',False),('repos/stsepelin/checktrail/actions/artifacts/12','GET',True)]:
   self.calls=[]
   with self.subTest(path=path,method=method),self.assertRaisesRegex(common.Refusal,'fresh404 pending only'):self.run_api([],method=method,missing=missing,fresh=True,path=path)
   self.assertEqual(self.calls,[])
 def test_retry_count_cannot_spin_with_zero_cost_fake_transport(self):
  with self.assertRaisesRegex(common.Refusal,'bounded read-only retry'):self.run_api([{'status':503}]*16,sleep_advance=False)
  self.assertEqual(len(self.calls),16)
 def test_late_200_and_late_outcome_persistence_do_not_return_success(self):
  for late_capture in [False,True]:
   self.clock[0]=0
   with self.subTest(late_capture=late_capture),self.assertRaisesRegex(common.Refusal,'within original budget'):self.run_api([{'status':200}],after_process=None if late_capture else lambda:self.clock.__setitem__(0,31),after_summary=late_capture)
 def test_malformed_http_and_failed_outcome_keep_safe_metadata_without_body(self):
  with self.assertRaisesRegex(common.Refusal,'framing/status'):self.run_api([{'raw':b'not-http synthetic-private-body'}])
  self.assertNotIn('synthetic-private-body',self.last_stdout);rows=list((self.root/'1').glob('*.api-outcome.json'));self.assertEqual(len(rows),1);value=json.loads(rows[0].read_bytes());self.assertIsNone(value['status']);self.assertFalse(value['authorityOrProducerPassCreditedByThisSummary'])
 def record(self,change=None,listing_digest='sha256:'+'c'*64):
  self.index+=1;root=self.root/('record'+str(self.index));(root/'windows/01').mkdir(parents=True);ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};state={'exportDeadline':900,'windows':{}};controller=types.SimpleNamespace(root=root,ctx=ctx,state=state,profile={'workflowPath':'.github/workflows/ci.yml'},save=mock.Mock());members=[{'id':aid,'name':common.name(ctx,index),'size_in_bytes':15,'expired':False,'digest':listing_digest,'workflow_run':{'id':123,'head_sha':'a'*40}} for index,aid in enumerate([21,22],1)];calls=[]
  class API:
   def __init__(self,*args):pass
   def bind(self,*args):pass
   def call(self,path,**kwargs):
    calls.append((path,kwargs))
    if '/runs/' in path:return {'total_count':2,'artifacts':copy.deepcopy(members)}
    value=copy.deepcopy(members[int(path.rsplit('/',1)[1])-21])
    if change:change(value)
    return value
  with mock.patch.object(driver,'load_controller',return_value=controller),mock.patch.object(driver,'GitHub',API),mock.patch('sys.stdout',io.StringIO()):driver.record_window('synthetic-test','unused',1,'21,22')
  return controller,calls
 def test_actual_record_step_passes_freshness_mode_only_for_exact_created_artifact_ids(self):
  controller,calls=self.record();self.assertEqual([x[1] for x in calls],[{}, {'fresh_creation':True},{'fresh_creation':True}]);self.assertEqual(controller.state['windows']['1']['ids'],[21,22]);self.assertFalse(controller.state['windows']['1']['acknowledged']);controller.save.assert_called_once()
 def test_actual_record_step_refuses_changed_id_name_size_known_digest_or_run(self):
  for key,value in [('id',23),('name','foreign'),('size_in_bytes',16),('digest','sha256:'+'d'*64),('digest',None),('workflow_run',{'id':124,'head_sha':'a'*40})]:
   with self.subTest(key=key,value=value),self.assertRaises(common.Refusal):self.record(change=lambda meta:meta.update({key:value}))
 def test_previously_unobserved_digest_can_become_observed_without_false_mismatch(self):
  controller,_=self.record(listing_digest=None,change=lambda meta:meta.update(digest='sha256:'+'d'*64));self.assertEqual(controller.state['windows']['1']['ids'],[21,22])
 def test_operator_process_failure_emits_safe_status_and_rethrows_without_retry(self):
  api=common.GitHub(self.root/'process-failure',900)
  with mock.patch.object(common,'process',side_effect=OSError('synthetic-private-detail')) as process,mock.patch('sys.stdout',io.StringIO()) as stdout,self.assertRaises(OSError):api.call('repos/stsepelin/checktrail/actions/runs/123')
  process.assert_called_once();self.assertNotIn('synthetic-private-detail',stdout.getvalue());value=json.loads((self.root/'process-failure/api-00001.api-outcome.json').read_bytes());self.assertEqual(value['operatorProcessErrorType'],'OSError');self.assertIsNone(value['status']);self.assertFalse(value['authorityOrProducerPassCreditedByThisSummary'])
if __name__=='__main__':unittest.main(verbosity=2)
