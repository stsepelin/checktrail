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
SOURCE_FILES = [
    'scripts/qualify-c-producer.mjs', 'scripts/qualify-binutils-producer.mjs',
    'scripts/producer-qualification/c-producer-profile.mjs', 'scripts/producer-qualification/c-producer-profiles.v1.json',
    'scripts/producer-qualification/c-producer-build.sh', 'scripts/producer-qualification/c-producer-test-reports.py',
    'scripts/producer-qualification/binutils-retention-observer.mjs', 'scripts/producer-qualification/binutils-retention-observer.py',
    'scripts/producer-qualification/binutils-image-identity.mjs', 'scripts/producer-qualification/binutils-image-identity.v1.json',
    'scripts/verify-c-producer-observation.mjs', 'scripts/producer-qualification/c-producer-export-evidence.py',
    'scripts/producer-qualification/c-producer-replay-evidence.py', '.github/workflows/upstream-glibc.yml',
  'scripts/verify-binutils-retention-observer.mjs', 'scripts/acquire-binutils-inputs.mjs', 'scripts/acquire-c-producer-inputs.mjs', 'scripts/producer-qualification/binutils.v1.json', 'scripts/producer-qualification/binutils-acquisition-plan.mjs', 'scripts/producer-qualification/binutils-prepare-inputs.py', 'scripts/producer-qualification/binutils-apt-index-preparation.v1.json', 'scripts/producer-qualification/binutils-input-reacquisition.v1.json',
]
SOURCE_FILES += ['scripts/producer-qualification/' + name for name in [
    'glibc-seccomp.mjs', 'glibc-seccomp.v1.json', 'glibc-seccomp-probe.py',
    'moby-28.0.4/default.json', 'moby-28.0.4/LICENSE', 'moby-28.0.4/NOTICE', 'moby-28.0.4/AUTHORS',
]]
SOURCE_FILES += ['scripts/producer-qualification/gcc-job-envelope.mjs', 'scripts/producer-qualification/gcc-github-job-clock.mjs', 'scripts/producer-qualification/emsdk-metadata-values.mjs']
SOURCE_FILES += ['scripts/producer-qualification/c-carrier-observation.mjs','scripts/observe-c-producer-carrier.mjs','.github/workflows/upstream-gcc.yml']


def physical(file):
    if file.resolve(strict=True) != file:
        raise RuntimeError('Linked evidence path refused')
    return file


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


class BoundedWriter:
    def __init__(self, handle):
        self.handle = handle

    def write(self, raw):
        if self.handle.tell() + len(raw) > 1536 * MIB:
            raise RuntimeError('C evidence archive exceeded1536MiB compressed bound')
        return self.handle.write(raw)

    def __getattr__(self, name):
        return getattr(self.handle, name)


def export(repository, inputs, common, result, startup, output, logs=(), observer_check=None, profile_name='glibc', carrier=None):
    if profile_name not in ['gcc-12','glibc']:
        raise RuntimeError('Unknown selected original C profile')
    repository, inputs, common, result, startup, output = [Path(value).absolute() for value in [repository, inputs, common, result, startup, output]]
    physical(output.parent)
    if output.exists() or Path(str(output) + '.part').exists():
        raise RuntimeError('Archive targets must be new')
    for source in [repository, inputs, common, result]:
        if output == source or source in output.parents:
            raise RuntimeError('Evidence output overlaps source')
    rows, names, directories, directory_identities, unavailable = [], set(), {}, {}, []
    total = report_total = 0

    def directory(file, name):
        if name in directories:
            return
        physical(file)
        info = file.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Nonphysical evidence directory')
        directories[name] = {'file': name, 'nativeUid': info.st_uid, 'nativeGid': info.st_gid, 'nativeMode': stat.S_IMODE(info.st_mode), 'nativeDevice': str(info.st_dev), 'nativeInode': str(info.st_ino)}
        directory_identities[name] = (file, info)

    def add(file, name, maximum, report=False):
        nonlocal total, report_total
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9._+~/-]|%3a)*', name) or any(part in ['', '.', '..'] for part in name.split('/')) or name in names:
            raise RuntimeError('Invalid or duplicate C evidence member')
        names.add(name)
        try:
            physical(file)
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
                raise RuntimeError('Nonphysical or over-bound evidence member')
            if report and report_total + info.st_size > 512 * MIB:
                raise RuntimeError('Original C report/log aggregate exceeds512MiB')
            if len(rows) >= 25000 or total + info.st_size > 2 * 1024 ** 3:
                raise RuntimeError('C evidence inventory exceeds declared bound')
            if report:
                report_total += info.st_size
            total += info.st_size
            rows.append((file, name, info))
        except (OSError, RuntimeError) as error:
            unavailable.append({'file': name, 'errorClass': type(error).__name__, 'state': 'missing-inaccessible-or-outside-declared-bound'})

    add(startup, 'operator-startup.json', MIB)
    for file in SOURCE_FILES:
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
        ('retention-observer.jsonl', 16 * MIB), ('custody-preflight.log', 65536),
        ('custody-preflight/test-reports.json', 65536), ('work/original-command.json', 4096),
        ('work/test-reports.json', 8 * MIB), ('work/installed-build-package-identities.txt', MIB),
    ]:
        add(result / file, 'result/' + file, maximum)
    if profile_name == 'glibc':
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
    for prefix in ['work/original-test-reports', 'custody-preflight/original-test-reports']:
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
                    if Path(name).suffix not in ['.sum', '.trs', '.log']:
                        raise RuntimeError('Unknown original C report/log member')
                    # C has its own64MiB member/512MiB aggregate contract.
                    add(current / name, logical + '/' + name, 64 * MIB, report=prefix.startswith('work/'))
    packages = result / 'work/output'
    if packages.exists():
        physical(packages)
        for file in sorted(packages.iterdir()):
            if file.suffix in ['.changes', '.buildinfo']:
                add(file, 'result/work/output/' + file.name, 4 * MIB)
    if not rows:
        raise RuntimeError('No raw C attempt observations available')
    manifest = {'schemaVersion': 1, 'selectedProfile': profile_name, 'scope': 'Bounded original C receipts, reports and logs; failed attempts retained without promotion.', 'rawFiles': [], 'nativeDirectories': list(directories.values()), 'unavailable': unavailable, 'uncompressedBytes': total, 'originalReportLogBytes': report_total, 'originalReportMemberByteLimit': 64 * MIB, 'originalReportAggregateByteLimit': 512 * MIB, 'binaryPackagePayloadsUploaded': False, 'nativeWorktreeArchiveUploaded': False, 'originalInputPayloadsUploaded': False, 'qualificationComplete': False, 'gateAComplete': False}
    partial = Path(str(output) + '.part')
    with os.fdopen(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as handle:
        with zipfile.ZipFile(BoundedWriter(handle), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for file, name, info in rows:
                digest, size = hashlib.sha256(), 0
                with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source, archive.open(name, 'w') as target:
                    before = os.fstat(source.fileno())
                    if identity(before) != identity(info):
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
    return {'state': 'bounded-raw-c-attempt-exported', 'files': len(rows), 'unavailable': len(unavailable), 'originalReportLogBytes': report_total, 'archiveBytes': output.stat().st_size, 'qualificationComplete': False, 'gateAComplete': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile',choices=['gcc-12','glibc'],required=True)
    parser.add_argument('--carrier')
    for name in ['repository', 'inputs', 'common-inputs', 'result', 'startup', 'output']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--common-admission-log')
    parser.add_argument('--input-admission-log')
    parser.add_argument('--controller-log')
    parser.add_argument('--observer-check')
    args = parser.parse_args()
    logs = [(label, file) for label, file in [('common-admission', args.common_admission_log), ('input-admission', args.input_admission_log), ('controller', args.controller_log)] if file]
    print(json.dumps(export(args.repository, args.inputs, args.common_inputs, args.result, args.startup, args.output, logs, args.observer_check,args.profile,args.carrier)))
