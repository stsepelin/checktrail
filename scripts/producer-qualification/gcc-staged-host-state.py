"""No-replace physical source activation; no SDK, compiler or service execution.

The independent checkpoint remains in the preparation frame for recovery. The
restored full tree is relocated, never copied or deleted. On a post-move failure
it remains at the recorded destination; a durable one-shot intent inhibits any
automatic retry. No receipt grants trust, native provenance, capacity or phase
advancement. This module has no command-line entry point.
"""
import importlib.util
import os
from pathlib import Path
import sys
import time


def load(name):
    path=Path(__file__).with_name(name)
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


prepared=load('gcc-staged-host-prepare.py')
codec=prepared.codec
require=codec.require


def activation_supported():
    require(sys.platform=='darwin' or sys.platform.startswith('linux'),'Atomic physical activation unsupported on this platform')


def same_device(source,parent):
    require(source.lstat().st_dev==parent.lstat().st_dev,'Cross-device source relocation is not supported; no copy fallback')


def activate(frame,native_frame):
    started=time.monotonic();frame=prepared.owned_directory(frame)
    intent_path=frame/'ACTIVATION-INTENT.json'
    require(not os.path.lexists(intent_path) and not os.path.lexists(frame/'ACTIVATION-FAILURE.json'),
            'Prior activation intent or failure requires independent reconciliation; no retry')
    record=prepared.verify_frame(frame)
    native_frame=prepared.fresh(native_frame,(frame,));prepared.owned_directory(native_frame.parent)
    activation_supported();source=codec.physical(frame/'predecessor');same_device(source,native_frame.parent)
    before=source.lstat();context=record['context'];policy,ledger,contract=prepared.selection()
    require(context['phaseLedger']==ledger and context['contract']==contract,'Complete source-frozen history changed before activation')
    intent={'schemaVersion':1,'state':'source-relocation-requested','source':str(source),'destination':str(native_frame/'state'),
            'preparationReceiptSha256':codec.sha(codec.canonical(record)),
            'sourceRootDevice':before.st_dev,'sourceRootInode':before.st_ino,
            'completeChargedPhaseHistory':ledger,'selectedOriginalContract':contract,
            'retainedIndependentCheckpoint':str(frame/'checkpoint'),'secondSourceCopyPerformed':False,**prepared.UNQUALIFIED}
    # Reserve the one-shot action durably BEFORE mkdir or rename. A crash cannot
    # convert an ambiguous relocation into an automatically repeatable operation.
    prepared.write_new(intent_path,intent)
    try:
        native_frame.mkdir(mode=0o700);prepared.sync_directory(native_frame.parent)
        require(set(p.name for p in native_frame.iterdir())==set(),'Fresh owned activation frame required')
        destination=native_frame/'state'
        codec.rename_no_replace(source,destination)
        prepared.sync_directory(frame);prepared.sync_directory(native_frame)
        after=destination.lstat()
        require(not os.path.lexists(source) and (after.st_dev,after.st_ino)==(before.st_dev,before.st_ino),
                'Complete predecessor was not relocated on its original physical inode')
        # Recompute, never accept the earlier receipt or a Boolean SDK clearance.
        observed=prepared.host.before(destination,policy['predecessorRoot'],ledger,frame/'controls')
        original=prepared.data(destination/'__carrier_work/external-sdk-before.json',256*1024**2)
        verified=prepared.sdk.read_prepared(frame/'controls',original,policy['predecessorRoot'])
        require(observed==context and prepared.sdk_members(frame/'controls')==record['sdkMetadataMembers'] and
                codec.sha(codec.canonical(verified))==record['sdkVerifiedContractSha256'],
                'Complete predecessor/history/SDK contract changed during relocation')
        require(prepared.inputs(frame/'checkpoint',policy,ledger)[1]==record['checkpointMembers'],
                'Retained independent recovery checkpoint changed during activation')
        require(set(p.name for p in native_frame.iterdir())=={'state'},'Unexpected activation-frame output')
        result={'schemaVersion':1,'state':'complete-predecessor-relocated-and-physically-reverified',
                'sourceRootDevice':after.st_dev,'sourceRootInode':after.st_ino,'source':str(source),'destination':str(destination),
                'physicalRootInodePreserved':True,'completeManifestVerifiedAfterRelocation':True,
                'retainedIndependentCheckpoint':str(frame/'checkpoint'),'secondSourceCopyPerformed':False,
                'context':context,'allAttemptNativeSecondsAlreadyCharged':contract['allAttemptNativeSecondsAlreadyCharged'],
                'localControlSeconds':time.monotonic()-started,**prepared.UNQUALIFIED}
        prepared.write_new(native_frame/'ACTIVATION.json',result)
        return result
    except BaseException as error:
        failure={**intent,'state':'source-activation-incomplete','error':str(error)[:2000],
                 'sourcePathPresent':os.path.lexists(source),'destinationPathPresent':os.path.lexists(native_frame/'state'),
                 'localControlSeconds':time.monotonic()-started,'automaticRecoveryAttempted':False}
        # Keep both the genuine input checkpoint and whichever path owns the
        # original source inode. Never roll back over a concurrent destination.
        try:prepared.write_new(frame/'ACTIVATION-FAILURE.json',failure)
        except BaseException as journal_error:raise RuntimeError('Activation failed; failure journal also failed: '+str(journal_error)) from error
        raise
