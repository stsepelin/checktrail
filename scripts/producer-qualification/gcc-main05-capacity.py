"""Fixed bounded admission for the ORIGINAL Debian GCC12 main bootstrap only.

This is data reconciliation, not native/source or storage authority. The hosted
carrier must supply fresh physical observations and independently authenticate
the configure predecessor and reconstructed SDK before using this plan.
"""
import importlib.util
import math
from pathlib import Path


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


planner=load('gcc-staged-plan.py')
require=planner.require
GIB=1024**3
STATE_BYTES=32*GIB
ARCHIVE_BYTES=4*GIB
ENVELOPE_BYTES=8*1024**2
CACHE_MARGIN_BYTES=128*1024**2
FINALIZATION_BOUNDS={
 'evidenceSeconds':300,'captureSeconds':1500,'localReplaySeconds':1500,
 'cacheSaveSeconds':600,'restorePreparationSeconds':120,'cacheRestoreSeconds':600,
 'serviceReplayAndMetadataSeconds':1800,'diagnosticExportSeconds':300,
 'artifactUploadSeconds':300,'controlAndCleanupReserveSeconds':180}
FINALIZE_SECONDS=sum(FINALIZATION_BOUNDS.values())
POST_CAPTURE_SECONDS=3900
SDK_MAX_SECONDS=1200
OBSERVER_OVERHEAD_RESERVE_SECONDS=180
CLEANUP_RESERVE_SECONDS=60
NATIVE_MAX_SECONDS=14400
CHECKPOINT_LIMITS={'entries':1000000,'treeBytes':STATE_BYTES,'archiveBytes':ARCHIVE_BYTES,
 'expandedBytes':40*GIB,'manifestBytes':256*1024**2,'memberBytes':STATE_BYTES,'seconds':1500,'maxPathBytes':4096}


def number(value):return type(value) in [int,float] and math.isfinite(value)


def admit(ledger,configuration,resources,service,physical,*,sdk_elapsed_seconds,now_monotonic):
    """A single fixed native05 continuation, with unreserved finite capacities.

    Scratch includes full growth up to32GiB, a4GiB compressed archive, a separate
    complete32GiB physical replay, and8GiB reserve. These are limits, not a claim
    that this producer will compress or finish within them. Refusal is expected
    when the observed stock host/cache cannot fit the complete operation.
    """
    selected,previous,spent,completed,last=planner.validate_ledger(ledger,configuration)
    require(not ledger['attempts'] or ledger['attempts'][-1]['quiescenceObserved'] is True,
            'Unresolved original process family inhibits every source/native start')
    require(completed==1 and len(ledger['attempts'])<64 and selected['phases'][completed]['phase']=='native',
            'Only the immediate original main bootstrap is selectable')
    require(physical['restoredPhysicalTreeVerified'] is True and physical['restoredCheckpointSha256']==last and
            physical['sourceAndImagePinsVerified'] is True and physical['packageInventoryUnchanged'] is True and
            physical['sdkMaterialPhysicallyReconstructed'] is True,'Native05 predecessor/SDK physical evidence missing')
    require(resources['architecture']=='x86_64' and resources['cpus']>=4 and resources['memoryBytes']>=12*GIB and
            resources['availableMemoryBytes']>=8*GIB,'Native05 standard AMD64 host capacity unavailable')
    require(all(type(resources[key]) is int and 0<resources[key]<=STATE_BYTES for key in
                ['activeTreeBytes','activeTreeLogicalBytes','activeTreeAllocatedBytes']) and
            resources['activeTreeBytes']==min(resources['activeTreeLogicalBytes'],resources['activeTreeAllocatedBytes']) and
            type(resources['freeDiskBytes']) is int and resources['freeDiskBytes']>=0 and
            type(resources['dockerRootFilesystemFreeBytes']) is int and resources['dockerRootFilesystemFreeBytes']>=0,
            'Native05 physical disk observations missing')
    scratch=STATE_BYTES-resources['activeTreeBytes']+ARCHIVE_BYTES+STATE_BYTES+8*GIB
    require(min(resources['freeDiskBytes'],resources['dockerRootFilesystemFreeBytes'])>=scratch,
            'Native05 growth/archive/independent-replay scratch unavailable')
    clock=service['clock'];cache=service['cache']
    require(number(now_monotonic) and number(clock['capturedMonotonic']) and
            0<=now_monotonic-clock['capturedMonotonic']<=30,'Fresh source-service clock required')
    require(number(clock['remainingSeconds']) and 0<clock['remainingSeconds']<=21600,'Invalid six-hour service remainder')
    remaining=clock['remainingSeconds']-(now_monotonic-clock['capturedMonotonic'])
    require(number(sdk_elapsed_seconds) and 0<=sdk_elapsed_seconds<=SDK_MAX_SECONDS,'SDK preparation time must be charged')
    maximum=min(NATIVE_MAX_SECONDS-sdk_elapsed_seconds-OBSERVER_OVERHEAD_RESERVE_SECONDS,
                43200-spent-sdk_elapsed_seconds-OBSERVER_OVERHEAD_RESERVE_SECONDS,
                int(remaining)-FINALIZE_SECONDS-OBSERVER_OVERHEAD_RESERVE_SECONDS)
    require(maximum>0,'No original main time remains after SDK/whole-job/finalization charges')
    occupied=cache['observedOccupiedBytes']
    require(type(occupied) is int and 0<=occupied<=10*GIB and cache['completeUniqueListingObserved'] is True,
            'Complete fresh included-cache metadata required')
    require(number(cache['capturedMonotonic']) and 0<=now_monotonic-cache['capturedMonotonic']<=30,
            'Fresh shared-cache metadata required')
    required_cache=ARCHIVE_BYTES+ENVELOPE_BYTES+CACHE_MARGIN_BYTES
    require(10*GIB-occupied>=required_cache,'Native05 successor cache capacity unavailable; no automatic deletion')
    phase=selected['phases'][completed]
    return {**phase,'sequence':completed,'attempt':len(ledger['attempts']),'predecessorSha256':previous,
            'restoreCheckpointSha256':last,'configurationSha256':selected['configurationSha256'],
            'maximumNativeBodyAndAttachSeconds':maximum,'sdkPreparationSecondsCharged':sdk_elapsed_seconds,
            'maximumCombinedSdkAndNativeBodySeconds':NATIVE_MAX_SECONDS,
            'prestartAndCleanupReserveSeconds':OBSERVER_OVERHEAD_RESERVE_SECONDS,
            'originalCommandWindowPromised':False,'originalCommandDurationMustBeObservedSeparately':True,'finalizationReserveSeconds':FINALIZE_SECONDS,
            'finalizationStageBounds':dict(FINALIZATION_BOUNDS),
            'requiredObservedFreeDiskBytes':scratch,'checkpointLimits':dict(CHECKPOINT_LIMITS),
            'requiredUnreservedCacheBytes':required_cache,'actualCheckpointSizeMeasured':False,
            'hostOrCompressionFitGuaranteed':False,'cacheCapacityReserved':False,
            'sourceOriginAndServiceClockAssessed':False,'gateAComplete':False}
