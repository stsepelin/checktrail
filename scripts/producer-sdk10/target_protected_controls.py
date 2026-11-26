"""PROPOSAL: exact first-party Ubuntu26 Docker/UID/protected-copy controls only."""
import argparse
import errno
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import bundle_bytes, context, digest, encoded, freeze, hash_file, need, owned_labels, read_json, verified_bundle
from driver import Controller, HERE, NATIVE_CAP_ALIASES, manifest_check, native_identity_contract
from owned_image import cleanup_image_inputs
from producer_adapter import ProducerAPI
from producer_pause import complete_command
from target_pause_controls import prove_control_image, remove_control_volume
from protected_control_worker import CASES, child_argv

def command_ok(row):
    need(complete_command(row), 'inert-control-command-transport-incomplete')

def verify_control_inputs(pin,files):
    """Check the control pin and its rows against the bundle bytes that are published and run."""
    raw=files.get('PROTECTED-CONTROLS.json')
    need(type(raw) is bytes and digest(raw)==pin, 'exact-reviewed-controls-manifest')
    rows=json.loads(raw)['files']
    names={'protected_control_worker.py','target_protected_controls.py','test_protected_control_target.py'}
    need(type(rows) is list and len(rows)==3 and {r['path'] for r in rows}==names, 'exact-three-first-party-control-files')
    for row in rows:
        body=files.get(row['path']);need(type(body) is bytes and (len(body),digest(body))==(row['bytes'],row['sha256']), 'frozen-first-party-control-file')

def child_contract(value,binding,state):
    need(type(value) is dict and value.get('binding')==binding and value.get('originalSDKSourceSeedBuildTestsOrKeysExecuted') is False, 'fresh-exact-canary-ready-binding')
    need(all(type(value.get(k)) is int and value[k]==state[wanted] for k,wanted in [('uid','uid'),('euid','uid'),('gid','gid')]) and value.get('supplementaryGroups')==[], 'actual-nonroot-canary-identity')
    caps=value.get('capabilities')
    need(type(caps) is dict and set(caps)=={'CapEff','CapPrm','CapInh','CapAmb'} and all(type(v) is int and v==0 for v in caps.values()) and type(value.get('NoNewPrivs')) is int and value['NoNewPrivs']==1, 'actual-child-zero-caps-and-no-new-privileges')
    need(type(value.get('parentPID')) is int and value['parentPID']==1 and type(value.get('childPID')) is int and value['childPID']>1, 'actual-private-namespace-child-and-supervisor')
    need(all(type(value.get(k)) is int and value[k]==wanted for k,wanted in [('protectedOpenErrno',errno.EACCES),('rootParentSignalProbeErrno',errno.EPERM),('rootSetuidProbeErrno',errno.EPERM)]), 'actual-child-cannot-read-control-signal-root-or-regain-root')
    return value

def ready(c, api, case, binding, deadline):
    last=None
    for ordinal in range(1,81):
        need(time.monotonic()<deadline, 'finite-ready-deadline')
        current=api.inspect_id(api.binding['id'],deadline)
        need(current is not None, 'exact-inert-producer-before-ready')
        destination=c.root/'evidence'/('READY-'+str(ordinal)+'.json')
        row,_=c.docker(['cp',api.binding['id']+':/work/control-reports/'+case+'/READY.json',str(destination)],seconds=min(2,max(.001,deadline-time.monotonic())),check=False)
        need(row.get('reason') is None, 'ready-transport-unknown-is-not-pending')
        if row['exitCode']==0:
            physical=destination.lstat();need(stat.S_ISREG(physical.st_mode) and physical.st_size<=8192 and physical.st_uid==os.geteuid(), 'physical-bounded-first-party-ready-copy')
            last=child_contract(read_json(destination,8192),binding,c.state)
            if CASES[case][1] is None:
                current=api.inspect_id(api.binding['id'],deadline)
                need(current is not None and current['State']['Running'] is True, 'fresh-exact-waiting-producer-running-before-stop')
            need(time.monotonic()<deadline, 'ready-readback-completion-deadline')
            return last
        need(row['exitCode']==1, 'only-exact-copy-not-ready-exit-is-pending')
        time.sleep(min(.1,max(0,deadline-time.monotonic())))
    raise RuntimeError('finite-ready-attempts-exhausted')

def stopped(api, deadline):
    for ordinal in range(1,81):
        need(time.monotonic()<deadline, 'finite-stopped-deadline')
        obj=api.inspect_id(api.binding['id'],deadline)
        need(obj is not None, 'inert-producer-retained-before-preservation')
        if obj['State']['Running'] is False and obj['State']['Paused'] is False:return obj
        time.sleep(min(.1,max(0,deadline-time.monotonic())))
    raise RuntimeError('finite-stopped-attempts-exhausted')

def canary(c, case, deadline):
    phase,natural=CASES[case];role='build' if phase=='build' else 'tests';name=c.state['prefix']+'-original-'+role
    c.helper('prepare-'+case,['/observer/protected_control_worker.py','prepare','--case',case,'--uid',str(c.state['uid']),'--gid',str(c.state['gid'])],deadline)
    need(c.inspect('container',name) is None, 'fresh-protected-canary-container')
    c.state['containers'].append(name);c.save();protected=c.root/'protected'/name;protected.mkdir(mode=0o700)
    binding={'context':c.ctx,'case':case,'syntheticControlOnly':True,'originalSDKCommandStarted':False,'phase':phase,'profileSHA256':digest(bundle_bytes(HERE/'profile.json')),'supervisorSHA256':digest(bundle_bytes(HERE/'native_entry.py'))}
    argv=child_argv(case,binding,deadline)
    wrapped=c.observer_entry(['/observer/protected_control_worker.py','supervisor','--case',case,'--binding-json',json.dumps(binding,sort_keys=True),'--deadline',str(deadline),'--uid',str(c.state['uid']),'--gid',str(c.state['gid'])])
    args=c.container_args(name,wrapped)
    if case=='denied-kill-tests':
        # Deliberate negative admission, only for this inert first-party case.
        index=next(i for i in range(len(args)-1) if args[i:i+2]==['--cap-add','KILL']);del args[index:index+2]
    obj=c.create_owned(name,args,seconds=15);captured=ProducerAPI.register(c,name,obj,binding,argv);api=ProducerAPI(c,name)
    c.validate_container(obj,name,wrapped)
    if case=='denied-kill-tests':
        caps=obj['HostConfig'].get('CapAdd')
        need(type(caps) is list and len(caps)==3 and all(x in NATIVE_CAP_ALIASES for x in caps) and {NATIVE_CAP_ALIASES[x] for x in caps}=={'CHOWN','SETUID','SETGID'}, 'exact-inert-negative-missing-kill-contract')
    else:native_identity_contract(obj)
    row,_=c.docker(['start',captured['id']],seconds=10,check=False);command_ok(row)
    child=ready(c,api,case,binding,min(deadline,time.monotonic()+12))
    metadata=protected.lstat()
    need(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid==0 and metadata.st_gid==0 and stat.S_IMODE(metadata.st_mode)==0o700, 'actual-root0700-protected-bind')
    denied=None
    try:(protected/'START.json').lstat()
    except PermissionError as error:denied=error.errno
    need(denied==errno.EACCES, 'actual-host-runner-protected-child-traversal-denied')
    stop_row=None
    if natural is None:
        stop_row,_=c.docker(['stop','--time','10',captured['id']],seconds=15,check=False);command_ok(stop_row)
    terminal=stopped(api,min(deadline,time.monotonic()+10))
    need(api.preserve_protected_metadata(captured,min(deadline,time.monotonic()+15)), 'actual-daemon-copy-first-preservation')
    folders=list((c.root/'evidence').glob('*-PRESERVED-*'))
    need(len(folders)==1, 'fresh-single-preservation-before-readback')
    start=read_json(folders[0]/'protected/START.json',65536);result=read_json(folders[0]/'protected/RESULT.json',65536)
    need(start.get('originalChildPID')==child['childPID'] and result.get('originalChildPID')==child['childPID'] and result.get('originalCommandStarted') is True, 'real-first-party-child-admission-bound-to-protected-pair')
    need(result.get('binding')==binding and result.get('originalArgv')==argv and terminal['State'].get('ExitCode')==result.get('supervisorExitCode'), 'actual-protected-canary-result-and-container-exit')
    if natural is not None:
        need(type(result.get('originalExitCode')) is int and result['originalExitCode']==natural and type(result.get('supervisorExitCode')) is int and result['supervisorExitCode']==natural and result.get('ownChildReaped') is True and result.get('supervisorSignalAttempted') is False and result.get('timedOut') is False and result.get('interrupted') is False, 'natural-child-and-wrapper-exits-observed-without-forced-stop')
    elif case=='interrupt-build':
        need(result.get('originalExitCode')==-9 and result.get('supervisorExitCode')==130 and result.get('ownChildReaped') is True and result.get('supervisorSignalSent') is True and result.get('interrupted') is True and result.get('cleanupSignalErrorType') is None and result.get('cleanupWaitErrorType') is None, 'actual-cross-UID-supervisor-kill-and-child-reaping')
    else:
        need(result.get('originalExitCode') is None and result.get('ownChildReaped') is False and result.get('supervisorSignalSent') is False and result.get('supervisorExitCode')==130 and result.get('cleanupSignalErrorType')=='PermissionError' and result.get('cleanupWaitErrorType')=='TimeoutExpired', 'actual-missing-kill-refusal-retained-without-fake-zero-or-reaping')
    c.observer()  # The canary ran from this snapshot; a changed one fails the case.
    summary={'case':case,'passed':True,'hostProtectedTraversalErrno':denied,'protectedRootUID':metadata.st_uid,'protectedRootMode':stat.S_IMODE(metadata.st_mode),'childUID':child['uid'],'childCapabilities':child['capabilities'],'childNoNewPrivs':child['NoNewPrivs'],'childCannotReadRootControlOrSignalOrSetuidRoot':True,'originalCanaryChildExit':result.get('originalExitCode'),'canarySupervisorExit':result.get('supervisorExitCode'),'canaryOwnChildReaped':result.get('ownChildReaped'),'canaryCleanupSignalErrorType':result.get('cleanupSignalErrorType'),'canaryCleanupWaitErrorType':result.get('cleanupWaitErrorType'),'daemonCopyBeforeHostChildInspection':True,'durableProtectedMembers':sorted(api.preservation['members']),'originalSDKStartExitOrGateACredit':False}
    c.stop_owned(name)
    need(api.inspect_id(captured['id'],min(deadline,time.monotonic()+5)) is None, 'exact-owned-canary-final-absence')
    return summary

def run(root,nonce,pin,control_pin):
    profile=manifest_check(pin);verify_control_inputs(control_pin,verified_bundle().files)
    need(sys.platform=='linux' and os.environ.get('RUNNER_OS')=='Linux' and os.environ.get('RUNNER_ARCH')=='X64' and platform.machine()=='x86_64', 'standard-Ubuntu26-X64-only')
    need(os.environ.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and os.environ.get('GITHUB_REPOSITORY')==profile['repository'] and os.environ.get('GITHUB_RUN_ATTEMPT')=='1', 'single-owned-first-party-manual-controls')
    need(os.geteuid()!=0 and os.getuid()==os.geteuid(), 'actual-host-nonroot-runner-for-DAC-negative')
    ctx=context(nonce);need(not root.exists(), 'fresh-protected-controls-root');root.mkdir(mode=0o700)
    for name in ['control','protected','evidence','inputs','cases']:(root/name).mkdir(mode=0o700)
    started=time.monotonic();body_end=started+300;end=started+480
    parent=Controller(root,ctx,profile);prefix='ct-sdk10-'+str(ctx['run'])+'-'+nonce
    parent.state={'prefix':prefix,'uid':os.getuid(),'gid':os.getgid(),'containers':[],'volume':prefix+'-work','tempVolume':prefix+'-tmp','imageAlias':'checktrail-sdk10-controls-owned:'+str(ctx['run'])+'-'+nonce,'imageAliasCreated':False,'preparationDeadline':body_end,'phaseDeadline':body_end,'nativeDeadline':body_end,'cleanupDeadline':end}
    parent.save();controllers=[];volumes=[];cases=[];observations={};failure=None;cleanup=[];stage='actual-host-admission'
    try:
        parent.publish_observer()
        raw=Path('/etc/os-release').read_bytes();need(len(raw)<=4096, 'bounded-actual-OS-metadata')
        fields=dict(line.split('=',1) for line in raw.decode().splitlines() if '=' in line)
        need(fields.get('ID','').strip(chr(34))=='ubuntu' and fields.get('VERSION_ID','').strip(chr(34))=='26.04', 'actual-Ubuntu26-target')
        observations['freeBytesBeforeImage']=shutil.disk_usage(root).free
        row,path=parent.docker(['info','--format','{{json .DockerRootDir}} {{json .Architecture}} {{json .NCPU}} {{json .MemTotal}}'],seconds=10,check=False);command_ok(row)
        raw=path.read_text().strip();decoder=json.JSONDecoder();items=[]
        while raw:
            value,n=decoder.raw_decode(raw);items.append(value);need(len(items)<=4,'finite-Docker-capacity-fields');raw=raw[n:].lstrip()
        need(len(items)==4,'complete-Docker-capacity-fields');docker_root,arch,cpus,memory=items
        need(type(docker_root) is str and os.stat(docker_root).st_dev==os.stat(root).st_dev, 'actual-Docker-and-capture-same-physical-filesystem')
        need(arch in ['amd64','x86_64'] and type(cpus) is int and cpus>=profile['limits']['minCPUs'] and type(memory) is int and memory>=profile['limits']['minHostMemory'],'actual-selected-image-and-supervisor-capacity')
        observations.update(dockerCPUs=cpus,dockerMemoryBytes=memory)
        observations['dockerAndCaptureSameFilesystem']=True
        stage='physical-selected-image-proof'
        observations.update(prove_control_image(parent,body_end))
        observations['freeBytesAfterPhysicalImageProof']=shutil.disk_usage(root).free
        observations['noWholeNativeOrContinuousDiskQuotaCredit']=True
        labels=[part for k,v in owned_labels(ctx).items() for part in ['--label',k+'='+v]]
        stage='fresh-inert-volume-create'
        for volume in [parent.state['volume'],parent.state['tempVolume']]:
            need(parent.inspect('volume',volume) is None, 'new-owned-inert-volume');volumes.append(volume)
            parent.docker(['volume','create',*labels,volume]);parent.volume_owned(volume)
        for case in CASES:
            stage='first-party-case:'+case
            need(time.monotonic()<body_end-30, 'canary-body-deadline-retains-cleanup-reserve')
            folder=root/'cases'/case;folder.mkdir(mode=0o700)
            for name in ['control','protected','evidence','inputs']:(folder/name).mkdir(mode=0o700)
            c=Controller(folder,ctx,profile);c.state={**parent.state,'prefix':prefix+'-'+case,'containers':[],'phaseDeadline':body_end};c.save();controllers.append(c)
            cases.append(canary(c,case,min(body_end,time.monotonic()+40)))
    except BaseException as error:failure={'type':type(error).__name__,'stage':stage,'errno':error.errno if isinstance(error,OSError) and type(error.errno) is int else None}
    finally:
        for c in controllers:
            c.state['phaseDeadline']=end
            for name in c.state['containers']:
                try:c.stop_owned(name)
                except BaseException as error:cleanup.append({'kind':'canary-container','errorType':type(error).__name__})
        parent.state['phaseDeadline']=end
        for volume in volumes:
            try:need(remove_control_volume(parent,volume,end), 'positive-owned-inert-volume-absence')
            except BaseException as error:cleanup.append({'kind':'canary-volume','errorType':type(error).__name__})
        if (root/'control/IMAGE-INPUT-OWNERSHIP.json').is_file():
            try:cleanup_image_inputs(parent,end)
            except BaseException as error:cleanup.append({'kind':'owned-image-inputs','errorType':type(error).__name__})
        observations['freeBytesAfterOwnedCleanup']=shutil.disk_usage(root).free
        complete=failure is None and not cleanup and len(cases)==len(CASES) and time.monotonic()<end
        result={'schemaVersion':1,'kind':'sdk10-owned-protected-controls-v1','context':ctx,'manifestSHA256':pin,'controlManifestSHA256':control_pin,'complete':complete,'failureType':failure,'cases':cases,'observations':observations,'cleanupErrors':cleanup,'elapsedSeconds':time.monotonic()-started,'controlsBodySecondsMaximum':300,'wholeSecondsMaximum':480,'firstPartyControlsOnly':True,'originalSDKSourceSeedBuildTestsKeysACKOrCaptureExportExecuted':False,'originalSDKBuildTestQuotaOrGateACredit':False}
        need(len(encoded(result))<=65536, 'bounded-first-party-only-RESULT-artifact');freeze(root/'RESULT.json',encoded(result));print(json.dumps(result,sort_keys=True),flush=True)
    return 0 if complete else 1

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--nonce',required=True);p.add_argument('--manifest-sha256',required=True);p.add_argument('--control-manifest-sha256',required=True);a=p.parse_args()
    raise SystemExit(run(Path(os.environ['RUNNER_TEMP'])/('ct-sdk10-protected-controls-'+a.nonce),a.nonce,a.manifest_sha256,a.control_manifest_sha256))
