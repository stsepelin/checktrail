"""Reviewed first-party GH child ownership/download primitive; no import actions."""
import pathlib,hashlib,os,signal,subprocess,shutil,time,re,json
CARRIER_MAX=128*1024**2
REPO="stsepelin/checktrail"
class Refusal(RuntimeError):
    pass

def need(v, msg):
    if not v:
        raise Refusal(msg)

def sha(b):
    return hashlib.sha256(b).hexdigest()

def freeze(p, b):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 384)
    with os.fdopen(fd, 'wb') as f:
        f.write(b)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(p, 256)

def syncdir(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

class Calls:

    def __init__(self, out, deadline, stop=None):
        self.out = out
        self.deadline = deadline
        self.stop = stop
        self.seq = 0
        self.startedPIDs = []
        self.reapedPIDs = []
        tool = shutil.which('gh')
        need(tool is not None, 'existing GitHub CLI')
        self.tool = str(pathlib.Path(tool).resolve(strict=True))
        tb = pathlib.Path(self.tool).read_bytes()
        self.events = [{'tool': 'existing GitHub CLI', 'physicalSHA256': sha(tb), 'bytes': len(tb)}]

    def run(self, tail, body_cap, seconds=30):
        need(self.stop is None or not self.stop.is_set(), 'owned API cancellation')
        self.seq += 1
        stem = self.out / ('api-' + str(self.seq).zfill(4))
        s = stem.with_suffix('.stdout')
        e = stem.with_suffix('.stderr')
        start = time.monotonic()
        proc = None
        reason = None
        progress = []
        last_bytes = 0
        first_growth = None
        last_growth = None
        try:
            need(self.deadline - start > 2, 'remaining operation budget')
            with s.open('xb') as so, e.open('xb') as se:
                env = dict(os.environ)
                env.pop('GH_DEBUG', None)
                env.pop('DEBUG', None)
                proc = subprocess.Popen([self.tool, 'api', '--hostname', 'github.com', *tail], stdout=so, stderr=se, start_new_session=True, env=env)
                self.startedPIDs.append(proc.pid)
                while proc.poll() is None:
                    now = time.monotonic()
                    current = s.stat().st_size
                    if body_cap == CARRIER_MAX and current > last_bytes:
                        sample = {'monotonicSeconds': now, 'bytes': current}
                        last_growth = sample
                        if first_growth is None:
                            first_growth = sample
                        if len(progress) < 512:
                            progress.append(sample)
                        last_bytes = current
                    if self.stop is not None and self.stop.is_set():
                        reason = 'owned API cancellation'
                        break
                    if time.monotonic() >= min(self.deadline - 1, start + seconds):
                        reason = 'API wall deadline'
                        break
                    if s.stat().st_size > body_cap or e.stat().st_size > 65536:
                        reason = 'API output cap'
                        break
                    time.sleep(0.1)
        finally:
            if proc is not None and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=max(0.1, min(2, self.deadline - time.monotonic())))
            if proc is not None and proc.poll() is not None:
                self.reapedPIDs.append(proc.pid)
        sb = s.read_bytes()
        eb = e.read_bytes()
        rc = proc.returncode if proc else None
        if len(sb) > body_cap or len(eb) > 65536:
            reason = reason or 'API terminal output cap'
        e.unlink()
        s.chmod(256)
        if time.monotonic() >= min(self.deadline - 1, start + seconds):
            reason = reason or 'API terminal wall deadline'
        self.events.append({'sequence': self.seq, 'method': tail[1] if tail[:1] == ['--method'] else 'GET', 'exitCode': rc, 'stdoutBytes': len(sb), 'stdoutSHA256': sha(sb), 'stderrBytes': len(eb), 'stderrSHA256': sha(eb), 'elapsedSeconds': time.monotonic() - start, 'startedMonotonicSeconds': start, 'endedMonotonicSeconds': time.monotonic(), 'ownedPID': proc.pid if proc else None, 'byteGrowthSamples': progress, 'firstObservedByteGrowth': first_growth, 'lastObservedByteGrowth': last_growth, 'ownedChildReaped': proc is None or proc.poll() is not None, 'stopReason': reason})
        if time.monotonic() >= min(self.deadline - 1, start + seconds):
            reason = reason or 'API terminal wall deadline'
            self.events[-1]['stopReason'] = reason
        need(reason is None, 'API operation incomplete')
        return (rc, sb, s)

    def metadata(self, path, missing=False):
        (rc, b, _) = self.run(['--include', path], 1048576)
        parts = re.split(b'\\r?\\n\\r?\\n', b, maxsplit=1)
        need(len(parts) == 2, 'HTTP metadata framing')
        line = parts[0].splitlines()[0]
        m = re.fullmatch(b'HTTP/[12](?:\\.[01])? ([0-9]{3})(?: [^\\r\\n]*)?', line)
        need(m is not None, 'HTTP status metadata')
        status = int(m.group(1))
        if missing and status == 404:
            need(rc != 0 and time.monotonic() < self.deadline - 1, 'consistent exact404 within original budget')
            return None
        need(rc == 0 and status == 200, 'metadata HTTP200 and CLI0')
        obj = json.loads(parts[1])
        need(isinstance(obj, dict), 'metadata object')
        need(time.monotonic() < self.deadline - 1, 'metadata parse within original whole budget')
        return obj

    def delete(self, aid):
        (rc, b, _) = self.run(['--method', 'DELETE', '--include', 'repos/' + REPO + '/actions/artifacts/' + str(aid)], 65536)
        line = b.splitlines()[0] if b else b''
        need(rc == 0 and re.fullmatch(b'HTTP/[12](?:\\.[01])? 204(?: [^\\r\\n]*)?', line) and time.monotonic() < self.deadline - 1, 'exact owned DELETE204 within original budget')
        return {'artifactID': aid, 'deleteExitCode': rc, 'HTTPStatus': 204}
