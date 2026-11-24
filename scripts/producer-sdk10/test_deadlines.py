"""Advanced synthetic clocks and fake children; no CLI/source/SDK process runs."""
import json,os,sys,tempfile,unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import common,crypto_bridge,git_ack,native_entry,transport_base
import collect,threading
from types import SimpleNamespace

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

class CollectorRecoveryBudget(unittest.TestCase):
 """A synthetic two-window collection under a controlled clock; no CLI or network."""
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-collector-clock-');self.root=Path(self.temp.name);self.clock=[0.0]
 def tearDown(self):self.temp.cleanup()
 def collect(self,second_window_at):
  clock=self.clock;ctx={'run':5113,'attempt':1,'head':'a'*40,'nonce':'synthetic-5113'};series={'plan':{'windows':2},'context':ctx};requests=[];state={'recovered':False}
  key=self.root/'operator-key-5113';key.write_bytes(b'synthetic');key.chmod(0o600)
  args=SimpleNamespace(nonce=ctx['nonce'],run=ctx['run'],head=ctx['head'],out=self.root/'collection',private_key=key,workflow='.github/workflows/sdk10-5113.yml',seconds=28800,stop=threading.Event())
  class Calls:
   def __init__(inner,out,deadline,stop=None):inner.deadline=deadline;inner.seq=0;inner.events=[]
   def metadata(inner,path,missing=False):
    # Same refusal as the real transport: no request at or past its own deadline.
    common.need(clock[0]<inner.deadline-1,'original metadata deadline before request');inner.seq+=1;requests.append((clock[0],inner.deadline,path));clock[0]+=0.5
    if path.endswith('/artifacts?per_page=100'):
     listed=([1,2] if clock[0]>=200 else [])+([3,4] if clock[0]>=second_window_at else []);return {'total_count':0 if state['recovered'] else 2,'artifacts':[],'listed':listed}
    if path.endswith('/jobs?per_page=100'):return {'total_count':1,'jobs':[{'head_sha':ctx['head'],'name':'sdk10-original','id':5113}]}
    return {'head_sha':ctx['head'],'event':'workflow_dispatch','run_attempt':1,'path':args.workflow,'status':'completed' if state['recovered'] else 'in_progress'}
   def run(inner,tail,cap,seconds):
    line='CHECKTRAIL_SDK10_TERMINAL='+json.dumps({'context':ctx,'cleanup':{'synthetic':5113},'state':'synthetic-complete-5113'});path=self.root/'job-log-5113';path.write_text(line);return 0,line.encode(),path
  def listing(value,ctx,ordinals):return [{'ordinal':i} for i in ordinals] if all(i in value['listed'] for i in ordinals) else None
  def worker(folder,ctx,ordinal,meta,deadline,stop):return {'ordinal':ordinal,'artifactID':ordinal,'state':'CUSTODIED','error':None,'ownedChildrenReaped':True,'series':series,'part':{'ordinal':ordinal}}
  def deleted(row,ctx,deadline,stop,final=False):
   if final:state['recovered']=True
   return row
  def sleep(seconds):clock[0]+=seconds
  with mock.patch.object(collect,'Calls',Calls),mock.patch.object(collect,'context',return_value=ctx),mock.patch.object(collect.shutil,'disk_usage',return_value=SimpleNamespace(free=10**14)),mock.patch.object(collect,'validate_window_listing',side_effect=listing),mock.patch.object(collect,'handshake',side_effect=lambda jobs,ctx,window:{'window':window}),mock.patch.object(collect,'worker',side_effect=worker),mock.patch.object(collect,'validate_meta',return_value=series),mock.patch.object(collect,'archive_roundtrip',return_value={'synthetic':5113}),mock.patch.object(collect,'publish_recovery_ack',return_value={'synthetic':5113}),mock.patch.object(collect,'delete_after_custody',side_effect=deleted),mock.patch.object(collect.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(collect.time,'sleep',side_effect=sleep),mock.patch('builtins.print'):
   try:collect.collect(args);code=0
   except SystemExit as exit:code=exit.code
  result=common.read_json(args.out/'RESULT.json');return code,result,requests
 def recovery_deadline(self,requests):
  # The first handshake request is made the moment the first pair is listed.
  listed=[t for t,deadline,path in requests if path.endswith('/attempts/1/jobs?per_page=100')][0];self.assertGreaterEqual(listed,200);return listed+4500
 def test_later_window_that_never_appears_stops_polling_at_the_recovery_budget(self):
  code,result,requests=self.collect(second_window_at=10**9);recovery=self.recovery_deadline(requests)
  self.assertEqual(code,1);self.assertIn('bounded source window availability wait',result['error'])
  listings=[(t,deadline) for t,deadline,path in requests if path.endswith('/artifacts?per_page=100')]
  # The wait for the first pair ran under the whole bound; every later listing under the recovery budget.
  self.assertEqual({deadline for t,deadline in listings if t<200},{28790});self.assertEqual({deadline for t,deadline in listings if t>recovery-4500},{recovery})
  self.assertGreater(max(t for t,_ in listings),recovery-60);self.assertLess(max(t for t,_,_ in requests),recovery);self.assertLessEqual(self.clock[0],recovery)
 def test_later_window_listed_inside_the_recovery_budget_is_collected(self):
  code,result,requests=self.collect(second_window_at=3700.0);recovery=self.recovery_deadline(requests)
  self.assertEqual(code,0,result.get('error'));self.assertEqual(result['completedWindows'],[1,2]);self.assertEqual(result['completedParts'],4)
  window_two=[t for t,deadline,path in requests if path.endswith('/attempts/1/jobs?per_page=100')][1];self.assertGreaterEqual(window_two,3700.0);self.assertLess(window_two,recovery)
  # Waiting for the producer job to finish after recovery keeps the whole bound.
  self.assertEqual(requests[-1][1],28790)

class CollectorLingeringDeletion(unittest.TestCase):
 """Real window-listing validation over scripted run listings; no CLI or network."""
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-collector-lingering-');self.root=Path(self.temp.name);self.clock=[0.0]
 def tearDown(self):self.temp.cleanup()
 def artifact(self,ctx,ordinal,identifier=None):
  return {'id':identifier or 7300+ordinal,'name':common.name(ctx,ordinal),'size_in_bytes':4093,'expired':False,'workflow_run':{'id':ctx['run'],'head_sha':ctx['head']},'digest':None}
 def collect(self,second_window):
  # Window 1 is listed, custodied and deleted; second_window(n) then gives the
  # artifacts of the n-th run listing made while waiting for window 2.
  clock=self.clock;ctx={'run':7300,'attempt':1,'head':'a'*40,'nonce':'synthetic-7300'};series={'plan':{'windows':2},'context':ctx};state={'phase':1,'second':0,'recovered':False};listings=[]
  key=self.root/'operator-key-7300';key.write_bytes(b'synthetic');key.chmod(0o600)
  args=SimpleNamespace(nonce=ctx['nonce'],run=ctx['run'],head=ctx['head'],out=self.root/'collection',private_key=key,workflow='.github/workflows/sdk10-7300.yml',seconds=28800,stop=threading.Event())
  test=self
  class Calls:
   def __init__(inner,out,deadline,stop=None):inner.deadline=deadline;inner.seq=0;inner.events=[]
   def metadata(inner,path,missing=False):
    common.need(clock[0]<inner.deadline-1,'original metadata deadline before request');inner.seq+=1;clock[0]+=0.5
    if path.endswith('/artifacts?per_page=100'):
     if state['recovered']:items=[]
     elif state['phase']==1:items=[test.artifact(ctx,1),test.artifact(ctx,2)]
     else:state['second']+=1;items=second_window(state['second'])
     items,total=items if type(items) is tuple else (items,len(items))
     listings.append((state['phase'],[x['id'] for x in items]));return {'total_count':total,'artifacts':items}
    if path.endswith('/jobs?per_page=100'):return {'total_count':1,'jobs':[{'head_sha':ctx['head'],'name':'sdk10-original','id':7300}]}
    return {'head_sha':ctx['head'],'event':'workflow_dispatch','run_attempt':1,'path':args.workflow,'status':'completed' if state['recovered'] else 'in_progress'}
   def run(inner,tail,cap,seconds):
    line='CHECKTRAIL_SDK10_TERMINAL='+json.dumps({'context':ctx,'cleanup':{'synthetic':7300},'state':'synthetic-complete-7300'});path=self.root/'job-log-7300';path.write_text(line);return 0,line.encode(),path
  def worker(folder,ctx,ordinal,meta,deadline,stop):return {'ordinal':ordinal,'artifactID':meta['id'],'state':'CUSTODIED','error':None,'ownedChildrenReaped':True,'series':series,'part':{'ordinal':ordinal}}
  def deleted(row,ctx,deadline,stop,final=False):
   # The real delete returns only after the exact per-artifact 404.
   row['deletionKnownAbsent']=True
   if row['ordinal']==2:state['phase']=2
   if final:state['recovered']=True
   return row
  def sleep(seconds):clock[0]+=seconds
  with mock.patch.object(collect,'Calls',Calls),mock.patch.object(collect,'context',return_value=ctx),mock.patch.object(collect.shutil,'disk_usage',return_value=SimpleNamespace(free=10**14)),mock.patch.object(collect,'handshake',side_effect=lambda jobs,ctx,window:{'window':window}),mock.patch.object(collect,'worker',side_effect=worker),mock.patch.object(collect,'validate_meta',return_value=series),mock.patch.object(collect,'archive_roundtrip',return_value={'synthetic':7300}),mock.patch.object(collect,'publish_recovery_ack',return_value={'synthetic':7300}),mock.patch.object(collect,'delete_after_custody',side_effect=deleted),mock.patch.object(collect.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(collect.time,'sleep',side_effect=sleep),mock.patch('builtins.print'):
   try:collect.collect(args);code=0
   except SystemExit as exit:code=exit.code
  return code,common.read_json(args.out/'RESULT.json'),listings,ctx
 def test_deleted_member_still_listed_is_waited_out_and_recovery_continues(self):
  ctx={'run':7300,'head':'a'*40,'nonce':'synthetic-7300','attempt':1}
  # The count may already exclude the deleted row (listings 1-2) or count it (listing 3).
  def second(n):
   if n<=2:return [self.artifact(ctx,1)],0
   return ([self.artifact(ctx,1)] if n<=3 else [])+[self.artifact(ctx,3),self.artifact(ctx,4)]
  code,result,listings,_=self.collect(second)
  self.assertEqual(code,0,result.get('error'));self.assertEqual(result['completedWindows'],[1,2]);self.assertEqual([x['artifactID'] for x in result['parts']],[7301,7302,7303,7304])
  self.assertEqual([ids for phase,ids in listings if phase==2][:4],[[7301]]*2+[[7301,7303,7304],[7303,7304]])
  self.assertEqual(len(list((self.root/'collection'/'window-02').glob('INCOMPLETE-LISTING-*.json'))),3)
 def test_unrelated_artifact_beside_a_lingering_deleted_member_is_refused(self):
  ctx={'run':7300,'head':'a'*40,'nonce':'synthetic-7300','attempt':1}
  for label,extra in [('reused-name-new-id',self.artifact(ctx,1,7399)),('foreign-name',self.artifact(ctx,5)),('deleted-id-other-name',{**self.artifact(ctx,1),'name':common.name(ctx,6)})]:
   with self.subTest(label=label):
    self.temp.cleanup();self.temp=tempfile.TemporaryDirectory(prefix='sdk10-collector-lingering-');self.root=Path(self.temp.name);self.clock[0]=0.0
    code,result,listings,_=self.collect(lambda n:[self.artifact(ctx,2),extra])
    self.assertEqual(code,1);self.assertIn('no unexpected current-window artifact',result['error']);self.assertEqual(result['completedWindows'],[1])
  # A count the lingering row cannot explain is refused, not waited out.
  for total in [100,-1]:
   with self.subTest(total=total):
    self.temp.cleanup();self.temp=tempfile.TemporaryDirectory(prefix='sdk10-collector-lingering-');self.root=Path(self.temp.name);self.clock[0]=0.0
    code,result,listings,_=self.collect(lambda n:([self.artifact(ctx,2)],total))
    self.assertEqual(code,1);self.assertIn('bounded two-slot listing schema',result['error']);self.assertEqual(len([1 for phase,ids in listings if phase==2]),1)
 def test_deleted_member_listed_past_the_recovery_budget_is_refused(self):
  ctx={'run':7300,'head':'a'*40,'nonce':'synthetic-7300','attempt':1}
  code,result,listings,_=self.collect(lambda n:[self.artifact(ctx,2),self.artifact(ctx,3),self.artifact(ctx,4)])
  self.assertEqual(code,1);self.assertIn('bounded source window availability wait',result['error']);self.assertEqual(result['completedWindows'],[1])
  self.assertGreater(len([1 for phase,ids in listings if phase==2]),100);self.assertLessEqual(self.clock[0],4500+10)

if __name__=='__main__':unittest.main(verbosity=2)
