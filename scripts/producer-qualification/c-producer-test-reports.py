"""Bounded data-only retention; original configurations are never pooled."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


class ReportRetentionError(RuntimeError):
    """A bounded per-file failure with its relative source identity."""


def parse_caller_identity(uid, gid):
    values = []
    for value in [uid, gid]:
        if (not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,9}', value)
                or int(value) > 4294967294):
            raise RuntimeError("Malformed captured caller UID/GID")
        values.append(int(value))
    return {"uid": values[0], "gid": values[1]}


def inode(info):
    return info.st_dev, info.st_ino


def handoff_new_fd(fd, expected_inode, caller, mode, directory=False):
    before = os.fstat(fd)
    proper_type = stat.S_ISDIR(before.st_mode) if directory else stat.S_ISREG(before.st_mode)
    if not proper_type or inode(before) != expected_inode or stat.S_IMODE(before.st_mode) != mode:
        raise RuntimeError("New copy FD/inode/mode changed before custody handoff")
    if (before.st_uid, before.st_gid) != (caller['uid'], caller['gid']):
        os.fchown(fd, caller['uid'], caller['gid'])
    after = os.fstat(fd)
    if (inode(after) != expected_inode or (after.st_uid, after.st_gid) != (caller['uid'], caller['gid'])
            or stat.S_IMODE(after.st_mode) != mode):
        raise RuntimeError("New copy ownership was not positively observed")
    return {"uid": after.st_uid, "gid": after.st_gid, "mode": mode,
            "producerDevice": str(after.st_dev), "producerInode": str(after.st_ino)}


class RetainedCopies:
    def __init__(self, root, caller):
        self.root, self.caller = root, caller
        self.directories, self.files, self.failures = {}, [], []
        self.parent_fd = self.root_fd = None
        if root.parent.resolve(strict=True) != root.parent:
            raise RuntimeError("Report export parent is not canonical")
        self.parent_fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parent = os.fstat(self.parent_fd)
            if (parent.st_uid, parent.st_gid) != (caller['uid'], caller['gid']):
                raise RuntimeError("Export parent caller identity differs; user namespace mapping is unqualified")
            os.mkdir(root.name, 0o700, dir_fd=self.parent_fd)
            self.root_fd = os.open(root.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent_fd)
            info = os.fstat(self.root_fd)
            if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
                raise RuntimeError("Exclusive new report root has unexpected identity/mode")
            self.directories['.'] = inode(info)
        except BaseException:
            self.close()
            raise

    def directory(self, relative, create=False):
        current = os.dup(self.root_fd)
        try:
            if inode(os.fstat(current)) != self.directories['.']:
                raise RuntimeError("New report root FD changed")
            built = []
            for part in ([] if relative == '.' else relative.split('/')):
                if not part or part in ['.', '..']:
                    raise RuntimeError("Invalid retained-copy directory component")
                built.append(part)
                name = '/'.join(built)
                if name not in self.directories:
                    if not create:
                        raise RuntimeError("Unjournaled report-copy directory refused")
                    if len(self.directories) >= 50000:
                        raise RuntimeError("Retained-copy directory custody inventory bound exceeded")
                    os.mkdir(part, 0o700, dir_fd=current)
                    info = os.stat(part, dir_fd=current, follow_symlinks=False)
                    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
                        raise RuntimeError("Exclusive new report-copy directory changed")
                    self.directories[name] = inode(info)
                following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                if inode(os.fstat(following)) != self.directories[name]:
                    os.close(following)
                    raise RuntimeError("Retained-copy directory inode differs from created journal")
                os.close(current)
                current = following
            return current
        except BaseException:
            os.close(current)
            raise

    def write(self, relative, raw):
        components = relative.split('/')
        parent = self.directory('/'.join(components[:-1]) or '.', create=True)
        fd = None
        original = None
        try:
            if len(self.files) >= 16384:
                raise RuntimeError("Retained-copy file custody inventory bound exceeded")
            fd = os.open(components[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            created = inode(os.fstat(fd))
            record = {"file": relative, "ownership": None}
            self.files.append(record)
            try:
                view = memoryview(raw)
                offset = 0
                while offset < len(raw):
                    written = os.write(fd, view[offset:])
                    if written <= 0:
                        raise RuntimeError("Retained-copy writer made no progress")
                    offset += written
                os.fsync(fd)
            except BaseException as error:
                original = error
            finally:
                try:
                    record['ownership'] = handoff_new_fd(fd, created, self.caller, 0o600)
                except BaseException as error:
                    self.failures.append(repr(error))
            if original is not None:
                raise original
            if record['ownership'] is None:
                raise RuntimeError("Retained-copy file handoff failed: " + '; '.join(self.failures))
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent)

    def write_stream(self, relative, chunks, validate_source):
        components = relative.split('/')
        parent = self.directory('/'.join(components[:-1]) or '.', create=True)
        temporary = '.partial-' + os.urandom(16).hex()
        fd, created = None, None
        temporary_present = published = complete = False
        digest, size = hashlib.sha256(), 0
        try:
            if len(self.files) >= 16384:
                raise RuntimeError("Retained-copy file custody inventory bound exceeded")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            created = inode(os.fstat(fd))
            temporary_present = True
            for raw in chunks:
                if len(raw) > 1024 ** 2 or size + len(raw) > 64 * 1024 ** 2:
                    raise RuntimeError("Retained-copy stream chunk/member bound exceeded")
                view, offset = memoryview(raw), 0
                while offset < len(raw):
                    written = os.write(fd, view[offset:])
                    if written <= 0:
                        raise RuntimeError("Retained-copy writer made no progress")
                    offset += written
                digest.update(raw)
                size += len(raw)
            os.fsync(fd)
            validate_source()
            if inode(os.stat(temporary, dir_fd=parent, follow_symlinks=False)) != created:
                raise RuntimeError("Atomic retained-copy temporary inode changed")
            # Link creation is atomic and refuses an existing final name. Only a
            # complete source-validated copy is ever published at that name.
            os.link(temporary, components[-1], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            published = True
            os.unlink(temporary, dir_fd=parent)
            temporary_present = False
            observed = os.stat(components[-1], dir_fd=parent, follow_symlinks=False)
            if inode(observed) != created or not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
                raise RuntimeError("Atomic retained-copy publication identity changed")
            record = {"file": relative, "ownership": None}
            self.files.append(record)
            record['ownership'] = handoff_new_fd(fd, created, self.caller, 0o600)
            complete = True
            return {"file": relative, "bytes": size, "sha256": digest.hexdigest()}
        finally:
            for present, name in [(temporary_present, temporary), (published and not complete, components[-1])]:
                if not present:
                    continue
                try:
                    if inode(os.stat(name, dir_fd=parent, follow_symlinks=False)) != created:
                        raise RuntimeError("Incomplete retained-copy path no longer names its owned inode")
                    os.unlink(name, dir_fd=parent)
                except BaseException as error:
                    self.failures.append(repr(error))
            if fd is not None:
                os.close(fd)
            os.close(parent)

    def finish(self):
        observed = []
        for relative in sorted(self.directories, key=lambda value: (value.count('/') + (value != '.'), value), reverse=True):
            fd = None
            try:
                if inode(os.stat(self.root.name, dir_fd=self.parent_fd, follow_symlinks=False)) != self.directories['.']:
                    raise RuntimeError("Created report root path was replaced before handoff")
                fd = self.directory(relative)
                ownership = handoff_new_fd(fd, self.directories[relative], self.caller, 0o700, directory=True)
                observed.append({"directory": relative, "ownership": ownership})
            except BaseException as error:
                self.failures.append(repr(error))
            finally:
                if fd is not None:
                    os.close(fd)
        if self.failures:
            raise RuntimeError("New report-copy custody was incomplete: " + '; '.join(self.failures))
        return {"schemaVersion": 1, "requestedCaller": self.caller, "producerEffectiveUid": os.geteuid(),
                "directories": observed, "files": self.files, "newCopyOwnersVerified": True,
                "recursiveOwnershipChangeUsed": False, "sourceTreePermissionsChanged": False,
                "nativeLinuxCrossUidAcceptanceVerified": False}

    def close(self):
        for key in ['root_fd', 'parent_fd']:
            fd = getattr(self, key)
            if fd is not None:
                os.close(fd)
                setattr(self, key, None)


def write_manifest(destination, report, caller, parent_fd=None):
    chunks = []
    size = 0
    for part in json.JSONEncoder(indent=2).iterencode(report):
        raw_part = part.encode()
        size += len(raw_part)
        if size + 1 > 8 * 1024 ** 2:
            raise RuntimeError("C manifest exceeds its existing8MiB reader bound")
        chunks.append(raw_part)
    raw = b''.join(chunks) + b'\n'
    fd = os.open(destination if parent_fd is None else destination.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
    original = None
    custody_error = None
    try:
        created = inode(os.fstat(fd))
        try:
            offset = 0
            while offset < len(raw):
                written = os.write(fd, raw[offset:])
                if written <= 0:
                    raise RuntimeError("Report manifest writer made no progress")
                offset += written
            os.fsync(fd)
        except BaseException as error:
            original = error
        finally:
            try:
                handoff_new_fd(fd, created, caller, 0o600)
            except BaseException as error:
                custody_error = error
        if original is not None:
            raise RuntimeError("Original report manifest write failed: " + repr(original) + "; custody: " + repr(custody_error)) from original
        if custody_error is not None:
            raise custody_error
    finally:
        os.close(fd)


def write_command_observation(phase, root, caller, exit_code=None):
    if phase not in ('requested', 'terminal'):
        raise RuntimeError("Unknown original command observation phase")
    if root.resolve(strict=True) != root:
        raise RuntimeError("Command observation parent is not canonical")
    parent = root.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or stat.S_IMODE(parent.st_mode) != 0o700
            or (parent.st_uid, parent.st_gid) != (caller['uid'], caller['gid'])):
        raise RuntimeError("Command observation parent differs from captured caller custody")
    if phase == 'requested':
        if exit_code is not None:
            raise RuntimeError("Requested invocation cannot claim a command terminal")
        code = None
    else:
        if not isinstance(exit_code, str) or not re.fullmatch(r'0|[1-9][0-9]{0,2}', exit_code) or int(exit_code) > 255:
            raise RuntimeError("Original command terminal exit code is invalid")
        code = int(exit_code)
    observation = {
        'schemaVersion': 1,
        'kind': 'original-command-' + phase,
        'command': ['dpkg-buildpackage', '-b', '-us', '-uc', '--jobs=4'],
        'invocationRequested': True,
        'commandTerminalObserved': phase == 'terminal',
        'exitCode': code,
        'wrapperTerminalObserved': False,
        'wrapperExitCode': None,
    }
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
        if identity(opened) != identity(parent):
            raise RuntimeError("Command observation parent was replaced before opening")
        write_manifest(root / ('original-command-' + phase + '.json'), observation, caller, parent_fd=fd)
        if identity(os.fstat(fd)) != identity(parent) or identity(root.lstat()) != identity(parent):
            raise RuntimeError("Command observation parent changed during the write")
        os.fsync(fd)
    finally:
        os.close(fd)


_report_codec_module = None


def report_codec():
    global _report_codec_module
    if _report_codec_module is None:
        file = Path(__file__).resolve().with_name('c-producer-report-codec.py')
        spec = importlib.util.spec_from_file_location('checktrail_c_report_codec', file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _report_codec_module = module
    return _report_codec_module


class ReportLines:
    def __init__(self):
        self.counts = {key: 0 for key in ['PASS', 'FAIL', 'XFAIL', 'XPASS', 'UNSUPPORTED', 'UNRESOLVED', 'UNTESTED', 'ERROR', 'SKIP']}
        self.total = 0
        self.prefix = b''
        self.has_bytes = False
        self.pending_cr = False

    def segment(self, raw):
        self.prefix += raw[:max(0, 16 - len(self.prefix))]
        self.has_bytes = self.has_bytes or bool(raw)

    def line(self):
        match = re.match(rb'^(PASS|FAIL|XFAIL|XPASS|UNSUPPORTED|UNRESOLVED|UNTESTED|ERROR|SKIP):(?:[ \t\f\v]|$)', self.prefix)
        if match:
            self.counts[match[1].decode('ascii')] += 1
        self.total += 1
        self.prefix, self.has_bytes = b'', False

    def feed(self, raw):
        start = 0
        if self.pending_cr:
            self.pending_cr = False
            if raw.startswith(b'\n'):
                start = 1
        position = start
        for match in re.finditer(rb'\r\n|\n|\r', raw[start:]):
            begin, end = start + match.start(), start + match.end()
            self.segment(raw[position:begin])
            self.line()
            self.pending_cr = match.group() == b'\r' and end == len(raw)
            position = end
        self.segment(raw[position:])

    def finish(self):
        if self.has_bytes:
            self.line()
        return {'counts': self.counts, 'totalLines': self.total, 'otherLines': self.total - sum(self.counts.values())}


def collect(profile, source, destination, caller):
    roots = {"gcc-12": ["build", "build-cross", "build-jit", "build-nvptx", "build-gcn", "build-hppa64"], "glibc": ["build-tree"], "glibc-u13": ["build-tree"]}[profile]
    codec = report_codec()
    limits = codec.POLICY['limits']
    retained = destination.parent / "original-test-reports"
    rows, skipped_links = [], []
    root_presence = {}
    total_bytes, stored_bytes, chunk_count, logical_files, entries = 0, 0, 0, 0, 0
    started = time.monotonic()
    if source.resolve(strict=True) != source or not stat.S_ISDIR(source.lstat().st_mode):
        raise RuntimeError("Original source root is not a canonical physical directory")
    copies = RetainedCopies(retained, caller)

    def retain(file, capture=False):
        nonlocal total_bytes, stored_bytes, chunk_count, logical_files
        relative = file.relative_to(source).as_posix()
        before = None
        def refusal(reason, label="Original report/log changed while read", **details):
            value = {"file": relative, "reason": reason, **details}
            if before is not None:
                value.update(bytes=before.st_size, mode=oct(before.st_mode))
            return ReportRetentionError(label + ': ' + json.dumps(value, sort_keys=True, separators=(',', ':')))
        try:
            before = file.lstat()
        except OSError as error:
            raise refusal('source-io-error', 'Original report/log IO failed', errno=error.errno) from error
        if not stat.S_ISREG(before.st_mode):
            raise refusal('nonregular-source', 'Nonphysical or oversized original report/log')
        if before.st_size > limits['decodedFileBytes']:
            raise refusal('decoded-file-bytes-exceeded', 'Original report/log decoded file bound exceeded', limitBytes=limits['decodedFileBytes'])
        logical_files += 1
        total_bytes += before.st_size
        if logical_files > limits['logicalFileCount']:
            raise refusal('logical-file-count-exceeded', 'Original report/log inventory bound exceeded')
        if total_bytes > limits['decodedFamilyBytes']:
            raise refusal('decoded-family-bytes-exceeded', 'Original report/log decoded family bound exceeded', retainedBytes=total_bytes, limitBytes=limits['decodedFamilyBytes'])
        identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        source_fd = None
        phase = 'source'
        digest, read_bytes, chunks = hashlib.sha256(), 0, []
        lines = ReportLines() if capture else None
        try:
            source_fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            opened = os.fstat(source_fd)
            if not stat.S_ISREG(opened.st_mode) or identity(before) != identity(opened):
                raise refusal('source-identity-changed')
            while read_bytes < before.st_size:
                wanted = min(limits['decodedChunkBytes'], before.st_size - read_bytes)
                parts, actual = [], 0
                while actual < wanted:
                    try:
                        raw = os.read(source_fd, wanted - actual)
                    except OSError as error:
                        raise refusal('source-io-error', 'Original report/log IO failed', errno=error.errno) from error
                    if not raw:
                        raise refusal('source-size-changed', observedBytes=read_bytes + actual)
                    parts.append(raw)
                    actual += len(raw)
                raw = b''.join(parts)
                if lines is not None:
                    lines.feed(raw)
                digest.update(raw)
                encoded = codec.encode_gzip_chunk(raw)
                if chunk_count >= limits['chunkCount']:
                    raise refusal('chunk-count-exceeded', 'Original report/log chunk inventory bound exceeded')
                if stored_bytes + len(encoded) > limits['storedFamilyBytes']:
                    raise refusal('stored-family-bytes-exceeded', 'Original report/log encoded family bound exceeded', storedBytes=stored_bytes + len(encoded), limitBytes=limits['storedFamilyBytes'])
                name = 'encoded/%08d.gz' % chunk_count
                phase = 'copy'
                pieces = (encoded[index:index + 1024 ** 2] for index in range(0, len(encoded), 1024 ** 2))
                pin = copies.write_stream(name, pieces, lambda: None)
                pin.update(offset=read_bytes, decodedBytes=len(raw), decodedSha256=hashlib.sha256(raw).hexdigest())
                chunks.append(pin)
                chunk_count += 1
                stored_bytes += len(encoded)
                read_bytes += len(raw)
                phase = 'source'
            # Read at most the original declared size plus one actual byte.
            extra = os.read(source_fd, 1)
            if extra:
                raise refusal('source-size-changed', observedBytes=read_bytes + len(extra))
            after, final = os.fstat(source_fd), file.lstat()
            if not stat.S_ISREG(final.st_mode) or not identity(before) == identity(opened) == identity(after) == identity(final):
                raise refusal('source-identity-changed')
            pin = {'file': relative, 'bytes': read_bytes, 'sha256': digest.hexdigest(), 'chunks': chunks}
            return pin, lines.finish() if lines is not None else None
        except ReportRetentionError:
            raise
        except OSError as error:
            raise refusal(phase + '-io-error', 'Original report/log IO failed', errno=error.errno) from error
        except RuntimeError as error:
            raise refusal('copy-failed', 'Original report/log copy failed', detail=str(error)[:1024]) from error
        finally:
            if source_fd is not None:
                os.close(source_fd)

    original_error = None
    custody_error = None
    try:
      for root_name in roots:
        root = source / root_name
        if not root.exists() and not root.is_symlink():
            root_presence[root_name] = False
            continue
        if not stat.S_ISDIR(root.lstat().st_mode):
            raise RuntimeError("Generated report root is not a physical directory")
        root_presence[root_name] = True
        for current, directories, files in os.walk(root, followlinks=False):
            entries += 1 + len(files) + len(directories)
            if entries > limits['discoveryEntries'] or time.monotonic() - started > limits['discoverySeconds'] or len(Path(current).relative_to(root).parts) > limits['pathDepth']:
                raise RuntimeError("Original report discovery bound exceeded")
            base = Path(current)
            for name in list(directories):
                if (base / name).is_symlink():
                    skipped_links.append((base / name).relative_to(source).as_posix())
                    directories.remove(name)
            for name in sorted(files):
                if not name.endswith((".sum", ".trs")):
                    continue
                file = base / name
                row, statistics = retain(file, capture=True)
                row.update(configuration=root_name, format="original-sum" if name.endswith(".sum") else "original-trs", **statistics)
                if name.endswith(".trs"):
                    row["outcomesInterpreted"] = False
                log = file.with_suffix(".log")
                if log.exists() or log.is_symlink():
                    row["log"], _ = retain(log)
                rows.append(row)
                if len(rows) > limits['reportCount'] or len(skipped_links) > limits['reportCount']:
                    raise RuntimeError("Original report inventory bound exceeded")
    except BaseException as error:
        original_error = error
    finally:
        try:
            custody = copies.finish()
        except BaseException as error:
            custody_error = error
        finally:
            copies.close()
    if original_error is not None:
        if custody_error is not None:
            raise RuntimeError("Original report collection failed: " + repr(original_error) + "; copy custody also failed: " + repr(custody_error)) from original_error
        raise original_error
    if custody_error is not None:
        raise custody_error
    report = {"schemaVersion": 3, "encoding": {'id': codec.POLICY['id'], 'sha256': codec.POLICY_SHA256}, "profile": profile, "generatedBuildRoots": roots, "reports": rows, "retainedBytes": total_bytes, "storedBytes": stored_bytes, "skippedLinkedDirectories": skipped_links, "exportCustody": custody, "completeConfigurationInventoryAssessed": False, "duplicateReportsAreIndependentEvidence": False, "allOriginalTestsPassRequired": False, "fullCompilerSdkBootstrapClosureVerified": False, "gateAComplete": False}
    if profile == "gcc-12":
        report["buildRootStates"] = []
        for name in roots:
            count = sum(row["configuration"] == name for row in rows)
            report["buildRootStates"].append({"root": name, "origin": "compatibility" if name == "build-cross" else "source", "state": "absent" if not root_presence[name] else "present-with-reports" if count else "present-no-reports", "reports": count})
    codec.validate_transport(report)
    write_manifest(destination, report, caller)


if __name__ == "__main__":
    if sys.argv[1] == '--command-observation':
        if len(sys.argv) not in (6, 7):
            raise RuntimeError("Fixed command observation phase/root/caller/exit arguments required")
        write_command_observation(sys.argv[2], Path(sys.argv[3]), parse_caller_identity(sys.argv[4], sys.argv[5]), sys.argv[6] if len(sys.argv) == 7 else None)
    elif sys.argv[1] == '--custody-preflight':
        if len(sys.argv) != 5 or sys.argv[2] != '/custody':
            raise RuntimeError("Only the fixed synthetic custody preflight is supported")
        caller = parse_caller_identity(sys.argv[3], sys.argv[4])
        source = Path('/tmp/custody-source')
        (source / 'build-tree/amd64-libc').mkdir(parents=True)
        (source / 'build-tree/amd64-libc/tests.sum').write_bytes(b'PASS: synthetic custody preflight\n')
        (source / 'build-tree/amd64-libc/tests.log').write_bytes(b'Original synthetic custody bytes\n')
        collect('glibc', source, Path('/custody/test-reports.json'), caller)
    else:
        if len(sys.argv) != 6:
            raise RuntimeError("Captured caller UID/GID arguments are required")
        collect(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), parse_caller_identity(sys.argv[4], sys.argv[5]))
