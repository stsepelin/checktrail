"""Execute only generated shell tools; never invoke a native producer or Docker."""
import json
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

repository = Path(sys.argv[1]).resolve(strict=True)
controller = repository / 'scripts/producer-qualification'
original = (controller / 'c-producer-build.sh').read_text()
caller = [str(os.geteuid()), str(os.getegid())]
observed = []
refusals = 0


def write(path, body, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(0o700 if executable else 0o600)


def refuses(action, kind, message):
    global refusals
    try:
        action()
    except kind as error:
        assert message in str(error), str(error)
        refusals += 1
    else:
        raise AssertionError('Expected exact marker refusal: ' + message)


with tempfile.TemporaryDirectory(prefix='ct-command-') as temporary:
    root = Path(temporary).resolve(strict=True)
    assert not any(c in str(root) for c in ' \n\r,')
    # macOS temporary parents may inherit a different group. Align only this
    # owned fixture directory before children inherit its actual group.
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fchown(fd, os.geteuid(), os.getegid())
        assert os.fstat(fd).st_gid == root.stat().st_gid == os.getegid()
    finally:
        os.close(fd)
    spec = importlib.util.spec_from_file_location('generated_collector', controller / 'c-producer-test-reports.py')
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    ids = {'uid': os.geteuid(), 'gid': os.getegid()}
    markers = root / 'markers'
    markers.mkdir(mode=0o700)
    collector.write_command_observation('requested', markers, ids)
    before = (markers / 'original-command-requested.json').read_bytes()
    refuses(lambda: collector.write_command_observation('requested', markers, ids), FileExistsError, 'File exists')
    assert (markers / 'original-command-requested.json').read_bytes() == before
    for code in ['256', '00', '1.5', None, True]:
        refuses(lambda: collector.write_command_observation('terminal', markers, ids, code), RuntimeError, 'exit code is invalid')
    assert not (markers / 'original-command-terminal.json').exists()
    refuses(lambda: collector.write_command_observation('requested', markers, ids, '0'), RuntimeError, 'cannot claim')
    refuses(lambda: collector.write_command_observation('terminal-near', markers, ids, '0'), RuntimeError, 'Unknown original')
    markers.chmod(0o755)
    refuses(lambda: collector.write_command_observation('terminal', markers, ids, '0'), RuntimeError, 'parent differs')
    markers.chmod(0o700)
    refuses(lambda: collector.write_command_observation('terminal', markers, {**ids, 'uid': ids['uid'] + 1}, '0'), RuntimeError, 'parent differs')
    refuses(lambda: collector.write_command_observation('terminal', markers, {**ids, 'gid': ids['gid'] + 1}, '0'), RuntimeError, 'parent differs')
    assert not (markers / 'original-command-terminal.json').exists()
    alias = root / 'marker-alias'
    alias.symlink_to(markers)
    refuses(lambda: collector.write_command_observation('terminal', alias, ids, '0'), RuntimeError, 'not canonical')
    collector.write_command_observation('terminal', markers, ids, '255')
    assert json.loads((markers / 'original-command-terminal.json').read_bytes())['exitCode'] == 255
    overhead = len(json.dumps({'blob': ''}, indent=2).encode()) + 1
    near = {'blob': 'x' * (8 * 1024**2 - overhead)}
    collector.write_manifest(root / 'exact-manifest', near, ids)
    assert (root / 'exact-manifest').stat().st_size == 8 * 1024**2
    near['blob'] += 'x'
    refuses(lambda: collector.write_manifest(root / 'oversize-manifest', near, ids), RuntimeError, '8MiB reader bound')
    assert not (root / 'oversize-manifest').exists()
    for mode, command_code, report_failure in [
        ('success', 0, False), ('retention-failure', 0, True),
        ('command-failure', 7, False), ('interrupted', None, False),
    ]:
        case = root / mode
        case.mkdir(mode=0o700)
        for leaf in ['build', 'work', 'inputs', 'controller', 'bin']:
            (case / leaf).mkdir(mode=0o700)
        # Relocate fixed fixture roots only; the shell logic and command argv
        # remain exact. Reverse substitution proves no other source edit.
        shell = original
        for leaf in ['build', 'work', 'inputs', 'controller']:
            shell = shell.replace('/' + leaf, str(case / leaf))
        restored = shell
        for leaf in ['build', 'work', 'inputs', 'controller']:
            restored = restored.replace(str(case / leaf), '/' + leaf)
        assert restored == original
        write(case / 'run.sh', shell)
        write(case / 'controller/c-producer-test-reports.py',
              (controller / 'c-producer-test-reports.py').read_text())
        prefix = '#!' + sys.executable + '\n'
        tracing = "import json,os,sys\nfrom pathlib import Path\ncase=Path(os.environ['CT_CASE'])\nwith (case/'trace').open('a')as f:f.write(json.dumps([Path(sys.argv[0]).name,*sys.argv[1:]])+'\\n')\n"
        write(case / 'bin/apt-get', prefix + tracing, True)
        write(case / 'bin/dpkg-checkbuilddeps', prefix + tracing, True)
        write(case / 'bin/dpkg-query', prefix + tracing + "print('synthetic\\t1\\tall')\n", True)
        write(case / 'bin/dpkg-source', prefix + tracing +
              "source=case/'build/source'\n(source/'debian').mkdir(parents=True)\n(source/'configure').touch()\n(source/'debian/control').touch()\n", True)
        write(case / 'bin/dpkg-buildpackage', prefix + tracing +
              "assert sys.argv[1:]==['-b','-us','-uc','--jobs=4']\n"
              "p=case/'build/source/build-tree/amd64-libc';p.mkdir(parents=True)\n"
              "(p/'tests.sum').write_text('PASS: generated\\nFAIL: generated failure\\n')\n"
              "if os.environ['CT_MODE']=='interrupted':\n import signal\n os.kill(os.getppid(),signal.SIGKILL)\n os._exit(0)\n"
              "sys.exit(int(os.environ['CT_COMMAND_CODE']))\n", True)
        write(case / 'bin/tar', prefix + tracing +
              "assert sys.argv[1:]==['-C',str(case/'build'),'-cf',str(case/'work/native-build-worktree.tar'),'.']\n"
              "(case/'work/native-build-worktree.tar').write_bytes(b'authored archive placeholder')\n", True)
        write(case / 'bin/python3', prefix + tracing +
              "args=sys.argv[1:]\n"
              "if len(args)>4 and args[3].endswith('/c-producer-test-reports.py') and args[4]=='glibc' and os.environ['CT_REPORT_FAIL']=='1':sys.exit(9)\n"
              "os.execv(sys.executable,[sys.executable,*args])\n", True)
        env = dict(os.environ, PATH=str(case / 'bin') + os.pathsep + os.environ['PATH'],
                   CT_CASE=str(case), CT_MODE=mode, CT_COMMAND_CODE=str(command_code),
                   CT_REPORT_FAIL='1' if report_failure else '0')
        child = subprocess.run(['/bin/sh', str(case / 'run.sh'), 'glibc', *caller],
                               env=env, capture_output=True, timeout=10)
        work = case / 'work'
        requested = json.loads((work / 'original-command-requested.json').read_bytes())
        assert requested['invocationRequested'] is True
        assert requested['commandTerminalObserved'] is False and requested['exitCode'] is None
        assert (work / 'original-command-requested.json').stat().st_mode & 0o777 == 0o600
        trace = [json.loads(line) for line in (case / 'trace').read_text().splitlines()]
        assert sum(row[0] == 'dpkg-buildpackage' for row in trace) == 1
        if mode == 'interrupted':
            assert child.returncode == -signal.SIGKILL, child.stderr
            assert not (work / 'original-command-terminal.json').exists()
            assert not (work / 'original-command.json').exists()
            assert not any(row[0] == 'tar' for row in trace)
            # Actual data collector can retain reports after the shell EXIT
            # trap was bypassed. This is same-UID host custody, not root proof.
            post = work / 'post-stop-reports'
            post.mkdir(mode=0o700)
            retained = subprocess.run([sys.executable, '-I', '-S', '-B',
                                       str(controller / 'c-producer-test-reports.py'),
                                       'glibc', str(case / 'build/source'),
                                       str(post / 'test-reports.json'), *caller],
                                      capture_output=True, timeout=10)
            assert retained.returncode == 0, retained.stderr
            report = json.loads((post / 'test-reports.json').read_bytes())
            assert len(report['reports']) == 1 and report['reports'][0]['counts']['FAIL'] == 1
            assert report['exportCustody']['producerEffectiveUid'] == os.geteuid()
        else:
            terminal = json.loads((work / 'original-command-terminal.json').read_bytes())
            final = json.loads((work / 'original-command.json').read_bytes())
            expected = 1 if report_failure else command_code
            assert child.returncode == expected, child.stderr
            assert terminal['commandTerminalObserved'] is True and terminal['exitCode'] == command_code
            assert terminal['wrapperTerminalObserved'] is False and terminal['wrapperExitCode'] is None
            assert final['exitCode'] == command_code and final['wrapperExitCode'] == expected
            assert final['invoked'] is True
            assert sum(row[0] == 'tar' for row in trace) == 1
            assert (work / 'native-build-worktree.tar').read_bytes() == b'authored archive placeholder'
            if report_failure:
                assert not (work / 'test-reports.json').exists()
            else:
                assert len(json.loads((work / 'test-reports.json').read_bytes())['reports']) == 1
        observed.append(mode)
print(json.dumps({'cases': observed, 'commandRuns': 4,
                  'markerAndManifestRefusals': refusals,
                  'originalProducerExecuted': False, 'sameUidHostCustodyOnly': True}))
