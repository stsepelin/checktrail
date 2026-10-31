"""Go carrier fixed-root observer; same protocol, with its approved regular-leaf cap."""
import json
import os
import stat
import sys
import time

ROOTS = ("/observed/bundle", "/observed/controls", "/observed/work")
MAX_ENTRIES = 1000000
MAX_BYTES = 2**53 - 1
MAX_LEAF_BYTES = 512 * 1024**2
MAX_SECONDS = 30
MAX_SCAN_ATTEMPTS = 3


def count_roots(roots, sequence=1):
    if len(roots) != 3 or type(sequence) is not int or sequence < 1:
        raise ValueError("fixed three-root sample identity required")
    started = time.monotonic()
    opened = []

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)

    def require_roots():
        for root, fd, original in opened:
            if identity(os.stat(root, follow_symlinks=False)) != original or identity(os.fstat(fd)) != original:
                raise ValueError("fixed root identity changed")

    def require_deadline():
        if time.monotonic() - started > MAX_SECONDS:
            raise ValueError("scan deadline exceeded")

    def visit(fd, depth, result):
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
                        visit(child, depth + 1, result)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    if info.st_size > MAX_LEAF_BYTES:
                        raise ValueError("Go retained regular-leaf bound exceeded")
                    result["files"] += 1
                    result["bytes"] += info.st_size
                    if result["bytes"] > MAX_BYTES:
                        raise ValueError("byte counter bound exceeded")
                else:
                    raise ValueError("linked or nonregular retained work refused")

    try:
        for root in roots:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            opened.append((root, fd, identity(os.fstat(fd))))
        require_roots()
        fixed = {"bytes": 0, "files": 0, "directories": 0}
        # Archives and controls are immutable: even a disappearance refuses.
        for _, fd, _ in opened[:2]:
            visit(fd, 0, fixed)
        for attempt in range(1, MAX_SCAN_ATTEMPTS + 1):
            require_roots()
            # Every retry discards all partial work counters under the same clock.
            result = dict(fixed)
            try:
                visit(opened[2][1], 0, result)
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
    finally:
        for _, fd, _ in reversed(opened):
            os.close(fd)


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
            emit({"schemaVersion": 1, "kind": "error", "sequence": expected, "error": type(error).__name__ + ": " + str(error)[:500]})
            raise
        emit({"schemaVersion": 1, "kind": "sample", "sequence": expected, **result})
        expected += 1


if __name__ == "__main__":
    main()
