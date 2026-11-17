"""First-party Intel-host/ARM-target controls; no actual SDK/source execution."""
import copy
import ctypes
import contextlib
import errno
import io
import json
import pathlib
import sys
import tempfile
import unittest
import uuid
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import controller as n


class IntelControls(unittest.TestCase):
    def test_translation_zero_and_explicit_absent_errno_are_distinct(self):
        native = {'returnCode': 0, 'errno': 0, 'size': ctypes.sizeof(ctypes.c_int), 'value': 0}
        absent = {**native, 'returnCode': -1, 'errno': errno.ENOENT, 'value': -1}
        self.assertEqual(n.intel_translation_metadata(lambda: native)['state'], 'present-native-zero')
        self.assertEqual(n.intel_translation_metadata(lambda: absent)['state'], 'absent-ENOENT-on-admitted-native-X64')

    def test_translation_whole_result_family_refuses_errors_and_inconsistent_values(self):
        native = {'returnCode': 0, 'errno': 0, 'size': ctypes.sizeof(ctypes.c_int), 'value': 0}
        absent = {**native, 'returnCode': -1, 'errno': errno.ENOENT, 'value': -1}
        for base, patch in [(native, {'value': 1}), (native, {'errno': errno.ENOENT}),
                            (native, {'size': 8}), (native, {'returnCode': True}),
                            (absent, {'errno': errno.EACCES}), (absent, {'errno': errno.EIO}),
                            (absent, {'value': 0}), (absent, {'size': 0}), (absent, {'returnCode': 1})]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                n.intel_translation_metadata(lambda: {**base, **patch})

    def test_failed_translation_keeps_exact_actual_typed_values_before_assertion(self):
        actual = {'returnCode': -1, 'errno': errno.EACCES, 'size': ctypes.sizeof(ctypes.c_int), 'value': -1}
        observed = {}
        with self.assertRaisesRegex(ValueError, 'Unknown translation'):
            n.intel_translation_metadata(lambda: actual, observed=observed)
        self.assertEqual(observed, actual)
        self.assertNotIn('state', observed)

    def test_actual_host_role_refuses_before_libsystem_tools_or_sdk(self):
        query = mock.Mock()
        for system, machine in [('Linux', 'x86_64'), ('Darwin', 'arm64'), ('Darwin', 'i386')]:
            with mock.patch.object(n.platform, 'system', lambda: system), mock.patch.object(n.platform, 'machine', lambda: machine), \
                 mock.patch.object(n, 'intel_translation_metadata', query), self.assertRaisesRegex(ValueError, 'Darwin x86_64'):
                n.host_admission({})
        query.assert_not_called()
        with mock.patch.object(n.platform, 'system', lambda: 'Darwin'), mock.patch.object(n.platform, 'machine', lambda: 'x86_64'), \
             mock.patch.object(n.os, 'getuid', lambda: 0), self.assertRaisesRegex(ValueError, 'Standard hosted Intel'):
            n.host_admission({'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_ARCH': 'ARM64'})

    def test_host_probe_positive_orchestration_is_first_party_only_under_umask077(self):
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            root = pathlib.Path(tmp).resolve()
            runner = root / 'runner'
            runner.mkdir()
            tool = root / 'inert-tool'
            tool.write_bytes(b'synthetic first-party tool bytes')
            trees = {}
            for name in ['sdk', 'toolchain', 'cmakeModules', 'gitExec']:
                folder = root / name
                folder.mkdir()
                (folder / 'inert').write_bytes(name.encode())
                trees[name] = str(folder)
            host = {'runId': '1234', 'sourceCommit': 'a' * 40, 'buildUid': 65533, 'buildGid': 65533,
                    'buildHome': '/synthetic/nobody', 'buildUser': 'nobody', 'developerDir': str(root),
                    'sdk': trees['sdk'], 'toolchain': trees['toolchain'],
                    'auxiliaryToolTrees': {key: trees[key] for key in ['cmakeModules', 'gitExec']},
                    'tools': {key: n.physical_file(tool) for key in ['cmake', 'ninja', 'git', 'python3', 'clang']},
                    'protectedWorkflowPaths': []}
            work = pathlib.Path('/private/tmp') / ('checktrail-binaryen-1234-' + uuid.uuid4().hex)
            env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                   'GITHUB_REPOSITORY': 'stsepelin/checktrail', 'GITHUB_RUN_ID': '1234', 'GITHUB_SHA': 'a' * 40,
                   'RUNNER_TEMP': str(runner), 'SUDO_UID': str(runner.stat().st_uid)}

            class FirstPartyOnly:
                def __init__(self, work, host):
                    self.started = n.time.monotonic()
                    self.baseline_nobody = set()
                    self.receipts = []

                def run(self, phase, argv, *args):
                    self.receipts.append({'phase': phase, 'argv': argv, 'syntheticNoProcessExecution': True})

            prior = n.os.umask(0o077)
            permission = mock.Mock()
            try:
                with mock.patch.dict(n.os.environ, env, clear=True), mock.patch.object(n.os, 'getuid', lambda: 0), \
                     mock.patch.object(n.os, 'chown'), mock.patch.object(n, 'host_admission', lambda *a, **k: host), \
                     mock.patch.object(n, 'Native', FirstPartyOnly), mock.patch.object(n, 'permission_admission', permission), \
                     mock.patch.object(n, 'ps_rows', lambda: []), \
                     mock.patch.object(n, 'capture_control_query', lambda *a, **k: (0, b'User nobody is not allowed to run sudo on synthetic-host.\n', b'')):
                    result = n.host_probe(type('Args', (), {'work': str(work)})())
                self.assertTrue(result['complete'])
                self.assertFalse(result['originalProducerExecuted'])
                self.assertFalse(result['SDKCompilerOrOriginalSourceExecuted'])
                self.assertFalse(result['targetRuntimeOrConsumerQualified'])
                self.assertEqual([r['phase'] for r in result['phases']], ['network-denial'])
                self.assertEqual(permission.call_args.args[2], {'roots': [{'mountPath': '.'}]})
                self.assertEqual((work / 'source').stat().st_mode & 0o777, 0o755)
                self.assertEqual((work / 'control/git-safe.config').stat().st_mode & 0o777, 0o444)
                self.assertEqual((runner / 'binaryen-host-admission.json').stat().st_mode & 0o777, 0o644)
                self.assertTrue((work / 'capture/TERMINAL.json').exists())
            finally:
                n.os.umask(prior)
                n.shutil.rmtree(work, ignore_errors=True)

    def test_native_host_tools_require_physical_intel_slice_for_whole_catalog(self):
        tools = {name: {'path': '/synthetic/' + name} for name in ['lipo', 'cmake', 'ninja', 'clang', 'clang++', 'git']}
        calls = []

        def query(folder, name, argv, env, **kwargs):
            calls.append(argv)
            return 0, b'x86_64 arm64\n', b''

        result = n.host_tool_architectures(tools, {}, query=query)
        self.assertEqual(set(result), set(tools))
        self.assertEqual(calls, [[tools['lipo']['path'], '-archs', tool['path']] for tool in tools.values()])
        for text in ['arm64', 'x86_64h', 'x86_64 x86_64', 'fake-x86_64', 'x86_64 foreign']:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, 'native Intel slice'):
                n.host_tool_architectures(tools, {}, query=lambda *a, **k: (0, text.encode()+b'\n', b''))

    def test_lipo_failed_exit_foreign_architecture_and_query_error_preserve_raw_metadata(self):
        tools = {'lipo': {'path': '/synthetic/lipo'}, 'cmake': {'path': '/synthetic/cmake'}}
        for code, stdout, stderr in [(9, b'actual unknown tool output\n', b'actual lipo failure\n'),
                                     (0, b'arm64\n', b'')]:
            observed = {}
            with self.subTest(code=code), self.assertRaises(ValueError):
                n.host_tool_architectures(tools, {}, observed=observed,
                                          query=lambda *a, **k: (code, stdout, stderr))
            self.assertEqual(set(observed), {'lipo'})
            self.assertEqual(observed['lipo']['exitCode'], code)
            self.assertEqual(observed['lipo']['stdout'], stdout.decode())
            self.assertEqual(observed['lipo']['stderr'], stderr.decode())
            self.assertFalse(observed['lipo']['nativeX64SliceVerified'])
        observed = {}

        def interrupted(folder, name, *args, **kwargs):
            (folder / (name + '.stdout')).write_bytes(b'partial observed stdout\n')
            (folder / (name + '.stderr')).write_bytes(b'partial observed stderr\n')
            (folder / (name + '.json')).write_text('{"exitCode":0,"timedOut":false,"elapsedSeconds":31}')
            raise TimeoutError('synthetic query deadline')

        with self.assertRaises(TimeoutError):
            n.host_tool_architectures(tools, {}, observed=observed, query=interrupted)
        self.assertEqual(observed['lipo']['stdout'], 'partial observed stdout\n')
        self.assertEqual(observed['lipo']['stderr'], 'partial observed stderr\n')
        self.assertIn('TimeoutError', observed['lipo']['queryFailure'])
        self.assertNotIn('exitCode', observed['lipo'])
        self.assertEqual(json.loads(observed['lipo']['boundedQueryMetadataJSON']), {'exitCode': 0, 'timedOut': False, 'elapsedSeconds': 31})

    def test_generated_system_evidence_distinguishes_host_from_target_architecture(self):
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            root = pathlib.Path(tmp)
            out = root / 'out'
            generated = out / 'CMakeFiles' / '4.4.5'
            generated.mkdir(parents=True)
            capture = root / 'capture'
            capture.mkdir()
            values = {'CMAKE_HOST_SYSTEM_NAME': 'Darwin', 'CMAKE_HOST_SYSTEM_PROCESSOR': 'x86_64',
                      'CMAKE_SYSTEM_NAME': 'Darwin', 'CMAKE_SYSTEM_PROCESSOR': 'x86_64', 'CMAKE_CROSSCOMPILING': 'FALSE'}
            p = generated / 'CMakeSystem.cmake'
            text = lambda v: '\n'.join('set(%s "%s")' % item for item in v.items()) + '\n'
            for processor in ['x86_64', 'arm64']:
                current = {**values, 'CMAKE_SYSTEM_PROCESSOR': processor}
                p.write_text(text(current))
                result = n.generated_system_metadata(out, capture)
                self.assertEqual(result['values'], current)
                self.assertEqual((capture / 'CMakeSystem.cmake').read_bytes(), p.read_bytes())
                self.assertTrue(result['cmakeCrosscompilingValueIsNotTargetRuntimeQualification'])
            for key, value in [('CMAKE_HOST_SYSTEM_PROCESSOR', 'arm64'), ('CMAKE_SYSTEM_NAME', 'Linux'),
                               ('CMAKE_SYSTEM_PROCESSOR', 'foreign'), ('CMAKE_CROSSCOMPILING', 'maybe')]:
                p.write_text(text({**values, key: value}))
                with self.subTest(key=key), self.assertRaises(ValueError):
                    n.generated_system_metadata(out, capture)
            p.write_text(text(values) + 'set(CMAKE_HOST_SYSTEM_NAME "Darwin")\n')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                n.generated_system_metadata(out, capture)
            p.unlink()
            with self.assertRaisesRegex(ValueError, 'Exactly one'):
                n.generated_system_metadata(out, capture)

    def test_requested_deployment_and_actual_macho_minimum_are_not_conflated(self):
        binary = {'cpuType': 0x0100000c, 'cpuSubtype': 0,
                  'buildVersion': {'minimumOS': 11 << 16, 'sdk': (15 << 16) + (5 << 8)}, 'binaryExecuted': False}
        result = n.validate_target_build_version(binary)
        self.assertEqual(result['requestedDeploymentTarget'], '10.15')
        self.assertEqual(result['actualMinimumOS'], 11 << 16)
        self.assertFalse(result['effectiveMinimumEqualsRequested'])
        self.assertFalse(result['compilerDeploymentAdjustmentCauseAssessed'])
        self.assertFalse(result['targetRuntimeQualified'])
        for patch in [{'cpuType': 0x01000007}, {'cpuSubtype': 2}, {'binaryExecuted': True},
                      {'buildVersion': {'minimumOS': 11 << 16, 'sdk': 14 << 16}}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                n.validate_target_build_version({**binary, **patch})

    def test_original_target_commands_remain_byte_identical(self):
        import hashlib
        original_command_sha256 = {'CONFIGURE': 'fb7c1995e25f351e82182e088444f27292cbccbe6d821c5cb7b8769c38247ddd', 'BUILD': '4364872d515c89ed9405332abc79def6ad8f5d14f373b390fd607704687dd50e', 'PACK': 'bd21b607b6e1a64a7e8b10cd589a7ec843e6dfa2b3b3d2ac8d13e0b9fa46ea31'}
        for key, expected in original_command_sha256.items():
            self.assertEqual(hashlib.sha256(json.dumps(getattr(n, key), separators=(',', ':')).encode()).hexdigest(), expected)
        self.assertNotIn('--parallel', n.BUILD)
        self.assertNotIn('ctest', n.PACK)


if __name__ == '__main__':
    unittest.main(verbosity=2)
