"""Private NEXT-action source: reuse R3 data readers on a locally committed SDK.

No CLI or public output. The future fixed operator must run this inside the
private FD barrier, after original reconstruct_for_main, before any GCC start.
This module grants no execution trust, service time, cache or native capacity.
"""
import importlib.util,json,os,re,stat
from pathlib import Path

def load(name):
 p=Path(__file__).with_name(name);s=importlib.util.spec_from_file_location(p.stem.replace('-','_'),p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

receipt=load('gcc-sdk-onhost-receipt.py')
sdk=load('gcc-main05-sdk.py')
image=load('gcc-main05-sdk-image.py')
h=image.h
require=h.require
POLICY_SHA256='1e8fe16ba8192347186097b7bc331bb3ae1d5dbf480ae138723a2610642604a8'

POLICY_PATH='scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json'

def stage_source(repository):
 """Verify the policy and every runtimeFiles row once and copy those bytes
 into the receipt's private staging tree. Reconstruction and verification
 then both read this one copy, never the runner-owned checkout again."""
 repository=h.physical(Path(repository))
 raw,mode=receipt.pinned_bytes(repository/POLICY_PATH,65536)
 require(receipt.hashlib.sha256(raw).hexdigest()==POLICY_SHA256,'Unchanged approved SDK policy required')
 files=receipt.verify_runtime_files(repository,json.loads(raw))
 require(POLICY_PATH not in files,'Original R3 SDK runtime source changed')
 return receipt.stage_verified({**files,POLICY_PATH:(raw,mode)})

def source_policy(repository):
 repository=h.physical(Path(repository))
 path=repository/'scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json'
 require(receipt.file_pin(path,65536)['sha256']==POLICY_SHA256,'Unchanged approved SDK policy required')
 policy=receipt.read_json(path)
 for row in policy['runtimeFiles']:
  p=repository/row['path']
  require(receipt.file_pin(p,row['bytes'])=={k:row[k] for k in ['bytes','sha256']} and stat.S_IMODE(p.lstat().st_mode)==row['mode'],
          'Original R3 SDK runtime source changed')
 return policy

def verify_prepared(repository,sdk_frame,private,docker=h.docker,*,source=None):
 """Inspect the actual NEW local family; docker is a synthetic-test seam only.

 There is no boolean/phase/command/trust parameter. All returned facts come from
 the physical SDK family, stopped snapshot witnesses and a current image read.
 The caller still needs a separately granted fixed operator action. `source`
 is the staged verified copy whose bytes the constructor used; the checkout
 itself is read only for its git identity.
 """
 source=Path(repository) if source is None else Path(source)
 policy=source_policy(source);sdk_frame=h.physical(Path(sdk_frame));private=h.physical(Path(private))
 require(sdk_frame.is_dir() and private.is_dir() and sdk_frame!=private and sdk_frame not in private.parents and private not in sdk_frame.parents,
         'Separate physical local SDK and reader frames required')
 result=receipt.read_json(sdk_frame/'SDK-FOR-MAIN.json')
 require(result['state']=='original-sdk-for-main-prepared-and-locally-snapshotted' and result['originalGccTargetInvoked'] is False and
         result['originalPhaseAdvanced'] is False and result['ownedContainerCleanup']=='removed' and result['ownedSeedCleanup']=='removed',
         'Actual completed SDK-for-main preparation/cleanup missing')
 actual_source=h.verify_repository(Path(repository),{'GITHUB_SHA':os.environ['GITHUB_SHA']})
 require(result['source']==actual_source,'SDK preparation belongs to another source cohort')
 observed=result['observed'];state=observed['containerState']
 require(observed['quiescenceObserved'] is True and state['Running'] is False and type(state['Pid']) is int and state['Pid']==0 and
         state['Status']=='exited' and type(state['ExitCode']) is int and state['ExitCode']==0 and state['OOMKilled'] is False and not state['Error'],
         'Genuine clean SDK terminal missing')
 local=receipt.read_json(sdk_frame/'SDK-LOCAL-IMAGE.json')
 request=receipt.read_json(sdk_frame/'SDK-LOCAL-SNAPSHOT-REQUEST.json')
 command=receipt.read_json(sdk_frame/'SDK-LOCAL-SNAPSHOT-COMMAND.json')
 proof=receipt.read_json(sdk_frame/'SDK-SNAPSHOT-MATERIAL-PROOF.json')
 stopped=receipt.read_json(sdk_frame/'SDK-STOPPED-FOR-SNAPSHOT.json')
 require(result['localImage']==local and result['proof']==proof and command['returnedLocalImageId']==local['localImageId'] and
         command['sourceContainerId']==request['sourceContainerId']==local['originalMaterializerContainerId'] and
         command['registryPublicationPerformed'] is False and request['native05Executed'] is False and command['native05Executed'] is False,
         'Local SDK snapshot causality differs')
 require(re.fullmatch(r'[a-f0-9]{64}',request['sourceContainerId']) and re.fullmatch(r'sha256:[a-f0-9]{64}',local['localImageId']),
         'Physical SDK resource identity missing')
 image.validate_stopped(stopped,request['sourceOwnerName'],request['sourceContainerId'],proof)
 require(not docker(['ps','--all','--no-trunc','--quiet','--filter','id='+request['sourceContainerId']]).strip(),
         'Original SDK materializer is not independently absent')
 current=json.loads(docker(['image','inspect',local['localImageId']]))
 require(type(current) is list and len(current)==1,'One exact current local SDK image required')
 original=json.loads(docker(['image','inspect',image.codec.IMAGE]))
 require(type(original) is list and len(original)==1,'One exact currently inspected original base required')
 runtime=h.admit_host_node(json.loads(os.environ['CHECKTRAIL_HOST_NODE']),private)
 registry=receipt.read_json(source/'scripts/producer-qualification/binutils-image-identity.v1.json')
 admitted=h.validate_image(original[0],image.codec.IMAGE,registry,runtime)
 require(result['image']==admitted and original[0]['Id']==local['observedOriginalImageId'] and
         original[0]['RootFS']['Layers']==local['originalRootfsLayers'],'SDK image base differs from original pinned registry admission')
 validated=image.validate_local_image(current[0],local['localImageId'],local['localOwnedTag'],original[0])
 require(local['materialProofSha256']==image.hashlib.sha256(image.codec.canonical(proof)).hexdigest(),
         'Physical SDK package/material proof differs from committed snapshot')
 # This is an explicitly labelled projection of independently checked facts,
 # not a claim that the original standalone capture wrote this file.
 projection=sdk_frame/'SDK-CARRIER.json'
 require(not os.path.lexists(projection),'Fresh local R3 reader projection required')
 value={'schemaVersion':1,'state':'sdk-material-reconstruction-observed-no-gcc-target-run',
        'ownedContainerCleanup':'removed','ownedSeedCleanup':'removed','originalGccTargetInvoked':False,'originalPhaseAdvanced':False,
        'observed':observed,'projectionOrigin':'new-native05-local-image-bridge','originalStandaloneCaptureInvoked':False}
 image.owned_json(projection,value)
 facts=receipt.verify_on_host(sdk_frame,private,policy,sdk)
 return {'sdkFactsForClosedReceipt':facts,'preparedSdkControls':str(private/'independent-sdk-controls'),
         'currentLocalImage':validated,'sameApprovedSdkPolicySha256':POLICY_SHA256,
         'newSdkMetadataAndLogsRemainOnHost':True,'originalStandaloneCaptureInvoked':False,
         'closedReceiptNotYetEmitted':True,
         'operatorExecutionTrustGranted':False,'nativeStartAuthorized':False,'nativeFitOrServiceClockQualified':False,
         'checkpointOrCacheExportAuthorized':False}
