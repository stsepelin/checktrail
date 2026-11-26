"""Journaled owned case-sensitive image lifecycle; unknown outcomes never grant detach."""
from pathlib import Path
import hashlib,json,os,re,stat
from admission import case_probe,need
STATE='OWNED-VOLUME-STATE.json'
# An attempt with unacknowledged persistence cannot issue another mutation.
# This is attempt-local refusal, not cross-host checkpoint/resume authority.
PERSISTENCE_FAILURES={}

def plan(work,context):
 need(work==work.resolve(strict=True) and re.fullmatch(r'[0-9]+',context['run']) and re.fullmatch(r'[0-9]+',context['attempt']),'Physical owned work and exact run identifiers');image=work/'source-work.sparseimage';mount=work/'case-work';label='rust198-'+context['run']+'-'+context['attempt'];return {'image':str(image),'mount':str(mount),'create':['/usr/bin/hdiutil','create','-type','SPARSE','-size','40g','-fs','JHFS+X','-volname',label,'-uid','0','-gid','0','-mode','0755',str(image)],'attach':['/usr/bin/hdiutil','attach','-nobrowse','-owners','on','-mountpoint',str(mount),'-plist',str(image)],'virtualBytes':40*1024**3,'notHistoricalFilesystemEquality':True}

def save_state(work,value):
 key=str(work.resolve(strict=True));need(key not in PERSISTENCE_FAILURES,'Journal persistence failure latched; no further mutation authority');control=work/'control'
 try:
  if not control.exists():control.mkdir(mode=0o700)
  need(control==control.resolve(strict=True) and control.stat().st_uid==os.getuid(),'Owned physical image journal parent');parent=control.stat();body=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode();need(len(body)<=65536,'Bounded owned-image journal');file=control/STATE;part=control/(STATE+'.next');fd=os.open(part,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:f.write(body);f.flush();os.fchmod(f.fileno(),0o400);os.fsync(f.fileno())
  os.replace(part,file);directory=os.open(control,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:
   opened=os.fstat(directory);need(stat.S_ISDIR(opened.st_mode) and (opened.st_dev,opened.st_ino,opened.st_uid)==(parent.st_dev,parent.st_ino,parent.st_uid),'Exact physical journal parent before persistence acknowledgment');os.fsync(directory)
  finally:os.close(directory)
 except BaseException as error:
  PERSISTENCE_FAILURES[key]={'type':type(error).__name__,'reason':str(error)[:512]};raise

def load_state(work,context):
 expected=plan(work,context);file=work/'control'/STATE
 if str(work.resolve(strict=True)) in PERSISTENCE_FAILURES:return {'stage':'unknown-persistence-failure','imageOutcome':'unknown','attachmentOutcome':'unknown','runContext':context,'image':expected['image'],'mount':expected['mount'],'failure':PERSISTENCE_FAILURES[str(work.resolve(strict=True))]}
 if not os.path.lexists(file):
  exists=os.path.lexists(expected['image']) or os.path.lexists(expected['mount']);return {'stage':'unknown-unrecorded-resource' if exists else 'never-attempted','imageOutcome':'unknown' if exists else 'not-attempted','attachmentOutcome':'unknown' if exists else 'not-attempted','runContext':context,'image':expected['image'],'mount':expected['mount']}
 s=file.lstat();need(file==file.resolve(strict=True) and stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o400 and s.st_size<=65536,'Physical owned image journal');body=file.read_bytes();need(len(body)==s.st_size,'Complete image journal body');v=json.loads(body);need(v['runContext']==context and v['image']==expected['image'] and v['mount']==expected['mount'],'Bounded exact image journal context/paths');need(v['imageOutcome'] in ['not-attempted','unknown','created'] and v['attachmentOutcome'] in ['not-attempted','unknown','proven','detached'],'Explicit image/attachment outcome');validate_state(v);v['journalSHA256']=hashlib.sha256(body).hexdigest();return v

def validate_state(value):
 stage=value['stage'];base=stage[7:] if stage.startswith('failed-') else stage;image=value['imageOutcome'];attachment=value['attachmentOutcome']
 if base=='intent-persisted':need(image=='not-attempted' and attachment=='not-attempted','Intent outcome inconsistent')
 elif base=='create-requested':need(image=='unknown' and attachment=='not-attempted','Unknown create outcome required')
 elif base=='image-created':need(image=='created' and attachment=='not-attempted','Image-only outcome inconsistent')
 elif base in ['attach-requested','attach-response-observed']:need(image=='created' and attachment=='unknown','Unproven attach must remain unknown')
 elif base in ['attachment-identity-proven','ready']:need(image=='created' and attachment in ['proven','unknown'],'Attachment proof state inconsistent')
 elif base in ['detach-requested','detach-outcome-unknown']:need(image=='created' and attachment=='unknown','Unproven detach must remain unknown')
 elif base=='detached':need(image=='created' and attachment=='detached','Detach outcome inconsistent')
 else:raise ValueError('Unknown journal stage cannot grant cleanup')
 if attachment in ['proven','detached']:
  need(re.fullmatch(r'/dev/disk[0-9]+(?:s[0-9]+)?',value.get('device','')) and all(type(value.get(k)) is int for k in ['imageInode','imageDevice','imageOwner']),'Complete exact attachment proof required')

def endpoint(image):
 s=image.lstat();need(image==image.resolve(strict=True) and stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid(),'Physical newly owned image endpoint');return {'imageInode':s.st_ino,'imageDevice':s.st_dev,'imageOwner':s.st_uid}

def check_endpoint(value):
 need(endpoint(Path(value['image']))=={k:value[k] for k in ['imageInode','imageDevice','imageOwner']},'Owned image endpoint changed')

def prepare(work,context,runner,probe=case_probe):
 p=plan(work,context);image=Path(p['image']);mount=Path(p['mount']);need(not os.path.lexists(image) and not os.path.lexists(mount) and not os.path.lexists(work/'control'/STATE),'Fresh owned image/mount/journal only');state={**p,'runContext':context,'stage':'intent-persisted','imageOutcome':'not-attempted','attachmentOutcome':'not-attempted'};save_state(work,state)
 def record(**fields):state.update(fields);save_state(work,state)
 try:
  mount.mkdir(mode=0o700);record(stage='create-requested',imageOutcome='unknown');runner(p['create'],120);record(stage='image-created',imageOutcome='created',**endpoint(image));record(stage='attach-requested',attachmentOutcome='unknown');result=runner(p['attach'],120)
  # A response is evidence, not authority. Persist bounded observation before checks.
  raw={k:str(result.get(k,''))[:2048] for k in ['imagePath','mountPoint','device']};record(stage='attach-response-observed',attachmentObservation=raw);need(raw['imagePath']==str(image) and raw['mountPoint']==str(mount) and re.fullmatch(r'/dev/disk[0-9]+(?:s[0-9]+)?',raw['device']),'Exact owned image attachment identity');check_endpoint(state);record(stage='attachment-identity-proven',device=raw['device'],attachmentOutcome='proven');proof=probe(mount);need(proof['caseSensitive'] is True,'Required source case distinction unsupported');check_endpoint(state);record(stage='ready',caseProbe=proof);return dict(state)
 except BaseException as error:
  # Once a mutation is requested, absence/ownership is never inferred from failure.
  if state['attachmentOutcome']=='proven':
   try:check_endpoint(state)
   except Exception:state['attachmentOutcome']='unknown'
  state.update(failure={'type':type(error).__name__,'reason':str(error)[:1024]},stage='failed-'+state['stage']);save_state(work,state);raise

def detach_owned(record,context,runner,current_info):
 need(record['runContext']==context and record['attachmentOutcome']=='proven','Proven owned image attachment/context required');work=Path(record['image']).parent;current=load_state(work,context);need(current['attachmentOutcome']=='proven' and {k:v for k,v in current.items() if k!='journalSHA256'}=={k:v for k,v in record.items() if k!='journalSHA256'},'Current exact proven journal required; stale/unknown state grants no detach');check_endpoint(record);need(current_info['imagePath']==record['image'] and current_info['mountPoint']==record['mount'] and current_info['device']==record['device'],'Owned attachment changed before detach');state={**record,'stage':'detach-requested','attachmentOutcome':'unknown'};state.pop('journalSHA256',None);save_state(work,state)
 try:
  observed=runner(['/usr/bin/hdiutil','detach',record['mount']],120);need(observed.get('ownedAttachmentAbsent') is True,'Exact owned attachment absence unobserved after detach');state.update(stage='detached',attachmentOutcome='detached');save_state(work,state)
 except BaseException as error:
  state.update(stage='failed-detach-outcome-unknown',failure={'type':type(error).__name__,'reason':str(error)[:1024]});save_state(work,state);raise
 return {'detachedOwnedImage':True,'exactOwnedAttachmentAbsenceObserved':True,'stockSDKOrOtherDiskChanged':False}
