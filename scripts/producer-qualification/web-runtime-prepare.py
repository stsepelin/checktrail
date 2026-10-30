"""Data-only pinned-archive preparation. No installer, project hook or compiler."""
import base64
import hashlib
import json
import os
import posixpath
import re
import struct
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

MAX_FILE = 512 * 1024**2
MAX_OVERLAY = 2 * 1024**3
NOTICE = re.compile(r"(^|[-_.])(licen[cs]e|copying|notice|copyright)([-_.]|$)", re.I)

def safe_parts(name):
    assert isinstance(name, str) and 0 < len(name) <= 4096
    assert not any(c in name for c in ["\\", "\x00", ":"])
    assert not name.startswith("/")
    parts = name.rstrip("/").split("/")
    assert all(part and part not in [".", ".."] for part in parts)
    return parts

def sha(body):
    return hashlib.sha256(body).hexdigest()

def regular(file, maximum=512 * 1024**2):
    assert file.is_absolute() and file.resolve() == file and not file.is_symlink()
    stat = file.stat()
    assert file.is_file() and 0 <= stat.st_size <= maximum
    body = file.read_bytes()
    after = file.stat()
    assert (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
    return body

def write(file, body, mode=0o600):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert file.parent.resolve() == file.parent
    with file.open("xb") as out:
        os.chmod(file, mode)
        out.write(body)
        out.flush()
        os.fsync(out.fileno())

def encode_index(entries):
    assert entries and len(entries) <= 1024
    body = b"\x03" + struct.pack("<I", 2) + ("manual-sha256:" + sha("\n".join(entries).encode())).encode() + b"\x00"
    seen = set()
    for line in entries:
        value = json.loads(line)
        version = value["vers"]
        assert version not in seen and "\x00" not in line and "\x00" not in version
        seen.add(version)
        body += version.encode() + b"\x00" + line.encode() + b"\x00"
    return body

def archive(file):
    """Enumerate data without executing extractors or honoring archive ownership."""
    with tarfile.open(file, "r|*") as opened:
        count = 0
        for member in opened:
            count += 1
            assert count <= 2000000
            if member.isdir() and member.name.rstrip("/") == ".":
                continue
            name = member.name[2:] if member.name.startswith("./") else member.name
            parts = safe_parts(name)
            assert member.isdir() or member.isfile() or member.issym() or member.islnk()
            if member.isfile():
                assert 0 <= member.size <= MAX_FILE
            yield opened, member, parts

def package_data(file):
    roots = set()
    package = None
    for opened, member, parts in archive(file):
        roots.add(parts[0])
        assert len(roots) == 1
        if member.isfile() and len(parts) == 2 and parts[1] == "package.json":
            assert package is None and member.size <= 2 * 1024**2
            package = json.loads(opened.extractfile(member).read())
    assert package is not None
    return package

# One original signed Rust component carries a larger complete copyright notice.
# Every other notice keeps the general limit; this is an exact byte identity.
MAX_NOTICE = 4 * 1024**2
LARGE_ORIGINAL_NOTICES = {
    ("components/rustc-1.98.1-x86_64-unknown-linux-gnu.tar.xz",
     "rustc-1.98.1-x86_64-unknown-linux-gnu/rustc/share/doc/rust/COPYRIGHT.html"):
        {"bytes": 15380909,
         "sha256": "5b0c93fc4e6d4b072eaa521b1762d1e746f4c368f65e81a0e5308e2772dac85e"}
}


def read_notice(opened, member, archive_name):
    assert member.isfile(), "Only regular original notice bytes are retained"
    exact = LARGE_ORIGINAL_NOTICES.get((archive_name, member.name))
    if exact is None:
        assert 0 <= member.size <= MAX_NOTICE, "Unregistered oversized original notice"
    else:
        assert member.size == exact["bytes"], "Pinned original notice size differs"
    with opened.extractfile(member) as handle:
        data = handle.read(member.size + 1)
    assert len(data) == member.size, "Original notice member was incomplete"
    if exact is not None:
        assert sha(data) == exact["sha256"], "Pinned original notice bytes differ"
    return data


def prepare(directory, catalog, frozen):
    import tomllib
    assert directory.is_absolute() and directory.resolve() == directory
    downloads = directory / "downloads"
    overlay = directory / "context/overlay/usr/local"
    overlay.mkdir(parents=True, mode=0o755)
    copied, targets, total = [], set(), 0
    # Exact official component archives; installers and their shell scripts are never run.
    for component in catalog["components"]:
        file = downloads / component["file"]
        body = regular(file)
        assert len(body) == component["bytes"] and sha(body) == component["sha256"]
        for opened, member, parts in archive(file):
            if component["name"] == "outer-node24":
                relative = parts[1:]
            elif len(parts) > 2 and parts[1] in ["cargo", "rustc", "rust-std-x86_64-unknown-linux-gnu"] and parts[2] != "manifest.in":
                relative = parts[2:]
            elif member.isfile():
                relative = ["share", "doc", "checktrail-runtime-inputs", component["name"], *parts[1:]]
            else:
                continue
            if not relative or member.isdir():
                continue
            name = "/".join(relative)
            safe_parts(name)
            assert name not in targets
            targets.add(name)
            target = overlay / name
            # A copied earlier symlink may never become a later traversal parent.
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            assert target.parent.resolve() == target.parent
            if member.issym():
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                safe_parts(resolved)
                assert not member.linkname.startswith("/") and "\\" not in member.linkname
                target.symlink_to(member.linkname)
                copied.append({"target": "/usr/local/" + name, "type": "symlink", "linkname": member.linkname})
            else:
                assert member.isfile(), "Component hardlinks require an explicit reviewed mapping"
                data = opened.extractfile(member).read()
                assert len(data) == member.size
                total += len(data)
                assert total <= MAX_OVERLAY
                write(target, data, member.mode & 0o777)
                copied.append({"target": "/usr/local/" + name, "bytes": len(data), "sha256": sha(data), "mode": member.mode & 0o777})
    # Use the exact signed Node distribution's npm cache APIs, with no install step.
    npm_tool = directory / "npm-tool"
    npm_source = overlay / "lib/node_modules/npm"
    import shutil
    shutil.copytree(npm_source, npm_tool, symlinks=True)
    assert json.loads((npm_tool / "package.json").read_text())["version"] == catalog["versions"]["npmVersion"]
    # Read only pinned source metadata for lock/config admission; never import the project.
    wanted = {"Cargo.toml", "Cargo.lock", ".cargo/config.toml", "lib/binding_web/package-lock.json"}
    wanted.update(row["path"] for row in frozen["originalSourceFiles"] if row["path"].endswith("Cargo.toml"))
    source_data = {}
    for opened, member, parts in archive(downloads / "original/tree-sitter-source.archive"):
        relative = "/".join(parts[1:])
        if member.isfile() and relative in wanted:
            source_data[relative] = opened.extractfile(member).read()
    pins = {row["path"]: row for row in frozen["originalSourceFiles"]}
    for relative, data in source_data.items():
        assert relative in pins and len(data) == pins[relative]["bytes"] and sha(data) == pins[relative]["sha256"]
    lock = json.loads(source_data["lib/binding_web/package-lock.json"])
    assert lock["lockfileVersion"] == 3
    actual_npm = {k: v for k, v in lock["packages"].items() if k}
    assert len(actual_npm) == len(catalog["npm"])
    for row in catalog["npm"]:
        value = actual_npm[row["packagePath"]]
        assert value["resolved"] == row["url"] and value["integrity"] == row["integrity"] and value["version"] == row["version"]
        file = downloads / ("npm/" + row["sha256"] + ".tgz")
        data = regular(file, 32 * 1024**2)
        assert len(data) == row["bytes"] and sha(data) == row["sha256"]
        assert "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode() == row["integrity"]
        package = package_data(file)
        assert package["name"] == row["expectedName"] and package["version"] == row["version"]
    root = tomllib.loads(source_data["Cargo.toml"].decode())
    members = root["workspace"]["members"]
    assert members == ["crates/cli", "crates/config", "crates/generate", "crates/highlight", "crates/loader", "crates/tags", "crates/xtask", "crates/language", "lib"]
    assert source_data[".cargo/config.toml"] == b'[alias]\nxtask = "run --package xtask --"\n'
    for relative in ["Cargo.toml", *[member + "/Cargo.toml" for member in members]]:
        manifest = tomllib.loads(source_data[relative].decode())
        assert not any(key in manifest for key in ["patch", "replace"])
        def inspect(value):
            if isinstance(value, dict):
                assert not any(key in value for key in ["git", "registry", "registry-index"])
                for child in value.values():
                    inspect(child)
            elif isinstance(value, list):
                for child in value:
                    inspect(child)
        inspect(manifest)
    locked = [row for row in tomllib.loads(source_data["Cargo.lock"].decode())["package"] if "source" in row]
    assert len(locked) == len(catalog["cargo"])
    expected_crates = {(row["name"], row["version"]): row for row in catalog["cargo"]}
    for row in locked:
        assert row["source"] == "registry+https://github.com/rust-lang/crates.io-index"
        assert row["checksum"] == expected_crates[(row["name"], row["version"])]["checksum"]
    index = directory / "cargo-cache/registry/index" / catalog["cargoRegistry"]
    cache = directory / "cargo-cache/registry/cache" / catalog["cargoRegistry"]
    entries = {}
    for row in catalog["cargoIndices"]:
        safe_parts(row["registryPath"])
        assert row["sourceUrl"] == "https://index.crates.io/" + row["registryPath"]
        for line in row["entries"]:
            data = json.loads(line)
            key = (data["name"], data["vers"])
            assert key not in entries and data["cksum"] == expected_crates[key]["checksum"]
            entries[key] = data
        write(index / ".cache" / row["registryPath"], encode_index(row["entries"]))
    assert len(entries) == len(locked)
    write(index / "config.json", b'{"dl":"https://static.crates.io/crates","api":"https://crates.io"}\n')
    for row in catalog["cargo"]:
        source = downloads / ("cargo/" + row["name"] + "-" + row["version"] + ".crate")
        data = regular(source, 32 * 1024**2)
        assert len(data) == row["bytes"] and sha(data) == row["checksum"] == row["sha256"]
        write(cache / source.name, data)
    # Retain every original archive intact, plus an indexed notice view. The regex
    # is an aid to inspection, never a claim that all upstream notice obligations closed.
    notices = []
    for file in sorted(downloads.rglob("*")):
        if not file.is_file() or not (file.name.endswith((".tgz", ".crate", ".xz", ".gz", ".archive"))):
            continue
        if zipfile.is_zipfile(file):
            continue
        for opened, member, parts in archive(file):
            if member.isfile() and NOTICE.search(parts[-1]):
                data = read_notice(opened, member, str(file.relative_to(downloads)))
                key = sha(str(file.relative_to(downloads)).encode())
                dest = directory / "notices" / key / Path(*parts)
                write(dest, data)
                notices.append({"archive": str(file.relative_to(downloads)), "member": member.name, "bytes": len(data), "sha256": sha(data)})
    write(directory / "assembly-copy-manifest.json", (json.dumps(copied, indent=2) + "\n").encode())
    write(directory / "original-notices.json", (json.dumps(notices, indent=2) + "\n").encode())
    print(json.dumps({"componentRegularBytes": total, "npmLockedPaths": len(actual_npm), "cargoLockedCrates": len(locked), "originalArchivesRetained": True, "completeNoticeClosureVerified": False, "projectCodeExecuted": False, "compilerExecuted": False}))

if __name__ == "__main__":
    assert len(sys.argv) == 4
    directory = Path(sys.argv[1])
    prepare(directory, json.loads(Path(sys.argv[2]).read_text()), json.loads(Path(sys.argv[3]).read_text()))
