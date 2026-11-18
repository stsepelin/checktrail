"""Fixed host observer for the separately authorized original GCC main05 action.

No execution on import. The enclosing reviewed operator-only controller owns
source/image/SDK admission, actual Docker creation, retention and cache replay.
This observer never turns a wrapper/runc status into an original dpkg exit.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


h=load('gcc-hosted-carrier.py')
policy=load('gcc-main05-capacity.py')
body=load('gcc-main05-stage.py')
require=h.require
BODY=['/usr/bin/python3','-I','-B','/controller/gcc-main05-stage.py','main05']


def prestart(owner,name,identifier):
    require(re.fullmatch('checktrail-gcc-native05-[a-f0-9]{32}',name) and owner['Id']==identifier and
            owner['Config']['Labels']['io.checktrail.gcc-staged-owner']==name,'Owned fixed main05 container required')
    require(owner['Config']['Entrypoint']==['/usr/bin/env'] and
            owner['Config']['Cmd']==['-i',*[k+'='+v for k,v in body.stage.FIXED_ENVIRONMENT.items()],*BODY],
            'Actual main05 process command/environment differs')
    require(owner['State']['Status']=='created' and owner['State']['Running'] is False and owner['State']['Pid']==0,
            'Fresh unstarted main05 container required')
    host=owner['HostConfig']
    require(host['NetworkMode']=='none' and host['Privileged'] is False and host['Init'] is True and
            host['NanoCpus']==4000000000 and host['Memory']==6*h.GIB and host['PidsLimit']==1024,
            'Main05 actual process resource/lifecycle controls differ')


def observe(output,name,identifier,maximum_seconds,service_clock,*,sdk_seconds):
    require(policy.number(sdk_seconds) and 0<=sdk_seconds<=policy.SDK_MAX_SECONDS and
            policy.number(maximum_seconds) and 0<maximum_seconds<=policy.NATIVE_MAX_SECONDS-sdk_seconds-policy.OBSERVER_OVERHEAD_RESERVE_SECONDS,
            'Main05 shared SDK/original native allowance invalid')
    require(policy.number(service_clock['capturedMonotonic']) and policy.number(service_clock['remainingSeconds']) and
            0<=time.monotonic()-service_clock['capturedMonotonic']<=30 and
            0<service_clock['remainingSeconds']<=21600,'Fresh actual main05 source-job clock required')
    owner=json.loads(h.docker(['inspect',name]))[0]
    (output/'MAIN05-PRESTART-CONTAINER.json').write_bytes(body.codec.canonical(owner))
    prestart(owner,name,identifier)
    now=time.monotonic();remaining=service_clock['remainingSeconds']-(now-service_clock['capturedMonotonic'])
    require(0<=now-service_clock['capturedMonotonic']<=30 and
            remaining>=maximum_seconds+policy.FINALIZE_SECONDS+policy.CLEANUP_RESERVE_SECONDS,
            'Prestart inspection consumed promised whole-body/source-service allowance; reobserve before execution')
    started=time.monotonic();status=None;failure=None;samples=[];observed_bytes=0;next_sample=0
    process=subprocess.Popen(['/usr/bin/docker','start','--attach',name],env=h.HOST_ENV,
                             stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
    selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
    try:
        with (output/'native.log').open('xb') as log:
            while selector.get_map():
                now=time.monotonic();elapsed=now-started
                remaining=service_clock['remainingSeconds']-(now-service_clock['capturedMonotonic'])
                require(elapsed<=maximum_seconds and remaining>=policy.FINALIZE_SECONDS+policy.CLEANUP_RESERVE_SECONDS,
                        'Original main05 reached native/source-service cutoff')
                if elapsed>=next_sample:
                    sampling_seconds=min(30,maximum_seconds-elapsed,remaining-policy.FINALIZE_SECONDS-policy.CLEANUP_RESERVE_SECONDS)
                    require(sampling_seconds>0,'Main05 sampling cannot borrow the command/source-service cutoff')
                    state=h.allocated_state(output/'state',maximum_seconds=sampling_seconds);free=shutil.disk_usage(output).free
                    samples.append({**state,'elapsedSeconds':elapsed,'availableDiskBytes':free})
                    require(state['logicalBytes']<=policy.STATE_BYTES and state['allocatedBytes']<=policy.STATE_BYTES and
                            free>=policy.STATE_BYTES+policy.ARCHIVE_BYTES+8*h.GIB,
                            'Main05 complete state/archive/independent-replay capacity reached')
                    next_sample=time.monotonic()-started+30
                for key,_ in selector.select(timeout=1):
                    raw=os.read(key.fileobj.fileno(),65536)
                    if not raw:selector.unregister(key.fileobj);continue
                    observed_bytes+=len(raw);require(observed_bytes<=h.LOG_CEILING,'Complete original main05 stdout bound reached')
                    log.write(raw)
            wait_seconds=min(maximum_seconds-(time.monotonic()-started),service_clock['remainingSeconds']-
                             (time.monotonic()-service_clock['capturedMonotonic'])-policy.FINALIZE_SECONDS-policy.CLEANUP_RESERVE_SECONDS)
            require(wait_seconds>0,'Original main05 reached native/source-service cutoff')
            try:status=process.wait(timeout=wait_seconds)
            except subprocess.TimeoutExpired:raise ValueError('Original main05 reached native/source-service cutoff')
            require(time.monotonic()-started<=maximum_seconds and service_clock['remainingSeconds']-
                    (time.monotonic()-service_clock['capturedMonotonic'])>=policy.FINALIZE_SECONDS+policy.CLEANUP_RESERVE_SECONDS,
                    'Late main05 wrapper terminal cannot bypass full source-service clock')
    except BaseException as error:
        failure=error
        for chosen in ['TERM','KILL']:
            try:h.docker(['kill','--signal',chosen,name],timeout=5)
            except BaseException:pass
            if chosen=='TERM':time.sleep(1)
        try:os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        status=process.wait(timeout=5)
    finally:
        selector.close();process.stdout.close()
        (output/'resource-samples.json').write_bytes(body.codec.canonical({'samples':samples,'quotaEnforced':False,'physicalHighWaterProven':False}))
    actual=json.loads(h.docker(['inspect',name],timeout=5))[0]
    require(actual['Id']==identifier and actual['Config']['Labels']['io.checktrail.gcc-staged-owner']==name,
            'Main05 terminal ownership changed')
    state=actual['State'];quiescent=state['Running'] is False and state['Pid']==0 and state['Status']=='exited'
    terminal=None;terminal_error=None;records=output/'observations/original-commands.jsonl'
    if records.exists():
        try:terminal=body.command_terminal(records,Path('/build/source'))
        except BaseException as error:terminal_error=str(error)[:1000]
    elapsed=time.monotonic()-started
    attempt={'schemaVersion':1,'phase':'native','originalCommand':body.COMMAND,'containerId':identifier,
             'observerElapsedSeconds':elapsed,'sdkPreparationSecondsCharged':sdk_seconds,
             'maximumNativeBodyAndAttachSeconds':maximum_seconds,'originalCommandWindowPromised':False,
             'bodyWindowIncludesAttachStartupPrechecksOriginalCommandPostchecksAndReap':True,
             'originalCommandElapsedSeconds':terminal['elapsedSeconds'] if terminal else None,
             'combinedSdkAndMainObservedSeconds':sdk_seconds+elapsed,'attachExitCode':status,
             'containerState':state,'quiescenceObserved':quiescent,'originalCommandTerminalObserved':terminal is not None,
             'originalCommandExitCode':terminal['exitCode'] if terminal else None,
             'originalCommandSignal':terminal['signal'] if terminal else None,'originalCommandTerminal':terminal,
             'terminalEvidenceError':terminal_error,'cutoffOrRetentionError':str(failure)[:2000] if failure else None,
             'sourceJobSecondsRemaining':service_clock['remainingSeconds']-(time.monotonic()-service_clock['capturedMonotonic']),
             'checkpointCompleted':False,'phaseCompletionAssessed':False,'allObservedElapsedMustBeChargedOnRetry':True,
             'nativeEvidenceOriginAssessed':False,'gateAComplete':False}
    (output/'MAIN05-ATTEMPT.json').write_bytes(body.codec.canonical(attempt))
    # Keep the genuine original terminal even when the wrapper, SDK recheck or
    # retention interval failed. The caller reconciles failure/retention-failed
    # versus complete capture; this observer grants no phase advancement.
    return attempt
