"""Complete physical local capture/replay for a source-pinned remaining phase.

This data-only bridge has no SDK/cache constructor, hosted capacity admission,
service publication, execution trust or native activation. Local success stays
provisional. One atomic directory publishes the already validated local results;
no completed ledger is exposed before every local artifact is ready.
"""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


host=load('gcc-staged-host-contract.py')
family=host.family
planner=host.planner
codec=host.codec
legacy=load('gcc-main05-retain.py')
h=legacy.h
require=codec.require
GIB=1024**3


def remaining(deadline,maximum):
    value=deadline-time.monotonic();require(value>0,'Original phase local retention deadline reached')
    return min(maximum,value)


def publish(directory,files,deadline):
    """Validate every target before exposing any ledger; stage and rename as one."""
    require(not directory.exists() and not directory.is_symlink(),'Fresh local result publication required')
    bodies={name:codec.canonical(value) for name,value in files.items()}
    require(set(bodies)<= {'PHASE-LEDGER.json','LOCAL-RESULT.json','FAILED-PHASE-LEDGER.json','FAILURE.json'} and bodies,
            'Finite local result files only')
    staging=Path(tempfile.mkdtemp(prefix='.phase-result-',dir=directory.parent))
    try:
        for name,raw in bodies.items():
            remaining(deadline,60)
            with (staging/name).open('xb') as output:output.write(raw)
        require(all((staging/name).read_bytes()==raw for name,raw in bodies.items()),'Staged local result readback differs')
        remaining(deadline,60);codec.rename_no_replace(staging,directory)
    finally:
        if staging.exists():shutil.rmtree(staging)


def preserve(frame,sdk_frame,contract,deadline):
    """Retain every prior evidence tree; each original attempt owns a fresh namespace."""
    work=codec.physical(frame/'state/__carrier_work')
    namespace='phase-'+str(contract['sequence'])+'-'+contract['phase']+'-attempt-'+str(contract['attempt'])+'-carrier-evidence'
    destination=work/namespace
    require(not destination.exists() and not destination.is_symlink(),'Fresh full-history phase evidence required')
    files={'phase-native.log':frame/'native.log','sdk-native.log':sdk_frame/'native.log',
           'phase-resource-samples.json':frame/'resource-samples.json','sdk-resource-samples.json':sdk_frame/'resource-samples.json',
           'PHASE-ATTEMPT.json':frame/'PHASE-ATTEMPT.json','SDK-ATTEMPT.json':sdk_frame/'ATTEMPT.json'}
    pins={name:h.digest_file(path,maximum=512*1024**2 if name.endswith('.log') else 1024**2) for name,path in files.items()}
    trees={'phase-observations':frame/'observations','sdk-observations':sdk_frame/'observations',
           'prepared-sdk':frame/'controls/prepared-sdk'}
    bounded=legacy.EvidenceCodec(deadline)
    for path in trees.values():codec.snapshot(path,bounded.Budget({'treeBytes':128*1024**2,'memberBytes':32*1024**2,'entries':1000,'seconds':120}))
    staging=Path(tempfile.mkdtemp(prefix='.phase-evidence-',dir=work))
    try:
        for name,path in files.items():remaining(deadline,60);h.copy_pinned(path,staging/name,pins[name])
        proofs={}
        for name,path in trees.items():
            target=staging/name;target.mkdir(mode=0o700);proofs[name]=legacy.material.clone_scratch(path,target,bounded)
        result={'directory':'__carrier_work/'+namespace,'files':pins,'completeMetadataTrees':proofs,
                'originalSdkAndPhaseStdoutRetainedCompletely':True,'historicalCacheBodyEqualityClaimed':False}
        (staging/'EVIDENCE-INVENTORY.json').write_bytes(codec.canonical(result))
        remaining(deadline,60);codec.rename_no_replace(staging,destination)
        return result
    finally:
        if staging.exists():shutil.rmtree(staging)


def capture(frame,sdk_frame,context,observation,stage_record,cleanup,*,limits,deadline):
    """Physically capture/replay complete state, then expose only a provisional ledger."""
    frame=codec.physical(Path(frame));sdk_frame=codec.physical(Path(sdk_frame));contract=host.verify(context)
    configuration=context['configuration'];ledger=context['phaseLedger'];root=context['predecessorRoot']
    caps=legacy.policy.CHECKPOINT_LIMITS
    require(type(limits) is dict and set(limits)==set(caps) and
            all(type(value) in [int,float] and 0<value<=caps[key] for key,value in limits.items()),
            'Finite local bounds cannot expand the unqualified native resource envelope')
    # Derive/validate the full observed charge before touching local checkpoint state.
    family.attempt_row(configuration,ledger,root,contract,observation,frozen_configuration_sha256=contract['configurationSha256'])
    target=frame/'LOCAL-PROVISIONAL';failure_target=frame/'LOCAL-FAILURE'
    require(not any(path.exists() or path.is_symlink() for path in [target,failure_target,frame/'checkpoint',frame/'local-physical-readback']),
            'Fresh all-artifact local capture destinations required')
    stage='physical-postconditions'
    try:
        require(cleanup['ownedNativeCleanupComplete'] is True and observation['quiescenceObserved'] is True,
                'Actual original family and exact owned cleanup must be closed')
        outputs,enriched,proofs=host.stage_evidence(frame,context,stage_record,observation)
        evidence=preserve(frame,sdk_frame,contract,min(deadline,time.monotonic()+1200))
        binding={**root['binding'],'phase':contract['phase'],'sequence':contract['sequence'],
                 'predecessorSha256':contract['predecessorSha256']}
        stage='capture';bounded={**limits,'seconds':remaining(deadline,1500)}
        captured=codec.capture(frame/'state',frame/'checkpoint',binding,limits=bounded)
        stage='physical-restore'
        require(shutil.disk_usage(frame).free>=limits['treeBytes']+8*GIB,'Complete independent original-state replay/scratch unavailable')
        restored=codec.restore(frame/'checkpoint',frame/'local-physical-readback',binding,captured['archiveSha256'],
                               limits={**limits,'seconds':remaining(deadline,1500)})
        host.after(frame/'local-physical-readback',context)
        replay_outputs=family.physical_outputs(frame/'local-physical-readback',contract)
        require(codec.canonical(outputs)==codec.canonical(replay_outputs),'Independent replay changed exact original phase stamp identities')
        stage='local-reconciliation'
        result=family.completed(configuration,ledger,root,contract,enriched,captured,restored,outputs,
                                frozen_configuration_sha256=contract['configurationSha256'])
        record={**result,'schemaVersion':1,'phase':contract['phase'],'contractSha256':contract['contractSha256'],
                'checkpoint':captured,'restore':restored,'evidence':evidence,'physicalProofs':proofs,
                'localCheckpointCapturedAndPhysicallyRestored':True,'cacheSaveCompleted':False,
                'cacheRestoreReplayQualified':False,'committedPhasePass':False,'hostedCapacityQualified':False}
        stage='atomic-local-publication'
        # Both files are serialized/written/read back before the directory appears.
        publish(target,{'PHASE-LEDGER.json':result['phaseLedger'],'LOCAL-RESULT.json':record},deadline)
        return record
    except BaseException as error:
        # Keep the detailed physical step in FAILURE, using only the existing
        # finite planner vocabulary for its charged, non-advancing attempt row.
        ledger_stage={'physical-postconditions':'capture','local-reconciliation':'physical-restore',
                      'atomic-local-publication':'capture'}.get(stage,stage)
        failure=family.failed(configuration,ledger,root,contract,observation,error,
                              frozen_configuration_sha256=contract['configurationSha256'],retention_stage=ledger_stage)
        publish(failure_target,{'FAILED-PHASE-LEDGER.json':failure,'FAILURE.json':{
            'error':str(error)[:2000],'retentionStage':stage,'actualObservation':observation,
            'completedLedgerPublished':False,'committedPhasePass':False,'gateAComplete':False}},time.monotonic()+60)
        raise
