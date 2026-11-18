"""Relocate the complete owned configure replay, without a second source copy.

No CLI or native execution. The reviewed host must first finish SDK materializing,
remove its owned containers, and retain its local image separately. The complete
original manifest and selected graph are rechecked before and after relocation.
"""
import importlib.util
import json
import os
from pathlib import Path
import stat


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


body=load('gcc-main05-stage.py')
h=load('gcc-hosted-carrier.py')
codec=body.codec
require=body.require


def activate(prepared,native_frame,ledger):
    root=Path(os.environ['RUNNER_TEMP']);require(root.is_absolute() and root.resolve()==root,'Physical runner temporary root required')
    sdk_frame=root/'gcc-main05/sdk-frame';source=sdk_frame/'predecessor';destination=native_frame/'state'
    require(prepared['frame']==sdk_frame and prepared['predecessor']==source and
            native_frame==root/'gcc-main05/native-frame','Fixed owned predecessor/native frames required')
    h.physical(sdk_frame);h.physical(source);h.physical(native_frame)
    require(sdk_frame.is_dir() and source.is_dir() and native_frame.is_dir() and
            not destination.exists() and not destination.is_symlink(),'Fresh owned native state destination required')
    proof_path=sdk_frame/'SDK-FOR-MAIN.json'
    require(proof_path.is_file() and not proof_path.is_symlink() and proof_path.stat().st_size<=1024**2,'Bounded SDK preparation receipt required')
    proof=json.loads(proof_path.read_bytes())
    require(proof['state']=='original-sdk-for-main-prepared-and-locally-snapshotted' and
            proof['ownedContainerCleanup']=='removed' and proof['ownedSeedCleanup']=='removed' and
            proof['originalGccTargetInvoked'] is False and proof['originalPhaseAdvanced'] is False,
            'Actual SDK/container shutdown must precede native source relocation')
    before=source.lstat();require(stat.S_ISDIR(before.st_mode) and before.st_dev==native_frame.stat().st_dev,
                                  'One physical owned filesystem required; no source copy fallback')
    configuration,tree,spent=body.predecessor(source,prepared['expectedRoot'],ledger)
    receipt=native_frame/'PREDECESSOR-ACTIVATION.json'
    require(not receipt.exists() and not receipt.is_symlink(),'Fresh predecessor activation receipt required')
    result={'schemaVersion':1,'state':'predecessor-relocation-requested','source':str(source),'destination':str(destination),
            'originalRootDevice':before.st_dev,'originalRootInode':before.st_ino,'secondSourceCopyPerformed':False,
            'completeManifestVerifiedBeforeRelocation':True,'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,
            'hostDiskFitQualified':False,'gateAComplete':False}
    receipt.write_bytes(codec.canonical(result))
    try:
        codec.rename_no_replace(source,destination)
        after=destination.lstat()
        require(not source.exists() and not source.is_symlink() and (after.st_dev,after.st_ino)==(before.st_dev,before.st_ino),
                'Owned predecessor was not physically relocated on its original inode')
        config_after,tree_after,spent_after=body.predecessor(destination,prepared['expectedRoot'],ledger)
        require(configuration==config_after and tree==tree_after and spent==spent_after,
                'Complete source/HOME/APT/report/configuration state changed during relocation')
        measured=h.allocated_state(destination)
        logical,allocated=measured['logicalBytes'],measured['allocatedBytes']
        require(type(logical) is int and type(allocated) is int and logical>0 and allocated>0,
                'Actual logical and allocated state measurements required')
        result.update(state='complete-original-predecessor-relocated-and-reverified',completeManifestVerifiedAfterRelocation=True,
                      physicalRootInodePreserved=True,physicalStateMeasurement=measured,
                      activeTreeBytesForGrowthAccounting=min(logical,allocated))
        return {'state':destination,'configuration':configuration,'priorChargedSeconds':spent,'measurement':measured,
                'activeTreeBytes':min(logical,allocated),'activeTreeLogicalBytes':logical,'activeTreeAllocatedBytes':allocated}
    except BaseException as error:
        result['error']=str(error)[:2000];raise
    finally:receipt.write_bytes(codec.canonical(result))
