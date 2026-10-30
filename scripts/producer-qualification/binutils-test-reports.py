"""Retain per-file original upstream outcomes; this is not full build qualification."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

source, destination = map(Path, sys.argv[1:])
rows = []
retained = destination.parent / "original-test-reports"
retained.mkdir()
limit = 1024 * 1024
for directory in sorted(source.glob("builddir-*")):
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError("Nonphysical generated build directory")
    (retained / directory.name).mkdir()
    for current, directories, files in os.walk(directory, followlinks=False):
        base = Path(current)
        if any((base / name).is_symlink() for name in directories):
            raise RuntimeError("Linked build-report directory")
        for name in sorted(files):
            if not name.endswith(".sum"):
                continue
            file = base / name
            if file.is_symlink() or not file.is_file() or file.stat().st_size > limit:
                raise RuntimeError("Unbounded or nonphysical original test report")
            raw = file.read_bytes()
            counts = {key: 0 for key in ["PASS", "FAIL", "XFAIL", "XPASS", "UNSUPPORTED", "UNRESOLVED", "UNTESTED", "ERROR"]}
            lines = raw.splitlines()
            other = 0
            for line in lines:
                match = re.match(rb"^(PASS|FAIL|XFAIL|XPASS|UNSUPPORTED|UNRESOLVED|UNTESTED|ERROR):(?:\s|$)", line)
                if match:
                    counts[match[1].decode("ascii")] += 1
                else:
                    other += 1
            relative = file.relative_to(source)
            target = retained / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as handle:
                handle.write(raw)
            rows.append({"file": relative.as_posix(), "configuration": directory.name,
                         "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                         "counts": counts, "otherLines": other, "totalLines": len(lines)})
            if len(rows) > 1024:
                raise RuntimeError("Original report inventory exceeded bound")
report = {"schemaVersion": 1, "scope": "Original .sum files under original generated builddir-* configurations; repeated reports are not independent evidence.",
          "reports": rows, "completeConfigurationInventoryAssessed": False,
          "fullCompilerSdkBootstrapClosureVerified": False, "completeOriginalNoticeClosureVerified": False, "gateAComplete": False}
with destination.open("x", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
    handle.write("\n")
