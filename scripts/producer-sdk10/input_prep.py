"""Prepare pinned inert inputs and materialize data without executing project code.

Imports perform no work. Runtime paths and public identities come from the reviewed
profile. The original exported working bytes and canonical Git objects are distinct.
"""
import argparse
import base64
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import ssl
import stat
import struct
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Refusal, encoded, freeze, git_blob, need, safe_relative


def tick(deadline):
    need(time.monotonic() < deadline, 'input preparation deadline')


def file_digest(path, algorithm='sha256', deadline=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    h = hashlib.new(algorithm)
    count = 0
    with os.fdopen(fd, 'rb') as stream:
        need(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'regular physical input required')
        for block in iter(lambda: stream.read(1048576), b''):
            if deadline is not None:
                tick(deadline)
            h.update(block)
            count += len(block)
    return count, h.hexdigest()


def read_json(path, maximum=96 * 1024 ** 2):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        st = os.fstat(stream.fileno())
        need(stat.S_ISREG(st.st_mode) and st.st_size <= maximum, 'bounded regular JSON')
        raw = stream.read(maximum + 1)
    need(len(raw) == st.st_size, 'complete JSON input')
    return json.loads(raw)


def profile_check(profile):
    need(profile.get('schemaVersion') == 1, 'profile schema')
    source = profile['source']
    for value in [source['commit'], source['tree'], source['exportTree']]:
        need(re.fullmatch(r'[0-9a-f]{40}', value), 'original Git identity syntax')
    need(type(source['leaves']) is int and 0 < source['archiveLeaves'] <= source['leaves'], 'source leaf bounds')
    need(source['canonicalByteRestoredPaths'] + len(source['missingAttributes']) <= source['leaves'], 'projection bounds')
    need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', source['tag']) and '..' not in source['tag'].split('/'), 'safe original tag')
    u = urllib.parse.urlsplit(source['archive']['url'])
    parts = u.path.split('/')
    need(u.scheme == 'https' and u.netloc == 'codeload.github.com' and len(parts) == 5 and parts[3] == 'tar.gz' and parts[4] == source['commit'] and not u.query and not u.fragment, 'original source URL')
    need(all(re.fullmatch(r'[A-Za-z0-9_.-]+', p) for p in parts[1:3]), 'public source repository')
    seed = urllib.parse.urlsplit(profile['seed']['url'])
    need(seed.scheme == 'https' and seed.netloc == 'builds.dotnet.microsoft.com' and not seed.query and not seed.fragment, 'original seed URL')
    for item in [source['archive'], profile['seed']]:
        need(type(item['bytes']) is int and item['bytes'] > 0 and re.fullmatch(r'[0-9a-f]{64}', item['sha256']), 'archive byte identity')
    need(re.fullmatch(r'[0-9a-f]{128}', profile['seed']['sha512']), 'official seed SHA512')
    for item in source['recursiveComponents']:
        safe_relative(item['sourcePath'])
        need(re.fullmatch(r'[0-9a-f]{40}', item['expectedRootGitTree']), 'component tree identity')
    for item in source['missingAttributes']:
        safe_relative(item['sourcePath'])
        need(item['sourcePath'].endswith('/.gitattributes'), 'omitted original attribute path')
    return parts[1], parts[2]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Transport:
    def __init__(self, deadline):
        self.deadline = deadline
        self.requests = 0
        self.metadata_bytes = 0
        self.receipts = []
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def fetch(self, url, maximum, destination=None):
        tick(self.deadline)
        u = urllib.parse.urlsplit(url)
        need(u.scheme == 'https' and u.netloc in ('codeload.github.com', 'builds.dotnet.microsoft.com', 'api.github.com') and not u.fragment and not u.username, 'public inert input endpoint')
        self.requests += 1
        need(self.requests <= 32, 'input request count')
        request = urllib.request.Request(url, headers={'User-Agent': 'Checktrail-inert-SDK-inputs/1', 'Accept': 'application/vnd.github+json' if u.netloc == 'api.github.com' else 'application/octet-stream', 'Accept-Encoding': 'identity'})
        out = None
        chunks = []
        h = hashlib.sha256()
        total = 0
        try:
            if destination is not None:
                out = open(destination, 'xb')
            with self.opener.open(request, timeout=min(30, max(.1, self.deadline - time.monotonic()))) as response:
                need(response.status == 200 and response.geturl() == url and response.headers.get('Content-Encoding') in (None, 'identity'), 'exact original no-redirect HTTP200')
                length = response.headers.get('Content-Length')
                need(length is None or length.isdigit() and int(length) <= maximum, 'declared transport bound')
                while True:
                    tick(self.deadline)
                    block = response.read(min(1048576, maximum - total + 1))
                    if not block:
                        break
                    total += len(block)
                    need(total <= maximum, 'input body bound')
                    h.update(block)
                    if out is None:
                        chunks.append(block)
                    else:
                        out.write(block)
                need(length is None or total == int(length), 'complete declared HTTP body')
            if out is None:
                self.metadata_bytes += total
                need(self.metadata_bytes <= 128 * 1024 ** 2, 'metadata corpus bound')
            self.receipts.append({'url': url, 'bytes': total, 'sha256': h.hexdigest(), 'normalTLS': True, 'redirectsFollowed': 0})
            return b''.join(chunks) if out is None else self.receipts[-1]
        finally:
            if out is not None:
                out.close()


class BoundedReader:
    def __init__(self, stream, maximum, deadline):
        self.stream, self.maximum, self.deadline, self.count = stream, maximum, deadline, 0

    def read(self, amount=-1):
        tick(self.deadline)
        remaining = self.maximum - self.count
        need(remaining > 0, 'decoded ceiling reached before EOF proof')
        if amount < 0:
            amount = remaining
        body = self.stream.read(min(amount, remaining))
        self.count += len(body)
        return body


def member_path(raw):
    while raw.startswith('./'):
        raw = raw[2:]
    if raw in ('', '.'):
        return None
    safe_relative(raw.rstrip('/'))
    need('.git' not in PurePosixPath(raw).parts, 'archive cannot supply Git control data')
    return raw.rstrip('/')


def link_target(path, target):
    need(type(target) is str and target and not target.startswith('/') and '\\' not in target and '\0' not in target, 'inert relative link target')
    stack = list(PurePosixPath(path).parent.parts)
    if stack == ['.']:
        stack = []
    for item in target.split('/'):
        if item in ('', '.'):
            continue
        if item == '..':
            need(bool(stack), 'link escapes selected tree')
            stack.pop()
        else:
            stack.append(item)
    need(bool(stack), 'link resolves to selected tree root')
    return target


def notice_name(path):
    base = path.rsplit('/', 1)[-1].lower()
    return bool(re.fullmatch(r'(licenses?|licences?|notices?|copying[0-9]*|copyrights?|third[-_. ]?party[-_. ]?notices?)([._-].*)?', base)) or base == 'patents'


def tree_objects(leaves, callback=None):
    root = {}
    for path, row in leaves.items():
        safe_relative(path)
        node = root
        parts = path.split('/')
        for piece in parts[:-1]:
            value = node.setdefault(piece, {})
            need(type(value) is dict, 'Git path collision')
            node = value
        need(parts[-1] not in node, 'duplicate Git leaf')
        mode = row['mode']
        sha = row['sha']
        need(mode in ('100644', '100755', '120000') and re.fullmatch(r'[0-9a-f]{40}', sha), 'canonical Git leaf')
        node[parts[-1]] = (mode, sha)

    def visit(node):
        records = []
        for name, value in node.items():
            rawname = name.encode('utf-8')
            if type(value) is dict:
                mode, sha, order = '40000', visit(value), rawname + b'/'
            else:
                mode, sha = value
                order = rawname + b'\0'
            records.append((order, mode.encode() + b' ' + rawname + b'\0' + bytes.fromhex(sha)))
        body = b''.join(value for _, value in sorted(records))
        sha = hashlib.sha1(b'tree ' + str(len(body)).encode() + b'\0' + body).hexdigest()
        if callback:
            callback('tree', sha, body)
        return sha
    return visit(root)


def inspect_archive(path, source, profile, deadline, notices=None, changed=None):
    rows, directories, seen = {}, {}, set()
    prefix = None
    restored = {}
    versions = []
    elf = False
    maximum = min(profile['limits']['workBytes'], 12 * 1024 ** 3)
    with open(path, 'rb') as raw, gzip.GzipFile(fileobj=raw) as gz:
        bounded = BoundedReader(gz, maximum, deadline)
        with tarfile.open(fileobj=bounded, mode='r|') as archive:
            for member in archive:
                tick(deadline)
                need(len(seen) < profile['limits']['captureMembers'], 'archive member count')
                name = member_path(member.name)
                if name is None:
                    need(member.isdir(), 'root marker is directory')
                    continue
                if source:
                    first, _, rest = name.partition('/')
                    prefix = prefix or first
                    need(first == prefix, 'one original source prefix')
                    if not rest:
                        need(member.isdir(), 'original source prefix directory')
                        continue
                    name = rest
                safe_relative(name)
                need(name not in seen, 'duplicate archive member')
                seen.add(name)
                need(member.isdir() or member.isreg() or member.issym(), 'regular/directory/symlink archive only')
                need(member.mode & 0o7000 == 0, 'no special archive permission bits')
                info = {'path': name, 'mode': member.mode & 0o777, 'mtime': member.mtime}
                if member.isdir():
                    directories[name] = info
                    continue
                if member.issym():
                    target = link_target(name, member.linkname)
                    body = target.encode('utf-8')
                    info.update({'kind': 'symlink', 'target': target, 'bytes': len(body), 'gitMode': '120000', 'gitBlob': git_blob(body)})
                    rows[name] = info
                    continue
                need(0 <= member.size <= maximum, 'regular archive member bound')
                stream = archive.extractfile(member)
                need(stream is not None, 'physical regular body')
                h = hashlib.sha256()
                gh = hashlib.sha1(b'blob ' + str(member.size).encode() + b'\0')
                amount, head = 0, bytearray()
                selected_notice = notices is not None and notice_name(name)
                selected_version = not source and name == 'sdk/' + profile['seedVersion'] + '/.version'
                selected_change = changed is not None and name in changed
                capture = bytearray() if selected_notice or selected_version or selected_change else None
                if capture is not None:
                    need(member.size <= (256 * 1024 if selected_change else 8 * 1024 ** 2), 'bounded selected metadata body')
                for block in iter(lambda: stream.read(1048576), b''):
                    tick(deadline)
                    amount += len(block)
                    need(amount <= member.size, 'archive body overflow')
                    h.update(block)
                    gh.update(block)
                    if len(head) < 64:
                        head.extend(block[:64 - len(head)])
                    if capture is not None:
                        capture.extend(block)
                need(amount == member.size, 'complete archive member')
                mode = '100755' if member.mode & 0o111 else '100644'
                info.update({'kind': 'regular', 'bytes': amount, 'sha256': h.hexdigest(), 'gitMode': mode, 'gitBlob': gh.hexdigest()})
                rows[name] = info
                if selected_notice:
                    notices(source, name, bytes(capture))
                if selected_version:
                    versions.append(bytes(capture).decode('utf-8').splitlines())
                if selected_change:
                    canonical = bytes(capture).replace(b'\r\n', b'\n')
                    expected = changed[name]
                    need(len(canonical) == expected['bytes'] and git_blob(canonical) == expected['sha'], 'CRLF restoration must match exact original blob and size')
                    restored[name] = canonical
                if not source and name == 'dotnet':
                    elf = mode == '100755' and len(head) >= 20 and head[:6] == b'\x7fELF\x02\x01' and int.from_bytes(head[18:20], 'little') == 62
                archive.members.clear()
        while bounded.read(1048576):
            pass
    for name in list(rows) + list(directories):
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.':
                need(str(parent) not in rows, 'archive file or symlink is a parent')
    if changed is not None:
        need(set(restored) == set(changed), 'every changed original body restored')
    if not source:
        need(elf and len(versions) == 1 and profile['seedVersion'] in versions[0], 'stable seed executable AMD64 ELF and embedded version')
    return {'entries': list(rows.values()), 'directories': list(directories.values()), 'prefix': prefix, 'decodedBytes': bounded.count, 'seedAMD64ELF': elf, 'seedVersionLines': versions}, restored


def metadata(transport, url, out, name):
    body = transport.fetch(url, 32 * 1024 ** 2)
    freeze(out / name, body)
    return json.loads(body)


def raw_commit(document, source):
    need(document['sha'] == source['commit'] and document['tree']['sha'] == source['tree'], 'real original commit/tree metadata')
    verification = document.get('verification') or {}
    need(verification.get('signature') is None and verification.get('reason') == 'unsigned', 'unsigned original commit reconstruction only')
    lines = ['tree ' + source['tree']]
    for parent in document['parents']:
        need(re.fullmatch(r'[0-9a-f]{40}', parent['sha']), 'original parent identity')
        lines.append('parent ' + parent['sha'])
    for key in ('author', 'committer'):
        item = document[key]
        need(not any(c in item['name'] + item['email'] for c in '\r\n\0<>'), 'original identity framing')
        date = datetime.datetime.fromisoformat(item['date'].replace('Z', '+00:00'))
        stamp = int(date.timestamp())
        need(date.microsecond == 0, 'original whole-second Git timestamp')
        lines.append(key + ' ' + item['name'] + ' <' + item['email'] + '> ' + str(stamp) + ' +0000')
    message = document['message']
    need(type(message) is str and '\0' not in message, 'original commit message')
    body = ('\n'.join(lines) + '\n\n' + message.rstrip('\n') + '\n').encode('utf-8')
    need(len(body) == source['rawCommitBytes'] and hashlib.sha256(body).hexdigest() == source['rawCommitSHA256'], 'exact original raw commit bytes')
    need(hashlib.sha1(b'commit ' + str(len(body)).encode() + b'\0' + body).hexdigest() == source['commit'], 'real original commit object identity')
    return body


def prepare(profile, out, deadline, transport=None):
    owner, repo = profile_check(profile)
    out = Path(out)
    need(not out.exists(), 'fresh input output directory')
    out.mkdir(parents=True, mode=0o700)
    profile_source = profile['source']
    deadline = min(deadline, time.monotonic() + profile['limits']['preparationSeconds'])
    need(shutil.disk_usage(out).free >= profile['limits'].get('minimumFreeBeforeInputs', 0), 'free capacity before input preparation')
    transport = transport or Transport(deadline)
    notices = []
    notice_bytes = 0
    (out / 'notices').mkdir(mode=0o700)
    (out / 'metadata').mkdir(mode=0o700)
    (out / 'original-git-blobs').mkdir(mode=0o700)

    def retain_notice(source, path, body):
        nonlocal notice_bytes
        notice_bytes += len(body)
        need(notice_bytes <= 256 * 1024 ** 2, 'original notice corpus bound')
        sha = hashlib.sha256(body).hexdigest()
        target = out / 'notices' / sha
        if target.exists():
            need(target.read_bytes() == body, 'notice content identity')
        else:
            freeze(target, body)
        notices.append({'kind': 'source' if source else 'seed', 'path': path, 'bytes': len(body), 'sha256': sha, 'file': 'notices/' + sha})

    for key, spec in [('source', profile_source['archive']), ('seed', profile['seed'])]:
        destination = out / (key + '.tar.gz')
        transport.fetch(spec['url'], spec['bytes'], destination)
        need(file_digest(destination, deadline=deadline) == (spec['bytes'], spec['sha256']), 'exact selected archive SHA256/size')
        if key == 'seed':
            need(file_digest(destination, 'sha512', deadline)[1] == spec['sha512'], 'official selected stable seed SHA512')
        destination.chmod(0o400)
    source_export, _ = inspect_archive(out / 'source.tar.gz', True, profile, deadline, retain_notice)
    seed, _ = inspect_archive(out / 'seed.tar.gz', False, profile, deadline, retain_notice)
    exported = {r['path']: {'mode': r['gitMode'], 'sha': r['gitBlob'], 'bytes': r['bytes']} for r in source_export['entries']}
    need(len(exported) == profile_source['archiveLeaves'] and tree_objects(exported) == profile_source['exportTree'], 'unchanged complete exported Git projection')
    expected = dict(exported)
    components = []
    api = 'https://api.github.com/repos/' + owner + '/' + repo + '/git/'
    for number, item in enumerate(profile_source['recursiveComponents']):
        prefix = item['sourcePath']
        expected_url = api + 'trees/' + item['expectedRootGitTree'] + '?recursive=1'
        need(item['url'] == expected_url, 'exact original component URL')
        document = metadata(transport, expected_url, out / 'metadata', 'component-' + str(number) + '.json')
        need(document['sha'] == item['expectedRootGitTree'] and document.get('truncated') is False, 'whole original recursive component')
        leaves = {}
        for row in document['tree']:
            if row['type'] == 'tree':
                need(row['mode'] == '040000', 'original directory mode')
                continue
            need(row['type'] == 'blob' and row['mode'] in ('100644', '100755', '120000') and type(row['size']) is int and row['size'] >= 0, 'original blob metadata')
            path = safe_relative(row['path'])
            need(path not in leaves, 'duplicate original component path')
            leaves[path] = {'mode': row['mode'], 'sha': row['sha'], 'bytes': row['size']}
        need(tree_objects(leaves) == item['expectedRootGitTree'], 'every original recursive component tree')
        for path in list(expected):
            if path == prefix or path.startswith(prefix + '/'):
                del expected[path]
        for path, row in leaves.items():
            expected[prefix + '/' + path] = row
        components.append({'path': prefix, 'tree': item['expectedRootGitTree'], 'leaves': len(leaves)})
    need(len(expected) == profile_source['leaves'] and tree_objects(expected) == profile_source['tree'], 'all canonical original leaves and root')
    need(set(exported) <= set(expected), 'no extra exported paths')
    missing = set(expected) - set(exported)
    attr_specs = {x['sourcePath']: x for x in profile_source['missingAttributes']}
    need(missing == set(attr_specs), 'only two declared original attribute omissions')
    changed = {path: row for path, row in expected.items() if path in exported and row != exported[path]}
    need(len(changed) == profile_source['canonicalByteRestoredPaths'] and all(expected[path]['mode'] == exported[path]['mode'] for path in changed), 'only exact same-mode byte projection differences')
    _, restored = inspect_archive(out / 'source.tar.gz', True, profile, deadline, changed=changed)
    projection = []
    object_bytes = {}
    for path, body in restored.items():
        oid = expected[path]['sha']
        need(oid not in object_bytes or object_bytes[oid] == body, 'canonical blob collision')
        object_bytes[oid] = body
        projection.append({'path': path, 'difference': 'CRLF-export-bytes-differ', 'export': exported[path], 'canonical': expected[path], 'canonicalSHA256': hashlib.sha256(body).hexdigest(), 'object': 'original-git-blobs/' + oid})
    for path in sorted(missing):
        item = attr_specs[path]
        need(expected[path]['sha'] == item['gitBlobSHA1'] and expected[path]['bytes'] == item['bytes'], 'original omitted attribute metadata')
        document = metadata(transport, api + 'blobs/' + item['gitBlobSHA1'], out / 'metadata', 'attribute-' + item['gitBlobSHA1'] + '.json')
        need(document['sha'] == item['gitBlobSHA1'] and document['encoding'] == 'base64' and document['size'] == item['bytes'], 'original omitted attribute response')
        body = base64.b64decode(re.sub(r'[\r\n\t ]', '', document['content']), validate=True)
        need(len(body) == item['bytes'] and hashlib.sha256(body).hexdigest() == item['sha256'] and git_blob(body) == item['gitBlobSHA1'], 'exact original omitted attribute bytes')
        object_bytes[item['gitBlobSHA1']] = body
        projection.append({'path': path, 'difference': 'export-omitted-original-attribute', 'export': None, 'canonical': expected[path], 'canonicalSHA256': item['sha256'], 'object': 'original-git-blobs/' + item['gitBlobSHA1']})
    need(len(projection) == len(changed) + len(missing) and sum(map(len, object_bytes.values())) <= 8 * 1024 ** 2, 'complete bounded canonical projection bodies')
    for oid, body in object_bytes.items():
        need(git_blob(body) == oid, 'canonical body Git identity')
        freeze(out / 'original-git-blobs' / oid, body)
    commit_document = metadata(transport, api + 'commits/' + profile_source['commit'], out / 'metadata', 'commit.json')
    commit = raw_commit(commit_document, profile_source)
    freeze(out / 'RAW-COMMIT.bin', commit)
    tag_document = metadata(transport, api + 'ref/tags/' + urllib.parse.quote(profile_source['tag'], safe='/'), out / 'metadata', 'tag.json')
    need(tag_document.get('ref') == 'refs/tags/' + profile_source['tag'] and tag_document['object']['type'] == 'commit' and tag_document['object']['sha'] == profile_source['commit'], 'original direct lightweight tag')
    freeze(out / 'SOURCE-EXPORT-MEMBERS.json', encoded(source_export))
    freeze(out / 'EXPECTED-GIT-LEAVES.json', encoded({'sourceCommit': profile_source['commit'], 'expectedRootGitTree': profile_source['tree'], 'leafCount': len(expected), 'entries': [dict(path=path, **expected[path]) for path in sorted(expected)]}))
    freeze(out / 'PROJECTION.json', encoded({'sourceCommit': profile_source['commit'], 'exportTree': profile_source['exportTree'], 'canonicalGitTree': profile_source['tree'], 'changedExportBytePaths': len(changed), 'missingOriginalAttributes': len(missing), 'canonicalObjectCount': len(object_bytes), 'sourceArchiveRewritten': False, 'entries': sorted(projection, key=lambda x: x['path']), 'components': components}))
    freeze(out / 'SEED-MEMBERS.json', encoded(seed))
    freeze(out / 'ORIGINAL-NOTICES.json', encoded({'entries': notices, 'associationBytes': notice_bytes, 'legalClosureClaimed': False}))
    files = []
    for path in sorted(out.rglob('*')):
        if path.is_file():
            n, sha = file_digest(path, deadline=deadline)
            files.append({'path': str(path.relative_to(out)), 'bytes': n, 'sha256': sha})
    receipt = {'schemaVersion': 1, 'state': 'COMPLETE', 'sourceCommit': profile_source['commit'], 'canonicalGitTree': profile_source['tree'], 'exportGitTree': profile_source['exportTree'], 'trackedLeaves': len(expected), 'projectionPaths': len(projection), 'canonicalObjectCount': len(object_bytes), 'originalArchiveBytesPreserved': True, 'stableSeedVersion': profile['seedVersion'], 'seedSHA512Verified': True, 'seedAMD64ELFMetadataVerified': True, 'seedOrProjectExecuted': False, 'files': files, 'transport': getattr(transport, 'receipts', []), 'fullProducerClosureClaimed': False}
    freeze(out / 'INPUTS.json', encoded(receipt))
    return receipt


def bundle_inputs(profile, inputs, deadline):
    inputs = Path(inputs)
    need(inputs.is_dir() and not inputs.is_symlink(), 'physical prepared input directory')
    receipt = read_json(inputs / 'INPUTS.json')
    source = profile['source']
    need(receipt.get('state') == 'COMPLETE' and receipt['sourceCommit'] == source['commit'] and receipt['canonicalGitTree'] == source['tree'] and receipt['exportGitTree'] == source['exportTree'], 'complete matching prepared bundle')
    expected_files = set()
    for row in receipt['files']:
        relative = safe_relative(row['path'])
        need(relative not in expected_files, 'duplicate bundle file')
        expected_files.add(relative)
        p = inputs / relative
        for parent in p.parents:
            if parent == inputs:
                break
            need(not parent.is_symlink() and parent.is_dir(), 'physical bundle parent')
        need(file_digest(p, deadline=deadline) == (row['bytes'], row['sha256']), 'prepared bundle byte identity')
    actual_files = set()
    for folder, directories, files in os.walk(inputs, followlinks=False):
        for directory in directories:
            need(not (Path(folder) / directory).is_symlink(), 'no bundle directory links')
        for filename in files:
            p = Path(folder) / filename
            need(not p.is_symlink(), 'no bundle leaf links')
            actual_files.add(str(p.relative_to(inputs)))
    need(actual_files == expected_files | {'INPUTS.json'}, 'all bundle files declared')
    for key, item in [('source', source['archive']), ('seed', profile['seed'])]:
        need(file_digest(inputs / (key + '.tar.gz'), deadline=deadline) == (item['bytes'], item['sha256']), 'selected original archive still exact')
    need(file_digest(inputs / 'seed.tar.gz', 'sha512', deadline)[1] == profile['seed']['sha512'], 'stable original seed SHA512 readback')
    expected_doc = read_json(inputs / 'EXPECTED-GIT-LEAVES.json')
    need(expected_doc.get('sourceCommit') == source['commit'] and expected_doc.get('expectedRootGitTree') == source['tree'] and expected_doc.get('leafCount') == source['leaves'], 'canonical expected metadata header')
    expected = {}
    for row in expected_doc['entries']:
        path = safe_relative(row['path'])
        need(path not in expected, 'duplicate expected original leaf')
        expected[path] = {k: row[k] for k in ('mode', 'sha', 'bytes')}
    need(len(expected) == source['leaves'] and tree_objects(expected) == source['tree'], 'full canonical original leaf authority')
    export_doc = read_json(inputs / 'SOURCE-EXPORT-MEMBERS.json')
    exported = {r['path']: {'mode': r['gitMode'], 'sha': r['gitBlob'], 'bytes': r['bytes']} for r in export_doc['entries']}
    need(len(exported) == source['archiveLeaves'] and tree_objects(exported) == source['exportTree'], 'original exported map readback')
    changed = {path: row for path, row in expected.items() if path in exported and row != exported[path]}
    need(set(exported) <= set(expected) and len(changed) == source['canonicalByteRestoredPaths'] and all(row['mode'] == exported[path]['mode'] for path, row in changed.items()), 'exact original projection difference family')
    missing = set(expected) - set(exported)
    need(missing == {x['sourcePath'] for x in source['missingAttributes']}, 'exact omitted original attributes')
    parsed_export, restored = inspect_archive(inputs / 'source.tar.gz', True, profile, deadline, changed=changed)
    seed, _ = inspect_archive(inputs / 'seed.tar.gz', False, profile, deadline)
    need(parsed_export == export_doc and seed == read_json(inputs / 'SEED-MEMBERS.json'), 'complete physical archive inventories read back')
    projection = read_json(inputs / 'PROJECTION.json')
    need(projection.get('sourceCommit') == source['commit'] and projection.get('exportTree') == source['exportTree'] and projection.get('canonicalGitTree') == source['tree'] and projection.get('changedExportBytePaths') == len(changed) and projection.get('missingOriginalAttributes') == len(missing) and projection.get('sourceArchiveRewritten') is False, 'original projection metadata header')
    ledger = {r['path']: r for r in projection['entries']}
    need(len(ledger) == len(changed) + len(missing) and set(ledger) == set(changed) | missing, 'complete disjoint canonical restoration ledger')
    objects = {}
    for path, row in ledger.items():
        need(row['canonical'] == expected[path] and row['object'] == 'original-git-blobs/' + expected[path]['sha'], 'canonical object reference bound')
        body = (inputs / row['object']).read_bytes()
        need(len(body) == expected[path]['bytes'] and git_blob(body) == expected[path]['sha'] and hashlib.sha256(body).hexdigest() == row['canonicalSHA256'], 'every canonical original body read back')
        if path in changed:
            need(row['export'] == exported[path] and body == restored[path], 'hash-proven CRLF restoration readback')
        else:
            item = next(x for x in source['missingAttributes'] if x['sourcePath'] == path)
            need(hashlib.sha256(body).hexdigest() == item['sha256'], 'omitted original attribute readback')
        objects[path] = body
    need(projection.get('canonicalObjectCount') == len({r['canonical']['sha'] for r in ledger.values()}), 'canonical original object dedup count')
    commit = (inputs / 'RAW-COMMIT.bin').read_bytes()
    need(len(commit) == source['rawCommitBytes'] and hashlib.sha256(commit).hexdigest() == source['rawCommitSHA256'] and hashlib.sha1(b'commit ' + str(len(commit)).encode() + b'\0' + commit).hexdigest() == source['commit'], 'real original commit body read back')
    tag = read_json(inputs / 'metadata' / 'tag.json')
    need(tag.get('ref') == 'refs/tags/' + source['tag'] and tag['object']['type'] == 'commit' and tag['object']['sha'] == source['commit'], 'real direct original tag readback')
    return receipt, parsed_export, seed, expected, objects, commit, projection


def mkdir_owned(root, relative):
    current = Path(root)
    for part in PurePosixPath(relative).parts if relative else ():
        safe_relative(part)
        current /= part
        if current.exists() or current.is_symlink():
            need(current.is_dir() and not current.is_symlink(), 'physical owned output parent')
        else:
            current.mkdir(mode=0o755)
    return current


def loose_object(gitdir, kind, oid, body, seen):
    header = kind.encode() + b' ' + str(len(body)).encode() + b'\0'
    need(hashlib.sha1(header + body).hexdigest() == oid, 'real loose Git object identity')
    fingerprint = hashlib.sha256(body).hexdigest()
    if oid in seen:
        need(seen[oid] == (kind, fingerprint, len(body)), 'Git identity dedup also requires body SHA256')
        return
    folder = gitdir / 'objects' / oid[:2]
    folder.mkdir(exist_ok=True, mode=0o755)
    freeze(folder / oid[2:], zlib.compress(header + body))
    seen[oid] = (kind, fingerprint, len(body))


def verify_loose_objects(gitdir, written, expected, commit, tree, deadline):
    required_blobs = {row['sha'] for row in expected.values()}
    need(required_blobs <= set(written) and all(written[oid][0] == 'blob' for oid in required_blobs), 'every canonical original blob was written')
    need(commit in written and written[commit][0] == 'commit' and tree in written and written[tree][0] == 'tree', 'real original commit and complete root object were written')
    for oid, (kind, fingerprint, size) in written.items():
        tick(deadline)
        need(0 <= size <= 256 * 1024 ** 2, 'bounded canonical loose object body')
        path = gitdir / 'objects' / oid[:2] / oid[2:]
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            st = os.fstat(source.fileno())
            need(stat.S_ISREG(st.st_mode) and st.st_size <= size + 1048576, 'bounded physical loose Git object')
            compressed = source.read(st.st_size + 1)
        need(len(compressed) == st.st_size, 'complete physical loose object read')
        header = kind.encode() + b' ' + str(size).encode() + b'\0'
        decoder = zlib.decompressobj()
        raw = decoder.decompress(compressed, len(header) + size + 1)
        need(decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data and len(raw) == len(header) + size and raw.startswith(header), 'exact canonical loose object zlib framing')
        need(hashlib.sha1(raw).hexdigest() == oid and hashlib.sha256(raw[len(header):]).hexdigest() == fingerprint, 'independent original loose object body readback')
    return {'objects': len(written), 'canonicalBlobObjects': len(required_blobs), 'allCanonicalBlobBodiesReadBack': True, 'bodySHA256AndGitObjectIdentityVerified': True}


def extract_tree(archive_path, destination, document, source, expected, canonical, writer, deadline):
    rows = {r['path']: r for r in document['entries']}
    need(len(rows) == len(document['entries']), 'unique physical export manifest')
    if source:
        need(destination.is_dir() and not destination.is_symlink() and {p.name for p in destination.iterdir()} == {'.git'}, 'only owned Git control root exists before source extraction')
    else:
        destination.mkdir(mode=0o755)
    for row in sorted(document['directories'], key=lambda r: (r['path'].count('/'), r['path'])):
        p = mkdir_owned(destination, row['path'])
        os.chmod(p, row['mode'])
    seen, links = set(), []
    with tarfile.open(archive_path, 'r|gz') as archive:
        for member in archive:
            tick(deadline)
            name = member_path(member.name)
            if name is None:
                continue
            if source:
                prefix, _, name = name.partition('/')
                need(prefix == document['prefix'], 'physical original source prefix')
                if not name:
                    continue
            if member.isdir():
                continue
            need(name in rows and name not in seen, 'physical member matches validated inventory')
            seen.add(name)
            row = rows[name]
            if row['kind'] == 'symlink':
                need(member.issym() and member.linkname == row['target'], 'original physical link metadata')
                link_target(name, row['target'])
                links.append(row)
                if source:
                    body = canonical.get(name, row['target'].encode())
                    need(git_blob(body) == expected[name]['sha'], 'canonical original link blob')
                    writer('blob', expected[name]['sha'], body)
                continue
            need(member.isreg() and member.size == row['bytes'] and member.size <= 256 * 1024 ** 2, 'bounded physical regular source/seed member')
            stream = archive.extractfile(member)
            chunks, n = [], 0
            while True:
                block = stream.read(1048576)
                if not block:
                    break
                tick(deadline)
                n += len(block)
                need(n <= member.size, 'physical materialization member bound')
                chunks.append(block)
            body = b''.join(chunks)
            need(len(body) == row['bytes'] and hashlib.sha256(body).hexdigest() == row['sha256'] and git_blob(body) == row['gitBlob'], 'physical export bytes unchanged at materialization')
            parent = str(PurePosixPath(name).parent)
            target = mkdir_owned(destination, '' if parent == '.' else parent) / PurePosixPath(name).name
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(body)
            os.chmod(target, row['mode'])
            os.utime(target, (row['mtime'], row['mtime']))
            if source:
                original = canonical.get(name, body)
                need(git_blob(original) == expected[name]['sha'] and len(original) == expected[name]['bytes'], 'canonical original blob at materialization')
                writer('blob', expected[name]['sha'], original)
            archive.members.clear()
    need(seen == set(rows), 'every physical original member materialized')
    for row in links:
        parent = str(PurePosixPath(row['path']).parent)
        target = mkdir_owned(destination, '' if parent == '.' else parent) / PurePosixPath(row['path']).name
        need(not target.exists() and not target.is_symlink(), 'new original source link')
        os.symlink(row['target'], target)
    return seen


def read_index(path, expected):
    raw = Path(path).read_bytes()
    need(len(raw) >= 32 and raw[:4] == b'DIRC' and hashlib.sha1(raw[:-20]).digest() == raw[-20:], 'real Git index framing/checksum')
    version, count = struct.unpack_from('>II', raw, 4)
    need(version == 2 and count == len(expected), 'exact original version2 index entries')
    offset, seen = 12, set()
    for _ in range(count):
        start = offset
        need(offset + 62 <= len(raw) - 20, 'index entry bounds')
        mode = struct.unpack_from('>I', raw, offset + 24)[0]
        oid = raw[offset + 40:offset + 60].hex()
        flags = struct.unpack_from('>H', raw, offset + 60)[0]
        need(not flags & 0xC000, 'no staged/extended index flags')
        end = raw.find(b'\0', offset + 62, len(raw) - 20)
        need(end >= offset + 62, 'index pathname framing')
        name = raw[offset + 62:end].decode('utf-8')
        need(name in expected and name not in seen and format(mode, 'o') == expected[name]['mode'] and oid == expected[name]['sha'] and flags >> 12 & 3 == 0, 'all real index leaves equal canonical original Git identities')
        seen.add(name)
        offset = start + ((end + 1 - start + 7) // 8) * 8
    need(seen == set(expected), 'complete canonical index readback')
    return {'version': version, 'entries': count, 'sha256': hashlib.sha256(raw).hexdigest(), 'GitSHA1ChecksumVerified': True}


def git_read_tree(source_dir, tree, home, evidence, expected, deadline):
    executable = shutil.which('git', path='/usr/bin:/bin')
    need(executable is not None, 'trusted first-party Git data tool available')
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_ATTR_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_INDEX_VERSION': '2', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC'}
    argv = [executable, '--git-dir=' + str(source_dir / '.git'), '--work-tree=' + str(source_dir), '-c', 'core.hooksPath=' + os.devnull, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=' + os.devnull, '-c', 'core.autocrlf=false', '-c', 'core.ignorecase=false', '-c', 'index.version=2', 'read-tree', tree]
    from common import process
    row, stdout = process(argv, evidence / 'git-read-tree', deadline, cap=65536, environment=env)
    need(row['exitCode'] == 0 and row['reason'] is None and row['stdoutBytes'] == 0, 'original Git read-tree data operation completed')
    index = read_index(source_dir / '.git' / 'index', expected)
    return {'argv': argv, 'readTreeOnlyNoCheckoutOrU': True, 'filtersHooksAndInheritedGitConfigDisabled': True, 'process': row, 'indexReadback': index}


def snapshot_source(source_dir, expected, canonical_tree, source_commit, deadline):
    entries, physical = [], {}
    for path in sorted(expected):
        tick(deadline)
        p = source_dir / path
        st = p.lstat()
        row = {'path': path, 'mode': stat.S_IMODE(st.st_mode)}
        if stat.S_ISLNK(st.st_mode):
            target = os.readlink(p)
            body = target.encode('utf-8')
            row.update({'kind': 'symlink', 'target': target, 'bytes': len(body), 'gitBlob': git_blob(body)})
            physical[path] = {'mode': '120000', 'sha': row['gitBlob']}
        else:
            need(stat.S_ISREG(st.st_mode), 'tracked physical regular or symlink')
            n, sha = file_digest(p, deadline=deadline)
            h = hashlib.sha1(b'blob ' + str(n).encode() + b'\0')
            with open(p, 'rb') as stream:
                for block in iter(lambda: stream.read(1048576), b''):
                    tick(deadline)
                    h.update(block)
            row.update({'kind': 'regular', 'bytes': n, 'sha256': sha, 'gitBlob': h.hexdigest()})
            physical[path] = {'mode': '100755' if st.st_mode & 0o111 else '100644', 'sha': row['gitBlob']}
        need(physical[path]['mode'] == expected[path]['mode'], 'physical tracked Git executable/link mode')
        entries.append(row)
    return {'schemaVersion': 1, 'sourceCommit': source_commit, 'canonicalGitTree': canonical_tree, 'workingTreeGitRoot': tree_objects(physical), 'entries': entries, 'seedAndGitControlFilesExcluded': True, 'trackedFilesAssumedImmutableDuringBuild': False}


def verify_physical_export(baseline, export_doc, expected, canonical):
    intended = {row['path']: dict(row) for row in export_doc['entries']}
    for path in set(expected) - set(intended):
        body = canonical[path]
        intended[path] = {'path': path, 'kind': 'regular', 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'gitBlob': git_blob(body), 'gitMode': expected[path]['mode'], 'mode': 0o755 if expected[path]['mode'] == '100755' else 0o644}
    actual = {row['path']: row for row in baseline['entries']}
    need(len(actual) == len(baseline['entries']) and set(actual) == set(intended), 'all intended physical tracked endpoints read back')
    physical = {}
    for path, row in intended.items():
        observed = actual[path]
        need(observed['kind'] == row['kind'] and observed['bytes'] == row['bytes'] and observed['gitBlob'] == row['gitBlob'], 'physical original export body identity readback')
        if row['kind'] == 'regular':
            need(observed['sha256'] == row['sha256'] and observed['mode'] == row['mode'], 'physical export SHA256 and permission readback')
        else:
            need(observed['target'] == row['target'], 'physical original link target readback')
        physical[path] = {'mode': row['gitMode'], 'sha': row['gitBlob']}
    need(tree_objects(physical) == baseline['workingTreeGitRoot'], 'physical tracked root equals intended export plus omitted attributes')
    return {'trackedEndpoints': len(actual), 'exportBytesPreservedWithOnlyOriginalOmittedAttributesAdded': True, 'allPhysicalBodiesAndModesReadBack': True}


def _materialize(profile, inputs, work, evidence, uid, gid, deadline, ownership):
    profile_check(profile)
    deadline = min(deadline, time.monotonic() + profile['limits']['preparationSeconds'])
    need(type(uid) is int and type(gid) is int and 0 <= uid < 2 ** 31 and 0 <= gid < 2 ** 31, 'explicit native ownership IDs')
    work, evidence, inputs = Path(work), Path(evidence), Path(inputs)
    need(work.is_absolute() and evidence.is_absolute() and inputs.is_absolute(), 'absolute explicit mounted paths')
    need(work.is_dir() and not work.is_symlink() and evidence.is_dir() and not evidence.is_symlink(), 'physical owned work/evidence directories')
    work_children = {path.name for path in work.iterdir()}
    existing_tmp = work_children == {'tmp'}
    need(not work_children or existing_tmp, 'only the persistent tmp directory may preexist in work')
    if existing_tmp:
        tmp = work / 'tmp'
        need(not tmp.is_symlink() and tmp.is_dir() and not any(tmp.iterdir()), 'preexisting tmp must be a physical empty directory')
    need(not any(evidence.iterdir()), 'fresh empty owned evidence mount')
    source_dir = work / 'source'
    need(not source_dir.exists() and not source_dir.is_symlink() and not (evidence / 'MATERIALIZATION.json').exists() and not (evidence / 'source-before.json').exists(), 'fresh materialization targets')
    for item in profile['image'].get('physicalCompilerHeaders', []):
        need(file_digest(item['path'], deadline=deadline) == (item['bytes'], item['sha256']), 'original image physical compiler/header prerequisite')
    receipt, export_doc, seed, expected, canonical, commit, projection = bundle_inputs(profile, inputs, deadline)
    need(not any(path == '.dotnet' or path.startswith('.dotnet/') for path in expected), 'stable seed is untracked and distinct')
    planned = 2 * sum(r['bytes'] for r in export_doc['entries'] if r['kind'] == 'regular') + sum(r['bytes'] for r in seed['entries'] if r['kind'] == 'regular') + 256 * 1024 ** 2
    need(planned <= profile['limits']['workBytes'] and shutil.disk_usage(work).free >= planned, 'capacity before materialization')
    required = ['home', 'dotnet-cli', 'nuget', 'staging', 'tmp', 'input-proofs']
    need(all(name == 'tmp' and existing_tmp or not (work / name).exists() and not (work / name).is_symlink() for name in required), 'all owned directory targets preflighted')
    if existing_tmp:
        need(not (work / 'tmp').is_symlink() and (work / 'tmp').is_dir() and not any((work / 'tmp').iterdir()), 'persistent tmp remains physical and empty before reuse')
    ownership['workPrepared'] = True
    for name in required:
        if name == 'tmp' and existing_tmp:
            continue
        (work / name).mkdir(mode=0o700)
    gitdir = source_dir / '.git'
    seen_objects = {}
    source_dir.mkdir(mode=0o755)
    gitdir.mkdir(mode=0o755)
    (gitdir / 'objects').mkdir(mode=0o755)
    (gitdir / 'refs' / 'tags').mkdir(parents=True, mode=0o755)
    def actual_writer(kind, oid, body):
        tick(deadline)
        loose_object(gitdir, kind, oid, body, seen_objects)

    extract_tree(inputs / 'source.tar.gz', source_dir, export_doc, True, expected, canonical, actual_writer, deadline)
    missing = [item for item in profile['source']['missingAttributes']]
    for item in missing:
        path = item['sourcePath']
        body = canonical[path]
        parent = str(PurePosixPath(path).parent)
        target = mkdir_owned(source_dir, '' if parent == '.' else parent) / PurePosixPath(path).name
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body)
        os.chmod(target, 0o755 if expected[path]['mode'] == '100755' else 0o644)
        actual_writer('blob', expected[path]['sha'], body)
    root = tree_objects(expected, actual_writer)
    need(root == profile['source']['tree'], 'real complete canonical tree object database')
    loose_object(gitdir, 'commit', profile['source']['commit'], commit, seen_objects)
    object_readback = verify_loose_objects(gitdir, seen_objects, expected, profile['source']['commit'], root, deadline)
    freeze(gitdir / 'HEAD', (profile['source']['commit'] + '\n').encode())
    freeze(gitdir / 'shallow', (profile['source']['commit'] + '\n').encode())
    tagpath = gitdir / 'refs' / 'tags' / profile['source']['tag']
    tagpath.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    freeze(tagpath, (profile['source']['commit'] + '\n').encode())
    owner, repo = profile_check(profile)
    origin = 'https://github.com/' + owner + '/' + repo
    configuration = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n\thooksPath = /dev/null\n\tfsmonitor = false\n\tautocrlf = false\n[index]\n\tversion = 2\n[remote "origin"]\n\turl = ' + origin + '\n'
    freeze(gitdir / 'config', configuration.encode('utf-8'))
    git_context = git_read_tree(source_dir, root, work / 'home', evidence, expected, deadline)
    extract_tree(inputs / 'seed.tar.gz', source_dir / '.dotnet', seed, False, {}, {}, None, deadline)
    for name in ['SOURCE-EXPORT-MEMBERS.json', 'EXPECTED-GIT-LEAVES.json', 'PROJECTION.json', 'RAW-COMMIT.bin', 'INPUTS.json', 'ORIGINAL-NOTICES.json']:
        freeze(work / 'input-proofs' / name, (inputs / name).read_bytes())
    (work / 'input-proofs' / 'original-git-blobs').mkdir(mode=0o700)
    for path in (inputs / 'original-git-blobs').iterdir():
        freeze(work / 'input-proofs' / 'original-git-blobs' / path.name, path.read_bytes())
    (work / 'input-proofs' / 'notices').mkdir(mode=0o700)
    for path in (inputs / 'notices').iterdir():
        freeze(work / 'input-proofs' / 'notices' / path.name, path.read_bytes())
    (work / 'input-proofs' / 'metadata').mkdir(mode=0o700)
    for path in (inputs / 'metadata').iterdir():
        freeze(work / 'input-proofs' / 'metadata' / path.name, path.read_bytes())
    for folder in [source_dir, work / 'home', work / 'dotnet-cli', work / 'nuget', work / 'staging', work / 'tmp']:
        for current, directories, files in os.walk(folder, followlinks=False):
            tick(deadline)
            os.chown(current, uid, gid)
            for name in directories + files:
                os.chown(Path(current) / name, uid, gid, follow_symlinks=False)
    baseline = snapshot_source(source_dir, expected, profile['source']['tree'], profile['source']['commit'], deadline)
    physical_readback = verify_physical_export(baseline, export_doc, expected, canonical)
    freeze(evidence / 'source-before.json', encoded(baseline))
    result = {'schemaVersion': 1, 'state': 'COMPLETE', 'sourceCommit': profile['source']['commit'], 'canonicalGitTree': root, 'workingTreeGitRoot': baseline['workingTreeGitRoot'], 'trackedPhysicalLeaves': len(baseline['entries']), 'workingExportBytesPreserved': True, 'canonicalProjectionPaths': len(projection['entries']), 'canonicalBodiesRetainedSeparately': True, 'originalNoticeBodiesAndAliasesRetained': True, 'inputProofsAreFullPreparedBundle': False, 'seedVersion': profile['seedVersion'], 'seedUntracked': True, 'realOriginalShallowGitContext': git_context, 'canonicalLooseObjectReadback': object_readback, 'physicalExportReadback': physical_readback, 'operatorConfiguredPublicOrigin': origin, 'historicalLocalGitConfigurationClaimed': False, 'originalRawCommitSHA256': hashlib.sha256(commit).hexdigest(), 'sourceOrSeedExecuted': False, 'baselineSHA256': hashlib.sha256(encoded(baseline)).hexdigest(), 'inputsReceiptSHA256': hashlib.sha256(encoded(receipt)).hexdigest(), 'freshOwnedDirectories': required, 'preexistingEmptyTempDirectoryReused': existing_tmp, 'tempVolumeIdentityVerifiedHere': False}
    return result


def materialize(profile, inputs, work, evidence, uid, gid, deadline):
    evidence, work = Path(evidence), Path(work)
    need(type(uid) is int and type(gid) is int and 0 <= uid < 2 ** 31 and 0 <= gid < 2 ** 31, 'explicit output ownership')
    need(evidence.is_absolute() and evidence.is_dir() and not evidence.is_symlink() and not any(evidence.iterdir()), 'fresh physical materialization evidence directory')
    os.chown(evidence, os.geteuid(), os.getegid())
    ownership = {'workPrepared': False}
    output = None
    incomplete = {'schemaVersion': 1, 'state': 'INCOMPLETE', 'sourceOrSeedExecuted': False}

    def restore_ownership():
        for path in evidence.iterdir():
            need(path.is_file() and not path.is_symlink(), 'only owned regular materialization evidence files')
            os.chown(path, uid, gid)
        os.chown(evidence, uid, gid)
        if ownership['workPrepared']:
            os.chown(work, uid, gid)

    try:
        result = _materialize(profile, inputs, work, evidence, uid, gid, deadline, ownership)
        fd = os.open(evidence / 'MATERIALIZATION.json', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        output = os.fdopen(fd, 'w+b')
        output.write(encoded(incomplete))
        output.flush()
        os.fchmod(output.fileno(), 0o400)
        restore_ownership()
        # The already-open descriptor remains writable after chown. No extra
        # FOWNER/DAC_OVERRIDE or reopening a UID-owned output is required.
        output.seek(0)
        output.truncate()
        output.write(encoded(result))
        output.flush()
        os.fsync(output.fileno())
        return result
    except Exception as error:
        incomplete['errorType'] = type(error).__name__
        incomplete['controlledReason'] = str(error) if isinstance(error, Refusal) else None
        if output is not None:
            output.seek(0)
            output.truncate()
            output.write(encoded(incomplete))
            output.flush()
            os.fsync(output.fileno())
        elif not (evidence / 'MATERIALIZATION.json').exists():
            freeze(evidence / 'MATERIALIZATION.json', encoded(incomplete))
        restore_ownership()
        raise
    finally:
        if output is not None:
            output.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare_parser = sub.add_parser('prepare')
    prepare_parser.add_argument('--profile', required=True)
    prepare_parser.add_argument('--out', required=True)
    prepare_parser.add_argument('--deadline', type=float, required=True)
    materialize_parser = sub.add_parser('materialize')
    materialize_parser.add_argument('--profile', required=True)
    materialize_parser.add_argument('--inputs', required=True)
    materialize_parser.add_argument('--work', required=True)
    materialize_parser.add_argument('--evidence', required=True)
    materialize_parser.add_argument('--uid', type=int, required=True)
    materialize_parser.add_argument('--gid', type=int, required=True)
    materialize_parser.add_argument('--deadline', type=float, required=True)
    args = parser.parse_args(argv)
    new_output = not Path(args.out).exists() if args.command == 'prepare' else Path(args.evidence).is_dir() and not Path(args.evidence).is_symlink() and not any(Path(args.evidence).iterdir())
    try:
        profile = read_json(args.profile, 1024 * 1024)
        if args.command == 'prepare':
            result = prepare(profile, args.out, args.deadline)
        else:
            result = materialize(profile, args.inputs, args.work, args.evidence, args.uid, args.gid, args.deadline)
        print(json.dumps({'state': result['state'], 'sourceOrSeedExecuted': False}))
        return 0
    except Exception as error:
        result = {'schemaVersion': 1, 'state': 'INCOMPLETE', 'errorType': type(error).__name__, 'HTTPStatus': getattr(error, 'code', None), 'controlledReason': str(error) if isinstance(error, Refusal) else None, 'sourceOrSeedExecuted': False}
        target = Path(args.out) / 'INPUTS.json' if args.command == 'prepare' else Path(args.evidence) / 'MATERIALIZATION.json'
        if new_output and target.parent.is_dir() and not target.parent.is_symlink() and not target.exists() and not target.is_symlink():
            try:
                freeze(target, encoded(result))
            except OSError:
                pass
        print(json.dumps(result))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
