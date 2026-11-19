"""Owned per-run first-party metadata placement, never a stock permission repair."""
from pathlib import Path
import hashlib,json,os,re,stat
PARENT=Path('/opt')
def need(value,reason):
 if not value:raise ValueError(reason)
def status(path):return Path(path).lstat()
def paths(context,parent=None):
 parent=PARENT if parent is None else Path(parent);run=context['GITHUB_RUN_ID'];attempt=context['GITHUB_RUN_ATTEMPT'];head=context['GITHUB_SHA'];need(re.fullmatch(r'[1-9][0-9]{0,19}',run) and re.fullmatch(r'[1-9][0-9]{0,9}',attempt) and re.fullmatch('[0-9a-f]{40}',head),'closed-host-placement-context')
 base=parent/('checktrail-rust198-'+run+'-'+attempt+'-'+head[:12]);return {'parent':parent,'base':base,'controller':base/'controller','host':base/'host','nativeWork':base/('rust198-'+run+'-'+attempt+'-'+head[:12])}
def validate_parent(parent=None):
 parent=PARENT if parent is None else Path(parent);need(parent.is_absolute() and parent==parent.resolve(strict=True),'physical-existing-placement-parent')
 records=[]
 for path in [parent,*parent.parents]:
  s=status(path);need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_mode&stat.S_IXOTH,'root-owned-traversable-existing-placement-ancestor');records.append({'path':str(path),'uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode)})
 return records

def create_namespace(context):
 need(os.getuid()==0,'root-owned-placement-startup-required');p=paths(context);validate_parent(p['parent']);p['base'].mkdir(mode=0o700);p['base'].chmod(0o755);s=status(p['base']);need(s.st_uid==0 and stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o755,'new-owned-placement-identity');return p

def validate_runtime(context,controller,output):
 p=paths(context);validate_parent(p['parent']);need(Path(controller)==p['controller'] and Path(output)==p['host'],'exact-own-run-controller-and-output-placement')
 for path,mode in [(p['base'],0o755),(p['controller'],0o555)]:
  s=status(path);need(path==path.resolve(strict=True) and stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==mode,'owned-controller-placement-identity')
 s=status(p['host']);need(p['host']==p['host'].resolve(strict=True) and stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'private-owned-host-output-placement');return p

def require_native_work(context,controller,work):
 p=paths(context);validate_parent(p['parent']);need(Path(controller)==p['controller'] and Path(work)==p['nativeWork'],'shared-native-controller-work-placement')
 for path,mode in [(p['base'],0o755),(p['controller'],0o555)]:
  s=status(path);need(path==path.resolve(strict=True) and s.st_uid==0 and stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==mode,'owned-native-placement-identity')
 return p

def access_canary(module,bounds,controller,output,identity,context,runner_uid,observe):
 """A real nonempty first-party read as nobody before ANY bulk SDK snapshot.
 The legacy inspector's controller identity check reads/hashes this public canary
 body. The actual legacy script is independently in the frame; no SDK is present.
 """
 validate_runtime(context,controller,output);bounds.tick();payload=module.encoded({'firstPartyAccessCanary':1,'runContext':context});need(0<len(payload)<=4096,'nonempty-small-firstparty-canary');canary=Path(output)/'FIRSTPARTY-ACCESS-CANARY';request=Path(output)/'FIRSTPARTY-CANARY-REQUEST.json';need(not os.path.lexists(canary) and not os.path.lexists(request),'fresh-owned-canary-files')
 # Create request's directory entry BEFORE framing ancestors. Filling its open
 # descriptor later changes the request inode, not framed parent directory times.
 descriptor=None
 try:
  fd=os.open(canary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
  with os.fdopen(fd,'wb') as f:os.fchmod(f.fileno(),0o444);f.write(payload);f.flush();os.fsync(f.fileno())
  descriptor=os.open(request,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444);os.fchmod(descriptor,0o444);Path(output).chmod(0o755)
  script=Path(controller)/'reused_admission.py';frame=module.snapshot([script,canary],bounds);seen={r['path'] for r in frame}
  for path in sorted({q for file in [script,canary] for q in file.parents},key=str):
   if str(path) not in seen:bounds.entry();frame.append({'path':str(path),**module.metadata(path),'type':'directory'});seen.add(str(path))
  frame.sort(key=lambda r:os.fsencode(r['path']));need(len(frame)>2 and any(r['path']==str(canary) and r['bytes']>0 for r in frame),'nonempty-firstparty-canary-frame')
  body=module.encoded({'frame':frame,'controller':{'file':str(canary),'sha256':hashlib.sha256(payload).hexdigest(),'uid':runner_uid},'identity':identity});need(len(body)<=65536,'small-firstparty-canary-request')
  with os.fdopen(descriptor,'wb') as f:descriptor=None;f.write(body);f.flush();os.fsync(f.fileno())
  command=['/usr/bin/sudo','-n','-u','nobody','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL=C','/usr/bin/python3','-I','-S','-B',str(script),'--inner',str(request)];receipts=[];bounds.tick();value=observe(module,command,{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C'},receipts,timeout=min(30,bounds.deadline-bounds.clock()));bounds.tick();end=module.current_endpoint(frame)
  need(value['metadataEndpointSha256']==module.digest(module.encoded(end)) and value['controllerProtected'] is True and value['allSelectedEntriesReadableExecutableAndProtected'] is True and value['selectedEntriesChecked']==len(frame),'firstparty-canary-access-refused')
  return {'firstPartyOnlyNonemptyAccessCanaryObserved':True,'payloadReadBytesVerifiedByLegacyHashCheck':len(payload),'payloadSHA256':hashlib.sha256(payload).hexdigest(),'selectedFirstpartyAndAncestorEntries':len(frame),'allAncestorsTraversableReadableAndProtected':True,'identity':identity,'commands':receipts,'secondsLimit':30,'costChargedInsideExistingPermissionPhase':True,'SDKBytesReadByThisCanary':0,'SDKFrameOrNativeAdmissionCredit':False}
 finally:
  if descriptor is not None:os.close(descriptor)
  for file in [request,canary]:
   if file.exists() and not file.is_symlink():file.unlink()
  Path(output).chmod(0o700)
