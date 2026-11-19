"""Readiness and future host/SLA/case-sensitive-workspace contract, no source execution."""
from pathlib import Path
import hashlib,json,os,re,stat,unicodedata
GIB=1024**3
DEVELOPER='/Applications/Xcode_26.2.app/Contents/Developer'
TOOLS=('python3','git','make','cmake','ninja','clang','clang++','ar','ranlib','ld','strip','xar','pkgbuild','hdiutil')
def need(v,m):
 if not v:raise ValueError(m)
def potential_aliases(records):
 groups={}
 for row in records:groups.setdefault(unicodedata.normalize('NFD',row['path']).casefold(),[]).append(row['path'])
 return [v for v in groups.values() if len(v)>1]
def case_probe(root):
 """Own synthetic files only. A result describes this directory, not another host."""
 first=root/'.producer-case-aa';other=root/'.producer-case-AA';need(not os.path.lexists(first) and not os.path.lexists(other),'Fresh case-probe names');created=[]
 try:
  fd=os.open(first,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,b'lower');os.close(fd);created.append(first)
  try:fd=os.open(other,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  except FileExistsError:return {'caseSensitive':False,'caseSensitivePositiveControl':False,'directory':str(root)}
  os.write(fd,b'upper');os.close(fd);created.append(other);need(first.read_bytes()==b'lower' and other.read_bytes()==b'upper' and first.stat().st_ino!=other.stat().st_ino,'Distinct case-sensitive objects');return {'caseSensitive':True,'caseSensitivePositiveControl':True,'directory':str(root)}
 finally:
  for p in created:p.unlink()
def assess(profile,host,include_workspace=True):
 """All native claims stay false unless actual context-bound tool/SLA/IPC proof exists."""
 failures=[]
 def check(v,reason):
  if not v:failures.append(reason)
 check(host.get('evidenceKind')=='actual-standard-github-host','actual-host-evidence-required');check(host.get('platform')=='Darwin' and host.get('arch')=='arm64' and str(host.get('macOS','')).split('.')[0]=='15','standard-macos15-arm64-required');check(host.get('developerDir')==DEVELOPER and host.get('xcodeVersion')=='26.2','selected-Xcode262-not-observed');check(host.get('CPUs',0)>=3 and host.get('RAMBytes',0)>=7*GIB,'original-host-resource-floor-unobserved');check(host.get('scratchFreeBytes',0)>=profile['bounds']['admissionFreeBytes'],'source-build-admission-free-space');check(host.get('controllerProtected') is True and host.get('sdkAndToolsProtectedFromBuildUid') is True and host.get('allDeclaredSDKToolBytesHashed') is True,'physical-UID-readonly-tool-admission');check(host.get('buildUid') not in [None,0,host.get('runnerUid')] and host.get('buildUser')=='nobody' and host.get('sudoDenied') is True,'distinct-unprivileged-build-account');check(host.get('buildUidProcesses')==[],'build-UID-not-quiescent-before-entry');
 if include_workspace:check(host.get('caseSensitiveWorkspace') is True,'full-source-case-sensitive-workspace-unobserved')
 check(host.get('originalSLATextRetained') is True and host.get('SLABodyRootReviewed') is True,'selected-original-SLA-not-closed');check(set(host.get('tools',{}))==set(TOOLS),'complete-selected-tool-inventory-required');cache=host.get('sccache',{});check(profile['originalSccache'].get('sha256') and cache.get('version')=='0.10.0' and cache.get('artifactSHA256')==profile['originalSccache'].get('sha256') and cache.get('originalSourceNoticeClosure') is True and cache.get('MachOArchitecture')=='x86_64' and cache.get('stockRosettaRuntimeObserved') is True,'original-sccache-Rosetta-source-notice-admission');check(host.get('networkIPCProbeQualified') is True and host.get('operatorQualifiedNetworkProfileSHA256')==hashlib.sha256(host.get('qualifiedNetworkProfile','').encode()).hexdigest(),'remote-denial-and-owned-cache-IPC-unqualified');check(cache.get('stopServerCommandQualified') is True,'owned-cache-quiescence-unqualified');return {'nativeEligible':not failures,'failures':failures,'allObservedFloorsDoNotProveBuildFit':True,'memoryHardLimitClaimed':False,'historicalPublisherByteEqualityClaimed':False}

def validate_operator_grant(file,expected_sha,profile_sha,context,code_sha,host_sha,archives_sha,work):
 s=file.lstat();need(file==file.resolve(strict=True) and stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o400 and s.st_size<=65536,'Physical root-owned startup operator grant required');body=file.read_bytes();need(hashlib.sha256(body).hexdigest()==expected_sha,'Operator grant exact bytes');v=json.loads(body);need(v.get('authority')=='explicit-reviewed-workflow-startup' and v.get('profileSHA256')==profile_sha and v.get('controllerCodeSHA256')==code_sha and v.get('runContext')==context and v.get('allowedOperation')=='original-rust198-producer' and v.get('hostReceiptSHA256')==host_sha and v.get('archiveMappingSHA256')==archives_sha and v.get('workNamespace')==str(work),'Operator startup context/profile/code binding');need(v.get('MCPOrModelArgumentAuthority') is False,'A model argument cannot grant execution');return v
