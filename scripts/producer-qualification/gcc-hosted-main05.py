"""One operator-authorized original GCC main05 continuation on stock Ubuntu26.

This fixed carrier never selects another phase or changes original producer
features. Local capture stays provisional until the workflow's one exact-key
cache save and independent service restore/replay have been authenticated.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


start=load('gcc-main05-start.py')
observer=start.observer
retain=load('gcc-main05-retain.py')
service=start.service
transport=load('gcc-main05-transport.py')
exporter=load('gcc-main05-export.py')
ledger_builder=start.attempt_ledger
h=start.h
codec=start.codec
require=h.require


def observation_after_error(runtime,elapsed,error):
    frame=runtime['nativeFrame'];path=frame/'MAIN05-ATTEMPT.json';receipt=None;receipt_error=None
    sdk=runtime['sdkPreparationSecondsCharged']
    require(ledger_builder.finite(elapsed),'Actual original observer failure time required')
    if os.path.lexists(path):
        try:
            h.digest_file(path,maximum=256*1024);candidate=json.loads(path.read_bytes())
            require(candidate['containerId']==runtime['containerId'] and candidate['sdkPreparationSecondsCharged']==sdk and
                    ledger_builder.finite(candidate['observerElapsedSeconds']) and candidate['observerElapsedSeconds']<=elapsed,
                    'Observer receipt belongs to another attempt or time interval')
            ledger_builder.base_row(runtime['ledger'],runtime['configuration'],candidate);receipt=candidate
        except BaseException as caught:receipt_error=str(caught)[:1000]
    # Even a valid earlier receipt cannot undercharge later observer failure.
    # A missing, partial, stale or wrapper-only receipt never supplies dpkg exit.
    terminal=receipt['originalCommandTerminal'] if receipt else None;terminal_error=None
    try:
        actual=observer.body.command_terminal(frame/'observations/original-commands.jsonl',Path('/build/source'))
        require(terminal is None or terminal==actual,'Original terminal differs from the current observer receipt')
        terminal=actual
    except BaseException as caught:
        terminal_error=str(caught)[:1000]
        if os.path.lexists(frame/'observations/original-commands.jsonl'):terminal=None
    if terminal is not None and not (ledger_builder.finite(terminal['elapsedSeconds']) and terminal['elapsedSeconds']<=elapsed):
        terminal_error='Original terminal exceeds the actual observer failure interval';terminal=None
    observation={'schemaVersion':1,'phase':'native','originalCommand':observer.body.COMMAND,'containerId':runtime['containerId'],
       'observerElapsedSeconds':elapsed,'sdkPreparationSecondsCharged':sdk,'combinedSdkAndMainObservedSeconds':sdk+elapsed,
       'originalCommandTerminalObserved':terminal is not None,'originalCommandExitCode':terminal['exitCode'] if terminal else None,
       'originalCommandSignal':terminal['signal'] if terminal else None,'originalCommandTerminal':terminal,
       'quiescenceObserved':False,'cutoffOrRetentionError':str(error)[:2000],'terminalEvidenceError':terminal_error,
       'priorObserverReceiptError':receipt_error,'priorObserverReceiptValidated':receipt is not None,
       'attachExitCode':None,'containerState':None,'nativeEvidenceOriginAssessed':False,'checkpointCompleted':False,
       'phaseCompletionAssessed':False,'gateAComplete':False}
    ledger_builder.base_row(runtime['ledger'],runtime['configuration'],observation)
    (frame/'MAIN05-OBSERVER-ERROR.json').write_bytes(codec.canonical(observation));return observation


def fail_ledger(runtime,observation,error,stage):
    frame=runtime['nativeFrame'];path=frame/'FAILED-PHASE-LEDGER.json'
    if path.exists():return json.loads(path.read_bytes())
    failed=ledger_builder.failed(runtime['ledger'],runtime['configuration'],observation,error,retention_stage=stage)
    path.write_bytes(ledger_builder.planner.canonical(failed));return failed


def capture(repository,inputs,output):
    runtime=None;observation=None;native_cleanup=None;image_cleanup=None;failure_stage='capture'
    result={'schemaVersion':1,'state':'native05-carrier-incomplete','localCheckpointCapturedAndPhysicallyRestored':False,'originalGccTargetInvoked':False,
            'originalUninterruptedDpkgCommandCompleted':False,'fullCompilerSdkBootstrapClosureVerified':False,
            'allSelectedOriginalPhasesCompleted':False,'cacheSaveCompleted':False,'cacheRestoreReplayQualified':False,
            'localLedgerIsProvisionalUntilServiceReplay':True,'gateAComplete':False}
    try:
        runtime=start.create_runtime(repository,inputs,output)
        frame=runtime['nativeFrame'];started=time.monotonic()
        result.update(nativeBodyStartRequested=True,originalGccTargetInvoked=None)
        try:
            observation=observer.observe(frame,runtime['name'],runtime['containerId'],
                runtime['admitted']['maximumNativeBodyAndAttachSeconds'],runtime['service']['clock'],
                sdk_seconds=runtime['sdkPreparationSecondsCharged'])
        except BaseException as error:
            observation=observation_after_error(runtime,time.monotonic()-started,error);raise
        result['originalGccTargetInvoked']=True if observation['originalCommandTerminalObserved'] else None
        # Close only the exact owned native family and derived SDK tag BEFORE
        # the whole-state snapshot. This also releases the local SDK image's
        # physical space without deleting the original pinned base image.
        failure_stage='cleanup';native_cleanup=start.cleanup_native(frame)
        image_cleanup=start.image.cleanup_owned(runtime['sdkFrame'])
        require(native_cleanup['ownedNativeCleanupComplete'] is True and image_cleanup['ownedImageCleanupComplete'] is True,
                'Owned runtime/image cleanup is incomplete')
        if native_cleanup.get('quiescenceAfterOwnedRemovalObserved') is True:
            observation={**observation,'quiescenceObserved':True,'quiescenceWasConfirmedByOwnedCleanup':True}
        stage_record=json.loads((frame/'observations/MAIN05-STAGE.json').read_bytes())
        failure_stage='capture'
        captured=retain.capture(frame,runtime['sdkFrame'],runtime['root'],runtime['ledger'],runtime['configuration'],
                                observation,stage_record,native_cleanup,
                                deadline=runtime['service']['clock']['capturedMonotonic']+runtime['service']['clock']['remainingSeconds']-service.policy.POST_CAPTURE_SECONDS)
        result.update(localCheckpointCapturedAndPhysicallyRestored=True,retained=captured)
        controls=json.loads((output/'NATIVE-PREPARED.json').read_bytes())['controls']
        root={'binding':captured['binding'],'archiveSha256':captured['checkpoint']['archiveSha256'],
              'archiveBytes':captured['checkpoint']['archiveBytes'],'manifestSha256':captured['checkpoint']['manifestSha256'],
              'mounts':{'/build':'.',**{target:relative for relative,target in h.MUTABLE_MOUNTS.items()}},
              'externalSdkSha256':runtime['root']['externalSdkSha256'],
              'externalSdkIdentityIsOriginalSoftwareBaseline':True,'sdkGeneratedStateContract':start.handoff.d.POLICY,
              'preparedSdkMetadataRetainedInsideCheckpoint':True,'wholeRootIdentityClaimed':False,
              'externalSdkReconstructionQualified':True,'controls':controls,'operatorNative05Policy':runtime['admitted'],
              'sourceServiceContext':runtime['resources']['context'],'sourceJobId':runtime['service']['clock']['jobId'],
              'immutableOriginalInputsRequireExactCatalogReacquisition':True,
              'originalUninterruptedDpkgCommandCompleted':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
        (frame/'CHECKPOINT-ROOT.json').write_bytes(codec.canonical(root))
        failure_stage='transport-admission'
        fresh=service.capture_service(runtime['api'],runtime['resources']['context'])
        envelope=service.measure_envelope({name:(frame/name).read_bytes() for name in ['CHECKPOINT-ROOT.json','PHASE-LEDGER.json']}
                                        |{'receipt.json':(frame/'checkpoint/receipt.json').read_bytes()})
        upload=service.admit_measured_save(fresh,captured['checkpoint']['archiveBytes'],envelope['envelopeLogicalBytesMeasured'])
        prepared_transport=transport.prepare(frame,service,runtime['resources']['context'],os.environ,codec)
        result.update(state='original-main05-checkpoint-captured-restored-and-transport-prepared',localCheckpointCapturedAndPhysicallyRestored=True,
                      originalMain05ZeroTerminalObserved=True,observed=observation,retained=captured,
                      ownedNativeCleanup=native_cleanup,ownedSdkImageCleanup=image_cleanup,
                      uploadAdmission=upload,transport=prepared_transport)
        return result
    except BaseException as error:
        result.update(state='native05-failed-or-incomplete',error=str(error)[:2000],phaseAdvanced=False)
        if runtime is not None:
            frame=runtime['nativeFrame']
            if native_cleanup is None:
                try:native_cleanup=start.cleanup_native(frame)
                except BaseException as cleanup_error:result['nativeCleanupError']=str(cleanup_error)[:1000]
            if image_cleanup is None:
                try:image_cleanup=start.image.cleanup_owned(runtime['sdkFrame'])
                except BaseException as cleanup_error:result['imageCleanupError']=str(cleanup_error)[:1000]
            if observation is not None:
                result['originalGccTargetInvoked']=True if observation['originalCommandTerminalObserved'] else None
                if native_cleanup and native_cleanup.get('quiescenceAfterOwnedRemovalObserved') is True:
                    observation={**observation,'quiescenceObserved':True,'quiescenceWasConfirmedByOwnedCleanup':True}
                try:result['failedPhaseLedger']=fail_ledger(runtime,observation,error,failure_stage)
                except BaseException as ledger_error:result['failedLedgerEvidenceError']=str(ledger_error)[:1000]
            result.update(observed=observation,ownedNativeCleanup=native_cleanup,ownedSdkImageCleanup=image_cleanup)
        raise
    finally:
        if output.is_dir():(output/'CARRIER.json').write_bytes(codec.canonical(result))


def post_capture(mode,repository,output):
    frame=output/'native-frame';selected=service.context()
    h.verify_repository(repository,selected)
    result=json.loads((output/'CARRIER.json').read_bytes())
    require(result['state']=='original-main05-checkpoint-captured-restored-and-transport-prepared' and
            result['localCheckpointCapturedAndPhysicallyRestored'] is True and result['localLedgerIsProvisionalUntilServiceReplay'] is True,
            'Original complete provisional native transport preparation required before post-capture operations')
    try:
        if mode=='prepare-restore':return transport.prepare_restore(frame,selected,service,codec,os.environ)
        api=service.GitHub(os.environ.get('CHECKTRAIL_GITHUB_JOB_TOKEN'),frame)
        if mode=='pre-save':
            expected=transport.expected_record(frame,selected,service)
            fresh=service.capture_service(api,selected)
            return service.admit_measured_save(fresh,expected['archive']['bytes'],expected['envelope']['envelopeLogicalBytesMeasured'])
        require(mode=='verify-restore','Unknown fixed native05 post-capture mode')
        replay=transport.verify(frame,selected,service,codec,ledger_builder.planner,api,os.environ)
        result.update(state='original-main05-source-cache-physically-replayed',cacheSaveCompleted=True,cacheRestoreReplayQualified=True,
                      localLedgerIsProvisionalUntilServiceReplay=False,transportReplay=replay)
        (output/'CARRIER.json').write_bytes(codec.canonical(result));return replay
    except BaseException as error:
        result.update(state='native05-service-retention-incomplete',serviceFailure={'mode':mode,'error':str(error)[:2000]},
                      cacheSaveCompleted=False,cacheRestoreReplayQualified=False,localLedgerIsProvisionalUntilServiceReplay=True)
        try:
            old=json.loads((frame/'controls/EXPECTED-PHASE-LEDGER.json').read_bytes())
            configuration=ledger_builder.planner.read_configuration(frame/'state/__carrier_work/gcc-staged-configuration',frame/'state/source')
            failed=ledger_builder.failed(old,configuration,result['observed'],error,retention_stage='transport')
            (frame/'FAILED-PHASE-LEDGER.json').write_bytes(ledger_builder.planner.canonical(failed));result['failedPhaseLedger']=failed
        except BaseException as ledger_error:result['failedLedgerEvidenceError']=str(ledger_error)[:1000]
        (output/'CARRIER.json').write_bytes(codec.canonical(result));raise


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repository',required=True);parser.add_argument('--inputs',required=True)
    parser.add_argument('--output',required=True);parser.add_argument('--mode',choices=['capture','pre-save','prepare-restore','verify-restore','export-diagnostics','preflight-history'],default='capture')
    parser.add_argument('--operator-trust-execution',action='store_true');args=parser.parse_args()
    require(args.mode!='capture' or args.operator_trust_execution,'Operator-level original SDK/source execution trust required')
    require(os.getuid()==0,'Host root required for complete original source ownership')
    repository=h.physical(Path(args.repository));output=Path(args.output)
    require(output==Path(os.environ['RUNNER_TEMP']).resolve()/'gcc-main05','Exact owned original native05 frame required')
    if args.mode=='preflight-history':
        selected=service.context();h.verify_repository(repository,selected)
        require(selected['GITHUB_RUN_ATTEMPT']=='1','A rerun requires independently frozen complete native attempt history and a new reviewed action')
        record=start.operator_history.inspect()
        target=Path(os.environ['RUNNER_TEMP']).resolve()/'gcc-main05-operator-history.json'
        require(not target.exists() and not target.is_symlink(),'Fresh operator history preflight receipt required')
        target.write_bytes(codec.canonical(record));return record
    if args.mode=='export-diagnostics':return exporter.export(h.physical(output))
    if args.mode=='capture':capture(repository,h.physical(Path(args.inputs)),output)
    else:post_capture(args.mode,repository,h.physical(output))


if __name__=='__main__':main()
