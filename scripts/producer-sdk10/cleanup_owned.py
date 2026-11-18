"""One exact recovered SDK-owned volume delete; bounded read-only reconciliation."""
import os
import time
from common import Refusal, encoded, freeze, need
from live_resource import TRANSPORT_REASONS, category, integer, seconds

LIMITS = {'removeSeconds': 30, 'absenceSeconds': 60, 'maximumReads': 16, 'pollSeconds': 1}

def projection(record):
    command = record.get('removeCommand') if type(record.get('removeCommand')) is dict else {}
    return {'kind': 'sdk10-owned-volume-cleanup-v1', 'role': record['role'],
            'deleteAttempted': record.get('deleteAttempted') is True,
            'deleteCommandStarted': command.get('ownedChildStarted') if type(command.get('ownedChildStarted')) is bool else None,
            'deleteCommandReaped': command.get('ownedChildReaped') if type(command.get('ownedChildReaped')) is bool else None,
            'deleteExit': integer(command.get('exitCode')),
            'deleteReason': category(command.get('reason'), TRANSPORT_REASONS, 'other-transport-refusal'),
            'positiveOwnedAbsenceObserved': record.get('positiveOwnedAbsenceObserved') is True,
            'absenceReads': len(record.get('absenceReads', [])), 'elapsedSeconds': seconds(record.get('elapsedSeconds')),
            'sourceBuildOrCustodyCredit': False, 'rawNamesPathsArgvOrErrorBodiesEmitted': False}

def remove_volume(c, name, clock=time.monotonic, sleep=time.sleep):
    volumes = [c.state['volume'], c.state['tempVolume']]
    need(len(set(volumes)) == 2 and name in volumes, 'only exact two registered SDK volumes')
    need(c.state.get('operatorFullRoundtripAcknowledged') is True and c.state.get('captureReady') is True, 'independent full recovery before owned delete')
    role = 'work' if name == volumes[0] else 'temp'
    root = c.root / 'evidence'
    request = root / ('CLEANUP-' + role + '-DELETE-REQUEST.json')
    result_path = root / ('CLEANUP-' + role + '-RESULT.json')
    # A prior/ambiguous attempt is never a reason to send a second delete.
    need(not os.path.lexists(request) and not os.path.lexists(result_path), 'owned delete already reserved')
    started = clock()
    whole_deadline = min(c.state['cleanupDeadline'], c.state['phaseDeadline'])
    need(started < whole_deadline, 'original cleanup deadline before ownership check')
    record = {'context': c.ctx, 'kind': 'volume', 'name': name, 'role': role, 'deleteAttempted': False,
              'positiveOwnedAbsenceObserved': False, 'absenceReads': [], 'removeCommand': None}
    original_phase_deadline = c.state['phaseDeadline']
    try:
        c.state['phaseDeadline'] = min(whole_deadline, clock() + 10)
        owned = c.volume_owned(name)  # exact name+context labels, before mutation
        record['originalOwnedIdentity'] = owned
        need(clock() < c.state['phaseDeadline'], 'cleanup ownership deadline')
        freeze(request, encoded({'context': c.ctx, 'role': role, 'name': name,
                                 'ownedIdentity': owned, 'oneDeleteReserved': True, 'wholeDeadline': whole_deadline}))
        need(clock() < c.state['phaseDeadline'], 'cleanup request persistence deadline')
        c.state['phaseDeadline'] = min(whole_deadline, clock() + LIMITS['removeSeconds'])
        record['deleteAttempted'] = True
        try:
            row, _ = c.docker(['volume', 'rm', name], seconds=LIMITS['removeSeconds'], check=False)
            record['removeCommand'] = row
        except BaseException as error:
            record['removeCommandErrorType'] = type(error).__name__
        # Only GET-like local Docker inspection follows. The same daemon may
        # finish the ONE original delete after its CLI lost its deadline.
        poll_deadline = min(whole_deadline, clock() + LIMITS['absenceSeconds'])
        for number in range(1, LIMITS['maximumReads'] + 1):
            if clock() >= poll_deadline:
                break
            c.state['phaseDeadline'] = min(poll_deadline, clock() + 10)
            item = {'read': number, 'positiveAbsence': False}
            try:
                current = c.inspect('volume', name)
                if current is None and clock() < poll_deadline:
                    item['positiveAbsence'] = True
                    record['positiveOwnedAbsenceObserved'] = True
                elif current is not None:
                    need(current.get('Name') == owned.get('Name') and current.get('Labels') == owned.get('Labels'), 'volume identity changed after original owned delete')
                    item['sameOwnedIdentityStillPresent'] = True
            except BaseException as error:
                item['inspectionErrorType'] = type(error).__name__
                record['absenceReads'].append(item)
                # Foreign identity is a hard stop, never a deletion target.
                if isinstance(error, Refusal) and str(error) == 'volume identity changed after original owned delete':
                    break
            else:
                record['absenceReads'].append(item)
            if record['positiveOwnedAbsenceObserved']:
                break
            if number < LIMITS['maximumReads'] and clock() < poll_deadline:
                sleep(min(LIMITS['pollSeconds'], max(0, poll_deadline - clock())))
    except BaseException as error:
        record['privateCleanupErrorType'] = type(error).__name__
        record['privateCleanupError'] = str(error)[:300]
    finally:
        stopped = clock()
        record['elapsedSeconds'] = stopped - started
        record['originalCleanupDeadline'] = whole_deadline
        if stopped >= whole_deadline:
            record['positiveOwnedAbsenceObserved'] = False
            record['cleanupBudgetExhausted'] = True
        c.state['phaseDeadline'] = original_phase_deadline
        record['privacySafeProjection'] = projection(record)
        from common import deadline_receipt
        expired = {**record, 'positiveOwnedAbsenceObserved': False}
        record = deadline_receipt(result_path, record, whole_deadline,
                                  {'positiveOwnedAbsenceObserved': False, 'cleanupBudgetExhausted': True,
                                   'privacySafeProjection': projection(expired)}, started)
        print('CHECKTRAIL_SDK10_CLEANUP_STATUS=' + __import__('json').dumps(record['privacySafeProjection'], sort_keys=True), flush=True)
    return record
