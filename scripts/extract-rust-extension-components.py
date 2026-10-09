"""Validate all selected public archives before extracting any task-owned payload."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

def require(condition, message):
    if not condition:
        raise ValueError(message)


root = Path(__file__).resolve().parent.parent
pins = json.loads((root / "scripts/rust-extension-components.json").read_text())
archives = root / ".checktrail/rust-extension-components"
payload = root / ".checktrail/rust-extension-payload"
require(not payload.exists(), "Native payload already exists; retain and inspect it")
validated = []
entries = 0
expanded_bytes = 0
for row in pins["records"]:
    archive = archives / row["file"]
    data = archive.read_bytes()
    require(len(data) == row["bytes"], 'Native component archive preflight violation')
    require(hashlib.sha256(data).hexdigest() == row["sha256"], 'Native component archive preflight violation')
    prefix = row["file"][:-7]
    with tarfile.open(archive, "r:xz") as opened:
        for member in opened:
            entries += 1
            expanded_bytes += member.size
            name = PurePosixPath(member.name)
            require(entries <= 20000 and expanded_bytes <= 2 * 1024**3, 'Native component archive preflight violation')
            require(len(member.name) <= 1024 and len(name.parts) <= 32, 'Native component archive preflight violation')
            require(not name.is_absolute() and ".." not in name.parts, 'Native component archive preflight violation')
            require(name.parts and name.parts[0] == prefix, 'Native component archive preflight violation')
            require(member.isdir() or member.isfile() or member.issym() or member.islnk(), 'Native component archive preflight violation')
            if member.issym() or member.islnk():
                link = PurePosixPath(member.linkname)
                require(not link.is_absolute(), 'Native component archive preflight violation')
                target = os.path.normpath(str(name.parent / link) if member.issym() else str(link))
                require(PurePosixPath(target).parts[0] == prefix, 'Native component archive preflight violation')
    validated.append(archive)
stage = Path(tempfile.mkdtemp(prefix="rust-extension-payload-stage-", dir=archives.parent))
try:
    for archive in validated:
        subprocess.run(["tar", "-xJf", str(archive), "-C", str(stage)], check=True)
    os.rename(stage, payload)
finally:
    if stage.exists():
        shutil.rmtree(stage)
print(json.dumps({"archives": len(validated), "entries": entries, "expandedBytes": expanded_bytes, "allArchivesPreflightedBeforeExtraction": True}))
