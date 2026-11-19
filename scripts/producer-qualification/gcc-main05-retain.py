"""Retain full quiescent original state with explicit profile-specific evidence.

Historical v1 retains the complete SDK/main evidence family; fixed native05-v2
retains the three GCC evidence files and original historical baseline while new
raw SDK evidence stays on-host. No producer command executes here. A locally
captured/physically restored row remains provisional until separate exact-key
service save/download/replay succeeds.
"""
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import tempfile
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


h=load('gcc-hosted-carrier.py')
policy=load('gcc-main05-capacity.py')
ledger_builder=load('gcc-main05-ledger.py')
body=ledger_builder.body
planner=ledger_builder.planner
codec=body.codec
material=body.material
require=h.require
profile=load('gcc-native05-checkpoint-profile.py')


def remaining_seconds(deadline,maximum):
    remaining=deadline-time.monotonic()
    require(remaining>0,'Original main05 retention/source-service deadline reached')
    return min(maximum,remaining)


class EvidenceCodec:
    """Preserve the original physical clone with this one evidence deadline."""
    def __init__(self,deadline):self.deadline=deadline
    def __getattr__(self,name):return getattr(codec,name)
    def Budget(self,limits):return codec.Budget({**limits,'seconds':remaining_seconds(self.deadline,limits.get('seconds',180))})


def preserve_evidence(frame,sdk_frame,deadline):
    bounded_codec=EvidenceCodec(deadline)
    work=frame/'state/__carrier_work';h.physical(work)
    destination=work/'main05-carrier-evidence'
    require(not destination.exists() and not destination.is_symlink(),'Fresh complete main05 evidence directory required')
    files={'main-native.log':frame/'native.log','sdk-native.log':sdk_frame/'native.log',
           'main-resource-samples.json':frame/'resource-samples.json','sdk-resource-samples.json':sdk_frame/'resource-samples.json',
           'MAIN05-ATTEMPT.json':frame/'MAIN05-ATTEMPT.json','SDK-ATTEMPT.json':sdk_frame/'ATTEMPT.json'}
    pins={name:h.digest_file(path,maximum=512*1024**2 if name.endswith('.log') else 1024**2) for name,path in files.items()}
    trees={'main-observations':frame/'observations','sdk-observations':sdk_frame/'observations',
           'prepared-sdk':frame/'controls/prepared-sdk'}
    for path in trees.values():codec.snapshot(path,bounded_codec.Budget({'treeBytes':128*1024**2,'memberBytes':32*1024**2,'entries':1000,'seconds':120}))
    staging=Path(tempfile.mkdtemp(prefix='.main05-evidence-',dir=work))
    try:
        for name,path in files.items():
            remaining_seconds(deadline,300);h.copy_pinned(path,staging/name,pins[name])
        tree_proofs={}
        for name,path in trees.items():
            target=staging/name;target.mkdir(mode=0o700);tree_proofs[name]=material.clone_scratch(path,target,bounded_codec)
        (staging/'EVIDENCE-INVENTORY.json').write_bytes(codec.canonical({'files':pins,'completeMetadataTrees':tree_proofs,
            'originalSdkAndMainStdoutRetainedCompletely':True,'historicalCacheBodyEqualityClaimed':False,'gateAComplete':False}))
        remaining_seconds(deadline,300)
        codec.rename_no_replace(staging,destination)
        return {'directory':'__carrier_work/main05-carrier-evidence','files':pins,'completeMetadataTrees':tree_proofs,
                'originalSdkAndMainStdoutRetainedCompletely':True}
    finally:
        if staging.exists():shutil.rmtree(staging)


def _capture(frame,sdk_frame,root,ledger,configuration,observation,stage_record,cleanup,*,deadline=None,sdk_scope=None):
    deadline=time.monotonic()+3300 if deadline is None else deadline
    state=frame/'state';source=state/'source';stamp=source/'stamps/05-build-stamp'
    result={'schemaVersion':1,'state':'native05-retention-incomplete','localCheckpointCapturedAndPhysicallyRestored':False,
            'localLedgerIsProvisionalUntilServiceReplay':True,'cacheSaveCompleted':False,'cacheRestoreReplayQualified':False,
            'allSelectedOriginalPhasesCompleted':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
    stage='capture'
    try:
        ledger_builder.native_success(ledger,configuration,observation,stage_record)
        require(cleanup['ownedNativeCleanupComplete'] is True and observation['quiescenceObserved'] is True and
                stat.S_ISREG(stamp.lstat().st_mode),'Closed original native family and physical main05 stamp required')
        selected,previous,_,complete,last=planner.validate_ledger(ledger,configuration)
        require(complete==1 and selected['phases'][complete]['phase']=='native' and
                root['archiveSha256']==last and root['binding']['configurationSha256']==selected['configurationSha256'],
                'Immediate original configure successor binding required')
        reread=planner.read_configuration(state/'__carrier_work/gcc-staged-configuration',source)
        require(reread==configuration,'Captured original selected configuration changed during main05')
        body.stage.selected_configuration(configuration,planner)
        evidence_deadline=min(deadline,time.monotonic()+policy.FINALIZATION_BOUNDS['evidenceSeconds'])
        descriptor=None
        if sdk_scope is None:
            evidence=preserve_evidence(frame,sdk_frame,evidence_deadline)
        else:
            profile.verify_historical_sdk_sources(sdk_frame,sdk_scope)
            evidence=profile.scope.retain_main_only(frame,state,sdk_frame,sdk_scope['privateRoot'],
                sdk_scope['historicalConfigureBaseline'],deadline=evidence_deadline)
            pins=profile.scope.raw_sdk_pins(sdk_frame,sdk_scope['privateRoot'],native_frame=frame)
            descriptor=profile.descriptor(sdk_scope['historicalSdkReceipt'],sdk_scope['historicalConfigureBaseline'],pins,
                sdk_scope['historicalSdkReceipt']['sourceHead'])
            profile.inspect_v2(state,descriptor,sdk_scope['historicalSdkReceipt']['sourceHead'],deadline=evidence_deadline)
        result['evidence']=evidence
        binding={**root['binding'],'phase':'native','sequence':1,'predecessorSha256':previous}
        limits={**policy.CHECKPOINT_LIMITS,'seconds':remaining_seconds(deadline,1500)}
        captured=codec.capture(state,frame/'checkpoint',binding,limits=limits)
        stage='physical-restore'
        # Preserve the actual whole source tree and complete independent replay;
        # refuse rather than omit reports/logs/state to make the disk fit.
        require(shutil.disk_usage(frame).free>=policy.STATE_BYTES+8*policy.GIB,'Complete independent native replay/scratch unavailable')
        limits={**limits,'seconds':remaining_seconds(deadline,1500)}
        restored=codec.restore(frame/'checkpoint',frame/'local-physical-readback',binding,captured['archiveSha256'],limits=limits)
        if descriptor is not None:
            profile.inspect_v2(frame/'local-physical-readback',descriptor,sdk_scope['historicalSdkReceipt']['sourceHead'],deadline=deadline)
        ledger_after=ledger_builder.completed(ledger,configuration,observation,captured,restored,stage_record)
        readback=frame/'local-physical-readback'
        require(stat.S_ISREG((readback/'source/stamps/05-build-stamp').lstat().st_mode),'Restored physical original main05 stamp missing')
        require(planner.read_configuration(readback/'__carrier_work/gcc-staged-configuration',readback/'source')==configuration,
                'Independent replay changed original selected configuration')
        shutil.rmtree(readback)
        remaining_seconds(deadline,1500)
        (frame/'PHASE-LEDGER.json').write_bytes(planner.canonical(ledger_after))
        result.update(state='original-main05-captured-and-physically-restored-provisional',localCheckpointCapturedAndPhysicallyRestored=True,
                      checkpoint=captured,restore=restored,phaseLedger=ledger_after)
        returned={'binding':binding,'checkpoint':captured,'restore':restored,'phaseLedger':ledger_after,'evidence':evidence}
        if descriptor is not None:returned['native05Evidence']=descriptor
        return returned
    except BaseException as error:
        result.update(error=str(error)[:2000],retentionStage=stage)
        try:
            failed=ledger_builder.failed(ledger,configuration,observation,error,retention_stage=stage)
            (frame/'FAILED-PHASE-LEDGER.json').write_bytes(planner.canonical(failed));result['failedPhaseLedger']=failed
        except BaseException as ledger_error:result['failedLedgerEvidenceError']=str(ledger_error)[:1000]
        raise
    finally:(frame/'RETENTION.json').write_bytes(codec.canonical(result))


def capture(frame,sdk_frame,root,ledger,configuration,observation,stage_record,cleanup,*,deadline=None):
    """Historical v1 full-SDK evidence writer; never selected by the new driver."""
    return _capture(frame,sdk_frame,root,ledger,configuration,observation,stage_record,cleanup,deadline=deadline)


def capture_native05(frame,sdk_frame,root,ledger,configuration,observation,stage_record,cleanup,sdk_scope,*,deadline):
    """Fixed new driver seam: no caller-selectable legacy/profile fallback."""
    require(type(sdk_scope) is dict and set(sdk_scope)=={'privateRoot','preparedControls','historicalConfigureBaseline','historicalSdkReceipt'},
            'Actual verified SDK scope required for fixed v2 capture')
    return _capture(frame,sdk_frame,root,ledger,configuration,observation,stage_record,cleanup,deadline=deadline,sdk_scope=sdk_scope)
