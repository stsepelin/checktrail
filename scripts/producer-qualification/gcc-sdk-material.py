"""Data-only SDK inventory comparison and fixed scratch-copy support.

Comparing JSON does not establish native evidence origin or grant execution.
The reviewed hosted carrier must independently bind and physically capture both
inventories before acting on a comparison or normalizing any timestamp.
"""
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat

EXCLUDED = ('/proc', '/sys', '/dev', '/run', '/build', '/work', '/inputs',
            '/controller', '/tmp', '/var/tmp', '/var/lib/apt/lists', '/var/cache/apt/archives')
INCIDENTAL_EXACT = frozenset(('/etc/hostname', '/etc/hosts', '/etc/resolv.conf'))
MAX_ENTRIES = 500000
MAX_LOGICAL = 16 * 1024 ** 3


def require(value, message):
    if not value:
        raise ValueError(message)


def under(path, prefix):
    return path == prefix or path.startswith(prefix + '/')


def inventory(value):
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['excludedMounts'] == list(EXCLUDED),
            'Wrong original SDK inventory scope')
    require(value['timesPreserved'] == 'mtime-nanoseconds' and
            value['recreatedExternalSdkStateQualified'] is False, 'Unsupported SDK inventory provenance')
    rows = value['entries']
    require(isinstance(rows, list) and 0 < len(rows) <= MAX_ENTRIES, 'SDK inventory entry bound')
    result = {}; logical = 0
    for row in rows:
        path = row['path']
        require(isinstance(path, str) and path.startswith('/') and not path.startswith('//') and str(PurePosixPath(path)) == path and
                '\0' not in path and '..' not in PurePosixPath(path).parts and len(path.encode()) <= 4096,
                'Noncanonical SDK path')
        require(not any(under(path, prefix) for prefix in EXCLUDED), 'Mutable mount leaked into SDK inventory')
        require(path not in result, 'Duplicate SDK inventory path')
        kind = row['kind']; require(kind in ['directory', 'file', 'symlink'], 'Unsupported SDK entry kind')
        fields = {'path', 'kind', 'uid', 'gid', 'mode', 'mtimeNs'}
        if kind == 'file':
            fields |= {'bytes', 'sha256'}
            require(type(row['bytes']) is int and 0 <= row['bytes'] <= 2 * 1024 ** 3 and
                    re.fullmatch('[a-f0-9]{64}', row['sha256']), 'Invalid SDK file identity')
            logical += row['bytes']
        if kind == 'symlink':
            fields.add('target')
            require(isinstance(row['target'], str) and '\0' not in row['target'] and
                    len(row['target'].encode()) <= 4096, 'Invalid SDK symlink identity')
        require(set(row) == fields, 'Missing or extra SDK entry identity')
        for field in ['uid', 'gid', 'mode', 'mtimeNs']:
            require(type(row[field]) is int, 'Nonintegral SDK metadata')
        require(0 <= row['mode'] <= 0o7777 and 0 <= row['uid'] < 2 ** 32 and
                0 <= row['gid'] < 2 ** 32, 'Invalid SDK ownership/mode')
        require(logical <= MAX_LOGICAL, 'SDK logical byte bound')
        result[path] = row
    require('/' in result and result['/']['kind'] == 'directory', 'Missing SDK root')
    for path in result:
        if path != '/':
            parent = str(PurePosixPath(path).parent)
            require(parent in result and result[parent]['kind'] == 'directory',
                    'Missing or linked SDK ancestor')
    require(value['logicalBytes'] == logical, 'SDK logical total differs')
    return result


def compare(expected, observed, expected_packages, observed_packages):
    before, after = inventory(expected), inventory(observed)
    require(re.fullmatch('[a-f0-9]{64}', expected_packages) and
            re.fullmatch('[a-f0-9]{64}', observed_packages), 'Invalid SDK package inventory identity')
    categories = {'matched': [], 'timestampOnlyMaterial': [], 'incidentalDifferences': [], 'unresolvedMaterial': []}
    for path in sorted(before.keys() | after.keys()):
        a, b = before.get(path), after.get(path)
        if a == b:
            categories['matched'].append(path)
        elif path in INCIDENTAL_EXACT or under(path, '/var/log'):
            # Retained visible differences, not identical-root ancestry claims.
            categories['incidentalDifferences'].append({'path': path, 'expected': a, 'observed': b})
        elif a is not None and b is not None and {k:v for k,v in a.items() if k != 'mtimeNs'} == {k:v for k,v in b.items() if k != 'mtimeNs'}:
            categories['timestampOnlyMaterial'].append({'path': path, 'expectedMtimeNs': a['mtimeNs'],
                                                        'observedMtimeNs': b['mtimeNs']})
        else:
            categories['unresolvedMaterial'].append({'path': path, 'expected': a, 'observed': b})
    counts = {key: len(rows) for key, rows in categories.items()}
    total = len(before.keys() | after.keys()); require(sum(counts.values()) == total, 'SDK categories do not reconcile')
    packages_match = expected_packages == observed_packages
    return {'schemaVersion': 1, 'state': 'data-only-sdk-material-comparison', 'entries': total,
            'counts': counts, 'categories': categories, 'installedPackageInventoryMatches': packages_match,
            'materialProjectionMatches': packages_match and not categories['unresolvedMaterial'],
            'timestampNormalizationPerformed': False, 'wholeRootIdentityClaimed': False,
            'nativeEvidenceOriginAssessed': False, 'externalSdkReconstructionQualified': False,
            'fullCompilerSdkBootstrapClosureVerified': False, 'gateAComplete': False}


def clone_scratch(source, destination, codec):
    """Copy one immutable APT store as data, preserving the existing codec contract."""
    source, destination = codec.physical(Path(source)), codec.physical(Path(destination))
    require(source != destination and source not in destination.parents and destination not in source.parents,
            'Scratch source/destination overlap')
    require(destination.is_dir() and not any(destination.iterdir()), 'Fresh empty scratch mount required')
    limits = {'treeBytes': 1024 ** 3, 'entries': 10000, 'seconds': 180, 'memberBytes': 1024 ** 3}
    before = codec.snapshot(source, codec.Budget(limits))
    try:
        for row in before['entries']:
            path = destination / row['path']
            if row['path'] == '':
                continue
            if row['kind'] == 'directory':
                path.mkdir(mode=0o700)
            elif row['kind'] == 'symlink':
                os.symlink(row['target'], path)
            elif row['kind'] == 'hardlink':
                os.link(destination / row['target'], path, follow_symlinks=False)
            else:
                shutil.copyfile(source / row['path'], path, follow_symlinks=False)
        for row in reversed(before['entries']):
            codec.set_metadata(destination / row['path'], row)
        require(codec.snapshot(source, codec.Budget(limits)) == before, 'Read-only predecessor changed during scratch clone')
        require(codec.snapshot(destination, codec.Budget(limits)) == before, 'Scratch physical metadata/data replay differs')
        return {'physicalScratchCloneVerified': True, 'entries': len(before['entries']),
                'logicalBytes': before['logicalBytes'], 'sourceModified': False,
                'nativeEvidenceOriginAssessed': False, 'gateAComplete': False}
    except BaseException:
        # Only this fresh, private scratch mount was writable; never remove the
        # immutable predecessor. A failed partial clone grants no SDK evidence.
        for path in destination.iterdir():
            if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
            else: path.unlink()
        raise
