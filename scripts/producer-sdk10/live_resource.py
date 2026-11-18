"""One explicit bounded SDK live observation, including Docker transport costs.

The original sampler remains20s. No timed-out command/incomplete sample gets
credit, and these limits never extend the original absolute source deadline.
"""
import math
import re
import time
from common import Refusal, deadline_receipt, encoded, freeze, hash_file, need, read_json
import producer_pause
from producer_adapter import ProducerAPI
from capacity_admission import observe_space

LIMITS = {'wholeSeconds': 90, 'startupSeconds': 30, 'attachSeconds': 30,
          'readbackSeconds': 10, 'reapSeconds': 30, 'sampleSeconds': 20, 'helperReapReserveSeconds': 10}
GUARDS = {'startup', 'attach', 'readback', 'sampler-complete', 'sample-bounds', 'reap', 'whole-deadline', 'complete', 'producer-pause', 'producer-terminal', 'reserve-bounds'}
TRANSPORT_REASONS = {'owned command deadline', 'owned command deadline exhausted before completion credit',
                     'owned command deadline expired before start', 'owned command start or supervision incomplete',
                     'owned command output bound', 'terminal command output bound'}
METER_CODES = {'non-race-incomplete', 'directory-vanished-or-replaced', 'directory-metadata-unavailable',
               'directory-identity-replaced', 'sampler-deadline', 'entry-vanished-during-sample',
               'entry-identity-replaced', 'descriptor-operation-unavailable', 'inode-observation-changed', 'inode-metadata-changed-during-sample'}

class ObservationIncomplete(Refusal):
    def __init__(self, safe_projection):
        self.safe_projection = safe_projection
        super().__init__('live resource observation incomplete: ' + str(safe_projection['guard']))

def integer(value):
    return value if type(value) is int and -(2**63) <= value < 2**63 else None

def seconds(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 21000 else None

def category(value, allowed, fallback):
    return value if value is None or (type(value) is str and value in allowed) else fallback

def projection(record):
    """Only finite categories/scalars/hashes: no paths/argv/exception bodies."""
    command = record.get('attach') if type(record.get('attach')) is dict else {}
    meter = record.get('meter') if type(record.get('meter')) is dict else {}
    reason = command.get('reason')
    return {'kind': 'sdk10-live-resource-observation-v1', 'guard': category(record.get('guard'), GUARDS, 'readback'),
            'complete': record.get('complete') is True, 'helperExit': integer(command.get('exitCode')),
            'helperReason': category(reason, TRANSPORT_REASONS, 'other-transport-refusal'),
            'helperSeconds': seconds(command.get('elapsedSeconds')), 'samplingComplete': meter.get('samplingComplete') if type(meter.get('samplingComplete')) is bool else None,
            'samplerCode': category(meter.get('incompleteCode'), METER_CODES, 'non-race-incomplete'),
            'samplerAttempts': len(meter['attempts']) if type(meter.get('attempts')) is list and len(meter['attempts']) <= 2 else None,
            'samplerSeconds': seconds(meter.get('elapsedSeconds')), 'members': integer(meter.get('members')),
            'regularLogicalBytes': integer(meter.get('regularLogicalBytes')),
            'allocatedBytesWithHardlinkDoubleCounting': integer(meter.get('allocatedBytesWithHardlinkDoubleCounting')),
            'allocatedBytesUniqueInodes': integer(meter.get('allocatedBytesUniqueInodes')),
            'uniqueObservedInodes': integer(meter.get('uniqueObservedInodes')),
            'repeatedInodePaths': integer(meter.get('repeatedInodePaths')),
            'allocationAccounting': category(meter.get('allocationAccounting'), {'stable-dev-inode-once'}, 'unassessed'),
            'wholeObservationSeconds': seconds(record.get('elapsedSeconds')),
            'physicalFreeBytes': integer(record.get('physicalReserve', {}).get('actualFreeBytes')),
            'physicalFreeRequiredBytes': integer(record.get('physicalReserve', {}).get('requiredFreeBytes')),
            'physicalReserveAccepted': record.get('physicalReserve', {}).get('accepted') is True,
            'sourceOriginalExitOrBuildPassCredited': False, 'cleanupOrCustodyCredit': False,
            'producerPausedConfirmed': record.get('producerLifecycle', {}).get('pauseConfirmed') is True,
            'producerLifecycleVerified': record.get('producerLifecycle', {}).get('lifecycleVerified') is True,
            'producerTerminalNoSample': record.get('producerTerminal') is True,
            'rawPathsArgvExceptionsSourceOrSDKBodiesEmitted': False}

def validate_meter(meter, maximum):
    need(type(meter) is dict and meter.get('samplingComplete') is True, 'live work sampler incomplete')
    need(meter.get('incompleteCode') is None and meter.get('failedAttemptCountersCredited') is False, 'contradictory complete sampler state')
    need(type(meter.get('attempts')) is list and 1 <= len(meter['attempts']) <= 2 and meter['attempts'][-1].get('samplingComplete') is True, 'complete final sampler attempt required')
    need(seconds(meter.get('elapsedSeconds')) is not None and meter['elapsedSeconds'] < LIMITS['sampleSeconds'], 'live sampler20s completion deadline')
    for key in ('members', 'regularLogicalBytes', 'allocatedBytesWithHardlinkDoubleCounting', 'allocatedBytesUniqueInodes', 'uniqueObservedInodes', 'repeatedInodePaths'):
        need(type(meter.get(key)) is int and meter[key] >= 0, 'live meter numeric contract')
    need(meter.get('allocationAccounting') == 'stable-dev-inode-once' and meter['uniqueObservedInodes'] + meter['repeatedInodePaths'] == meter['members'] and meter['allocatedBytesUniqueInodes'] <= meter['allocatedBytesWithHardlinkDoubleCounting'], 'same complete inode allocation accounting')
    need(meter['members'] <= 2000000 and meter['regularLogicalBytes'] <= maximum and meter['allocatedBytesUniqueInodes'] <= maximum, 'sampled work byte bound')

def observe(controller, label, native_deadline, clock=time.monotonic, producer_binding=None):
    """Specific SDK meter helper. No source invocation or automatic retry."""
    need(re.fullmatch(r'meter-[1-9][0-9]*', label), 'exact first-party meter label')
    c = controller
    need(type(producer_binding) is dict, 'captured original producer binding required')
    api = ProducerAPI(c, producer_binding.get('name'))
    need(api.binding == producer_binding, 'exact captured original producer for observation')
    started = clock()
    deadline = min(native_deadline, c.state['nativeDeadline'], c.state['cleanupDeadline'], started + LIMITS['wholeSeconds'])
    original_phase_deadline = c.state['phaseDeadline']
    name = c.state['prefix'] + '-' + label
    record = {'context': c.ctx, 'label': label, 'guard': 'startup', 'complete': False, 'attach': None,
              'meter': None, 'phases': [], 'originalNativeDeadlineUnchanged': native_deadline}
    live = c.root / 'evidence/LIVE-METER.json'
    target = c.root / 'evidence' / (label + '-LIVE-OPERATION.json')
    need(not target.exists(), 'fresh live operation receipt')
    def stage(guard, seconds_limit):
        need(guard in GUARDS and clock() < deadline, 'live observation original whole deadline')
        record['guard'] = guard
        c.state['phaseDeadline'] = min(deadline, clock() + seconds_limit)
        record['phases'].append({'stage': guard, 'started': clock(), 'deadline': c.state['phaseDeadline']})
    original_error = None
    registered = False
    try:
        stage('startup', LIMITS['startupSeconds'])
        # A former valid sample must never substitute for this operation.
        if live.exists():
            need(live.is_file() and not live.is_symlink() and live.stat().st_size <= 65536, 'prior physical live metadata')
            identity = hash_file(live)
            prior = live.with_name(label + '-PRIOR-LIVE-METER.json')
            freeze(prior, live.read_bytes())
            need(hash_file(prior) == identity and hash_file(live) == identity, 'prior meter byte custody before fresh observation')
            live.unlink()
        need(c.inspect('container', name) is None, 'owned meter must start absent')
        c.state['containers'].append(name)
        registered = True
        c.save()
        script = ['/observer/meter_runner.py', '--uid', str(c.state['uid']), '--gid', str(c.state['gid'])]
        entry = ['/usr/bin/python3', '-I', '-S', '-B', *script]
        c.docker(c.container_args(name, entry, True, True, False), seconds=LIMITS['startupSeconds'])
        c.validate_container(c.own_container(name), name, script, True, True, False)
        need(clock() < c.state['phaseDeadline'], 'live startup deadline')
        protocol_deadline = deadline - LIMITS['helperReapReserveSeconds']
        scan_deadline = protocol_deadline - producer_pause.LIMITS['lifecycleReserveSeconds']
        def strict_scan():
            stage('attach', LIMITS['attachSeconds'])
            c.state['phaseDeadline'] = min(c.state['phaseDeadline'], scan_deadline)
            row, _ = c.cmd(['docker', 'start', '-a', name], LIMITS['attachSeconds'], check=False)
            record['attach'] = row
            stage('readback', LIMITS['readbackSeconds'])
            c.state['phaseDeadline'] = min(c.state['phaseDeadline'], scan_deadline)
            if live.is_file() and not live.is_symlink():
                record['meter'] = read_json(live, 65536)
                record['meterPhysicalIdentity'] = hash_file(live)
            need(clock() < c.state['phaseDeadline'], 'live readback deadline')
            record['guard'] = 'attach'
            need(type(row.get('exitCode')) is int and row['exitCode'] == 0 and row.get('reason') is None and row.get('ownedChildStarted') is True and row.get('ownedChildReaped') is True, 'live meter attach transport incomplete')
            record['guard'] = 'sampler-complete'
            need(record['meter'] is not None and record['meter'].get('samplingComplete') is True, 'live work sampler incomplete')
            record['guard'] = 'sample-bounds'
            validate_meter(record['meter'], c.profile['limits']['workBytes'])
            record['guard'] = 'reserve-bounds'
            record['physicalReserve'] = observe_space(c.root, c.state['capacityAdmission']['DockerRootDir'], c.profile, 'paused-native-sample')
            need(record['physicalReserve']['accepted'], 'fresh paused-source same-filesystem capture reserve admission')
            return record['meter']
        record['guard'] = 'producer-pause'
        record['producerLifecycle'] = producer_pause.run(producer_binding, api, strict_scan, native_deadline, protocol_deadline, clock)
        lifecycle = record['producerLifecycle']
        need(lifecycle['outcome'] in ['complete-sample-lifecycle', 'producer-terminal-no-sample'], 'owned producer pause/measurement/resume incomplete')
        record['producerTerminal'] = lifecycle['outcome'] == 'producer-terminal-no-sample'
    except BaseException as error:
        original_error = error
        record['privateErrorType'] = type(error).__name__
        record['privateErrorMessage'] = str(error)[:300]
    finally:
        # The helper is reaped even when attach/readback refuses. Cleanup never
        # changes an earlier transport or sampler failure into passing credit.
        failed_guard = record['guard']
        try:
            if registered:
                stage('reap', LIMITS['reapSeconds'])
                need(c.stop_owned(name), 'owned live helper absence not observed')
                need(clock() < c.state['phaseDeadline'], 'live reap deadline')
                record['helperPositivelyAbsent'] = True
        except BaseException as error:
            record['reapErrorType'] = type(error).__name__
            record['helperPositivelyAbsent'] = False
            if original_error is None:
                original_error = error
                failed_guard = 'reap'
        stopped = clock()
        record['elapsedSeconds'] = stopped - started
        if stopped >= deadline:
            failed_guard = 'whole-deadline'
            if original_error is None:
                original_error = Refusal('live observation original whole deadline')
        record['firstFailureGuard'] = failed_guard if original_error is not None else None
        record['guard'] = failed_guard if original_error is not None else 'producer-terminal' if record.get('producerTerminal') else 'complete'
        record['complete'] = original_error is None and not record.get('producerTerminal', False)
        c.state['phaseDeadline'] = original_phase_deadline
        record['privacySafeProjection'] = projection(record)
        expired = {**record, 'guard': 'whole-deadline', 'complete': False}
        record = deadline_receipt(target, record, deadline, {'guard': 'whole-deadline', 'complete': False,
                                  'privacySafeProjection': projection(expired)}, started)
        if record['completionBudgetExhausted'] and original_error is None:
            original_error = Refusal('live observation receipt deadline')
        print('CHECKTRAIL_SDK10_OBSERVER_STATUS=' + __import__('json').dumps(record['privacySafeProjection'], sort_keys=True), flush=True)
    if original_error is not None:
        raise ObservationIncomplete(record['privacySafeProjection']) from original_error
    return record
