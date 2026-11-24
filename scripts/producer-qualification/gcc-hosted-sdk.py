"""Review-only fixed SDK reconstruction diagnostic for the next GCC phase.

The predecessor is restored as inert data, and mounted read-only while the same
original offline build dependencies are provisioned. This action cannot invoke
any GCC source target or advance the original phase ledger.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import uuid
import urllib.parse


def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


HERE=Path(__file__).resolve().parent
h=load(HERE/'gcc-hosted-carrier.py')
codec=load(HERE/'gcc-staged-checkpoint.py')
planner=load(HERE/'gcc-staged-plan.py')
stage=load(HERE/'gcc-hosted-stage.py')
require=h.require
PREDECESSOR={
 'run':44140525465,'job':134241750848,'head':'9b237f06213d06bca5f94340c59bd40b2dccccd3',
 'key':'gcc-phase0-9b237f06213d06bca5f94340c59bd40b2dccccd3-44140525465-1',
 'ref':'refs/heads/diagnostic/gcc-phase0-original-1117','cacheId':10678503445,
 'cacheVersion':'159f84918b9ae2c514f95d04945a8a79e20ef5ffa09fc0be8bfe9a613fb8727f',
 'archive':{'bytes':699109163,'sha256':'3eff87d27334ddc28ea76b49cd59f0bc6e7d02b108d4a66bb8c7194e8e32dbbf'},
 'members':{
  'CHECKPOINT-ROOT.json':{'bytes':2812,'sha256':'0a37582b5bba89ea84a20c9c2d2454e07b7a6ccc0a3c22e7b2dfbab8e7ea8a31'},
  'PHASE-LEDGER.json':{'bytes':629,'sha256':'72b4bad5b000796bd91fab7e81a657b48ce9cb468a4fe06967dd2e7c9d8fba3b'},
  'receipt.json':{'bytes':982,'sha256':'8129db60a3f05053be41c14f393ecd2f1d0763226775af9c71a9fb5cf7778e43'}},
 'configurationSha256':'0c08604bb36390d97a8697dda36f8468f6a7cd90b3fd3ed00c9ee285325b9a35',
 'externalSdkSha256':'248633f163abe316ed8e475bf86a8d56ae2d7c9fb21f7b9abe8abf1867caea46'}
BODY=['/usr/bin/python3','-I','-B','/controller/gcc-sdk-reconstruct.py','sdk-reconstruct']
# Set by the on-host receipt after it loads this module from its private copy
# of the verified bytes; a direct run must use the checkout it attests.
VERIFIED_COPY=False


def controls_directory(repository):
    """Where the controls copied into the SDK container come from.

    This module's own directory: the private verified copy when the on-host
    receipt runs it, otherwise the attested checkout itself and no other one.
    """
    require(VERIFIED_COPY is True or HERE==Path(repository).resolve()/'scripts/producer-qualification',
            'SDK controls must come from the attested checkout')
    return HERE


CONTROLS=['gcc-hosted-stage.py','gcc-sdk-material.py','gcc-sdk-reconstruct.py','gcc-staged-checkpoint.py',
          'gcc-sdk-derived.py','gcc-sdk-derived-run.py']


def verify_cache_identity(api, policy=PREDECESSOR):
    suffix='/repos/stsepelin/checktrail/actions/caches?per_page=100&key='+urllib.parse.quote(policy['key'],safe='')+'&ref='+urllib.parse.quote(policy['ref'],safe='')
    value,_=api.get(suffix)
    require(type(value['total_count']) is int and 0<value['total_count']<=100 and
            len(value['actions_caches'])==value['total_count'],'Bounded predecessor cache inventory missing')
    matches=[row for row in value['actions_caches'] if row['key']==policy['key'] and row['ref']==policy['ref']]
    require(len(matches)==1 and matches[0]['id']==policy['cacheId'] and
            matches[0]['version']==policy['cacheVersion'] and type(matches[0]['size_in_bytes']) is int and
            0<matches[0]['size_in_bytes']<=805306368+8388608,'Original predecessor cache identity differs')
    return matches[0]


def verify_predecessor(transport, output, policy=PREDECESSOR):
    require(transport.is_dir() and not transport.is_symlink() and
            set(p.name for p in transport.iterdir())=={'tree.tar.gz',*policy['members']},
            'Exact predecessor transport members required')
    checkpoint=output/'checkpoint';checkpoint.mkdir(mode=0o700)
    h.copy_pinned(transport/'tree.tar.gz',checkpoint/'tree.tar.gz',policy['archive'])
    for name,pin in policy['members'].items():h.copy_pinned(transport/name,checkpoint/name,pin)
    root=json.loads((checkpoint/'CHECKPOINT-ROOT.json').read_bytes())
    require(root['sourceServiceContext']['GITHUB_RUN_ID']==str(policy['run']) and
            root['sourceServiceContext']['GITHUB_SHA']==policy['head'] and root['sourceJobId']==policy['job'] and
            root['sourceServiceContext']['GITHUB_REF']==policy['ref'] and
            root['binding']['phase']=='configure' and root['binding']['profile']==planner.PROFILE and
            root['binding']['configurationSha256']==policy['configurationSha256'] and
            root['externalSdkSha256']==policy['externalSdkSha256'], 'Predecessor typed root/source binding differs')
    tree=output/'predecessor'
    replay=codec.restore(checkpoint,tree,root['binding'],policy['archive']['sha256'],
                         limits={'treeBytes':8*h.GIB,'archiveBytes':805306368,'expandedBytes':12*h.GIB,'seconds':900})
    stamp=tree/'source/stamps/04-configure-stamp'
    require(stamp.is_file() and not stamp.is_symlink(),'Physical original configure stamp missing')
    config=planner.read_configuration(tree/'__carrier_work/gcc-staged-configuration',tree/'source')
    stage.selected_configuration(config,planner)
    ledger=json.loads((checkpoint/'PHASE-LEDGER.json').read_bytes())
    selected,_,spent,complete,last=planner.validate_ledger(ledger,config)
    require(complete==1 and last==policy['archive']['sha256'] and selected['phases'][1]['phase']=='native',
            'Predecessor cannot skip or replace an original phase')
    require(planner.sha(planner.canonical(config))==policy['configurationSha256'] and replay['physicalTreeVerified'],
            'Physical predecessor configuration differs')
    result={'source':policy,'physicalPredecessorReplayed':True,'reportedCompletePhases':complete,
            'reportedNativeSeconds':spent,'nextOriginalTarget':selected['phases'][1],
            'originalPhaseAdvanced':False,'externalSdkReconstructionQualified':False,'gateAComplete':False}
    (output/'PREDECESSOR-REPLAY.json').write_bytes(codec.canonical(result));return tree,root


def prepare_readonly_keyring(path, predecessor, expected_root):
    inventory=json.loads((predecessor/'__carrier_work/external-sdk-before.json').read_bytes())
    require(hashlib.sha256(stage.canonical(inventory)).hexdigest()==expected_root['externalSdkSha256'],
            'Authenticated old SDK inventory missing before read-only input preparation')
    rows=load(HERE/'gcc-sdk-material.py').inventory(inventory)
    row=rows['/usr/share/keyrings/debian-keyring.gpg']
    require(row['kind']=='file' and h.digest_file(path)=={'bytes':row['bytes'],'sha256':row['sha256']},
            'Original read-only keyring bytes differ')
    before=path.lstat()
    # This is the newly reacquired immutable DATA input, before it is mounted
    # read-only. Preserve its captured dependency time now; the in-container
    # material normalizer cannot alter a read-only bind mount.
    os.utime(path,ns=(row['mtimeNs'],row['mtimeNs']),follow_symlinks=False)
    after=path.lstat()
    require((before.st_mode,before.st_uid,before.st_gid)==(after.st_mode,after.st_uid,after.st_gid) and
            after.st_mtime_ns==row['mtimeNs'] and h.digest_file(path)=={'bytes':row['bytes'],'sha256':row['sha256']},
            'Read-only keyring preparation changed bytes/ownership/mode')
    return {'file':'/usr/share/keyrings/debian-keyring.gpg','bytes':row['bytes'],'sha256':row['sha256'],
            'mtimeNs':row['mtimeNs'],'hostOwnershipAndModePreserved':True,'preparedBeforeReadOnlyMount':True}


def prepare_nested_bind_targets(output):
    # runc applies the nested mounts only at START. A created-container mount
    # map does not prove a child can be created beneath a read-only parent.
    # These are ALL child mounts below our two read-only directory binds.
    parents=[output/'inputs/source',output/'controls']
    children=[parents[0]/'predecessor',parents[1]/'observations']
    for parent,child in zip(parents,children):
        h.physical(parent)
        require(parent.is_dir() and not child.exists() and not child.is_symlink(),
                'Fresh physical nested read-only bind destinations required')
    for child in children:child.mkdir(mode=0o700)
    for child in children:
        h.physical(child)
        require(child.is_dir() and not any(child.iterdir()) and stat.S_IMODE(child.stat().st_mode)==0o700,
                'Empty owned nested read-only bind destination unavailable')
    return children


def arguments(catalog, output, name):
    prepare_nested_bind_targets(output)
    args=h.create_arguments(catalog,output,name)
    require(args[-2:]==['/controller/gcc-hosted-stage.py','configure'],'Existing constructor tail changed')
    args[-2:]=['/controller/gcc-sdk-reconstruct.py','sdk-reconstruct']
    index=args.index(catalog['image'])
    args[index:index]=['--mount','type=bind,source='+str(output/'predecessor')+',target=/inputs/predecessor,readonly',
                       '--mount','type=bind,source='+str(output/'observations')+',target=/controller/observations']
    return args


def validate_container(owner, identifier, name, catalog, output):
    require(owner['Id']==identifier and owner['Config']['Labels']['io.checktrail.gcc-staged-owner']==name,
            'SDK container ownership differs')
    config=owner['Config'];limits=owner['HostConfig'];state=owner['State']
    require(config['User']=='0:0' and config['WorkingDir']=='/work' and config['Image']==catalog['image'] and
            config['Entrypoint']==['/usr/bin/env'] and config['Cmd']==['-i',*[k+'='+v for k,v in catalog['environment'].items()],*BODY],
            'Fixed SDK command/environment differs')
    require(limits['NetworkMode']=='none' and limits['Privileged'] is False and limits['Init'] is True and
            limits['NanoCpus']==4000000000 and limits['Memory']==6*h.GIB and limits['PidsLimit']==1024 and
            state['Status']=='created' and state['Running'] is False and state['Pid']==0,
            'SDK limits or pre-start lifecycle differs')
    expected={'/build':(output/'state',True),'/inputs':(output/'inputs/source',False),
              '/controller':(output/'controls',False),'/inputs/predecessor':(output/'predecessor',False),
              '/controller/observations':(output/'observations',True),
              '/usr/share/keyrings/debian-keyring.gpg':(output/'inputs/keyrings/debian-keyring.gpg',False)}
    expected.update({target:(output/'state'/relative,True) for relative,target in h.MUTABLE_MOUNTS.items()})
    actual={}
    for mount in owner['Mounts']:
        require(mount['Type']=='bind' and mount['Destination'] not in actual,'Unknown/duplicate SDK mount')
        actual[mount['Destination']]=(Path(mount['Source']),mount['RW'])
    require(actual==expected,'SDK read-only predecessor/scratch mount map differs')
    return {'ownedContainer':identifier,'actualLimitsObserved':True,'readOnlyPredecessorObserved':True,
            'originalGccTargetInvoked':False}


def admit(resources, service):
    require(resources['architecture']=='x86_64' and resources['cpus']>=4 and resources['memoryBytes']>=12*h.GIB and
            resources['availableMemoryBytes']>=8*h.GIB and resources['freeDiskBytes']>=40*h.GIB,
            'SDK reconstruction host/scratch capacity unavailable')
    require(service['clock']['remainingSeconds']>=h.capacity.FINALIZE_SECONDS+1200 and
            service['cache']['observedOccupiedBytes']<=10*h.GIB,'SDK source clock/free-included storage unavailable')
    return {'maximumSdkBodySeconds':1200,'predecessorTreeByteLimit':8*h.GIB,'scratchStoreByteLimit':h.GIB,
            'requiredObservedFreeDiskBytes':40*h.GIB,'newCacheWriteRequired':False,
            'laterMainStateArchiveCapacityQualified':False,'originalPhaseAdvanced':False,'gateAComplete':False}


def retain_sdk_stdout(output):
    source=output/'native.log'
    if not source.exists():return {'complete':False,'reason':'SDK body stdout was not created'}
    pin=h.digest_file(source,maximum=512*1024**2);target=output/'sdk-native.log.gz'
    try:
        with target.open('xb') as sink:
            bounded=codec.CappedWriter(sink,codec.Budget({'archiveBytes':8*1024**2,'seconds':120}))
            with gzip.GzipFile(fileobj=bounded,mode='wb',compresslevel=1,mtime=0) as stream:
                with source.open('rb') as original:
                    while True:
                        raw=original.read(65536)
                        if not raw:break
                        stream.write(raw)
        require(h.digest_file(source,maximum=512*1024**2)==pin,'SDK stdout changed during retention')
        return {'complete':True,'original':pin,'compressed':h.digest_file(target,maximum=8*1024**2)}
    except BaseException as error:
        if target.exists():target.unlink()
        return {'complete':False,'original':pin,'reason':str(error)[:1000]}


def export(output):
    destination=Path(os.environ['RUNNER_TEMP'])/'gcc-sdk-diagnostics'
    require(not destination.exists() and not destination.is_symlink(),'Fresh SDK diagnostic destination required')
    stdout=retain_sdk_stdout(output)
    sources=list(output.glob('*.json'))
    if stdout['complete']:sources.append(output/'sdk-native.log.gz')
    sources += [p for p in (output/'observations').glob('*') if p.name in
                ['SDK-RECONSTRUCTION.json','installed-package-identities.txt','sdk-commands.jsonl',
                 'sdk-observed-before.json.gz','sdk-comparison-before.json.gz','sdk-observed-after.json.gz','sdk-comparison-after.json.gz',
                 'SDK-DERIVED-GENERATION.json','SDK-DERIVED-VALIDATION.json','sdk-observed-generated.json.gz','sdk-comparison-generated.json.gz']]
    for folder in output.glob('service-*'):
        if folder.is_dir() and not folder.is_symlink():sources.extend(folder.glob('*.json'))
    total=0;pins=[]
    for source in sources:
        pin=h.digest_file(source,maximum=32*1024**2);total+=pin['bytes'];pins.append((source,pin))
    require(len(pins)<=200 and total<=64*1024**2,'SDK diagnostic metadata bound')
    uid,gid=int(os.environ['SUDO_UID']),int(os.environ['SUDO_GID']);require(uid>0 and gid>0,'SDK artifact-reader identity missing')
    stage=destination.with_name('.gcc-sdk-diagnostics-staging');stage.mkdir(mode=0o700)
    try:
        for source,pin in pins:
            target=stage/source.relative_to(output);h.copy_pinned(source,target,pin);os.chown(target,uid,gid)
        (stage/'SUMMARY.json').write_bytes(codec.canonical({'schemaVersion':1,'metadataBytes':total,
            'metadataMembers':len(pins),'sdkCarrierRecordPresent':(output/'SDK-CARRIER.json').is_file(),
            'nativeEvidenceCreditAssessed':False,'originalGccPhaseAdvanced':False,
            'completeRawSdkStdoutExportAssessed':stdout['complete'],'sdkStdout':stdout,'gateAComplete':False}))
        os.chown(stage/'SUMMARY.json',uid,gid)
        for directory in [stage,*[p for p in stage.rglob('*') if p.is_dir()]]:os.chown(directory,uid,gid)
        codec.rename_no_replace(stage,destination)
        require(stdout['complete'] or not (output/'native.log').exists(), 'SDK stdout retention failed; metadata remains published')
    finally:
        if stage.exists():shutil.rmtree(stage)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repository',required=True)
    parser.add_argument('--inputs',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--mode',choices=['capture','export-diagnostics'],default='capture')
    parser.add_argument('--operator-trust-execution',action='store_true');args=parser.parse_args()
    require(args.mode!='capture' or args.operator_trust_execution,'Operator-level SDK execution trust required')
    require(os.getuid()==0,'Host root required for original ownership/mtime replay')
    repository=h.physical(Path(args.repository));output=Path(args.output)
    require(output==Path(os.environ['RUNNER_TEMP']).resolve()/'gcc-sdk-reconstruction','Exact owned SDK output required')
    if args.mode=='export-diagnostics':return export(output)
    require(not output.exists() and not output.is_symlink(),'Fresh SDK reconstruction output required');output.mkdir(mode=0o700)
    name='checktrail-gcc-sdk-'+uuid.uuid4().hex;identifier=None;requested=False
    result={'schemaVersion':1,'state':'sdk-reconstruction-incomplete','originalGccTargetInvoked':False,
            'originalPhaseAdvanced':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
    try:
        resources=h.capacity.stock_resources(output);result['source']=h.verify_repository(repository,resources['context'])
        require(resources['context']['GITHUB_REF']==PREDECESSOR['ref'],'Predecessor cache requires the same diagnostic branch')
        runtime=h.admit_host_node(json.loads(os.environ['CHECKTRAIL_HOST_NODE']),output)
        api=h.capacity.GitHub(os.environ.get('CHECKTRAIL_GITHUB_JOB_TOKEN'),output);service=h.capacity.capture_service(api,resources['context'])
        admit(resources,service)
        require(os.environ.get('CHECKTRAIL_PREDECESSOR_CACHE_HIT')=='true','Exact predecessor cache action did not hit')
        result['predecessorCache']=verify_cache_identity(api)
        transport=Path(os.environ['RUNNER_TEMP']).resolve()/'gcc-phase0-transport'
        predecessor,expected=verify_predecessor(transport,output)
        controls=controls_directory(repository);raw=(controls/'c-producer-profiles.v1.json').read_bytes()
        require(hashlib.sha256(raw).hexdigest()==codec.CATALOG,'Original producer catalog differs')
        catalog=json.loads(raw);profile=catalog['profiles']['gcc-12']
        require(catalog['image']==codec.IMAGE and catalog['platform']=='linux/amd64' and
                catalog['environment']==stage.FIXED_ENVIRONMENT,'Original SDK image/environment differs')
        inputs=h.physical(Path(args.inputs))
        for row in profile['files']:h.copy_pinned(inputs/row['file'],output/'inputs'/row['file'],row)
        result['readOnlyKeyring']=prepare_readonly_keyring(output/'inputs/keyrings/debian-keyring.gpg',predecessor,expected)
        state=output/'state';state.mkdir(mode=0o700)
        for relative in ['__carrier_work','__carrier_apt_lists','__carrier_apt_archives']:(state/relative).mkdir(mode=0o700)
        (output/'observations').mkdir(mode=0o700);target=output/'controls';target.mkdir(mode=0o700)
        for filename in CONTROLS:h.copy_pinned(controls/filename,target/filename,h.digest_file(controls/filename))
        (target/'EXPECTED-PREDECESSOR-ROOT.json').write_bytes(codec.canonical(expected))
        # Authenticated workflow acquisition already selected this exact image;
        # creation below forbids an implicit pull or alternate image.
        image=json.loads(h.docker(['image','inspect',codec.IMAGE]))[0]
        result['image']=h.validate_and_retain_image(output,image,codec.IMAGE,json.loads((controls/'binutils-image-identity.v1.json').read_bytes()),runtime)
        daemon=json.loads(h.docker(['info','--format','{{json .}}']))
        (output/'DOCKER-OBSERVATION.json').write_bytes(codec.canonical(daemon))
        resources=h.validate_daemon(daemon,h.capacity.stock_resources(output),output);admit(resources,service)
        # Seed and SDK effects address the IDs their creates returned. A name is
        # read only to admit, or to reconcile a create that returned no ID.
        seed=name+'-seed';seed_identifier=None
        try:
            seed_identifier=h.container_id(h.docker(['create','--pull=never','--network','none','--name',seed,'--label','io.checktrail.gcc-sdk-seed='+name,'--entrypoint','/bin/true',codec.IMAGE]).decode().strip())
            for relative in ['__carrier_tmp','__carrier_var_tmp','__carrier_run']:
                h.docker(['cp','-a',seed_identifier+':'+h.MUTABLE_MOUNTS[relative],str(state/relative)],timeout=120)
        finally:
            owner=json.loads(h.docker(['inspect',seed_identifier or seed]))[0]
            require((owner['Id']==seed_identifier if seed_identifier else h.is_container_id(owner['Id'])) and
                    owner['Config']['Labels']['io.checktrail.gcc-sdk-seed']==name,'Unknown seed ownership')
            h.docker(['rm',owner['Id']]);result['ownedSeedCleanup']='removed'
        requested=True;identifier=h.container_id(h.docker(arguments(catalog,output,name),timeout=60).decode().strip())
        owner=json.loads(h.docker(['inspect',name]))[0];witness=validate_container(owner,identifier,name,catalog,output)
        before_source=codec.snapshot(predecessor,codec.Budget({'treeBytes':8*h.GIB,'seconds':180}))
        service=h.capacity.capture_service(api,resources['context']);policy=admit(h.capacity.stock_resources(output),service)
        (output/'ADMISSION.json').write_bytes(codec.canonical({'resources':resources,'service':service,'policy':policy,'container':witness,
                                                            'operatorTrustedSdkCode':True,'projectCodeSandboxed':False}))
        observed=h.native_observation(output,identifier,1200,service['clock'],scope='sdk-reconstruction')
        after_source=codec.snapshot(predecessor,codec.Budget({'treeBytes':8*h.GIB,'seconds':180}))
        require(after_source==before_source,'SDK provisioning modified the immutable predecessor')
        (output/'PREDECESSOR-AFTER-SDK.json').write_bytes(codec.canonical({
            'beforeSnapshotSha256':codec.sha(codec.canonical(before_source)),
            'afterSnapshotSha256':codec.sha(codec.canonical(after_source)),
            'completePhysicalTreeUnchanged':True,'originalPhaseAdvanced':False,'gateAComplete':False}))
        proof=json.loads((output/'observations/SDK-RECONSTRUCTION.json').read_bytes())
        require(proof['state']=='sdk-material-reconstructed-and-physically-verified' and proof['packageInventoryMatches'] and
                proof['originalGccTargetInvoked'] is False,'SDK source body did not prove material reconstruction')
        result.update(state='sdk-material-reconstruction-observed-no-gcc-target-run',observed=observed,proof=proof,
                      actualPredecessorArchiveReplayed=True,sameOriginalPackageInventory=True,wholeRootIdentityClaimed=False)
    except BaseException as error:
        result['error']=str(error)[:2000];raise
    finally:
        cleanup_error=None
        if requested:
            try:
                owner=json.loads(h.docker(['inspect',identifier or name]))[0]
                require(owner['Config']['Labels']['io.checktrail.gcc-staged-owner']==name and
                        (owner['Id']==identifier if identifier else h.is_container_id(owner['Id'])),'Unknown SDK cleanup ownership')
                if owner['State']['Running']:h.docker(['kill',owner['Id']])
                h.docker(['rm',owner['Id']]);result['ownedContainerCleanup']='removed'
            except BaseException as error:
                cleanup_error=error
                result.update(state='sdk-cleanup-incomplete',ownedContainerCleanup='unavailable',cleanupError=str(error)[:1000])
        (output/'SDK-CARRIER.json').write_bytes(codec.canonical(result))
        if cleanup_error is not None:raise cleanup_error


if __name__=='__main__':main()
