"""Owned per-run first-party metadata placement, never a stock permission repair."""
from pathlib import Path
import hashlib,json,os,re,stat
PARENT=Path('/opt')
def need(value,reason):
 if not value:raise ValueError(reason)
def status(path):return Path(path).lstat()

# Exactly the result reused_admission.inspect_as_build() returns: it raises unless
# the controller is protected, checks every request frame entry once, and sets the
# all-protected flag from a zero failure count with at most 100 listed failures.
INNER_RESULT_FIELDS=frozenset(('identity','selectedEntriesChecked','failureCount','firstFailures','allSelectedEntriesReadableExecutableAndProtected','controllerProtected','metadataEndpointSha256','permissionProbeOnly','projectCodeExecuted'))
INNER_LISTED_FAILURES=100
INNER_FAILURE_FIELDS=frozenset(('path','readable','executableWhenRequired','writablePaths'))
def require_consistent_failure_rows(rows,frame,failures):
 """Each listed row names one frame entry, in frame order, that failed a check.
 A symlink's execution requirement comes from its bound physical target record,
 and a non-executable file reports executableWhenRequired true. protected_path()
 names only the entry and its ancestors, nearest first; an ancestor may lie
 outside the frame, because snapshot() records roots and their descendants only.
 Only the first failures are listed, so every omitted one lies after the last.
 """
 if not rows:return
 records={row['path']:row for row in frame};position={}
 for index,row in enumerate(frame):position.setdefault(str(Path(row['path'])),index)
 previous=-1
 for row in rows:
  need(type(row) is dict and set(row)==INNER_FAILURE_FIELDS and type(row['path']) is str and type(row['readable']) is bool and type(row['executableWhenRequired']) is bool and type(row['writablePaths']) is list and all(type(p) is str for p in row['writablePaths']),'First-party inner result inconsistent: listed failure row shape')
  index=position.get(row['path']);need(index is not None and index>previous,'First-party inner result inconsistent: listed failure outside request frame order');previous=index
  entry=frame[index];target=records.get(entry.get('physicalPath')) if entry['type']=='symlink' else entry
  need(target is not None and target['type'] in ('file','directory'),'First-party inner result inconsistent: listed failure without bound physical target')
  need(target['type']=='directory' or target['mode']&0o111 or row['executableWhenRequired'] is True,'First-party inner result inconsistent: execution not required for listed entry')
  path=Path(row['path']);named=[str(path),*map(str,path.parents)];k=0
  for name in row['writablePaths']:
   while k<len(named) and named[k]!=name:k+=1
   need(k<len(named),'First-party inner result inconsistent: writable path is not the entry or its ancestor');k+=1
  need(not (row['readable'] and row['executableWhenRequired'] and not row['writablePaths']),'First-party inner result inconsistent: listed entry did not fail')
 need(len(frame)-1-previous>=failures-len(rows),'First-party inner result inconsistent: omitted failures do not follow the listed ones')

def require_consistent_inner_result(value,frame,identity):
 need(type(value) is dict and set(value)==INNER_RESULT_FIELDS and all(type(value[key]) is bool for key in ['controllerProtected','allSelectedEntriesReadableExecutableAndProtected','permissionProbeOnly','projectCodeExecuted']) and all(type(value[key]) is int for key in ['failureCount','selectedEntriesChecked']) and type(value['firstFailures']) is list,'First-party inner result fields')
 checked=value['selectedEntriesChecked'];failures=value['failureCount']
 need(frame and checked==len(frame),'First-party inner result inconsistent: entries checked differ from request frame')
 need(0<=failures<=checked and len(value['firstFailures'])==min(failures,INNER_LISTED_FAILURES),'First-party inner result inconsistent: failure count')
 need(value['allSelectedEntriesReadableExecutableAndProtected'] is (failures==0),'First-party inner result inconsistent: all-protected flag and failure count')
 need(value['controllerProtected'] is True and value['permissionProbeOnly'] is True and value['projectCodeExecuted'] is False,'First-party inner result inconsistent: controller/probe-only claims')
 need(value['identity']==identity,'First-party inner result inconsistent: build identity')
 require_consistent_failure_rows(value['firstFailures'],frame,failures)
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

INNER_HELPER='VERIFIED-PERMISSION-HELPER.py'
INNER_HELPER_BYTES=1024**2
# The build account runs this from argv, so no file can stand in for it. It reads the
# staged helper once, refuses unless those bytes have the sha256 the root controller
# pinned, and executes exactly those bytes. A helper it cannot open is reported as
# its own bounded refusal with the errno only, never as an interpreter startup error.
INNER_BOOTSTRAP='\n'.join([
 'import hashlib,os,stat,sys',
 'path,expected=sys.argv[1],sys.argv[2]',
 'try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)',
 'except OSError as error:',
 ' sys.stderr.write("permission-helper-open-refused: [Errno %d]\\n"%error.errno);raise SystemExit(2)',
 'try:',
 ' s=os.fstat(fd)',
 ' if not(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<s.st_size<='+str(INNER_HELPER_BYTES)+'):raise SystemExit("permission-helper-not-a-bounded-single-link-file")',
 ' body=b""',
 ' while len(body)<=s.st_size:',
 '  piece=os.read(fd,s.st_size+1-len(body))',
 '  if not piece:break',
 '  body+=piece',
 'finally:os.close(fd)',
 'if len(body)!=s.st_size or hashlib.sha256(body).hexdigest()!=expected:raise SystemExit("permission-helper-sha256-differs")',
 'sys.argv=[path]+sys.argv[3:]',
 'exec(compile(body,path,"exec"),{"__name__":"__main__","__file__":path,"__builtins__":__builtins__})',
])
def stage_inner_helper(module,folder):
 """Write the helper bytes the controller verified against their pin into the
 root-owned output, which the build account can read but not change. The probe
 runs this copy, so replacing the controller's file after verification has no effect."""
 body=module.verifiedSource;need(0<len(body)<=INNER_HELPER_BYTES and hashlib.sha256(body).hexdigest()==module.verifiedSHA256,'verified-permission-helper-bytes')
 file=Path(folder)/INNER_HELPER;fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
 with os.fdopen(fd,'wb') as f:os.fchmod(f.fileno(),0o444);f.write(body);f.flush();os.fsync(f.fileno())
 return file
def inner_command(module,helper,request):
 return ['/usr/bin/sudo','-n','-u','nobody','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL=C','/usr/bin/python3','-I','-S','-B','-c',INNER_BOOTSTRAP,str(helper),module.verifiedSHA256,'--inner',str(request)]

def access_canary(module,bounds,controller,output,identity,context,runner_uid,observe):
 """A real nonempty first-party read as nobody before ANY bulk SDK snapshot.
 The legacy inspector's controller identity check reads/hashes this public canary
 body. The controller's legacy script and the staged copy the probe executes are both
 in the frame; no SDK is present.
 """
 validate_runtime(context,controller,output);bounds.tick();payload=module.encoded({'firstPartyAccessCanary':1,'runContext':context});need(0<len(payload)<=4096,'nonempty-small-firstparty-canary');canary=Path(output)/'FIRSTPARTY-ACCESS-CANARY';request=Path(output)/'FIRSTPARTY-CANARY-REQUEST.json';need(not os.path.lexists(canary) and not os.path.lexists(request),'fresh-owned-canary-files')
 # Create request's directory entry BEFORE framing ancestors. Filling its open
 # descriptor later changes the request inode, not framed parent directory times.
 descriptor=None;helper=None
 try:
  fd=os.open(canary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
  with os.fdopen(fd,'wb') as f:os.fchmod(f.fileno(),0o444);f.write(payload);f.flush();os.fsync(f.fileno())
  helper=stage_inner_helper(module,output);descriptor=os.open(request,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444);os.fchmod(descriptor,0o444);Path(output).chmod(0o755)
  script=Path(controller)/'reused_admission.py';frame=module.snapshot([script,helper,canary],bounds);seen={r['path'] for r in frame}
  for path in sorted({q for file in [script,helper,canary] for q in file.parents},key=str):
   if str(path) not in seen:bounds.entry();frame.append({'path':str(path),**module.metadata(path),'type':'directory'});seen.add(str(path))
  frame.sort(key=lambda r:os.fsencode(r['path']));need(len(frame)>2 and any(r['path']==str(canary) and r['bytes']>0 for r in frame),'nonempty-firstparty-canary-frame')
  body=module.encoded({'frame':frame,'controller':{'file':str(canary),'sha256':hashlib.sha256(payload).hexdigest(),'uid':runner_uid},'identity':identity});need(len(body)<=65536,'small-firstparty-canary-request')
  with os.fdopen(descriptor,'wb') as f:descriptor=None;f.write(body);f.flush();os.fsync(f.fileno())
  command=inner_command(module,helper,request);receipts=[];bounds.tick();value=observe(module,command,{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C'},receipts,timeout=min(30,bounds.deadline-bounds.clock()));bounds.tick();end=module.current_endpoint(frame)
  require_consistent_inner_result(value,frame,identity)
  need(value['metadataEndpointSha256']==module.digest(module.encoded(end)) and value['allSelectedEntriesReadableExecutableAndProtected'] is True,'firstparty-canary-access-refused')
  return {'firstPartyOnlyNonemptyAccessCanaryObserved':True,'payloadReadBytesVerifiedByLegacyHashCheck':len(payload),'payloadSHA256':hashlib.sha256(payload).hexdigest(),'selectedFirstpartyAndAncestorEntries':len(frame),'allAncestorsTraversableReadableAndProtected':True,'identity':identity,'commands':receipts,'secondsLimit':30,'costChargedInsideExistingPermissionPhase':True,'SDKBytesReadByThisCanary':0,'SDKFrameOrNativeAdmissionCredit':False}
 finally:
  if descriptor is not None:os.close(descriptor)
  try:
   for file in [request,canary,helper]:
    if file is not None and file.exists() and not file.is_symlink():file.unlink()
  finally:Path(output).chmod(0o700)
