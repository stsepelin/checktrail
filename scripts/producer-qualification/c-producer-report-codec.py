"""Closed, lossless original C report transport; imports only trusted local code/data."""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import zlib

POLICY_SHA256 = "94fb95987b59c470fde94071220e41f5eed3071acf481e187bebaa6a4d499e46"
_policy_file = Path(__file__).resolve().with_name('c-report-encoding.v1.json')
_fd = os.open(_policy_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    _before = os.fstat(_fd)
    if not 0 < _before.st_size <= 16384:
        raise RuntimeError('Unbounded C report encoding policy')
    _raw = os.read(_fd, 16385)
    _after = os.fstat(_fd)
finally:
    os.close(_fd)
if (len(_raw) != _before.st_size or
        (_before.st_dev, _before.st_ino, _before.st_size, _before.st_mtime_ns, _before.st_ctime_ns) !=
        (_after.st_dev, _after.st_ino, _after.st_size, _after.st_mtime_ns, _after.st_ctime_ns) or
        hashlib.sha256(_raw).hexdigest() != POLICY_SHA256):
    raise RuntimeError('C report encoding policy differs')
_POLICY = json.loads(_raw)
POLICY = json.loads(_raw)
_LIMITS = dict(_POLICY['limits'])
_HEADER = bytes.fromhex(_POLICY['compression']['headerHex'])
_EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()


def _require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def _integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def _sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def _relative(value):
    if not isinstance(value, str) or not value or len(value) > 32768 or '\\' in value or '\0' in value:
        return False
    parts = value.split('/')
    return len(parts) <= _LIMITS['pathDepth'] and all(p and p not in ['.', '..'] for p in parts)


def _pin(pin, ordinal=None, semantic=False):
    keys = {'file', 'bytes', 'sha256', 'chunks'}
    if semantic:
        keys |= {'configuration', 'format', 'counts', 'totalLines', 'otherLines', 'outcomesInterpreted', 'log'}
    _require(type(pin) is dict and {'file', 'bytes', 'sha256', 'chunks'} <= set(pin) <= keys, 'Unknown or missing C report logical pin fields')
    _require(_relative(pin['file']) and _integer(pin['bytes'], 0, _LIMITS['decodedFileBytes']) and _sha(pin['sha256']), 'Invalid C report logical identity/decoded file bound')
    chunks = pin['chunks']
    _require(type(chunks) is list and len(chunks) <= _LIMITS['chunkCount'], 'C report chunk inventory exceeds bound')
    _require(len(chunks) == (pin['bytes'] + _LIMITS['decodedChunkBytes'] - 1) // _LIMITS['decodedChunkBytes'], 'Omitted or extra C report chunks')
    offset, names = 0, set()
    for chunk in chunks:
        _require(type(chunk) is dict and set(chunk) == {'file', 'offset', 'bytes', 'sha256', 'decodedBytes', 'decodedSha256'}, 'Unknown or missing C report chunk fields')
        _require(isinstance(chunk['file'], str) and re.fullmatch(r'encoded/[0-9]{8}\.gz', chunk['file']) is not None and chunk['file'] not in names, 'Unsafe or duplicate C report chunk identity')
        if ordinal is not None:
            _require(chunk['file'] == 'encoded/%08d.gz' % ordinal, 'Reordered or omitted C report physical chunks')
            ordinal += 1
        names.add(chunk['file'])
        expected = min(_LIMITS['decodedChunkBytes'], pin['bytes'] - offset)
        _require(_integer(chunk['offset'], 0, _LIMITS['decodedFileBytes']) and chunk['offset'] == offset and _integer(chunk['decodedBytes'], 1, _LIMITS['decodedChunkBytes']) and chunk['decodedBytes'] == expected, 'C report decoded chunk offset/length differs')
        _require(_integer(chunk['bytes'], 20, _LIMITS['storedMemberBytes']) and _sha(chunk['sha256']) and _sha(chunk['decodedSha256']), 'C report stored member identity/bound differs')
        offset += expected
    _require(offset == pin['bytes'], 'C report decoded length differs')
    if not chunks:
        _require(pin['sha256'] == _EMPTY_SHA256, 'Empty C report hash differs')
    return ordinal


def validate_transport(value):
    _require(type(value) is dict and value.get('schemaVersion') == 3 and type(value.get('schemaVersion')) is int, 'New C report transport schema required')
    _require(value.get('encoding') == {'id': _POLICY['id'], 'sha256': POLICY_SHA256}, 'Closed C report encoding policy differs')
    _require(type(value.get('reports')) is list and len(value['reports']) <= _LIMITS['reportCount'], 'C report inventory exceeds bound')
    files, chunks, names, ordinal = [], [], set(), 0
    decoded = stored = 0
    for report in value['reports']:
        _require(type(report) is dict, 'C report row is not an object')
        for index, pin in enumerate([report] + ([report['log']] if 'log' in report else [])):
            ordinal = _pin(pin, ordinal, semantic=index == 0)
            _require(pin['file'] not in names, 'Duplicate C report logical path')
            names.add(pin['file'])
            files.append(pin)
            chunks.extend(pin['chunks'])
            decoded += pin['bytes']
            stored += sum(chunk['bytes'] for chunk in pin['chunks'])
            _require(len(files) <= _LIMITS['logicalFileCount'] and ordinal <= _LIMITS['chunkCount'], 'C report physical/logical inventory exceeds bound')
            _require(decoded <= _LIMITS['decodedFamilyBytes'] and stored <= _LIMITS['storedFamilyBytes'], 'C report family decoded/stored byte ceiling exceeded')
    _require(_integer(value.get('retainedBytes'), 0, _LIMITS['decodedFamilyBytes']) and value['retainedBytes'] == decoded, 'C report retained decoded byte total differs')
    _require(_integer(value.get('storedBytes'), 0, _LIMITS['storedFamilyBytes']) and value['storedBytes'] == stored, 'C report stored byte total differs')
    return {'files': files, 'chunkFiles': chunks, 'decodedBytes': decoded, 'storedBytes': stored}


def encode_gzip_chunk(raw):
    _require(type(raw) is bytes and 0 < len(raw) <= _LIMITS['decodedChunkBytes'], 'C report encoder decoded chunk bound exceeded')
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15, 8, zlib.Z_DEFAULT_STRATEGY)
    encoded = _HEADER + compressor.compress(raw) + compressor.flush(zlib.Z_FINISH) + struct.pack('<II', zlib.crc32(raw) & 0xffffffff, len(raw))
    _require(len(encoded) <= _LIMITS['storedMemberBytes'], 'C report encoder stored member bound exceeded')
    return encoded


def decode_gzip_chunk(encoded, chunk):
    _require(type(encoded) is bytes and _integer(chunk.get('bytes'), 20, _LIMITS['storedMemberBytes']) and len(encoded) == chunk['bytes'] and _sha(chunk.get('sha256')) and hashlib.sha256(encoded).hexdigest() == chunk['sha256'], 'C report stored chunk bytes/hash differ')
    expected = chunk.get('decodedBytes')
    _require(_integer(expected, 1, _LIMITS['decodedChunkBytes']) and _sha(chunk.get('decodedSha256')), 'C report decoded chunk bound/identity differs')
    _require(encoded[:10] == _HEADER and len(encoded) >= 20, 'C report fixed gzip header differs')
    inflater = zlib.decompressobj(-15)
    try:
        decoded = inflater.decompress(encoded[10:-8], expected + 1)
    except zlib.error as error:
        raise RuntimeError('Invalid C report gzip deflate stream') from error
    _require(len(decoded) == expected and inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail, 'C report gzip decoded length/trailing stream differs')
    crc, length = struct.unpack('<II', encoded[-8:])
    _require(length == expected and crc == zlib.crc32(decoded) & 0xffffffff, 'C report gzip trailer differs')
    _require(hashlib.sha256(decoded).hexdigest() == chunk['decodedSha256'], 'C report decoded chunk hash differs')
    return decoded


def iter_report_bytes(pin, read_chunk):
    _pin(pin, semantic=True)
    digest, size = hashlib.sha256(), 0
    for chunk in pin['chunks']:
        encoded = read_chunk(chunk['file'], chunk['bytes'])
        raw = decode_gzip_chunk(encoded, chunk)
        digest.update(raw)
        size += len(raw)
        _require(size <= pin['bytes'], 'C report decoded file ceiling exceeded')
        yield raw
    _require(size == pin['bytes'] and digest.hexdigest() == pin['sha256'], 'C report whole original bytes/hash differ')
