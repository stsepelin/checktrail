"""Finite sampled disk admission; no quota, native peak or compression proof."""
import os
import shutil
import stat
from common import need, Refusal

GIB = 1024 ** 3
STAGES = {'post-materialization-before-native', 'paused-native-sample', 'stopped-before-capture'}

def plan(profile):
    limits = profile['limits']
    for key in ['workBytes', 'captureBytes', 'carrierBytes', 'freeReserve', 'minimumFreeBeforeInputs']:
        need(type(limits.get(key)) is int and limits[key] > 0, 'finite typed capacity profile')
    need(limits['workBytes'] == 28 * GIB and limits['captureBytes'] == 12 * GIB and limits['carrierBytes'] == 128 * 1024**2 and limits['freeReserve'] == 10 * GIB, 'exact reviewed working/capture/reserve profile')
    scratch = 2 * limits['captureBytes'] + 2 * limits['carrierBytes'] + limits['freeReserve']
    initial = limits['workBytes'] + scratch + 16 * GIB
    need(limits['minimumFreeBeforeInputs'] == initial == 84020297728, 'full working delta charged to startup admission')
    return {'workingLogicalAndUniqueInodeAllocationMaximumBytes': limits['workBytes'],
            'fullStoppedLogicalMaximumBytes': 32 * GIB, 'plaintextMaximumBytes': limits['captureBytes'] - 65536,
            'encryptedMaximumBytes': limits['captureBytes'], 'twoCarrierScratchBytes': 2 * limits['carrierBytes'],
            'freeReserveBytes': limits['freeReserve'], 'remainingCaptureScratchAndReserveBytes': scratch,
            'startupAncillaryAllowanceBytes': 16 * GIB, 'minimumFreeBeforeInputs': initial,
            'postMaterializationFreeRequiredBytes': limits['workBytes'] + scratch}

def observe_space(root, docker_root, profile, stage):
    need(stage in STAGES, 'exact first-party disk-admission stage')
    selected = plan(profile)
    required = selected['postMaterializationFreeRequiredBytes'] if stage == 'post-materialization-before-native' else selected['remainingCaptureScratchAndReserveBytes']
    row = {'stage': stage, 'observationComplete': False, 'accepted': False, 'actualFreeBytes': None,
           'sameFilesystem': None, 'requiredFreeBytes': required, 'observationErrorType': None,
           'observationErrno': None, 'plan': selected, 'continuousQuotaOrNativePeakFitProven': False,
           'fullWorkingAllowanceChargedAgainWithoutAssumedReclaim': stage == 'post-materialization-before-native'}
    try:
        before = os.stat(root)
        docker = os.stat(docker_root)
        free = shutil.disk_usage(root).free
        after = os.stat(root)
        docker_after = os.stat(docker_root)
        need(stat.S_ISDIR(before.st_mode) and stat.S_ISDIR(docker.st_mode) and stat.S_ISDIR(after.st_mode), 'actual disk roots remain directories')
        need((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino), 'capture root changed across disk observation')
        need((docker.st_dev, docker.st_ino) == (docker_after.st_dev, docker_after.st_ino), 'Docker root changed across disk observation')
        need(type(free) is int and free >= 0, 'actual finite physical free bytes')
        row.update(observationComplete=True, actualFreeBytes=free, sameFilesystem=before.st_dev == docker.st_dev)
        row['accepted'] = row['sameFilesystem'] and free >= required
    except (OSError, Refusal) as error:
        row.update(observationErrorType=type(error).__name__, observationErrno=getattr(error, 'errno', None))
    return row
