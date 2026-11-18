"""Future metadata-only standard-host probe. No SDK/compiler/source executable is run.
SLA text stays private on the host; this helper has no upload/export implementation.
"""
from pathlib import Path
import argparse,gzip,hashlib,importlib.util,json,os,platform,plistlib,pwd,shutil,stat,subprocess,sys,time
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
import admission as D

def guard():
 p=HERE/'reused_admission.py';D.need(hashlib.sha256(p.read_bytes()).hexdigest()=='06bb9d23fc305375f8e7498caab3fb40cbe65e4e37f01d60ef6333c54c3fa49c','Reviewed permission-frame helper changed');spec=importlib.util.spec_from_file_location('rust_metadata_permissions',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def bounded_read(file,limit):
 before=file.lstat();D.need(stat.S_ISREG(before.st_mode) and before.st_nlink>=1 and 0<before.st_size<=limit,'Bounded physical original host metadata');fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  D.need((os.fstat(stream.fileno()).st_dev,os.fstat(stream.fileno()).st_ino)==(before.st_dev,before.st_ino),'Opened original metadata endpoint');body=stream.read(limit+1)
 after=file.lstat();D.need(len(body)==before.st_size and (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'Host metadata changed while reading');return body

def hash_tool(file,deadline):
 before=file.lstat();D.need(stat.S_ISREG(before.st_mode) and before.st_mode&0o111 and 0<before.st_size<=256*1024**2,'Bounded executable physical tool');h=hashlib.sha256();count=0;fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  opened=os.fstat(stream.fileno());D.need((opened.st_dev,opened.st_ino)==(before.st_dev,before.st_ino),'Opened tool endpoint changed')
  for body in iter(lambda:stream.read(65536),b''):
   D.need(time.monotonic()<deadline,'Tool metadata hash deadline');count+=len(body);D.need(count<=before.st_size,'Tool grew while hashing');h.update(body)
 after=file.lstat();D.need(count==before.st_size and (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'Tool changed while hashing');return {'path':str(file),'bytes':count,'sha256':h.hexdigest(),'uid':after.st_uid,'gid':after.st_gid,'mode':stat.S_IMODE(after.st_mode)}

def collect_metadata(developer,output,context,query,permission_probe=None):
 D.need(not os.path.lexists(output) and output.parent==output.parent.resolve(strict=True),'Fresh private host-metadata output');output.mkdir(mode=0o700);started=time.monotonic();app=developer.parent;infofile=app/'Info.plist';versionfile=app/'version.plist';infobody=bounded_read(infofile,1024**2);versionbody=bounded_read(versionfile,1024**2);info=plistlib.loads(infobody);version=plistlib.loads(versionbody);sdk=(developer/'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk').resolve(strict=True);toolchain=developer/'Toolchains/XcodeDefault.xctoolchain';D.need(sdk.is_dir() and sdk.is_relative_to(developer),'Selected SDK resolved outside declared developer tree');settings=sdk/'SDKSettings.json';settingsbody=bounded_read(settings,4*1024**2);sdk_settings=json.loads(settingsbody);paths=str(toolchain/'usr/bin')+':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';tools={};missing=[]
 for name in D.TOOLS:
  value=shutil.which(name,path=paths)
  if not value:missing.append(name);continue
  p=Path(value).resolve(strict=True);tools[name]=hash_tool(p,started+300)
 original_license=app/'Resources/English.lproj/License.rtf';sla=None
 if original_license.is_file() and not original_license.is_symlink():
  body=bounded_read(original_license,4*1024**2);file=output/'original-Xcode-license.rtf';file.write_bytes(body);file.chmod(0o400);sla={'originalHostPath':str(original_license),'file':str(file),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'rootLegalAssessmentClaimed':False}
 hardware=query();result={'evidenceKind':'actual-standard-github-host','runContext':context,'platform':platform.system(),'arch':platform.machine(),'developerDir':str(developer),'xcodeVersion':info.get('CFBundleShortVersionString'),'xcodeBuild':version.get('ProductBuildVersion'),'sdkPath':str(sdk),'SDKVersionObservedNotHistoricalPublisherPin':sdk_settings.get('Version'),'xcodeInfoSHA256':hashlib.sha256(infobody).hexdigest(),'xcodeVersionPlistSHA256':hashlib.sha256(versionbody).hexdigest(),'SDKSettingsSHA256':hashlib.sha256(settingsbody).hexdigest(),'CPUs':hardware['CPUs'],'RAMBytes':hardware['RAMBytes'],'macOS':hardware['macOS'],'scratchFreeBytes':shutil.disk_usage(output).free,'originalSLA':sla,'originalSLATextRetained':sla is not None,'SLABodyRootReviewed':False,'tools':tools,'missingTools':missing,'stockScratchCaseProbe':D.case_probe(output),'nativeAdmissionGranted':False,'allDeclaredSDKToolBytesHashed':False,'toolRuntimeRootSourceAndNoticeQualificationPending':True,'originalSccacheRosettaAndIPCQualified':False,'SDKCompilerOrSourceExecuted':False,'metadataSystemQueriesOnly':True,'exportPerformed':False,'elapsedSeconds':time.monotonic()-started};D.need(result['elapsedSeconds']<300,'Metadata observation deadline')
 if permission_probe is not None:result.update(permission_probe(developer,sdk,toolchain,tools,output,context))
 return result

def permission_observation(developer,sdk,toolchain,tools,output,context):
 """Read/hash and actual build-UID access probes only. Never chmod stock trees."""
 module=guard();bounds=module.Bounds();account=pwd.getpwnam('nobody');D.need(account.pw_uid not in (0,int(os.environ['CHECKTRAIL_CONTROLLER_UID'])),'Existing distinct nobody account');receipts=[];clean={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C'}
 def run(argv,codes=(0,)):
  bounds.tick();value=module.command(argv,clean,receipts,codes,timeout=min(30,bounds.deadline-bounds.clock()));bounds.tick();return value
 identity={'uid':account.pw_uid,'gid':account.pw_gid,'groups':sorted(set(module.group_id(v) for v in run(['/usr/bin/id','-G','nobody']).stdout.decode().split()))};policy=run(['/usr/bin/sudo','-n','-l','-U','nobody'],(0,1));D.need(module.sudo_denial(policy),'Existing nobody sudo policy not the reviewed exact denial');processes=run(['/bin/ps','-axo','uid=,pid=,command=']).stdout.decode();active=[]
 for line in processes.splitlines():
  parts=line.strip().split(None,2)
  if len(parts)>=2 and int(parts[0])&0xffffffff==account.pw_uid:active.append({'uid':account.pw_uid,'pid':int(parts[1]),'command':parts[2] if len(parts)==3 else ''})
 D.need(not active,'Build UID already has live processes');roots=[sdk,toolchain,HERE];covered=lambda p:any(p==r or r in p.parents for r in roots)
 for name in ['Info.plist','version.plist']:
  file=developer.parent/name
  if not covered(file):roots.append(file)
 for row in tools.values():
  file=Path(row['path'])
  if not covered(file):roots.append(file)
 frame=module.snapshot(roots,bounds);encoded=module.encoded(frame);D.need(len(encoded)<=module.MAX_DECODED_METADATA-module.MAX_COMMAND_BYTES-65536,'Permission metadata bound');output.chmod(0o755);request=output/'permission-request.json';module.write_json(request,{'frame':frame,'controller':{'file':str(HERE/'reused_admission.py'),'sha256':module.digest((HERE/'reused_admission.py').read_bytes()),'uid':int(os.environ['CHECKTRAIL_CONTROLLER_UID'])},'identity':identity});request.chmod(0o444)
 command=['/usr/bin/sudo','-n','-u','nobody','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL=C','/usr/bin/python3','-I','-S','-B',str(HERE/'reused_admission.py'),'--inner',str(request)]
 # The inner invocation is reviewed first-party metadata code, not an SDK producer.
 observed=module.command(command,clean,receipts,timeout=min(300,bounds.deadline-bounds.clock()));value=json.loads(observed.stdout);end=module.current_endpoint(frame);D.need(value['metadataEndpointSha256']==module.digest(module.encoded(end)),'Physical frame endpoint changed');compressed=output/'selected-sdk-tool-controller-frame.json.gz'
 with compressed.open('xb') as f:
  os.fchmod(f.fileno(),0o400)
  with gzip.GzipFile(filename='',fileobj=module.LimitedCarrier(f,module.MAX_CAPTURE_BYTES),mode='wb',mtime=0) as z:z.write(encoded)
 request.unlink();output.chmod(0o700)
 return {'buildUid':account.pw_uid,'buildGid':account.pw_gid,'buildUser':'nobody','runnerUid':int(os.environ['CHECKTRAIL_CONTROLLER_UID']),'sudoDenied':True,'buildUidProcesses':active,'controllerProtected':value['controllerProtected'],'sdkAndToolsProtectedFromBuildUid':value['allSelectedEntriesReadableExecutableAndProtected'],'allDeclaredSDKToolBytesHashed':set(tools)==set(D.TOOLS),'permissionObservation':value,'permissionCommands':receipts,'selectedFrame':{'file':str(compressed),'bytes':compressed.stat().st_size,'sha256':hashlib.sha256(compressed.read_bytes()).hexdigest(),'entries':len(frame),'hashReadBytes':bounds.bytes},'permissionEndpointEqualityIsNotContinuousImmutability':True,'nativeAdmissionGranted':False,'runContext':context}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('output');a=p.parse_args();D.need(os.getuid()==0 and platform.system()=='Darwin' and platform.machine()=='arm64','Root standardDarwinARM metadata controller');D.need(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted','Actual standard hosted action required');context={k:os.environ.get(k,'') for k in ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA']};D.need(all(context.values()),'Actual fresh run context')
 def query():
  def read(argv):
   result=subprocess.run(argv,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,check=True);D.need(len(result.stdout)+len(result.stderr)<=65536,'Bounded metadata query output');return result.stdout.decode().strip()
  return {'CPUs':int(read(['/usr/sbin/sysctl','-n','hw.logicalcpu'])),'RAMBytes':int(read(['/usr/sbin/sysctl','-n','hw.memsize'])),'macOS':read(['/usr/bin/sw_vers','-productVersion'])}
 result=collect_metadata(Path(D.DEVELOPER),Path(a.output),context,query,permission_observation);out=Path(a.output)/'HOST-OBSERVATION.json';out.write_text(json.dumps(result,sort_keys=True,indent=2)+'\n');out.chmod(0o400);summary={'metadataObserved':True,'nativeAdmissionGranted':False,'actualHost':{k:result[k] for k in ['platform','arch','macOS','CPUs','RAMBytes','scratchFreeBytes','xcodeVersion','xcodeBuild','SDKVersionObservedNotHistoricalPublisherPin']},'missingTools':result['missingTools'],'originalSLA':{k:result['originalSLA'][k] for k in ['bytes','sha256']} if result['originalSLA'] else None,'permissionFrame':{k:result['selectedFrame'][k] for k in ['bytes','sha256','entries','hashReadBytes']},'permissionFailureCount':result['permissionObservation']['failureCount'],'controllerProtected':result['controllerProtected'],'SDKOrSourceExecuted':False,'SLAOriginalTextKeptOnHostOnlyNotRootReviewedOrExported':True,'nativeBuildFitMeasured':False};print(json.dumps(summary,sort_keys=True));return 0 if not result['missingTools'] and result['sdkAndToolsProtectedFromBuildUid'] and result['xcodeVersion']=='26.2' and result['originalSLA'] else 1
if __name__=='__main__':raise SystemExit(main())
