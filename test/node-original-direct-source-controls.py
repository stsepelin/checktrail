"""Generated XZ/tar sources only; no original archives, tools or upstream code."""
import hashlib
import io
import json
import lzma
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import time
import types
import unittest

DIRECTORY = Path(sys.argv.pop(1))
bridge = types.ModuleType('owned_node_source_bridge_controls')
exec(compile((DIRECTORY / 'node-original-source.py').read_bytes(),
             str(DIRECTORY / 'node-original-source.py'), 'exec'), bridge.__dict__)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fixture(base, extra=None):
    base = base.resolve(strict=True)
    bundle, work = base / 'bundle', base / 'work'
    (bundle / 'source').mkdir(parents=True)
    work.mkdir()
    root = 'node-v22.16.0'
    directories = {'': 0o755, 'dir': 0o751, 'utf': 0o750, 'utf/新建文件夹': 0o750}
    files = {'short.js': (b'fixture\n', 0o640), 'empty.txt': (b'', 0o640),
             'dir/' + 'x' * 110 + '.txt': (b'original long fixture\n', 0o751),
             'utf/新建文件夹/a.txt': ('原始数据\n'.encode(), 0o640)}
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.GNU_FORMAT) as archive:
        for name, mode in directories.items():
            item = tarfile.TarInfo(root + ('/' + name if name else '') + '/')
            item.type, item.mode, item.mtime, item.uid, item.gid = tarfile.DIRTYPE, mode, 1234567890, 1000, 1000
            archive.addfile(item)
        for name, (raw, mode) in files.items():
            item = tarfile.TarInfo(root + '/' + name)
            item.mode, item.mtime, item.uid, item.gid, item.size = mode, 1234567891, 1000, 1000, len(raw)
            archive.addfile(item, io.BytesIO(raw))
        if extra is not None:
            item = tarfile.TarInfo(extra[0])
            item.mode, item.mtime, item.uid, item.gid = 0o640, 1234567891, 1000, 1000
            if extra[1] == 'link':
                item.type, item.linkname = tarfile.SYMTYPE, '../outside'
                archive.addfile(item)
            elif extra[1] == 'hardlink':
                item.type, item.linkname = tarfile.LNKTYPE, root + '/short.js'
                archive.addfile(item)
            else:
                item.size = 1
                archive.addfile(item, io.BytesIO(b'x'))
    tar = stream.getvalue()
    compressed = lzma.compress(tar, format=lzma.FORMAT_XZ, preset=0)
    file = bundle / 'source/node-v22.16.0.tar.xz'
    file.write_bytes(compressed)
    source = {'root': root, 'archive': {'file': 'source/node-v22.16.0.tar.xz',
               'bytes': len(compressed), 'sha256': sha(compressed)},
              'expandedTarBytes': len(tar),
              'expandedPartReferences': [{'bytes': 519, 'sha256': sha(tar[:519])},
                                         {'bytes': len(tar) - 519, 'sha256': sha(tar[519:])}],
              'expectedCounts': {'members': 8, 'regular': 4, 'directories': 4,
                                 'gnuLongNames': 1, 'rawHeaders': 9}}
    return bundle, work, source, file, tar, files, directories


def replace_input(file, source, raw):
    file.write_bytes(raw)
    source['archive'].update(bytes=len(raw), sha256=sha(raw))


class DirectSourceControls(unittest.TestCase):
    def test_signed_byte_pin_then_real_xz_gnu_utf8_empty_modes_and_mtimes(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-valid-') as temporary:
            bundle, work, source, _, _, files, directories = fixture(Path(temporary))
            value = bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            root = work / source['root']
            self.assertFalse(value['oldLocalIndexReusedOrRelabeled'])
            self.assertTrue(value['originalModesAndMtimesPreserved'])
            self.assertEqual(value['counters']['regular'], 4)
            self.assertEqual(value['counters']['emptyRegular'], 1)
            self.assertEqual(value['gnuLongNames'], 1)
            self.assertEqual(value['decodedTar']['qualifiedExpandedIntervalsMatched'], 2)
            self.assertEqual(value['decodedTar']['decoderMemoryLimitBytes'], 256 * 1024**2)
            for name, (raw, mode) in files.items():
                self.assertEqual((root / name).read_bytes(), raw)
                self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), mode)
                self.assertEqual((root / name).stat().st_mtime, 1234567891)
            for name, mode in directories.items():
                self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), mode)
                self.assertEqual((root / name).stat().st_mtime, 1234567890)
            member_file = work / value['nativeMemberIdentities']['file']
            raw = member_file.read_bytes()
            self.assertEqual(sha(raw), value['nativeMemberIdentities']['sha256'])
            rows = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(len(rows), 8)
            self.assertEqual({row['archiveUid'] for row in rows}, {1000})
            self.assertEqual({row['archiveGid'] for row in rows}, {1000})
            self.assertEqual(value['materializedOwner'], {'uid': os.geteuid(), 'gid': os.getegid()})

    def test_changed_source_sha_refuses_before_any_preparation_output(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-pin-') as temporary:
            bundle, work, source, file, _, _, _ = fixture(Path(temporary))
            raw = file.read_bytes()
            file.write_bytes(raw[:-1] + bytes([raw[-1] ^ 1]))
            with self.assertRaisesRegex(ValueError, 'signed Node archive byte identity differs'):
                bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            self.assertFalse(list(work.iterdir()))

    def test_actual_decoder_crc_failure_is_retained_after_valid_input_pin(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-crc-') as temporary:
            bundle, work, source, file, _, _, _ = fixture(Path(temporary))
            raw = file.read_bytes()
            replace_input(file, source, raw[:-1] + bytes([raw[-1] ^ 1]))
            with self.assertRaises(lzma.LZMAError) as caught:
                bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            self.assertIn('counters', caught.exception.nodeSourcePreparation)
            self.assertFalse((work / source['root']).exists())

    def test_concatenated_xz_stream_cannot_be_hidden_as_trailing_source(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-tail-') as temporary:
            bundle, work, source, file, _, _, _ = fixture(Path(temporary))
            replace_input(file, source, file.read_bytes() + lzma.compress(b'not-original-source'))
            with self.assertRaisesRegex(ValueError, 'Trailing or concatenated'):
                bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            self.assertFalse((work / source['root']).exists())

    def test_real_expansion_crosses_the_declared_bound_before_source_materialization(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-expansion-') as temporary:
            bundle, work, source, _, _, _, _ = fixture(Path(temporary))
            source['expandedTarBytes'] -= 1
            source['expandedPartReferences'][1]['bytes'] -= 1
            with self.assertRaisesRegex(ValueError, 'expanded beyond exact bound') as caught:
                bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            self.assertEqual(caught.exception.nodeSourcePreparation['counters']['decoderReturnedBytes'],
                             source['expandedTarBytes'] + 1)
            self.assertFalse((work / source['root']).exists())

    def test_traversal_and_adjacent_root_refuse_before_source_leaf_writes(self):
        for name in ['node-v22.16.0/../escape', 'node-v22.16.00/foreign']:
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='ct-node-xz-path-') as temporary:
                bundle, work, source, _, _, _, _ = fixture(Path(temporary), (name, 'file'))
                with self.assertRaisesRegex(ValueError, 'Unsafe source path|Foreign original Node source root'):
                    bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
                self.assertFalse((work / source['root']).exists())
                self.assertFalse((work.parent / 'escape').exists())

    def test_source_symlink_and_hardlink_refuse_instead_of_following_or_normalizing(self):
        for kind in ['link', 'hardlink']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='ct-node-xz-links-') as temporary:
                bundle, work, source, _, _, _, _ = fixture(Path(temporary), ('node-v22.16.0/link', kind))
                with self.assertRaisesRegex(ValueError, 'links/sparse/PAX/special'):
                    bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
                self.assertFalse((work / source['root']).exists())

    def test_non_cold_namespace_and_expired_duration_remain_refusals(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-admission-') as temporary:
            bundle, work, source, _, _, _, _ = fixture(Path(temporary))
            (work / 'foreign').write_bytes(b'held')
            with self.assertRaisesRegex(ValueError, 'must be cold'):
                bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            (work / 'foreign').unlink()
            with self.assertRaisesRegex(ValueError, 'deadline'):
                bridge.prepare_source(bundle, work, source, 0)

    def test_input_fstat_failure_closes_the_actual_opened_descriptor(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-fstat-') as temporary:
            bundle, work, source, file, _, _, _ = fixture(Path(temporary))
            original = bridge.os
            proxy = types.SimpleNamespace(**{name: getattr(original, name) for name in dir(original)})
            opened = []
            def open_fd(path, flags, *args, **kwargs):
                fd = original.open(path, flags, *args, **kwargs)
                if Path(path) == file:
                    opened.append(fd)
                return fd
            def fstat_fd(fd):
                if opened and fd == opened[-1]:
                    raise OSError('toy fstat primary')
                return original.fstat(fd)
            proxy.open, proxy.fstat = open_fd, fstat_fd
            bridge.os = proxy
            try:
                with self.assertRaisesRegex(OSError, 'fstat primary'):
                    bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            finally:
                bridge.os = original
            self.assertEqual(len(opened), 1)
            with self.assertRaises(OSError) as caught:
                os.fstat(opened[0])
            self.assertEqual(caught.exception.errno, 9)

    def test_actual_two_byte_output_then_eio_keeps_the_physical_tar_prefix(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-xz-write-') as temporary:
            bundle, work, source, _, tar, _, _ = fixture(Path(temporary))
            original = bridge.os
            proxy = types.SimpleNamespace(**{name: getattr(original, name) for name in dir(original)})
            writes = [0]
            def write(fd, raw):
                writes[0] += 1
                if writes[0] == 1:
                    return original.write(fd, raw[:2])
                raise OSError('toy tar write primary')
            proxy.write = write
            bridge.os = proxy
            try:
                with self.assertRaisesRegex(OSError, 'tar write primary') as caught:
                    bridge.prepare_source(bundle, work, source, time.monotonic() + 5)
            finally:
                bridge.os = original
            retained = (work / 'preparation/node-source.tar').read_bytes()
            self.assertEqual(retained, tar[:2])
            progress = caught.exception.nodeSourcePreparation['counters']['decodedTarWrite']
            self.assertEqual(progress, {'writtenBytes': 2, 'writtenPrefixSha256': sha(retained)})


if __name__ == '__main__':
    unittest.main()
