"""Manual original Rust1.98 producer controller. No execution at import or plan.
A concrete root-owned workflow-startup grant is required before source activation.
This is not an MCP interface and a model-supplied boolean cannot grant execution.
"""
from pathlib import Path
import argparse,hashlib,json,os,plistlib,re,shutil,signal,stat,sys,time
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
import placement as PL
import admission as A,materializer as M,process_supervisor as N,retention as R,volume as V
from profile_constants import EXPECTED_CONFIGURE,EXPECTED_DIST,EXPECTED_INPUTS

def need(v,m):
 if not v:raise ValueError(m)
def validate_profile(p):
 need(p['selection']=='rust-1.98.0-original-aarch64-apple-darwin' and p['sourceCommit']=='88d9e12ae178fab0fb5cc050a94da85685d449ea' and p['sourceVersion']=='1.98.0','Exact original1.98source selection');need(p['configure']==EXPECTED_CONFIGURE and len(p['configure'])==37 and p['dist']==EXPECTED_DIST,'Original36configureargs/full-defaultdist command drift');need(p['prepare']==['make','prepare'] and p['prepareAttempts']==5 and p['prepareBackoffSeconds']==[1,2,3,4],'Original prepare retry semantics');need(p['host']==p['target']=='aarch64-apple-darwin' and p['configuredCodegenBackends']==['llvm','cranelift'] and p['profile']=='dist' and p['buildStage']==2,'Original host/target/backends/default profile');need({r['id']:(r['bytes'],r['sha256'],r['prefix']) for r in p['inputs']}==EXPECTED_INPUTS and len(p['inputs'])==4,'Exact source/bootstrap input set');need(p['originalFeaturesTargetsOrDefaultComponentsReduced'] is False,'No reduced original features');return True

def clean_environment(work,source,host,p):
 paths=list(dict.fromkeys([str(Path(v['path']).parent) for v in host['tools'].values()]+[str(Path(host['sccache']['path']).parent),'/usr/bin','/bin','/usr/sbin','/sbin']));return {'PATH':':'.join(paths),'HOME':str(work/'state/home'),'TMPDIR':str(work/'state/tmp'),'CARGO_HOME':str(work/'state/cargo'),'CARGO_NET_OFFLINE':'true','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(work/'control/empty-git.config'),'GIT_TERMINAL_PROMPT':'0','GIT_OPTIONAL_LOCKS':'0','DEVELOPER_DIR':p['developerDir'],'SDKROOT':host['sdkPath'],'MACOSX_DEPLOYMENT_TARGET':'11.0','MACOSX_STD_DEPLOYMENT_TARGET':'11.0','DIST_REQUIRE_ALL_TOOLS':'1','CODEGEN_BACKENDS':'llvm,cranelift','SCCACHE_DIR':str(work/'state/sccache'),'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8','CI':'true'}

def activate_owned_working_tree(root,uid,gid):
 for folder,dirs,files in os.walk(root,followlinks=False):
  os.chown(folder,uid,gid)
  for name in dirs+files:
   p=Path(folder)/name
   if p.is_symlink():os.lchown(p,uid,gid)
   else:os.chown(p,uid,gid)

def phase_summary(child,outer):
 required=['configure','prepare','original-dist'];result={name:{'status':'incomplete','reason':'not-established'} for name in required}
 for row in child.get('phases',[]):
  key='prepare' if row['phase'].startswith('prepare-attempt-') else row['phase']
  if key in result:result[key]={'status':row['status'],'exitCode':row['exitCode']}
 prepare=[row for row in child.get('phases',[]) if row['phase'].startswith('prepare-attempt-')]
 if prepare and prepare[-1]['status']=='command-failed':
  # Earlier failed attempts are retried; a lower final attempt means the next retry
  # was refused or interrupted without an exit row, not that this exit ended the build.
  attempt=int(prepare[-1]['phase'].rsplit('-',1)[1]);result['prepare']['attempt']=attempt;result['prepare']['laterAttemptWithoutExitCode']=attempt<PREPARE_ATTEMPTS
 if outer is not True or child.get('originalCommandsComplete') is not True:
  for row in result.values():
   if row['status']=='command-passed':row.update(status='incomplete',reason='outer completion/quiescence not qualified')
 return result

# The build account writes this report, so its rows can name command exits but
# never grant pass credit: phase_summary() revokes passes without outer completion.
CHILD_REPORT_BYTES=256*1024
PREPARE_ATTEMPTS=5
CHILD_PHASES=frozenset(['configure','original-dist',*('prepare-attempt-'+str(n) for n in range(1,PREPARE_ATTEMPTS+1))])
def possible_history(rows,complete):
 # Exactly the row orders sequence.py can write: configure, consecutive prepare
 # attempts until one passes, then dist; a complete report has all of them passing.
 names=[r['phase'] for r in rows];codes=[r['exitCode'] for r in rows]
 if not rows:return not complete
 if names[0]!='configure':return False
 if codes[0]!=0:return len(rows)==1 and not complete
 k=1;prepared=False
 while k<len(rows) and names[k]=='prepare-attempt-'+str(k):
  k+=1
  if codes[k-1]==0:prepared=True;break
 if not prepared or k==len(rows):return len(rows)==k and not complete
 return names[k]=='original-dist' and len(rows)==k+1 and (codes[k]==0 or not complete)
def phase_command(p,phase):
 return p['prepare'] if phase.startswith('prepare-attempt-') else p['configure' if phase=='configure' else 'dist']
def read_child_report(file,p):
 before=file.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=CHILD_REPORT_BYTES,'Physical bounded child phase report');fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  opened=os.fstat(stream.fileno());need((opened.st_dev,opened.st_ino)==(before.st_dev,before.st_ino),'Opened child phase report endpoint');body=stream.read(CHILD_REPORT_BYTES+1)
 need(len(body)==before.st_size,'Child phase report changed while reading');value=json.loads(body);need(isinstance(value,dict) and isinstance(value.get('phases'),list) and len(value['phases'])<=len(CHILD_PHASES),'Child phase report shape')
 for row in value['phases']:need(isinstance(row,dict) and row.get('phase') in CHILD_PHASES and type(row.get('exitCode')) is int and -signal.NSIG<row['exitCode']<=255 and row.get('status')==('command-passed' if row['exitCode']==0 else 'command-failed'),'Child phase row shape')
 # sequence.py writes each row with the exact validated profile command it ran.
 need(all(type(row.get('argv')) is list and row['argv']==phase_command(p,row['phase']) for row in value['phases']),'Child phase row argv differs from validated profile command')
 # sequence.py always writes both keys; a cache shutdown that did not exit 0
 # always records a failure, so a report without one cannot be attributed.
 need('failure' in value and 'cacheStopExitCode' in value,'Child report failure/cache shutdown fields absent');cache=value['cacheStopExitCode']
 need(cache is None or (type(cache) is int and -signal.NSIG<cache<=255),'Child cache shutdown exit shape');need(value['failure'] is not None or cache==0,'Child report without failure after unclean cache shutdown')
 failure=value.get('failure');need(type(value.get('originalCommandsComplete')) is bool and (failure is None or (isinstance(failure,dict) and isinstance(failure.get('type'),str) and isinstance(failure.get('reason'),str))),'Child completion/failure shape')
 # sequence.py marks a report complete only with no failure and a clean cache shutdown.
 need(value['originalCommandsComplete'] is False or (failure is None and type(value.get('cacheStopExitCode')) is int and value['cacheStopExitCode']==0),'Complete child report with failure or cache shutdown exit')
 need(possible_history(value['phases'],value['originalCommandsComplete']),'Child phase history impossible');return value

def retain_generated_configuration(source,capture):
 # Original bootstrap.py1346..1361 selects bootstrap.toml before config.toml.
 # Exact bytes are retained for root semantic/default review, not declared equal.
 selected=next((source/name for name in ['bootstrap.toml','config.toml'] if os.path.lexists(source/name)),None);need(selected is not None,'Actual original generated bootstrap configuration absent');before=selected.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=1024**2,'Physical bounded generated bootstrap configuration');body=selected.read_bytes();after=selected.lstat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) and len(body)==before.st_size,'Generated bootstrap configuration changed during capture');file=capture/'generated-original-bootstrap.toml';need(not file.exists(),'Fresh generated configuration capture');file.write_bytes(body);file.chmod(0o400);return {'originalWorkingPath':str(selected),'privateCapture':str(file),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'semanticEqualityToPublisherBuilderConfigClaimed':False,'rootSemanticAndDefaultReviewStillRequired':True}

class Operations:
 def __init__(self,profile):self.profile=profile;self.volume_native=None
 def materialize(self,pins,archives,destination):return M.materialize(pins[0],pins[1:],archives,destination,self.profile['bounds'])
 def activate(self,source,host):activate_owned_working_tree(source,host['buildUid'],host['buildGid'])
 def native(self,work,host):N.LIMITS.update(wholeSeconds=self.profile['bounds']['nativeSeconds'],logBytes=self.profile['bounds']['logBytes'],minimumFreeBytes=self.profile['bounds']['minimumFreeBytes'],sampledRssBytes=self.profile['bounds']['sampledRssBytes']);return N.Native(work,host)
 def volume(self,work,context,host):
  self.volume_native=self.native(work,host);volume_context={'run':context['GITHUB_RUN_ID'],'attempt':context['GITHUB_RUN_ATTEMPT'],'head':context['GITHUB_SHA']};expected=V.plan(work,volume_context)
  def command(argv,seconds):
   name='owned-volume-'+str(len(self.volume_native.receipts));record=self.volume_native.run(name,argv,{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},work,seconds,as_build=False)
   if 'attach' not in argv:return {}
   info=self.volume_native.run(name+'-identity',['/usr/bin/hdiutil','info','-plist'],{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},work,30,as_build=False);file=Path(info['log']['path']);need(file.stat().st_size<=1024**2,'Bounded attached-image metadata');value=plistlib.loads(file.read_bytes());images=[i for i in value.get('images',[]) if i.get('image-path')==expected['image']];need(len(images)==1,'Exact owned image metadata');entities=[i for i in images[0].get('system-entities',[]) if i.get('mount-point')==expected['mount']];need(len(entities)==1,'Exact owned mount metadata');return {'imagePath':expected['image'],'mountPoint':expected['mount'],'device':entities[0]['dev-entry']}
  record=V.prepare(work,volume_context,command);Path(record['image']).chmod(0o600);return record
 def detach(self,record,context,host,work):
  native=self.native(work,host);query=native.run('owned-volume-detach-identity',['/usr/bin/hdiutil','info','-plist'],{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},work,30,as_build=False);path=Path(query['log']['path']);need(path.stat().st_size<=1024**2,'Bounded detach identity metadata');value=plistlib.loads(path.read_bytes());images=[i for i in value.get('images',[]) if i.get('image-path')==record['image']];need(len(images)==1,'Owned image metadata before detach');entities=[i for i in images[0].get('system-entities',[]) if i.get('mount-point')==record['mount']];need(len(entities)==1,'Owned mount metadata before detach');current={'imagePath':record['image'],'mountPoint':record['mount'],'device':entities[0]['dev-entry']};vc={'run':context['GITHUB_RUN_ID'],'attempt':context['GITHUB_RUN_ATTEMPT'],'head':context['GITHUB_SHA']}
  def command(argv,seconds):
   native.run('owned-volume-detach',argv,{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},work,seconds,as_build=False);after=native.run('owned-volume-post-detach-identity',['/usr/bin/hdiutil','info','-plist'],{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},work,30,as_build=False);path=Path(after['log']['path']);need(path.stat().st_size<=1024**2,'Bounded post-detach identity metadata');info=plistlib.loads(path.read_bytes());return {'ownedAttachmentAbsent':not any(i.get('image-path')==record['image'] for i in info.get('images',[]))}
  return V.detach_owned(record,vc,command,current)
 def processes(self):return N.ps_rows()
 def source_matches(self,source,records):return M.original_frame_matches(source,records)

# The top-level lifecycle is independent of transport: no download, key or export calls.
def observe(p,host,archives,work,context,ops):
 validate_profile(p);assessment=A.assess(p,host,include_workspace=False);need(assessment['nativeEligible'],'Native admission incomplete: '+','.join(assessment['failures']));need(work.parent==work.parent.resolve(strict=True) and re.fullmatch(r'rust198-'+re.escape(context['GITHUB_RUN_ID'])+'-'+re.escape(context['GITHUB_RUN_ATTEMPT'])+r'-[a-z0-9-]{8,64}',work.name),'Exact owned Rust run namespace');need(not os.path.lexists(work),'Fresh owned original producer namespace');work.mkdir(mode=0o755);work.chmod(0o755);(work/'control').mkdir(mode=0o755);(work/'control').chmod(0o755);(work/'capture').mkdir(mode=0o700);(work/'capture').chmod(0o700);(work/'state').mkdir(mode=0o700);(work/'state').chmod(0o700);started=time.monotonic();deadline=started+p['bounds']['wholeSeconds'];marker={'selection':p['selection'],'runContext':context,'work':str(work),'upstreamSourceCommit':p['sourceCommit'],'volumeControllerEntered':False};N.atomic_json(work/'control/OWNERSHIP.json',marker,mode=0o444);volume_record=None;native=None;child={};complete=False;failure=None;quiescence={'allBuildUidProcessesStopped':False};inventory=None;configuration=None;child_file=None;failure_child_report=None
 try:
  need(not [r for r in ops.processes() if r['uid']==host['buildUid']],'Exclusive fresh build account is not quiescent');marker['volumeControllerEntered']=True;N.atomic_json(work/'control/OWNERSHIP.json',marker,mode=0o444);volume_record=ops.volume(work,context,host);host={**host,'caseSensitiveWorkspace':volume_record['caseProbe']['caseSensitive'],'capacityRoots':[volume_record['mount']]};need(A.assess(p,host)['nativeEligible'],'Measured owned workspace admission failed');materialized=ops.materialize(p['inputs'],archives,Path(volume_record['mount'])/'payload');Path(volume_record['mount']).chmod(0o755);Path(materialized['source']).parent.chmod(0o755);source=Path(materialized['source']);records=json.loads(Path(materialized['memberMap']).read_bytes());ops.activate(source,host)
  for name in ['home','tmp','cargo','sccache']:(work/'state'/name).mkdir(mode=0o700)
  activate_owned_working_tree(work/'state',host['buildUid'],host['buildGid']) if isinstance(ops,Operations) else None
  profile_file=work/'control/profile.json';N.atomic_json(profile_file,p,mode=0o444);(work/'control/empty-git.config').write_bytes(b'');(work/'control/empty-git.config').chmod(0o444);child_file=work/'state/original-phases.json';env=clean_environment(work,source,host,p);native=ops.native(work,host);native.run('original-source-producer',[host['tools']['python3']['path'],'-I','-B',str(HERE/'sequence.py'),str(profile_file),str(source),host['sccache']['path'],str(child_file)],env,source,min(p['bounds']['nativeSeconds'],deadline-time.monotonic()-300));child=read_child_report(child_file,p);need(child.get('originalCommandsComplete') is True,'Child original command sequence not complete');need(not [r for r in ops.processes() if r['uid']==host['buildUid']],'Build UID not quiescent after native command');quiescence={'allBuildUidProcessesStopped':True};ops.source_matches(source,records);configuration=retain_generated_configuration(source,work/'capture')
  dist=source/'build/dist';need(dist.is_dir() and all((dist/name).is_file() and not (dist/name).is_symlink() for name in p['minimumSDKArtifactNames']),'Selected rustc/cargo/std originaldist outputs absent');inventory=R.catalog({'original-dist':dist},p['bounds']);sizes={r['member']:r['bytes'] for r in inventory};need(all(sizes.get('original-dist/'+name,0)>0 for name in p['minimumSDKArtifactNames']),'Selected rustc/cargo/std originaldist outputs empty');need(time.monotonic()<deadline,'Late original producer result');complete=True
 except Exception as error:failure={'type':type(error).__name__,'reason':str(error)[:1024]}
 finally:
  try:quiescence={'allBuildUidProcessesStopped':not [r for r in ops.processes() if r['uid']==host['buildUid']]}
  except Exception as error:quiescence={'allBuildUidProcessesStopped':False,'reason':str(error)[:512]}
  try:
   vc={'run':context['GITHUB_RUN_ID'],'attempt':context['GITHUB_RUN_ATTEMPT'],'head':context['GITHUB_SHA']};volume_state=V.load_state(work,vc)
   if volume_state['stage']=='never-attempted' and marker['volumeControllerEntered']:volume_state.update(stage='unknown-journal-after-controller-entry',imageOutcome='unknown',attachmentOutcome='unknown')
  except Exception as error:volume_state={'stage':'unknown-or-invalid-journal','imageOutcome':'unknown','attachmentOutcome':'unknown','failure':str(error)[:512]}
  if not quiescence['allBuildUidProcessesStopped']:complete=False
  # A failed sequence exits nonzero after writing its report, so Native.run()
  # raises before the read above. It is read here only once no build-UID process
  # remains that could still rewrite it.
  if not child and child_file is not None and quiescence['allBuildUidProcessesStopped']:
   try:child=read_child_report(child_file,p);failure_child_report={'accepted':True}
   except Exception as error:failure_child_report={'accepted':False,'type':type(error).__name__,'reason':str(error)[:512]}
  if time.monotonic()>=deadline:complete=False;failure={'type':'TimeoutError','reason':'Whole original producer deadline exhausted'}
  result={'originalCommandBuildWitnessComplete':complete,'phaseAccounting':phase_summary(child,complete),'failurePathChildReport':failure_child_report,'childFailure':{'type':child['failure']['type'][:128],'reason':child['failure']['reason'][:512]} if child.get('failure') else None,'failure':failure,'quiescence':quiescence,'runContext':context,'sourceCommit':p['sourceCommit'],'nativePhases':native.receipts if native else [],'producedDistInventory':inventory,'generatedOriginalConfiguration':configuration,'originalStableGuardNoOps':{'enzymePackaging':'original-stable-guard-no-pass-credit','miriPackaging':'original-stable-guard-no-pass-credit','craneliftPackaging':'original-stable-guard-no-pass-credit; configured compiler backend remains selected','allOtherDefaultComponentActualSelection':'not-independently-accepted; root original trace/config review required'},'ownedVolume':volume_record,'ownedVolumeState':volume_state,'sourceWorkspace':str(source) if 'source' in locals() else None,'elapsedSeconds':time.monotonic()-started,'allOriginalDefaultComponentCoverageStillRequiresRootReview':True,'upstreamTestsOrModelBenchmarkTrialsPassedClaimed':False,'wholeProducerSDKLegalHistoricalEqualityOrGateAClosureClaimed':False,'exportOrEncryptionPerformed':False};N.atomic_json(work/'capture/RESULT.json',result,mode=0o400)
 return result

def finish_private(p,result,work,context,host,ops):
 """Retain only quiescent generated outputs/logs privately, then detach owned image.
 Image bytes remain in the owned namespace. A failed or live build is never erased.
 """
 marker=json.loads((work/'control/OWNERSHIP.json').read_bytes());need(marker['runContext']==context and marker['work']==str(work) and marker['selection']==p['selection'],'Owned lifecycle marker/context');lifecycle={'privateRetentionComplete':False,'ownedImageDetached':False,'attachmentCleanupComplete':False,'workAndFailureEvidencePreserved':True,'remoteExportOrStockHostChangePerformed':False};failure=None
 try:
  need(result['elapsedSeconds']<p['bounds']['wholeSeconds'] and (result.get('failure') or {}).get('type')!='WholeDeadline','Whole deadline exhausted; private work preserved without further native actions')
  need(result['quiescence']['allBuildUidProcessesStopped'] is True and not [r for r in ops.processes() if r['uid']==host['buildUid']],'Live/unknown build UID refuses packaging and detach');roots={'controller-capture':work/'capture'}
  if result.get('sourceWorkspace'):
   dist=Path(result['sourceWorkspace'])/'build/dist'
   if dist.is_dir():roots['original-dist']=dist
  retained=R.retain_private(roots,work/'PRIVATE-OUTPUTS.tar',p['bounds'],result['quiescence']);lifecycle.update(privateRetentionComplete=True,privateArchive=retained)
  need(not [r for r in ops.processes() if r['uid']==host['buildUid']],'Build UID became live before detach')
  volume_state=result.get('ownedVolumeState',{'imageOutcome':'unknown','attachmentOutcome':'unknown'});outcome=volume_state['attachmentOutcome'];image_outcome=volume_state['imageOutcome']
  if outcome=='proven':
   lifecycle['detachReceipt']=ops.detach(volume_state,context,host,work);lifecycle['ownedImageDetached']=lifecycle['detachReceipt']['detachedOwnedImage'] is True;lifecycle['attachmentCleanupComplete']=lifecycle['ownedImageDetached']
  elif outcome=='not-attempted' and image_outcome in ['not-attempted','created']:
   lifecycle.update(attachmentCleanupComplete=True,noAttachmentWasAttempted=True,noOwnedImageWasEstablished=image_outcome=='not-attempted',ownedImagePreservedWithoutAttachment=image_outcome=='created')
  else:raise ValueError('Unknown image/attachment outcome: cleanup-incomplete, no detach authority')
 except Exception as error:failure={'type':type(error).__name__,'reason':str(error)[:1024]}
 lifecycle.update(failure=failure,controllerLifecycleComplete=result['originalCommandBuildWitnessComplete'] is True and lifecycle['privateRetentionComplete'] and lifecycle['attachmentCleanupComplete'],wholeProducerSDKLegalHistoricalEqualityOrGateAClosureClaimed=False);N.atomic_json(work/'LIFECYCLE.json',lifecycle,mode=0o400);return lifecycle

class WholeDeadline(TimeoutError):pass

def enforce_whole_deadline(seconds):
 def elapsed(_signal,_frame):raise WholeDeadline('Whole original producer wall-clock deadline')
 previous=signal.signal(signal.SIGALRM,elapsed);signal.setitimer(signal.ITIMER_REAL,seconds);return previous

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['plan','observe']);parser.add_argument('profile');parser.add_argument('--operator-grant');parser.add_argument('--grant-sha256');parser.add_argument('--host-receipt');parser.add_argument('--archives');parser.add_argument('--work');args=parser.parse_args();profile_file=Path(args.profile);p=json.loads(profile_file.read_bytes());validate_profile(p)
 if args.mode=='plan':print(json.dumps({'profileValidated':True,'nativeExecutionGranted':False,'originalCommands':[p['configure'],p['prepare'],p['dist']],'unassessed':['SDK262/SLA/toolphysicalprotection','sourcecasevolume','originalsccache/Rosetta/IPC','buildmemory/disk/time/capturefit'],'anySDKOrSourceExecuted':False}));return 0
 need(os.getuid()==0 and all([args.operator_grant,args.grant_sha256,args.host_receipt,args.archives,args.work]),'Explicit root startup grant/host/archive/work inputs required');context={k:os.environ.get(k,'') for k in ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA']};need(all(context.values()),'Actual hosted run context');PL.require_native_work(context,HERE,Path(args.work));A.validate_operator_grant(Path(args.operator_grant),args.grant_sha256,hashlib.sha256(profile_file.read_bytes()).hexdigest(),context,hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),hashlib.sha256(Path(args.host_receipt).read_bytes()).hexdigest(),hashlib.sha256(Path(args.archives).read_bytes()).hexdigest(),Path(args.work));host=json.loads(Path(args.host_receipt).read_bytes());need(host['runContext']==context,'Fresh same-run host receipt');archives=json.loads(Path(args.archives).read_bytes());work=Path(args.work);ops=Operations(p);previous=enforce_whole_deadline(p['bounds']['wholeSeconds'])
 try:
  result=observe(p,host,archives,work,context,ops);lifecycle=finish_private(p,result,work,context,host,ops);return 0 if lifecycle['controllerLifecycleComplete'] else 1
 finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
if __name__=='__main__':raise SystemExit(main())
