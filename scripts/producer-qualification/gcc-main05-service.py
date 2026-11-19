"""Phase-specific measured service/cache frame for original main05 only.

The existing authenticated read-only collector supplies complete unique cache
rows and actual source-job clock. Its phase0 size/admission fields are explicitly
replaced here, preserving the raw shared metadata receipts and historical402.
No policy settings, reservation, cache deletion or producer command occurs.
"""
import importlib.util
import json
from pathlib import Path
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


policy=load('gcc-main05-capacity.py')
h=load('gcc-hosted-carrier.py')
require=h.require
base=h.capacity.base
GIB=1024**3
STATE_CEILING_BYTES=policy.STATE_BYTES
CHECKPOINT_BYTES=policy.ARCHIVE_BYTES
ENVELOPE_BYTES=policy.ENVELOPE_BYTES
FREE_CACHE_BYTES=10*GIB
SHARED_MARGIN_BYTES=policy.CACHE_MARGIN_BYTES
FINALIZE_SECONDS=policy.FINALIZE_SECONDS
GitHub=h.capacity.GitHub
context=h.capacity.context


def capture_service(api,selected):
    original=h.capacity.capture_service(api,selected)
    # The delegated collector's guards already validated all bounded pages,
    # unique IDs and exact sizes. No policy endpoint402 is retried.
    occupied=original['cache']['observedOccupiedBytes']
    require(type(occupied) is int and occupied>=0,'Actual complete main05 cache occupancy missing')
    headroom=max(0,FREE_CACHE_BYTES-occupied);required=CHECKPOINT_BYTES+ENVELOPE_BYTES+SHARED_MARGIN_BYTES
    cache={**original['cache'],'phase':'native','predecessorEntries':1,'successorEntries':1,
           'checkpointCompressedByteLimit':CHECKPOINT_BYTES,'envelopeByteLimit':ENVELOPE_BYTES,
           'requiredObservedHeadroomBytes':required,'headroomAdmitted':headroom>=required,
           'availableCacheBytes':headroom,'completeUniqueListingObserved':True,'capturedMonotonic':time.monotonic(),
           'checkpointSizeIsUpperBoundNotMeasured':True,'reservationGuaranteed':False,'laterPhaseCapacityQualified':False}
    return {'clock':original['clock'],'cache':cache}


def measure_envelope(files):
    require(set(files)=={'receipt.json','CHECKPOINT-ROOT.json','PHASE-LEDGER.json'},'Wrong closed main05 envelope inventory')
    measured=0
    for name,raw in files.items():
        require(isinstance(raw,bytes) and 0<len(raw)<=1024**2,'Unbounded main05 envelope member')
        json.loads(raw);measured+=len(raw)
    require(measured<=ENVELOPE_BYTES,'Main05 envelope cap exceeded')
    return {'envelopeLogicalBytesMeasured':measured,'envelopeByteLimit':ENVELOPE_BYTES,
            'serviceCacheWrapperBytesMeasured':False,'serviceStoredSizeMustBeVerifiedAfterSave':True,
            'laterPhaseCapacityQualified':False}


def admit_measured_save(service,archive_bytes,envelope_bytes):
    require(type(archive_bytes) is int and 0<archive_bytes<=CHECKPOINT_BYTES and
            type(envelope_bytes) is int and 0<envelope_bytes<=ENVELOPE_BYTES,'Complete measured main05 archive/envelope required')
    required=archive_bytes+envelope_bytes+SHARED_MARGIN_BYTES
    require(service['cache']['completeUniqueListingObserved'] is True and
            FREE_CACHE_BYTES-service['cache']['observedOccupiedBytes']>=required,
            'Actual measured successor-cache headroom unavailable')
    now=time.monotonic()
    require(0<=now-service['cache']['capturedMonotonic']<=30 and
            0<=now-service['clock']['capturedMonotonic']<=30,'Fresh source job/shared-cache measurements required')
    require(service['clock']['remainingSeconds']-(now-service['clock']['capturedMonotonic'])>=policy.POST_CAPTURE_SECONDS,
            'Source service cannot retain upload/independent restore/finalization')
    return {'actualArchiveBytesMeasured':archive_bytes,'actualEnvelopeBytesMeasured':envelope_bytes,
            'requiredUnreservedCacheBytes':required,'sharedCacheReservationGuaranteed':False,
            'newCacheSaveRequired':True,'unrelatedCachesDeleted':False,'gateAComplete':False}
