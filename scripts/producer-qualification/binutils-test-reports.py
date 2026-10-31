"""Retain original result files and logs; this is not full build qualification."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

source, destination = map(Path, sys.argv[1:])
rows = []
untraversed_links = []
link_metadata_bytes = 0
retained = destination.parent / "original-test-reports"
retained.mkdir()
limit = 1024 * 1024


def physical_bytes(file, maximum=limit):
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
        raise RuntimeError("Unbounded or nonphysical original test report/log")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(file, flags), "rb") as handle:
        opened = os.fstat(handle.fileno())
        raw = handle.read(maximum + 1)
        after = os.fstat(handle.fileno())
    final = file.lstat()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size,
                              value.st_mtime_ns, value.st_ctime_ns)
    if (len(raw) > maximum or len(raw) != opened.st_size
            or not stat.S_ISREG(final.st_mode)
            or not identity(before) == identity(opened) == identity(after) == identity(final)):
        raise RuntimeError("Original report/log changed or exceeded its byte bound")
    return raw


def outcomes(raw, report_format):
    lines = re.split(rb"\r\n|\n|\r", raw) if raw else []
    if raw.endswith((b"\r", b"\n")):
        lines.pop()
    if report_format == "dejagnu":
        keys = ["PASS", "FAIL", "XFAIL", "XPASS", "UNSUPPORTED", "UNRESOLVED", "UNTESTED", "ERROR"]
        counts = {key: 0 for key in keys}
        other = 0
        for line in lines:
            match = re.match(rb"^(PASS|FAIL|XFAIL|XPASS|UNSUPPORTED|UNRESOLVED|UNTESTED|ERROR):(?:[ \t\f\v]|$)", line)
            if match:
                counts[match[1].decode("ascii")] += 1
            else:
                other += 1
        return counts, other, len(lines), None
    metadata = {}
    for line in lines:
        match = re.fullmatch(rb":(test-result|global-test-result|recheck|copy-in-global-log): ([A-Za-z]+)", line)
        if not match or match[1].decode("ascii") in metadata:
            raise RuntimeError("Original Automake result has unknown or duplicate fields")
        metadata[match[1].decode("ascii")] = match[2].decode("ascii")
    keys = ["PASS", "FAIL", "XFAIL", "XPASS", "SKIP", "ERROR"]
    result = metadata.get("test-result")
    expected_recheck = "yes" if result in ["FAIL", "XPASS", "ERROR"] else "no"
    expected_copy = "no" if result == "PASS" else "yes"
    if (set(metadata) != {"test-result", "global-test-result", "recheck", "copy-in-global-log"}
            or result not in keys or metadata["global-test-result"] != result
            or metadata["recheck"] != expected_recheck
            or metadata["copy-in-global-log"] != expected_copy):
        raise RuntimeError("Original Automake result is missing, unsupported or inconsistent")
    return {key: int(key == result) for key in keys}, len(lines) - 1, len(lines), metadata


def retain(file, raw):
    relative = file.relative_to(source)
    target = retained / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as handle:
        handle.write(raw)
    return {"file": relative.as_posix(), "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest()}


for directory in sorted(source.glob("builddir-*")):
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError("Nonphysical generated build directory")
    (retained / directory.name).mkdir()
    for current, directories, files in os.walk(directory, followlinks=False):
        base = Path(current)
        for name in sorted(directories):
            file = base / name
            before = file.lstat()
            if not stat.S_ISLNK(before.st_mode):
                continue
            if name.endswith((".sum", ".trs")):
                raise RuntimeError("Linked original test-report path: " + str(file.relative_to(source)))
            target = os.readlink(os.fsencode(file))
            after = file.lstat()
            identity = lambda value: (value.st_dev, value.st_ino, value.st_mode,
                                      value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            relative = file.relative_to(source).as_posix()
            path_bytes = relative.encode("utf-8", errors="strict")
            link_metadata_bytes += len(path_bytes) + len(target)
            if (identity(before) != identity(after)
                    or not 0 < len(target) <= 4096 or len(path_bytes) > 4096
                    or len(untraversed_links) >= 8192 or link_metadata_bytes > 1024 * 1024):
                raise RuntimeError("Changed or over-bound untraversed directory-link metadata")
            untraversed_links.append({"file": relative, "targetBytes": len(target),
                                      "targetSha256": hashlib.sha256(target).hexdigest(),
                                      "targetBase64": base64.b64encode(target).decode("ascii")})
            # Never traverse or copy a link target. Its contents are unknown evidence.
            directories.remove(name)
        for name in sorted(files):
            if not name.endswith((".sum", ".trs")):
                continue
            file = base / name
            report_format = "automake-trs" if name.endswith(".trs") else "dejagnu"
            raw = physical_bytes(file)
            counts, other, total, metadata = outcomes(raw, report_format)
            row = {**retain(file, raw), "configuration": directory.name,
                   "format": report_format, "counts": counts,
                   "otherLines": other, "totalLines": total}
            if metadata is not None:
                row["metadata"] = metadata
            log = file.with_suffix(".log")
            if report_format == "automake-trs" or log.exists() or log.is_symlink():
                row["log"] = retain(log, physical_bytes(log, 8 * limit))
            rows.append(row)
            if len(rows) > 1024:
                raise RuntimeError("Original report inventory exceeded bound")
report = {"schemaVersion": 1, "scope": "Original DejaGNU .sum and Automake .trs files with associated logs under generated builddir-* configurations; repeated reports are not independent evidence.",
          "reports": rows, "untraversedDirectoryLinks": untraversed_links,
          "directoryLinkTargetsAssessed": False,
          "completeConfigurationInventoryAssessed": False,
          "fullCompilerSdkBootstrapClosureVerified": False, "completeOriginalNoticeClosureVerified": False, "gateAComplete": False}
with destination.open("x", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
    handle.write("\n")
