"""Node fixed-root observer; counts link/socket objects without following or reading their contents."""
import json
import os
import stat
import sys
import time

ROOTS = ("/observed/bundle", "/observed/controls", "/observed/work")
MAX_ENTRIES = 1000000
MAX_BYTES = 2**53 - 1
MAX_LEAF_BYTES = 32 * 1024**3
MAX_SECONDS = 30
MAX_SCAN_ATTEMPTS = 3


def count_roots(roots, sequence=1):
    if len(roots) != 3 or type(sequence) is not int or sequence < 1:
        raise ValueError("fixed three-root sample identity required")
    started = time.monotonic()
    opened = []
    cleanup_failures = []
    primary = None

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)

    def require_roots():
        for root, fd, original in opened:
            if identity(os.stat(root, follow_symlinks=False)) != original or identity(os.fstat(fd)) != original:
                raise ValueError("fixed root identity changed")

    def require_deadline():
        if time.monotonic() - started > MAX_SECONDS:
            raise ValueError("scan deadline exceeded")

    def visit(fd, depth, result, allow_links):
        require_deadline()
        if depth > 128:
            raise ValueError("directory depth bound exceeded")
        result["directories"] += 1
        with os.scandir(fd) as entries:
            for entry in entries:
                require_deadline()
                info = entry.stat(follow_symlinks=False)
                if result["files"] + result["directories"] >= MAX_ENTRIES:
                    raise ValueError("entry bound exceeded")
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        actual = os.fstat(child)
                        if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                            raise ValueError("directory identity changed")
                        visit(child, depth + 1, result, allow_links)
                    except BaseException as error:
                        failure = error
                    else:
                        failure = None
                    try:
                        os.close(child)
                    except BaseException as error:
                        cleanup_failures.append({'type': type(error).__name__, 'message': str(error)[:256]})
                        if failure is None:
                            failure = error
                    if failure is not None:
                        raise failure
                elif stat.S_ISREG(info.st_mode):
                    if info.st_size > MAX_LEAF_BYTES:
                        raise ValueError("Node retained regular-leaf bound exceeded")
                    result["files"] += 1
                    result["bytes"] += info.st_size
                    if result["bytes"] > MAX_BYTES:
                        raise ValueError("byte counter bound exceeded")
                elif stat.S_ISLNK(info.st_mode) and allow_links:
                    # The target string is an object body, never a path to read.
                    target = os.fsencode(os.readlink(entry.name, dir_fd=fd))
                    after = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    link_identity = lambda row: (row.st_dev, row.st_ino, row.st_mode,
                        row.st_uid, row.st_gid, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
                    if link_identity(info) != link_identity(after) or len(target) != info.st_size or len(target) > 4096:
                        raise ValueError("Node link object changed or exceeded bound")
                    result['files'] += 1
                    result['bytes'] += len(target)
                    result['links'] += 1
                    result['linkTargetBytes'] += len(target)
                    if result['bytes'] > MAX_BYTES:
                        raise ValueError("byte counter bound exceeded")
                elif stat.S_ISSOCK(info.st_mode) and allow_links:
                    # Only mutable work may contain the original test sockets.
                    # Do not open/read/connect the endpoint or follow a target.
                    after = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    if identity(info) != identity(after):
                        raise ValueError("Node work socket identity changed")
                    result['files'] += 1
                    result['sockets'] += 1
                else:
                    raise ValueError("linked immutable input or nonregular retained work refused")

    try:
        for root in roots:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            opened.append((root, fd, None))
            opened[-1] = (root, fd, identity(os.fstat(fd)))
        require_roots()
        fixed = {"bytes": 0, "files": 0, "directories": 0, "links": 0, "linkTargetBytes": 0, "sockets": 0}
        # Archives and controls are immutable: even a disappearance refuses.
        for _, fd, _ in opened[:2]:
            visit(fd, 0, fixed, False)
        for attempt in range(1, MAX_SCAN_ATTEMPTS + 1):
            require_roots()
            # Every retry discards all partial work counters under the same clock.
            result = dict(fixed)
            try:
                visit(opened[2][1], 0, result, True)
            except FileNotFoundError:
                require_roots()
                if attempt == MAX_SCAN_ATTEMPTS:
                    raise
                print(json.dumps({"schemaVersion": 1, "kind": "mutable-work-scan-retry", "sequence": sequence, "discardedAttempt": attempt, "maximumAttempts": MAX_SCAN_ATTEMPTS, "errno": 2}, separators=(",", ":")), file=sys.stderr, flush=True)
                continue
            require_roots()
            require_deadline()
            return result
        raise AssertionError("bounded scan did not produce a complete result")
    except BaseException as error:
        primary = error
    finally:
        for _, fd, _ in reversed(opened):
            try:
                os.close(fd)
            except BaseException as error:
                cleanup_failures.append({'type': type(error).__name__, 'message': str(error)[:256]})
                if primary is None:
                    primary = error
        if primary is not None:
            primary.cleanupFailures = cleanup_failures
            raise primary


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def main():
    if len(sys.argv) != 1:
        raise ValueError("observer accepts no path or command arguments")
    emit({"schemaVersion": 1, "kind": "ready", "roots": list(ROOTS)})
    expected = 1
    while True:
        line = sys.stdin.buffer.readline(257)
        if not line:
            return
        if len(line) > 256 or not line.endswith(b"\n"):
            raise ValueError("request bound exceeded")
        request = json.loads(line)
        if request != {"schemaVersion": 1, "kind": "sample", "sequence": expected} or type(request.get("sequence")) is not int or type(request.get("schemaVersion")) is not int:
            raise ValueError("unexpected request or sequence")
        try:
            result = count_roots(ROOTS, expected)
        except Exception as error:
            print(json.dumps({'schemaVersion': 1, 'kind': 'node-observer-failure', 'sequence': expected,
                'primaryType': type(error).__name__, 'primaryMessage': str(error)[:500],
                'cleanupFailures': getattr(error, 'cleanupFailures', [])}, separators=(',', ':')),
                file=sys.stderr, flush=True)
            emit({"schemaVersion": 1, "kind": "error", "sequence": expected, "error": type(error).__name__ + ": " + str(error)[:500]})
            raise
        print(json.dumps({'schemaVersion': 1, 'kind': 'node-link-object-counts', 'sequence': expected,
            'links': result['links'], 'linkTargetBytes': result['linkTargetBytes'],
            'targetContentsFollowed': False, 'sockets': result['sockets'],
            'socketContentsRead': False}, separators=(',', ':')), file=sys.stderr, flush=True)
        emit({"schemaVersion": 1, "kind": "sample", "sequence": expected,
            **{key: result[key] for key in ['bytes', 'files', 'directories']}})
        expected += 1


if __name__ == "__main__":
    main()
