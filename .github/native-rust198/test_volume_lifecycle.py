"""Synthetic image lifecycle family: no hdiutil, mounts, SDK or source code runs."""
from pathlib import Path
import copy,json,os,stat,sys,tempfile,unittest
from unittest.mock import patch
import process_supervisor as N,producer as P,volume as V
from test_controller import profile,qualified

class LifecycleTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.p=profile();self.h=qualified(self.p);self.context={'GITHUB_RUN_ID':'7','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40};self.vc={'run':'7','attempt':'1','head':'a'*40}
 def tearDown(self):self.tmp.cleanup()
 def run_synthetic(self,mode):
  work=self.root/('rust198-7-1-synthetic-'+mode);events=[];ledger={'attached':False,'detached':False,'attachAttempted':False};vc=self.vc
  class Ops:
   def processes(self):return []
   def volume(self,work,context,host):
    if mode=='entered-without-journal':raise ValueError('synthetic failure before durable intent')
    def run(argv,seconds):
     if argv[1]=='create':
      events.append('create')
      if mode=='create-before':raise ValueError('synthetic failed create')
      Path(argv[-1]).write_bytes(b'synthetic inert image')
      if mode=='create-after':raise ValueError('synthetic create side effect before failure')
      return {}
     events.append('attach');ledger['attachAttempted']=True
     if mode=='attach-before':raise ValueError('synthetic attach failure')
     ledger['attached']=True
     if mode=='attach-after':raise ValueError('synthetic successful attach then lost response')
     return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk77s1' if mode!='bad-identity' else '/dev/disk77s1;not-an-identifier'}
    def probe(root):
     events.append('probe')
     if mode=='probe-raises':raise ValueError('synthetic probe failure after valid attachment')
     if mode=='probe-replaces-image':
      image=work/'source-work.sparseimage';image.rename(work/'preserved-old-image');image.write_bytes(b'new unrelated endpoint')
     return {'caseSensitive':mode!='probe-false'}
    result=V.prepare(work,vc,run,probe)
    if mode=='post-ready':raise ValueError('synthetic post-validation failure before returning volume record')
    return result
   def materialize(self,*args):raise ValueError('synthetic stop before any source materialization')
   def detach(self,record,context,host,work):
    events.append('detach-controller');current={'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk77s1'}
    def command(argv,seconds):events.append('detach');ledger['attached']=False;ledger['detached']=True;return {'ownedAttachmentAbsent':True}
    return V.detach_owned(record,vc,command,current)
  ops=Ops();result=P.observe(self.p,self.h,{},work,self.context,ops);lifecycle=P.finish_private(self.p,result,work,self.context,self.h,ops);return work,result,lifecycle,events,ledger
 def test_successful_attach_then_failed_case_probe_keeps_proof_and_detaches_exact_resource(self):
  for mode in ['probe-false','probe-raises','post-ready']:
   with self.subTest(mode=mode):
    work,result,lifecycle,events,ledger=self.run_synthetic(mode);self.assertIsNone(result['ownedVolume']);self.assertEqual('proven',result['ownedVolumeState']['attachmentOutcome']);self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertTrue(lifecycle['attachmentCleanupComplete']);self.assertTrue(lifecycle['ownedImageDetached']);self.assertNotIn('noOwnedImageWasEstablished',lifecycle);self.assertTrue(ledger['detached']);self.assertFalse(ledger['attached']);self.assertEqual(['create','attach','probe','detach-controller','detach'],events);self.assertEqual('detached',V.load_state(work,self.vc)['attachmentOutcome']);self.assertFalse(lifecycle['controllerLifecycleComplete'])
 def test_create_attach_identity_and_endpoint_unknowns_never_grant_detach_or_no_image_claim(self):
  for mode in ['create-before','create-after','attach-before','attach-after','bad-identity','probe-replaces-image','entered-without-journal']:
   with self.subTest(mode=mode):
    work,result,lifecycle,events,ledger=self.run_synthetic(mode);self.assertFalse(result['originalCommandBuildWitnessComplete']);self.assertFalse(lifecycle['attachmentCleanupComplete']);self.assertFalse(lifecycle['ownedImageDetached']);self.assertFalse(lifecycle.get('noOwnedImageWasEstablished',False));self.assertNotIn('detach-controller',events);self.assertNotIn('detach',events);self.assertFalse(ledger['detached']);self.assertFalse(lifecycle['controllerLifecycleComplete'])
    if mode in ['attach-after','bad-identity','probe-replaces-image']:self.assertTrue(ledger['attached'])
    if mode=='entered-without-journal':self.assertEqual('unknown-journal-after-controller-entry',result['ownedVolumeState']['stage'])
 def test_durable_intent_precedes_each_mutating_os_request(self):
  work=self.root/'intent';work.mkdir();seen=[]
  def run(argv,seconds):
   state=V.load_state(work,self.vc);seen.append(state['stage'])
   if argv[1]=='create':self.assertEqual('create-requested',state['stage']);Path(argv[-1]).write_bytes(b'inert')
   else:self.assertEqual('attach-requested',state['stage']);self.assertEqual('unknown',state['attachmentOutcome'])
   return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk77'}
  def probe(_):state=V.load_state(work,self.vc);self.assertEqual('attachment-identity-proven',state['stage']);self.assertEqual('proven',state['attachmentOutcome']);return {'caseSensitive':True}
  V.prepare(work,self.vc,run,probe);self.assertEqual(['create-requested','attach-requested'],seen);self.assertEqual(0o400,stat.S_IMODE((work/'control'/V.STATE).stat().st_mode))
 def test_missing_or_inconsistent_or_wrong_context_journal_cannot_be_detach_authority(self):
  work=self.root/'journal';work.mkdir();self.assertEqual('never-attempted',V.load_state(work,self.vc)['stage']);(work/'source-work.sparseimage').write_bytes(b'unrecorded');self.assertEqual('unknown',V.load_state(work,self.vc)['attachmentOutcome']);(work/'source-work.sparseimage').unlink();value={**V.plan(work,self.vc),'runContext':self.vc,'stage':'attach-requested','imageOutcome':'created','attachmentOutcome':'proven'};V.save_state(work,value)
  with self.assertRaisesRegex(ValueError,'remain unknown'):V.load_state(work,self.vc)
  value.update(stage='intent-persisted',imageOutcome='not-attempted',attachmentOutcome='not-attempted',runContext={**self.vc,'attempt':'2'});V.save_state(work,value)
  with self.assertRaisesRegex(ValueError,'context'):V.load_state(work,self.vc)
 def test_detach_failure_or_missing_absence_proof_stays_unknown_and_cannot_retry(self):
  for mode in ['raises','absence-missing']:
   work=self.root/mode;work.mkdir()
   def run(argv,seconds):
    if argv[1]=='create':Path(argv[-1]).write_bytes(b'inert')
    return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk99'}
   record=V.prepare(work,self.vc,run,lambda _:{'caseSensitive':True});current={'imagePath':record['image'],'mountPoint':record['mount'],'device':record['device']}
   def fail(argv,seconds):
    self.assertEqual('unknown',V.load_state(work,self.vc)['attachmentOutcome'])
    if mode=='raises':raise TimeoutError('synthetic detach deadline')
    return {'ownedAttachmentAbsent':False}
   with self.assertRaises((ValueError,TimeoutError)):V.detach_owned(record,self.vc,fail,current)
   self.assertEqual('unknown',V.load_state(work,self.vc)['attachmentOutcome'])
   with self.assertRaisesRegex(ValueError,'stale/unknown'):V.detach_owned(record,self.vc,lambda *_:{'ownedAttachmentAbsent':True},current)

 def test_permissions_file_sync_replace_exact_parent_sync_order(self):
  work=self.root/'order';work.mkdir();value={**V.plan(work,self.vc),'runContext':self.vc,'stage':'intent-persisted','imageOutcome':'not-attempted','attachmentOutcome':'not-attempted'};events=[];chmod=os.fchmod;sync=os.fsync;replace=os.replace
  def fchmod(fd,mode):events.append(('fchmod',mode));return chmod(fd,mode)
  def fsync(fd):
   st=os.fstat(fd)
   if stat.S_ISDIR(st.st_mode):self.assertEqual((work/'control').stat().st_ino,st.st_ino);events.append(('parent-fsync',st.st_ino))
   else:self.assertEqual(0o400,stat.S_IMODE(st.st_mode));events.append(('file-fsync',st.st_ino))
   return sync(fd)
  def renamed(a,b):events.append(('replace',str(b)));return replace(a,b)
  with patch.object(V.os,'fchmod',fchmod),patch.object(V.os,'fsync',fsync),patch.object(V.os,'replace',renamed):V.save_state(work,value)
  self.assertEqual(['fchmod','file-fsync','replace','parent-fsync'],[r[0] for r in events]);self.assertEqual('intent-persisted',V.load_state(work,self.vc)['stage'])
 def test_parent_fsync_failure_prevents_create_or_attach_and_latches_unknown(self):
  for stop,expected in [('create-requested',[]),('attach-requested',['create']),('attachment-identity-proven',['create','attach']),('ready',['create','attach','probe'])]:
   work=self.root/stop;work.mkdir();calls=[];sync=os.fsync
   def run(argv,seconds):
    calls.append(argv[1])
    if argv[1]=='create':Path(argv[-1]).write_bytes(b'inert')
    return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk88'}
   def probe(_):calls.append('probe');return {'caseSensitive':True}
   def fail_parent(fd):
    if stat.S_ISDIR(os.fstat(fd).st_mode) and json.loads((work/'control'/V.STATE).read_bytes())['stage']==stop:raise OSError('synthetic exact-parent fsync failure')
    return sync(fd)
   with patch.object(V.os,'fsync',fail_parent),self.assertRaises((OSError,ValueError)):V.prepare(work,self.vc,run,probe)
   self.assertEqual(expected,calls);self.assertEqual('unknown-persistence-failure',V.load_state(work,self.vc)['stage'])
   with self.assertRaisesRegex(ValueError,'latched'):V.save_state(work,{})
   self.assertEqual(expected,calls)
 def test_prior_proven_detach_cannot_run_after_parent_persistence_failure(self):
  work=self.root/'previous-proven';work.mkdir();calls=[];sync=os.fsync
  def run(argv,seconds):
   if argv[1]=='create':Path(argv[-1]).write_bytes(b'inert')
   return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk66'}
  record=V.prepare(work,self.vc,run,lambda _:{'caseSensitive':True});current={'imagePath':record['image'],'mountPoint':record['mount'],'device':record['device']}
  def fail(fd):
   if stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError('synthetic parent sync failure before detach')
   return sync(fd)
  def detach(*args):calls.append('detach');return {'ownedAttachmentAbsent':True}
  with patch.object(V.os,'fsync',fail),self.assertRaises((OSError,ValueError)):V.detach_owned(record,self.vc,detach,current)
  self.assertEqual([],calls);self.assertEqual('unknown',V.load_state(work,self.vc)['attachmentOutcome'])
  with self.assertRaisesRegex(ValueError,'stale/unknown'):V.detach_owned(record,self.vc,detach,current)
  self.assertEqual([],calls)
 def test_terminal_detach_parent_sync_failure_never_credits_actual_detach(self):
  work=self.root/'terminal';work.mkdir();calls=[];sync=os.fsync
  def run(argv,seconds):
   if argv[1]=='create':Path(argv[-1]).write_bytes(b'inert')
   return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk55'}
  record=V.prepare(work,self.vc,run,lambda _:{'caseSensitive':True});current={'imagePath':record['image'],'mountPoint':record['mount'],'device':record['device']}
  def fail(fd):
   if stat.S_ISDIR(os.fstat(fd).st_mode) and json.loads((work/'control'/V.STATE).read_bytes())['stage']=='detached':raise OSError('synthetic terminal parent sync failure')
   return sync(fd)
  def detach(*args):calls.append('actual-detach-observed');return {'ownedAttachmentAbsent':True}
  with patch.object(V.os,'fsync',fail),self.assertRaises((OSError,ValueError)):V.detach_owned(record,self.vc,detach,current)
  self.assertEqual(['actual-detach-observed'],calls);self.assertEqual('unknown-persistence-failure',V.load_state(work,self.vc)['stage'])
  with self.assertRaisesRegex(ValueError,'stale/unknown'):V.detach_owned(record,self.vc,detach,current)
  self.assertEqual(['actual-detach-observed'],calls)
 def test_wrong_physical_parent_descriptor_refuses_persistence_acknowledgment(self):
  work=self.root/'wrong-parent';work.mkdir();other=self.root/'unrelated';other.mkdir();opened=os.open;value={**V.plan(work,self.vc),'runContext':self.vc,'stage':'intent-persisted','imageOutcome':'not-attempted','attachmentOutcome':'not-attempted'}
  def substituted(path,flags,mode=0o777):return opened(other if flags&os.O_DIRECTORY else path,flags,mode)
  with patch.object(V.os,'open',substituted),self.assertRaisesRegex(ValueError,'Exact physical journal parent'):V.save_state(work,value)
  self.assertEqual('unknown',V.load_state(work,self.vc)['attachmentOutcome'])

class FirstPartyNative(N.Native):
 """The real phase runner and journal, with each hdiutil request replaced by a first-party child that exits 41."""
 def run(self,name,args,env,cwd,seconds,as_build=True):return super().run(name,[sys.executable,'-I','-c','import sys;sys.exit(41)'],env,cwd,min(seconds,10),as_build)

class PhaseJournalFailureTests(unittest.TestCase):
 context={'GITHUB_RUN_ID':'7','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40};vc={'run':'7','attempt':'1','head':'a'*40}
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.p=profile();self.h=qualified(self.p)
  self.p['bounds'].update(minimumFreeBytes=0,logBytes=4096,sampledRssBytes=1024**3,nativeSeconds=60)
 def tearDown(self):self.tmp.cleanup()
 def lifecycle(self,label,ops,journal_error):
  work=self.root/('rust198-7-1-journal-'+label);patches=[patch.dict(N.LIMITS,dict(N.LIMITS)),patch.object(N,'ps_rows',return_value=[]),patch.object(N,'Native',FirstPartyNative)]
  if journal_error:patches.append(patch.object(N,'append_phase_receipt',side_effect=OSError(28,'synthetic journal disk full 6151')))
  for item in patches:item.start()
  try:result=P.observe(self.p,self.h,{},work,self.context,ops);lifecycle=P.finish_private(self.p,result,work,self.context,self.h,ops)
  finally:
   for item in reversed(patches):item.stop()
  return work,json.loads((work/'capture/RESULT.json').read_bytes()),json.loads((work/'LIFECYCLE.json').read_bytes())
 def test_volume_phase_journal_failure_is_retained_beside_the_phase_failure(self):
  work,result,lifecycle=self.lifecycle('volume',P.Operations(self.p),True)
  self.assertEqual([{'phase':'owned-volume-0','type':'OSError','reason':None}],result['phaseJournalFailures'])
  self.assertEqual({'type':'ValueError','reason':'Native phase failed: owned-volume-0'},result['failure'])
  self.assertFalse(os.path.lexists(work/'capture/PHASES.json'));self.assertEqual([],lifecycle['phaseJournalFailures'])
 def test_volume_phase_failure_with_an_intact_journal_records_no_journal_failure(self):
  work,result,lifecycle=self.lifecycle('volume-intact',P.Operations(self.p),False)
  self.assertEqual([],result['phaseJournalFailures']);self.assertEqual({'type':'ValueError','reason':'Native phase failed: owned-volume-0'},result['failure'])
  self.assertEqual([('owned-volume-0',41)],[(row['phase'],row['exitCode']) for row in json.loads((work/'capture/PHASES.json').read_bytes())])
 def detach_operations(self):
  vc=self.vc
  class SyntheticVolumeOperations(P.Operations):
   def volume(self,work,context,host):
    def run(argv,seconds):
     if argv[1]=='create':Path(argv[-1]).write_bytes(b'synthetic inert image 6151')
     return {'imagePath':str(work/'source-work.sparseimage'),'mountPoint':str(work/'case-work'),'device':'/dev/disk61s1'}
    return V.prepare(work,vc,run,lambda _:{'caseSensitive':True})
   def materialize(self,*args):raise ValueError('synthetic stop before any source materialization 6151')
  return SyntheticVolumeOperations(self.p)
 def test_detach_phase_journal_failure_is_retained_beside_the_detach_failure(self):
  work,result,lifecycle=self.lifecycle('detach',self.detach_operations(),True)
  self.assertEqual('proven',result['ownedVolumeState']['attachmentOutcome']);self.assertEqual([],result['phaseJournalFailures'])
  self.assertEqual([{'phase':'owned-volume-detach-identity','type':'OSError','reason':None}],lifecycle['phaseJournalFailures'])
  self.assertEqual({'type':'ValueError','reason':'Native phase failed: owned-volume-detach-identity'},lifecycle['failure'])
  self.assertTrue(lifecycle['privateRetentionComplete']);self.assertFalse(lifecycle['ownedImageDetached'])
 def test_detach_phase_failure_with_an_intact_journal_records_no_journal_failure(self):
  work,result,lifecycle=self.lifecycle('detach-intact',self.detach_operations(),False)
  self.assertEqual([],lifecycle['phaseJournalFailures']);self.assertEqual({'type':'ValueError','reason':'Native phase failed: owned-volume-detach-identity'},lifecycle['failure'])
  self.assertEqual([('owned-volume-detach-identity',41)],[(row['phase'],row['exitCode']) for row in json.loads((work/'capture/PHASES.json').read_bytes())])

if __name__=='__main__':unittest.main()
