"""Setup-only extraction of exact selected public Maven wrapper members."""
import hashlib
import json
import pathlib
import sys
import zipfile

archive, destination, table = map(pathlib.Path, sys.argv[1:4])
pins = json.loads(table.read_text(encoding="utf-8"))
raw = archive.read_bytes()
if len(raw) != 65218 or hashlib.sha256(raw).hexdigest() != "db7487641ba809ce66540a107e7d1ae8db6ba980480212fcc95e27eff82e68ec":
    raise ValueError("Selected Maven wrapper archive identity")
with zipfile.ZipFile(archive) as opened:
    names = opened.namelist()
    if len(names) != len(set(names)):
        raise ValueError("Duplicate wrapper archive members")
    payloads = []
    for pin in pins:
        name = pin["path"]
        if name not in ("mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.jar"):
            raise ValueError("Unselected wrapper member")
        info = opened.getinfo(name)
        if info.file_size != pin["bytes"]:
            raise ValueError("Wrapper member size")
        data = opened.read(info)
        if len(data) != pin["bytes"] or hashlib.sha256(data).hexdigest() != pin["sha256"]:
            raise ValueError("Wrapper member digest")
        target = destination / name
        if target.exists() or target.is_symlink():
            raise ValueError("Existing wrapper output")
        payloads.append((target, data))
    # Every selected payload is validated before any member is written.
    for target, data in payloads:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)
