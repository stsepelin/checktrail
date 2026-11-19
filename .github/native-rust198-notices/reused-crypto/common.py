"""First-party SDK10 controller primitives. Imports perform no project work."""
import hashlib,json,os,pathlib,re,signal,stat,subprocess,time,urllib.error,urllib.request,ssl,email.utils
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
def process(argv,out,deadline,cap=2*1024**2,environment=None):
 """Own, bound and reap one first-party command; never prints error bodies."""
 out=pathlib.Path(out);stdout=out.with_suffix('.stdout');stderr=out.with_suffix('.stderr');start=time.monotonic();reason=None;p=None;start_error=None
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
  except BaseException as e:start_error=type(e).__name__;reason='owned command start or supervision incomplete'
  finally:
   if p is not None:
    if p.poll() is None:
     try:os.killpg(p.pid,signal.SIGKILL)
     except ProcessLookupError:pass
    p.wait(timeout=5)
 n,h=hash_file(stdout);en,eh=hash_file(stderr)
 if n>cap or en>65536:reason='terminal command output bound'
 row={'argv':argv,'exitCode':p.returncode if p else None,'reason':reason,'elapsedSeconds':time.monotonic()-start,'ownedPID':p.pid if p else None,'ownedChildStarted':p is not None,'ownedChildReaped':p is not None and p.poll() is not None,'stdoutBytes':n,'stdoutSHA256':h,'stderrBytes':en,'stderrSHA256':eh,'startOrSupervisionErrorType':start_error};stderr.unlink();row=deadline_receipt(out.with_suffix('.receipt.json'),row,deadline,{'reason':reason or 'owned command deadline exhausted before completion credit'},start)
 need(start_error is None and n<=cap and en<=65536,'owned command incomplete; receipt retained');return row,stdout

def actions_outcome(stem,method,attempt,status,row,error_type=None):
 summary={'method':method,'attempt':attempt,'status':status,'exitCode':row.get('exitCode'),'reason':row.get('reason'),'stdoutBytes':row.get('stdoutBytes'),'stdoutSHA256':row.get('stdoutSHA256'),'stderrBytes':row.get('stderrBytes'),'stderrSHA256':row.get('stderrSHA256'),'operatorProcessErrorType':error_type,'authorityOrProducerPassCreditedByThisSummary':False};freeze(stem.with_suffix('.api-outcome.json'),encoded(summary));print('CHECKTRAIL_SDK10_API_OUTCOME='+json.dumps(summary,sort_keys=True),flush=True)
class GitHub:
 def __init__(self,folder,deadline):self.folder=pathlib.Path(folder);self.folder.mkdir(exist_ok=True,mode=0o700);self.deadline=deadline;self.sequence=0
 def call(self,path,method='GET',missing=False,fresh_creation=False):
  need(path.startswith('repos/stsepelin/checktrail/actions/') and not path.endswith('/zip'),'only selected repository Actions metadata API');need(method in ['GET','DELETE'],'bounded Actions method');need(not fresh_creation or (method=='GET' and not missing and re.fullmatch(r'repos/stsepelin/checktrail/actions/artifacts/[1-9][0-9]*',path)),'fresh404 pending only for exact newly created artifact GET');call_deadline=min(self.deadline,time.monotonic()+30)
  for attempt in range(16):
   need(time.monotonic()<call_deadline,'original Actions operation deadline before request');self.sequence+=1;stem=self.folder/('api-'+str(self.sequence).zfill(5))
   try:row,p=process(['gh','api','--hostname','github.com','--method',method,'--include',path],stem,call_deadline)
   except Exception as error:
    failed={};receipt=stem.with_suffix('.receipt.json')
    if receipt.is_file() and not receipt.is_symlink() and receipt.stat().st_size<=65536:
     try:value=read_json(receipt,65536);failed=value if type(value) is dict else {}
     except (ValueError,OSError,Refusal):pass
    actions_outcome(stem,method,attempt+1,None,failed,type(error).__name__);raise
   raw=p.read_bytes();parts=re.split(br'\r?\n\r?\n',raw,maxsplit=1);line=parts[0].splitlines()[0] if parts[0].splitlines() else b'';m=re.fullmatch(br'HTTP/[12](?:\.[01])? ([0-9]{3})(?: [^\r\n]*)?',line);status=int(m.group(1)) if m is not None else None;actions_outcome(stem,method,attempt+1,status,row)
   need(len(parts)==2 and status is not None,'HTTP response framing/status');need(row['reason'] is None and time.monotonic()<call_deadline,'Actions API response completed within original budget')
   if missing and status==404:need(row['exitCode']==1,'exact missing404 CLI1');return None
   if row['exitCode']==0 and status==(204 if method=='DELETE' else 200):
    value={} if method=='DELETE' else json.loads(parts[1]);need(time.monotonic()<call_deadline,'Actions response parse exceeded original operation deadline');return value
   pending=method=='GET' and row['exitCode']==1 and ((fresh_creation and status==404) or status in [429,500,502,503,504]);need(pending,'exact Actions API completion');headers=[v.split(b':',1)[1].strip() for v in parts[0].splitlines()[1:] if v.split(b':',1)[0].lower()==b'retry-after'];need(len(headers)<=1,'one Retry-After header');delay=1
   if headers:
    header=headers[0];need(len(header)<=128,'bounded Retry-After header')
    if re.fullmatch(rb'[0-9]+',header):delay=max(1,int(header))
    else:
     try:date=email.utils.parsedate_to_datetime(header.decode('ascii'));need(date.tzinfo is not None,'aware Retry-After date');delay=max(1,date.timestamp()-time.time())
     except (ValueError,UnicodeError,TypeError,OverflowError) as error:raise Refusal('invalid Retry-After header') from error
   need(attempt<15 and time.monotonic()+delay<call_deadline,'bounded read-only retry inside original30second operation');time.sleep(delay)
  raise Refusal('unreachable Actions retry loop')
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


# Original first-party operator profile before the one supported upstream mode
# argument. These are literal source-producer argv, never a project trust grant.
ORIGINAL_BUILD_ARGV = ['./build.sh', '--ci', '--clean-while-building', '--prepareMachine', '-c', 'Release', '/p:VerticalName=AzureLinux_x64_Cross_Alpine_arm64', '/p:ArtifactsStagingDir=/work/staging', '-os', 'linux-musl', '-arch', 'arm64', '--target-rid', 'linux-musl-arm64', '/p:CrossBuild=true']
ORIGINAL_TEST_ARGV = ['./build.sh', '--test', '--excludeCIBinarylog', '/bl:artifacts/log/Release/Test.binlog', '--ci', '--clean-while-building', '--prepareMachine', '-c', 'Release', '/p:VerticalName=AzureLinux_x64_Cross_Alpine_arm64', '/p:ArtifactsStagingDir=/work/staging', '-os', 'linux-musl', '-arch', 'arm64', '--target-rid', 'linux-musl-arm64']
OPERATOR_BUILD_ID = '20261117.1'
def original_mode_configuration(profile):
 identity={'mode':'original-supported-official-build','buildID':OPERATOR_BUILD_ID,'historicalPublisherIdentity':False}
 need(profile.get('operatorBuildIdentity')==identity,'Exact reviewed operator build identity descriptor')
 suffix=['--official-build-id',OPERATOR_BUILD_ID]
 need(profile.get('buildArgv')==ORIGINAL_BUILD_ARGV+suffix,'Original build argv plus exact supported official-build-id only')
 need(profile.get('testArgv')==ORIGINAL_TEST_ARGV+suffix,'Original test argv plus exact same supported official-build-id only')
 return {'schemaVersion':1,'supportedOriginalMode':identity['mode'],'operatorBuildID':OPERATOR_BUILD_ID,'historicalPublisherIdentityClaimed':False,
         'auditConfiguredState':'disabled-by-original-official-mode','auditStatusKind':'configured-original-policy-not-per-project-observation','auditPassingCredit':False,'securityAuditPerformedByController':False,'actualPerProjectEffectiveAuditState':'unassessed',
         'upstreamAuditCondition':'OfficialBuildId nonempty -> OfficialBuild true -> original selected bootstrap SDK NuGetAudit false','explicitNuGetAuditOverrideAdded':False,
         'signSwitchRequested':False,'upstreamPublicationRequestedByOperator':False,'originalVMRPublishingMode':'PushToLocalStorage=true','sourceBuildSuccessIsNotAuditOrTestSuccess':True,
         'upstreamTestOptOutsZeroAndSkippedReportsCountAsPassing':False,'declaredUpstreamTestOptOuts':[{'project':'sdk','originalCondition':"OS != Windows_NT",'originalProperty':'DotNetBuildTestsOptOut=true','evidenceKind':'original-source-metadata-not-runtime-test-result','passingCredit':False}],'originalSelectedDefaultCommandsPreservedExceptSupportedModeArgument':True}
