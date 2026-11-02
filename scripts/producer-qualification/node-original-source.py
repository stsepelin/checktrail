"""Fixed original Node source bridge; no upstream execution or general archive API."""
import hashlib
import io
import json
import lzma
import math
import os
from pathlib import Path
import stat
import tarfile
import time

MIB = 1024**2
MAX_MEMBERS = 40000
MAX_LEAF = 512 * MIB
MAX_MEMBER_MAP = 32 * MIB

def require(ok, reason):
    if not ok:
        raise ValueError(reason)

def identity(row):
    return (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid,
            row.st_nlink, row.st_size, row.st_mtime_ns, row.st_ctime_ns)

def object_identity(row):
    return (row.st_dev, row.st_ino, stat.S_IFMT(row.st_mode), row.st_uid, row.st_gid)

def safe_name(raw):
    require(type(raw) is bytes and len(raw) <= 4096, 'Source path byte bound')
    name = raw.decode('utf-8', 'strict')
    require(name and not name.startswith('/') and not any(c in name for c in ['\\', '\0', '\r', '\n'])
            and len(name.split('/')) <= 64 and
            all(part not in ['', '.', '..'] for part in name.split('/')), 'Unsafe source path')
    return name

def close_preserving(targets, summary, primary=None):
    for target in targets:
        if target is not None:
            try:
                target.close() if hasattr(target, 'close') else os.close(target)
            except BaseException as error:
                summary.setdefault('cleanupFailures', []).append(
                    {'type': type(error).__name__, 'reason': str(error)[:256]})
                if primary is None:
                    primary = error
    return primary

def parent_fd(root_fd, name):
    """Walk every directory through held no-follow FDs; never follow source links."""
    parts = name.split('/')[:-1]
    fd = os.dup(root_fd)
    try:
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            previous = fd
            fd = child
            os.close(previous)
        return fd
    except BaseException as error:
        cleanup = {}
        close_preserving([fd], cleanup, error)
        error.sourceCleanupFailures = cleanup.get('cleanupFailures', [])
        raise

def write_all(fd, raw, progress, hasher):
    view = memoryview(raw)
    while view:
        count = os.write(fd, view)
        require(count > 0, 'Source output write made no progress')
        progress['writtenBytes'] += count
        hasher.update(view[:count])
        progress['writtenPrefixSha256'] = hasher.hexdigest()
        view = view[count:]


def clock(deadline):
    require(time.monotonic() < deadline, 'Original Node source preparation deadline')


def hash_archive(fd, expected, counters, deadline):
    hasher, count = hashlib.sha256(), 0
    while count <= expected['bytes']:
        clock(deadline)
        raw = os.read(fd, min(65536, expected['bytes'] + 1 - count))
        counters['archiveHashReadOperations'] += 1
        counters['archiveHashReturnedBytes'] += len(raw)
        count += len(raw)
        hasher.update(raw)
        if not raw:
            break
    require(count == expected['bytes'] and hasher.hexdigest() == expected['sha256'],
            'Original signed Node archive byte identity differs')
    os.lseek(fd, 0, os.SEEK_SET)


def decode_xz(input_fd, tar_fd, source, counters, deadline):
    """One XZ stream,256MiB decoder memory,1MiB output chunks,exact expansion."""
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=256 * MIB)
    references = source['expandedPartReferences']
    require(len(references) == 2 and sum(row['bytes'] for row in references) == source['expandedTarBytes'],
            'Closed original Node expanded reference changed')
    interval_hashes = [hashlib.sha256(), hashlib.sha256()]
    interval_counts = [0, 0]
    input_hash = hashlib.sha256()
    written_hash = hashlib.sha256()
    progress = {'writtenBytes': 0, 'writtenPrefixSha256': written_hash.hexdigest()}
    counters['decodedTarWrite'] = progress
    while not decoder.eof:
        clock(deadline)
        if decoder.needs_input:
            chunk = os.read(input_fd, min(65536, source['archive']['bytes'] - counters['decoderInputReturnedBytes'] + 1))
            counters['decoderInputReadOperations'] += 1
            counters['decoderInputReturnedBytes'] += len(chunk)
            require(chunk and counters['decoderInputReturnedBytes'] <= source['archive']['bytes'],
                    'Original Node XZ input truncated or exceeded pin')
            input_hash.update(chunk)
        else:
            chunk = b''
        raw = decoder.decompress(chunk, max_length=min(MIB, source['expandedTarBytes'] - counters['decoderReturnedBytes'] + 1))
        counters['decoderCalls'] += 1
        counters['decoderReturnedBytes'] += len(raw)
        require(counters['decoderReturnedBytes'] <= source['expandedTarBytes'],
                'Original Node XZ expanded beyond exact bound')
        cursor = 0
        for index, reference in enumerate(references):
            take = min(len(raw) - cursor, reference['bytes'] - interval_counts[index])
            if take:
                interval_hashes[index].update(raw[cursor:cursor + take])
                interval_counts[index] += take
                cursor += take
        require(cursor == len(raw), 'Original Node expanded interval overflow')
        write_all(tar_fd, raw, progress, written_hash)
    tail = os.read(input_fd, 1)
    counters['decoderInputReadOperations'] += 1
    counters['decoderInputReturnedBytes'] += len(tail)
    require(not decoder.unused_data and not tail,
            'Trailing or concatenated original Node XZ input')
    require(counters['decoderInputReturnedBytes'] == source['archive']['bytes'] and
            input_hash.hexdigest() == source['archive']['sha256'] and
            counters['decoderReturnedBytes'] == source['expandedTarBytes'] and
            progress['writtenBytes'] == source['expandedTarBytes'], 'Original Node decode incomplete')
    for count, hasher, reference in zip(interval_counts, interval_hashes, references):
        require(count == reference['bytes'] and hasher.hexdigest() == reference['sha256'],
                'Original Node expanded interval differs from qualified reference')
    os.fsync(tar_fd)
    os.fchmod(tar_fd, 0o400)
    os.lseek(tar_fd, 0, os.SEEK_SET)
    return {'bytes': progress['writtenBytes'], 'sha256': written_hash.hexdigest(),
            'decoderMemoryLimitBytes': 256 * MIB, 'qualifiedExpandedIntervalsMatched': 2}


class TarView:
    """Counts application reads of the held decoded tar; no pathname reopen."""
    def __init__(self, fd, size, counters, deadline):
        self.fd, self.size, self.counters, self.deadline = fd, size, counters, deadline
        self.position = 0

    def read(self, count):
        clock(self.deadline)
        require(type(count) is int and 0 <= count <= MIB, 'Unbounded decoded tar read')
        count = min(count, self.size - self.position)
        require(self.counters['tarReadOperations'] < 200000, 'Decoded tar read operation bound')
        raw = os.pread(self.fd, count, self.position)
        self.position += len(raw)
        self.counters['tarReadOperations'] += 1
        self.counters['tarReturnedBytes'] += len(raw)
        require(self.counters['tarReturnedBytes'] <= 2 * 1024**3, 'Decoded tar returned-byte bound')
        clock(self.deadline)
        return raw

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        require(type(offset) is int and whence in [0, 1, 2], 'Unknown decoded tar seek')
        position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        require(0 <= position <= self.size, 'Decoded tar seek outside exact input')
        self.position = position
        return position


def raw_header(fd, offset, size, counters, deadline):
    clock(deadline)
    require(type(offset) is int and offset >= 0 and offset % 512 == 0 and offset + 512 <= size,
            'Original Node raw-header offset')
    raw = os.pread(fd, 512, offset)
    counters['headerProbeOperations'] += 1
    counters['headerProbeReturnedBytes'] += len(raw)
    require(counters['headerProbeOperations'] <= 80000, 'Original Node header probe count bound')
    require(len(raw) == 512, 'Original Node raw header truncated')
    return raw


def inspect_members(archive, tar_fd, source, counters, deadline):
    members, names, long_names, raw_headers, total = [], {}, 0, 0, 0
    for item in archive:
        clock(deadline)
        require(len(members) < MAX_MEMBERS, 'Original Node member count bound')
        spelling = item.name.rstrip('/')
        require(spelling == source['root'] or spelling.startswith(source['root'] + '/'),
                'Foreign original Node source root')
        name = '' if spelling == source['root'] else safe_name(spelling[len(source['root']) + 1:].encode())
        require(name not in names and (name or item.isdir()), 'Duplicate original Node source path')
        require((item.isdir() or item.isfile()) and not item.issym() and not item.islnk() and
                not getattr(item, 'sparse', None) and not item.pax_headers,
                'Original Node links/sparse/PAX/special source member refused')
        require(type(item.size) is int and 0 <= item.size <= MAX_LEAF and
                type(item.mode) is int and 0 <= item.mode <= 0o777 and
                type(item.uid) is int and type(item.gid) is int and item.uid >= 0 and item.gid >= 0 and
                type(item.mtime) in [int, float] and math.isfinite(item.mtime),
                'Original Node source numeric metadata bound')
        require(item.isfile() or item.size == 0, 'Nonempty original Node directory payload')
        total += item.size
        require(total <= source['expandedTarBytes'], 'Original Node source payload aggregate bound')
        require(item.offset_data + item.size <= source['expandedTarBytes'], 'Original source payload extent')
        header_at = item.offset_data - 512
        header = raw_header(tar_fd, header_at, source['expandedTarBytes'], counters, deadline)
        require(header[156:157] in [b'0', b'\0', b'5'], 'Unexpected original Node regular/directory type')
        extension = None
        raw_headers += 1
        if item.offset != header_at:
            original = raw_header(tar_fd, item.offset, source['expandedTarBytes'], counters, deadline)
            require(original[156:157] == b'L', 'Unknown original Node extension chain')
            length = int(original[124:136].rstrip(b'\0 ') or b'0', 8)
            require(0 < length <= 4096 and item.offset + 512 + ((length + 511) // 512) * 512 == header_at,
                    'Original Node long-name extent differs')
            payload = os.pread(tar_fd, length, item.offset + 512)
            counters['headerProbeOperations'] += 1
            counters['headerProbeReturnedBytes'] += len(payload)
            require(counters['headerProbeOperations'] <= 80000 and
                    counters['headerProbeReturnedBytes'] <= 64 * MIB, 'Original Node header probe byte/count bound')
            require(len(payload) == length and payload.rstrip(b'\0').rstrip(b'/') == spelling.encode('utf-8'),
                    'Original Node GNU long-name bytes differ')
            extension = {'headerSha256': hashlib.sha256(original).hexdigest(),
                         'bytes': length, 'sha256': hashlib.sha256(payload).hexdigest()}
            raw_headers += 1
            long_names += 1
        row = {'file': name, 'kind': 'directory' if item.isdir() else 'regular', 'mode': item.mode,
               'archiveUid': item.uid, 'archiveGid': item.gid, 'mtime': item.mtime,
               'bytes': item.size, 'rawHeaderSha256': hashlib.sha256(header).hexdigest(),
               'gnuLongName': extension}
        names[name] = row
        members.append((item, row))
    counts = source['expectedCounts']
    require(len(members) == counts['members'] and '' in names and
            sum(item.isdir() for item, _ in members) == counts['directories'] and
            sum(item.isfile() for item, _ in members) == counts['regular'] and
            long_names == counts['gnuLongNames'] and raw_headers == counts['rawHeaders'],
            'Original Node source member partition differs')
    return members, names, {'rawHeaders': raw_headers, 'gnuLongNames': long_names, 'sourcePayloadBytes': total}


def prepare_source(bundle, work, source, deadline):
    """Whole signed-byte identity precedes decode; all names precede source writes."""
    counters = {'archiveHashReadOperations': 0, 'archiveHashReturnedBytes': 0,
                'decoderInputReadOperations': 0, 'decoderInputReturnedBytes': 0,
                'decoderCalls': 0, 'decoderReturnedBytes': 0,
                'tarReadOperations': 0, 'tarReturnedBytes': 0,
                'headerProbeOperations': 0, 'headerProbeReturnedBytes': 0,
                'regular': 0, 'directories': 0, 'emptyRegular': 0}
    summary = {'schemaVersion': 1, 'scope': 'new-native-original-node-source-observation',
               'oldLocalIndexReusedOrRelabeled': False, 'originalSourceExecuted': False,
               'materializedOwner': {'uid': os.geteuid(), 'gid': os.getegid()},
               'originalUidGidRetainedInNewMemberIdentities': True, 'counters': counters}
    input_fd = tar_fd = root_fd = identity_fd = archive = None
    primary = None
    try:
        clock(deadline)
        require(work.resolve(strict=True) == work and not list(work.iterdir()),
                'Original Node native source namespace must be cold and physical')
        file = bundle / safe_name(source['archive']['file'].encode())
        require(file.resolve(strict=True) == file, 'Linked original Node archive path')
        before = file.lstat()
        require(stat.S_ISREG(before.st_mode) and before.st_size == source['archive']['bytes'] and
                before.st_size <= 64 * MIB, 'Original Node archive physical bound')
        input_fd = os.open(str(file), os.O_RDONLY | os.O_NOFOLLOW)
        require(identity(os.fstat(input_fd)) == identity(before), 'Original Node archive open race')
        hash_archive(input_fd, source['archive'], counters, deadline)
        require(identity(os.fstat(input_fd)) == identity(before) and identity(file.lstat()) == identity(before),
                'Original Node archive changed during admission')
        preparation = work / 'preparation'
        preparation.mkdir(mode=0o755)
        os.chmod(preparation, 0o755)
        tar_path = preparation / 'node-source.tar'
        tar_fd = os.open(str(tar_path), os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        summary['decodedTar'] = decode_xz(input_fd, tar_fd, source, counters, deadline)
        tar_frame = identity(os.fstat(tar_fd))
        archive = tarfile.open(fileobj=TarView(tar_fd, source['expandedTarBytes'], counters, deadline),
                               mode='r:', encoding='utf-8', errors='strict')
        members, names, inventory = inspect_members(archive, tar_fd, source, counters, deadline)
        summary.update(inventory)
        root = work / source['root']
        require(not root.exists() and not root.is_symlink(), 'Original Node source destination already exists')
        root.mkdir(mode=names['']['mode'])
        root_fd = os.open(str(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        root_identity = object_identity(os.fstat(root_fd))
        os.fchmod(root_fd, names['']['mode'])
        directories = {''}
        for name, row in names.items():
            if row['kind'] == 'directory':
                directories.add(name)
            for parent in Path(name).parents:
                if parent.as_posix() != '.':
                    directories.add(parent.as_posix())
        require(all(name not in names or names[name]['kind'] == 'directory' for name in directories),
                'Original Node source parent is a regular file')
        for name in sorted(directories - {''}, key=lambda value: (value.count('/'), value)):
            parent, child, failure = parent_fd(root_fd, name), None, None
            try:
                mode = names[name]['mode'] if name in names else 0o755
                os.mkdir(name.rsplit('/', 1)[-1], mode=mode, dir_fd=parent)
                child = os.open(name.rsplit('/', 1)[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.fchmod(child, mode)
            except BaseException as error:
                failure = error
            finally:
                failure = close_preserving([child, parent], summary, failure)
            if failure is not None:
                raise failure
        identities = preparation / 'source-members.jsonl'
        identity_fd = os.open(str(identities), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        os.fchmod(identity_fd, 0o644)
        map_hash = hashlib.sha256()
        map_progress = {'writtenBytes': 0, 'writtenPrefixSha256': map_hash.hexdigest()}
        summary['memberIdentityWrite'] = map_progress
        for item, row in members:
            clock(deadline)
            if item.isdir():
                counters['directories'] += 1
                row['sha256'] = hashlib.sha256(b'').hexdigest()
            else:
                parent, fd, body, failure = parent_fd(root_fd, row['file']), None, None, None
                try:
                    require(object_identity(root.lstat()) == root_identity, 'Original Node source root replaced')
                    fd = os.open(row['file'].rsplit('/', 1)[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 row['mode'], dir_fd=parent)
                    body = archive.extractfile(item)
                    require(body is not None, 'Original Node member body unavailable')
                    output_hash = hashlib.sha256()
                    progress = {'file': row['file'], 'readBytes': 0, 'writtenBytes': 0,
                                'writtenPrefixSha256': output_hash.hexdigest()}
                    counters['currentLeaf'] = progress
                    while progress['readBytes'] < item.size:
                        clock(deadline)
                        raw = body.read(min(MIB, item.size - progress['readBytes']))
                        require(raw, 'Original Node member body truncated')
                        progress['readBytes'] += len(raw)
                        write_all(fd, raw, progress, output_hash)
                    require(not body.read(1) and progress['writtenBytes'] == item.size,
                            'Original Node materialized member length differs')
                    os.fchmod(fd, row['mode'])
                    os.utime(fd, (item.mtime, item.mtime))
                    os.fsync(fd)
                    check = parent_fd(root_fd, row['file'])
                    check_failure = None
                    try:
                        require(object_identity(os.fstat(check)) == object_identity(os.fstat(parent)),
                                'Original Node materialized parent replaced')
                    except BaseException as error:
                        check_failure = error
                    finally:
                        check_failure = close_preserving([check], summary, check_failure)
                    if check_failure is not None:
                        raise check_failure
                    row['sha256'] = output_hash.hexdigest()
                    counters['regular'] += 1
                    counters['emptyRegular'] += item.size == 0
                    del counters['currentLeaf']
                except BaseException as error:
                    failure = error
                finally:
                    failure = close_preserving([body, fd, parent], summary, failure)
                if failure is not None:
                    raise failure
            raw = (json.dumps(row, sort_keys=True, ensure_ascii=True, separators=(',', ':')) + '\n').encode()
            require(map_progress['writtenBytes'] + len(raw) <= MAX_MEMBER_MAP, 'Node member-identity map bound')
            write_all(identity_fd, raw, map_progress, map_hash)
        for item, row in sorted(members, key=lambda value: value[1]['file'].count('/'), reverse=True):
            if not item.isdir():
                continue
            clock(deadline)
            directory = parent_fd(root_fd, row['file'] + '/leaf') if row['file'] else os.dup(root_fd)
            failure = None
            try:
                os.utime(directory, (item.mtime, item.mtime))
            except BaseException as error:
                failure = error
            finally:
                failure = close_preserving([directory], summary, failure)
            if failure is not None:
                raise failure
        os.fsync(identity_fd)
        require(identity(os.fstat(input_fd)) == identity(before) and identity(file.lstat()) == identity(before),
                'Original Node compressed input changed during preparation')
        require(identity(os.fstat(tar_fd)) == tar_frame and identity(tar_path.lstat()) == tar_frame,
                'Original Node decoded tar changed during materialization')
        require(object_identity(root.lstat()) == root_identity, 'Original Node source destination replaced')
        summary.update(nativeMemberIdentities={'file': 'preparation/source-members.jsonl',
            'bytes': map_progress['writtenBytes'], 'sha256': map_hash.hexdigest(), 'records': len(members)},
            sourceRoot=source['root'], originalModesAndMtimesPreserved=True,
            implicitDirectories=len(directories) - sum(item.isdir() for item, _ in members),
            originalArchive={'bytes': before.st_size, 'sha256': source['archive']['sha256']})
    except BaseException as error:
        primary = error
        if hasattr(error, 'sourceCleanupFailures'):
            summary.setdefault('cleanupFailures', []).extend(error.sourceCleanupFailures)
    finally:
        primary = close_preserving([archive, identity_fd, root_fd, tar_fd, input_fd], summary, primary)
    try:
        clock(deadline)
    except BaseException as error:
        if primary is None:
            primary = error
        else:
            summary.setdefault('cleanupFailures', []).append({'type': type(error).__name__, 'reason': str(error)[:256]})
    if primary is not None:
        primary.nodeSourcePreparation = summary
        raise primary
    return summary
