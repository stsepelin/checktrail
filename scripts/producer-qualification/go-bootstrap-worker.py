"""Fixed data preparation and read-only observations; never imports SDK/project code."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import stat
import sys
import tarfile

CATALOG_SHA256 = '1ef7849aa70199aa50c7182f1fff7ea754b344ad1d9a0f8efc816f129d33a18b'
MAX_LEAF = 512 * 1024**2
MAX_TOTAL = 16 * 1024**3
MAX_ENTRIES = 200000


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def safe_name(name):
    return isinstance(name, str) and bool(name) and len(name.encode('utf-8')) <= 4096 and len(name.split('/')) <= 64 and not any(c in name for c in ['\\', '\0', '\r', '\n']) and all(part not in ['', '.', '..'] for part in name.split('/'))


def file_identity(file, maximum=MAX_LEAF):
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > maximum or file.resolve(strict=True) != file:
        raise ValueError('physical regular file bound/type refused')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd); hasher = hashlib.sha256(); size = 0
        while True:
            raw = os.read(fd, 1048576)
            if not raw: break
            size += len(raw)
            if size > maximum: raise ValueError('physical file grew beyond bound')
            hasher.update(raw)
        after = os.fstat(fd)
    finally: os.close(fd)
    final = file.lstat()
    identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
    if identity(before) != identity(opened) or identity(before) != identity(after) or identity(before) != identity(final) or size != before.st_size:
        raise ValueError('physical file changed during observation')
    return {'bytes': size, 'sha256': hasher.hexdigest()}


def physical_tree(root):
    if root.resolve(strict=True) != root: raise ValueError('linked SDK root refused')
    first = root.lstat()
    if not stat.S_ISDIR(first.st_mode): raise ValueError('SDK root is not a directory')
    rows, total = [], 0
    def visit(directory, depth):
        nonlocal total
        if depth > 64: raise ValueError('SDK directory depth bound')
        before = directory.lstat()
        if not stat.S_ISDIR(before.st_mode) or directory.resolve(strict=True) != directory:
            raise ValueError('linked SDK parent refused')
        for file in directory.iterdir():
            name = file.relative_to(root).as_posix()
            if not safe_name(name) or len(rows) >= MAX_ENTRIES: raise ValueError('SDK path/count bound')
            info = file.lstat()
            row = {'file': name, 'kind': None, 'mode': info.st_mode & 0o7777, 'uid': info.st_uid, 'gid': info.st_gid}
            if row['mode'] > 0o777: raise ValueError('unexpected special SDK mode')
            if stat.S_ISDIR(info.st_mode):
                row['kind'] = 'directory'; rows.append(row); visit(file, depth + 1)
            elif stat.S_ISREG(info.st_mode):
                row['kind'] = 'file'; row.update(file_identity(file)); total += row['bytes']; rows.append(row)
            elif stat.S_ISLNK(info.st_mode):
                target = os.readlink(file)
                combined = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if not target or target.startswith('/') or combined == '..' or combined.startswith('../') or any(c in target for c in ['\\', '\0', '\r', '\n']) or len(target.encode()) > 4096:
                    raise ValueError('SDK link target outside sealed root')
                final = file.lstat()
                if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns, final.st_ctime_ns): raise ValueError('SDK link changed')
                row.update(kind='symlink', target=target, bytes=len(target.encode()), sha256=digest(target.encode())); total += row['bytes']; rows.append(row)
            else: raise ValueError('SDK special object refused')
            if total > MAX_TOTAL: raise ValueError('SDK total byte bound')
        after = directory.lstat()
        if (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid, after.st_mtime_ns, after.st_ctime_ns): raise ValueError('SDK directory changed')
    visit(root, 0)
    last = root.lstat()
    if (first.st_dev, first.st_ino) != (last.st_dev, last.st_ino): raise ValueError('SDK root changed')
    rows.sort(key=lambda row: PurePosixPath(row['file']))
    return {'schemaVersion': 1, 'root': {'mode': first.st_mode & 0o7777, 'uid': first.st_uid, 'gid': first.st_gid}, 'entries': rows}


def extract_source(archive, destination):
    if destination.exists() or destination.is_symlink(): raise ValueError('source destination must be new')
    with tarfile.open(archive, mode='r:gz') as handle:
        members = handle.getmembers()
        if len(members) > MAX_ENTRIES: raise ValueError('source archive entry bound')
        selected, names, directories, total = [], {}, set(), 0
        for member in members:
            full = member.name.rstrip('/')
            if full == 'go' and member.isdir(): continue
            if not full.startswith('go/') or not safe_name(full[3:]): raise ValueError('source archive path refused')
            name = full[3:]
            if name in names: raise ValueError('duplicate archive path')
            if not (member.isdir() or member.isfile() or member.issym()): raise ValueError('special/hardlink archive member refused')
            if member.size < 0 or member.size > MAX_LEAF: raise ValueError('archive leaf bound')
            total += member.size
            if total > MAX_TOTAL: raise ValueError('archive aggregate bound')
            names[name] = member
            for parent in PurePosixPath(name).parents:
                if parent.as_posix() != '.': directories.add(parent.as_posix())
            if member.isdir(): directories.add(name)
            if member.issym():
                target = member.linkname
                normalized = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if not target or target.startswith('/') or normalized == '..' or normalized.startswith('../') or any(c in target for c in ['\\', '\0', '\r', '\n']): raise ValueError('archive link outside source')
            selected.append((name, member))
        for name in directories:
            if name in names and not names[name].isdir(): raise ValueError('archive parent is a file or link')
        destination.mkdir(mode=0o755)
        for name in sorted(directories, key=PurePosixPath): (destination / name).mkdir(mode=0o755, parents=True, exist_ok=True)
        for name, member in selected:
            target = destination / name
            if member.isdir(): continue
            if member.issym(): continue
            source = handle.extractfile(member)
            if source is None: raise ValueError('archive file body unavailable')
            count = 0
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755 if member.mode & 0o111 else 0o644)
            try:
                with os.fdopen(fd, 'wb') as output:
                    while True:
                        raw = source.read(1048576)
                        if not raw: break
                        count += len(raw)
                        if count > member.size: raise ValueError('archive file expanded beyond bound')
                        output.write(raw)
                    output.flush(); os.fsync(output.fileno())
                if count != member.size: raise ValueError('archive file size differs')
                os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
                os.utime(target, (member.mtime, member.mtime))
            finally: source.close()
        for name, member in selected:
            if member.issym(): (destination / name).symlink_to(member.linkname)
    return physical_tree(destination)


def image_tools():
    selected = [('bash', '/bin/bash'), ('gcc', '/usr/bin/gcc'), ('as', '/usr/bin/as'), ('ld', '/usr/bin/ld'), ('python3', '/usr/bin/python3'), ('cc1', '/usr/lib/gcc/x86_64-linux-gnu/12/cc1'), ('collect2', '/usr/lib/gcc/x86_64-linux-gnu/12/collect2'), ('loader', '/lib64/ld-linux-x86-64.so.2')]
    rows = []
    for role, invocation in selected:
        file = Path(invocation); resolved = file.resolve(strict=True)
        rows.append({'role': role, 'invocation': invocation, 'canonicalPath': str(resolved), **file_identity(resolved), 'mode': resolved.stat().st_mode & 0o7777})
    return rows


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ['prepare', 'observe']: raise ValueError('fixed mode and stage required')
    raw = Path('/controls/go-bootstrap.v1.json').read_bytes()
    if len(raw) > 131072 or digest(raw) != CATALOG_SHA256: raise ValueError('closed catalog byte identity differs')
    catalog = json.loads(raw)
    profiles = [row for row in catalog['profiles'] if row['id'] == sys.argv[2]]
    if len(profiles) != 1: raise ValueError('unknown closed stage')
    profile = profiles[0]
    if sys.argv[1] == 'prepare':
        work = Path('/work')
        if list(work.iterdir()): raise ValueError('cold source namespace is not empty')
        archive = Path('/bundle/archives') / profile['sourceArchive']['url'].rsplit('/', 1)[1]
        expected = profile['sourceArchive']
        if file_identity(archive, 64 * 1024**2) != {'bytes': expected['bytes'], 'sha256': expected['sha256']}: raise ValueError('original source archive changed')
        tree = extract_source(archive, work / 'go')
        if (work / 'go' / 'VERSION').read_text().strip().splitlines()[0] != profile['internalVersionFile'].splitlines()[0]: raise ValueError('original source VERSION differs')
        if profile['environment'].get('HOME') == '/work/home': (work / 'home').mkdir(mode=0o700)
        value = {'schemaVersion': 1, 'stage': profile['id'], 'sourceArchive': {'bytes': expected['bytes'], 'sha256': expected['sha256']}, 'sourceTree': tree, 'buildExecuted': False}
    else:
        value = {'schemaVersion': 1, 'stage': profile['id'], 'sdkTree': physical_tree(Path('/observed/sdk')), 'bootstrapTree': physical_tree(Path('/observed/bootstrap')) if profile['predecessor'] else None, 'imageTools': image_tools(), 'toolSourceBuildClosureVerified': False, 'actualModuleLoadsTraced': False}
    print(json.dumps(value, separators=(',', ':'), ensure_ascii=True), flush=True)


if __name__ == '__main__': main()
