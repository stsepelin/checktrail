"""Closed single-entry phase-0 cache envelope and independent restore replay.

This module never executes producer/project code and never changes cache quota
or deletes a cache entry. Cache save/restore are pinned workflow action steps.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import time
import tempfile
import urllib.parse


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def bounded_file(path, maximum):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum,
            'Missing bounded ordinary transport member')
    return path.read_bytes()


def archive_identity(path, maximum):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum,
            'Missing bounded transport archive')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            raw = stream.read(1024 ** 2)
            if not raw:
                break
            digest.update(raw)
    return {'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def transport_path(environment):
    root = Path(environment['RUNNER_TEMP'])
    require(root.is_absolute() and root.resolve() == root and not root.is_symlink(), 'Physical runner-temp required')
    return root / 'gcc-phase0-transport'


def key(selected):
    return 'gcc-phase0-' + selected['GITHUB_SHA'] + '-' + selected['GITHUB_RUN_ID'] + '-' + selected['GITHUB_RUN_ATTEMPT']


def prepare(output, capacity, selected, environment, codec):
    path = transport_path(environment)
    require(not path.exists() and not path.is_symlink(), 'Phase-0 transport path already exists')
    runner_uid = int(environment['SUDO_UID'])
    runner_gid = int(environment['SUDO_GID'])
    require(runner_uid > 0 and runner_gid > 0 and os.getuid() == 0, 'Original nonroot workflow reader identity required')
    members = {'receipt.json': bounded_file(output / 'checkpoint/receipt.json', 65536),
               'CHECKPOINT-ROOT.json': bounded_file(output / 'CHECKPOINT-ROOT.json', 1024 ** 2),
               'PHASE-LEDGER.json': bounded_file(output / 'PHASE-LEDGER.json', 1024 ** 2)}
    envelope = capacity.measure_envelope(members)
    archive = archive_identity(output / 'checkpoint/tree.tar.gz', capacity.CHECKPOINT_BYTES)
    receipt = json.loads(members['receipt.json'])
    require(receipt['archiveSha256'] == archive['sha256'] and receipt['archiveBytes'] == archive['bytes'],
            'Measured source archive differs before envelope creation')
    expected = {'schemaVersion': 1, 'key': key(selected), 'ref': selected['GITHUB_REF'],
        'source': selected, 'archive': archive, 'envelope': envelope,
        'members': {name: {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for name, raw in members.items()},
        'checkpointCompressedByteLimit': capacity.CHECKPOINT_BYTES,
        'envelopeByteLimit': capacity.ENVELOPE_BYTES, 'cacheSaved': False, 'restoreReplayed': False,
        'laterPhaseCapacityQualified': False}
    expected_path = output / 'TRANSPORT-EXPECTED.json'
    require(not expected_path.exists() and not expected_path.is_symlink(), 'Independent transport expectation already exists')
    stage = Path(tempfile.mkdtemp(prefix='.gcc-phase0-transport-', dir=path.parent))
    try:
        os.chown(stage, 0, runner_gid)
        stage.chmod(0o750)
        for name, raw in members.items():
            target = stage / name
            target.write_bytes(raw)
            os.chown(target, 0, runner_gid)
            target.chmod(0o440)
        # Same owned filesystem, read-only host hardlink; no second archive copy.
        os.link(output / 'checkpoint/tree.tar.gz', stage / 'tree.tar.gz', follow_symlinks=False)
        os.chown(stage / 'tree.tar.gz', 0, runner_gid)
        (stage / 'tree.tar.gz').chmod(0o440)
        expected_path.write_bytes(canonical(expected))
        expected_path.chmod(0o600)
        # Publish only the complete closed inventory. An expectation without a
        # published directory remains an intent record and cannot be restored.
        codec.rename_no_replace(stage, path)
        return expected
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def expected_record(output, selected, capacity):
    path = output / 'TRANSPORT-EXPECTED.json'
    require(path.stat().st_uid == 0 and stat.S_IMODE(path.stat().st_mode) == 0o600,
            'Independent expected transport record ownership changed')
    value = json.loads(bounded_file(path, 1024 ** 2))
    require(value['source'] == selected and value['key'] == key(selected) and value['ref'] == selected['GITHUB_REF'] and
            value['checkpointCompressedByteLimit'] == capacity.CHECKPOINT_BYTES and
            value['envelopeByteLimit'] == capacity.ENVELOPE_BYTES, 'Wrong independent source/policy transport frame')
    return value


def prepare_restore(output, selected, capacity, codec, environment):
    expected = expected_record(output, selected, capacity)
    original = transport_path(environment)
    moved = original.with_name(original.name + '-captured-original')
    marker = output / 'SERVICE-RESTORE-REQUEST.json'
    require(original.is_dir() and not original.is_symlink() and not moved.exists() and not moved.is_symlink(),
            'Fresh exact-path cache replay unavailable')
    require(not marker.exists() and not marker.is_symlink(), 'Stale service-restore request')
    codec.rename_no_replace(original, moved)
    require(not original.exists(), 'Original cache path must be absent before service restore')
    marker.write_bytes(canonical({'expectedSha256': hashlib.sha256(canonical(expected)).hexdigest(),
        'movedPath': str(moved), 'movedDevice': moved.stat().st_dev, 'movedInode': moved.stat().st_ino,
        'restoreTargetMissingObserved': True}))
    marker.chmod(0o600)
    return {'originalMovedAside': True, 'restorePath': str(original), 'key': key(selected),
            'sourceOrCompilerExecuted': False}


def verify(output, selected, capacity, codec, planner, api, environment):
    expected = expected_record(output, selected, capacity)
    path = transport_path(environment)
    request_path = output / 'SERVICE-RESTORE-REQUEST.json'
    require(request_path.stat().st_uid == 0 and stat.S_IMODE(request_path.stat().st_mode) == 0o600,
            'Independent service-restore request ownership changed')
    request = json.loads(bounded_file(request_path, 65536))
    moved = path.with_name(path.name + '-captured-original')
    require(request['expectedSha256'] == hashlib.sha256(canonical(expected)).hexdigest() and
            request['movedPath'] == str(moved) and request['restoreTargetMissingObserved'] is True and
            moved.is_dir() and not moved.is_symlink() and
            (moved.stat().st_dev, moved.stat().st_ino) == (request['movedDevice'], request['movedInode']),
            'Original cache bytes were not independently moved aside')
    require(path.is_dir() and not path.is_symlink() and
            set(item.name for item in path.iterdir()) == {'tree.tar.gz', *expected['members']},
            'Missing/extra replayed transport member')
    require((path.stat().st_dev, path.stat().st_ino) != (request['movedDevice'], request['movedInode']),
            'Old local directory cannot stand in for a service cache restore')
    require(archive_identity(path / 'tree.tar.gz', capacity.CHECKPOINT_BYTES) == expected['archive'],
            'Restored cache archive differs from independent captured identity')
    for name, pin in expected['members'].items():
        raw = bounded_file(path / name, 1024 ** 2)
        require(len(raw) == pin['bytes'] and hashlib.sha256(raw).hexdigest() == pin['sha256'],
                'Replayed cache metadata differs: ' + name)
    root = json.loads((path / 'CHECKPOINT-ROOT.json').read_bytes())
    checkpoint_dir = output / 'service-restored-checkpoint'
    require(not checkpoint_dir.exists(), 'Service replay checkpoint path already exists')
    checkpoint_dir.mkdir(mode=0o700)
    for name in ['tree.tar.gz', 'receipt.json']:
        os.link(path / name, checkpoint_dir / name, follow_symlinks=False)
    destination = output / 'service-physical-readback'
    receipt = codec.restore(checkpoint_dir, destination, root['binding'], expected['archive']['sha256'],
                            limits={'treeBytes': capacity.STATE_CEILING_BYTES,
                                    'archiveBytes': capacity.CHECKPOINT_BYTES, 'expandedBytes': 12 * capacity.GIB,
                                    'seconds': 900})
    require(receipt['physicalTreeVerified'], 'Service-restored physical source/report/state replay unavailable')
    # The full mount state is restored at fresh physical paths as data; no
    # source, compiler or package script is run during this independent replay.
    config = planner.read_configuration(destination / '__carrier_work/gcc-staged-configuration', destination / 'source')
    require(planner.sha(planner.canonical(config)) == root['binding']['configurationSha256'],
            'Service-restored configured source graph differs')
    ledger = json.loads((path / 'PHASE-LEDGER.json').read_bytes())
    _, _, _, index, last = planner.validate_ledger(ledger, config)
    require(index == 1 and last == expected['archive']['sha256'], 'Cache replay cannot skip/advance beyond configure')
    service = capacity.capture_service(api, selected)
    require(service['clock']['remainingSeconds'] >= 60 and
            service['cache']['observedOccupiedBytes'] <= capacity.FREE_CACHE_BYTES,
            'Source service/free-included storage bound unavailable after replay')
    query = '/repos/' + capacity.base.REPOSITORY + '/actions/caches?per_page=100&key=' + urllib.parse.quote(expected['key'], safe='') + '&ref=' + urllib.parse.quote(selected['GITHUB_REF'], safe='')
    listing, _ = api.get(query)
    require(0 < listing['total_count'] <= 100 and len(listing['actions_caches']) == listing['total_count'],
            'Bounded exact-key cache inventory unavailable')
    entries = [row for row in listing['actions_caches'] if row['key'] == expected['key'] and row['ref'] == expected['ref']]
    require(len(entries) == 1, 'Exact source cache identity unavailable or ambiguous')
    entry = entries[0]
    require(type(entry['size_in_bytes']) is int and 0 < entry['size_in_bytes'] <=
            capacity.CHECKPOINT_BYTES + capacity.ENVELOPE_BYTES, 'Measured service cache wrapper exceeds phase-0 envelope bound')
    envelope_delta = entry['size_in_bytes'] - expected['archive']['bytes']
    result = {'schemaVersion': 1, 'state': 'phase0-service-cache-restored-and-physical-state-replayed',
        'source': selected, 'cacheId': entry['id'], 'cacheKey': expected['key'], 'cacheRef': expected['ref'],
        'actualServiceStoredBytes': entry['size_in_bytes'], 'capturedArchiveBytes': expected['archive']['bytes'],
        'serviceStoredBytesMinusCapturedArchiveBytes': envelope_delta,
        'envelopeByteLimit': capacity.ENVELOPE_BYTES, 'cacheSaveAndRestoreReplayed': True,
        'fullSourceReportsAndMountStatePhysicallyReplayed': True, 'receipt': receipt,
        'phaseLedger': ledger, 'nextPhase': 'native', 'sharedCacheReservationGuaranteed': False,
        'laterPhaseCapacityQualified': False, 'originalUninterruptedDpkgCommandCompleted': False,
        'fullCompilerSdkBootstrapClosureVerified': False, 'gateAComplete': False}
    (output / 'TRANSPORT-REPLAY.json').write_bytes(canonical(result))
    (output / 'FINAL-PHASE-LEDGER.json').write_bytes(planner.canonical(ledger))
    shutil.rmtree(destination)
    return result
