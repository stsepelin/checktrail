"""Reconcile a future owned host observer's physical command records as data.

No Docker, SDK, original command, service call or execution trust is provided.
The actual host loop/constructor and each phase's resource fit remain unqualified.
The observation includes startup, evidence reads and reap time in the one charge;
an observed original zero survives a late clock/evidence/family refusal.
"""
import importlib.util
from pathlib import Path
import re
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


host=load('gcc-staged-host-contract.py')
family=host.family
codec=host.codec
require=codec.require
BODY=['/usr/bin/python3','-I','-B','/controller/gcc-staged-selected-body.py','selected-original-phase']


def prestart(context,owner,name,identifier):
    """Inspect a future generic constructor; this does not create/start it."""
    contract=host.verify(context)
    require(re.fullmatch('checktrail-gcc-staged-[a-f0-9]{32}',name) is not None and
            owner['Id']==identifier and owner['Config']['Labels']['io.checktrail.gcc-staged-owner']==name,
            'Exact owned finite original-phase container required')
    require(owner['Config']['Entrypoint']==['/usr/bin/env'] and
            owner['Config']['Cmd']==['-i',*[key+'='+value for key,value in host.body.legacy.stage.FIXED_ENVIRONMENT.items()],*BODY],
            'Generic original phase body/environment differs')
    state=owner['State'];controls=owner['HostConfig']
    require(state['Status']=='created' and state['Running'] is False and type(state['Pid']) is int and state['Pid']==0,
            'Fresh unstarted original phase container required')
    require(controls['NetworkMode']=='none' and controls['Privileged'] is False and controls['Init'] is True and
            type(controls['NanoCpus']) is int and controls['NanoCpus']==4000000000 and
            type(controls['Memory']) is int and controls['Memory']==6*1024**3 and
            type(controls['PidsLimit']) is int and controls['PidsLimit']==1024,
            'Actual original phase process limits differ')
    return {'phase':contract['phase'],'constructorInspectedOnly':True,'nativeCapacityQualified':False,
            'operatorExecutionTrustGranted':False,'gateAComplete':False}


def reconcile(frame,context,*,name,identifier,container,attach_exit_code,sdk_seconds,
              observer_started_monotonic,service_clock,maximum_body_seconds,cutoff_error=None):
    """Read original terminal before recording late failures; never infer it from attach."""
    contract=host.verify(context);frame=codec.physical(Path(frame));now=time.monotonic()
    require(family.finite(sdk_seconds) and family.finite(observer_started_monotonic) and observer_started_monotonic<=now and
            family.finite(maximum_body_seconds) and 0<maximum_body_seconds<=min(
                14400-sdk_seconds-180,43200-contract['allAttemptNativeSecondsAlreadyCharged']-sdk_seconds-180) and
            family.finite(service_clock['capturedMonotonic']) and family.finite(service_clock['remainingSeconds']) and
            0<=observer_started_monotonic-service_clock['capturedMonotonic']<=30 and
            0<service_clock['remainingSeconds']<=21600,'Exact source service/SDK/observer clock envelope required')
    require(re.fullmatch('checktrail-gcc-staged-[a-f0-9]{32}',name) is not None and container['Id']==identifier and
            container['Config']['Labels']['io.checktrail.gcc-staged-owner']==name,
            'Terminal container ownership changed')
    require(attach_exit_code is None or type(attach_exit_code) is int,'Typed actual attach status required')
    state=container['State']
    require(type(state['Running']) is bool and type(state['Pid']) is int and state['Pid']>=0 and
            type(state['OOMKilled']) is bool and type(state['ExitCode']) is int,
            'Typed actual terminal container state required')
    terminal=None;terminal_error=None
    try:terminal=host.body.terminal(frame/'observations/original-commands.jsonl',Path('/build/source'),contract)
    except BaseException as error:terminal_error=str(error)[:1000]
    finished=time.monotonic();elapsed=finished-observer_started_monotonic
    require(family.finite(elapsed),'Monotonic original observer interval required')
    remaining=service_clock['remainingSeconds']-(finished-service_clock['capturedMonotonic'])
    failures=[] if cutoff_error is None else [str(cutoff_error)[:1000]]
    if elapsed>maximum_body_seconds:failures.append('Original phase observer/body window exceeded')
    if remaining<7260:failures.append('Whole source service finalization/cleanup reserve reached')
    if terminal is not None and terminal['elapsedSeconds']>elapsed:
        terminal_error='Original terminal duration exceeds the full observed interval';terminal=None
    return {'schemaVersion':1,'phase':contract['phase'],'originalCommand':contract['command'],
            'containerId':identifier,'observerElapsedSeconds':elapsed,'sdkPreparationSecondsCharged':sdk_seconds,
            'combinedSdkAndPhaseObservedSeconds':sdk_seconds+elapsed,'attachExitCode':attach_exit_code,
            'containerState':state,'quiescenceObserved':state['Running'] is False and state['Pid']==0 and state['Status']=='exited',
            'originalCommandTerminalObserved':terminal is not None,'originalCommandTerminal':terminal,
            'originalCommandExitCode':terminal['exitCode'] if terminal else None,
            'originalCommandSignal':terminal['signal'] if terminal else None,
            'terminalEvidenceError':terminal_error,'cutoffOrRetentionError':'; '.join(failures) if failures else None,
            'sourceJobSecondsRemaining':remaining,'observerFinalizedMonotonic':finished,
            'fullStartupEvidenceAndReapIntervalCharged':True,'checkpointCompleted':False,
            'phaseCompletionAssessed':False,'nativeEvidenceOriginAssessed':False,
            'operatorExecutionTrustGranted':False,'gateAComplete':False}
