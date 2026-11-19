"""Bounded data-only metadata/opaque-log export for the original main05 job.

No source, compiler, SDK tool or service request executes. The caller must have
separate destination/payload authorization before uploading the resulting data.
"""
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


h=load('gcc-hosted-carrier.py')
codec=load('gcc-staged-checkpoint.py')
require=h.require
RAW_LOG_LIMIT=512*1024**2
COMPRESSED_LOG_LIMIT=8*1024**2
METADATA_MEMBER_LIMIT=32*1024**2
TOTAL_EXPORT_LIMIT=64*1024**2
EXPORT_SECONDS=300
SDK_OBSERVATIONS={'SDK-RECONSTRUCTION.json','installed-package-identities.txt','sdk-commands.jsonl',
 'sdk-observed-before.json.gz','sdk-comparison-before.json.gz','sdk-observed-generated.json.gz','sdk-comparison-generated.json.gz',
 'sdk-observed-after.json.gz','sdk-comparison-after.json.gz','SDK-DERIVED-GENERATION.json','SDK-DERIVED-VALIDATION.json'}
NATIVE_OBSERVATIONS={'MAIN05-STAGE.json','MAIN05-ATTEMPT.json','original-commands.jsonl',
 'installed-package-identities-before.txt','installed-package-identities-after.txt','SDK-PROJECTION-before.json','SDK-PROJECTION-after.json',
 'sdk-observed-before.json.gz','sdk-comparison-before.json.gz','sdk-observed-after.json.gz','sdk-comparison-after.json.gz'}


def opaque_log(source,target,deadline):
    if not os.path.lexists(source):return {'state':'not-created','present':False,'complete':False,'originalExecutionAssessed':False}
    before=None
    try:
        before=h.digest_file(source,maximum=RAW_LOG_LIMIT)
        require(time.monotonic()<deadline,'Opaque stdout export deadline reached')
        with target.open('xb') as sink:
            writer=codec.CappedWriter(sink,codec.Budget({'archiveBytes':COMPRESSED_LOG_LIMIT,'seconds':min(120,deadline-time.monotonic())}))
            with gzip.GzipFile(fileobj=writer,mode='wb',compresslevel=1,mtime=0) as output:
                with source.open('rb') as stream:
                    while True:
                        require(time.monotonic()<deadline,'Opaque stdout export deadline reached')
                        raw=stream.read(65536)
                        if not raw:break
                        output.write(raw)
        require(h.digest_file(source,maximum=RAW_LOG_LIMIT)==before,'Original stdout changed during opaque retention')
        digest=hashlib.sha256();size=0
        with gzip.open(target,'rb') as stream:
            while True:
                require(time.monotonic()<deadline,'Opaque stdout round-trip deadline reached')
                raw=stream.read(65536)
                if not raw:break
                size+=len(raw);require(size<=RAW_LOG_LIMIT and size<=before['bytes'],'Opaque stdout round-trip expansion bound')
                digest.update(raw)
        require(size==before['bytes'] and digest.hexdigest()==before['sha256'],'Complete opaque stdout round-trip differs')
        return {'state':'complete-original-stdout-compressed-and-roundtrip-verified','present':True,'complete':True,
                'original':before,'compressed':h.digest_file(target,maximum=COMPRESSED_LOG_LIMIT),
                'bodyReadByModel':False,'originalExecutionAssessed':False}
    except BaseException as error:
        if target.exists():target.unlink()
        return {'state':'original-stdout-retention-failed','present':True,'complete':False,'original':before,
                'reason':str(error)[:1000],'bodyReadByModel':False,'originalExecutionAssessed':False}


def export(output):
    started=time.monotonic();deadline=started+EXPORT_SECONDS
    root=Path(os.environ['RUNNER_TEMP']).resolve()
    require(output==root/'gcc-main05' and output.is_dir() and not output.is_symlink(),'Fixed original main05 metadata frame required')
    destination=root/'gcc-main05-diagnostics'
    require(not destination.exists() and not destination.is_symlink(),'Fresh original main05 diagnostic destination required')
    uid,gid=int(os.environ['SUDO_UID']),int(os.environ['SUDO_GID']);require(uid>0 and gid>0,'Actual original runner artifact-reader identity required')
    collected={}
    for path in output.glob('*.json'):collected[str(path.relative_to(output))]=path
    for label in ['native-frame','sdk-frame']:
        frame=output/label
        for path in frame.glob('*.json'):collected[str(path.relative_to(output))]=path
        allowed=NATIVE_OBSERVATIONS if label=='native-frame' else SDK_OBSERVATIONS
        for name in allowed:
            path=frame/'observations'/name
            if os.path.lexists(path):collected[str(path.relative_to(output))]=path
        for path in frame.glob('service*.json'):collected[str(path.relative_to(output))]=path
    pins={name:h.digest_file(path,maximum=METADATA_MEMBER_LIMIT) for name,path in collected.items()}
    require(len(pins)<=196 and sum(pin['bytes'] for pin in pins.values())<=TOTAL_EXPORT_LIMIT,
            'Complete bounded original main05 metadata export unavailable')
    staging=Path(tempfile.mkdtemp(prefix='.gcc-main05-diagnostics-',dir=root));logs={}
    try:
        for name,path in collected.items():h.copy_pinned(path,staging/name,pins[name])
        for label in ['native-frame','sdk-frame']:
            target=staging/(label+'-native.log.gz');logs[label]=opaque_log(output/label/'native.log',target,deadline)
        files=[];total=0
        for path in staging.rglob('*'):
            if not path.is_file():continue
            pin=h.digest_file(path,maximum=METADATA_MEMBER_LIMIT);total+=pin['bytes'];files.append({'path':str(path.relative_to(staging)),**pin})
        require(len(files)<=198 and total<=TOTAL_EXPORT_LIMIT,'Combined metadata/complete stdout export bound exceeded')
        summary={'schemaVersion':1,'state':'bounded-original-main05-metadata-and-opaque-log-export',
                 'files':files,'exportBytesBeforeSummary':total,'logs':logs,'exportElapsedSeconds':time.monotonic()-started,
                 'exportWholeAllowanceSeconds':EXPORT_SECONDS,
                 'allPresentOriginalSdkAndMainStdoutExported':all(not row['present'] or row['complete'] for row in logs.values()),
                 'bothOriginalStdoutFilesActuallyPresent':all(row['present'] for row in logs.values()),
                 'originalExecutionCreditAssessed':False,'originalSourceOrCompilerExecutedDuringExport':False,
                 'privateProjectsBenchmarksOrReviewTrialsIncluded':False,'gateAComplete':False}
        require(time.monotonic()<deadline,'Whole original main05 export deadline reached')
        raw=codec.canonical(summary);require(len(raw)<=65536 and total+len(raw)<=TOTAL_EXPORT_LIMIT,'Bounded original main05 export summary required')
        (staging/'SUMMARY.json').write_bytes(raw)
        for path in staging.rglob('*'):
            require(not path.is_symlink(),'Unqualified exported link');os.chown(path,uid,gid)
        os.chown(staging,uid,gid);codec.rename_no_replace(staging,destination)
        require(summary['allPresentOriginalSdkAndMainStdoutExported'],'Original stdout export failed; bounded metadata remains published')
        return summary
    finally:
        if staging.exists():shutil.rmtree(staging)


def export_native05(output):
    """Fixed v2 allowlist. Never fall back to the old raw SDK exporter.

    Success exports only three GCC files, the historical baseline, authenticated
    checkpoint/ledger closure and the <=16KiB historical SDK descriptor. A failed
    pre-checkpoint attempt can export its strict typed SDK subaction receipt;
    this does not describe or qualify the later controller/native outcome.
    """
    started=time.monotonic();deadline=started+EXPORT_SECONDS
    profile=load('gcc-native05-checkpoint-profile.py')
    root=Path(os.environ['RUNNER_TEMP']).resolve()
    require(output==root/'gcc-main05' and output.is_dir() and not output.is_symlink(),'Fixed v2 frame required')
    destination=root/'gcc-main05-diagnostics'
    require(not os.path.lexists(destination),'Fresh fixed v2 diagnostic destination required')
    uid,gid=int(os.environ['SUDO_UID']),int(os.environ['SUDO_GID'])
    require(uid>0 and gid>0,'Actual artifact-reader identity required')
    frame=output/'native-frame';root_file=frame/'CHECKPOINT-ROOT.json';collected={};sdk_only=None
    if os.path.lexists(root_file):
        checkpoint_root=profile.data(root_file,1024**2)
        require(checkpoint_root.get('native05EvidenceProfile')==profile.PROFILE,'Fixed exporter requires v2 profile; no legacy fallback')
        profile.validate_checkpoint(frame/'state',checkpoint_root,deadline=deadline)
        # No top-level CARRIER, NATIVE-PREPARED, stage, observations, SDK trees,
        # stdout or generic JSON glob is an export source.
        collected={'CHECKPOINT-ROOT.json':root_file,'PHASE-LEDGER.json':frame/'PHASE-LEDGER.json',
                   'receipt.json':frame/'checkpoint/receipt.json','historical-configure-baseline.json':frame/'state'/profile.scope.BASELINE}
        for name in profile.scope.MAIN_SOURCES:
            collected['gcc-evidence/'+name]=frame/'state'/profile.EVIDENCE/name
        collected['gcc-evidence/INVENTORY.json']=frame/'state'/profile.EVIDENCE/'INVENTORY.json'
        baseline=profile.scope.historical_baseline(frame/'state')
        pins={(r['bytes'],r['sha256']) for r in checkpoint_root['native05Evidence']['excludedNewSdkBodyPins']}
        for name,path in collected.items():
            pin=profile.scope.physical_file(path,RAW_LOG_LIMIT)
            require(name=='historical-configure-baseline.json' and pin==baseline or (pin['bytes'],pin['sha256']) not in pins,
                    'Export source is a relabelled NEW SDK body')
        # Reuse the full original configuration/ledger reader, not a success flag.
        planner=load('gcc-staged-plan.py')
        configuration=planner.read_configuration(frame/'state/__carrier_work/gcc-staged-configuration',frame/'state/source')
        ledger=profile.data(frame/'PHASE-LEDGER.json',1024**2)
        _,_,_,index,last=planner.validate_ledger(ledger,configuration)
        require(index==2 and last==checkpoint_root['archiveSha256'],'Fixed exporter requires complete main05 ledger closure')
    else:
        sdk_record=profile.receipt.validate_receipt(profile.data(output/'SDK-ONHOST-RECEIPT.json',profile.receipt.MAX_RECEIPT))
        require(sdk_record['sourceHead']==os.environ['GITHUB_SHA'],'Source-bound SDK subaction required')
        sdk_only={'schemaVersion':2,'historicalSdkSubaction':{'stage':profile.SDK_STAGE,'receipt':sdk_record},
                  'currentNativeOutcomeAssessed':False,'rawSdkBodiesIncluded':False,'gateAComplete':False}
    # Preflight all files before producing any export member. No one-file
    # success path conceals failure of another member.
    pins={name:h.digest_file(path,maximum=RAW_LOG_LIMIT if name.endswith('.log') else METADATA_MEMBER_LIMIT) for name,path in collected.items()}
    require(sum(pin['bytes'] for pin in pins.values())<=TOTAL_EXPORT_LIMIT,'Complete fixed v2 evidence exceeds export bound')
    staging=Path(tempfile.mkdtemp(prefix='.gcc-main05-v2-diagnostics-',dir=root));total=0;files=[]
    try:
        if sdk_only is not None:
            raw=codec.canonical(sdk_only);require(len(raw)<=16384,'Closed SDK failure/subaction envelope exceeds16KiB')
            (staging/'SDK-SUBACTION.json').write_bytes(raw)
        else:
            for name,path in collected.items():
                require(time.monotonic()<deadline,'V2 export deadline reached')
                if name=='gcc-evidence/main-native.log':
                    result=opaque_log(path,staging/'main-native.log.gz',deadline)
                    require(result['present'] is True and result['complete'] is True,'Complete GCC stdout retention failed')
                else:h.copy_pinned(path,staging/name,pins[name])
            profile.validate_checkpoint(frame/'state',checkpoint_root,deadline=deadline)
            require(all(h.digest_file(path,maximum=RAW_LOG_LIMIT)==pins[name] for name,path in collected.items()),'V2 export source changed')
        for path in staging.rglob('*'):
            require(not path.is_symlink(),'Exported alias refused')
            if path.is_file():
                pin=h.digest_file(path,maximum=METADATA_MEMBER_LIMIT);total+=pin['bytes'];files.append({'path':path.relative_to(staging).as_posix(),**pin})
        summary={'schemaVersion':2,'profile':profile.PROFILE,'files':sorted(files,key=lambda row:row['path']),
                 'newRawSdkMetadataAndStdoutIncluded':False,'historicalSdkReceiptDescribesOnlyPriorSdkSubaction':True,
                 'completeGccDiagnosticMembersPresent':sdk_only is None,'checkpointArchiveIncluded':False,'currentNativeOutcomeAssessedDuringExport':False,
                 'universalProducerOutputNoninterferenceClaimed':False,'originalSourceOrCompilerExecutedDuringExport':False,'gateAComplete':False}
        raw=codec.canonical(summary)
        require(len(raw)<=65536 and total+len(raw)<=TOTAL_EXPORT_LIMIT and time.monotonic()<deadline,'Late/oversize v2 export refused')
        (staging/'SUMMARY.json').write_bytes(raw)
        for path in staging.rglob('*'):os.chown(path,uid,gid)
        os.chown(staging,uid,gid);codec.rename_no_replace(staging,destination)
        return summary
    finally:
        if staging.exists():shutil.rmtree(staging)
