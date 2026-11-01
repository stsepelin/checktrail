"""Read-only, fixed-root byte observer; never imports producer code."""
import json
import os
import stat
import sys
import time

ROOTS = ("/observed/bundle", "/observed/controls", "/observed/work")
MAX_ENTRIES = 1000000
MAX_BYTES = 2**53 - 1
MAX_SECONDS = 30


def count_roots(roots):
    result = {"bytes": 0, "files": 0, "directories": 0}
    started = time.monotonic()

    def visit(fd, depth):
        if depth > 128:
            raise ValueError("directory depth bound exceeded")
        result["directories"] += 1
        with os.scandir(fd) as entries:
            for entry in entries:
                if time.monotonic() - started > MAX_SECONDS:
                    raise ValueError("scan deadline exceeded")
                info = entry.stat(follow_symlinks=False)
                if result["files"] + result["directories"] >= MAX_ENTRIES:
                    raise ValueError("entry bound exceeded")
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        actual = os.fstat(child)
                        if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                            raise ValueError("directory identity changed")
                        visit(child, depth + 1)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    result["files"] += 1
                    result["bytes"] += info.st_size
                    if result["bytes"] > MAX_BYTES:
                        raise ValueError("byte counter bound exceeded")
                else:
                    raise ValueError("linked or nonregular retained work refused")

    for root in roots:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            visit(fd, 0)
        finally:
            os.close(fd)
    return result


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
            result = count_roots(ROOTS)
        except Exception as error:
            emit({"schemaVersion": 1, "kind": "error", "sequence": expected, "error": type(error).__name__ + ": " + str(error)[:500]})
            raise
        emit({"schemaVersion": 1, "kind": "sample", "sequence": expected, **result})
        expected += 1


if __name__ == "__main__":
    main()
