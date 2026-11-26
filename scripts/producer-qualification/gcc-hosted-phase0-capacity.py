"""Finite phase-0 admission; historical policy API 402 is not capacity proof."""
import importlib.util
import json
from pathlib import Path
import time
import urllib.error

spec = importlib.util.spec_from_file_location('frozen_stock_probe', Path(__file__).with_name('gcc-hosted-capacity.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
require, canonical = base.require, base.canonical
context, stock_resources, service_clock = base.context, base.stock_resources, base.service_clock
GIB = 1024 ** 3
CHECKPOINT_BYTES = 768 * 1024 ** 2
ENVELOPE_BYTES = 8 * 1024 ** 2
SHARED_MARGIN_BYTES = 128 * 1024 ** 2
FREE_CACHE_BYTES = 10 * GIB
STATE_CEILING_BYTES = 8 * GIB
FINALIZE_SECONDS = 5400
FREE_CEILING_SOURCE = 'https://docs.github.com/en/billing/concepts/product-billing/github-actions#storage-measurement-units'
HISTORICAL_POLICY_UNAVAILABLE = {'httpStatus': 402, 'runId': 44105958212, 'runAttempt': 1,
    'headSha': 'eff76f832316a3c61d112422282a052ff4c61f54', 'originalBodyRetained': False,
    'notAConfiguredPolicyObservation': True, 'notAPaidRunnerRequirement': True}


class GitHub(base.GitHub):
    def get(self, suffix):
        try:
            return super().get(suffix)
        except urllib.error.HTTPError as error:
            try:
                raw = error.read(2 * 1024 ** 2 + 1)
            finally:
                error.close()
            require(len(raw) <= 2 * 1024 ** 2, 'Oversized failed service response')
            path = self.output / ('service-error-%03d' % self.sequence)
            self.sequence += 1
            path.with_suffix('.json').write_bytes(raw)
            path.with_suffix('.receipt.json').write_bytes(canonical({
                'url': 'https://api.github.com' + suffix, 'httpStatus': error.code,
                'bodyBytes': len(raw), 'responseBodyRetained': True,
                'authenticationHeadersRetained': False, 'capacityQualified': False}) + b'\n')
            raise


def cache_capacity(usage, listing):
    require(type(usage['active_caches_size_in_bytes']) is int and
            usage['active_caches_size_in_bytes'] >= 0, 'Invalid observed repository cache usage')
    require(type(listing['total_count']) is int and 0 <= listing['total_count'] <= 1000 and
            len(listing['actions_caches']) == listing['total_count'], 'Complete bounded cache inventory unavailable')
    rows = listing['actions_caches']
    require(len({row['id'] for row in rows}) == len(rows) and
            all(type(row['size_in_bytes']) is int and row['size_in_bytes'] >= 0 for row in rows),
            'Duplicate or invalid cache entry sizes')
    occupied = max(usage['active_caches_size_in_bytes'], sum(row['size_in_bytes'] for row in rows))
    required = CHECKPOINT_BYTES + ENVELOPE_BYTES + SHARED_MARGIN_BYTES
    headroom = max(0, FREE_CACHE_BYTES - occupied)
    return {'documentedFreeIncludedBytes': FREE_CACHE_BYTES, 'freeCeilingSource': FREE_CEILING_SOURCE,
            'configuredRepositoryCacheCeilingAssessed': False,
            'historicalPolicyEndpointUnavailable': HISTORICAL_POLICY_UNAVAILABLE,
            'observedOccupiedBytes': occupied, 'availableCacheBytes': headroom,
            'phase': 'configure', 'predecessorEntries': 0, 'successorEntries': 1,
            'checkpointCompressedByteLimit': CHECKPOINT_BYTES, 'envelopeByteLimit': ENVELOPE_BYTES,
            'sharedConcurrentWriteMarginBytes': SHARED_MARGIN_BYTES,
            'requiredObservedHeadroomBytes': required, 'headroomAdmitted': headroom >= required,
            'reservationGuaranteed': False, 'cacheUsageMayLagSeconds': 300,
            'sharedConcurrentWritesRemainPossible': True, 'laterPhaseCapacityQualified': False,
            'settingsChanged': False, 'unrelatedCachesDeleted': False}


def capture_service(api, selected):
    prefix = '/repos/' + base.REPOSITORY
    repository, _ = api.get(prefix)
    run, _ = api.get(prefix + '/actions/runs/' + selected['GITHUB_RUN_ID'])
    jobs, response = api.get(prefix + '/actions/runs/' + selected['GITHUB_RUN_ID'] +
                             '/attempts/' + selected['GITHUB_RUN_ATTEMPT'] + '/jobs?per_page=100')
    clock = service_clock(selected, repository, run, jobs, response)
    usage, _ = api.get(prefix + '/actions/cache/usage')
    listing, _ = api.get(prefix + '/actions/caches?per_page=100&page=1')
    require(type(listing['total_count']) is int and 0 <= listing['total_count'] <= 1000,
            'Repository cache metadata exceeds bounded inventory')
    for page in range(2, (listing['total_count'] + 99) // 100 + 1):
        following, _ = api.get(prefix + '/actions/caches?per_page=100&page=' + str(page))
        require(following['total_count'] == listing['total_count'], 'Cache inventory changed during pagination')
        listing['actions_caches'].extend(following['actions_caches'])
    return {'clock': clock, 'cache': cache_capacity(usage, listing)}


def admit(resources, service, *, state_bytes, state_ceiling_bytes=STATE_CEILING_BYTES, preparation_bytes=0):
    require(resources['cpus'] >= 4 and resources['memoryBytes'] >= 12 * GIB and
            resources['availableMemoryBytes'] >= 8 * GIB, 'Insufficient actual stock CPU/memory')
    require(type(state_bytes) is int and 0 <= state_bytes <= state_ceiling_bytes == STATE_CEILING_BYTES and
            type(preparation_bytes) is int and preparation_bytes >= 0, 'Wrong fixed phase-0 growth budget')
    # After capture the carrier keeps the original tree and the compressed
    # checkpoint while it restores an independent readback tree of up to the
    # same logical ceiling, and still requires the 8 GiB floor beside them.
    restore_tree = state_ceiling_bytes
    required = (state_ceiling_bytes - state_bytes + CHECKPOINT_BYTES + ENVELOPE_BYTES + restore_tree +
                8 * GIB + preparation_bytes)
    require(resources['freeDiskBytes'] >= required, 'Actual phase-0 scratch/capture capacity unavailable')
    require(service['cache']['headroomAdmitted'], 'Actual finite phase-0 unpaid cache headroom unavailable')
    remaining = service['clock']['remainingSeconds'] - (time.monotonic() - service['clock']['capturedMonotonic'])
    maximum = min(3600, int(remaining - FINALIZE_SECONDS))
    require(maximum >= 60, 'Source job cannot retain capture/upload/finalization reserve')
    return {'maximumNativeSeconds': maximum, 'requiredScratchBytes': required,
            'stateCeilingBytes': STATE_CEILING_BYTES, 'restoreReadbackTreeBytes': restore_tree,
            'compressedCheckpointByteLimit': CHECKPOINT_BYTES,
            'envelopeByteLimit': ENVELOPE_BYTES, 'sharedConcurrentWriteMarginBytes': SHARED_MARGIN_BYTES,
            'checkpointPredecessorEntries': 0, 'actualCacheReservation': False,
            'sourceServiceClockWitnessed': True, 'laterPhaseCapacityQualified': False,
            'noNativeProducerInvokedByAdmission': True, 'gateAComplete': False}


def measure_envelope(files):
    require(set(files) == {'receipt.json', 'CHECKPOINT-ROOT.json', 'PHASE-LEDGER.json'}, 'Wrong closed phase-0 envelope inventory')
    measured = 0
    for name, raw in files.items():
        require(isinstance(raw, bytes) and 0 < len(raw) <= 1024 ** 2, 'Unbounded phase-0 envelope member')
        json.loads(raw)
        measured += len(raw)
    require(measured <= ENVELOPE_BYTES, 'Phase-0 envelope cap exceeded')
    return {'envelopeLogicalBytesMeasured': measured, 'envelopeByteLimit': ENVELOPE_BYTES,
            'serviceCacheWrapperBytesMeasured': False,
            'serviceStoredSizeMustBeVerifiedAfterSave': True, 'laterPhaseCapacityQualified': False}
