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
    products = []
    if prefix == "recipe":
        for relative in ["web-tree-sitter.wasm", "debug/web-tree-sitter.wasm"]:
            file = root / "work/source/lib/binding_web" / relative
            if file.exists() or file.is_symlink():
                products.append(("recipe/compiled-products/" + relative, file))
    selected = [(prefix + "/" + str(file.relative_to(root)), file, 4 * 1024**2)
                for file in sorted(candidates)]
    selected += [(name, file, 16 * 1024**2) for name, file in products]
    for name, file, maximum in selected:
        assert file.is_file() and not file.is_symlink() and file.resolve() == file
        stat = file.stat()
        assert stat.st_size <= maximum
        total += stat.st_size
        assert total <= 256 * 1024**2
        rows.append((name, file, stat, maximum))
assert rows, "No physical producer observations to retain"
with target.open("xb") as output:
    os.chmod(target, 0o600)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        index = []
        for name, file, stat, maximum in rows:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            with os.fdopen(os.open(file, flags), "rb") as handle:
                opened = os.fstat(handle.fileno())
                body = handle.read(maximum + 1)
                after = os.fstat(handle.fileno())
            final = file.lstat()
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            assert len(body) == stat.st_size and len(body) <= maximum
            assert identity(stat) == identity(opened) == identity(after) == identity(final)
            index.append({"file": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
            archive.writestr(name, body)
        archive.writestr("observations-index.json", json.dumps({"files": index, "rawSourceAndArchiveBodiesExported": False, "fixedCompiledWasmProductsExported": [name for name, _, _, _ in rows if name.startswith("recipe/compiled-products/")], "nativeQualificationClaimedByExporter": False}, indent=2))
    output.flush()
    os.fsync(output.fileno())
print(json.dumps({"retainedFiles": len(rows), "uncompressedBytes": total, "archiveBytes": target.stat().st_size}))
