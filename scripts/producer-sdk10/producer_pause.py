"""Bounded SDK producer-pause lifecycle protocol.

The adapter supplies exact owned-ID effects. Bindings are data, not trust.
"""
import re
import time

LIMITS = {'wholeSeconds': 90, 'strictScanSeconds': 20, 'inspectSeconds': 5,
          'pauseSeconds': 5, 'resumeSeconds': 5, 'abortSeconds': 10,
          'lifecycleReserveSeconds': 40}

class Refusal(RuntimeError):
    def __init__(self, code): self.code = code; super().__init__(code)

def need(value, code):
    if not value: raise Refusal(code)

def identity(value, binding):
    if value is None: return None
    need(type(value) is dict and value.get('Id') == binding['id'] and value.get('Name') == '/' + binding['name'], 'producer-identity-differs')
    labels = (value.get('Config') or {}).get('Labels')
    need(type(labels) is dict and all(labels.get(k) == v for k, v in binding['labels'].items()), 'producer-labels-differ')
    state = value.get('State')
    need(type(state) is dict and type(state.get('Running')) is bool and type(state.get('Paused')) is bool, 'producer-state-unassessed')
    return state

def complete_command(row):
    return type(row) is dict and type(row.get('exitCode')) is int and row['exitCode'] == 0 and row.get('reason') is None and row.get('ownedChildStarted') is True and row.get('ownedChildReaped') is True

def absent_inverse_observation(container_id):
    # An absence observation is not an execution receipt. No inverse child ran.
    return {'outcome': 'positively-absent-noop', 'operation': 'unpause', 'containerID': container_id,
            'positiveAbsenceObserved': True, 'commandSent': False, 'exitCode': None,
            'ownedChildStarted': False, 'ownedChildReaped': False}

def valid_absent_inverse(row, container_id):
    expected = absent_inverse_observation(container_id)
    return (type(row) is dict and set(row) == set(expected) and row == expected
            and row['positiveAbsenceObserved'] is True and row['commandSent'] is False
            and row['exitCode'] is None and row['ownedChildStarted'] is False and row['ownedChildReaped'] is False)

def run(binding, api, strict_scan, native_deadline, operation_deadline, clock=time.monotonic):
    """Model finite exact-ID effects; every API call receives the SAME outer budget.

    api implements source-only test methods inspect_id/pause_id/unpause_id/
    preserve_protected_metadata/force_remove_id. All calls remain bounded by the original operation deadline.
    """
    started = clock()
    deadline = min(native_deadline, operation_deadline)
    need(deadline <= started + LIMITS['wholeSeconds'] and started < deadline, 'original-operation-budget')
    need(set(binding) == {'id', 'name', 'labels'} and re.fullmatch('[0-9a-f]{64}', binding['id']) is not None, 'exact-captured-producer-binding')
    need(re.fullmatch(r'ct-sdk10-[a-z0-9-]+-original-(?:build|tests)', binding['name']) is not None and type(binding['labels']) is dict and len(binding['labels']) == 3, 'exact-native-role-and-label-binding')
    work_deadline = deadline - LIMITS['lifecycleReserveSeconds']
    row = {'outcome': 'refused', 'samplingComplete': False, 'lifecycleVerified': False,
           'sourceBuildOrTestOrQuotaPassingCredit': False, 'pauseAttempted': False,
           'pauseConfirmed': False, 'inverseRequested': False, 'unpauseAttempted': False, 'forcedRemovalAttempted': False,
           'protectedMetadataPreservationAssessed': False, 'primaryError': None, 'lifecycleErrors': [], 'errors': [], 'commands': [], 'noOpObservations': [],
           'nativeDeadline': native_deadline, 'originalOperationDeadline': operation_deadline}
    paused_once = False
    terminal_before_scan = False
    def bound(seconds, cleanup=False):
        end = deadline if cleanup else work_deadline
        need(clock() < end, 'lifecycle-budget' if cleanup else 'scan-reserve-budget')
        return min(end, clock() + seconds)
    def inspect(cleanup=False):
        return identity(api.inspect_id(binding['id'], bound(LIMITS['inspectSeconds'], cleanup)), binding)
    def invoke(name, seconds, cleanup=False):
        method = getattr(api, name + '_id')
        record = method(binding['id'], bound(seconds, cleanup))
        need(type(record) is dict, 'lifecycle-record-unassessed')
        if {'outcome', 'positiveAbsenceObserved', 'commandSent'} & set(record):
            need(name == 'unpause' and valid_absent_inverse(record, binding['id']), 'inverse-noop-receipt-differs')
            row['noOpObservations'].append({'stage': 'inside-inverse', 'observation': dict(record)})
            row['unpauseAttempted'] = False
        else:
            row['commands'].append({'operation': name, 'exitCode': record.get('exitCode'), 'reason': record.get('reason'), 'ownedChildStarted': record.get('ownedChildStarted'), 'ownedChildReaped': record.get('ownedChildReaped')})
        return record
    try:
        state = inspect()
        need(state is not None, 'producer-missing-before-pause')
        if not state['Running']:
            terminal_before_scan = True
            row.update(outcome='producer-terminal-no-sample', lifecycleVerified=True)
        else:
            need(not state['Paused'], 'producer-prepaused')
            need(clock() + LIMITS['strictScanSeconds'] + LIMITS['pauseSeconds'] + LIMITS['inspectSeconds'] < work_deadline, 'strict-scan-and-resume-reserve')
            row['pauseAttempted'] = True
            pause = invoke('pause', LIMITS['pauseSeconds'])
            state = inspect()
            need(state is not None, 'producer-missing-after-pause')
            need(complete_command(pause), 'pause-transport-incomplete')
            if not state['Running']:
                terminal_before_scan = True
                row['outcome'] = 'producer-terminal-no-sample'
            else:
                need(state['Paused'], 'pause-not-confirmed')
                paused_once = True; row['pauseConfirmed'] = True
                sample = strict_scan()
                row['sample'] = sample
                need(clock() < work_deadline, 'scan-deadline-with-resume-reserve')
                need(type(sample) is dict and sample.get('samplingComplete') is True, 'strict-sampler-incomplete')
                after = inspect()
                need(after is not None and (not after['Running'] or after['Paused']), 'pause-not-held-through-scan')
                row['samplingComplete'] = True
    except BaseException as error:
        row['primaryError'] = error.code if isinstance(error, Refusal) else type(error).__name__
        row['errors'].append(row['primaryError'])
    finally:
        def lifecycle_error(code):
            row['lifecycleErrors'].append(code); row['errors'].append(code)
        if row['pauseAttempted']:
            try:
                try:
                    state = inspect(True)
                except Refusal as error:
                    if error.code in ['producer-identity-differs', 'producer-labels-differ', 'foreign-lifecycle-id']:
                        raise  # Positive foreign identity forbids an inverse write.
                    lifecycle_error(error.code)
                    state = 'unassessed'
                except BaseException as error:
                    lifecycle_error(type(error).__name__)
                    state = 'unassessed'
                if state is None:
                    row['noOpObservations'].append({'stage': 'before-inverse', 'observation': absent_inverse_observation(binding['id'])})
                    need(inspect(True) is None, 'inverse-noop-final-absence-unproven')
                    row.update(lifecycleVerified=True, lifecycleOutcome='absent')
                elif state != 'unassessed' and (not state['Running'] or not state['Paused']):
                    row['lifecycleVerified'] = True
                    row['lifecycleOutcome'] = 'terminal' if not state['Running'] else 'resumed'
                else:
                    row['inverseRequested'] = True
                    row['unpauseAttempted'] = True
                    resumed = None
                    try:
                        resumed = invoke('unpause', LIMITS['resumeSeconds'], True)
                        if not valid_absent_inverse(resumed, binding['id']) and not complete_command(resumed): lifecycle_error('unpause-transport-incomplete')
                    except BaseException as error:
                        lifecycle_error(error.code if isinstance(error, Refusal) else type(error).__name__)
                    state = inspect(True)
                    if valid_absent_inverse(resumed, binding['id']): need(state is None, 'inverse-noop-final-absence-unproven')
                    if state is None or not state['Running'] or not state['Paused']:
                        row['lifecycleVerified'] = True
                        row['lifecycleOutcome'] = 'absent' if state is None else 'terminal' if not state['Running'] else 'resumed'
                    else:
                        # A production integration must preserve bound protected
                        # START/RESULT before this exact owned-ID removal, and
                        # retain original exit UNKNOWN when no RESULT exists.
                        try:
                            row['protectedMetadataPreservationAssessed'] = api.preserve_protected_metadata(binding, bound(LIMITS['inspectSeconds'], True)) is True
                        except BaseException as error:
                            lifecycle_error(type(error).__name__)
                        need(row['protectedMetadataPreservationAssessed'] is True, 'protected-evidence-preservation-unproven')
                        row['forcedRemovalAttempted'] = True
                        removed = invoke('force_remove', LIMITS['abortSeconds'], True)
                        if not complete_command(removed): lifecycle_error('producer-abort-transport-incomplete')
                        need(inspect(True) is None, 'producer-abort-absence-unproven')
                        row.update(lifecycleVerified=True, lifecycleOutcome='aborted-owned-producer')
                        lifecycle_error('producer-forced-abort-original-exit-unknown')
            except BaseException as error:
                lifecycle_error(error.code if isinstance(error, Refusal) else type(error).__name__)
                row['lifecycleVerified'] = False
        if clock() >= deadline: lifecycle_error('original-operation-deadline')
        row['elapsedSeconds'] = clock() - started
    if row['errors']:
        row['outcome'] = 'refused' if row['lifecycleVerified'] or not row['pauseAttempted'] else 'producer-cleanup-unproven'
    elif terminal_before_scan:
        row['outcome'] = 'producer-terminal-no-sample'
    elif paused_once and row['samplingComplete'] and row['lifecycleVerified']:
        row['outcome'] = 'complete-sample-lifecycle'
    return row
