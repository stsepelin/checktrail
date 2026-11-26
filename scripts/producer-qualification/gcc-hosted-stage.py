"""Fixed container body for the true configure boundary of the GCC producer.

Only an operator-reviewed carrier may execute this file. Importing it is inert.
No configurable shell commands or source flags are accepted.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import time

LANGUAGES = 'c,ada,c++,go,d,fortran,objc,obj-c++,m2'
EXTERNAL_EXCLUDED = ('/proc', '/sys', '/dev', '/run', '/build', '/work', '/inputs',
                     '/controller', '/tmp', '/var/tmp', '/var/lib/apt/lists', '/var/cache/apt/archives')
FIXED_ENVIRONMENT = {'HOME': '/work/home', 'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                     'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'DEBIAN_FRONTEND': 'noninteractive'}
DPKG = ['dpkg-buildpackage', '-b', '-us', '-uc', '--jobs=4']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def external_inventory(root=Path('/'), excluded=EXTERNAL_EXCLUDED, maximum_seconds=900):
    """Hash complete non-mount ordinary state; never follow a symlink."""
    started = time.monotonic()
    rows = []
    logical = 0
    stack = [Path(root)]
    while stack:
        path = stack.pop()
        logical_path = '/' + str(path.relative_to(root)) if path != root else '/'
        if logical_path == '/.':
            logical_path = '/'
        if any(logical_path == prefix or logical_path.startswith(prefix + '/') for prefix in excluded):
            continue
        require(time.monotonic() - started < maximum_seconds, 'External SDK inventory deadline')
        before = path.lstat()
        row = {'path': logical_path, 'uid': before.st_uid, 'gid': before.st_gid,
               'mode': stat.S_IMODE(before.st_mode), 'mtimeNs': before.st_mtime_ns}
        if stat.S_ISDIR(before.st_mode):
            row['kind'] = 'directory'
            stack.extend(sorted(path.iterdir(), reverse=True))
        elif stat.S_ISLNK(before.st_mode):
            row.update(kind='symlink', target=os.readlink(path))
        elif stat.S_ISREG(before.st_mode):
            require(before.st_size <= 2 * 1024 ** 3, 'External SDK file bound')
            digest = hashlib.sha256()
            with path.open('rb') as source:
                while True:
                    require(time.monotonic() - started < maximum_seconds, 'External SDK file deadline')
                    raw = source.read(1024 ** 2)
                    if not raw:
                        break
                    digest.update(raw)
            logical += before.st_size
            row.update(kind='file', bytes=before.st_size, sha256=digest.hexdigest())
        else:
            raise ValueError('Uncaptured external special state: ' + logical_path)
        after = path.lstat()
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_mode,
                 before.st_uid, before.st_gid) == (after.st_dev, after.st_ino, after.st_size,
                 after.st_mtime_ns, after.st_mode, after.st_uid, after.st_gid), 'External SDK input changed while hashing')
        rows.append(row)
        require(len(rows) <= 500000 and logical <= 16 * 1024 ** 3, 'External SDK inventory bound')
    return {'schemaVersion': 1, 'excludedMounts': list(excluded), 'entries': rows,
            'logicalBytes': logical, 'timesPreserved': 'mtime-nanoseconds',
            'recreatedExternalSdkStateQualified': False}


def selected_configuration(config, planner):
    planner.plan(config)
    values = config['variables']
    for key in ['with_check', 'with_jit', 'with_offload_nvptx', 'with_offload_gcn',
                'with_hppa64', 'with_cxx', 'with_ada']:
        require(values[key] == 'yes', 'Retained full default producer branch changed: ' + key)
    flags = shlex.split(values['CONFARGS'])
    require([token for token in flags if token.startswith('--enable-languages=')] ==
            ['--enable-languages=' + LANGUAGES], 'Retained original main language selection changed')
    require('--enable-multilib' in flags and '--disable-multilib' not in flags,
            'Retained original multilib selection changed')
    offloads = [token for token in flags if token.startswith('--enable-offload-targets=')]
    require(len(offloads) == 1, 'Original offload configuration unavailable')
    targets = {item.split('=', 1)[0] for item in offloads[0].split('=', 1)[1].split(',')}
    require(targets == {'nvptx-none', 'amdgcn-amdhsa'}, 'Original offload target family changed')
    return {'configurationSha256': planner.sha(planner.canonical(config)), 'mainLanguages': LANGUAGES,
            'multilib': True, 'originalBootstrapTarget': values['bootstrap_target'],
            'selectedDefaultBranches': ['native', 'jit', 'nvptx', 'gcn', 'hppa64', 'check', 'default-build', 'packages'],
            'allExpandedFlagsBound': True, 'nativeLaterBranchesCompleted': False}


def command_record(command, cwd, records, label):
    started = time.monotonic()
    request = {'schemaVersion': 1, 'label': label, 'command': command, 'cwd': str(cwd),
               'state': 'requested', 'elapsedSeconds': 0, 'exitCode': None}
    with records.open('ab') as sink:
        sink.write(canonical(request) + b'\n')
        sink.flush()
        os.fsync(sink.fileno())
    # Shell=False is deliberate. Only these fixed commands enter trusted source.
    result = subprocess.run(command, cwd=cwd, check=False)
    terminal = {**request, 'state': 'terminal', 'elapsedSeconds': time.monotonic() - started,
                'exitCode': result.returncode if result.returncode >= 0 else None,
                'signal': -result.returncode if result.returncode < 0 else None,
                'terminalObserved': True}
    with records.open('ab') as sink:
        sink.write(canonical(terminal) + b'\n')
        sink.flush()
        os.fsync(sink.fileno())
    require(result.returncode == 0, 'Original native command failed: ' + label)
    return terminal


def main():
    require(sys.argv == [sys.argv[0], 'configure'], 'Unknown fixed first-stage goal')
    require(os.getuid() == 0 and all(os.environ.get(key) == value for key, value in FIXED_ENVIRONMENT.items()),
            'Original selected container environment changed')
    require(set(os.environ) <= set(FIXED_ENVIRONMENT) | {'PWD', 'SHLVL', '_'}, 'Unexpected inherited producer environment')
    work = Path('/work')
    (work / 'home').mkdir(mode=0o700, exist_ok=True)
    (work / 'gcc-staged-configuration').mkdir(mode=0o700, exist_ok=False)
    records = work / 'native-commands.jsonl'
    require(not records.exists() and not Path('/build/source').exists(), 'First stage cannot reuse stale native state')
    descriptor = '/inputs/gcc-12/gcc-12_12.2.0-14+deb12u1.dsc'
    apt = ['apt-get', '-o', 'APT::Get::AllowUnauthenticated=false', '-o',
           'Acquire::AllowInsecureRepositories=false', '-o', 'Acquire::AllowDowngradeToInsecureRepositories=false',
           '-o', 'Acquire::Check-Valid-Until=true', '-o', 'Dir::Cache::archives=/var/cache/apt/archives/gcc-12',
           '--yes', '--no-download', '--no-install-recommends', 'build-dep', descriptor]
    preparation = [command_record(apt, work, records, 'offline-original-apt-build-dep')]
    with (work / 'installed-build-package-identities.txt').open('xb') as sink:
        subprocess.run(['dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\n'], stdout=sink, check=True)
    preparation.append(command_record(['dpkg-source', '--require-valid-signature', '--require-strong-checksums',
                                       '--extract', descriptor, '/build/source'], work, records, 'signed-source-extract'))
    source = Path('/build/source')
    require((source / 'gcc-12.2.0-dfsg.tar.xz').is_file() and (source / 'debian/control').is_file(),
            'Original GCC source body unavailable')
    preparation.append(command_record(['dpkg-checkbuilddeps', 'debian/control'], source, records, 'original-build-dependencies'))
    preparation.append(command_record(['dpkg-source', '--before-build', '.'], source, records, 'original-source-before-build'))
    preparation.append(command_record([*DPKG, '--rules-target=clean'], source, records, 'explicit-original-preclean'))
    sdk_before = external_inventory()
    (work / 'external-sdk-before.json').write_bytes(canonical(sdk_before) + b'\n')
    configure = command_record([*DPKG, '--rules-target=configure'], source, records, 'configure')
    capture = command_record([*DPKG, '--rules-file=/controller/gcc-staged-rules2.sh',
                              '--rules-target=checktrail-print-configuration'], source, records, 'original-configured-variables')
    planner = load(Path('/controller/gcc-staged-plan.py'))
    config = planner.read_configuration(work / 'gcc-staged-configuration', source)
    selected = selected_configuration(config, planner)
    (work / 'configured-values.json').write_bytes(canonical(config) + b'\n')
    (work / 'selected-default-graph.json').write_bytes(canonical(selected) + b'\n')
    require((source / 'stamps/04-configure-stamp').is_file(), 'Original configure stamp unavailable')
    sdk_after = external_inventory()
    (work / 'external-sdk-after.json').write_bytes(canonical(sdk_after) + b'\n')
    require(sdk_before == sdk_after, 'Native first stage modified uncaptured external SDK state')
    (work / 'FIRST-STAGE.json').write_bytes(canonical({
        'schemaVersion': 1, 'state': 'native-configure-terminal-and-selected-configuration-observed',
        'profile': planner.PROFILE, 'preparation': preparation, 'configure': configure,
        'configurationCapture': capture, 'selectedConfiguration': selected,
        'externalSdkUnchanged': True, 'externalSdkSha256': hashlib.sha256(canonical(sdk_before)).hexdigest(),
        'packageInventorySha256': hashlib.sha256((work / 'installed-build-package-identities.txt').read_bytes()).hexdigest(),
        'laterSelectedBranchesCompleted': False, 'originalUninterruptedDpkgCommandCompleted': False,
        'fullCompilerSdkBootstrapClosureVerified': False, 'gateAComplete': False}) + b'\n')


if __name__ == '__main__':
    main()
