"""Finite original-notice custody; no SDK/compiler/project executable is run.

This is a distinct body-custody proposal, not the earlier metadata-only channel.
Raw notice bodies and dynamic host observations stay private/encrypted. The
three fixed stock selectors and expected stat policy are visible in this code.
"""
from contextlib import ExitStack, contextmanager
from pathlib import Path
import argparse
import hashlib
import json
import os
import platform
import plistlib
import re
import signal
import stat
import struct
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'reused-crypto'))
from common import need, encoded, freeze, deadline_receipt, hash_file
from crypto_bridge import operation

APP = Path('/Applications/Xcode_26.2.app')
OWN_BASE = Path('/opt')
NONCE = 'rust198-xcode262-notices-1118-v1'
MAGIC = b'CT-XCODE-NOTICES-1\n'
MAX_PLAIN = 2 * 1024**2
MAX_MANIFEST = 16384
MAX_VERSION_METADATA = 65536
MAX_CIPHER = MAX_PLAIN + 65536
MAX_ZIP = MAX_PLAIN + 98304
FILES = (
    ('Contents/Resources/en.lproj/License.rtf', 174787),
    ('Contents/Resources/en.lproj/License.pdf', 186137),
    ('Contents/Resources/Acknowledgments.pdf', 1278722),
)
FILE_IDENTITY = (501, 20, 0o644)
# Actual metadata-run 44272765882 identities. They are not vendor/historical pins.
# Stock ownership is preserved, including the runner-owned application and files.
ANCESTORS = {
    '/': (0, 0, 0o755),
    '/Applications': (0, 80, 0o775),
    '/Applications/Xcode_26.2.app': (501, 20, 0o755),
    '/Applications/Xcode_26.2.app/Contents': (501, 20, 0o755),
    '/Applications/Xcode_26.2.app/Contents/Resources': (501, 20, 0o755),
    '/Applications/Xcode_26.2.app/Contents/Resources/en.lproj': (501, 20, 0o755),
}
MEMBERS = {'notices.ctenc': MAX_CIPHER, 'ENVELOPE.json': 16384, 'READY.json': 4096}


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate-notice-json-field')
        result[key] = value
    return result


def endpoint(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class Budget:
    def __init__(self, seconds, clock=time.monotonic):
        need(0 < seconds <= 120, 'finite-notice-deadline')
        self.clock = clock
        self.started = clock()
        self.deadline = self.started + seconds

    def tick(self):
        need(self.clock() < self.deadline, 'notice-deadline-exhausted')


@contextmanager
def hard_phase(seconds):
    need(0 < seconds <= 60 and signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0),
         'fresh-hard-notice-phase')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(_number, _frame):
        raise TimeoutError('original-notice-hard-phase-expired')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def physical_read(path, limit, budget, exact_bytes=None):
    """Read one fixed regular file through held nofollow ancestor descriptors.

    Equality is checked at finite endpoints; it does not claim continuous
    immutability or protection against the trusted host/operator/file owner.
    """
    budget.tick()
    need(path.is_absolute() and '..' not in path.parts and '.' not in path.parts,
         'absolute-fixed-notice-path')
    with ExitStack() as stack:
        root = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, root)
        root_before = os.fstat(root)
        need(stat.S_ISDIR(root_before.st_mode) and
             (root_before.st_uid, root_before.st_gid, stat.S_IMODE(root_before.st_mode)) == ANCESTORS['/'],
             'selected-root-identity-mode')
        directories = [(None, None, root, root_before)]
        parent = root
        absolute = Path('/')
        for part in path.parts[1:-1]:
            budget.tick()
            absolute = absolute / part
            need(str(absolute) in ANCESTORS, 'unselected-notice-ancestor')
            before = os.stat(part, dir_fd=parent, follow_symlinks=False)
            need(stat.S_ISDIR(before.st_mode) and
                 (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) == ANCESTORS[str(absolute)],
                 'selected-notice-ancestor-identity-mode')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            stack.callback(os.close, child)
            need(endpoint(before) == endpoint(os.fstat(child)), 'notice-ancestor-open-changed')
            directories.append((parent, part, child, before))
            parent = child
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
             (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) == FILE_IDENTITY and
             0 < before.st_size <= limit and (exact_bytes is None or before.st_size == exact_bytes),
             'selected-regular-notice-identity-mode-size')
        leaf = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        stack.callback(os.close, leaf)
        need(endpoint(before) == endpoint(os.fstat(leaf)), 'notice-file-open-changed')
        body = bytearray()
        while True:
            budget.tick()
            piece = os.read(leaf, min(65536, limit + 1 - len(body)))
            if not piece:
                break
            body.extend(piece)
            need(len(body) <= before.st_size, 'notice-body-overread')
        need(len(body) == before.st_size and endpoint(before) == endpoint(os.fstat(leaf)) and
             endpoint(before) == endpoint(os.stat(path.name, dir_fd=parent, follow_symlinks=False)),
             'notice-file-read-changed')
        for previous, part, descriptor, initial in reversed(directories):
            budget.tick()
            need(endpoint(initial) == endpoint(os.fstat(descriptor)), 'notice-ancestor-read-changed')
            if previous is not None:
                need(endpoint(initial) == endpoint(os.stat(part, dir_fd=previous, follow_symlinks=False)),
                     'notice-ancestor-name-changed')
        return bytes(body), {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


def validate_context(context):
    need(type(context) is dict and set(context) == {'run', 'head', 'attempt', 'nonce'} and
         type(context['run']) is int and context['run'] > 0 and type(context['attempt']) is int and context['attempt'] == 1 and
         type(context['head']) is str and re.fullmatch('[0-9a-f]{40}', context['head']) and
         context['nonce'] == NONCE and re.fullmatch('[a-z0-9-]{8,40}', context['nonce']), 'exact-original-notice-context')


def host_context():
    need(os.getuid() == 0 and platform.system() == 'Darwin' and platform.machine() == 'arm64' and
         os.environ.get('GITHUB_ACTIONS') == 'true' and
         os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
         os.environ.get('GITHUB_REPOSITORY') == 'stsepelin/checktrail' and
         os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
         os.environ.get('RUNNER_ARCH') == 'ARM64', 'original-notice-host-operator-context')
    context = {'run': int(os.environ['GITHUB_RUN_ID']), 'attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
               'head': os.environ['GITHUB_SHA'], 'nonce': NONCE}
    validate_context(context)
    return context


def namespace(context):
    validate_context(context)
    return OWN_BASE / ('checktrail-rust198-original-notices-' + str(context['run']) + '-' +
                       str(context['attempt']) + '-' + context['head'][:12])


def namespace_identity(value):
    # Authorized child creation changes directory times/link count. The held
    # own namespace's object/owner/mode identity must still remain identical.
    return value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode


def original_members(budget):
    info, info_proof = physical_read(APP / 'Contents/Info.plist', MAX_VERSION_METADATA, budget)
    version, version_proof = physical_read(APP / 'Contents/version.plist', MAX_VERSION_METADATA, budget)
    need(plistlib.loads(info).get('CFBundleShortVersionString') == '26.2' and
         plistlib.loads(version).get('ProductBuildVersion') == '17C52', 'selected-xcode-version-build')
    bodies = []
    records = []
    offset = 0
    for name, size in FILES:
        budget.tick()
        body, proof = physical_read(APP / name, size, budget, exact_bytes=size)
        bodies.append(body)
        records.append({'name': name, 'offset': offset, **proof})
        offset += len(body)
    need(len(bodies) == 3 and offset == sum(size for _, size in FILES), 'all-three-original-notices-required')
    budget.tick()
    return bodies, records, {'Info.plist': info_proof, 'version.plist': version_proof}


def make_container(bodies, records, version_proof, context):
    validate_context(context)
    manifest = {'schemaVersion': 1, 'kind': 'selected-xcode262-original-notices-only',
                'context': context, 'selectedApp': str(APP), 'xcodeVersion': '26.2', 'xcodeBuild': '17C52',
                'versionMetadata': version_proof, 'members': records}
    raw = encoded(manifest)
    need(len(raw) <= MAX_MANIFEST, 'notice-manifest-bound')
    body = MAGIC + struct.pack('>I', len(raw)) + raw + b''.join(bodies)
    need(len(body) <= MAX_PLAIN, 'notice-container-bound')
    parse_container(body, context)
    return body, {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(),
                  'internalMemberMapSHA256': hashlib.sha256(encoded(records)).hexdigest()}


def parse_container(body, context):
    validate_context(context)
    prefix = len(MAGIC) + 4
    need(type(body) is bytes and prefix < len(body) <= MAX_PLAIN and body.startswith(MAGIC), 'notice-container-header')
    length = struct.unpack('>I', body[len(MAGIC):prefix])[0]
    need(0 < length <= MAX_MANIFEST and prefix + length < len(body), 'notice-container-manifest-length')
    manifest = json.loads(body[prefix:prefix + length], object_pairs_hook=unique)
    need(type(manifest) is dict and set(manifest) == {'schemaVersion', 'kind', 'context', 'selectedApp',
         'xcodeVersion', 'xcodeBuild', 'versionMetadata', 'members'} and type(manifest['schemaVersion']) is int and manifest['schemaVersion'] == 1 and
         manifest['kind'] == 'selected-xcode262-original-notices-only' and manifest['context'] == context and
         manifest['selectedApp'] == str(APP) and manifest['xcodeVersion'] == '26.2' and manifest['xcodeBuild'] == '17C52',
         'exact-original-notice-schema-selection')
    validate_context(manifest['context'])
    versions = manifest['versionMetadata']
    need(type(versions) is dict and set(versions) == {'Info.plist', 'version.plist'}, 'original-version-proofs')
    for proof in versions.values():
        need(type(proof) is dict and set(proof) == {'bytes', 'sha256'} and type(proof['bytes']) is int and
             0 < proof['bytes'] <= MAX_VERSION_METADATA and type(proof['sha256']) is str and re.fullmatch('[0-9a-f]{64}', proof['sha256']),
             'bounded-original-version-proof')
    rows = manifest['members']
    need(type(rows) is list and len(rows) == 3, 'exact-three-original-notice-members')
    payload = body[prefix + length:]
    offset = 0
    for row, (name, size) in zip(rows, FILES):
        need(type(row) is dict and set(row) == {'name', 'offset', 'bytes', 'sha256'} and row['name'] == name and
             type(row['offset']) is int and row['offset'] == offset and type(row['bytes']) is int and row['bytes'] == size and
             type(row['sha256']) is str and re.fullmatch('[0-9a-f]{64}', row['sha256']), 'exact-ordered-contiguous-notice-member')
        member = payload[offset:offset + size]
        need(len(member) == size and hashlib.sha256(member).hexdigest() == row['sha256'], 'whole-original-notice-member')
        offset += size
    need(offset == len(payload), 'no-extra-or-partial-notice-bytes')
    return manifest


def private_read(path, limit, public=False):
    before = path.lstat()
    need(path == path.resolve(strict=True) and stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
         before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) in ([0o400, 0o444] if public else [0o400]) and 0 < before.st_size <= limit,
         'private-notice-input-identity')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        need(endpoint(before) == endpoint(os.fstat(stream.fileno())), 'private-notice-input-open-changed')
        body = stream.read(limit + 1)
        need(endpoint(before) == endpoint(os.fstat(stream.fileno())), 'private-notice-input-held-fd-changed')
    need(len(body) == before.st_size and endpoint(before) == endpoint(path.lstat()), 'private-notice-input-read-changed')
    return body


def seal_container(source, output, recipient_file, recipient_sha, context, deadline):
    started = time.monotonic()
    validate_context(context)
    need(time.monotonic() < deadline and not os.path.lexists(output) and output.parent == output.parent.resolve(strict=True),
         'fresh-timely-private-notice-cipher')
    raw = private_read(source, MAX_PLAIN)
    manifest = parse_container(raw, context)
    public_raw = private_read(recipient_file, 4096, public=True)
    need(len(public_raw) <= 4096 and hashlib.sha256(public_raw).hexdigest() == recipient_sha, 'exact-distinct-notice-recipient')
    public = json.loads(public_raw, object_pairs_hook=unique)
    need(set(public) == {'kty', 'n', 'e'} and public['kty'] == 'RSA', 'public-only-notice-recipient')
    plain = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
             'internalMemberMapSHA256': hashlib.sha256(encoded(manifest['members'])).hexdigest()}
    output.mkdir(mode=0o700)
    output.chmod(0o700)
    envelope = operation(output / 'private-crypto', 'encrypt', {'source': str(source), 'out': str(output / 'notices.ctenc'),
        'seconds': min(30, deadline - time.monotonic()), 'plaintext': plain, 'context': context, 'publicJWK': public}, deadline)
    need(envelope['plaintext'] == plain and envelope['context'] == context and envelope['publicRecipientJWK'] == public and
         envelope['bytes'] <= MAX_CIPHER and hash_file(output / 'notices.ctenc', deadline=deadline) ==
         (envelope['bytes'], envelope['sha256']) and private_read(source, MAX_PLAIN) == raw, 'exact-original-notice-cipher-source')
    public_envelope = {**envelope, 'originalNoticesOnly': True, 'noticeSchemaVersion': 1}
    need(len(encoded(public_envelope)) <= MEMBERS['ENVELOPE.json'], 'notice-envelope-bound')
    freeze(output / 'ENVELOPE.json', encoded(public_envelope))
    ready = {'schemaVersion': 1, 'context': context, 'allThreeOriginalNoticesEncrypted': True,
             'bytes': envelope['bytes'], 'sha256': envelope['sha256'],
             'envelopeSHA256': hashlib.sha256(encoded(public_envelope)).hexdigest(),
             'originalMemberCount': 3, 'originalSelectedBytes': sum(size for _, size in FILES),
             'rawOriginalBodiesOrDynamicInventoryEmittedPublicly': False, 'licenseSDKBuildNativeOrGateACredit': False}
    need(time.monotonic() < deadline, 'notice-sealing-deadline')
    ready = deadline_receipt(output / 'READY.json', ready, deadline,
        {'allThreeOriginalNoticesEncrypted': False}, started)
    need(ready['allThreeOriginalNoticesEncrypted'] and ready['completionCreditFinalized'] and
         not ready['completionBudgetExhausted'], 'late-notice-custody-is-incomplete')
    return ready


def preflight_recipient(output, recipient_file, recipient_sha, context):
    validate_context(context)
    raw = private_read(recipient_file, 4096, public=True)
    need(type(recipient_sha) is str and re.fullmatch('[0-9a-f]{64}', recipient_sha) and
         hashlib.sha256(raw).hexdigest() == recipient_sha, 'exact-distinct-notice-public-key')
    public = json.loads(raw, object_pairs_hook=unique)
    need(set(public) == {'kty', 'n', 'e'} and public['kty'] == 'RSA', 'only-notice-public-key')
    deadline = time.monotonic() + 20
    result = operation(output, 'validate-recipient', {'publicJWK': public}, deadline)
    need(result == {'validPublicRecipient': True} and time.monotonic() < deadline,
         'notice-public-crypto-preflight-incomplete')


def grant_cipher_upload(root, output, ready):
    need(root == root.resolve(strict=True) and root.stat().st_uid == os.getuid() and
         stat.S_IMODE(root.stat().st_mode) == 0o700 and output.parent == root and
         output == output.resolve(strict=True), 'own-original-notice-upload-placement')
    need(ready['allThreeOriginalNoticesEncrypted'] is True and ready['completionCreditFinalized'] is True and
         ready['completionBudgetExhausted'] is False, 'no-incomplete-notice-upload')
    need({p.name for p in output.iterdir() if p.is_file()} == set(MEMBERS), 'only-three-cipher-upload-files')
    for name, cap in MEMBERS.items():
        body = private_read(output / name, cap)
        if name == 'notices.ctenc':
            need(len(body) == ready['bytes'] and hashlib.sha256(body).hexdigest() == ready['sha256'],
                 'whole-notice-upload-cipher')
    need(json.loads(private_read(output / 'READY.json', 4096), object_pairs_hook=unique) == ready and
         hashlib.sha256(private_read(output / 'ENVELOPE.json', 16384)).hexdigest() == ready['envelopeSHA256'],
         'same-final-notice-upload-metadata')
    for name in MEMBERS:
        (output / name).chmod(0o444)
    output.chmod(0o555)
    root.chmod(0o711)
    return output


def recover_container(cipher, output, private_key, public_recipient, context, deadline):
    validate_context(context)
    need(not os.path.lexists(output) and output.parent == output.parent.resolve(strict=True), 'fresh-private-notice-recovery')
    private_read(private_key, 8192)
    ready = json.loads(private_read(cipher / 'READY.json', 4096), object_pairs_hook=unique)
    envelope_raw = private_read(cipher / 'ENVELOPE.json', 16384)
    envelope = json.loads(envelope_raw, object_pairs_hook=unique)
    validate_context(ready['context'])
    validate_context(envelope['context'])
    need(ready['context'] == envelope['context'] == context and ready['allThreeOriginalNoticesEncrypted'] is True and
         ready['completionCreditFinalized'] is True and ready['completionBudgetExhausted'] is False and
         ready['originalMemberCount'] == 3 and ready['originalSelectedBytes'] == sum(size for _, size in FILES) and
         envelope['publicRecipientJWK'] == public_recipient and envelope['originalNoticesOnly'] is True and
         envelope['noticeSchemaVersion'] == 1 and ready['envelopeSHA256'] == hashlib.sha256(envelope_raw).hexdigest() and
         ready['bytes'] == envelope['bytes'] <= MAX_CIPHER and ready['sha256'] == envelope['sha256'],
         'exact-whole-notice-cipher-context-recipient')
    source = cipher / 'notices.ctenc'
    need(hash_file(source, deadline=deadline) == (envelope['bytes'], envelope['sha256']), 'physical-notice-cipher-before-decrypt')
    output.mkdir(mode=0o700)
    output.chmod(0o700)
    plain = output / 'AUTHENTICATED-NOTICES.bin'
    proof = operation(output / 'private-decrypt', 'decrypt', {'privateKey': str(private_key),
        'parts': [{'path': str(source), 'bytes': envelope['bytes'], 'sha256': envelope['sha256']}],
        'envelope': envelope, 'context': context, 'out': str(plain),
        'seconds': min(60, deadline - time.monotonic())}, deadline)
    need(proof['authenticated'] is True and proof['plaintextParsingBeforeGCMAuthentication'] is False,
         'full-notice-GCM-before-container-parse')
    raw = private_read(plain, MAX_PLAIN)
    manifest = parse_container(raw, context)
    need(envelope['plaintext'] == {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
         'internalMemberMapSHA256': hashlib.sha256(encoded(manifest['members'])).hexdigest()}, 'authenticated-notice-member-map')
    receipt = {'authenticatedThreeOriginalNoticesRecovered': True, 'context': context,
               'containerBytes': len(raw), 'containerSHA256': hashlib.sha256(raw).hexdigest(),
               'originalMemberCount': 3, 'originalSelectedBytes': sum(size for _, size in FILES),
               'rawOriginalBodiesDynamicInventoryOrKeyPubliclyEmitted': False, 'licenseSDKBuildNativeOrGateACredit': False}
    need(time.monotonic() < deadline, 'notice-recovery-deadline')
    freeze(output / 'RECOVERY.json', encoded(receipt))
    need(time.monotonic() < deadline, 'notice-recovery-receipt-deadline')
    return receipt


def collect_and_seal(output, recipient_file, recipient_sha, context):
    validate_context(context)
    need(not os.path.lexists(output) and output.parent == output.parent.resolve(strict=True) and
         output.parent.stat().st_uid == os.getuid() and not output.parent.stat().st_mode & 0o077,
         'fresh-owned-private-original-notice-output')
    output.mkdir(mode=0o700)
    output.chmod(0o700)
    try:
        with hard_phase(20):
            preflight_recipient(output / 'private-preflight', recipient_file, recipient_sha, context)
        budget = Budget(60)
        with hard_phase(60):
            bodies, records, versions = original_members(budget)
            payload, _ = make_container(bodies, records, versions, context)
            budget.tick()
            source = output / 'ORIGINAL-NOTICES.bin'
            freeze(source, payload)
            budget.tick()
        # Reading has its own 60s scope; sealing has a distinct honest 60s scope.
        with hard_phase(60):
            ready = seal_container(source, output / 'cipher', recipient_file, recipient_sha, context,
                                   time.monotonic() + 60)
        grant_cipher_upload(output, output / 'cipher', ready)
        return ready
    except BaseException as error:
        freeze(output / 'REFUSAL.json', encoded({'complete': False, 'reasonIdentifier': 'original-notice-custody-refused',
            'errorType': type(error).__name__, 'noPositivePartialCustody': True, 'noRetryOrScopeGrowth': True,
            'licenseSDKBuildNativeOrGateACredit': False}))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output')
    parser.add_argument('--public-recipient', required=True)
    parser.add_argument('--recipient-sha256', required=True)
    args = parser.parse_args()
    # Original body-custody source is not permission to execute; only a later
    # reviewed root workflow may call this exact fixed selection.
    try:
        context = host_context()
        root = namespace(context)
        output = Path(args.output)
        need(output == root / 'custody' and root == root.resolve(strict=True), 'fixed-own-original-notice-namespace')
        before = root.lstat()
        need(stat.S_ISDIR(before.st_mode) and before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o700,
             'private-own-original-notice-namespace')
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            need(namespace_identity(before) == namespace_identity(os.fstat(descriptor)), 'own-notice-namespace-open-changed')
            result = collect_and_seal(output, Path(args.public_recipient), args.recipient_sha256, context)
            need(namespace_identity(before) == namespace_identity(root.lstat()) == namespace_identity(os.fstat(descriptor)),
                 'own-notice-namespace-read-changed')
            # Only this fresh own namespace becomes traversable for the three
            # explicit ciphertext/public files. Original container stays0400.
            os.fchmod(descriptor, 0o711)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        print(json.dumps({k: result[k] for k in ['allThreeOriginalNoticesEncrypted', 'bytes', 'sha256',
            'originalMemberCount', 'originalSelectedBytes', 'completionCreditFinalized', 'completionBudgetExhausted',
            'licenseSDKBuildNativeOrGateACredit']}, sort_keys=True))
        return 0
    except BaseException as error:
        print(json.dumps({'originalNoticeCustodyComplete': False, 'errorType': type(error).__name__,
                          'rawOriginalBodyOrDynamicPathEmitted': False, 'licenseSDKBuildNativeOrGateACredit': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
