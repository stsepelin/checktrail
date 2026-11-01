"""Fixed Node producer metadata preparation; never executes upstream source."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time
import types

CATALOG_SHA256 = '7869b5297b9b4f3b319b6961e84827fcfae6e1830267f1a327ef137f008924c0'
SOURCE_HELPER_SHA256 = '14ca20a5884f91a165da06ebc101ba89dab7450ca7a1da3c97b375abb219358b'
ROOT = Path('/work/node-v22.16.0')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def identity(row):
    return (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid,
            row.st_nlink, row.st_size, row.st_mtime_ns, row.st_ctime_ns)


def read_physical(file, maximum, retain=False, expected=None):
    require(file.resolve(strict=True) == file, 'Linked metadata/tool body refused')
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, 'Physical metadata/tool bound')
    fd = os.open(str(file), os.O_RDONLY | os.O_NOFOLLOW)
    primary, secondary, chunks, size, hasher, operations = None, [], [], 0, hashlib.sha256(), 0
    try:
        require(identity(os.fstat(fd)) == identity(before), 'Physical metadata/tool open race')
        while size <= before.st_size:
            raw = os.read(fd, min(1024**2, before.st_size + 1 - size))
            operations += 1
            size += len(raw)
            hasher.update(raw)
            if retain:
                chunks.append(raw)
            if not raw:
                break
        require(size == before.st_size and identity(os.fstat(fd)) == identity(before) and
                identity(file.lstat()) == identity(before), 'Physical metadata/tool changed')
        value = {'bytes': size, 'sha256': hasher.hexdigest()}
        if expected is not None:
            require(value == {key: expected[key] for key in ['bytes', 'sha256']}, 'Exact metadata/tool bytes differ')
    except BaseException as error:
        primary = error
    finally:
        try:
            os.close(fd)
        except BaseException as error:
            secondary.append({'type': type(error).__name__, 'reason': str(error)[:256]})
            if primary is None:
                primary = error
    if primary is not None:
        primary.metadataRead = {'file': str(file), 'readOperations': operations,
                                'returnedBytes': size, 'prefixSha256': hasher.hexdigest(),
                                'cleanupFailures': secondary}
        raise primary
    return (b''.join(chunks), value) if retain else value


def tool_record(role, invocation, maximum=64 * 1024**2):
    selected = Path(invocation)
    canonical = selected.resolve(strict=True)
    require(os.access(selected, os.X_OK), 'Selected image tool is not executable')
    return {'role': role, 'invocation': invocation, 'canonicalPath': str(canonical),
            **read_physical(canonical, maximum), 'mode': stat.S_IMODE(canonical.lstat().st_mode)}


def observe_tools(catalog):
    rows = []
    for expected in catalog['tools']:
        row = tool_record(expected['role'], expected['invocation'])
        require(all(row[key] == expected[key] for key in ['role', 'invocation', 'canonicalPath', 'bytes', 'sha256']),
                'Selected original Node image tool changed')
        rows.append(row)
    compiler_lookups = []
    by_role = {row['role']: row for row in rows}
    for selector in catalog['compilerDefaultLookups']:
        invocation = shutil.which(selector['name'])
        require(invocation is not None, 'Original default compiler lookup unavailable')
        selected = by_role[selector['role']]
        canonical = Path(invocation).resolve(strict=True)
        require(str(canonical) == selected['canonicalPath'], 'Original default compiler PATH resolved differently')
        compiler_lookups.append({'name': selector['name'], 'invocation': invocation,
            'canonicalPath': str(canonical), 'bytes': selected['bytes'], 'sha256': selected['sha256']})
    candidates = []
    for candidate in catalog['pythonCandidatesInOrder']:
        resolved = shutil.which(candidate)
        if resolved is None:
            candidates.append({'candidate': candidate, 'executable': False,
                               'canonicalPath': None, 'bytes': None, 'sha256': None})
        else:
            record = tool_record('python-candidate', resolved)
            candidates.append({'candidate': candidate, 'executable': True,
                               **{key: record[key] for key in ['canonicalPath', 'bytes', 'sha256']}})
    first = next((row for row in candidates if row['executable']), None)
    selected = next(row for row in catalog['tools'] if row['role'] == 'tool-python3')
    require(first is not None and all(first[key] == selected[key] for key in ['canonicalPath', 'bytes', 'sha256']),
            'Original configure would select a different Python interpreter')
    additional = [tool_record('original-posix-shell', '/bin/sh')]
    optional_gold = shutil.which('ld.gold')
    additional.append(tool_record('optional-gold-probe', optional_gold) if optional_gold else
                      {'role': 'optional-gold-probe', 'available': False})
    return {'imageTools': rows, 'originalCompilerLookups': compiler_lookups, 'pythonCandidates': candidates, 'additionalBaseUtilities': additional,
            'compilerInterpreterOrLinkerExecutedByMetadataReader': False,
            'toolSourceBuildClosureVerified': False}


def source_file(name, maximum):
    path = ROOT / name
    if not path.exists() and not path.is_symlink():
        return {'file': name, 'state': 'absent'}
    return {'file': name, 'state': 'retained-identity', **read_physical(path, maximum),
            'mode': stat.S_IMODE(path.lstat().st_mode)}


def source_outputs(catalog):
    rows, total = [], 0
    maximum = catalog['limits']['observedWorkBytes']
    for name in catalog['selectedOutputs']:
        row = source_file(name, maximum - total)
        total += row.get('bytes', 0)
        require(total <= maximum, 'Selected output aggregate exceeds declared owned-work envelope')
        rows.append(row)
    return rows


def load_source_helper():
    raw, pin = read_physical(Path('/controls/node-original-source.py'), 32768, True)
    require(pin['sha256'] == SOURCE_HELPER_SHA256, 'Maintenance source bridge changed')
    module = types.ModuleType('verified_owned_node_source')
    exec(compile(raw, '<verified-owned-node-source>', 'exec'), module.__dict__)
    return module


def inspect_original_environment(environment):
    for name in ['CC', 'CXX', 'CI_SKIP_TESTS']:
        require(name not in environment, 'Original Node default selector overridden: ' + name)
    for key, value in [('BUILDTYPE', 'Release'), ('FLAKY_TESTS', 'run'), ('TEST_CI_ARGS', ''), ('GTEST_FILTER', '*')]:
        require(key not in environment or environment[key] == value, 'Original Node test default overridden: ' + key)
    settings = [key for key in environment if key.lower().startswith('npm_config_')]
    require(settings == ['npm_config_cache'] and environment['npm_config_cache'] == '/work/npm-cache',
            'Only the explicit owned npm cache location may be routed')


def main():
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64' and os.geteuid() == 0,
            'Fixed Linux x86_64 root-UID metadata namespace required')
    require(len(sys.argv) == 3 and sys.argv[1] in ['preflight', 'prepare', 'observe'],
            'Fixed Node metadata mode and remaining-duration grant required')
    duration = float(sys.argv[2])
    require(0 < duration <= 7200 and duration == duration and duration != float('inf'),
            'Invalid Node metadata duration grant')
    deadline = time.monotonic() + duration
    raw, pin = read_physical(Path('/controls/node-original.v1.json'), 131072, True)
    require(pin['sha256'] == CATALOG_SHA256, 'Original Node catalog changed')
    catalog = json.loads(raw)
    require(catalog['source']['root'] == ROOT.name and catalog['limits']['workSeconds'] == 7200,
            'Fixed original Node profile differs')
    inspect_original_environment(os.environ)
    tools = observe_tools(catalog)
    require(time.monotonic() < deadline, 'Node metadata admission deadline')
    if sys.argv[1] == 'prepare':
        source_bridge = load_source_helper()
        value = source_bridge.prepare_source(Path('/bundle'), Path('/work'), catalog['source'], deadline)
        for selected in catalog['source']['selectorSourcePins']:
            read_physical(ROOT / selected['file'], 2 * 1024**2, expected=selected)
        doc = catalog['docCache']
        for relative, expected_sha in [('tools/doc/package.json', doc['packageJsonSha256']),
                                       ('tools/doc/package-lock.json', doc['lockSha256'])]:
            require(read_physical(ROOT / relative, 2 * 1024**2)['sha256'] == expected_sha,
                    'Cold source documentation manifest or lock changed')
        value = {'sourceMaterialization': value, 'coldSourceDocLockBound': True}
    else:
        value = {'selectedOutputs': source_outputs(catalog)} if sys.argv[1] == 'observe' else {}
    require(time.monotonic() < deadline, 'Node metadata result exceeded grant')
    print(json.dumps({'schemaVersion': 1, 'mode': sys.argv[1], 'catalogSha256': CATALOG_SHA256,
                      'sourceOrCompilerExecutedByMetadataReader': False, **tools, **value},
                     separators=(',', ':'), ensure_ascii=True), flush=True)
    require(time.monotonic() < deadline, 'Node metadata flush exceeded grant')


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        print(json.dumps({'state': 'node-original-metadata-refused', 'type': type(error).__name__,
                          'reason': str(error)[:1024],
                          'sourcePreparation': getattr(error, 'nodeSourcePreparation', None),
                          'metadataRead': getattr(error, 'metadataRead', None),
                          'sourceCleanupFailures': getattr(error, 'sourceCleanupFailures', None)},
                         separators=(',', ':'), ensure_ascii=True), flush=True)
        raise SystemExit(2)
