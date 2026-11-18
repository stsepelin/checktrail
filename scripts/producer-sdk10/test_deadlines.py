"""Advanced synthetic clocks and fake children; no CLI/source/SDK process runs."""
import json,os,sys,tempfile,unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import common,crypto_bridge,git_ack,native_entry,transport_base

class DeadlineControls(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-deadline-synthetic-');self.root=Path(self.temp.name);self.clock=[0.0]
 def tearDown(self):self.temp.cleanup()
 def child(self,late=True):
  clock=self.clock
  class Child:
   pid=99999999;returncode=0
   def __init__(self,*a,**kw):pass
   def poll(self):
    if late:clock[0]=10.0
    return 0
   def wait(self,**kw):
    if late:clock[0]=10.0
    return 0
  return Child
 def test_common_late_zero_preserves_real_exit_and_withholds_budget_success(self):
  with mock.patch.object(common.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(common.subprocess,'Popen',self.child()):row,p=common.process(['unexecuted'],self.root/'command',5)
  self.assertEqual(row['exitCode'],0);self.assertIsNotNone(row['reason']);self.assertTrue(row['completionBudgetExhausted']);self.assertTrue(row['completionCreditFinalized']);self.assertEqual(common.read_json(self.root/'command.receipt.json'),row)
 def test_native_late_zero_preserves_original_zero_and_sets_separate_supervisor_124(self):
  with mock.patch.object(native_entry.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(native_entry.subprocess,'Popen',self.child()):row=native_entry.supervise(['unexecuted'],5,str(self.root),{},self.root,{'synthetic':True})
  self.assertEqual(row['originalExitCode'],0);self.assertTrue(row['timedOut']);self.assertEqual(row['supervisorExitCode'],124);self.assertTrue(row['ownChildReaped'])
 def test_common_late_capture_hash_is_not_credited_after_terminal_zero(self):
  original=common.hash_file;calls=[]
  def hashing(*a,**kw):
   result=original(*a,**kw);calls.append(True)
   if len(calls)==2:self.clock[0]=10.0
   return result
  with mock.patch.object(common.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(common.subprocess,'Popen',self.child(False)),mock.patch.object(common,'hash_file',side_effect=hashing):row,p=common.process(['unexecuted'],self.root/'command',5)
  self.assertEqual(row['exitCode'],0);self.assertTrue(row['completionBudgetExhausted']);self.assertIsNotNone(row['reason'])
 def test_receipt_persistence_crossing_deadline_corrects_zero_completion_before_return(self):
  original=common.replace_json;calls=[]
  def replacing(*a,**kw):
   result=original(*a,**kw);calls.append(True)
   if len(calls)==1:self.clock[0]=10.0
   return result
  with mock.patch.object(common.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(common,'replace_json',side_effect=replacing):row=common.deadline_receipt(self.root/'receipt.json',{'exitCode':0,'reason':None},5,{'reason':'late capture'},0)
  self.assertEqual(row['exitCode'],0);self.assertEqual(row['reason'],'late capture');self.assertTrue(row['completionBudgetExhausted']);self.assertEqual(common.read_json(self.root/'receipt.json'),row);self.assertEqual(len(calls),2)
 def test_native_late_result_persistence_never_changes_observed_original_exit(self):
  original=common.replace_json;calls=[]
  def replacing(*a,**kw):
   result=original(*a,**kw);calls.append(True)
   if len(calls)==1:self.clock[0]=10.0
   return result
  with mock.patch.object(native_entry.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(native_entry.subprocess,'Popen',self.child(False)),mock.patch.object(common,'replace_json',side_effect=replacing):row=native_entry.supervise(['unexecuted'],5,str(self.root),{},self.root,{'synthetic':True})
  self.assertEqual(row['originalExitCode'],0);self.assertTrue(row['timedOut']);self.assertEqual(row['supervisorExitCode'],124)
 def test_late_404_response_cannot_be_treated_as_owned_artifact_absence(self):
  path=self.root/'reply';path.write_bytes(b'HTTP/2 404\n\n{"message":"Not Found"}');api=common.GitHub(self.root/'api',5)
  with mock.patch.object(common.time,'monotonic',return_value=0),mock.patch.object(common,'process',return_value=({'exitCode':1,'reason':'late deadline'},path)),self.assertRaises(common.Refusal):api.call('repos/stsepelin/checktrail/actions/artifacts/11',missing=True)
 def test_collector_transport_late_zero_keeps_failure_event_and_cannot_return_body(self):
  calls=object.__new__(transport_base.Calls);calls.out=self.root;calls.deadline=5;calls.stop=None;calls.seq=0;calls.events=[];calls.startedPIDs=[];calls.reapedPIDs=[];calls.tool='unexecuted-gh'
  with mock.patch.object(transport_base.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(transport_base.subprocess,'Popen',self.child()),self.assertRaises(transport_base.Refusal):calls.run(['--include','unexecuted'],1024)
  self.assertEqual(calls.events[-1]['exitCode'],0);self.assertIsNotNone(calls.events[-1]['stopReason']);self.assertEqual(calls.startedPIDs,calls.reapedPIDs)
 def test_crypto_and_ack_reject_zero_response_with_nonempty_failure_reason(self):
  reply=self.root/'reply';reply.write_bytes(b'HTTP/2 200\n\n{}');ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};channel={'ref':'heads/diagnostic/sdk10-recovery-synthetic-test','parent':'b'*40};ack=git_ack.AckAPI(self.root/'ack',5,channel,ctx)
  with mock.patch.object(crypto_bridge,'process',return_value=({'exitCode':0,'reason':'deadline'},reply)),self.assertRaises(common.Refusal):crypto_bridge.operation(self.root/'crypto','validate-recipient',{},5)
  with mock.patch.object(git_ack.time,'monotonic',return_value=0),mock.patch.object(git_ack,'process',return_value=({'exitCode':0,'reason':'deadline'},reply)),self.assertRaises(common.Refusal):ack.call('git/ref/'+channel['ref'])
 def test_crypto_and_actions_post_parse_deadline_cannot_return_success(self):
  reply=self.root/'reply';reply.write_bytes(b'{}')
  def parsing(*a,**kw):self.clock[0]=10;return {}
  with mock.patch.object(crypto_bridge.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(crypto_bridge,'process',return_value=({'exitCode':0,'reason':None},reply)),mock.patch.object(crypto_bridge,'read_json',side_effect=parsing),self.assertRaises(common.Refusal):crypto_bridge.operation(self.root/'crypto','validate-recipient',{},5)
  self.clock[0]=0;reply.write_bytes(b'HTTP/2 200\n\n{}');api=common.GitHub(self.root/'api',5)
  with mock.patch.object(common.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(common,'process',return_value=({'exitCode':0,'reason':None},reply)),mock.patch.object(common.json,'loads',side_effect=parsing),self.assertRaises(common.Refusal):api.call('repos/stsepelin/checktrail/actions/runs/123')
  self.clock[0]=0;ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};channel={'ref':'heads/diagnostic/sdk10-recovery-synthetic-test','parent':'b'*40};ack=git_ack.AckAPI(self.root/'ack-postparse',5,channel,ctx)
  with mock.patch.object(git_ack.time,'monotonic',side_effect=lambda:self.clock[0]),mock.patch.object(git_ack,'process',return_value=({'exitCode':0,'reason':None},reply)),mock.patch.object(git_ack.json,'loads',side_effect=parsing),self.assertRaises(common.Refusal):ack.call('git/ref/'+channel['ref'])

if __name__=='__main__':unittest.main(verbosity=2)
