"""Actual receiver metadata branch controls; only inert synthetic responses."""
import io,json,pathlib,sys,tempfile,unittest
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import transport_base as t
class ReceiverControls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name);self.clock=[0];clock=mock.patch.object(t.time,'monotonic',side_effect=lambda:self.clock[0]);clock.start();self.addCleanup(clock.stop)
 def caller(self,responses,cost=0):
  calls=object.__new__(t.Calls);calls.deadline=900;calls.events=[];calls.requests=[];pending=iter(responses)
  def run(tail,cap,seconds=30,operation_deadline=None):
   calls.requests.append((tail,cap,seconds,operation_deadline));value=next(pending);self.clock[0]+=cost
   if isinstance(value,Exception):raise value
   status=value.get('status',200);body=value.get('body',b'{}');headers=value.get('headers','');data=value.get('raw',('HTTP/2 '+str(status)+'\n'+headers+'\n').encode()+body);return value.get('rc',0 if status==200 else 1),data,None
  calls.run=run;return calls
 def request(self,calls,missing=False,advance=True):
  with mock.patch.object(t.time,'sleep',side_effect=lambda n:self.clock.__setitem__(0,self.clock[0]+n) if advance else None):return calls.metadata('repos/stsepelin/checktrail/actions/artifacts/12',missing)
 def test_receiver_transient_families_wait_then_return_actual_object(self):
  for status in [429,500,502,503,504]:
   self.clock[0]=0;calls=self.caller([{'status':status},{'body':b'{"synthetic":true}'}]);self.assertEqual(self.request(calls),{'synthetic':True});self.assertEqual(len(calls.requests),2);self.assertEqual([r[3] for r in calls.requests],[30,30]);self.assertEqual(calls.deadline,900);self.assertEqual([r['metadataResponseStatus'] for r in calls.events],[status,200]);self.assertTrue(all(r['authorityCreditedByThisSummary'] is False for r in calls.events))
 def test_numeric_and_date_retry_after_are_honored_inside_same_budget(self):
  for header,delay in [('Retry-After: 3\n',3),('Retry-After: Thu, 01 Jan 1970 00:00:05 GMT\n',5)]:
   self.clock[0]=0;calls=self.caller([{'status':503,'headers':header},{}])
   with mock.patch.object(t.time,'time',return_value=0):self.assertEqual(self.request(calls),{})
   self.assertEqual(self.clock[0],delay);self.assertEqual([r[3] for r in calls.requests],[30,30])
 def test_original30second_budget_is_not_reset_after_slow_retry(self):
  calls=self.caller([{'status':502},{}],cost=15)
  with self.assertRaisesRegex(t.Refusal,'response within original30second'):self.request(calls)
  self.assertEqual([r[3] for r in calls.requests],[30,30]);self.assertEqual(self.clock[0],31)
 def test_original_whole_deadline_can_be_stricter_than30seconds(self):
  calls=self.caller([{'status':502},{}]);calls.deadline=5;self.assertEqual(self.request(calls),{});self.assertEqual([r[3] for r in calls.requests],[4,4])
 def test_exact_missing404_stays_absence_only_for_actual_cli1(self):
  calls=self.caller([{'status':404,'rc':1}]);self.assertIsNone(self.request(calls,True));self.assertEqual(len(calls.requests),1)
  for rc in [0,2,-9]:
   calls=self.caller([{'status':404,'rc':rc}])
   with self.subTest(rc=rc),self.assertRaisesRegex(t.Refusal,'exact404 CLI1'):self.request(calls,True)
   self.assertEqual(len(calls.requests),1)
 def test_nonmissing404_and_auth_or_other_statuses_never_retry(self):
  for status in [401,403,404,400,501]:
   calls=self.caller([{'status':status}])
   with self.subTest(status=status),self.assertRaisesRegex(t.Refusal,'HTTP200 and CLI0'):self.request(calls)
   self.assertEqual(len(calls.requests),1)
 def test_bad_duplicate_and_unaffordable_retry_after_refuse_without_another_request(self):
  for headers in ['Retry-After: invalid\n','Retry-After: 1\nRetry-After: 1\n','Retry-After: 30\n']:
   calls=self.caller([{'status':503,'headers':headers}])
   with self.subTest(headers=headers),self.assertRaises(t.Refusal):self.request(calls)
   self.assertEqual(len(calls.requests),1)
 def test_retry_attempt_bound_holds_even_with_zero_cost_clock(self):
  calls=self.caller([{'status':502}]*16)
  with self.assertRaisesRegex(t.Refusal,'bounded metadata retry'):self.request(calls,advance=False)
  self.assertEqual(len(calls.requests),16)
 def test_signal_inconsistent_exit_or_transport_refusal_never_retry(self):
  for value in [{'status':200,'rc':1},{'status':502,'rc':-9},t.Refusal('owned API cancellation')]:
   calls=self.caller([value])
   with self.subTest(value=value),self.assertRaises(t.Refusal):self.request(calls)
   self.assertEqual(len(calls.requests),1)
 def test_malformed_http_or_nonobject_json_never_earn_metadata_credit(self):
  for value in [{'raw':b'not HTTP'},{'body':b'[]'}]:
   calls=self.caller([value])
   with self.subTest(value=value),self.assertRaises(t.Refusal):self.request(calls)
   self.assertEqual(len(calls.requests),1)
 def test_late_json_parse_cannot_return_metadata_object(self):
  calls=self.caller([{}]);original=t.json.loads
  def loads(body):value=original(body);self.clock[0]=31;return value
  with mock.patch.object(t.json,'loads',side_effect=loads),self.assertRaisesRegex(t.Refusal,'parse within original30second'):self.request(calls)
 def test_expired_operation_admits_no_metadata_request(self):
  calls=self.caller([]);calls.deadline=0
  with self.assertRaisesRegex(t.Refusal,'deadline before request'):self.request(calls)
  self.assertEqual(calls.requests,[])
 def physical(self):
  calls=object.__new__(t.Calls);calls.out=self.root;calls.deadline=900;calls.stop=None;calls.seq=0;calls.events=[];calls.startedPIDs=[];calls.reapedPIDs=[];calls.tool='unexecuted-synthetic-gh';return calls
 def test_actual_child_runner_respects_fixed_absolute_operation_deadline(self):
  calls=self.physical()
  class Child:
   pid=99999999;returncode=0
   def __init__(self,*args,**kwargs):pass
   def poll(self):self_outer.clock[0]=10;return 0
  self_outer=self
  with mock.patch.object(t.subprocess,'Popen',Child),self.assertRaisesRegex(t.Refusal,'API operation incomplete'):calls.run(['--include','synthetic'],1024,30,5)
  self.assertEqual(calls.events[-1]['exitCode'],0);self.assertIsNotNone(calls.events[-1]['stopReason']);self.assertEqual(calls.startedPIDs,calls.reapedPIDs)
 def test_expired_fixed_child_deadline_does_not_spawn(self):
  calls=self.physical()
  with mock.patch.object(t.subprocess,'Popen') as child,self.assertRaisesRegex(t.Refusal,'operation deadline before child'):calls.run(['--include','synthetic'],1024,30,0)
  child.assert_not_called()
 def test_delete_failure_is_not_retried(self):
  calls=self.caller([{'status':503}])
  with self.assertRaisesRegex(t.Refusal,'DELETE204'):calls.delete(12)
  self.assertEqual(len(calls.requests),1);self.assertEqual(calls.requests[0][0][:2],['--method','DELETE'])
 def test_binary_zip_child_failure_is_not_retried(self):
  calls=self.physical()
  class Child:
   pid=99999999;returncode=1
   def __init__(self,*args,**kwargs):kwargs['stdout'].write(b'synthetic ZIP transfer failure');kwargs['stdout'].flush()
   def poll(self):return 1
  with mock.patch.object(t.subprocess,'Popen',side_effect=Child) as child:rc,body,_=calls.run(['--allow-escape-sequences','repos/stsepelin/checktrail/actions/artifacts/12/zip'],t.CARRIER_MAX,120)
  self.assertEqual(rc,1);self.assertEqual(body,b'synthetic ZIP transfer failure');self.assertEqual(child.call_count,1);self.assertEqual(calls.startedPIDs,calls.reapedPIDs)
if __name__=='__main__':unittest.main(verbosity=2)
