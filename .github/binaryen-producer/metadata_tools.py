"""Reviewed first-party bounded metadata/archive primitives; no source execution."""
import argparse

import base64

from contextlib import contextmanager

import hashlib

import json

import math

import os

from pathlib import Path

import re

import shutil

import signal

import ssl

import stat

import time

import urllib.error

import urllib.parse

import urllib.request

import zlib

SHA1 = re.compile(r'[0-9a-f]{40}\Z')

NOTICE = re.compile(r'(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|AUTHORS|PATENTS)(?:[._-].*)?\Z', re.I)

KINDS = {'commit': ('GitCommitMetadataRequests','GitCommitMetadataPerResponseBytes'),
         'tree': ('GitRecursiveTreeMetadataRequests','GitRecursiveTreePerResponseBytes'),
         'archive': ('codeloadRequests','compressedArchivePerResponseBytes'),
         'blob': ('canonicalBlobRestorationRequests','canonicalBlobJSONPerResponseBytes')}

def need(condition, message):
    if not condition:
        raise ValueError(message)

def digest(body):
    return hashlib.sha256(body).hexdigest()

def git_hash(kind, body):
    return hashlib.sha1(kind.encode() + b' ' + str(len(body)).encode() + b'\0' + body).hexdigest()

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'Duplicate JSON key: ' + key)
        value[key] = item
    return value

def json_data(body):
    def integer(text):
        need(len(text) <= 21, 'JSON integer length limit')
        return int(text)
    def constant(text):
        raise ValueError('Non-JSON numeric constant: ' + text)
    def floating(text):
        need(len(text) <= 64, 'JSON float length limit')
        value = float(text); need(math.isfinite(value), 'Nonfinite JSON float')
        return value
    return json.loads(body.decode('utf-8'), object_pairs_hook=unique_object,
                      parse_int=integer, parse_float=floating, parse_constant=constant)

def regular(path):
    """Reject links in every existing physical component, including the leaf."""
    path = Path(path)
    need(path.is_absolute() and path == path.resolve(), 'Noncanonical file path')
    for part in [*reversed(path.parents), path]:
        item = part.lstat()
        need(not stat.S_ISLNK(item.st_mode), 'Linked path component')
    item = path.stat()
    need(stat.S_ISREG(item.st_mode) and item.st_nlink == 1, 'Nonphysical or multiply-linked file')
    return item

def pinned_file(pin):
    path = Path(pin['file'])
    metadata = regular(path)
    need(metadata.st_size == pin['bytes'], 'Pinned file size differs: ' + str(path))
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor,'rb') as stream:
        opened = os.fstat(stream.fileno())
        need((opened.st_dev,opened.st_ino,opened.st_size) == (metadata.st_dev,metadata.st_ino,metadata.st_size), 'Pinned input changed before opening')
        body = stream.read(metadata.st_size + 1)
    after = regular(path)
    need((after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) == (metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns), 'Pinned input changed while reading')
    need(len(body) == metadata.st_size and digest(body) == pin['sha256'], 'Pinned file bytes differ: ' + str(path))
    return body

def checked_path(value, limits):
    need(isinstance(value, str) and value and '\\' not in value and '\0' not in value, 'Unsafe logical path')
    encoded = value.encode('utf-8')
    pieces = value.split('/')
    need(len(encoded) <= limits['pathUTF8Bytes'] and len(pieces) <= limits['pathSegments'], 'Logical path limit')
    need(all(part not in ('', '.', '..') for part in pieces), 'Unsafe logical segment')
    return value

class Budget:
    def __init__(self, limits, clock=None):
        self.limits = dict(limits)
        self.clock = clock or time.monotonic
        self.start = self.clock()
        self.counts = {'requests': 0, 'httpBytes': 0, 'metadataBytes': 0,
                       'archiveBytes': 0, 'expandedBytes': 0, 'restoredBytes': 0,
                       'members': 0, **{kind + 'Requests': 0 for kind in KINDS}}

    def elapsed(self):
        return self.clock() - self.start

    def tick(self, terminal=False):
        limit = self.limits['wholeWallSeconds']
        if not terminal: limit -= self.limits['reserveSecondsForTerminalReceipts']
        need(self.elapsed() < limit, 'Terminal whole intake deadline' if terminal else 'Whole intake deadline')

    def add(self, key, amount, maximum):
        self.tick()
        need(type(amount) is int and amount >= 0, 'Invalid accounting increment')
        self.counts[key] += amount
        need(self.counts[key] <= self.limits[maximum], 'Exhausted ' + maximum)

    def begin(self, kind):
        self.tick()
        need(self.counts['requests'] < self.limits['newRequests'] and self.counts[kind + 'Requests'] < self.limits[KINDS[kind][0]], 'Request ceiling exhausted before request')
        self.counts['requests'] += 1; self.counts[kind + 'Requests'] += 1

    def remaining(self, kind, response_bytes):
        limits = [self.limits[KINDS[kind][1]] - response_bytes,
                  self.limits['allHTTPBodyAggregateBytes'] - self.counts['httpBytes']]
        if kind == 'archive':
            limits.append(self.limits['compressedArchiveAggregateBytes'] - self.counts['archiveBytes'])
        else:
            limits.append(self.limits['allMetadataHTTPBodyAggregateBytes'] - self.counts['metadataBytes'])
        return min(limits)

    def wire(self, kind, amount):
        key = 'archiveBytes' if kind == 'archive' else 'metadataBytes'
        limit = 'compressedArchiveAggregateBytes' if kind == 'archive' else 'allMetadataHTTPBodyAggregateBytes'
        self.counts['httpBytes'] += amount; self.counts[key] += amount
        need(self.counts['httpBytes'] <= self.limits['allHTTPBodyAggregateBytes'] and self.counts[key] <= self.limits[limit], 'Actual wire ceiling exceeded')
        self.tick()

    def expanded(self, amount, restored=False):
        self.counts['expandedBytes'] += amount
        if restored:
            self.counts['restoredBytes'] += amount
        need(self.counts['expandedBytes'] <= self.limits['archiveExpandedTarBytesPlusRestoredBlobDecodedBytes'] and self.counts['restoredBytes'] <= self.limits['canonicalBlobDecodedAggregateBytes'], 'Actual decoded ceiling exceeded')
        self.tick()

class Store:
    def __init__(self, root):
        root = Path(root)
        need(root.is_absolute() and root.parent == root.parent.resolve(), 'Physical output parent required')
        need(root.parent.is_dir() and not root.exists() and not root.is_symlink(), 'Fresh output destination required')
        root.mkdir(mode=0o700)
        need(root.stat().st_uid == os.getuid(), 'Output ownership differs')
        self.root = root
        self.objects = root / 'objects'
        self.requests = root / 'requests'
        self.objects.mkdir(mode=0o700)
        self.requests.mkdir(mode=0o700)
        self.pins = {}
        self.request_rows = []
        self.budget = None

    def guard(self):
        if self.budget is not None: self.budget.tick(terminal=True)

    def json(self, name, value):
        self.guard()
        need(re.fullmatch(r'[A-Za-z0-9_.-]+', name) is not None, 'Unsafe receipt name')
        body = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
        temporary = self.root / ('.' + name + '.next')
        published = False
        try:
            self.guard()
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(body); stream.flush(); os.fsync(stream.fileno())
            self.guard()
            os.replace(temporary, self.root / name); published = True
            self.guard()
        except Exception:
            # Revoke a late success publication; the prewritten pending receipt
            # remains in TERMINAL-PENDING.json. Nonzero exit never earns credit.
            if published and name == 'TERMINAL.json' and value.get('state') == 'seven-root-custody-verified-not-producer-complete':
                (self.root / name).unlink(missing_ok=True)
            raise
        finally:
            temporary.unlink(missing_ok=True)

    def put(self, body):
        self.guard()
        identity = digest(body)
        path = self.objects / identity
        if path.exists():
            metadata = regular(path)
            need(metadata.st_size == len(body) and path.read_bytes() == body, 'Retained CAS collision or corruption')
        else:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(body); stream.flush(); os.fsync(stream.fileno())
        pin = {'sha256': identity, 'bytes': len(body), 'file': 'objects/' + identity}
        self.pins[identity] = pin
        self.guard()
        return pin

    def reread(self):
        self.guard()
        verified = 0
        for identity, pin in sorted(self.pins.items()):
            self.guard()
            path = self.root / pin['file']; metadata = regular(path)
            observed = hashlib.sha256(); length = 0
            with path.open('rb') as stream:
                while True:
                    self.guard()
                    body = stream.read(65536)
                    self.guard()
                    if not body: break
                    length += len(body); observed.update(body)
            need(length == metadata.st_size == pin['bytes'] and observed.hexdigest() == identity, 'Independent CAS reread failed')
            verified += 1
        self.guard()
        return {'objects': verified, 'allRehashed': True}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect refused')

@contextmanager
def request_deadline(seconds):
    """A wall deadline, not a per-read socket inactivity timeout."""
    need(seconds > 0 and hasattr(signal, 'setitimer'), 'Finite POSIX request deadline required')
    need(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'Existing process timer must not be replaced')
    prior = signal.getsignal(signal.SIGALRM)
    def expired(_signal, _frame):
        raise TimeoutError('Per-request wall deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior)

class Client:
    def __init__(self, store, budget, allowed, opener=None):
        self.store, self.budget, self.allowed = store, budget, set(allowed)
        self.seen = set()
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect())

    def get(self, url, kind):
        need(url in self.allowed and url not in self.seen, 'Undeclared or repeated request')
        parsed = urllib.parse.urlsplit(url)
        need(parsed.scheme == 'https' and parsed.netloc in ('api.github.com', 'codeload.github.com')
             and not parsed.username and not parsed.password and not parsed.fragment, 'Untrusted origin')
        self.seen.add(url); self.budget.begin(kind)
        row = {'number': len(self.store.request_rows) + 1, 'url': url, 'kind': kind, 'complete': False, 'bytes': 0}
        self.store.request_rows.append(row)
        partial = self.store.requests / ('%03d.partial' % row['number'])
        descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        sha = hashlib.sha256()
        try:
            request = urllib.request.Request(url, method='GET', headers={'User-Agent': 'Checktrail-data-only-custody', 'Accept-Encoding': 'identity'})
            timeout = min(self.budget.limits['perRequestWallSeconds'],
                          self.budget.limits['wholeWallSeconds'] - self.budget.limits['reserveSecondsForTerminalReceipts'] - self.budget.elapsed())
            with os.fdopen(descriptor, 'wb') as sink:
                descriptor = None
                try:
                    with request_deadline(timeout), self.opener.open(request, timeout=timeout) as response:
                        need(response.status == 200 and response.geturl() == url, 'Unexpected HTTP identity/status')
                        need(response.headers.get('Content-Encoding', 'identity').lower() == 'identity', 'HTTP content transformation refused')
                        declared = response.headers.get('Content-Length')
                        need(declared is None or re.fullmatch(r'[0-9]+', declared), 'Malformed Content-Length')
                        declared = int(declared) if declared is not None else None
                        if declared is not None:
                            need(declared <= self.budget.remaining(kind, 0), 'Declared HTTP response exceeds remaining budget')
                        while True:
                            self.budget.tick()
                            if declared is not None and row['bytes'] == declared: break
                            remaining = self.budget.remaining(kind, row['bytes'])
                            need(remaining > 0, 'HTTP byte ceiling reached before EOF')
                            block = response.read(min(65536, remaining))
                            if not block: break
                            need(len(block) <= remaining, 'Transport violated bounded read')
                            row['bytes'] += len(block); sha.update(block); sink.write(block)
                            self.budget.wire(kind, len(block))
                        need(declared is None or row['bytes'] == declared, 'Short HTTP response')
                        row['complete'] = True
                finally:
                    sink.flush(); os.fsync(sink.fileno())
            row['sha256'] = sha.hexdigest()
            row['retained'] = self.store.put(partial.read_bytes())
            partial.unlink()
            return row['retained']
        except Exception as error:
            if descriptor is not None: os.close(descriptor)
            row['failure'] = type(error).__name__ + ': ' + str(error)
            row['sha256'] = sha.hexdigest()
            row['partialFile'] = str(partial.relative_to(self.store.root))
            raise
        finally:
            self.store.json('REQUESTS.json', self.store.request_rows)

def tree_projection(payload, expected_root, limits):
    need(isinstance(payload, dict) and payload.get('sha') == expected_root and payload.get('truncated') is False, 'Tree root/truncation differs')
    need(SHA1.fullmatch(expected_root) is not None and isinstance(payload.get('tree'), list), 'Malformed tree root')
    rows = {}
    types = {'100644': 'blob', '100755': 'blob', '120000': 'blob', '040000': 'tree', '160000': 'commit'}
    for entry in payload['tree']:
        need(isinstance(entry, dict), 'Malformed tree entry')
        name = checked_path(entry.get('path'), limits)
        need(name not in rows and entry.get('mode') in types and entry.get('type') == types[entry['mode']], 'Duplicate/malformed tree entry')
        need(isinstance(entry.get('sha'), str) and SHA1.fullmatch(entry['sha']), 'Malformed object ID')
        if entry['type'] == 'blob':
            need(type(entry.get('size')) is int and entry['size'] >= 0, 'Missing blob size')
        rows[name] = {key: entry[key] for key in ('path', 'mode', 'type', 'sha')}
        if entry['type'] == 'blob': rows[name]['size'] = entry['size']
    recompute_tree(rows, expected_root)
    return rows

def recompute_tree(rows, expected_root=None):
    children = {'': []}
    for name, entry in rows.items():
        parent, _, leaf = name.rpartition('/')
        need(not parent or (parent in rows and rows[parent]['type'] == 'tree'), 'Missing/non-tree parent')
        children.setdefault(parent, []).append((leaf, entry))
        if entry['type'] == 'tree': children.setdefault(name, [])
    computed = {}
    for folder in sorted(children, key=lambda value: (-value.count('/'), -len(value))):
        raw = bytearray()
        entries = sorted(children[folder], key=lambda item: item[0].encode() + (b'/' if item[1]['type'] == 'tree' else b''))
        for name, entry in entries:
            sha = computed[entry['path']] if entry['type'] == 'tree' else entry['sha']
            raw.extend(entry['mode'].lstrip('0').encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(sha))
        sha = git_hash('tree', bytes(raw)); computed[folder] = sha
        if folder:
            need(sha == rows[folder]['sha'], 'Nested tree differs: ' + folder)
    root = computed['']
    need(expected_root is None or root == expected_root, 'Root tree differs')
    return root

class GzipReader:
    """Single gzip member, bounded decompression; never creates extracted paths."""
    def __init__(self, stream, budget):
        self.stream, self.budget = stream, budget
        self.decoder = zlib.decompressobj(31)
        self.pending = b''; self.buffer = bytearray(); self.finished = False

    def read(self, length):
        need(0 <= length <= 33554432, 'Unbounded decompressed read')
        while len(self.buffer) < length and not self.finished:
            self.budget.tick()
            data = self.pending or self.stream.read(65536)
            need(data, 'Truncated gzip stream')
            remaining = self.budget.limits['archiveExpandedTarBytesPlusRestoredBlobDecodedBytes'] - self.budget.counts['expandedBytes']
            need(remaining > 0, 'Decoded byte ceiling reached before gzip EOF')
            produced = self.decoder.decompress(data, min(65536, length - len(self.buffer), remaining))
            self.pending = self.decoder.unconsumed_tail
            self.budget.expanded(len(produced)); self.buffer.extend(produced)
            if self.decoder.eof:
                need(not self.decoder.unused_data and not self.pending and not self.stream.read(1), 'Concatenated gzip or trailing bytes')
                self.finished = True
        result = bytes(self.buffer[:length]); del self.buffer[:length]
        return result

def tar_number(raw):
    need(not raw or not raw[0] & 128, 'Unsupported binary tar number')
    value = raw.rstrip(b'\0 ').lstrip(b' ')
    need(not value or re.fullmatch(b'[0-7]+', value), 'Malformed tar number')
    return int(value or b'0', 8)

def tar_text(raw):
    before, separator, after = raw.partition(b'\0')
    need(not separator or not any(after), 'Hidden bytes after tar string')
    return before.decode('utf-8')

def pax_fields(body):
    result = {}; offset = 0
    while offset < len(body):
        end = body.find(b' ', offset)
        need(end > offset and end - offset <= 7 and body[offset:end].isdigit(), 'Malformed PAX length')
        size = int(body[offset:end]); need(size > end - offset + 2 and offset + size <= len(body), 'PAX record overrun')
        record = body[end + 1:offset + size]
        need(record.endswith(b'\n') and b'=' in record, 'Malformed PAX record')
        key, value = record[:-1].decode('utf-8').split('=', 1)
        need(key not in result and key in {'path','linkpath','comment','mtime','atime','ctime','uid','gid','uname','gname'}, 'Duplicate or unsupported PAX key')
        need('\0' not in value, 'NUL in PAX value')
        result[key] = value; offset += size
    return result

def inspect_archive(path, expected_prefix, rows, store, budget):
    found = {}; seen = set(); pending = None; members = 0
    with Path(path).open('rb') as stream:
        reader = GzipReader(stream, budget)
        while True:
            header = reader.read(512); need(len(header) == 512, 'Truncated tar header')
            if not any(header):
                need(pending is None and reader.read(512) == bytes(512), 'Missing tar end blocks or dangling PAX')
                while True:
                    tail = reader.read(65536)
                    if not tail: break
                    need(not any(tail), 'Nonzero tar trailing payload')
                break
            members += 1; budget.add('members', 1, 'tarMembersAcrossAllArchives')
            need(members <= budget.limits['tarMembersPerArchive'], 'Per-archive member limit')
            need(tar_number(header[148:156]) == sum(header[:148]) + 8 * 32 + sum(header[156:]), 'Tar checksum differs')
            need(header[257:263] in (b'ustar\0', b'ustar '), 'Unsupported tar encoding')
            size = tar_number(header[124:136]); mode = tar_number(header[100:108]); kind = header[156:157]
            maximum = min(1048576, budget.limits['singleArchiveRegularBlobBytes']) if kind in (b'x', b'g') else budget.limits['singleArchiveRegularBlobBytes']
            need(size <= maximum, 'Tar member byte limit')
            body = reader.read(size); need(len(body) == size, 'Truncated tar body')
            padding = reader.read((-size) % 512); need(padding == bytes((-size) % 512), 'Nonzero/truncated tar padding')
            if kind in (b'x', b'g'):
                fields = pax_fields(body)
                if kind == b'g':
                    need(pending is None and not {'path','linkpath'} & fields.keys(), 'Global PAX path override')
                else:
                    need(pending is None, 'Repeated local PAX header'); pending = fields
                continue
            name = tar_text(header[:100]); prefix = tar_text(header[345:500])
            name = (prefix + '/' if prefix else '') + name
            link = tar_text(header[157:257])
            if pending is not None:
                name = pending.get('path', name); link = pending.get('linkpath', link); pending = None
            directory = kind == b'5'
            if directory:
                need(not name.endswith('//'), 'Repeated trailing directory separator')
                name = name.rstrip('/')
            checked_path(name, budget.limits)
            need(name == expected_prefix or name.startswith(expected_prefix + '/'), 'Unexpected archive root')
            need(name not in seen, 'Duplicate effective tar member'); seen.add(name)
            relative = name[len(expected_prefix):].lstrip('/')
            if not relative:
                need(directory and size == 0, 'Archive root must be a directory'); continue
            expected = rows.get(relative)
            need(expected is not None, 'Unexpected archive member: ' + relative)
            if directory:
                need(size == 0 and expected['type'] in ('tree','commit'), 'Unexpected archive directory'); continue
            need(expected['type'] == 'blob', 'Source body at typed tree/Gitlink')
            if kind == b'2':
                need(size == 0 and expected['mode'] == '120000', 'Symlink mode differs')
                body = link.encode('utf-8'); need(len(body) <= budget.limits['symlinkTargetBytes'], 'Symlink target limit')
                # Link target bytes are data. Nothing traverses this logical link.
                mode = '120000'
            else:
                need(kind in (b'0', b'\0') and not link, 'Unsupported tar member type')
                need(mode & 0o111 in (0, 0o111), 'Noncanonical executable mode')
                mode = '100755' if mode & 0o111 else '100644'
                need(mode == expected['mode'], 'Executable mode differs')
            found[relative] = {'gitBlob': git_hash('blob', body), 'mode': mode, 'retained': store.put(body)}
    return found
