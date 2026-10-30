"""Bounded observation export only; inputs/work/source trees are not uploaded."""
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path
assert len(sys.argv) == 4
inputs, result, target = [Path(value) for value in sys.argv[1:]]
assert target.is_absolute() and not target.exists() and target.parent.resolve() == target.parent
rows = []
total = 0
for prefix, root in [("preparation", inputs), ("recipe", result)]:
    if not root.exists():
        continue
    assert root.resolve() == root and not root.is_symlink()
    candidates = list(root.glob("*.json")) + list(root.glob("*.log"))
    if prefix == "recipe":
        candidates += list((root / "worker-receipts").glob("*.json")) + list((root / "worker-receipts").glob("*.log"))
    for file in sorted(candidates):
        assert file.is_file() and not file.is_symlink() and file.resolve() == file
        stat = file.stat()
        assert stat.st_size <= 4 * 1024**2
        total += stat.st_size
        assert total <= 256 * 1024**2
        rows.append((prefix + "/" + str(file.relative_to(root)), file, stat))
assert rows, "No physical producer observations to retain"
with target.open("xb") as output:
    os.chmod(target, 0o600)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        index = []
        for name, file, stat in rows:
            body = file.read_bytes()
            after = file.stat()
            assert (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            index.append({"file": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
            archive.writestr(name, body)
        archive.writestr("observations-index.json", json.dumps({"files": index, "rawSourceAndArchiveBodiesExported": False, "nativeQualificationClaimedByExporter": False}, indent=2))
    output.flush()
    os.fsync(output.fileno())
print(json.dumps({"retainedFiles": len(rows), "uncompressedBytes": total, "archiveBytes": target.stat().st_size}))
