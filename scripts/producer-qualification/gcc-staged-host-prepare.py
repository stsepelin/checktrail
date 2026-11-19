"""Local data-only preparation for the source-frozen next original GCC phase.

This consumes an already downloaded, independently pinned checkpoint and a
complete SDK metadata family. It performs no service request, SDK installation,
project execution or native admission. SDK metadata integrity is checked using
the original verification contract; its native provenance is not established by
this helper. There is deliberately no phase, history, trust or clearance option.
"""
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import tempfile
import time


def load(name):
    path=Path(__file__).with_name(name)
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


host=load('gcc-staged-host-contract.py')
sdk=load('gcc-main05-sdk.py')
codec=host.codec
require=codec.require
MEMBERS={'tree.tar.gz','receipt.json','CHECKPOINT-ROOT.json','PHASE-LEDGER.json'}
LIMITS={'treeBytes':32*1024**3,'memberBytes':32*1024**3,'archiveBytes':4*1024**3,
        'expandedBytes':64*1024**3,'manifestBytes':256*1024**2,'entries':1000000,'seconds':1500}
UNQUALIFIED={'operatorExecutionTrustGranted':False,'cacheServiceIdentityQualified':False,
             'sdkNativeOriginQualified':False,'hostCapacityQualified':False,'fullServiceClockAccountingQualified':False,
             'originalSdkOrGccInvoked':False,'originalPhaseAdvanced':False,'gateAComplete':False}


def owned_directory(path):
    path=codec.physical(Path(path));info=path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid==os.geteuid() and not info.st_mode&0o022,
            'Physical privately owned directory required')
    return path


def fresh(path,roots=()):
    path=Path(path);codec.physical(path.parent)
    require(path.is_absolute() and path==path.parent/path.name and not os.path.lexists(path),
            'Fresh physical destination required')
    for root in roots:
        require(path!=root and root not in path.parents and path not in root.parents,'Preparation paths overlap')
    return path


def pin(path,maximum=1024**2):
    path=codec.physical(Path(path));info=path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink==1,'Ordinary unaliased input file required')
    digest,size=codec.identify(path,codec.Budget(LIMITS),maximum)
    return {'bytes':size,'sha256':digest}


def data(path,maximum=1024**2):
    path=Path(path);expected=pin(path,maximum);body=bytearray()
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(descriptor,'rb') as source:
        while True:
            block=source.read(min(65536,maximum+1-len(body)))
            if not block:break
            body.extend(block);require(len(body)<=maximum,'Bounded metadata input grew during read')
    require({'bytes':len(body),'sha256':codec.sha(body)}==expected and pin(path,maximum)==expected,
            'Metadata input changed during read')
    return json.loads(body)


def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def write_new(path,value):
    """One durable no-replace publication, including dangling-marker refusal."""
    path=fresh(Path(path));temporary=path.parent/('.'+path.name+'-'+os.urandom(12).hex())
    descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'wb') as sink:
        sink.write(codec.canonical(value));sink.flush();os.fsync(sink.fileno())
    codec.rename_no_replace(temporary,path);sync_directory(path.parent)


def copy_file(source,target,expected,maximum):
    require(pin(source,maximum)==expected,'Independently bound input bytes differ')
    target=fresh(Path(target))
    descriptor=os.open(source,os.O_RDONLY|os.O_NOFOLLOW);budget=codec.Budget(LIMITS);copied=0
    with os.fdopen(descriptor,'rb') as incoming,target.open('xb') as outgoing:
        os.chmod(target,0o600)
        while True:
            budget.tick()
            block=incoming.read(65536)
            if not block:break
            copied+=len(block);require(copied<=expected['bytes'],'Input grew during bounded copy')
            outgoing.write(block)
        outgoing.flush();os.fsync(outgoing.fileno())
    require(copied==expected['bytes'] and pin(source,maximum)==expected and pin(target,maximum)==expected,
            'Input changed during pinned copy')


def selection():
    # inspect() records no new attempt and refuses a genuine-zero unclosed family.
    # The complete history and the permitted phase are pinned in operator SOURCE.
    inspected=host.body.history.inspect();policy,selected=host.body.history.read_policy()
    require(inspected['phaseLedger']==selected['phaseLedger'] and
            inspected['contract']==host.body.history.verify_selected_history(policy['configuration'],selected['phaseLedger']),
            'Source-frozen history changed during preparation')
    return policy,selected['phaseLedger'],inspected['contract']


def inputs(transport,policy,ledger):
    transport=codec.physical(Path(transport))
    require(transport.is_dir() and set(p.name for p in transport.iterdir())==MEMBERS,'Closed predecessor checkpoint family required')
    pins={name:pin(transport/name,LIMITS['archiveBytes'] if name=='tree.tar.gz' else 1024**2) for name in sorted(MEMBERS)}
    root=data(transport/'CHECKPOINT-ROOT.json');expected=policy['predecessorRoot']
    require(all(root.get(key)==value for key,value in expected.items()),'Independent predecessor root identity differs')
    codec.validate_binding(root['binding'])
    require(pins['tree.tar.gz']=={'bytes':expected['archiveBytes'],'sha256':expected['archiveSha256']},
            'Independent predecessor archive identity differs')
    receipt=data(transport/'receipt.json')
    require(receipt['binding']==expected['binding'] and receipt['archiveSha256']==expected['archiveSha256'] and
            receipt['archiveBytes']==expected['archiveBytes'] and receipt['manifestSha256']==expected['manifestSha256'],
            'Checkpoint receipt and independent root differ')
    # Cache contents end at the immediate COMPLETED predecessor. Failed attempts
    # after that checkpoint remain in the separate source-pinned full history.
    completed=[i for i,row in enumerate(ledger['attempts']) if row['outcome']=='completed']
    require(completed,'A completed immediate predecessor is required')
    expected_ledger={**ledger,'attempts':ledger['attempts'][:completed[-1]+1]}
    require(data(transport/'PHASE-LEDGER.json')==expected_ledger,'Checkpoint ledger is not the exact completed history prefix')
    return root,pins


def sdk_members(controls):
    directory=codec.physical(Path(controls)/'prepared-sdk')
    require(directory.is_dir() and set(p.name for p in directory.iterdir())=={*sdk.FILES,'PREPARED-SDK-MANIFEST.json'},
            'Complete physical SDK metadata family required')
    return {name:pin(directory/name,32*1024**2) for name in sorted({*sdk.FILES,'PREPARED-SDK-MANIFEST.json'})}


def verify_local(frame,policy,ledger):
    root,checkpoint_pins=inputs(frame/'checkpoint',policy,ledger)
    state=codec.physical(frame/'predecessor');controls=owned_directory(frame/'controls')
    require(set(p.name for p in controls.iterdir())=={'SELECTED-PHASE-CONTRACT.json','prepared-sdk'},
            'Closed local selected-phase controls required')
    evidence_profile=load('gcc-native05-checkpoint-profile.py')
    evidence_profile.validate_checkpoint(state,root,deadline=time.monotonic()+120)
    context=host.before(state,root,ledger,controls)
    original=data(state/'__carrier_work/external-sdk-before.json',256*1024**2)
    members=sdk_members(controls)
    verified=sdk.read_prepared(controls,original,root)
    require(sdk_members(controls)==members,'SDK metadata changed during contract verification')
    info=state.lstat()
    return {'context':context,'checkpointMembers':checkpoint_pins,'sdkMetadataMembers':members,
            'sdkVerifiedContractSha256':codec.sha(codec.canonical(verified)),
            'physicalPredecessorRoot':{'device':info.st_dev,'inode':info.st_ino},
            'allAttemptNativeSecondsAlreadyCharged':context['contract']['allAttemptNativeSecondsAlreadyCharged']}


def verify_frame(frame):
    frame=owned_directory(frame)
    require(set(p.name for p in frame.iterdir())=={'checkpoint','predecessor','controls','PREPARED.json'},
            'Complete unused preparation frame required')
    policy,ledger,_=selection();record=data(frame/'PREPARED.json')
    elapsed=record['localControlSeconds']
    require(type(elapsed) in [int,float] and math.isfinite(elapsed) and elapsed>=0,'Actual local preparation duration required')
    require(record=={'schemaVersion':1,'state':'complete-predecessor-and-sdk-metadata-contract-verified',
                     **verify_local(frame,policy,ledger),'localControlSeconds':elapsed,**UNQUALIFIED},
            'Physical preparation no longer matches its complete receipt')
    return record


def prepare(transport,frame,sdk_controls):
    """Restore DATA only; leave the input checkpoint and failed stages intact."""
    started=time.monotonic();policy,ledger,contract=selection()
    transport=codec.physical(Path(transport));sdk_controls=codec.physical(Path(sdk_controls))
    frame=fresh(frame,(transport,sdk_controls));owned_directory(frame.parent)
    require(transport!=sdk_controls and transport not in sdk_controls.parents and sdk_controls not in transport.parents,
            'Checkpoint and SDK metadata inputs overlap')
    root,checkpoint_pins=inputs(transport,policy,ledger);members=sdk_members(sdk_controls)
    staging=Path(tempfile.mkdtemp(prefix='.gcc-staged-preparation-',dir=frame.parent));published=False
    try:
        checkpoint=staging/'checkpoint';checkpoint.mkdir(mode=0o700)
        for name,identity in checkpoint_pins.items():
            copy_file(transport/name,checkpoint/name,identity,LIMITS['archiveBytes'] if name=='tree.tar.gz' else 1024**2)
        replay=codec.restore(checkpoint,staging/'predecessor',root['binding'],root['archiveSha256'],limits=LIMITS)
        require(replay['physicalTreeVerified'] is True and replay['restored'] is True,'Complete physical predecessor replay missing')
        controls=staging/'controls';controls.mkdir(mode=0o700);(controls/'prepared-sdk').mkdir(mode=0o700)
        write_new(controls/'SELECTED-PHASE-CONTRACT.json',contract)
        for name,identity in members.items():copy_file(sdk_controls/'prepared-sdk'/name,controls/'prepared-sdk'/name,identity,32*1024**2)
        require(sdk_members(sdk_controls)==members and inputs(transport,policy,ledger)[1]==checkpoint_pins,
                'Original input family changed during preparation')
        record={'schemaVersion':1,'state':'complete-predecessor-and-sdk-metadata-contract-verified',
                **verify_local(staging,policy,ledger),'localControlSeconds':time.monotonic()-started,**UNQUALIFIED}
        write_new(staging/'PREPARED.json',record);verify_frame(staging)
        codec.rename_no_replace(staging,frame);published=True;sync_directory(frame.parent)
        return verify_frame(frame)
    except BaseException as error:
        retained=frame if published else staging
        failure={'schemaVersion':1,'state':'predecessor-preparation-incomplete','error':str(error)[:2000],
                 'completeChargedPhaseHistory':ledger,'selectedOriginalContract':contract,
                 'localControlSeconds':time.monotonic()-started,'originalDownloadedCheckpointRetained':str(transport),
                 'retainedOwnedStage':str(retained),**UNQUALIFIED}
        try:write_new(retained/'PREPARATION-FAILURE.json',failure)
        except BaseException as journal_error:raise RuntimeError('Preparation failed; failure journal also failed: '+str(journal_error)) from error
        raise
