"""Bounded C-producer raw evidence export, including incomplete/failed attempts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import zipfile

MIB = 1024 ** 2
C_BUILD_POLICY = {'sampleIntervalMs': 10000, 'maximumSamples': 9000,
                  'maximumLogBytes': 256 * MIB,
                  'workObjectPolicy': 'c-build-links-and-specials-no-follow'}
C_SAMPLING_POLICY = {'id':'owned-container-quiescent-v1','counters':'complete-fixed-root-scan','nativeDeadlineIncludesObservation':True}
REPORT_LOCATIONS = {
    'original-trap': {'source': 'original-trap', 'manifest': 'work/test-reports.json', 'root': 'work/original-test-reports'},
    'post-stop': {'source': 'post-stop', 'manifest': 'work/post-stop-reports/test-reports.json', 'root': 'work/post-stop-reports/original-test-reports'},
}
SOURCE_FILES = [
    'scripts/qualify-c-producer.mjs', 'scripts/qualify-binutils-producer.mjs',
    'scripts/producer-qualification/c-producer-profile.mjs', 'scripts/producer-qualification/c-producer-quiescent-sample.mjs', 'scripts/producer-qualification/c-producer-profiles.v1.json',
    'scripts/producer-qualification/c-producer-build.sh', 'scripts/producer-qualification/c-producer-test-reports.py',
    'scripts/producer-qualification/binutils-retention-observer.mjs', 'scripts/producer-qualification/binutils-retention-observer.py',
    'scripts/producer-qualification/binutils-image-identity.mjs', 'scripts/producer-qualification/binutils-image-identity.v1.json',
    'scripts/verify-c-producer-observation.mjs', 'scripts/producer-qualification/c-producer-export-evidence.py',
    'scripts/producer-qualification/c-producer-replay-evidence.py', '.github/workflows/upstream-glibc.yml', '.github/workflows/upstream-glibc-u13.yml',
  'scripts/verify-binutils-retention-observer.mjs', 'scripts/acquire-binutils-inputs.mjs', 'scripts/acquire-c-producer-inputs.mjs', 'scripts/producer-qualification/binutils.v1.json', 'scripts/producer-qualification/binutils-acquisition-plan.mjs', 'scripts/producer-qualification/binutils-prepare-inputs.py', 'scripts/producer-qualification/binutils-apt-index-preparation.v1.json', 'scripts/producer-qualification/binutils-input-reacquisition.v1.json',
]
SOURCE_FILES += ['scripts/producer-qualification/' + name for name in [
    'glibc-seccomp.mjs', 'glibc-seccomp.v1.json', 'glibc-seccomp-probe.py',
    'moby-28.0.4/default.json', 'moby-28.0.4/LICENSE', 'moby-28.0.4/NOTICE', 'moby-28.0.4/AUTHORS',
]]
SOURCE_FILES += ['scripts/producer-qualification/gcc-job-envelope.mjs', 'scripts/producer-qualification/gcc-github-job-clock.mjs', 'scripts/producer-qualification/emsdk-metadata-values.mjs']
SOURCE_FILES += ['scripts/producer-qualification/c-carrier-observation.mjs','scripts/observe-c-producer-carrier.mjs','.github/workflows/upstream-gcc.yml']
REPORT_CODEC_FILES=['scripts/producer-qualification/'+name for name in ['c-report-encoding.v1.json','c-producer-report-codec.mjs','c-producer-report-codec.py']]
SOURCE_FILES[SOURCE_FILES.index('scripts/producer-qualification/c-producer-test-reports.py')+1:SOURCE_FILES.index('scripts/producer-qualification/c-producer-test-reports.py')+1]=REPORT_CODEC_FILES
HISTORICAL_REPORT_COLLECTORS={'9dee7066707382c33ba971fe63ded57c407454c81ed38ab30aa66b95b558691c':18397,'653010a795c74ec4c216436449d222517998b759736634c2c44ec97368e9ab7f':24102}

LOCAL_POLICY_ID = 'local-gcc12-23h-v1'
LOCAL_POLICY_SOURCE = 'scripts/producer-qualification/gcc-local-wall-policy.v1.json'
LOCAL_POLICY_SHA256 = '9356abbf7cf21ec34646c56a95158414d2832e4402797a77e5dfce0866129bd8'
LOCAL_POLICIES = {
    LOCAL_POLICY_ID: {'source': LOCAL_POLICY_SOURCE, 'sha256': LOCAL_POLICY_SHA256},
    'local-gcc12-12h-v1': {'source': 'scripts/producer-qualification/gcc-local-12h-policy.v1.json', 'sha256': '1964d3ca86505c6fc12791cd1b58d67cbb5013f20de87300371f7a4652efc3cf'},
}


def physical(file):
    if file.resolve(strict=True) != file:
        raise RuntimeError('Linked evidence path refused')
    return file


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def evidence_format(result):
    """Select only closed formats; an unreadable receipt still gets raw export."""
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('Duplicate controller receipt key')
            value[key] = item
        return value
    try:
        file = physical(result / 'receipt.json')
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16 * MIB:
            raise ValueError('Bounded controller receipt required')
        with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as handle:
            opened = os.fstat(handle.fileno())
            if not stat.S_ISREG(opened.st_mode) or identity(opened) != identity(info):
                raise ValueError('Controller receipt changed before read')
            raw = handle.read(16 * MIB + 1)
            if len(raw) != info.st_size or identity(os.fstat(handle.fileno())) != identity(info) or identity(file.lstat()) != identity(info):
                raise ValueError('Controller receipt changed')
        receipt = json.loads(raw, object_pairs_hook=pairs)
        version = receipt.get('schemaVersion')
        if type(version) is int and version == 1 and not any(key in receipt for key in ['retentionTransportPolicy', 'reportRetention', 'retentionSamplingPolicy']):
            return 1, 'schema1'
        if (type(version) is int and version in [2, 3] and
                json.dumps(receipt.get('retentionTransportPolicy'), sort_keys=True) == json.dumps(C_BUILD_POLICY, sort_keys=True) and
                receipt.get('reportRetention') in REPORT_LOCATIONS.values() and
                ((version == 2 and 'retentionSamplingPolicy' not in receipt) or
                 (version == 3 and json.dumps(receipt.get('retentionSamplingPolicy'), sort_keys=True) == json.dumps(C_SAMPLING_POLICY, sort_keys=True)))):
            return version, 'schema'+str(version)
    except (OSError, ValueError, TypeError, AttributeError, RuntimeError):
        pass
    return 2, 'unverified'


class BoundedWriter:
    def __init__(self, handle):
        self.handle = handle

    def write(self, raw):
        if self.handle.tell() + len(raw) > 1536 * MIB:
            raise RuntimeError('C evidence archive exceeded1536MiB compressed bound')
        return self.handle.write(raw)

    def __getattr__(self, name):
        return getattr(self.handle, name)


def report_source_files(repository):
    # Source selection cannot be downgraded by a report or archive manifest.
    # Only exact known local collector bytes admit the historical source cohort.
    file=repository/'scripts/producer-qualification/c-producer-test-reports.py'
    try:
        physical(file)
        named=file.lstat()
        if not stat.S_ISREG(named.st_mode) or named.st_size>2*MIB:return SOURCE_FILES
        with os.fdopen(os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as handle:
            before=os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode) or identity(named)!=identity(before):return SOURCE_FILES
            raw=handle.read(2*MIB+1);after=os.fstat(handle.fileno())
        if identity(before)!=identity(after) or identity(file.lstat())!=identity(before) or len(raw)!=before.st_size:return SOURCE_FILES
        historical=HISTORICAL_REPORT_COLLECTORS.get(hashlib.sha256(raw).hexdigest())
        if historical is not None and historical==len(raw):return [name for name in SOURCE_FILES if name not in REPORT_CODEC_FILES]
    except (OSError,RuntimeError):
        pass
    return SOURCE_FILES


def export(repository, inputs, common, result, startup, output, logs=(), observer_check=None, profile_name='glibc', carrier=None, execution_policy=None):
    if profile_name not in ['gcc-12','glibc','glibc-u13']:
        raise RuntimeError('Unknown selected original C profile')
    if execution_policy is not None and (execution_policy not in LOCAL_POLICIES or profile_name != 'gcc-12'):
        raise RuntimeError('Unknown or foreign local execution policy')
    repository, inputs, common, result, startup, output = [Path(value).absolute() for value in [repository, inputs, common, result, startup, output]]
    physical(output.parent)
    if output.exists() or Path(str(output) + '.part').exists():
        raise RuntimeError('Archive targets must be new')
    for source in [repository, inputs, common, result]:
        if output == source or source in output.parents:
            raise RuntimeError('Evidence output overlaps source')
    version, controller_format = evidence_format(result)
    if execution_policy is not None and version not in [2, 3]:
        version, controller_format = 2, 'unverified'
    rows, names, directories, directory_identities, unavailable = [], set(), {}, {}, []
    total = 0
    report_totals = {'original-trap': 0, 'post-stop': 0}

    def directory(file, name):
        if name in directories:
            return
        physical(file)
        info = file.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Nonphysical evidence directory')
        directories[name] = {'file': name, 'nativeUid': info.st_uid, 'nativeGid': info.st_gid, 'nativeMode': stat.S_IMODE(info.st_mode), 'nativeDevice': str(info.st_dev), 'nativeInode': str(info.st_ino)}
        directory_identities[name] = (file, info)

    def add(file, name, maximum, report=None):
        nonlocal total
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9._+~/-]|%3a)*', name) or any(part in ['', '.', '..'] for part in name.split('/')) or name in names:
            raise RuntimeError('Invalid or duplicate C evidence member')
        names.add(name)
        try:
            physical(file)
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
                raise RuntimeError('Nonphysical or over-bound evidence member')
            if report is not None and report_totals[report] + info.st_size > 512 * MIB:
                raise RuntimeError('Original C report/log aggregate exceeds512MiB')
            if len(rows) >= 25000 or total + info.st_size > 2 * 1024 ** 3:
                raise RuntimeError('C evidence inventory exceeds declared bound')
            if report is not None:
                report_totals[report] += info.st_size
            total += info.st_size
            rows.append((file, name, info))
        except (OSError, RuntimeError) as error:
            unavailable.append({'file': name, 'errorClass': type(error).__name__, 'state': 'missing-inaccessible-or-outside-declared-bound'})

    add(startup, 'operator-startup.json', MIB)
    for file in report_source_files(repository) + ([LOCAL_POLICIES[execution_policy]['source']] if execution_policy is not None else []):
        add(repository / file, 'source/' + file, 2 * MIB)
    for prefix, source in [('inputs', inputs), ('common-inputs', common)]:
        add(source / 'receipt.json', prefix + '/receipt.json', 8 * MIB)
        if prefix == 'common-inputs':
            add(source / 'transform.log', prefix + '/transform.log', 8 * MIB)
            transformed = source / 'transform'
            if transformed.exists():
                physical(transformed)
                for file in sorted(transformed.iterdir()):
                    if not re.fullmatch(r'(preparation\.json|(?:release-\d+|release-mutant|release-restored|source|source-mutant|source-restored|store-\d+)\.(stdout|stderr))', file.name):
                        raise RuntimeError('Unknown original APT evidence member')
                    add(file, prefix + '/transform/' + file.name, MIB)
    for label, file in logs:
        if label not in ['common-admission', 'input-admission', 'controller']:
            raise RuntimeError('Unknown controller log role')
        add(Path(file).absolute(), 'logs/' + label + '.log', 8 * MIB)
    if observer_check:
        observed = Path(observer_check).absolute()
        add(observed / 'observations.json', 'observer-check/observations.json', MIB)
        add(observed / 'retention-observer.jsonl', 'observer-check/retention-observer.jsonl', 16 * MIB)
    for file, maximum in [
        ('receipt.json', 16 * MIB), ('build-observation.json', 2 * MIB), ('build.log', 512 * MIB),
        ('retention-observer.jsonl', (16 if version == 1 else 256) * MIB), ('custody-preflight.log', 65536),
        ('custody-preflight/test-reports.json', 65536), ('work/original-command.json', 4096),
        ('work/test-reports.json', 8 * MIB), ('work/installed-build-package-identities.txt', MIB),
    ]:
        add(result / file, 'result/' + file, maximum)
    if version in [2, 3]:
        for phase in ['requested', 'terminal']:
            name = 'work/original-command-' + phase + '.json'
            add(result / name, 'result/' + name, 4096)
        if os.path.lexists(result / 'work/post-stop-reports'):
            add(result / 'work/post-stop-reports/test-reports.json', 'result/work/post-stop-reports/test-reports.json', 8 * MIB)
        if os.path.lexists(result / 'post-stop-reports.log'):
            add(result / 'post-stop-reports.log', 'result/post-stop-reports.log', 8 * MIB)
    if profile_name in ['glibc','glibc-u13']:
        for file in ['seccomp-baseline.log','seccomp-derived.log','controls/glibc-native-seccomp.json']:
            add(result / file, 'result/' + file, 65536)
    else:
        carrier = Path(carrier).absolute() if carrier is not None else Path(str(result) + '-carrier')
        for file,maximum in [('receipt.json',MIB),('controller.log',8*MIB),('owner-frame.json',16*MIB)]:
            add(carrier / file,'carrier/' + file,maximum)
        for file,maximum in [('github-job-response.json',128*1024),('github-job-capture.json',256*1024),('.github-job-response.part',128*1024),('.github-job-capture.part',256*1024)]:
            if os.path.lexists(carrier / file):
                add(carrier / file,'carrier/' + file,maximum)
        for file,maximum in [('.receipt.part',MIB),('.owner-frame.part',16*MIB)]:
            if os.path.lexists(carrier / file):
                add(carrier / file,'carrier/failed-' + file[1:],maximum)
    report_prefixes = ['work/original-test-reports', 'custody-preflight/original-test-reports']
    if version in [2, 3]:
        report_prefixes.append('work/post-stop-reports/original-test-reports')
    for prefix in report_prefixes:
        source = result / prefix
        if source.exists():
            physical(source)
            def walk_error(error):
                unavailable.append({'file': 'result/' + prefix, 'errorClass': type(error).__name__, 'state': 'original-copy-directory-inaccessible'})
            for current, children, files in os.walk(source, followlinks=False, onerror=walk_error):
                current = Path(current)
                logical = 'result/' + prefix + (('/' + current.relative_to(source).as_posix()) if current != source else '')
                directory(current, logical)
                for child in children:
                    if (current / child).is_symlink():
                        raise RuntimeError('Linked original C copy directory refused')
                for name in sorted(files):
                    retained_relative=(current/name).relative_to(source).as_posix()
                    encoded_chunk=bool(re.fullmatch(r'encoded/[0-9]{8}\.gz',retained_relative))
                    if Path(name).suffix not in ['.sum','.trs','.log'] and not encoded_chunk:
                        raise RuntimeError('Unknown original C report/log member')
                    # Both transports retain the64MiB stored-member/512MiB
                    # stored-family cap. Decoded identities are checked separately.
                    family = 'post-stop' if prefix.startswith('work/post-stop-reports/') else 'original-trap' if prefix.startswith('work/') else None
                    add(current / name, logical + '/' + name, 64 * MIB, report=family)
    packages = result / 'work/output'
    if packages.exists():
        physical(packages)
        for file in sorted(packages.iterdir()):
            if file.suffix in ['.changes', '.buildinfo']:
                add(file, 'result/work/output/' + file.name, 4 * MIB)
    if not rows:
        raise RuntimeError('No raw C attempt observations available')
    manifest = {'schemaVersion': version, 'selectedProfile': profile_name, 'scope': 'Bounded original C receipts, reports and logs; failed attempts retained without promotion.', 'rawFiles': [], 'nativeDirectories': list(directories.values()), 'unavailable': unavailable, 'uncompressedBytes': total, 'originalReportLogBytes': report_totals['original-trap'], 'originalReportMemberByteLimit': 64 * MIB, 'originalReportAggregateByteLimit': 512 * MIB, 'binaryPackagePayloadsUploaded': False, 'nativeWorktreeArchiveUploaded': False, 'originalInputPayloadsUploaded': False, 'qualificationComplete': False, 'gateAComplete': False}
    if execution_policy is not None:
        manifest['executionPolicy'] = execution_policy
    if version in [2, 3]:
        manifest.update(controllerReceiptFormat=controller_format, retentionObserverLogByteLimit=256*MIB,
                        postStopReportLogBytes=report_totals['post-stop'], postStopReportAggregateByteLimit=512*MIB,
                        reportFamiliesRetainedSeparately=True)
    partial = Path(str(output) + '.part')
    with os.fdopen(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as handle:
        with zipfile.ZipFile(BoundedWriter(handle), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for file, name, info in rows:
                digest, size = hashlib.sha256(), 0
                with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source, archive.open(name, 'w') as target:
                    before = os.fstat(source.fileno())
                    if not stat.S_ISREG(before.st_mode) or identity(before) != identity(info):
                        raise RuntimeError('C evidence member changed before export')
                    while raw := source.read(MIB):
                        size += len(raw)
                        if size > info.st_size:
                            raise RuntimeError('C evidence member grew during export')
                        digest.update(raw)
                        target.write(raw)
                    after = os.fstat(source.fileno())
                    if identity(after) != identity(before) or identity(file.lstat()) != identity(before):
                        raise RuntimeError('C evidence member changed during export')
                if size != info.st_size:
                    raise RuntimeError('C evidence member was truncated')
                manifest['rawFiles'].append({'file': name, 'bytes': size, 'sha256': digest.hexdigest(), 'nativeUid': info.st_uid, 'nativeGid': info.st_gid, 'nativeMode': stat.S_IMODE(info.st_mode), 'nativeDevice': str(info.st_dev), 'nativeInode': str(info.st_ino)})
            archive.writestr('manifest.json', json.dumps(manifest, indent=2) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    # Independently stream the produced ZIP members, including CRC, before publish.
    with zipfile.ZipFile(partial) as archive:
        if sorted(archive.namelist()) != sorted([row['file'] for row in manifest['rawFiles']] + ['manifest.json']):
            raise RuntimeError('C exported ZIP member set differs')
        for row in manifest['rawFiles']:
            digest, size = hashlib.sha256(), 0
            with archive.open(row['file']) as source:
                while raw := source.read(MIB):
                    size += len(raw)
                    if size > row['bytes']:
                        raise RuntimeError('Exported C member exceeds observed bytes')
                    digest.update(raw)
            if size != row['bytes'] or digest.hexdigest() != row['sha256']:
                raise RuntimeError('Exported C member hash differs')
    for file, info in directory_identities.values():
        physical(file)
        after = file.lstat()
        if identity(after) != identity(info) or (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)):
            raise RuntimeError('Native original copy directory changed during export')
    os.link(partial, output)
    partial.unlink()
    return {'state': 'bounded-raw-c-attempt-exported', 'files': len(rows), 'unavailable': len(unavailable), 'originalReportLogBytes': report_totals['original-trap'], 'archiveBytes': output.stat().st_size, 'qualificationComplete': False, 'gateAComplete': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile',choices=['gcc-12','glibc','glibc-u13'],required=True)
    parser.add_argument('--carrier')
    parser.add_argument('--execution-policy', choices=list(LOCAL_POLICIES))
    for name in ['repository', 'inputs', 'common-inputs', 'result', 'startup', 'output']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--common-admission-log')
    parser.add_argument('--input-admission-log')
    parser.add_argument('--controller-log')
    parser.add_argument('--observer-check')
    args = parser.parse_args()
    logs = [(label, file) for label, file in [('common-admission', args.common_admission_log), ('input-admission', args.input_admission_log), ('controller', args.controller_log)] if file]
    print(json.dumps(export(args.repository, args.inputs, args.common_inputs, args.result, args.startup, args.output, logs, args.observer_check,args.profile,args.carrier,args.execution_policy)))
