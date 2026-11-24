#!/usr/bin/env python3
"""Manual-only original SDK10 producer controller. No work runs on import."""
import argparse,gzip,hashlib,json,os,pathlib,re,shutil,signal,stat,subprocess,sys,tarfile,time,uuid
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from common import *
from owned_image import reserve_image_inputs, admit_pulled_image, cleanup_image_inputs
from capacity_admission import plan as capacity_plan, observe_space
from crypto_bridge import operation,validate_ack_payload
from git_ack import AckAPI
from observer import file_identity
from live_resource import observe as observe_live_resource, ObservationIncomplete
from cleanup_owned import remove_volume as remove_owned_volume
from producer_adapter import ProducerAPI
HERE=pathlib.Path(__file__).resolve().parent
def compiler_invocation(executable,argv):
 name=pathlib.PurePosixPath(executable.removesuffix(' (deleted)')).name
 triplet=r'(?:(?:aarch64-linux-(?:gnu|musl)|x86_64-(?:linux-gnu|pc-linux-gnu))-)?'
 if re.fullmatch(triplet+r'(?:clang(?:\+\+)?|gcc|g\+\+|cc1|cc1plus|ilc)(?:-[0-9]+(?:\.[0-9]+)*)?',name):return {'kind':'native-compiler-executable','identifier':name,'compilerVersionInferredFromNameOrArguments':False}
 if name not in ['dotnet','corerun'] or len(argv)<2:return None
 args=argv[1:];index=1 if name=='dotnet' and args[0]=='exec' else 0
 valued={'--depsfile','--runtimeconfig','--additionalprobingpath','--additional-deps','--fx-version','--roll-forward'}
 while index<len(args):
  arg=args[index]
  if arg=='--':index+=1;break
  option,equals,value=arg.partition('=')
  if name=='dotnet' and option in valued:
   if equals:
    if not value:return None
    index+=1
   else:
    if index+1>=len(args) or not args[index+1]:return None
    index+=2
   continue
  break
 if index>=len(args):return None
 assembly=args[index];identifier=pathlib.PurePosixPath(assembly).name
 if identifier not in ['csc.dll','fsc.dll','ilc.dll']:return None
 return {'kind':'managed-compiler-in-runtime-host','identifier':identifier,'runtimeHostIdentifier':name,'assemblyArgument':assembly,'compilerVersionInferredFromNameOrArguments':False}

def process_directory(pid):return pathlib.Path('/proc')/str(pid)

def assembly_path(proc,argument):return proc/'root'/argument.lstrip('/') if argument.startswith('/') else proc/'cwd'/argument
def process_maps_file(proc,dev,inode):
 """Whether the process maps file (dev, inode); reads only its bounded mapping table."""
 with (proc/'maps').open('rb') as f:maps=f.read(2*1024**2+1)
 need(len(maps)<=2*1024**2,'bounded observed compiler process mappings')
 for line in maps.decode('utf8','replace').splitlines():
  fields=line.split(None,5)
  if len(fields)<5:continue
  match=re.fullmatch(r'([0-9a-fA-F]+):([0-9a-fA-F]+)',fields[3])
  if match and fields[4].isdigit() and (int(match[1],16),int(match[2],16),int(fields[4]))==(os.major(dev),os.minor(dev),inode):return True
 return False
def assembly_argument_mapped(proc,argument):
 """Cheap pre-check for a pending managed host: stat and mapping table only, no content hash."""
 try:
  s=assembly_path(proc,argument).lstat()
  return stat.S_ISREG(s.st_mode) and process_maps_file(proc,s.st_dev,s.st_ino)
 except (OSError,Refusal):return False
def compiler_assembly_identity(proc,argument,deadline=None):
 deadline=time.monotonic()+5 if deadline is None else deadline
 path=assembly_path(proc,argument)
 result={'argument':argument,'state':'UNASSESSED','actualAssemblyMappedInObservedProcess':False,'compilerAssemblyVersionInferred':False}
 try:
  identity=file_identity(path,128*1024**2,deadline);result.update(state='PHYSICAL_ARGUMENT_BOUND_MAPPING_UNASSESSED',physicalIdentity=identity)
  if process_maps_file(proc,identity['dev'],identity['inode']):need(file_identity(path,128*1024**2,deadline)==identity,'compiler assembly changed across process mapping observation');result.update(state='PHYSICAL_COMPILER_ARGUMENT_AND_PROCESS_MAPPING_BOUND',actualAssemblyMappedInObservedProcess=True)
 except (OSError,Refusal):pass
 return result
def output(values):
 p=os.environ.get('GITHUB_OUTPUT')
 if p:
  with open(p,'a') as f:
   for k,v in values.items():need(re.fullmatch('[a-z_]+',k) and '\n' not in str(v),'bounded workflow output');f.write(k+'='+str(v)+'\n')
def input_prep_command(root,deadline):
 # The child imports its siblings; without -B it would leave a bytecode cache
 # in the reviewed directory, which every later --entry step then refuses.
 return [sys.executable,'-B',str(HERE/'input_prep.py'),'prepare','--profile',str(HERE/'profile.json'),'--out',str(root/'inputs'),'--deadline',str(deadline)]
def root_path(nonce):return pathlib.Path(os.environ['RUNNER_TEMP'])/('ct-sdk10-'+nonce)
def manifest_check(pin):
 raw=(HERE/'MANIFEST.json').read_bytes();need(digest(raw)==pin,'operator-reviewed first-party bundle manifest');m=json.loads(raw)
 for row in m['files']:
  p=HERE/row['path'];need(p.parent==HERE and not p.is_symlink(),'direct first-party helper file');need(hash_file(p)==(row['bytes'],row['sha256']),'frozen first-party helper changed')
 return read_json(HERE/'profile.json')
NATIVE_CAP_ALIASES={name:canonical for canonical in ['CHOWN','SETUID','SETGID','KILL'] for name in [canonical,'CAP_'+canonical]}
def native_identity_contract(obj):
 h=obj.get('HostConfig') or {};values=h.get('CapAdd');need(obj.get('Config',{}).get('User')=='0:0','protected root supervisor exact user');need(type(values) is list and len(values)==4 and all(type(v) is str and v in NATIVE_CAP_ALIASES for v in values),'finite exact native capability aliases');need({NATIVE_CAP_ALIASES[v] for v in values}=={'CHOWN','SETUID','SETGID','KILL'},'exact supervisor ownership/UID/GID/kill capabilities, no omitted or extra capability');return True
def retain_native_identity(folder,label,stage,obj):
 h=obj.get('HostConfig') or {};value={'label':label,'stage':stage,'User':obj.get('Config',{}).get('User'),'CapAdd':h.get('CapAdd'),'CapDrop':h.get('CapDrop'),'Privileged':h.get('Privileged'),'PidMode':h.get('PidMode'),'ReadonlyRootfs':h.get('ReadonlyRootfs'),'sourceExecutionOrBuildPassCreditedByThisMetadata':False};need(len(encoded(value))<=4096,'bounded selected Docker identity metadata');freeze(folder/(label+'-DOCKER-IDENTITY-'+stage+'.json'),encoded(value));print('CHECKTRAIL_SDK10_NATIVE_IDENTITY='+json.dumps(value,sort_keys=True),flush=True);return value
def retain_protected_status(folder,label,controls,errors,validated=None):
 value={'label':label,'sourceExecutionOrBuildPassCreditedByThisMetadata':False,'protectedReceiptErrors':list(errors),'receipts':{}}
 for member,row in controls.items():
  if type(row) is not dict:value['receipts'][member]={'parsedObject':False,'bindingValidated':False};continue
  value['receipts'][member]={key:row.get(key) for key in ['originalCommandStarted','originalExitCode','supervisorExitCode','timedOut','interrupted','ownChildReaped'] if row.get(key) is None or type(row.get(key)) in [bool,int]};value['receipts'][member]['bindingValidated']=member in (validated or {})
 need(len(encoded(value))<=4096,'bounded selected protected status metadata');freeze(folder/(label+'-PROTECTED-STATUS.json'),encoded(value));print('CHECKTRAIL_SDK10_PROTECTED_STATUS='+json.dumps(value,sort_keys=True),flush=True);return value
def settle_native_client(child,stop_source,folder,label,deadline):
 # A refused source-evidence/removal gate must not orphan the separately owned
 # Docker CLI. Retain both failures; no source result is inferred from its exit.
 started=time.monotonic();row={'ownClientPID':child.pid,'sourceCleanupErrorType':None,'signalErrorType':None,'waitErrorType':None,'ownClientReaped':False,'sourceOriginalExitOrBuildCredit':False};source_error=None
 try:stop_source()
 except BaseException as error:source_error=error;row['sourceCleanupErrorType']=type(error).__name__
 if child.poll() is None:
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  except BaseException as error:row['signalErrorType']=type(error).__name__
 try:row['dockerClientExitCode']=child.wait(timeout=max(.001,min(5,deadline-time.monotonic())))
 except BaseException as error:row['waitErrorType']=type(error).__name__
 row['ownClientReaped']=child.poll() is not None
 row=deadline_receipt(folder/(label+'-CLIENT-CLEANUP.json'),row,deadline,{'ownClientCleanupBudgetExhausted':True},started)
 if source_error is not None:raise source_error
 need(row['ownClientReaped'] and row['signalErrorType'] is None and row['waitErrorType'] is None and not row['completionBudgetExhausted'],'own original Docker client cleanup incomplete; receipt retained')
 return row
class Controller:
 def __init__(self,root,ctx,profile):self.root=pathlib.Path(root);self.ctx=ctx;self.profile=profile;self.state_path=self.root/'STATE.json';self.state=read_json(self.state_path) if self.state_path.exists() else None;self.sequence=0
 def save(self):replace_json(self.state_path,self.state)
 def cmd(self,args,seconds=60,check=True,cap=2*1024**2):
  self.sequence+=1;stem=self.root/'control'/('command-'+str(time.monotonic_ns()));row,p=process(args,stem,min(self.state['cleanupDeadline'],self.state.get('phaseDeadline',self.state['cleanupDeadline']),time.monotonic()+seconds),cap);need(not check or (row['exitCode']==0 and row['reason'] is None),'first-party command incomplete: '+args[0]);return row,p
 def docker(self,args,seconds=60,check=True):return self.cmd(['docker',*args],seconds,check)
 def inspect(self,kind,name):
  row,p=self.docker([kind,'inspect',name],check=False)
  need(row['reason'] is None,'Docker inspect unavailable; absence is not observed')
  if row['exitCode']!=0:
   need(kind in ['container','volume','image'],'exact supported Docker identity kind')
   args={'container':['container','ls','-aq','--no-trunc','--filter','name=^/'+name+'$'],'volume':['volume','ls','-q','--filter','name=^'+name+'$'],'image':['image','ls','-q','--no-trunc','--filter','reference='+name]}[kind]
   listing,body=self.docker(args,check=False)
   need(listing['reason'] is None and listing['exitCode']==0,'Docker identity listing unavailable; no absence credit')
   need(not body.read_bytes().strip(),'failed inspect conflicts with existing identity; no absence credit')
   return None
  data=json.loads(p.read_bytes());need(type(data) is list and len(data)==1,'one exact Docker identity');return data[0]
 def own_container(self,name):
  need(name in self.state['containers'],'only registered owned container name');obj=self.inspect('container',name)
  if obj is not None:need(obj['Name'].lstrip('/')==name and labels_match(obj['Config'].get('Labels'),self.ctx),'positive owned container label binding')
  return obj
 def stop_owned(self,name):
  obj=self.own_container(name)
  native=name in [self.state['prefix']+'-original-build',self.state['prefix']+'-original-tests']
  if obj is None:
   # A renamed producer leaves its name absent while its registered ID still
   # runs and writes the volume; only absence of that exact ID is quiescence.
   if native and name in self.state.get('nativeProducers',{}):
    api=ProducerAPI(self,name);need(api.inspect_id(api.binding['id'],min(self.state['phaseDeadline'],self.state['cleanupDeadline'])) is None,'registered native producer ID absence')
   return True
  if native:
   api=ProducerAPI(self,name);actual=api.inspect_id(api.binding['id'],min(self.state['phaseDeadline'],self.state['cleanupDeadline']));need(actual is not None,'owned native immutable identity before stop')
   if actual['State'].get('Paused'):api.unpause_id(api.binding['id'],min(self.state['phaseDeadline'],time.monotonic()+5))
   if actual['State'].get('Running'):self.docker(['stop','--time','20',api.binding['id']],seconds=30,check=False)
   terminal=api.inspect_id(api.binding['id'],min(self.state['phaseDeadline'],self.state['cleanupDeadline']));need(terminal is not None and not terminal['State']['Running'],'native stopped before protected preservation');need(api.preserve_protected_metadata(api.binding,min(self.state['phaseDeadline'],time.monotonic()+10)),'protected native evidence before cleanup');api.force_remove_id(api.binding['id'],min(self.state['phaseDeadline'],time.monotonic()+30));gone=api.inspect_id(api.binding['id'],min(self.state['phaseDeadline'],self.state['cleanupDeadline'])) is None
  else:
   if obj['State'].get('Running'):self.docker(['stop','--time','20',name],seconds=30,check=False)
   self.docker(['rm','-f',name],seconds=30,check=False);gone=self.inspect('container',name) is None
  need(gone,'owned container absence not observed');return gone
 def volume_owned(self,name=None):
  name=name or self.state['volume'];need(name in [self.state['volume'],self.state['tempVolume']],'registered owned persistent volume');obj=self.inspect('volume',name);need(obj is not None and obj['Name']==name and labels_match(obj.get('Labels'),self.ctx),'positive exact volume ownership');return obj
 def container_args(self,name,entry,read_only_work=False,helper=False,capture=False):
  need(re.fullmatch('[a-z0-9-]+',name),'owned container namespace');p=self.profile;limit=p['limits'];sampler=helper and any(x.endswith('/meter_runner.py') for x in entry);memory=limit['samplerMemory'] if sampler else 4*1024**3 if helper else limit['nativeMemory'];args=['create','--name',name,'--platform','linux/amd64','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--cpuset-cpus','0-3','--cpus',('0.5' if sampler else '2' if helper else '4'),'--memory',str(memory),'--memory-swap',str(memory),'--pids-limit',str(64 if sampler else 512 if helper else limit['nativePIDs']),'--ulimit','nofile=65536:65536','--stop-timeout','20','--network',('none' if helper else 'bridge'),'--mount','type=volume,source='+self.state['volume']+',target=/work,volume-nocopy'+(',readonly' if read_only_work else '')]
  for target in ['/tmp','/work/tmp']:args+=['--mount','type=volume,source='+self.state['tempVolume']+',target='+target+',volume-nocopy'+(',readonly' if read_only_work else '')]
  for k,v in owned_labels(self.ctx).items():args+=['--label',k+'='+v]
  # Protected root supervisor drops all source child groups/UID/capabilities.
  # Data helpers receive only DAC_READ_SEARCH/CHOWN and no source command.
  if helper:
   destination=self.root/('materialization' if '/observer/input_prep.py' in entry and 'materialize' in entry else 'evidence');args+=['--user','0:0','--cap-add','DAC_READ_SEARCH','--cap-add','CHOWN','--mount','type=bind,source='+str(HERE)+',target=/observer,readonly','--mount','type=bind,source='+str(self.root/'inputs')+',target=/inputs,readonly','--mount','type=bind,source='+str(destination)+',target=/evidence'+(',readonly' if capture else '')]
  else:args+=['--user','0:0','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','KILL','--mount','type=bind,source='+str(HERE)+',target=/observer,readonly','--mount','type=bind,source='+str(self.root/'protected'/name)+',target=/native-control']
  if capture:args+=['--mount','type=bind,source='+str(self.root/'capture')+',target=/capture']
  env={'HOME':'/work/home','DOTNET_CLI_HOME':'/work/home/dotnet','NUGET_PACKAGES':'/work/cache/nuget','ROOTFS_DIR':'/crossrootfs/arm64','DOTNET_INSTALL_DIR':'/work/source/.dotnet','DOTNET_ROOT':'/work/source/.dotnet','DOTNET_CLI_TELEMETRY_OPTOUT':'1','DOTNET_NOLOGO':'1','DOTNET_MULTILEVEL_LOOKUP':'0','TZ':'UTC','TMPDIR':'/work/tmp','TMP':'/work/tmp','TEMP':'/work/tmp'};args+=fresh_env(env);args+=['--workdir','/' if helper else '/work/source','--entrypoint',entry[0],self.state['imageAlias'],*entry[1:]];return args
 def validate_container(self,obj,name,entry,read_only=False,helper=False,capture=False):
  expected={'/work':('volume',self.state['volume'],not read_only),'/work/tmp':('volume',self.state['tempVolume'],not read_only),'/tmp':('volume',self.state['tempVolume'],not read_only),'/observer':('bind',str(HERE),False)}
  if helper:
   destination=self.root/('materialization' if '/observer/input_prep.py' in entry and 'materialize' in entry else 'evidence');expected.update({'/inputs':('bind',str(self.root/'inputs'),False),'/evidence':('bind',str(destination),not capture)})
  else:expected['/native-control']=('bind',str(self.root/'protected'/name),True)
  if capture:expected['/capture']=('bind',str(self.root/'capture'),True)
  mounts=obj.get('Mounts');need(type(mounts) is list and len(mounts)==len(expected) and len({x.get('Destination') for x in mounts})==len(mounts),'actual complete unique owned mount set')
  for m in mounts:
   dest=m.get('Destination');need(dest in expected,'no unrequested container mount');kind,source,rw=expected[dest];need(m.get('Type')==kind and m.get('Name' if kind=='volume' else 'Source')==source and m.get('RW') is rw,'actual work/temp/control/read-only mount binding')
  h=obj.get('HostConfig',{});need(h.get('ReadonlyRootfs') is True and h.get('Privileged') is False and h.get('PidMode') in ['',None] and h.get('CpusetCpus')=='0-3' and h.get('NetworkMode')==('none' if helper else 'bridge') and 'ALL' in (h.get('CapDrop') or []) and 'no-new-privileges:true' in (h.get('SecurityOpt') or []),'actual readonly/private namespace/CPU/no-new-privileges configuration')
  configured=h.get('Mounts');need(type(configured) is list,'actual configured mount options required');volumes=[m for m in configured if m.get('Type')=='volume'];targets={'/work':self.state['volume'],'/tmp':self.state['tempVolume'],'/work/tmp':self.state['tempVolume']}
  need(len(volumes)==3 and {m.get('Target') for m in volumes}==set(targets),'all three unique persistent volume initialization targets')
  for m in volumes:need(m.get('Source')==targets[m['Target']] and (m.get('VolumeOptions') or {}).get('NoCopy') is True,'actual owned volume must disable image-directory copy-up')
  return True
 def helper(self,label,script_args,deadline,read_only=False,capture=False):
  name=self.state['prefix']+'-'+label;need(self.inspect('container',name) is None,'owned helper name must start absent');self.state['containers'].append(name);self.save();args=self.container_args(name,['/usr/bin/python3','-I','-S','-B',*script_args],read_only,True,capture);self.docker(args);self.validate_container(self.own_container(name),name,script_args,read_only,True,capture);row,p=self.cmd(['docker','start','-a',name],max(1,deadline-time.monotonic()),check=False);self.stop_owned(name);need(row['exitCode']==0 and row['reason'] is None,'first-party '+label+' incomplete');return row
 def compiler_processes(self,name,seen,cache,file):
  row,p=self.docker(['top',name,'-eo','pid,ppid,comm,args'],seconds=5,check=False)
  if row['exitCode']!=0 or row.get('reason') is not None:return
  lines=p.read_text(errors='replace').splitlines()[1:];need(hash_file(p)==(row['stdoutBytes'],row['stdoutSHA256']),'owned docker-top metadata physical identity');p.unlink() # only redundant first-party polling transport; selected original observations remain in JSONL
  observation_deadline=min(time.monotonic()+5,self.state.get('nativeDeadline',time.monotonic()+5))
  for line in lines:
   if time.monotonic()>=observation_deadline:break
   fields=line.split(None,3)
   if len(fields)!=4 or not fields[0].isdigit():continue
   pid=int(fields[0]);comm=fields[2];args=fields[3]
   try:
    proc=process_directory(pid);identity=proc.joinpath('stat').read_text().rsplit(')',1)[1].split()[19];key=(pid,identity)
    # A managed host can be sampled before it maps its compiler assembly, so
    # only a qualified identity is final; a pending one is examined again.
    if seen.get(key) is True:continue
    target=os.readlink(proc/'exe')
    with (proc/'cmdline').open('rb') as f:raw_argv=f.read(262145)
    need(len(raw_argv)<=262144 and raw_argv.endswith(b'\0'),'bounded complete native process argv');argv=[os.fsdecode(x) for x in raw_argv[:-1].split(b'\0')];role=compiler_invocation(target,argv)
    if role is None:continue
    # A pending host was already recorded with its assembly identity. Until the
    # assembly is mapped, re-hashing it would only spend the shared sample budget.
    if seen.get(key) is False and role['kind']=='managed-compiler-in-runtime-host' and not assembly_argument_mapped(proc,role['assemblyArgument']):continue
    s=(proc/'exe').stat();stamp=(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    if stamp not in cache:
     need(stat.S_ISREG(s.st_mode) and s.st_size<=256*1024**2,'observed compiler executable size');h=hashlib.sha256();n=0
     with (proc/'exe').open('rb') as stream:
      start=os.fstat(stream.fileno());need(stamp==(start.st_dev,start.st_ino,start.st_size,start.st_mtime_ns,start.st_ctime_ns),'opened executable differs from observed process identity')
      for body in iter(lambda:stream.read(1048576),b''):need(time.monotonic()<observation_deadline,'compiler observation shared sample deadline');n+=len(body);need(n<=256*1024**2,'compiler executable grew beyond bound');h.update(body)
      end=os.fstat(stream.fileno());need(n==s.st_size and stamp==(end.st_dev,end.st_ino,end.st_size,end.st_mtime_ns,end.st_ctime_ns),'opened executable changed during hash')
     after=(proc/'exe').stat();need(stamp==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) and os.readlink(proc/'exe')==target,'observed executable changed during identity hash');cache[stamp]=h.hexdigest()
    assembly=compiler_assembly_identity(proc,role['assemblyArgument'],observation_deadline) if role['kind']=='managed-compiler-in-runtime-host' else None;qualified=role['kind']=='native-compiler-executable' or assembly['actualAssemblyMappedInObservedProcess']
    headers=[]
    for fd in list((proc/'fd').iterdir())[:256]:
     if time.monotonic()>=observation_deadline:break
     try:
      header=os.readlink(fd)
      if not header.startswith(('/usr/local/lib/clang/20/include/','/crossrootfs/arm64/usr/include/')):continue
      hp=proc/'root'/header.lstrip('/');n,h=hash_file(hp,deadline=observation_deadline);need(n<=16*1024**2,'observed header size');headers.append({'path':header,'bytes':n,'sha256':h,'role':'actual open file descriptor in observed source compiler process'})
     except (OSError,Refusal):continue
    final=(proc/'exe').stat();need((final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns)==stamp and proc.joinpath('stat').read_text().rsplit(')',1)[1].split()[19]==identity and os.readlink(proc/'exe')==target,'process identity changed before observation record')
    event={'pid':pid,'processStartTicks':identity,'comm':comm,'argvObserved':argv,'dockerTopDisplayArguments':args,'containerExecutablePath':target,'actualExecutableSHA256':cache[stamp],'executableIdentityRole':'compiler-executable' if assembly is None else 'managed-runtime-host','compilerInvocation':role,'compilerAssemblyIdentity':assembly,'actualCompilerExecutableSHA256':cache[stamp] if assembly is None else None,'headerOpenObservations':headers,'actualSourceCompilerProcessObserved':qualified,'unmappedOrUnavailableManagedAssemblyGivenCompilerCredit':False,'packageLabelsUsedAsExecutionEvidence':False}
    if key not in seen or qualified:file.write(json.dumps(event,sort_keys=True)+'\n');file.flush()
    seen[key]=qualified
   except (OSError,Refusal,IndexError):continue
 def native(self,label,argv,deadline):
  need(stat.S_IMODE(HERE.stat().st_mode)&0o005==0o005 and all(stat.S_IMODE((HERE/n).stat().st_mode)&0o004 for n in ['native_entry.py','common.py','profile.json']),'published first-party readonly supervisor bundle must be traversable/readable without DAC capabilities')
  self.helper('before-'+label,['/observer/observer.py','before-build' if label=='original-build' else 'before-test','--profile','/observer/profile.json','--evidence','/evidence','--deadline',str(deadline),'--uid',str(self.state['uid']),'--gid',str(self.state['gid'])],deadline,True);need(time.monotonic()<deadline,'original command budget before container action');name=self.state['prefix']+'-'+label;need(self.inspect('container',name) is None,'owned original producer starts absent');self.state['containers'].append(name);self.save();phase='build' if label=='original-build' else 'test';binding={'context':self.ctx,'manifestSHA256':self.state['manifestSHA256']};protected=self.root/'protected'/name;protected.mkdir(mode=0o700);wrapped=['/usr/bin/python3','-I','-S','-B','/observer/native_entry.py','--profile','/observer/profile.json','--phase',phase,'--deadline',str(deadline),'--uid',str(self.state['uid']),'--gid',str(self.state['gid']),'--binding-json',json.dumps(binding,sort_keys=True)];self.docker(self.container_args(name,wrapped));obj=self.own_container(name);producer_binding=ProducerAPI.register(self,name,obj,{**binding,'phase':phase,'profileSHA256':hash_file(HERE/'profile.json')[1],'supervisorSHA256':hash_file(HERE/'native_entry.py')[1]},argv);retain_native_identity(self.root/'evidence',label,'admission',obj);native_identity_contract(obj);self.validate_container(obj,name,wrapped);need(obj['HostConfig'].get('PidMode') in ['',None] and obj['HostConfig'].get('Privileged') is False,'own private PID namespace and unprivileged original process');need(obj['HostConfig']['Memory']==self.profile['limits']['nativeMemory'],'exact native memory cap');logs=self.root/'evidence';stdout=logs/(label+'.stdout');stderr=logs/(label+'.stderr');observed=logs/(label+'-actual-compiler-processes.jsonl');started=time.monotonic();started_wall=time.time();reason=None;seen={};cache={};last_sample=started;resource_failure=None;previous_log_bytes=sum(p.stat().st_size for phase in ['original-build','original-tests'] for suffix in ['.stdout','.stderr'] for p in [logs/(phase+suffix)] if p.exists());remaining_log_bytes=self.profile['limits']['logBytes']-previous_log_bytes;need(remaining_log_bytes>0,'remaining cumulative original log budget')
  need(time.monotonic()<deadline,'original remaining budget before Docker start')
  with stdout.open('xb') as so,stderr.open('xb') as se,observed.open('x') as observations:
   child=subprocess.Popen(['docker','start','-a',name],stdout=so,stderr=se,start_new_session=True)
   try:
    while child.poll() is None:
     now=time.monotonic()
     if now>=deadline:reason='original combined240min build/test deadline';break
     if stdout.stat().st_size+stderr.stat().st_size>remaining_log_bytes:reason='original log bound';break
     if shutil.disk_usage(self.root).free<self.profile['limits']['freeReserve']:reason='physical host free reserve';break
     self.compiler_processes(name,seen,cache,observations)
     if now-last_sample>=120:
      try:
       live=observe_live_resource(self,'meter-'+str(int(now)),deadline,producer_binding=producer_binding)
       if live.get('producerTerminal') is True:break
       freeze(logs/('LIVE-METER-'+str(time.monotonic_ns())+'.json'),encoded(live['meter']))
      except BaseException as error:
       resource_failure={'errorType':type(error).__name__,'privacySafeProjection':error.safe_projection if isinstance(error,ObservationIncomplete) else None};freeze(logs/(label+'-LIVE-RESOURCE-FAILURE.json'),encoded({'context':self.ctx,**resource_failure}));reason='live resource observation incomplete';break
      last_sample=now
     time.sleep(.5)
    if reason:self.docker(['stop','--time','20',producer_binding['id']],seconds=30,check=False)
    try:code=child.wait(timeout=30)
    except subprocess.TimeoutExpired:code=None
   finally:
    if child.poll() is None:
     settle_native_client(child,lambda:self.stop_owned(name),logs,label,self.state['cleanupDeadline'])
    observations.flush();os.fsync(observations.fileno())
  if stdout.stat().st_size+stderr.stat().st_size>remaining_log_bytes:reason='terminal cumulative original log bound'
  terminal=self.own_container(name)
  if terminal is None:
   api=ProducerAPI(self,name);absence=api.inspect_id(producer_binding['id'],min(deadline,self.state['cleanupDeadline']));attempt=self.state.get('nativeRemovalAttempts',{}).get(name);need(absence is None and type(attempt) is dict and attempt.get('binding')==producer_binding and attempt.get('protectedPreservation',{}).get('existingProtectedBodiesPreserved') is True,'owned producer abort protected custody and exact absence required');row={'phase':label,'exitCode':None,'originalArgv':argv,'originalCodeExecuted':None,'liveResourceFailure':resource_failure,'stopReason':'owned producer aborted; original exit unknown','dockerClientExitCode':code,'protectedRemovalAttempt':attempt,'elapsedSeconds':time.monotonic()-started,'sourceOrCompilerCalledSandboxed':False};return deadline_receipt(logs/(label+'-TERMINAL.json'),row,deadline,{'stopReason':'owned producer abort and original combined deadline; original exit unknown'},started)
  need(not terminal['State'].get('Running'),'owned original process stopped before protected receipt copy');controls={};observed_controls={};receipt_errors=[];expected={**binding,'phase':phase,'profileSHA256':hash_file(HERE/'profile.json')[1],'supervisorSHA256':hash_file(HERE/'native_entry.py')[1]}
  retain_native_identity(logs,label,'terminal',terminal)
  for member in ['START','RESULT']:
   try:
    destination=logs/(label+'-PROTECTED-'+member+'.json');copied,_=self.docker(['cp',name+':/native-control/'+member+'.json',str(destination)],seconds=20,check=False);need(copied['exitCode']==0 and copied['reason'] is None,'protected '+member+' receipt unavailable');need(destination.is_file() and not destination.is_symlink() and destination.stat().st_size<=65536,'protected physical receipt');value=read_json(destination,65536);observed_controls[member]=value;need(value.get('binding')==expected and value.get('originalArgv')==argv and value.get('schemaVersion')==2,'protected exact original command/bundle/context binding');need(type(value.get('originalCommandStarted')) is bool,'protected original start state')
    if value['originalCommandStarted']:need(type(value.get('originalChildPID')) is int and value['originalChildPID']>0 and type(value.get('originalStartedWallTime')) in [int,float] and value['originalStartedWallTime']>0,'protected actual child admission identity')
    if member=='START':need(value['originalCommandStarted'] is True and value.get('originalExitCode') is None,'protected preterminal child start receipt')
    else:need((value['originalCommandStarted'] and value.get('ownChildReaped') is True and type(value.get('originalExitCode')) is int) or (value['originalCommandStarted'] is False and value.get('originalExitCode') is None),'protected started/exit/reap consistency')
    controls[member]=value
   except BaseException as e:receipt_errors.append(member+':'+type(e).__name__)
  retain_protected_status(logs,label,observed_controls,receipt_errors,controls);native_identity_contract(terminal)
  control=controls.get('RESULT',{});start_control=controls.get('START',{});original_started=control.get('originalCommandStarted',start_control.get('originalCommandStarted'));original_exit=control.get('originalExitCode') if control.get('originalCommandStarted') is True else None
  if control.get('originalCommandStarted') is False and start_control:receipt_errors.append('contradictory protected start and terminal');original_started=True;original_exit=None
  if control.get('originalCommandStarted') is True and (not start_control or any(start_control.get(k)!=control.get(k) for k in ['originalChildPID','originalStartedWallTime','originalStartedMonotonic'])):receipt_errors.append('protected START/RESULT admission mismatch')
  if control and (terminal['State'].get('OOMKilled') or terminal['State'].get('ExitCode')!=control.get('supervisorExitCode') or code!=terminal['State'].get('ExitCode')):receipt_errors.append('supervisor/container/client terminal status mismatch')
  row={'phase':label,'liveResourceFailure':resource_failure,'originalArgv':argv,'exitCode':original_exit,'containerSupervisorExitCode':terminal['State'].get('ExitCode'),'dockerClientExitCode':code,'OOMKilled':terminal['State'].get('OOMKilled'),'stopReason':reason or ('protected original receipt incomplete' if receipt_errors else 'original child not started' if original_started is not True else 'protected original timeout/interruption' if control.get('timedOut') or control.get('interrupted') or control.get('supervisorErrorType') or control.get('cleanupSignalErrorType') or control.get('cleanupWaitErrorType') or control.get('signalRestoreErrorTypes') else None),'protectedOriginalReceipt':control,'protectedOriginalStartReceipt':start_control,'protectedReceiptErrors':receipt_errors,'elapsedSeconds':time.monotonic()-started,'startedWallTime':control.get('originalStartedWallTime',start_control.get('originalStartedWallTime')),'wrapperStartedWallTime':started_wall,'sourceOrCompilerCalledSandboxed':False,'originalCodeExecuted':original_started,'originalLogBytesBeforePhase':previous_log_bytes,'originalLogBytesRemainingAtPhaseAdmission':remaining_log_bytes,'compilerInvocationCandidatesObserved':len(seen),'actualCompilerProcessesObserved':sum(value is True for value in seen.values()),'compilerObservationCountsUsedAsProducerAcceptance':False,'stdout':{'bytes':stdout.stat().st_size,'sha256':hash_file(stdout)[1]},'stderr':{'bytes':stderr.stat().st_size,'sha256':hash_file(stderr)[1]}};self.stop_owned(name);row=deadline_receipt(logs/(label+'-TERMINAL.json'),row,deadline,{'stopReason':row['stopReason'] or 'original combined240min deadline exhausted before phase completion credit'},started);return row

def capacity(root,profile):
 row,p=process(['docker','info','--format','{{json .Architecture}} {{json .NCPU}} {{json .MemTotal}} {{json .DockerRootDir}}'],root/'control'/'capacity-docker',time.monotonic()+30);need(row['exitCode']==0 and row['reason'] is None,'Docker capacity metadata');values=json.JSONDecoder();text=p.read_text().strip();parts=[]
 while text:
  value,n=values.raw_decode(text);parts.append(value);text=text[n:].lstrip()
 arch,cpus,memory,docker_root=parts;limit=profile['limits'];capacity_plan(profile);free=shutil.disk_usage(root).free;need(arch in ['amd64','x86_64'] and cpus>=limit['minCPUs'] and memory>=limit['minHostMemory'],'actual original AMD64/4CPU/15GiB host capacity');need(free>=limit['minimumFreeBeforeInputs'],'fresh full84,020,297,728byte scratch envelope');need(os.stat(root).st_dev==os.stat(docker_root).st_dev,'Docker and capture storage physical accounting share admitted filesystem');row,p=process(['docker','container','ls','-q'],root/'control'/'capacity-running',time.monotonic()+30);need(row['exitCode']==0 and row['reason'] is None and not p.read_bytes().strip(),'no existing running containers displaced');return {'architecture':arch,'CPUs':cpus,'memoryBytes':memory,'freeBytes':free,'requiredFullScratchBytes':limit['minimumFreeBeforeInputs'],'DockerRootDir':docker_root,'kernelFilesystemQuotaClaimed':False,'nativeAdmissionDoesNotProve12GiBRecoveryOrInstantArtifactQuota':True}
def prove_image(c):
 p=c.profile;alias=c.state['imageAlias'];reserve_image_inputs(c);c.docker(['pull','--platform','linux/amd64',p['image']['reference']],seconds=900);admit_pulled_image(c);need(shutil.disk_usage(c.root).free>=9*1024**3,'same nine GiB opaque image scratch admission after pull before tag/save');c.docker(['tag',p['image']['reference'],alias]);c.state['imageAliasCreated']=True;c.save();image=c.inspect('image',alias);need(image and image['Architecture']=='amd64' and image['Os']=='linux' and image['RootFS']['Layers']==['sha256:'+x for x in p['image']['diffIDs']],'fresh actual original image architecture/raw layer identities');target=c.root/'original-image-proof.tar';c.docker(['save','--output',str(target),alias],seconds=600);need(target.stat().st_size<=8*1024**3,'independent original image export scratch bound');config=None;layer_hashes=[]
 with tarfile.open(target,'r:') as t:
  entries=t.getmembers();need(len(entries)<=1000,'original image export metadata bound');configs=[x for x in entries if x.isfile() and (x.name=='blobs/sha256/'+p['image']['configSHA256'] or x.name==p['image']['configSHA256']+'.json')];need(len(configs)==1 and configs[0].size<=65536,'exact original config in physical image export');body=t.extractfile(configs[0]).read();need(digest(body)==p['image']['configSHA256'],'exported original config bytes');config=json.loads(body);m=t.getmember('manifest.json');need(m.isfile() and m.size<=65536,'Docker export layer map');man=json.loads(t.extractfile(m).read());need(len(man)==1 and len(man[0]['Layers'])==4,'four actual original layers in export')
  for name,expected in zip(man[0]['Layers'],p['image']['diffIDs']):
   item=t.getmember(name);need(item.isfile(),'raw layer byte member');h=hashlib.sha256();n=0;f=t.extractfile(item);signature=f.read(2);f.seek(0);stream=gzip.GzipFile(fileobj=f,mode='rb') if signature==b'\x1f\x8b' else f
   for block in iter(lambda:stream.read(1048576),b''):need(time.monotonic()<c.state['preparationDeadline'],'original layer proof within preparation deadline');h.update(block);n+=len(block);need(n<=p['image']['rawLayerBytes'],'original raw layer byte bound')
   need(h.hexdigest()==expected,'actual exported original rawdiffID');layer_hashes.append({'bytes':n,'sha256':h.hexdigest()})
 need(sum(x['bytes'] for x in layer_hashes)==p['image']['rawLayerBytes'],'actual original raw layer total');freeze(c.root/'evidence'/'ORIGINAL-IMAGE-IDENTITY.json',encoded({'requestedOriginalManifest':p['image']['manifestSHA256'],'actualRuntimeImageID':image['Id'],'originalConfig':p['image']['configSHA256'],'rawOriginalLayers':layer_hashes,'staticNoticePackageHandoffSHA256':p['image']['staticNoticePackageHandoffSHA256'],'historicalPublisherConsumptionAttested':False}));target.unlink() # exact redundant transport, original config/layer bytes already proved and operator custody is pinned
def produce(nonce,pin):
 profile=manifest_check(pin);mode=original_mode_configuration(profile);ctx=context(nonce);need(os.environ.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and os.environ.get('GITHUB_REPOSITORY')==profile['repository'] and os.environ.get('GITHUB_RUN_ATTEMPT')=='1','manual-only selected repository first attempt');need(os.environ.get('CHECKTRAIL_OPERATOR_ACK')=='sdk10-original-e34-240m-'+pin[:12],'concrete operator source-execution acknowledgement');root=root_path(nonce);need(not root.exists(),'new owned hosted root');root.mkdir(mode=0o700)
 for name in ['control','protected','materialization','evidence','capture','windows']:(root/name).mkdir(mode=0o700)
 started=time.monotonic();c=Controller(root,ctx,profile);c.state={'context':ctx,'started':started,'preparationDeadline':started+1800,'phaseDeadline':started+1800,'cleanupDeadline':started+21000,'volume':'ct-sdk10-'+str(ctx['run'])+'-'+nonce,'tempVolume':'ct-sdk10-'+str(ctx['run'])+'-'+nonce+'-tmp','prefix':'ct-sdk10-'+str(ctx['run'])+'-'+nonce,'imageAlias':'checktrail-sdk10-owned:'+str(ctx['run'])+'-'+nonce,'imageAliasCreated':False,'containers':[],'uid':os.getuid(),'gid':os.getgid(),'manifestSHA256':pin,'captureReady':False,'operatorFullRoundtripAcknowledged':False,'windows':{},'sourceCalledSandboxed':False};c.save();error=None
 try:
  freeze(root/'evidence'/'ORIGINAL-MODE-CONFIGURATION.json',encoded(mode))
  api=GitHub(root/'control'/'api',c.state['preparationDeadline']);api.bind(ctx,profile['workflowPath']);recipient=json.loads(os.environ.get('CHECKTRAIL_RECIPIENT_JWK','null'));operation(root/'control'/'validate-recipient','validate-recipient',{'publicJWK':recipient},c.state['preparationDeadline']);channel={'ref':'heads/diagnostic/sdk10-recovery-'+nonce,'parent':os.environ.get('CHECKTRAIL_ACK_PARENT','')};ack_api=AckAPI(root/'control'/'ack-admission',c.state['preparationDeadline'],channel,ctx);need(ack_api.current()==channel['parent'],'existing original ACK ref parent before any source/input action');c.state['publicRecipientJWK']=recipient;c.state['recoveryACKChannel']=channel;c.save();c.state['capacityAdmission']=capacity(root,profile);c.save();freeze(root/'evidence'/'ACTUAL-CAPACITY-ADMISSION.json',encoded(c.state['capacityAdmission']));freeze(root/'evidence'/'PROFILE.json',encoded(profile));c.cmd(input_prep_command(root,c.state['preparationDeadline']),1800);need(time.monotonic()<c.state['preparationDeadline'],'input preparation30min budget');prove_image(c);need(c.inspect('volume',c.state['volume']) is None,'owned volume starts absent');labels=[v for k,vv in owned_labels(ctx).items() for v in ['--label',k+'='+vv]];
  for volume in [c.state['volume'],c.state['tempVolume']]:
   need(c.inspect('volume',volume) is None,'owned persistent volume starts absent');c.docker(['volume','create',*labels,volume]);c.volume_owned(volume)
  args=['/observer/input_prep.py','materialize','--profile','/observer/profile.json','--inputs','/inputs','--work','/work','--evidence','/evidence','--uid',str(c.state['uid']),'--gid',str(c.state['gid']),'--deadline',str(c.state['preparationDeadline'])];c.helper('materialize',args,c.state['preparationDeadline']);retain_materialization_receipts(c);c.helper('image-probe',['/observer/observer.py','probe','--profile','/observer/profile.json','--evidence','/evidence','--deadline',str(c.state['preparationDeadline']),'--uid',str(c.state['uid']),'--gid',str(c.state['gid'])],c.state['preparationDeadline']);need(time.monotonic()<c.state['preparationDeadline'],'all preparation within30min');space=observe_space(root,c.state['capacityAdmission']['DockerRootDir'],profile,'post-materialization-before-native');freeze(root/'evidence'/'POST-MATERIALIZATION-SPACE-ADMISSION.json',encoded(space));need(space['accepted'],'fresh same-filesystem full additional working plus capture scratch admission');need(time.monotonic()<c.state['preparationDeadline'],'disk admission within original preparation budget');native_deadline=time.monotonic()+14400;c.state['nativeDeadline']=native_deadline;c.state['phaseDeadline']=native_deadline;c.save();build=c.native('original-build',profile['buildArgv'],native_deadline);c.state['build']=build;c.save()
  if build['exitCode']==0 and build['stopReason'] is None and time.monotonic()<native_deadline:c.state['test']=c.native('original-tests',profile['testArgv'],native_deadline)
  else:c.state['test']={'state':'NOT_RUN','reason':'original build failed/incomplete or original combined240min exhausted','passingCredit':False}
 except BaseException as e:error={'type':type(e).__name__,'reason':str(e)[:300] if isinstance(e,Refusal) else 'first-party controller operation incomplete'}
 finally:
  c.state['phaseDeadline']=c.state['cleanupDeadline'];stop_ok=True
  for name in c.state['containers']:
   try:c.stop_owned(name)
   except BaseException:stop_ok=False
  c.state['error']=error;c.state['ownedSourceProcessesPositivelyStopped']=stop_ok;c.state['exportDeadline']=min(started+20700,time.monotonic()+4500);c.state['phaseDeadline']=c.state['exportDeadline'];c.save()
  retain_materialization_receipts(c)
  if stop_ok:
   try:
    c.volume_owned();c.volume_owned(c.state['tempVolume']);space=observe_space(root,c.state['capacityAdmission']['DockerRootDir'],profile,'stopped-before-capture');freeze(root/'evidence'/'STOPPED-CAPTURE-SPACE-ADMISSION.json',encoded(space));need(space['accepted'],'fresh same-filesystem plain+cipher+two-carrier+reserve physical admission');free_before_capture=space['actualFreeBytes'];required_capture_scratch=space['requiredFreeBytes'];freeze(root/'evidence'/'PRIVATE-ENVELOPE-SCRATCH-ADMISSION.json',encoded({'actualFreeBytes':free_before_capture,'requiredRemainingCaptureCipherAndCarrierBytes':required_capture_scratch,'plaintextMaximumBytes':12*1024**3-65536,'encryptedMaximumBytes':12*1024**3,'maximumTwoCarrierScratchBytes':2*128*1024**2,'freeReserveBytes':profile['limits']['freeReserve'],'selectedMinimumFreeBeforeInputs':profile['limits']['minimumFreeBeforeInputs'],'redundantImageExportMustBeAbsentBeforeEncryption':True,'receiverMaximumCopiesOfCaptureEquivalent':3}));need(time.monotonic()<c.state['exportDeadline']-60,'bounded75min capture/recovery reserve');c.helper('after-observer',['/observer/observer.py','after','--profile','/observer/profile.json','--evidence','/evidence','--deadline',str(c.state['exportDeadline']),'--uid',str(c.state['uid']),'--gid',str(c.state['gid']),*(['--test-start-wall',str(c.state['test']['startedWallTime'])] if c.state.get('test',{}).get('startedWallTime') is not None else [])],c.state['exportDeadline'],True);retain_control_snapshot(c);c.helper('stopped-capture',['/observer/capture.py','--work','/work','--evidence','/evidence','--inputs','/inputs','--out','/capture','--deadline',str(c.state['exportDeadline']),'--uid',str(c.state['uid']),'--gid',str(c.state['gid'])],c.state['exportDeadline'],True,True);capture=read_json(root/'capture'/'CAPTURE-RESULT.json');need(capture.get('archiveRoundtripVerified') is True,'full stopped persistent-byte sender roundtrip');c.state['capture']=capture;need(not (root/'original-image-proof.tar').exists(),'redundant independent image export absent before plain+cipher scratch peak');envelope=operation(root/'control'/'encrypt','encrypt',{'source':str(root/'capture'/'STOPPED-EVIDENCE.tar.gz'),'out':str(root/'capture'/'STOPPED-EVIDENCE.ct10'),'plaintext':capture,'context':ctx,'publicJWK':c.state['publicRecipientJWK'],'seconds':max(.001,min(4500,c.state['exportDeadline']-time.monotonic()-5))},c.state['exportDeadline']);need(envelope['context']==ctx and envelope['plaintext']==capture and envelope['bytes']<=12*1024**3,'encrypted capture exact identity/overhead within original bound');c.state['envelope']=envelope;c.state['bodyPlan']=body_plan(envelope['bytes']);c.state['captureReady']=True
   except BaseException as e:c.state['captureError']={'type':type(e).__name__,'reason':str(e)[:300] if isinstance(e,Refusal) else 'stopped capture incomplete'}
  c.save();output({'capture_ready':str(c.state['captureReady']).lower(),'total_carriers':c.state.get('bodyPlan',{}).get('totalCarriers',0)});print(json.dumps({'captureReady':c.state['captureReady'],'originalBuildExit':c.state.get('build',{}).get('exitCode'),'originalTestExit':c.state.get('test',{}).get('exitCode'),'error':error,'GateAComplete':False,'auditConfiguredState':mode['auditConfiguredState'],'auditPassingCredit':False}))
 if not c.state['captureReady']:raise SystemExit(1)
def retain_control_snapshot(c):
 target=c.root/'evidence'/'FIRST-PARTY-CONTROL-SNAPSHOT';need(not target.exists(),'fresh first-party command receipt snapshot');target.mkdir(mode=0o700)
 for parent,dirs,files in os.walk(c.root/'control',followlinks=False):
  relative=pathlib.Path(parent).relative_to(c.root/'control');destination=target/relative
  for name in dirs:
   source=pathlib.Path(parent,name);need(not source.is_symlink(),'first-party control directory links refused');(destination/name).mkdir(mode=0o700)
  for name in files:
   source=pathlib.Path(parent,name);need(source.is_file() and not source.is_symlink(),'first-party control regular file only');shutil.copyfile(source,destination/name);need(hash_file(source)==hash_file(destination/name),'control snapshot physical readback');fd=os.open(destination/name,os.O_RDONLY)
   try:os.fsync(fd)
   finally:os.close(fd)
  syncdir(destination)
 sync_chain(target,c.root)
def retain_materialization_receipts(c):
 for file in (c.root/'materialization').iterdir():
  need(file.is_file() and not file.is_symlink(),'first-party materialization metadata files only');target=c.root/'evidence'/file.name;need(not target.exists(),'materialization receipt cannot replace prior evidence');os.rename(file,target)
def load_controller(nonce,pin):
 profile=manifest_check(pin);ctx=context(nonce);root=root_path(nonce);need(root.exists(),'original owned controller root');c=Controller(root,ctx,profile);need(c.state is not None and c.state['context']==ctx and c.state['manifestSHA256']==pin,'same reviewed original controller context');return c
def prepare_window(nonce,pin,window):
 c=load_controller(nonce,pin);s=c.state;need(s['captureReady'] and time.monotonic()<s['exportDeadline'],'shared75min capture/recovery deadline');plan=s['bodyPlan'];need(1<=window<=plan['windows'],'declared actual carrier window');need(window==1 or s['windows'].get(str(window-1),{}).get('acknowledged') is True,'no next window before exact previous owned404s');out=c.root/'windows'/str(window).zfill(2);need(not out.exists(),'new two-slot local carrier window');out.mkdir(mode=0o700);archive=c.root/'capture'/'STOPPED-EVIDENCE.ct10';need(archive.stat().st_size==s['envelope']['bytes'] and stat.S_IMODE(archive.stat().st_mode)==0o400,'frozen stopped archive physical bound')
 if 'series' not in s:
  need(hash_file(archive)==(s['envelope']['bytes'],s['envelope']['sha256']),'full original stopped archive SHA before first export');s['series']={'schemaVersion':1,'kind':'encrypted-original-sdk10-stopped-persistent-evidence','context':c.ctx,'archive':s['envelope'],'recoveryACKChannel':s['recoveryACKChannel'],'plan':plan,'originalBuildExit':s.get('build',{}).get('exitCode'),'originalTestExit':s.get('test',{}).get('exitCode'),'receiverFullRoundtripRequiredBeforeFinalDeletion':True};s['seriesSHA256']=digest(encoded(s['series']));c.save()
 for ordinal in [window*2-1,window*2]:
  folder=out/str(ordinal).zfill(6);folder.mkdir();payload=ordinal<=plan['payloadParts'];offset=(ordinal-1)*plan['partBytes'] if payload else None;expected=min(plan['partBytes'],s['envelope']['bytes']-offset) if payload else 1024;h=hashlib.sha256();part=folder/'part.bin'
  with part.open('xb') as f:
   if payload:
    with archive.open('rb') as source:
     source.seek(offset);remaining=expected
     while remaining:
      need(time.monotonic()<s['exportDeadline'],'carrier creation within shared recovery reserve');b=source.read(min(1048576,remaining));need(b,'full original stopped archive carrier');f.write(b);h.update(b);remaining-=len(b)
   else:
    seed=encoded({'sentinel':True,'seriesSHA256':s['seriesSHA256'],'ordinal':ordinal});body=seed+b'\n'*(1024-len(seed));need(len(body)==1024,'bounded final custody sentinel');f.write(body);h.update(body)
   f.flush();os.fsync(f.fileno())
  part.chmod(0o400);meta={'series':s['series'],'seriesSHA256':s['seriesSHA256'],'ordinal':ordinal,'window':window,'finalWindow':window==plan['windows'],'payload':payload,'offset':offset,'bytes':expected,'sha256':h.hexdigest()};freeze(folder/'part.json',encoded(meta));syncdir(folder)
 freeze(out/'PREPARED.json',encoded({'window':window,'ordinals':[window*2-1,window*2],'seriesSHA256':s['seriesSHA256']}));print(json.dumps({'preparedWindow':window,'twoLocalCarriers':True}))
def record_window(nonce,pin,window,ids):
 c=load_controller(nonce,pin);s=c.state;need(time.monotonic()<s['exportDeadline'],'shared capture/recovery reserve');ordinals=[window*2-1,window*2];ids=[int(x) for x in ids.split(',')];need(len(ids)==2 and len(set(ids))==2 and all(x>0 for x in ids),'two exact returned artifact IDs');api=GitHub(c.root/'control'/('record-'+str(window)),s['exportDeadline']);api.bind(c.ctx,c.profile['workflowPath']);members=None
 while members is None:
  need(time.monotonic()<s['exportDeadline']-2,'bounded exact window metadata observation');listing=api.call('repos/stsepelin/checktrail/actions/runs/'+str(c.ctx['run'])+'/artifacts?per_page=100');members=validate_window_listing(listing,c.ctx,ordinals)
  if members is None:time.sleep(1)
 need([x['id'] for x in members]==ids,'actual upload outputs and exact two-slot listing agree')
 for expected,ordinal,aid in zip(members,ordinals,ids):
  actual=owned(api.call('repos/stsepelin/checktrail/actions/artifacts/'+str(aid),fresh_creation=True),c.ctx,ordinal);need(all(actual.get(k)==expected.get(k) for k in ['id','name','size_in_bytes']),'fresh artifact descriptor matches exact upload ID/name/size');need(expected.get('digest') is None or actual.get('digest')==expected['digest'],'previously observed artifact digest must be reconfirmed unchanged')
 row={'window':window,'ordinals':ordinals,'ids':ids,'twoSlotsActuallyObserved':True,'thirdAdmissionBlockedUntilBothExact404s':True,'acknowledged':False};s['windows'][str(window)]=row;c.save();freeze(c.root/'windows'/str(window).zfill(2)/'AT-CAPACITY.json',encoded(row));print(json.dumps({'window':window,'twoOwnedSlotsObserved':True}))
def wait_window(nonce,pin,window):
 c=load_controller(nonce,pin);s=c.state;row=s['windows'].get(str(window));need(row and row['window']==window and len(row['ids'])==2,'recorded exact owned pair');api=GitHub(c.root/'control'/('wait-'+str(window)),s['exportDeadline']);api.bind(c.ctx,c.profile['workflowPath']);absent=[]
 while len(absent)<2:
  need(time.monotonic()<s['exportDeadline']-2,'shared75min recovery deadline, not a new per-window allowance')
  listing=api.call('repos/stsepelin/checktrail/actions/runs/'+str(c.ctx['run'])+'/artifacts?per_page=100');items=listing.get('artifacts');need(type(listing.get('total_count')) is int and 0<=listing['total_count']<=2 and type(items) is list and len(items)<=2,'bounded current owned-pair absence listing');need(all(type(x) is dict and x.get('id') in row['ids'] for x in items),'no unrelated artifact admitted by sender wait')
  if listing['total_count']==0 and items==[]:
   for aid in row['ids']:
    if aid not in absent and api.call('repos/stsepelin/checktrail/actions/artifacts/'+str(aid),missing=True) is None:absent.append(aid)
  if len(absent)<2:time.sleep(min(10,max(0,s['exportDeadline']-time.monotonic()-2)))
 row['acknowledged']=True;row['exactOwnedIDsObserved404']=absent;row['artifactAbsenceAloneProvesFullRecovery']=False
 if window==s['bodyPlan']['windows']:
  channel=AckAPI(c.root/'control'/'ack-final',s['exportDeadline'],s['recoveryACKChannel'],c.ctx);ack=None
  while ack is None:
   need(time.monotonic()<s['exportDeadline']-5,'signed durable recovery ACK within existing export deadline');ack=channel.fetch()
   if ack is None:time.sleep(10)
  expected=validate_ack_payload(ack['ack'].get('payload'),s['series']);proof=operation(c.root/'control'/'verify-recovery-ack','verify-ack',{'ack':ack['ack'],'expected':expected,'publicJWK':s['publicRecipientJWK']},s['exportDeadline']);need(proof.get('operatorSignatureVerified') is True,'authenticated local recovery proof');s['authenticatedRecoveryACKVerified']=True;s['recoveryACK']=ack;s['operatorFullRoundtripAcknowledged']=True
 c.save();freeze(c.root/'windows'/str(window).zfill(2)/'RECEIVER-ACK.json',encoded(row))
 # These two local parts are redundant byte slices of the still-retained full
 # archive, and their exact remote ownership/custody acknowledgement is recorded.
 for ordinal in row['ordinals']:
  folder=c.root/'windows'/str(window).zfill(2)/str(ordinal).zfill(6);meta=read_json(folder/'part.json');need(hash_file(folder/'part.bin')==(meta['bytes'],meta['sha256']),'owned redundant local part identity before removal');(folder/'part.bin').unlink();(folder/'part.json').unlink();folder.rmdir()
 print(json.dumps({'window':window,'bothExactOwnedIDs404':True,'fullArchiveRoundtripAcknowledged':s['operatorFullRoundtripAcknowledged']}))
def finalize_image_inputs(c,recovered,cleanup):
 if recovered:
  try:cleanup.append({'kind':'owned-image-inputs',**cleanup_image_inputs(c,min(c.state['cleanupDeadline'],c.state.get('phaseDeadline',c.state['cleanupDeadline'])))})
  except BaseException as error:cleanup.append({'kind':'owned-image-inputs','positiveOwnedAbsenceObserved':False,'positiveOwnedAliasAbsenceObserved':False,'positiveOwnedCanonicalAbsenceObserved':False,'cleanupErrorType':type(error).__name__})

def finalize(nonce,pin):
 c=load_controller(nonce,pin);s=c.state;s['phaseDeadline']=min(s['cleanupDeadline'],time.monotonic()+c.profile['limits']['cleanupSeconds']);cleanup=[];recovered=s.get('operatorFullRoundtripAcknowledged') is True and s.get('captureReady') is True
 for name in s['containers']:
  try:cleanup.append({'kind':'container','name':name,'positiveOwnedAbsenceObserved':c.stop_owned(name)})
  except BaseException:cleanup.append({'kind':'container','name':name,'positiveOwnedAbsenceObserved':False})
 for volume_name in [s['volume'],s['tempVolume']]:
  try:volume=c.inspect('volume',volume_name)
  except BaseException:cleanup.append({'kind':'volume','name':volume_name,'positiveOwnedAbsenceObserved':False,'inspectionUnavailable':True});continue
  if volume is not None:
   if recovered:
    # The full record (inspect object, mount path, argv, error text) stays in
    # the private evidence receipt remove_owned_volume freezes; the terminal
    # is printed, so it carries only the privacy-safe projection.
    try:record=remove_owned_volume(c,volume_name);public=record.get('privacySafeProjection');need(type(public) is dict,'owned volume cleanup projection');cleanup.append(public)
    except BaseException:cleanup.append({'kind':'volume','name':volume_name,'positiveOwnedAbsenceObserved':False})
   else:cleanup.append({'kind':'volume','name':volume_name,'retainedBecauseIndependentRecoveryIncomplete':True,'hostedRunnerDisposalMayRemoveRetainedVolume':True})
  else:cleanup.append({'kind':'volume','name':volume_name,'positiveOwnedAbsenceObserved':True})
 finalize_image_inputs(c,recovered,cleanup)
 natural_path=c.root/'evidence'/'ORIGINAL-NATURAL-TEST-REPORTS.json';fresh_path=c.root/'evidence'/'FRESH-SELECTED-SDK-OUTPUTS.json';natural=read_json(natural_path) if natural_path.exists() else {};fresh=read_json(fresh_path) if fresh_path.exists() else {};build=s.get('build',{});test=s.get('test',{});build_ok=build.get('exitCode')==0 and build.get('stopReason') is None;test_ok=test.get('exitCode')==0 and test.get('stopReason') is None and natural.get('allCreditedFreshTestsPassed') is True;all_cleanup=all(x.get('positiveOwnedAbsenceObserved') is True for x in cleanup);complete=build_ok and test_ok and fresh.get('selectedSDKArchiveMetadataAndAttributionObserved') is True and fresh.get('validatedBuildArchiveBytesUnchangedForStoppedCapture') is True and recovered and all_cleanup
 terminal={'schemaVersion':1,'state':'COMPLETE original producer command/test/output/custody observations' if complete else 'INCOMPLETE original producer command/test/output/custody observations','context':c.ctx,'manifestSHA256':pin,'originalBuildCommandPassed':build_ok,'originalTestCommandAndObservedNaturalTestsPassed':test_ok,'skipsUnavailableEmptyOrStaleGivenPassingCredit':False,'selectedSDKMetadataAndAttributionObserved':fresh.get('selectedSDKArchiveMetadataAndAttributionObserved') is True,'validatedBuildArchiveBytesUnchangedForStoppedCapture':fresh.get('validatedBuildArchiveBytesUnchangedForStoppedCapture') is True,'independentOperatorArchiveRoundtripAcknowledged':recovered,'capture':s.get('capture'),'cleanup':cleanup,'allOwnedCleanupPositivelyObserved':all_cleanup,'preexistingResourcesDeleted':False,'sourceCalledSandboxed':False,'GateAOrWholeProducerGraphClosureClaimed':False,'bodyPlan':s.get('bodyPlan'),'windowCustodyAcknowledgements':s['windows'],'originalFailure':s.get('error'),'sourceAndCompilerSelectionRequiresPostBuildEvidenceAudit':True};freeze(c.root/'TERMINAL.json',encoded(terminal));output({'terminal_ready':'true'});print('CHECKTRAIL_SDK10_TERMINAL='+json.dumps(terminal,sort_keys=True,separators=(',',':')))
 if not complete:raise SystemExit(1)
def main():
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['produce','prepare-window','record-window','wait-window','finalize']);p.add_argument('--nonce',required=True);p.add_argument('--manifest-sha256',required=True);p.add_argument('--window',type=int);p.add_argument('--ids');a=p.parse_args()
 if a.mode=='produce':produce(a.nonce,a.manifest_sha256)
 elif a.mode=='prepare-window':prepare_window(a.nonce,a.manifest_sha256,a.window)
 elif a.mode=='record-window':record_window(a.nonce,a.manifest_sha256,a.window,a.ids)
 elif a.mode=='wait-window':wait_window(a.nonce,a.manifest_sha256,a.window)
 else:finalize(a.nonce,a.manifest_sha256)
if __name__=='__main__':
 def interrupted(signum,frame):raise InterruptedError('owned first-party controller interrupted')
 for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,interrupted)
 main()
