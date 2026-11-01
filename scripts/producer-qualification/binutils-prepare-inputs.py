"""Fixed data transformations in the selected original image; no package installs/builds."""
import hashlib
import io
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile


def checked_bytes(file, pin):
    assert file.is_file() and not file.is_symlink()
    assert file.stat().st_size == pin['bytes']
    raw = file.read_bytes()
    assert len(raw) == pin['bytes'] and hashlib.sha256(raw).hexdigest() == pin['sha256']
    return raw


def stream_identity(handle, maximum):
    digest, size = hashlib.sha256(), 0
    while True:
        chunk = handle.read(min(1024 * 1024, maximum - size + 1))
        if not chunk:
            break
        size += len(chunk)
        assert size <= maximum, 'Expanded data exceeds frozen limit'
        digest.update(chunk)
    return {'bytes': size, 'sha256': digest.hexdigest()}


def extract_keyring(package, member_name, pin):
    assert package.startswith(b'!<arch>\n')
    position, data, members = 8, None, []
    while position < len(package):
        header = package[position:position + 60]
        assert len(header) == 60 and header[-2:] == b'`\n'
        name = header[:16].decode('ascii').strip().removesuffix('/')
        assert name and name not in members and '/' not in name
        members.append(name)
        size = int(header[48:58].decode('ascii').strip())
        position += 60
        assert 0 <= size <= len(package) - position
        if name == 'data.tar.xz':
            assert data is None
            data = package[position:position + size]
        position += size
        if size % 2:
            assert package[position:position + 1] == b'\n'
            position += 1
    assert position == len(package) and data is not None
    selected, count, total = None, 0, 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r|xz') as archive:
        for member in archive:
            count += 1
            total += member.size
            assert count <= 4096 and 0 <= member.size and total <= 256 * 1024**2
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            assert not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
            if name == member_name:
                assert selected is None and member.isfile() and member.size == pin['bytes']
                handle = archive.extractfile(member)
                assert handle is not None
                selected = handle.read(member.size + 1)
                assert len(selected) == member.size
    assert selected is not None and hashlib.sha256(selected).hexdigest() == pin['sha256']
    return selected


def signed_payload_contains(text, pin, filename):
    sections = re.findall(r'(?m)^SHA256:\n((?: [^\n]+\n)+)', text)
    assert len(sections) == 1
    rows = {}
    for line in sections[0].splitlines():
        digest, size, name = line.strip().split()
        assert name not in rows
        rows[name] = {'bytes': int(size), 'sha256': digest}
    assert rows[filename] == {'bytes': pin['bytes'], 'sha256': pin['sha256']}


def main():
    plan = json.loads(Path('/controller/plan.json').read_text())
    assert plan['profile'] == 'original-binutils-public-input-acquisition-v1'
    downloads = {row['id']: row for row in plan['downloads']}
    rows = plan['operations']
    bundle, output, inputs = Path('/bundle'), Path('/output'), Path('/inputs')
    report = {'schemaVersion': 1, 'complete': False, 'releaseSignatures': [], 'sourceSignatureVerified': False, 'allSourceArchivesBoundBySignedDescriptor': False, 'compilerExecuted': False, 'packageInstalled': False, 'gateAComplete': False}
    for row in plan['transform']['toolIdentities']:
        physical = Path(os.path.realpath(row['file']))
        assert str(physical) == row['physicalFile']
        checked_bytes(physical, row)
    home = Path('/tmp/gpg-home')
    home.mkdir(mode=0o700)

    def verify(file, keyring, prefix, expected_valid=True):
        target = Path('/tmp') / (prefix + '.clear')
        result = subprocess.run(['gpgv', '--homedir', str(home), '--keyring', str(keyring), '--status-fd', '1', '--output', str(target), str(file)], capture_output=True, timeout=20)
        assert len(result.stdout) + len(result.stderr) <= 1024**2
        (output / (prefix + '.stdout')).write_bytes(result.stdout)
        (output / (prefix + '.stderr')).write_bytes(result.stderr)
        fingerprints = [line.split()[2] for line in result.stdout.decode('ascii').splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
        if not expected_valid:
            assert result.returncode != 0, 'Changed signature was accepted'
            return result.returncode
        assert result.returncode == 0 and fingerprints, 'Original signature is invalid'
        assert target.is_file() and target.stat().st_size <= 1024**2
        return target.read_text('ascii'), fingerprints

    for index, row in enumerate(x for x in rows if x['kind'] == 'original-apt-store-transform'):
        compressed = inputs / row['input']
        checked_bytes(compressed, downloads[row['input']])
        clear, fingerprints = verify(bundle / row['inRelease'], '/usr/share/keyrings/debian-archive-keyring.gpg', 'release-' + str(index))
        signed_payload_contains(clear, row['canonicalPayload'], 'main/binary-amd64/Packages')
        signed_payload_contains(clear, downloads[row['input']], 'main/binary-amd64/Packages.xz')
        with lzma.open(compressed, 'rb') as handle:
            assert stream_identity(handle, row['canonicalPayload']['bytes']) == row['canonicalPayload']
        target = bundle / row['file']
        assert not target.exists()
        uri = 'store:' + str(compressed)
        packet = f'600 URI Acquire\nURI: {uri}\nFilename: {target}\nExpected-SHA256: {row["canonicalPayload"]["sha256"]}\nExpected-Checksum-FileSize: {row["canonicalPayload"]["bytes"]}\n\n'.encode()
        result = subprocess.run(['/usr/lib/apt/methods/store'], input=packet, capture_output=True, timeout=30)
        assert len(result.stdout) + len(result.stderr) <= 1024**2
        (output / f'store-{index}.stdout').write_bytes(result.stdout)
        (output / f'store-{index}.stderr').write_bytes(result.stderr)
        assert result.returncode == 0
        responses = [part for part in result.stdout.split(b'\n\n') if part.startswith(b'201 URI Done\n')]
        assert len(responses) == 1
        fields = dict(line.split(b': ', 1) for line in responses[0].splitlines()[1:] if b': ' in line)
        assert fields[b'URI'] == uri.encode() and fields[b'Filename'] == str(target).encode()
        checked_bytes(target, row)
        if index == 0:
            original = (bundle / row['inRelease']).read_bytes()
            assert b'Origin: Debian' in original
            changed = Path('/tmp/changed-InRelease')
            changed.write_bytes(original.replace(b'Origin: Debian', b'Origin: Xebian', 1))
            bad_exit = verify(changed, '/usr/share/keyrings/debian-archive-keyring.gpg', 'release-mutant', False)
            restored, _ = verify(bundle / row['inRelease'], '/usr/share/keyrings/debian-archive-keyring.gpg', 'release-restored')
            assert restored == clear
            report['releaseSignatureFaultControl'] = {'changedExitCode': bad_exit, 'restoredExitCode': 0}
        report['releaseSignatures'].append({'file': row['inRelease'], 'validSignatureFingerprints': fingerprints, 'canonicalPayloadBoundToSignature': True, 'exactOriginalLz4': True})

    keys = [x for x in rows if x['kind'] == 'extract-fixed-regular-keyring-member']
    assert len(keys) == 1
    selected = keys[0]
    package = checked_bytes(inputs / selected['input'], downloads[selected['input']])
    keyring = extract_keyring(package, selected['member'], selected)
    target = bundle / selected['file']
    with target.open('xb') as handle:
        handle.write(keyring)
    checked_bytes(target, selected)
    source = bundle / 'source/binutils/binutils_2.40-2.dsc'
    clear, fingerprints = verify(source, target, 'source')
    assert 'D56571B88A8BBAF140BF63D6BD7EAA60778FA6F5' in fingerprints
    matches = re.findall(r'(?m)^Checksums-Sha256:\n((?: [^\n]+\n)+)', clear)
    assert len(matches) == 1
    found = {}
    for line in matches[0].splitlines():
        digest, size, filename = line.strip().split()
        assert filename not in found and '/' not in filename
        found[filename] = {'bytes': int(size), 'sha256': digest}
    expected = {Path(row['file']).name: {'bytes': row['bytes'], 'sha256': row['sha256']} for row in rows if row['file'].startswith('source/') and not row['file'].endswith('.dsc')}
    assert found == expected and len(found) == 2
    original = source.read_bytes()
    assert b'Version: 2.40-2' in original
    changed = Path('/tmp/changed.dsc')
    changed.write_bytes(original.replace(b'Version: 2.40-2', b'Version: 2.40-3', 1))
    bad_exit = verify(changed, target, 'source-mutant', False)
    restored, _ = verify(source, target, 'source-restored')
    assert restored == clear
    report['sourceSignatureFaultControl'] = {'changedExitCode': bad_exit, 'restoredExitCode': 0}
    report.update(complete=True, sourceSignatureVerified=True, sourceSignatureFingerprints=fingerprints, allSourceArchivesBoundBySignedDescriptor=True)
    with (output / 'preparation.json').open('x') as handle:
        json.dump(report, handle, indent=2)
        handle.write('\n')


if __name__ == '__main__':
    main()
