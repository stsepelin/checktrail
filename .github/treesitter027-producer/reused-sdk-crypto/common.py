"""First-party SDK10 controller primitives. Imports perform no project work."""
import hashlib,json,os,pathlib,re,signal,stat,subprocess,time,urllib.error,urllib.request,ssl
class Refusal(RuntimeError):pass
def need(value,message):
 if not value:raise Refusal(message)
def encoded(value):return (json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
def digest(raw):return hashlib.sha256(raw).hexdigest()
def hash_file(path,algorithm='sha256',deadline=None):
 h=hashlib.new(algorithm);n=0
 with open(path,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''):
   if deadline is not None:need(time.monotonic()<deadline,'file hashing deadline')
   h.update(block);n+=len(block)
 return n,h.hexdigest()
def git_blob(raw):return hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
def syncdir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def sync_chain(path,anchor):
 """Persist every newly-created directory link through an existing ancestor."""
 path=pathlib.Path(path).absolute();anchor=pathlib.Path(anchor).absolute();need(path==anchor or anchor in path.parents,'durability anchor contains complete owned path')
 while True:
  need(not path.is_symlink() and path.is_dir(),'durable directory chain has no links');syncdir(path)
  if path==anchor:break
  path=path.parent
def freeze(path,raw):
 path=pathlib.Path(path);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 os.chmod(path,0o400);syncdir(path.parent)
def replace_json(path,value):
 path=pathlib.Path(path);tmp=path.with_name(path.name+'.next');freeze(tmp,encoded(value));os.replace(tmp,path);syncdir(path.parent)
def deadline_receipt(path,row,deadline,expired_fields,started):
 """Publish final credit only after capture/persistence within the same budget."""
 row={**row,'completionCreditFinalized':False,'completionBudgetExhausted':False};freeze(path,encoded(row))
 now=time.monotonic();row['elapsedSeconds']=now-started
 if now>=deadline:row.update(expired_fields);row['completionBudgetExhausted']=True
 row['completionCreditFinalized']=True;replace_json(path,row)
 now=time.monotonic()
 if now>=deadline and not row['completionBudgetExhausted']:
  row.update(expired_fields);row.update(completionBudgetExhausted=True,elapsedSeconds=now-started);replace_json(path,row)
 return row
def read_json(path,maximum=64*1024**2):
 path=pathlib.Path(path);need(not path.is_symlink() and path.stat().st_size<=maximum,'bounded regular metadata file');return json.loads(path.read_bytes())
def safe_relative(name):
 need(type(name) is str and name and not name.startswith('/') and '\\' not in name and '\0' not in name,'relative member path')
 need(all(x not in ['','.','..'] for x in name.split('/')) and len(name.encode())<=4096,'member path boundary');return name
def context(nonce,run=None,head=None):
 need(re.fullmatch('[a-z0-9-]{8,40}',nonce) is not None,'exact bounded operator nonce')
 run=int(run if run is not None else os.environ.get('GITHUB_RUN_ID','0'));head=head or os.environ.get('GITHUB_SHA','')
 need(run>0 and re.fullmatch('[0-9a-f]{40}',head) is not None,'exact immutable run/head')
 return {'run':run,'head':head,'nonce':nonce,'attempt':1}
def name(ctx,ordinal):return 'ct-sdk10-native-'+str(ctx['run'])+'-1-'+ctx['nonce']+'-'+str(ordinal).zfill(6)
def record_step(window):return 'Record exact SDK10 two-slot window '+str(window).zfill(2)
def owned(meta,ctx,ordinal):
 need(type(meta) is dict and type(meta.get('id')) is int and meta['id']>0,'exact positive artifactID');need(meta.get('name')==name(ctx,ordinal),'exact owned carrier name')
 need(type(meta.get('size_in_bytes')) is int and 0<meta['size_in_bytes']<=128*1024**2 and meta.get('expired') is False,'bounded unexpired original carrier');w=meta.get('workflow_run') or {};need(w.get('id')==ctx['run'] and w.get('head_sha')==ctx['head'],'carrier original run/head');d=meta.get('digest');need(d is None or re.fullmatch('sha256:[0-9a-f]{64}',d),'service digest syntax');return meta
def body_plan(size,part_bytes=127*1024**2):
 need(type(size) is int and 0<size<=12*1024**3,'bounded nonempty stopped capture');payload=(size+part_bytes-1)//part_bytes;sentinels=1 if payload%2 else 2;total=payload+sentinels;need(total<=98 and total%2==0,'at most49 exact two-slot windows');return {'payloadParts':payload,'sentinelParts':sentinels,'totalCarriers':total,'windows':total//2,'partBytes':part_bytes}
def fresh_env(additions):
 # Only named literal values cross into project code. Docker's original public
 # image ENV remains; no host credentials or host HOME are inherited.
 allowed={'HOME','DOTNET_CLI_HOME','NUGET_PACKAGES','ROOTFS_DIR','DOTNET_INSTALL_DIR','DOTNET_ROOT','DOTNET_CLI_TELEMETRY_OPTOUT','DOTNET_NOLOGO','DOTNET_MULTILEVEL_LOOKUP','TZ','TMPDIR','TMP','TEMP'}
 need(set(additions)<=allowed and all(type(v) is str for v in additions.values()),'project environment literal allowlist');return [v for k in sorted(additions) for v in ['--env',k+'='+additions[k]]]
def owned_labels(ctx):return {'org.checktrail.sdk10.run':str(ctx['run']),'org.checktrail.sdk10.nonce':ctx['nonce'],'org.checktrail.sdk10.head':ctx['head']}
def labels_match(labels,ctx):return type(labels) is dict and all(labels.get(k)==v for k,v in owned_labels(ctx).items())


def owned_group_frame(pid,timeout=1):
 """Bounded kernel metadata only; raw process commands are never retained."""
 query=subprocess.run(['/bin/ps','-axo','pid=,ppid=,pgid=,uid=,stat='],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 need(query.returncode==0 and len(query.stdout)+len(query.stderr)<=2*1024**2,'Owned process metadata query failed or exceeded bound')
 members=[]
 for line in query.stdout.splitlines():
  fields=line.split();need(len(fields)==5 and all(v.lstrip(b'-').isdigit() for v in fields[:4]),'Owned process metadata row malformed')
  actual,parent,group,uid=map(int,fields[:4])
  if group!=pid:continue
  need(len(members)<128 and 0<len(fields[4])<=16,'Owned process group metadata bound')
  row={'pid':actual,'ppid':parent,'pgid':group,'uid':uid&0xffffffff,'state':fields[4].decode('ascii')}
  try:row.update(sid=os.getsid(actual),sidStatus='observed')
  except ProcessLookupError:row.update(sid=None,sidStatus='vanished-during-observation')
  except PermissionError:row.update(sid=None,sidStatus='unavailable')
  members.append(row)
 return {'pgid':pid,'members':members}

def cleanup_owned(process,allowed_uids,seconds=5,observer=None):
 """A held Popen child authorizes its original group, never a reused group.

 Before wait/poll consumes that token, prove actual PGID/SID/parent/UID. Signal
 failure is retained. An unknown group only permits bounded teardown of the
 proved Popen child PID; it never authorizes signaling other group members.
 """
 observer=observer or owned_group_frame;start=time.monotonic();deadline=start+seconds
 record={'pid':process.pid,'expectedPGID':process.pid,'expectedSID':process.pid,'controllerPid':os.getpid(),'controllerUid':os.getuid(),'allowedGroupUIDs':sorted(allowed_uids),'returncodeAtEntry':process.returncode,'observations':[],'observationCount':0,'signals':[],'errors':[],'leaderReaped':process.returncode is not None,'groupAbsent':False,'ownershipUnknown':False,'complete':False}
 def error(stage,e):record['errors'].append({'stage':stage,'type':type(e).__name__,'errno':e.errno if isinstance(e,OSError) else None})
 def remaining():return max(.001,deadline-time.monotonic())
 def observe():
  frame=observer(process.pid,timeout=min(1,remaining()));record['observationCount']+=1
  if len(record['observations'])<8:record['observations'].append(frame)
  else:record['observations'][-1]=frame
  return frame
 def wait_owned(timeout):
  try:process.wait(timeout=min(timeout,remaining()));record['leaderReaped']=process.returncode is not None;return record['leaderReaped']
  except subprocess.TimeoutExpired:return False
  except (OSError,subprocess.SubprocessError) as e:error('wait-proved-child',e);return False
 def authority(frame):
  need(process.returncode is None,'Reaped child cannot authorize another group signal')
  leader=[r for r in frame['members'] if r['pid']==process.pid]
  need(len(leader)==1 and leader[0]['ppid']==os.getpid(),'Proved Popen leader missing or parent changed')
  need(all(r['uid'] in allowed_uids and r['sidStatus']=='observed' and r['sid']==process.pid and r['pgid']==process.pid for r in frame['members']),'Owned process UID/PGID/SID changed or unknown')
  need(os.getpgid(process.pid)==process.pid and os.getsid(process.pid)==process.pid,'Current proved-child PGID/SID changed')
 def signal_group(frame,sig):
  authority(frame);row={'authority':'unreaped-proved-child-and-current-PGID-SID-UID-frame','kind':'group','pid':process.pid,'signal':int(sig)};record['signals'].append(row)
  try:os.killpg(process.pid,sig);row['sent']=True;return True
  except (ProcessLookupError,PermissionError) as e:row.update(sent=False,errorType=type(e).__name__,errno=e.errno);error('group-signal',e);return False
 try:
  frame=observe()
  # Once already reaped, even a numerically equal group with matching UID/SID
  # is not this invocation's authority token. Observe only; never signal it.
  if process.returncode is not None:
   record['groupAbsent']=not frame['members']
   if frame['members']:record['ownershipUnknown']=True
  else:
   for sig in (signal.SIGTERM,signal.SIGKILL):
    if time.monotonic()>=deadline:break
    if not frame['members'] or (len(frame['members'])==1 and frame['members'][0]['pid']==process.pid and frame['members'][0]['state'].startswith('Z')):
     wait_owned(1);break
    if not signal_group(frame,sig):break
    until=min(deadline,time.monotonic()+1)
    while time.monotonic()<until:
     frame=observe()
     live=[r for r in frame['members'] if not r['state'].startswith('Z')]
     if not live:
      # Hold the unreaped leader while live descendants could still retain its
      # session/group. When all have stopped, consume only our own wait token.
      wait_owned(1);break
     time.sleep(min(.05,remaining()))
    if process.returncode is not None:break
    frame=observe()
 except (OSError,subprocess.SubprocessError,ValueError,Refusal) as e:
  error('group-inspection-or-authority',e);record['ownershipUnknown']=True
 # Bound/reap the specific child even when group inspection or group signaling
 # failed. Popen's per-PID signal method polls under its own child-wait lock;
 # it does not signal a PID after learning that child has already been reaped.
 for sig in (signal.SIGTERM,signal.SIGKILL):
  if process.returncode is not None or time.monotonic()>=deadline:break
  row={'authority':'proved-Popen-child-PID-only','kind':'child-pid','pid':process.pid,'signal':int(sig)};record['signals'].append(row)
  try:
   process.send_signal(sig);row.update(methodReturnedWithoutError=True,actualSignalSyscallPerformed=None,returncodeAfterMethod=process.returncode)
  except (OSError,subprocess.SubprocessError) as e:row.update(methodReturnedWithoutError=False,errorType=type(e).__name__);error('proved-child-signal',e)
  if wait_owned(1):break
 record['leaderReaped']=process.returncode is not None;record['leaderExitCode']=process.returncode
 if record['leaderReaped']:
  try:
   while time.monotonic()<deadline:
    frame=observe();record['groupAbsent']=not frame['members']
    if record['groupAbsent']:break
    # No mutation after reaping: a surviving/reused/foreign group is unresolved.
    time.sleep(min(.05,remaining()))
  except (OSError,subprocess.SubprocessError,ValueError,Refusal) as e:error('post-wait-group-inspection',e);record['ownershipUnknown']=True
 record['observationsTruncated']=record['observationCount']>len(record['observations']);record['elapsedSeconds']=time.monotonic()-start
 record['complete']=record['leaderReaped'] and record['groupAbsent'] and not record['ownershipUnknown'] and record['elapsedSeconds']<seconds
 return record

def process(argv,out,deadline,cap=2*1024**2,environment=None):
 """Own, bound and reap one first-party command; never prints error bodies."""
 out=pathlib.Path(out);stdout=out.with_suffix('.stdout');stderr=out.with_suffix('.stderr');start=time.monotonic();reason=None;p=None;start_error=None;primary=None;cleanup=None;before_cleanup=None
 # A budget is an admission condition, not permission to spawn then kill.
 if start>=deadline:
  row={'argv':argv,'exitCode':None,'reason':'owned command deadline expired before start','elapsedSeconds':0,'ownedPID':None,'ownedChildStarted':False,'ownedChildReaped':False}
  freeze(out.with_suffix('.receipt.json'),encoded(row));raise Refusal(row['reason'])
 with stdout.open('xb') as so,stderr.open('xb') as se:
  env=dict(os.environ) if environment is None else dict(environment);env.pop('GH_DEBUG',None);env.pop('DEBUG',None)
  try:
   need(time.monotonic()<deadline,'owned command deadline expired before start')
   p=subprocess.Popen(argv,stdout=so,stderr=se,start_new_session=True,env=env)
   while p.poll() is None:
    if time.monotonic()>=deadline:reason='owned command deadline';break
    if stdout.stat().st_size>cap or stderr.stat().st_size>65536:reason='owned command output bound';break
    time.sleep(.1)
   if reason:primary={'type':'BoundRefusal','reason':reason}
  except BaseException as e:
   start_error=type(e).__name__;reason='owned command start or supervision incomplete';primary={'type':type(e).__name__,'reason':reason}
  finally:
   if p is not None:
    before_cleanup=p.returncode
    # Current UID only: this Tree copy runs first-party Node/Actions utilities,
    # never a sudo/project/SDK producer. No authority follows a consumed wait.
    cleanup=cleanup_owned(p,{os.getuid()},seconds=5)
 n,h=hash_file(stdout);en,eh=hash_file(stderr)
 if n>cap or en>65536:reason='terminal command output bound'
 if p is not None and not cleanup['complete'] and reason is None:reason='owned command cleanup incomplete'
 row={'argv':argv,'exitCode':p.returncode if p else None,'reason':reason,'elapsedSeconds':time.monotonic()-start,'ownedPID':p.pid if p else None,'ownedChildStarted':p is not None,'ownedChildReaped':p is not None and p.returncode is not None,'stdoutBytes':n,'stdoutSHA256':h,'stderrBytes':en,'stderrSHA256':eh,'startOrSupervisionErrorType':start_error,'originalExitCodeBeforeCleanup':before_cleanup,'primaryFailure':primary,'ownedProcessCleanup':cleanup};stderr.unlink();row=deadline_receipt(out.with_suffix('.receipt.json'),row,deadline,{'reason':reason or 'owned command deadline exhausted before completion credit'},start)
 need(start_error is None and n<=cap and en<=65536,'owned command incomplete; receipt retained')
 need(p is not None and cleanup['complete'],'owned command cleanup incomplete; receipt retained')
 return row,stdout

class GitHub:
 def __init__(self,folder,deadline):self.folder=pathlib.Path(folder);self.folder.mkdir(exist_ok=True,mode=0o700);self.deadline=deadline;self.sequence=0
 def call(self,path,method='GET',missing=False):
  need(path.startswith('repos/stsepelin/checktrail/actions/') and not path.endswith('/zip'),'only selected repository Actions metadata API');need(method in ['GET','DELETE'],'bounded Actions method');self.sequence+=1;stem=self.folder/('api-'+str(self.sequence).zfill(5));call_deadline=min(self.deadline,time.monotonic()+30);row,p=process(['gh','api','--hostname','github.com','--method',method,'--include',path],stem,call_deadline);raw=p.read_bytes();parts=re.split(br'\r?\n\r?\n',raw,maxsplit=1);need(len(parts)==2,'HTTP response framing');m=re.fullmatch(br'HTTP/[12](?:\.[01])? ([0-9]{3})(?: [^\r\n]*)?',parts[0].splitlines()[0]);need(m,'HTTP response status');status=int(m.group(1));need(row['reason'] is None and time.monotonic()<call_deadline,'Actions API response completed within original budget')
  if missing and status==404:need(row['exitCode']!=0,'exact missing404');return None
  need(row['reason'] is None and row['exitCode']==0 and status==(204 if method=='DELETE' else 200),'exact Actions API completion');value={} if method=='DELETE' else json.loads(parts[1]);need(time.monotonic()<call_deadline,'Actions response parse exceeded original operation deadline');return value
 def bind(self,ctx,workflow):
  r=self.call('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run']));need(r.get('id')==ctx['run'] and r.get('run_attempt')==1 and r.get('head_sha')==ctx['head'] and r.get('event')=='workflow_dispatch' and r.get('path')==workflow,'exact manual original workflow/run/head/attempt');return r
def handshake(jobs,ctx,window,job_name='sdk10-original'):
 need(type(jobs.get('total_count')) is int and jobs['total_count']==1 and type(jobs.get('jobs')) is list and len(jobs['jobs'])==1,'complete exact one-job workflow');job=jobs['jobs'][0];need(job.get('run_id')==ctx['run'] and job.get('head_sha')==ctx['head'] and job.get('name')==job_name,'exact original producer job');steps=[x for x in job.get('steps',[]) if x.get('name')==record_step(window)];need(len(steps)<=1,'unique exact window record step')
 if not steps:need(job.get('status')!='completed','terminal workflow missing handshake');return None
 step=steps[0]
 if step.get('status')!='completed':return None
 need(step.get('conclusion')=='success','successful exact record step before custody/delete');return {'jobID':job['id'],'stepName':step['name'],'stepNumber':step['number'],'run':ctx['run'],'head':ctx['head'],'window':window,'conclusion':'success'}
def validate_window_listing(listing,ctx,ordinals):
 items=listing.get('artifacts');need(type(listing.get('total_count')) is int and 0<=listing['total_count']<=2 and type(items) is list and len(items)<=2,'bounded two-slot listing schema');allowed={name(ctx,i):i for i in ordinals};need(all(type(x) is dict and x.get('name') in allowed for x in items),'no unexpected current-window artifact');need(len({x['id'] for x in items})==len(items) and len({x['name'] for x in items})==len(items),'unique current-window IDs/names')
 for x in items:owned(x,ctx,allowed[x['name']])
 if listing['total_count']!=len(items) or len(items)!=2:return None
 return [next(x for x in items if x['name']==name(ctx,i)) for i in ordinals]
