"""Held generated IPC objects only; never reads source archives or endpoint data."""
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import types
import unittest

DIRECTORY = Path(sys.argv.pop(1))
observer = types.ModuleType('owned_node_retention_controls')
exec(compile((DIRECTORY / 'node-original-retention-observer.py').read_bytes(),
             str(DIRECTORY / 'node-original-retention-observer.py'), 'exec'), observer.__dict__)


def roots(base):
    values = [base / name for name in ['bundle', 'controls', 'work']]
    for path in values:
        path.mkdir()
    (values[0] / 'immutable').write_bytes(b'b')
    (values[1] / 'control').write_bytes(b'c')
    return values


class Observer(unittest.TestCase):
    def test_held_work_socket_then_three_byte_regular_leaf(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-ipc-', dir=str(Path('/tmp').resolve(strict=True))) as temporary:
            values = roots(Path(temporary))
            parent = values[2] / 'test' / '.tmp.0'
            parent.mkdir(parents=True)
            leaf = parent / 'pipe'
            held = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            original = observer.os
            proxy = types.SimpleNamespace(**{name: getattr(original, name) for name in dir(original)})
            opened = []
            def only_directories(path, flags, *args, **kwargs):
                self.assertTrue(flags & os.O_DIRECTORY, 'observer attempted a leaf/content open')
                opened.append(str(path))
                return original.open(path, flags, *args, **kwargs)
            proxy.open = only_directories
            try:
                held.bind(str(leaf))
                observer.os = proxy
                value = observer.count_roots(values)
                self.assertEqual({key: value[key] for key in ['files', 'bytes', 'sockets', 'links']},
                                 {'files': 3, 'bytes': 2, 'sockets': 1, 'links': 0})
                self.assertNotIn('pipe', opened)
                held.close()
                leaf.unlink()
                leaf.write_bytes(b'abc')
                value = observer.count_roots(values)
                self.assertEqual({key: value[key] for key in ['files', 'bytes', 'sockets', 'links']},
                                 {'files': 3, 'bytes': 5, 'sockets': 0, 'links': 0})
            finally:
                observer.os = original
                held.close()

    def test_both_immutable_roots_still_refuse_actual_held_socket(self):
        for index in [0, 1]:
            with self.subTest(root=index), tempfile.TemporaryDirectory(prefix='ct-node-ipc-', dir=str(Path('/tmp').resolve(strict=True))) as temporary:
                values = roots(Path(temporary))
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as held:
                    held.bind(str(values[index] / 'pipe'))
                    with self.assertRaisesRegex(ValueError, 'nonregular retained work refused'):
                        observer.count_roots(values)

    def test_filesystem_fifo_still_refused_without_opening_it(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-ipc-', dir=str(Path('/tmp').resolve(strict=True))) as temporary:
            values = roots(Path(temporary))
            os.mkfifo(values[2] / 'pipe')
            with self.assertRaisesRegex(ValueError, 'nonregular retained work refused'):
                observer.count_roots(values)

    def test_replaced_socket_identity_refuses_without_reading_replacement(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-ipc-', dir=str(Path('/tmp').resolve(strict=True))) as temporary:
            values = roots(Path(temporary))
            leaf = values[2] / 'pipe'
            original = observer.os
            proxy = types.SimpleNamespace(**{name: getattr(original, name) for name in dir(original)})
            replaced = []
            def swapping_stat(path, *args, **kwargs):
                if path == 'pipe':
                    self.assertFalse(kwargs['follow_symlinks'])
                    self.assertIsNotNone(kwargs['dir_fd'])
                    leaf.unlink()
                    leaf.write_bytes(b'abc')
                    replaced.append(True)
                return original.stat(path, *args, **kwargs)
            proxy.stat = swapping_stat
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as held:
                held.bind(str(leaf))
                observer.os = proxy
                try:
                    with self.assertRaisesRegex(ValueError, 'work socket identity changed'):
                        observer.count_roots(values)
                finally:
                    observer.os = original
            self.assertEqual(replaced, [True])
            self.assertEqual(leaf.read_bytes(), b'abc')

    def test_actual_main_emits_separate_socket_metadata_and_no_content_read_claim(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-ipc-', dir=str(Path('/tmp').resolve(strict=True))) as temporary:
            values = roots(Path(temporary))
            out, err = io.StringIO(), io.StringIO()
            original_roots, original_sys = observer.ROOTS, observer.sys
            request = {'schemaVersion': 1, 'kind': 'sample', 'sequence': 1}
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as held:
                held.bind(str(values[2] / 'pipe'))
                observer.ROOTS = tuple(str(path) for path in values)
                observer.sys = types.SimpleNamespace(argv=['fixed-observer'], stdin=types.SimpleNamespace(
                    buffer=io.BytesIO((json.dumps(request)+'\n').encode())), stderr=err)
                try:
                    with contextlib.redirect_stdout(out):
                        observer.main()
                finally:
                    observer.ROOTS, observer.sys = original_roots, original_sys
            self.assertEqual(len(out.getvalue().splitlines()), 2)
            ready, sample = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(ready['kind'], 'ready')
            self.assertEqual(sample, {'schemaVersion': 1, 'kind': 'sample', 'sequence': 1,
                                      'bytes': 2, 'files': 3, 'directories': 3})
            self.assertEqual(json.loads(err.getvalue()), {'schemaVersion': 1, 'kind': 'node-link-object-counts',
                'sequence': 1, 'links': 0, 'linkTargetBytes': 0, 'targetContentsFollowed': False,
                'sockets': 1, 'socketContentsRead': False})


if __name__ == '__main__':
    unittest.main()
