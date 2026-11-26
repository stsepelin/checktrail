"""Concrete original SDK materializer retained for local main05 image staging.

No CLI, import execution or source target. The enclosing fixed operator-only
host controller must authorize this native preparation, own the ephemeral image
and retain its complete receipts. This function preserves the independently
pinned original configure predecessor and never advances its phase ledger.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import uuid


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


sdk=load('gcc-hosted-sdk.py')
image_stage=load('gcc-main05-sdk-image.py')
h=sdk.h
codec=sdk.codec
require=h.require


def reconstruct_for_main(repository,inputs,frame,*,controls=None):
    """`controls` is the staged verified copy of scripts/producer-qualification;
    the controls copied into the SDK container and the catalog come from it."""
    require(not frame.exists() and not frame.is_symlink(),'Fresh fixed SDK-for-main frame required')
    require(frame==Path(os.environ['RUNNER_TEMP']).resolve()/'gcc-main05/sdk-frame',
            'Fixed owned SDK-for-main frame path required')
    frame.mkdir(mode=0o700)
    name='checktrail-gcc-sdk-'+uuid.uuid4().hex;identifier=None;requested=False;local_image=None
    result={'schemaVersion':1,'state':'sdk-for-main-preparation-incomplete','originalGccTargetInvoked':False,
            'originalPhaseAdvanced':False,'gateAComplete':False,'localImageCleanupRequired':False}
    try:
        resources=h.capacity.stock_resources(frame);result['source']=h.verify_repository(repository,resources['context'])
        require(resources['context']['GITHUB_REF']==sdk.PREDECESSOR['ref'],'Original predecessor requires the same diagnostic branch')
        runtime=h.admit_host_node(json.loads(os.environ['CHECKTRAIL_HOST_NODE']),frame)
        api=h.capacity.GitHub(os.environ.get('CHECKTRAIL_GITHUB_JOB_TOKEN'),frame)
        service=h.capacity.capture_service(api,resources['context']);sdk.admit(resources,service)
        require(os.environ.get('CHECKTRAIL_PREDECESSOR_CACHE_HIT')=='true','Exact configure cache action did not hit')
        result['predecessorCache']=sdk.verify_cache_identity(api)
        transport=Path(os.environ['RUNNER_TEMP']).resolve()/'gcc-phase0-transport'
        predecessor,expected=sdk.verify_predecessor(transport,frame)
        controls=Path(repository)/'scripts/producer-qualification' if controls is None else Path(controls)
        raw=(controls/'c-producer-profiles.v1.json').read_bytes()
        require(hashlib.sha256(raw).hexdigest()==codec.CATALOG,'Original source/input catalog differs')
        catalog=json.loads(raw);profile=catalog['profiles']['gcc-12']
        require(catalog['image']==codec.IMAGE and catalog['platform']=='linux/amd64' and
                catalog['environment']==sdk.stage.FIXED_ENVIRONMENT,'Original SDK image/environment differs')
        inputs=h.physical(Path(inputs))
        for row in profile['files']:h.copy_pinned(inputs/row['file'],frame/'inputs'/row['file'],row)
        result['readOnlyKeyring']=sdk.prepare_readonly_keyring(frame/'inputs/keyrings/debian-keyring.gpg',predecessor,expected)
        state=frame/'state';state.mkdir(mode=0o700)
        for relative in ['__carrier_work','__carrier_apt_lists','__carrier_apt_archives']:(state/relative).mkdir(mode=0o700)
        (frame/'observations').mkdir(mode=0o700);target=frame/'controls';target.mkdir(mode=0o700)
        for filename in sdk.CONTROLS:h.copy_pinned(controls/filename,target/filename,h.digest_file(controls/filename))
        (target/'EXPECTED-PREDECESSOR-ROOT.json').write_bytes(codec.canonical(expected))
        original_image=json.loads(h.docker(['image','inspect',codec.IMAGE]))[0]
        result['image']=h.validate_and_retain_image(frame,original_image,codec.IMAGE,
            json.loads((controls/'binutils-image-identity.v1.json').read_bytes()),runtime)
        daemon=json.loads(h.docker(['info','--format','{{json .}}']))
        (frame/'DOCKER-OBSERVATION.json').write_bytes(codec.canonical(daemon))
        resources=h.validate_daemon(daemon,h.capacity.stock_resources(frame),frame);sdk.admit(resources,service)
        # Seed and materializer effects address the IDs their creates returned.
        # A name is read only to admit, or to reconcile a create with no ID.
        seed=name+'-seed';seed_identifier=None
        try:
            seed_identifier=h.container_id(h.docker(['create','--pull=never','--network','none','--name',seed,'--label','io.checktrail.gcc-sdk-seed='+name,
                                                     '--entrypoint','/bin/true',codec.IMAGE]).decode().strip())
            for relative in ['__carrier_tmp','__carrier_var_tmp','__carrier_run']:
                h.docker(['cp','-a',seed_identifier+':'+h.MUTABLE_MOUNTS[relative],str(state/relative)],timeout=120)
        finally:
            owner=json.loads(h.docker(['inspect',seed_identifier or seed]))[0]
            require((owner['Id']==seed_identifier if seed_identifier else h.is_container_id(owner['Id'])) and
                    owner['Config']['Labels']['io.checktrail.gcc-sdk-seed']==name,'Unknown SDK seed cleanup ownership')
            h.docker(['rm',owner['Id']]);result['ownedSeedCleanup']='removed'
        # This is the SAME corrected constructor contract as the SDK probe:
        # physically prepare every nested child below the two RO parents before
        # docker create/start, then independently validate the actual mount map.
        arguments=sdk.arguments(catalog,frame,name)
        requested=True;identifier=h.container_id(h.docker(arguments,timeout=60).decode().strip())
        owner=json.loads(h.docker(['inspect',name]))[0]
        witness=sdk.validate_container(owner,identifier,name,catalog,frame)
        before=codec.snapshot(predecessor,codec.Budget({'treeBytes':8*h.GIB,'seconds':180}))
        service=h.capacity.capture_service(api,resources['context']);policy=sdk.admit(h.capacity.stock_resources(frame),service)
        (frame/'ADMISSION.json').write_bytes(codec.canonical({'resources':resources,'service':service,'policy':policy,
            'container':witness,'operatorTrustedSdkCode':True,'projectCodeSandboxed':False}))
        observed=h.native_observation(frame,identifier,1200,service['clock'],scope='sdk-reconstruction')
        after=codec.snapshot(predecessor,codec.Budget({'treeBytes':8*h.GIB,'seconds':180}))
        require(after==before,'SDK materialization changed the complete immutable predecessor')
        (frame/'PREDECESSOR-AFTER-SDK.json').write_bytes(codec.canonical({'beforeSnapshotSha256':codec.sha(codec.canonical(before)),
            'afterSnapshotSha256':codec.sha(codec.canonical(after)),'completePhysicalTreeUnchanged':True,
            'originalPhaseAdvanced':False,'gateAComplete':False}))
        proof=json.loads((frame/'observations/SDK-RECONSTRUCTION.json').read_bytes())
        require(proof['state']=='sdk-material-reconstructed-and-physically-verified' and proof['packageInventoryMatches'] is True and
                proof['originalGccTargetInvoked'] is False,'Actual full SDK material reconstruction missing')
        # Snapshot only the genuine stopped, verified materializer into an
        # ephemeral LOCAL image. Actual base layers/SDK package projection stay
        # witnessed; no registry publication or whole-root identity is claimed.
        local_image=image_stage.commit_prepared(name,identifier,original_image,proof,frame)
        result.update(state='original-sdk-for-main-prepared-and-locally-snapshotted',observed=observed,proof=proof,
            localImage=local_image,localImageCleanupRequired=True,wholeRootIdentityClaimed=False,
            actualPredecessorArchiveReplayed=True,sameOriginalPackageInventory=True)
        return {'frame':frame,'predecessor':predecessor,'expectedRoot':expected,'configurationDirectory':predecessor/'__carrier_work/gcc-staged-configuration',
                'originalCatalog':catalog,'localImage':local_image,'sdkProof':proof,'sdkObservedSeconds':observed['nativeSeconds'],
                'sourceContext':resources['context'],'sourceResources':resources}
    except BaseException as error:
        result['error']=str(error)[:2000]
        if local_image is not None:result.update(localImage=local_image,localImageCleanupRequired=True)
        raise
    finally:
        cleanup_error=None
        if requested:
            try:
                owner=json.loads(h.docker(['inspect',identifier or name]))[0]
                require(owner['Config']['Labels']['io.checktrail.gcc-staged-owner']==name and
                        (owner['Id']==identifier if identifier else h.is_container_id(owner['Id'])),'Unknown SDK materializer cleanup ownership')
                if owner['State']['Running']:h.docker(['kill',owner['Id']])
                h.docker(['rm',owner['Id']]);result['ownedContainerCleanup']='removed'
            except BaseException as error:
                cleanup_error=error;result.update(state='sdk-for-main-cleanup-incomplete',cleanupError=str(error)[:1000])
        (frame/'SDK-FOR-MAIN.json').write_bytes(codec.canonical(result))
        # No derived image is silently deleted here: the enclosing host owns the
        # exact returned/retained identity and MUST clean it on success/failure.
        if cleanup_error is not None:raise cleanup_error
