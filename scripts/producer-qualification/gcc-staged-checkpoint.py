"""Closed GCC12 continuation/checkpoint primitives. No producer runs on import.

This development-only controller never equates phase/checkpoint completion with
the frozen uninterrupted dpkg invocation or with successful upstream tests.
"""
import argparse
import ctypes
import sys
from decimal import Decimal
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile
import time

PROFILE = 'debian-gcc12-hosted-continuation-v1'
CATALOG = '3e22395e92f732e1b30cf972c6f6d660f5e499562038ed31a342b018f8d481bd'
IMAGE = 'docker.io/coqorg/coq@sha256:1f69b9224f068d408e6be7a3f536f67395d00c3497b97bdb99ee2d2c4c91954c'
LIMITS = {'entries': 1000000, 'treeBytes': 64 * 1024**3,
          'archiveBytes': 4000000000, 'expandedBytes': 80 * 1024**3,
          'manifestBytes': 256 * 1024**2, 'memberBytes': 2 * 1024**3,
          'seconds': 1500, 'maxPathBytes': 4096}

def require(value, message):
    if not value: raise ValueError(message)

def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()

def sha(body): return hashlib.sha256(body).hexdigest()

def relative(name):
    require(isinstance(name, str) and name and len(name.encode()) <= LIMITS['maxPathBytes'], 'Invalid relative path')
    require('\\' not in name and '\0' not in name and not name.startswith('/'), 'Unsafe relative path')
    require(all(part not in ('', '.', '..') for part in name.split('/')), 'Unsafe path component')
    return name

def physical(path):
    path = Path(path)
    require(path.is_absolute() and path == path.resolve(), 'Canonical physical path required')
    for part in reversed((path, *path.parents)):
        require(not stat.S_ISLNK(part.lstat().st_mode), 'Linked physical path')
    return path

class Budget:
    def __init__(self, limits=None):
        self.limits = {**LIMITS, **(limits or {})}; self.started = time.monotonic()
        self.expanded = 0
    def tick(self): require(time.monotonic() - self.started < self.limits['seconds'], 'Checkpoint deadline')
    def add(self, count):
        self.tick(); self.expanded += count
        require(self.expanded <= self.limits['expandedBytes'], 'Expanded checkpoint limit')

def metadata(info):
    return {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid,
            'gid': info.st_gid, 'mtimeNs': info.st_mtime_ns}

def identify(path, budget, maximum=None):
    before = path.lstat(); require(stat.S_ISREG(before.st_mode), 'Expected physical regular file')
    require(before.st_size <= (budget.limits['memberBytes'] if maximum is None else maximum), 'Checkpoint member limit')
    digest = hashlib.sha256(); total = 0
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'File changed before open')
        while True:
            budget.tick(); body = stream.read(65536)
            if not body: break
            total += len(body); require(total <= before.st_size, 'File grew during snapshot'); digest.update(body)
    after = path.lstat()
    require((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_mode, after.st_uid, after.st_gid) ==
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_mode, before.st_uid, before.st_gid), 'File changed during snapshot')
    require(total == before.st_size, 'File shrank during snapshot')
    return digest.hexdigest(), total

def snapshot(root, budget):
    root = physical(root); require(root.is_dir(), 'Checkpoint root is not a directory')
    rows = [{'path': '', 'kind': 'directory', **metadata(root.stat())}]
    pending = [root]; inodes = {}; links = {}; logical = 0
    while pending:
        folder = pending.pop()
        for entry in sorted(os.scandir(folder), key=lambda row: row.name):
            budget.tick(); path = Path(entry.path); name = relative(path.relative_to(root).as_posix())
            info = path.lstat(); row = {'path': name, **metadata(info)}
            if stat.S_ISDIR(info.st_mode): row['kind'] = 'directory'; pending.append(path)
            elif stat.S_ISLNK(info.st_mode):
                target = os.readlink(path); require(len(target.encode()) <= 4096 and '\0' not in target, 'Symlink target limit')
                row.update(kind='symlink', target=target); logical += len(target.encode())
                require(path.lstat().st_mtime_ns == info.st_mtime_ns, 'Symlink changed during snapshot')
            elif stat.S_ISREG(info.st_mode):
                identity = (info.st_dev, info.st_ino); links[identity] = links.get(identity, 0) + 1
                body_sha, size = identify(path, budget); logical += size
                row.update(kind='file', bytes=size, sha256=body_sha, _inode=identity)
                inodes.setdefault(identity, {'nlink': info.st_nlink})
            else: raise ValueError('Unsupported special checkpoint entry: ' + name)
            rows.append(row)
            require(len(rows) <= budget.limits['entries'] and logical <= budget.limits['treeBytes'], 'Checkpoint tree limit')
    for identity, row in inodes.items(): require(links[identity] == row['nlink'], 'External hardlink aliases are not restorable')
    rows.sort(key=lambda row: row['path'])
    first = {}
    for row in rows:
        identity = row.pop('_inode', None)
        if identity is None: continue
        if identity in first: row.update(kind='hardlink', target=first[identity])
        else: first[identity] = row['path']
    return {'schemaVersion': 1, 'logicalRoot': '/build', 'entries': rows, 'logicalBytes': logical,
            'timestampContract': 'mtime-nanoseconds; inode/device/ctime/atime continuity is not claimed',
            'symlinkContract': 'exact inert targets, never followed; external target identities require the pinned carrier inventory'}

def validate_binding(binding):
    require(set(binding) == {'profile', 'catalogSha256', 'image', 'platform', 'sourceVersion', 'configurationSha256', 'packageInventorySha256', 'sourceEpochSha256', 'phase', 'sequence', 'predecessorSha256'}, 'Wrong continuation binding fields')
    require(binding['profile'] == PROFILE and binding['catalogSha256'] == CATALOG and binding['image'] == IMAGE, 'Wrong pinned GCC source/image/profile')
    require(binding['platform'] == 'linux/amd64' and binding['sourceVersion'] == '12.2.0-14+deb12u1', 'Wrong producer version/platform')
    for key in ['configurationSha256', 'packageInventorySha256', 'sourceEpochSha256']:
        require(isinstance(binding[key], str) and re.fullmatch('[a-f0-9]{64}', binding[key]), 'Invalid identity: ' + key)
    require(type(binding['sequence']) is int and 0 <= binding['sequence'] < 64, 'Invalid continuation sequence')
    require(binding['predecessorSha256'] is None if binding['sequence'] == 0 else isinstance(binding['predecessorSha256'], str) and re.fullmatch('[a-f0-9]{64}', binding['predecessorSha256']), 'Invalid predecessor binding')
    require(binding['phase'] in ['configure', 'native', 'jit', 'nvptx', 'gcn', 'hppa64', 'check', 'default-build', 'packages'], 'Unknown GCC phase')
    return binding

class CappedWriter:
    def __init__(self, stream, budget): self.stream, self.budget, self.bytes = stream, budget, 0
    def write(self, body):
        self.budget.tick(); require(self.bytes + len(body) <= self.budget.limits['archiveBytes'], 'Compressed checkpoint limit')
        result = self.stream.write(body); self.bytes += result; return result
    def flush(self): self.stream.flush()

class ExpandedReader:
    def __init__(self, stream, budget): self.stream, self.budget = stream, budget
    def read(self, amount):
        require(0 <= amount <= 1048576, 'Unbounded compressed archive read')
        body = self.stream.read(amount); self.budget.add(len(body)); return body

class LimitedTarInfo(tarfile.TarInfo):
    def _proc_pax(self, archive):
        require(self.size <= 1048576, 'Oversized PAX header')
        return super()._proc_pax(archive)
    def _proc_gnulong(self, archive):
        raise ValueError('Unsupported GNU long header')
    def _proc_sparse(self, archive):
        raise ValueError('Unsupported sparse header')

def tar_info(row):
    item = tarfile.TarInfo('tree' + ('/' + row['path'] if row['path'] else ''))
    item.mode, item.uid, item.gid = row['mode'], row['uid'], row['gid']
    item.pax_headers = {'mtime': str(Decimal(row['mtimeNs']) / Decimal(1000000000))}
    item.mtime = row['mtimeNs'] // 1000000000
    item.type = {'directory': tarfile.DIRTYPE, 'file': tarfile.REGTYPE, 'hardlink': tarfile.LNKTYPE, 'symlink': tarfile.SYMTYPE}[row['kind']]
    if row['kind'] == 'file': item.size = row['bytes']
    elif row['kind'] == 'hardlink': item.linkname = 'tree/' + row['target']
    elif row['kind'] == 'symlink': item.linkname = row['target']
    return item

def validate_manifest(value, binding, budget):
    require(set(value) == {'schemaVersion', 'binding', 'tree'} and value['schemaVersion'] == 1 and value['binding'] == binding, 'Checkpoint binding changed')
    tree = value['tree']; require(tree['schemaVersion'] == 1 and tree['logicalRoot'] == '/build', 'Checkpoint relocation')
    rows = tree['entries']; require(isinstance(rows, list) and 0 < len(rows) <= budget.limits['entries'], 'Checkpoint entry bound')
    known = {}; logical = 0
    for row in rows:
        name = row['path']; require(name == '' or relative(name), 'Invalid manifest path')
        require(name not in known and row['kind'] in ['directory', 'file', 'hardlink', 'symlink'], 'Duplicate/invalid manifest entry')
        if name:
            parent = str(PurePosixPath(name).parent); parent = '' if parent == '.' else parent
            require(parent in known and known[parent]['kind'] == 'directory', 'Missing directory parent')
        for key in ['mode', 'uid', 'gid', 'mtimeNs']: require(type(row[key]) is int, 'Invalid metadata type')
        require(0 <= row['mode'] <= 0o7777 and row['uid'] >= 0 and row['gid'] >= 0, 'Invalid metadata range')
        if row['kind'] in ['file', 'hardlink']:
            require(type(row['bytes']) is int and 0 <= row['bytes'] <= budget.limits['memberBytes'] and re.fullmatch('[a-f0-9]{64}', row['sha256']), 'Invalid file identity')
            logical += row['bytes']
        if row['kind'] == 'symlink': require(isinstance(row['target'], str) and '\0' not in row['target'] and len(row['target'].encode()) <= 4096, 'Invalid symlink'); logical += len(row['target'].encode())
        if row['kind'] == 'hardlink':
            target = known.get(relative(row['target'])); require(target is not None and target['kind'] == 'file', 'Unsafe or forward hardlink')
            require(all(row[k] == target[k] for k in ['mode', 'uid', 'gid', 'mtimeNs', 'bytes', 'sha256']), 'Hardlink metadata differs')
        known[name] = row
    require(rows[0]['path'] == '' and rows[0]['kind'] == 'directory', 'Missing root')
    require(logical == tree['logicalBytes'] and logical <= budget.limits['treeBytes'], 'Tree byte accounting differs')
    return rows

def verify_archive(path, receipt, binding, budget, destination=None):
    validate_binding(binding); require(receipt['binding'] == binding, 'Receipt binding differs')
    archive_sha, archive_size = identify(path, budget, budget.limits['archiveBytes'])
    require(archive_sha == receipt['archiveSha256'] and archive_size == receipt['archiveBytes'], 'Checkpoint archive identity differs')
    require(archive_size <= budget.limits['archiveBytes'], 'Checkpoint compressed bound')
    manifest = None; seen = set(); links = []; directories = []
    with path.open('rb') as stream, gzip.GzipFile(fileobj=stream, mode='rb') as decoded:
        with tarfile.open(fileobj=ExpandedReader(decoded, budget), mode='r|', tarinfo=LimitedTarInfo) as archive:
            item = archive.next(); require(item and item.name == 'CHECKTRAIL-MANIFEST.json' and item.isfile() and 0 < item.size <= budget.limits['manifestBytes'], 'Missing bounded checkpoint manifest')
            content = archive.extractfile(item).read(item.size + 1); require(len(content) == item.size and sha(content) == receipt['manifestSha256'], 'Manifest identity differs')
            manifest = json.loads(content); rows = validate_manifest(manifest, binding, budget)
            expected = {row['path']: row for row in rows}
            for item in iter(archive.next, None):
                budget.tick(); name = '' if item.name == 'tree' else relative(item.name.removeprefix('tree/'))
                require(item.name == 'tree' or item.name.startswith('tree/'), 'Unexpected archive namespace')
                require(name not in seen and name in expected, 'Duplicate or unexpected archive entry'); seen.add(name)
                row = expected[name]; wanted = tar_info(row)
                require(item.type == wanted.type and item.size == wanted.size and item.linkname == wanted.linkname and item.uid == row['uid'] and item.gid == row['gid'] and item.mode == row['mode'], 'Archive entry metadata differs')
                require(item.pax_headers.get('mtime') == wanted.pax_headers['mtime'], 'Archive mtime precision differs')
                require(not item.sparse, 'Sparse member refused')
                target = destination / name if destination is not None else None
                if row['kind'] == 'directory':
                    if target is not None and name: target.mkdir(mode=0o700)
                    directories.append(row)
                elif row['kind'] == 'file':
                    observed = hashlib.sha256(); total = 0
                    source = archive.extractfile(item)
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600) if target is not None else None
                    sink = os.fdopen(fd, 'wb') if fd is not None else None
                    try:
                        while True:
                            budget.tick(); body = source.read(65536)
                            if not body: break
                            total += len(body); observed.update(body)
                            if sink: sink.write(body)
                        if sink: sink.flush(); os.fsync(sink.fileno())
                    finally:
                        if sink: sink.close()
                    require(total == row['bytes'] and observed.hexdigest() == row['sha256'], 'Restored content differs')
                    if target is not None: set_metadata(target, row)
                else: links.append(row)
            require(seen == set(expected), 'Missing checkpoint entries')
            # Read through tar's own buffer, including data already read ahead.
            while True:
                budget.tick(); tail = archive.fileobj.read(65536)
                if not tail: break
                require(not any(tail), 'Nonzero trailing checkpoint bytes')
    if destination is not None:
        for row in links:
            target = destination / row['path']
            if row['kind'] == 'hardlink': os.link(destination / row['target'], target, follow_symlinks=False)
            else: os.symlink(row['target'], target)
            set_metadata(target, row)
        for row in reversed(directories): set_metadata(destination / row['path'], row)
        require(snapshot(destination, budget) == manifest['tree'], 'Physical restored checkpoint differs')
    return manifest

def set_metadata(path, row):
    before = path.lstat()
    if (before.st_uid, before.st_gid) != (row['uid'], row['gid']): os.chown(path, row['uid'], row['gid'], follow_symlinks=False)
    if row['kind'] != 'symlink': os.chmod(path, row['mode'], follow_symlinks=False)
    os.utime(path, ns=(row['mtimeNs'], row['mtimeNs']), follow_symlinks=False)

def fresh_destination(root, output):
    output = Path(output); physical(output.parent)
    require(output.is_absolute() and not output.exists() and not output.is_symlink(), 'Checkpoint destination already exists')
    require(root != output and root not in output.parents and output not in root.parents, 'Checkpoint source/output overlap')
    return output

def rename_no_replace(source, output):
    # Native atomic no-replace rename: a concurrent empty destination must not
    # be overwritten between admission and publication.
    library=ctypes.CDLL(None,use_errno=True)
    if sys.platform=='darwin':
        action=library.renamex_np;action.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint]
        result=action(os.fsencode(source),os.fsencode(output),4)  # RENAME_EXCL
    elif sys.platform.startswith('linux'):
        action=library.renameat2;action.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
        result=action(-100,os.fsencode(source),-100,os.fsencode(output),1)  # RENAME_NOREPLACE
    else:raise OSError('Atomic no-replace directory publication unavailable')
    if result!=0:raise OSError(ctypes.get_errno(),'Atomic checkpoint publication failed',str(output))

def publish(stage,output,budget):
    budget.tick();rename_no_replace(stage,output)
    try:budget.tick()
    except BaseException:
        # The caller has not received this owned fresh result. Move it back
        # atomically so normal private staging cleanup can withhold publication.
        rename_no_replace(output,stage)
        raise

def capture(root, output, binding, limits=None):
    root = physical(root); output = fresh_destination(root, output); validate_binding(binding); budget = Budget(limits)
    before = snapshot(root, budget); manifest = {'schemaVersion': 1, 'binding': binding, 'tree': before}; content = canonical(manifest)
    require(len(content) <= budget.limits['manifestBytes'], 'Checkpoint manifest bound')
    stage = Path(tempfile.mkdtemp(prefix='.gcc-checkpoint-', dir=output.parent))
    try:
        archive_path = stage / 'tree.tar.gz'
        with archive_path.open('xb') as raw:
            with gzip.GzipFile(fileobj=CappedWriter(raw, budget), mode='wb', compresslevel=1, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                    header = tarfile.TarInfo('CHECKTRAIL-MANIFEST.json'); header.size = len(content); archive.addfile(header, io.BytesIO(content))
                    for row in before['entries']:
                        budget.tick(); item = tar_info(row)
                        if row['kind'] == 'file':
                            descriptor = os.open(root / row['path'], os.O_RDONLY | os.O_NOFOLLOW)
                            with os.fdopen(descriptor, 'rb') as source: archive.addfile(item, source)
                        else: archive.addfile(item)
            raw.flush(); os.fsync(raw.fileno())
        require(snapshot(root, budget) == before, 'Source changed while checkpoint was created')
        archive_digest, archive_bytes = identify(archive_path, budget, budget.limits['archiveBytes'])
        receipt = {'schemaVersion': 1, 'binding': binding, 'archiveSha256': archive_digest, 'archiveBytes': archive_bytes,
                   'manifestSha256': sha(content), 'logicalRoot': '/build', 'checkpointValidated': True,
                   'phaseCompletionAssessed': False, 'originalCommandCompleted': False, 'gateAComplete': False}
        verify_archive(archive_path, receipt, binding, budget)
        (stage / 'receipt.json').write_bytes(canonical(receipt))
        budget.tick(); require(not output.exists(), 'Late checkpoint output collision'); publish(stage,output,budget)
        return receipt
    finally:
        if stage.exists(): shutil.rmtree(stage)

def restore(checkpoint, output, binding, expected_archive_sha256, limits=None):
    checkpoint = physical(checkpoint); output = fresh_destination(checkpoint, output); budget = Budget(limits)
    receipt_path = checkpoint / 'receipt.json'; require(receipt_path.is_file() and not receipt_path.is_symlink() and receipt_path.stat().st_size <= 65536, 'Missing bounded checkpoint receipt')
    receipt = json.loads(receipt_path.read_bytes())
    require(isinstance(expected_archive_sha256, str) and re.fullmatch('[a-f0-9]{64}', expected_archive_sha256), 'Independent checkpoint identity required')
    require(receipt['archiveSha256'] == expected_archive_sha256, 'Checkpoint differs from independently pinned predecessor')
    stage = Path(tempfile.mkdtemp(prefix='.gcc-restore-', dir=output.parent))
    try:
        verify_archive(checkpoint / 'tree.tar.gz', receipt, binding, budget, stage)
        budget.tick(); require(not output.exists(), 'Late restore output collision'); publish(stage,output,budget)
        return {'schemaVersion': 1, 'binding': binding, 'restored': True, 'physicalTreeVerified': True,
                'archiveSha256': receipt['archiveSha256'], 'originalCommandCompleted': False, 'gateAComplete': False}
    finally:
        if stage.exists(): shutil.rmtree(stage)

def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('operation', choices=['capture', 'restore']); parser.add_argument('--root', required=True); parser.add_argument('--output', required=True); parser.add_argument('--binding', required=True); parser.add_argument('--expected-archive-sha256')
    args = parser.parse_args(); data = Path(args.binding).read_bytes(); require(len(data) <= 65536, 'Binding size limit'); binding = json.loads(data)
    if args.operation == 'capture': value = capture(Path(args.root), Path(args.output), binding)
    else: value = restore(Path(args.root), Path(args.output), binding, args.expected_archive_sha256)
    print(json.dumps(value, sort_keys=True))

if __name__ == '__main__': main()
