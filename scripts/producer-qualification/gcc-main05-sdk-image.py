"""Local ephemeral SDK carrier from one witnessed STOPPED original materializer.

No registry publication or GCC target occurs here. The enclosing reviewed host
controller must first execute and authenticate the original SDK reconstruction,
including its physical package/compiler/header/library comparison. This helper
refuses a running, failed, unowned or different-command materializer and records
actual local image ancestry/configuration before any later native container.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


sdk=load('gcc-hosted-sdk.py')
h=sdk.h
codec=sdk.codec
require=h.require


def validate_stopped(owner,name,identifier,proof):
    require(re.fullmatch('checktrail-gcc-sdk-[a-f0-9]{32}',name) and owner['Id']==identifier and
            owner['Config']['Labels']['io.checktrail.gcc-staged-owner']==name,'Owned original SDK materializer required')
    require(owner['Config']['Image']==codec.IMAGE and owner['Config']['Entrypoint']==['/usr/bin/env'] and
            owner['Config']['Cmd']==['-i',*[k+'='+v for k,v in sdk.stage.FIXED_ENVIRONMENT.items()],*sdk.BODY],
            'SDK image carrier cannot commit another source command/environment')
    require(owner['State']['Running'] is False and owner['State']['Status']=='exited' and
            owner['State']['Pid']==0 and owner['State']['ExitCode']==0 and owner['State']['OOMKilled'] is False,
            'Genuine stopped zero SDK process family required before local snapshot')
    require(type(owner['SizeRw']) is int and 0<owner['SizeRw']<=8*h.GIB,
            'Actual SDK writable-layer storage missing or exceeds bounded local reserve')
    require(proof['state']=='sdk-material-reconstructed-and-physically-verified' and
            proof['packageInventoryMatches'] is True and proof['sdkMaterialReconstructionObserved'] is True and
            proof['generatedStatePhysicallyValidated'] is True and proof['allTimestampWritesPrecededFinalValidators'] is True and
            proof['softwareAndGeneratedStateContract']=='gcc12-original-sdk-generated-state-v1' and
            proof['historicalCacheBodyEqualityClaimed'] is False and
            proof['originalGccTargetInvoked'] is False and proof['originalPhaseAdvanced'] is False and
            proof['wholeRootIdentityClaimed'] is False,'Physical original software reconstruction required')
    return owner['SizeRw']


def validate_local_image(image,identifier,tag,base):
    require(re.fullmatch('sha256:[a-f0-9]{64}',identifier) and image['Id']==identifier and
            image['Os']=='linux' and image['Architecture']=='amd64' and tag in image['RepoTags'],
            'Actual local derived SDK image identity differs')
    original=base['RootFS']['Layers'];derived=image['RootFS']['Layers']
    require(base['Os']=='linux' and base['Architecture']=='amd64' and base['RootFS']['Type']=='layers' and
            image['RootFS']['Type']=='layers' and len(original)>0 and
            all(re.fullmatch('sha256:[a-f0-9]{64}',layer) for layer in original) and
            derived[:len(original)]==original and len(derived)==len(original)+1 and
            re.fullmatch('sha256:[a-f0-9]{64}',derived[-1]),'Local SDK image does not retain exact observed original layers')
    require(image['Config']['User']=='0:0' and image['Config']['WorkingDir']=='/work',
            'Local SDK materializer runtime configuration differs')
    return {'localImageId':identifier,'localOwnedTag':tag,'observedOriginalImageId':base['Id'],
            'originalRootfsLayers':original,'additionalLocalLayer':derived[-1],
            'wholeRootIdentityClaimed':False,'registryPublicationPerformed':False,
            'native05Executed':False,'gateAComplete':False}


def owned_json(path,value):
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'wb') as stream:
        stream.write(codec.canonical(value));stream.flush();os.fsync(stream.fileno())


def commit_prepared(name,identifier,base,proof,output,docker=h.docker):
    """Operator-only local snapshot; caller owns removal of this exact new ID.

    A caller-selected repository, image, command or destination is not accepted.
    `docker` is an internal synthetic-control injection, not a CLI/MCP argument.
    This does not by itself authenticate base/SDK observations; the enclosing
    fixed native controller must produce those receipts physically.
    """
    require(output.is_dir() and not output.is_symlink(),'Physical owned observation directory required')
    # The stopped materializer is read and committed by its admitted ID; its
    # name may be rebound to another container at any moment.
    require(re.fullmatch('[a-f0-9]{64}',identifier),'Owned original SDK materializer required')
    owner=json.loads(docker(['inspect','--size',identifier]))[0]
    owned_json(output/'SDK-STOPPED-FOR-SNAPSHOT.json',owner)
    size=validate_stopped(owner,name,identifier,proof)
    tag='checktrail-gcc-main05-sdk:'+name.rsplit('-',1)[1]
    require(not docker(['image','ls','--no-trunc','--quiet',tag]).strip(),'Existing SDK tag cannot be overwritten')
    owned_json(output/'SDK-SNAPSHOT-MATERIAL-PROOF.json',proof)
    owned_json(output/'SDK-LOCAL-SNAPSHOT-REQUEST.json',{'command':['docker','commit','--pause=true',identifier,tag],
        'sourceContainerId':identifier,'sourceOwnerName':name,'localOwnedTag':tag,'ownedTagWasAbsentObserved':True,
        'stoppedContainerSha256':hashlib.sha256(codec.canonical(owner)).hexdigest(),
        'materialProofSha256':hashlib.sha256(codec.canonical(proof)).hexdigest(),'native05Executed':False})
    directory=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(directory)
    finally:os.close(directory)
    actual=docker(['commit','--pause=true',identifier,tag],timeout=300).decode().strip()
    # Retain the actual command result/identity even if subsequent validation
    # refuses; do not promote a malformed identity or delete an unknown image.
    (output/'SDK-LOCAL-SNAPSHOT-COMMAND.json').write_bytes(codec.canonical({'command':['docker','commit','--pause=true',identifier,tag],
        'returnedLocalImageId':actual,'sourceContainerId':identifier,'observedSizeRwBytes':size,
        'registryPublicationPerformed':False,'native05Executed':False}))
    require(re.fullmatch('sha256:[a-f0-9]{64}',actual),'Unusable local SDK snapshot identity')
    image=json.loads(docker(['image','inspect',actual]))[0]
    (output/'SDK-LOCAL-IMAGE-OBSERVATION.json').write_bytes(codec.canonical(image))
    record=validate_local_image(image,actual,tag,base)
    record.update(originalMaterializerContainerId=identifier,materialProofSha256=hashlib.sha256(codec.canonical(proof)).hexdigest(),
                  materializerWritableLayerBytes=size,ephemeralLocalImageCleanupRequired=True)
    (output/'SDK-LOCAL-IMAGE.json').write_bytes(codec.canonical(record));return record


def remove_owned_tag(tag,observed,docker,result):
    """Remove the exact owned tag reference, never an image ID.

    Docker deletes the image only when no other tag still holds it, so an
    alias another client added survives with its image. The tag is re-read
    just before the removal; afterwards the image must carry no owned tag and
    is either gone or held only by foreign tags, which are reported. A
    rebind in the last instant before removal cannot be prevented through
    the Docker API; it shows as the owned image left untagged, and is refused.
    """
    listed=docker(['image','ls','--no-trunc','--quiet',tag]).decode().splitlines()
    require(listed==[observed],'Owned SDK tag no longer names the observed image; refuse removal')
    docker(['image','rm',tag],timeout=30)
    require(not docker(['image','ls','--no-trunc','--quiet',tag]).strip(),'Exact owned SDK tag remains after removal')
    present=set(docker(['image','ls','--all','--no-trunc','--quiet']).decode().splitlines())
    if observed in present:
        remaining=json.loads(docker(['image','inspect',observed]))[0]
        aliases=remaining.get('RepoTags') or []
        require(remaining['Id']==observed and tag not in aliases,'Owned SDK tag still names the observed image')
        require(aliases,'Owned SDK image survived removal of its only tag; the tag may have named another image')
        result['unrelatedRemainingAliasesProtected']=aliases


def cleanup_owned(output,docker=h.docker):
    """Recover a created image even when commit_prepared never returned.

    Delete only the one exact owned new tag, or its independently returned
    untagged image ID. Never prune, force image deletion, or remove other tags.
    A mismatched identity remains retained and makes cleanup unqualified.
    """
    request_path=output/'SDK-LOCAL-SNAPSHOT-REQUEST.json'
    if not os.path.lexists(request_path):
        require(not os.path.lexists(output/'SDK-LOCAL-SNAPSHOT-COMMAND.json'),'Image command exists without its pre-effect ownership reservation')
        return {'state':'local-sdk-snapshot-not-requested','ownedImageCleanupComplete':True}
    def read(path):
        h.digest_file(path,maximum=1024**2)
        return json.loads(path.read_bytes())
    request=read(request_path);owner=read(output/'SDK-STOPPED-FOR-SNAPSHOT.json');proof=read(output/'SDK-SNAPSHOT-MATERIAL-PROOF.json')
    name=request['sourceOwnerName'];tag=request['localOwnedTag'];identifier=request['sourceContainerId']
    validate_stopped(owner,name,identifier,proof)
    require(tag=='checktrail-gcc-main05-sdk:'+name.rsplit('-',1)[1] and
            request['command']==['docker','commit','--pause=true',identifier,tag] and request['ownedTagWasAbsentObserved'] is True and
            request['stoppedContainerSha256']==hashlib.sha256(codec.canonical(owner)).hexdigest() and
            request['materialProofSha256']==hashlib.sha256(codec.canonical(proof)).hexdigest(),
            'Exact pre-effect SDK image/tag ownership reservation differs')
    returned=None;command_path=output/'SDK-LOCAL-SNAPSHOT-COMMAND.json'
    if os.path.lexists(command_path):
        command=read(command_path)
        require(command['command']==request['command'] and command['sourceContainerId']==identifier,'Actual SDK snapshot command ownership differs')
        value=command['returnedLocalImageId']
        if isinstance(value,str) and re.fullmatch('sha256:[a-f0-9]{64}',value):returned=value
    listed=docker(['image','ls','--no-trunc','--quiet',tag]).decode().splitlines()
    require(len(listed)<=1,'Owned SDK image tag is ambiguous')
    result={'schemaVersion':1,'state':'local-sdk-image-cleanup-unqualified','tag':tag,'returnedLocalImageId':returned,
            'onlyExactOwnedResourcesTargeted':True,'unrelatedTagsRemoved':False,'imagePrunePerformed':False,
            'originalGccTargetInvoked':False,'gateAComplete':False,'ownedImageCleanupComplete':False}
    try:
        if listed:
            actual=json.loads(docker(['image','inspect',tag]))[0]
            (output/'SDK-IMAGE-CLEANUP-OBSERVED.json').write_bytes(codec.canonical(actual))
            observed=actual['Id']
            require(re.fullmatch('sha256:[a-f0-9]{64}',observed) and listed==[observed] and tag in actual['RepoTags'],
                    'Actual owned image tag identity differs')
            if returned is not None:require(observed==returned,'Owned tag was rebound to a different image; refuse deletion')
            else:require((actual['Config'].get('Labels') or {}).get('io.checktrail.gcc-staged-owner')==name,
                         'Ambiguous commit output lacks independent observed owner label')
            remove_owned_tag(tag,observed,docker,result)
            result.update(state='local-sdk-owned-tag-removed',ownedImageCleanupComplete=True,observedLocalImageId=observed)
        elif returned is not None:
            # The tag may have been removed before a prior cleanup response was
            # retained. Recover only this exact returned ID; protect all aliases.
            present=set(docker(['image','ls','--all','--no-trunc','--quiet']).decode().splitlines())
            if returned in present:
                actual=json.loads(docker(['image','inspect',returned]))[0]
                (output/'SDK-IMAGE-CLEANUP-OBSERVED.json').write_bytes(codec.canonical(actual))
                require(actual['Id']==returned,'Exact returned SDK image identity differs')
                if not actual.get('RepoTags'):
                    # Removing by ID would also take a tag another client adds
                    # meanwhile. Re-acquire the owned tag and remove only that.
                    docker(['tag',returned,tag],timeout=30)
                    remove_owned_tag(tag,returned,docker,result)
                else:result['unrelatedRemainingAliasesProtected']=actual['RepoTags']
            result.update(state='local-sdk-owned-tag-absent-returned-image-reconciled',ownedImageCleanupComplete=True)
        else:
            result.update(state='local-sdk-image-absence-unqualified-after-ambiguous-commit',ownedImageCleanupComplete=False,
                          unknownUnreferencedImageRemovalAssessed=False)
            raise ValueError('No returned SDK image identity/tag; complete owned image cleanup is unproven')
        return result
    except BaseException as error:
        result['error']=str(error)[:2000];raise
    finally:(output/'SDK-IMAGE-CLEANUP.json').write_bytes(codec.canonical(result))
