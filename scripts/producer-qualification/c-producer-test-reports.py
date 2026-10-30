"""Bounded data-only retention; original configurations are never pooled."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


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


def write_manifest(destination, report, caller):
    raw = (json.dumps(report, indent=2) + '\n').encode()
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
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


def collect(profile, source, destination, caller):
    roots = {"gcc-12": ["build", "build-cross"], "glibc": ["build-tree"]}[profile]
    retained = destination.parent / "original-test-reports"
    rows, skipped_links = [], []
    total_bytes, entries = 0, 0
    started = time.monotonic()
    if source.resolve(strict=True) != source or not stat.S_ISDIR(source.lstat().st_mode):
        raise RuntimeError("Original source root is not a canonical physical directory")
    keys = ["PASS", "FAIL", "XFAIL", "XPASS", "UNSUPPORTED", "UNRESOLVED", "UNTESTED", "ERROR", "SKIP"]
    copies = RetainedCopies(retained, caller)

    def retain(file):
        nonlocal total_bytes
        before = file.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > 64 * 1024 ** 2:
            raise RuntimeError("Nonphysical or oversized original report/log")
        total_bytes += before.st_size
        if total_bytes > 512 * 1024 ** 2:
            raise RuntimeError("Original report/log aggregate bound exceeded")
        with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW), "rb") as handle:
            opened = os.fstat(handle.fileno())
            raw = handle.read(64 * 1024 ** 2 + 1)
            after = os.fstat(handle.fileno())
        final = file.lstat()
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if (len(raw) != before.st_size or len(raw) > 64 * 1024 ** 2
                or not stat.S_ISREG(final.st_mode)
                or not identity(before) == identity(opened) == identity(after) == identity(final)):
            raise RuntimeError("Original report/log changed while read")
        relative = file.relative_to(source).as_posix()
        copies.write(relative, raw)
        return {"file": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}, raw

    original_error = None
    custody_error = None
    try:
      for root_name in roots:
        root = source / root_name
        if not root.exists() and not root.is_symlink():
            continue
        if not stat.S_ISDIR(root.lstat().st_mode):
            raise RuntimeError("Generated report root is not a physical directory")
        for current, directories, files in os.walk(root, followlinks=False):
            entries += 1 + len(files) + len(directories)
            if entries > 1000000 or time.monotonic() - started > 30 or len(Path(current).relative_to(root).parts) > 128:
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
                row, raw = retain(file)
                lines = re.split(rb"\r\n|\n|\r", raw) if raw else []
                if raw.endswith((b"\n", b"\r")):
                    lines.pop()
                counts = {key: 0 for key in keys}
                for line in lines:
                    match = re.match(rb"^(PASS|FAIL|XFAIL|XPASS|UNSUPPORTED|UNRESOLVED|UNTESTED|ERROR|SKIP):(?:[ \t\f\v]|$)", line)
                    if match:
                        counts[match[1].decode("ascii")] += 1
                row.update(configuration=root_name, format="original-sum" if name.endswith(".sum") else "original-trs", counts=counts, totalLines=len(lines), otherLines=len(lines) - sum(counts.values()))
                if name.endswith(".trs"):
                    # Retain exact Automake bytes without pretending colon metadata is a sum.
                    row["outcomesInterpreted"] = False
                log = file.with_suffix(".log")
                if log.exists() or log.is_symlink():
                    row["log"], _ = retain(log)
                rows.append(row)
                if len(rows) > 8192 or len(skipped_links) > 8192:
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
    report = {"schemaVersion": 1, "profile": profile, "generatedBuildRoots": roots, "reports": rows, "retainedBytes": total_bytes, "skippedLinkedDirectories": skipped_links, "exportCustody": custody, "completeConfigurationInventoryAssessed": False, "duplicateReportsAreIndependentEvidence": False, "allOriginalTestsPassRequired": False, "fullCompilerSdkBootstrapClosureVerified": False, "gateAComplete": False}
    write_manifest(destination, report, caller)


if __name__ == "__main__":
    if sys.argv[1] == '--custody-preflight':
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
