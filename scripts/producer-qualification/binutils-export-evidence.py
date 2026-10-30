"""Export bounded build metadata and original test/log bytes, including failed runs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import zipfile


class BoundedWriter:
    def __init__(self, handle, maximum):
        self.handle, self.maximum = handle, maximum

    def write(self, data):
        assert self.handle.tell() + len(data) <= self.maximum, 'Evidence archive exceeded byte bound'
        return self.handle.write(data)

    def __getattr__(self, name):
        return getattr(self.handle, name)


def physical(file):
    current = Path(file.anchor)
    for part in file.parts[1:]:
        current /= part
        assert not current.is_symlink(), 'Linked evidence path refused'
    return file


def export(inputs, result, output, admission_log=None, controller_log=None):
    inputs, result, output = map(lambda value: Path(value).absolute(), [inputs, result, output])
    physical(output.parent)
    assert output.parent.is_dir() and not output.exists()
    assert output not in (inputs, result) and inputs not in output.parents and result not in output.parents
    rows, names, total = [], set(), 0

    def add(file, name, maximum):
        nonlocal total
        physical(file)
        if not file.exists():
            return
        info = file.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_size <= maximum
        assert name not in names and not name.startswith('/') and '..' not in Path(name).parts
        names.add(name)
        rows.append((file, name, info))
        total += info.st_size
        assert len(rows) <= 2200 and total <= 2 * 1024**3, 'Evidence inventory exceeded bound'

    if admission_log is not None:
        add(Path(admission_log).absolute(), 'inputs/admission.log', 8 * 1024**2)
    if controller_log is not None:
        add(Path(controller_log).absolute(), 'result/controller.log', 8 * 1024**2)
    add(inputs / 'receipt.json', 'inputs/receipt.json', 2 * 1024**2)
    add(inputs / 'transform.log', 'inputs/transform.log', 8 * 1024**2)
    if (inputs / 'transform').exists():
        physical(inputs / 'transform')
        for file in sorted((inputs / 'transform').iterdir()):
            assert re.fullmatch(r'(preparation\.json|(?:release-\d+|release-mutant|release-restored|source|source-mutant|source-restored|store-\d+)\.(?:stdout|stderr))', file.name)
            add(file, 'inputs/transform/' + file.name, 1024**2)
    for file, maximum in [('receipt.json', 16 * 1024**2), ('build-observation.json', 1024**2), ('build.log', 512 * 1024**2), ('work/original-command.json', 4096), ('work/test-reports.json', 8 * 1024**2), ('work/installed-build-package-identities.txt', 1024**2)]:
        add(result / file, 'result/' + file, maximum)
    reports = result / 'work/original-test-reports'
    if reports.exists():
        physical(reports)
        for directory, directories, files in os.walk(reports, followlinks=False):
            for name in directories:
                assert not (Path(directory) / name).is_symlink()
            for name in sorted(files):
                file = Path(directory) / name
                assert file.suffix in ('.sum', '.trs', '.log')
                add(file, 'result/work/original-test-reports/' + file.relative_to(reports).as_posix(), 8 * 1024**2 if file.suffix == '.log' else 1024**2)
    assert rows, 'No original observation files available'
    partial = Path(str(output) + '.part')
    manifest = {'schemaVersion': 1, 'scope': 'Original metadata, complete declared result files and associated logs. No claim that upstream tests or global qualification passed.', 'rawFiles': [], 'uncompressedBytes': total, 'nativeWorktreeArchiveUploaded': False, 'binaryPackagesUploaded': False, 'originalInputsUploaded': False, 'qualificationComplete': False, 'gateAComplete': False}
    with partial.open('xb') as handle:
        os.chmod(partial, 0o600)
        with zipfile.ZipFile(BoundedWriter(handle, 256 * 1024**2), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for file, name, info in rows:
                digest, read = hashlib.sha256(), 0
                flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                with os.fdopen(os.open(file, flags), 'rb') as source, archive.open(name, 'w') as target:
                    before = os.fstat(source.fileno())
                    assert (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    while True:
                        chunk = source.read(1024**2)
                        if not chunk:
                            break
                        read += len(chunk)
                        assert read <= info.st_size
                        digest.update(chunk)
                        target.write(chunk)
                    after = os.fstat(source.fileno())
                    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                assert read == info.st_size
                manifest['rawFiles'].append({'file': name, 'bytes': read, 'sha256': digest.hexdigest()})
            archive.writestr('manifest.json', json.dumps(manifest, indent=2) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    # Re-read the actual ZIP members, including CRC and the original raw-byte hashes.
    with zipfile.ZipFile(partial) as archive:
        assert sorted(archive.namelist()) == sorted([row['file'] for row in manifest['rawFiles']] + ['manifest.json'])
        for row in manifest['rawFiles']:
            digest, size = hashlib.sha256(), 0
            with archive.open(row['file']) as source:
                while True:
                    chunk = source.read(1024**2)
                    if not chunk:
                        break
                    size += len(chunk)
                    assert size <= row['bytes']
                    digest.update(chunk)
            assert size == row['bytes'] and digest.hexdigest() == row['sha256']
    os.link(partial, output)
    partial.unlink()
    return {'files': len(rows), 'uncompressedBytes': total, 'archiveBytes': output.stat().st_size, 'qualificationComplete': False, 'gateAComplete': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--result', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--admission-log')
    parser.add_argument('--controller-log')
    args = parser.parse_args()
    print(json.dumps(export(args.inputs, args.result, args.output, args.admission_log, args.controller_log)))
