"""Prepare one fixed original main05 runtime; no GCC process is started here.

Import is inert. A separately reviewed operator-only host owns this preparation,
SDK execution, the returned unstarted native container and exact local image.
No CLI/MCP arguments select another source, target, image, mount or resource size.
"""
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import stat
import time
import uuid


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


assembly=load('gcc-native05-assembly.py')
prepare=assembly.prepare
operator_history=load('gcc-staged-operator-history.py')
h=prepare.h
sdk=prepare.sdk
image=prepare.image_stage
state=load('gcc-main05-state.py')
handoff=load('gcc-main05-sdk.py')
service=load('gcc-main05-service.py')
policy=load('gcc-main05-capacity.py')
observer=load('gcc-main05-observer.py')
attempt_ledger=load('gcc-main05-ledger.py')
codec=sdk.codec
require=h.require
CONTROLS=['gcc-hosted-capacity.py','gcc-hosted-phase0-capacity.py','gcc-hosted-carrier.py','gcc-hosted-stage.py',
          'gcc-phase0-transport.py','gcc-staged-plan.py','gcc-staged-checkpoint.py','gcc-staged-rules2.sh',
          'gcc-staged-configuration.mk','gcc-sdk-material.py','gcc-sdk-reconstruct.py','gcc-sdk-derived.py',
          'gcc-sdk-derived-run.py','gcc-main05-sdk.py','gcc-main05-stage.py']


def arguments(catalog,frame,name):
    parent=h.physical(frame/'controls');child=parent/'observations'
    require(parent.is_dir() and not child.exists() and not child.is_symlink(),'Fresh physical native read-only-parent child required')
    child.mkdir(mode=0o700)
    require(h.physical(child).is_dir() and not any(child.iterdir()) and stat.S_IMODE(child.stat().st_mode)==0o700,
            'Empty native observation mountpoint must exist before read-only parent mounting')
    args=h.create_arguments(catalog,frame,name)
    require(args[-2:]==['/controller/gcc-hosted-stage.py','configure'],'Original fixed constructor tail changed')
    args[-2:]=['/controller/gcc-main05-stage.py','main05'];index=args.index(catalog['image'])
    args[index:index]=['--mount','type=bind,source='+str(frame/'observations')+',target=/controller/observations']
    return args


def validate_container(owner,identifier,name,catalog,frame):
    observer.prestart(owner,name,identifier)
    require(owner['Config']['User']=='0:0' and owner['Config']['WorkingDir']=='/work' and owner['Config']['Image']==catalog['image'],
            'Actual native local SDK image/user/workdir differs')
    expected={'/build':(frame/'state',True),'/inputs':(frame/'inputs/source',False),'/controller':(frame/'controls',False),
              '/controller/observations':(frame/'observations',True),
              '/usr/share/keyrings/debian-keyring.gpg':(frame/'inputs/keyrings/debian-keyring.gpg',False)}
    expected.update({target:(frame/'state'/relative,True) for relative,target in h.MUTABLE_MOUNTS.items()})
    actual={}
    for mount in owner['Mounts']:
        require(mount['Type']=='bind' and mount['Destination'] not in actual,'Unknown/duplicate native mount')
        actual[mount['Destination']]=(Path(mount['Source']),mount['RW'])
    require(actual==expected,'Complete original state and read-only SDK/input/control mount map differs')
    return {'actualNativeContainer':identifier,'actualPreparedLocalImage':catalog['image'],
            'completeOriginalMountStateObserved':True,'readOnlyInputsAndControlsObserved':True,'nativeStarted':False}


def cleanup_native(native):
    request_path=native/'NATIVE-CREATION-REQUEST.json'
    if not os.path.lexists(request_path):return {'state':'native-container-not-requested','ownedNativeCleanupComplete':True}
    h.digest_file(request_path,maximum=1024**2);request=json.loads(request_path.read_bytes());name=request['name']
    require(re.fullmatch('checktrail-gcc-native05-[a-f0-9]{32}',name) and request['sameNameWasAbsentObserved'] is True,
            'Exact new native container ownership reservation required')
    listed=h.docker(['ps','--all','--no-trunc','--quiet','--filter','name=^/'+name+'$']).decode().splitlines()
    require(len(listed)<=1,'Native owned-name lookup is ambiguous')
    if not listed:return {'state':'exact-owned-native-container-absent','ownedNativeCleanupComplete':True}
    owner=json.loads(h.docker(['inspect',name]))[0]
    (native/'NATIVE-CLEANUP-OBSERVED.json').write_bytes(codec.canonical(owner))
    require(re.fullmatch('[a-f0-9]{64}',owner['Id']) and owner['Id']==listed[0] and owner['Config']['Labels']['io.checktrail.gcc-staged-owner']==name,
            'Exact native cleanup ownership differs')
    returned=None;response_path=native/'NATIVE-CREATION-RESPONSE.json'
    if os.path.lexists(response_path):
        h.digest_file(response_path,maximum=65536);response=json.loads(response_path.read_bytes())
        require(response['name']==name,'Native creation response namespace differs')
        value=response['returnedContainerId']
        if isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value):returned=value
    if returned is not None:
        # A malformed runtime configuration remains OUR created resource when
        # its independent returned ID and exact owner match. Preserve the bad
        # metadata, remove it, and never turn that cleanup into native readiness.
        require(owner['Id']==returned,'Native name rebound to another container; refuse deletion')
    else:
        require(owner['Config']['Image']==request['localImageId'] and
                owner['Config']['Cmd']==['-i',*[key+'='+value for key,value in sdk.stage.FIXED_ENVIRONMENT.items()],*observer.BODY],
                'Ambiguous native create lacks matching observed command/image')
    h.docker(['rm','--force',name],timeout=30)
    require(not h.docker(['ps','--all','--no-trunc','--quiet','--filter','name=^/'+name+'$']).strip(),
            'Owned native container remains after removal')
    result={'state':'exact-owned-native-container-removed','ownedNativeCleanupComplete':True,'removedContainerId':owner['Id'],
            'unrelatedContainerRemoved':False,'quiescenceAfterOwnedRemovalObserved':True}
    (native/'NATIVE-CLEANUP.json').write_bytes(codec.canonical(result));return result


def operator_ledger(output=None):
    return operator_history.inspect(output)['phaseLedger']


def preparation_failure(output,sdk_frame,native,sdk_charged,error):
    """Retain real SDK time even when no native runtime was returned.

    Unknown or missing timing/configuration remains explicitly non-retryable.
    A wrapper or SDK failure never becomes an invented original GCC exit.
    """
    result={'state':'preparation-failure-not-yet-charged','originalGccTargetInvoked':False,
            'originalCommandTerminalObserved':False,'originalCommandExitCode':None,'failureLedgerWritten':False,
            'retryAuthorized':False,'gateAComplete':False}
    try:
        path=sdk_frame/'ATTEMPT.json';h.digest_file(path,maximum=1024**2);observed=json.loads(path.read_bytes())
        require(observed['nativePhase']=='sdk-reconstruction' and observed['allElapsedTimeMustBeChargedOnRetry'] is True and
                attempt_ledger.finite(observed['elapsedSeconds']) and attempt_ledger.finite(sdk_charged) and sdk_charged>=observed['elapsedSeconds'],
                'Actual complete SDK timing observation missing')
        root=json.loads((sdk_frame/'controls/EXPECTED-PREDECESSOR-ROOT.json').read_bytes())
        source=native/'state' if (native/'state').exists() else sdk_frame/'predecessor'
        ledger=operator_ledger();configuration,_,_=state.body.predecessor(source,root,ledger)
        observation={'phase':'native','originalCommand':observer.body.COMMAND,'sdkPreparationSecondsCharged':sdk_charged,
            'observerElapsedSeconds':0,'combinedSdkAndMainObservedSeconds':sdk_charged,'originalCommandTerminalObserved':False,
            'originalCommandTerminal':None,'originalCommandExitCode':None,'originalCommandSignal':None,'quiescenceObserved':False}
        failed=attempt_ledger.failed(ledger,configuration,observation,error)
        (output/'PREPARATION-FAILED-PHASE-LEDGER.json').write_bytes(attempt_ledger.planner.canonical(failed))
        result.update(state='actual-sdk-preparation-time-charged-without-gcc-phase-advancement',failureLedgerWritten=True,
                      actualSdkBodyObservedSeconds=observed['elapsedSeconds'],conservativeFullSdkPreparationSecondsCharged=sdk_charged,
                      chargedIncludesPreparationAndCleanupOverhead=True,lastIndependentCheckpointUnchanged=True)
    except BaseException as evidence_error:result['timingOrSourceEvidenceError']=str(evidence_error)[:1000]
    (output/'PREPARATION-FAILURE.json').write_bytes(codec.canonical(result))
    return result


def create_runtime(repository,inputs,output):
    require(os.getuid()==0,'Host root required for original numeric source ownership')
    require(output==Path(os.environ['RUNNER_TEMP']).resolve()/'gcc-main05' and not output.exists() and not output.is_symlink(),
            'Fresh exact owned main05 source-job frame required')
    output.mkdir(mode=0o700);native=output/'native-frame';sdk_frame=output/'sdk-frame'
    name='checktrail-gcc-native05-'+uuid.uuid4().hex;identifier=None;requested=False;ready=False;sdk_charged=None
    result={'schemaVersion':1,'state':'native05-runtime-preparation-incomplete','originalGccTargetInvoked':False,
            'nativeStarted':False,'phaseAdvanced':False,'gateAComplete':False}
    try:
        ledger=operator_ledger(output)
        require(os.environ.get('GITHUB_RUN_ATTEMPT')=='1','A rerun requires independently frozen complete native attempt history and a new reviewed action')
        sdk_started=time.monotonic()
        try:prepared=assembly.reconstruct_verified(repository,inputs,sdk_frame,output)
        finally:sdk_charged=time.monotonic()-sdk_started
        native.mkdir(mode=0o700);controls=native/'controls';controls.mkdir(mode=0o700);(native/'observations').mkdir(mode=0o700)
        original=prepared['originalCatalog'];profile=original['profiles']['gcc-12'];source_controls=repository/'scripts/producer-qualification'
        for row in profile['files']:h.copy_pinned(Path(inputs)/row['file'],native/'inputs'/row['file'],row)
        result['readonlyKeyring']=sdk.prepare_readonly_keyring(native/'inputs/keyrings/debian-keyring.gpg',prepared['predecessor'],prepared['expectedRoot'])
        pins=[]
        for name_control in CONTROLS:
            source=source_controls/name_control;pin=h.digest_file(source)
            h.copy_pinned(source,controls/name_control,pin)
            if name_control.endswith('.sh'):(controls/name_control).chmod(0o755)
            pins.append({'file':name_control,**pin})
        root=prepared['expectedRoot']
        (controls/'EXPECTED-PREDECESSOR-ROOT.json').write_bytes(codec.canonical(root))
        (controls/'EXPECTED-PHASE-LEDGER.json').write_bytes(codec.canonical(ledger))
        sdk_metadata=handoff.stage_metadata(sdk_frame,controls,root)
        active=state.activate(prepared,native,ledger)
        selected_contract=operator_history.verify_selected_history(active['configuration'],ledger)
        local=prepared['localImage'];actual=json.loads(h.docker(['image','inspect',local['localImageId']]))[0]
        (native/'LOCAL-SDK-IMAGE-BEFORE-NATIVE.json').write_bytes(codec.canonical(actual))
        base={'Id':local['observedOriginalImageId'],'Os':'linux','Architecture':'amd64',
              'RootFS':{'Type':'layers','Layers':local['originalRootfsLayers']}}
        image_witness=image.validate_local_image(actual,local['localImageId'],local['localOwnedTag'],base)
        catalog={**original,'image':local['localImageId']}
        native_args=arguments(catalog,native,name)
        require(not h.docker(['ps','--all','--no-trunc','--quiet','--filter','name=^/'+name+'$']).strip(),
                'A preexisting native container name cannot be adopted')
        image.owned_json(native/'NATIVE-CREATION-REQUEST.json',{'name':name,'localImageId':catalog['image'],
            'arguments':native_args,'sameNameWasAbsentObserved':True,'sourceContext':prepared['sourceContext'],'nativeStarted':False})
        directory=os.open(native,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(directory)
        finally:os.close(directory)
        requested=True;response=h.docker(native_args,timeout=60).decode().strip()
        image.owned_json(native/'NATIVE-CREATION-RESPONSE.json',{'returnedContainerId':response,'name':name})
        require(re.fullmatch('[a-f0-9]{64}',response),'Actual native create response identity differs')
        identifier=response
        owner=json.loads(h.docker(['inspect',name]))[0]
        witness=validate_container(owner,identifier,name,catalog,native)
        daemon=json.loads(h.docker(['info','--format','{{json .}}']))
        (native/'DOCKER-BEFORE-NATIVE.json').write_bytes(codec.canonical(daemon))
        resources=h.validate_daemon(daemon,service.h.capacity.stock_resources(native),native)
        measured=h.allocated_state(native/'state')
        resources.update(activeTreeBytes=min(measured['logicalBytes'],measured['allocatedBytes']),
                         activeTreeLogicalBytes=measured['logicalBytes'],activeTreeAllocatedBytes=measured['allocatedBytes'])
        api=service.GitHub(os.environ.get('CHECKTRAIL_GITHUB_JOB_TOKEN'),native)
        fresh=service.capture_service(api,resources['context'])
        physical={'restoredPhysicalTreeVerified':True,'restoredCheckpointSha256':root['archiveSha256'],
                  'sourceAndImagePinsVerified':True,'packageInventoryUnchanged':prepared['sdkProof']['packageInventoryMatches'],
                  'sdkMaterialPhysicallyReconstructed':prepared['sdkProof']['generatedStatePhysicallyValidated']}
        admitted=policy.admit(ledger,active['configuration'],resources,fresh,physical,
                              sdk_elapsed_seconds=sdk_charged,now_monotonic=time.monotonic())
        result.update(state='original-native05-runtime-prepared-not-started',container=witness,image=image_witness,
                      sourceService=fresh,resources=resources,admission=admitted,controls=pins,sdkMetadata=sdk_metadata,
                      operatorHistorySha256=operator_history.HISTORY_SHA256,selectedOriginalContract=selected_contract,
                      actualSdkBodyObservedSeconds=prepared['sdkObservedSeconds'],conservativeFullSdkPreparationSecondsCharged=sdk_charged,
                      allOriginalSourceStatePhysicallyRelocated=True,localImageCleanupRequired=True)
        image.owned_json(output/'NATIVE-PREPARED.json',result)
        directory=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(directory)
        finally:os.close(directory)
        ready=True
        return {'output':output,'nativeFrame':native,'sdkFrame':sdk_frame,'name':name,'containerId':identifier,
                'localImage':local,'preparedSdk':prepared,'sdkScope':prepared['native05SdkScope'],'root':root,'ledger':ledger,'configuration':active['configuration'],
                'resources':resources,'service':fresh,'api':api,'admitted':admitted,'sdkPreparationSecondsCharged':sdk_charged}
    except BaseException as error:
        result['error']=str(error)[:2000]
        try:result['preparationFailure']=preparation_failure(output,sdk_frame,native,sdk_charged,error)
        except BaseException as journal_error:result['failureJournalError']=str(journal_error)[:1000]
        raise
    finally:
        if not ready:
            if requested:
                try:result['ownedUnstartedNativeContainerCleanup']=cleanup_native(native)
                except BaseException as error:result['nativeCleanupError']=str(error)[:1000]
            try:result['ownedLocalSdkImageCleanup']=image.cleanup_owned(sdk_frame)
            except BaseException as error:result['imageCleanupError']=str(error)[:1000]
            require(not (output/'NATIVE-PREPARED.json').is_symlink(),'Refuse a replaced native preparation receipt')
            (output/'NATIVE-PREPARED.json').write_bytes(codec.canonical(result))
