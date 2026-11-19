"""Closed, read-only stock-runner/service admission for the GCC continuation.

This probe never pulls an image, prepares inputs, installs packages or executes
upstream code. Its observations are retained; they do not reserve shared cache.
"""
import argparse
import datetime as dt
import email.utils
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time
import urllib.request

REPOSITORY = 'stsepelin/checktrail'
WORKFLOW_ID = 363121286
JOB = 'gcc-staged-first'
GIB = 1024 ** 3
SERVICE_SECONDS = 21600
FINALIZE_SECONDS = 3300
MAXIMUM_NATIVE_SECONDS = 14400
CHECKPOINT_BYTES = 4000000000
FREE_CACHE_BYTES = 10000000000


def require(value, message):
    if not value:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def instant(value):
    require(isinstance(value, str) and value.endswith('Z'), 'Missing UTC service timestamp')
    return dt.datetime.fromisoformat(value[:-1] + '+00:00')


def context(environment):
    expected = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': REPOSITORY}
    require(all(environment.get(key) == value for key, value in expected.items()), 'Wrong fixed public hosted context')
    require(re.fullmatch(r'refs/heads/diagnostic/[A-Za-z0-9._/-]+', environment.get('GITHUB_REF', '')),
            'Native continuation requires an explicit diagnostic branch')
    require(re.fullmatch('[a-f0-9]{40}', environment.get('GITHUB_SHA', '')), 'Invalid reviewed checkout SHA')
    require(re.fullmatch('[1-9][0-9]*', environment.get('GITHUB_RUN_ID', '')) and
            re.fullmatch('[1-9][0-9]*', environment.get('GITHUB_RUN_ATTEMPT', '')), 'Invalid source run/attempt')
    require(environment.get('GITHUB_JOB') == JOB, 'Wrong fixed carrier job')
    return {key: environment[key] for key in [*expected, 'GITHUB_REF', 'GITHUB_SHA',
                                            'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB']}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise ValueError('GitHub service redirect refused')


class GitHub:
    def __init__(self, token, output):
        require(isinstance(token, str) and 0 < len(token) <= 4096 and not re.search('[\r\n]', token),
                'Missing bounded operator GitHub token')
        self.token = token
        self.output = Path(output)
        self.sequence = 0
        self.opener = urllib.request.build_opener(NoRedirect())

    def get(self, suffix):
        prefix = '/repos/' + REPOSITORY
        require((suffix == prefix or suffix.startswith(prefix + '/')) and '..' not in suffix and
                not re.search('[\r\n#]', suffix), 'Unexpected GitHub API path')
        url = 'https://api.github.com' + suffix
        request = urllib.request.Request(url, headers={
            'Accept': 'application/vnd.github+json', 'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache', 'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'checktrail-gcc-staged-readonly-admission',
            'Authorization': 'Bearer ' + self.token})
        started = time.monotonic()
        with self.opener.open(request, timeout=20) as response:
            require(response.status == 200 and response.headers.get('Content-Encoding', 'identity') == 'identity',
                    'Unexpected GitHub service response')
            raw = response.read(2 * 1024 ** 2 + 1)
            require(len(raw) <= 2 * 1024 ** 2, 'Oversized service response')
            date = email.utils.parsedate_to_datetime(response.headers['Date'])
            received = dt.datetime.now(dt.timezone.utc)
            elapsed = time.monotonic() - started
            require(abs((received - date).total_seconds()) <= 120 and elapsed <= 25,
                    'Unbounded service/local clock discrepancy')
        record = {'url': url, 'httpStatus': 200, 'serviceDate': date.isoformat(),
                  'receivedAt': received.isoformat(), 'requestSeconds': elapsed,
                  'rawSha256': hashlib.sha256(raw).hexdigest(), 'authenticationHeadersRetained': False}
        prefix = self.output / ('service-%03d' % self.sequence)
        self.sequence += 1
        prefix.with_suffix('.json').write_bytes(raw)
        prefix.with_suffix('.receipt.json').write_bytes(canonical(record) + b'\n')
        return json.loads(raw), record


def service_clock(selected, repository, run, jobs, capture, configured_job_seconds=SERVICE_SECONDS):
    require(type(configured_job_seconds) is int and 0 < configured_job_seconds <= SERVICE_SECONDS,
            'Invalid configured source-job timeout')
    require(repository['full_name'] == REPOSITORY and repository['private'] is False,
            'Paid/private source repository not admitted')
    require(run['id'] == int(selected['GITHUB_RUN_ID']) and
            run['run_attempt'] == int(selected['GITHUB_RUN_ATTEMPT']) and
            run['head_sha'] == selected['GITHUB_SHA'] and run['event'] == 'workflow_dispatch' and
            run['workflow_id'] == WORKFLOW_ID and run['head_branch'] == selected['GITHUB_REF'][11:],
            'Service run differs from reviewed manual diagnostic checkout')
    require(type(jobs['total_count']) is int and 0 < jobs['total_count'] <= 100 and
            len(jobs['jobs']) == jobs['total_count'], 'Incomplete service job inventory')
    matching = [row for row in jobs['jobs'] if row['name'] == JOB]
    require(len(matching) == 1, 'Ambiguous carrier job identity')
    job = matching[0]
    require(job['status'] == 'in_progress' and job['conclusion'] is None and
            job['run_id'] == run['id'] and 'ubuntu-26.04' in job['labels'],
            'Unknown stock Ubuntu 26.04 service job')
    server = dt.datetime.fromisoformat(capture['serviceDate'])
    age = (server - instant(job['started_at'])).total_seconds() + capture['requestSeconds'] + 2
    require(0 <= age < configured_job_seconds, 'Source hosted job deadline exhausted or in future')
    return {'jobId': job['id'], 'jobStartedAt': job['started_at'],
            'runId': run['id'], 'runAttempt': run['run_attempt'], 'headSha': run['head_sha'],
            'jobAgeUpperSeconds': age, 'remainingSeconds': max(0, configured_job_seconds - age),
            'platformMaximumSeconds': SERVICE_SECONDS, 'configuredJobSeconds': configured_job_seconds,
            'capturedMonotonic': time.monotonic(), 'serviceClockSource': capture,
            'includesCheckoutPreparationCaptureUploadFinalization': True}


def cache_capacity(policy, usage, listing):
    require(type(policy['max_cache_size_gb']) is int and 0 < policy['max_cache_size_gb'] <= 10,
            'Unpaid repository cache ceiling is absent or exceeds 10 GB')
    require(type(usage['active_caches_size_in_bytes']) is int and
            type(usage['active_caches_count']) is int and usage['active_caches_size_in_bytes'] >= 0,
            'Invalid cache usage observation')
    require(type(listing['total_count']) is int and 0 <= listing['total_count'] <= 1000 and
            len(listing['actions_caches']) == listing['total_count'], 'Complete cache inventory unavailable')
    require(len({row['id'] for row in listing['actions_caches']}) == listing['total_count'] and
            all(type(row['size_in_bytes']) is int and row['size_in_bytes'] >= 0 for row in listing['actions_caches']),
            'Invalid cache entry identities/sizes')
    occupied = max(usage['active_caches_size_in_bytes'],
                   sum(row['size_in_bytes'] for row in listing['actions_caches']))
    ceiling = min(FREE_CACHE_BYTES, policy['max_cache_size_gb'] * 1000000000)
    headroom = max(0, ceiling - occupied)
    return {'repositoryCacheLimitBytes': ceiling, 'observedOccupiedBytes': occupied,
            'availableCacheBytes': headroom, 'predecessorSuccessorBytesRequired': 2 * CHECKPOINT_BYTES,
            'headroomAdmitted': headroom >= 2 * CHECKPOINT_BYTES,
            'cacheUsageMayLagSeconds': 300, 'reservationGuaranteed': False,
            'sharedConcurrentWritesRemainPossible': True, 'settingsChanged': False,
            'unrelatedCachesDeleted': False}


def capture_service(api, selected, configured_job_seconds=SERVICE_SECONDS):
    prefix = '/repos/' + REPOSITORY
    repository, _ = api.get(prefix)
    run, _ = api.get(prefix + '/actions/runs/' + selected['GITHUB_RUN_ID'])
    jobs, response = api.get(prefix + '/actions/runs/' + selected['GITHUB_RUN_ID'] +
                             '/attempts/' + selected['GITHUB_RUN_ATTEMPT'] + '/jobs?per_page=100')
    clock = service_clock(selected, repository, run, jobs, response, configured_job_seconds)
    policy, _ = api.get(prefix + '/actions/cache/storage-limit')
    usage, _ = api.get(prefix + '/actions/cache/usage')
    listing, _ = api.get(prefix + '/actions/caches?per_page=100&page=1')
    require(type(listing['total_count']) is int and 0 <= listing['total_count'] <= 1000,
            'Repository cache metadata exceeds bounded complete inventory')
    for page in range(2, (listing['total_count'] + 99) // 100 + 1):
        following, _ = api.get(prefix + '/actions/caches?per_page=100&page=' + str(page))
        require(following['total_count'] == listing['total_count'], 'Cache inventory changed during pagination')
        listing['actions_caches'].extend(following['actions_caches'])
    return {'clock': clock, 'cache': cache_capacity(policy, usage, listing)}


def stock_resources(path, environment=os.environ):
    selected = context(environment)
    require(platform.system() == 'Linux' and platform.machine() == 'x86_64', 'Native Linux AMD64 host required')
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    require(release.get('ID', '').strip('"') == 'ubuntu' and release.get('VERSION_ID', '').strip('"') == '26.04',
            'Wrong stock Linux release')
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    total_memory = int(memory['MemTotal'].split()[0]) * 1024
    free_memory = int(memory['MemAvailable'].split()[0]) * 1024
    disk = shutil.disk_usage(path)
    return {'context': selected, 'runnerLabel': 'ubuntu-26.04', 'architecture': 'x86_64',
            'cpus': os.cpu_count(), 'memoryBytes': total_memory, 'availableMemoryBytes': free_memory,
            'filesystemTotalBytes': disk.total, 'freeDiskBytes': disk.free,
            'observedPath': str(Path(path).resolve()), 'capturedMonotonic': time.monotonic()}


def admit(resources, service, *, state_bytes, state_ceiling_bytes, preparation_bytes=0):
    require(resources['cpus'] >= 4 and resources['memoryBytes'] >= 12 * GIB and
            resources['availableMemoryBytes'] >= 8 * GIB, 'Insufficient actual stock CPU/memory')
    require(type(state_bytes) is int and 0 <= state_bytes <= state_ceiling_bytes <= 64 * GIB and
            type(preparation_bytes) is int and preparation_bytes >= 0, 'Invalid phase growth/capture budget')
    required = state_ceiling_bytes - state_bytes + CHECKPOINT_BYTES + 8 * GIB + preparation_bytes
    require(resources['freeDiskBytes'] >= required, 'Actual phase/scratch/checkpoint capacity unavailable')
    require(service['cache']['headroomAdmitted'], 'Actual shared unpaid predecessor/successor cache headroom unavailable')
    remaining = service['clock']['remainingSeconds'] - (time.monotonic() - service['clock']['capturedMonotonic'])
    maximum = min(MAXIMUM_NATIVE_SECONDS, int(remaining - FINALIZE_SECONDS))
    require(maximum >= 60, 'Source service clock cannot retain capture/upload/finalization reserve')
    return {'maximumNativeSeconds': maximum, 'requiredScratchBytes': required,
            'stateCeilingBytes': state_ceiling_bytes, 'actualCacheReservation': False,
            'sourceServiceClockWitnessed': True, 'capacitySnapshotOnly': True,
            'noNativeProducerInvokedByAdmission': True, 'gateAComplete': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(mode=0o700, exist_ok=False)
    try:
        resources = stock_resources(output)
        (output / 'HOST.json').write_bytes(canonical(resources) + b'\n')
        api = GitHub(os.environ.get('CHECKTRAIL_GITHUB_JOB_TOKEN'), output)
        service = capture_service(api, resources['context'], configured_job_seconds=900)
        value = {'schemaVersion': 1, 'state': 'stock-capacity-observed-not-native-qualified',
                 'resources': resources, 'service': service, 'sourceOrCompilerInvoked': False,
                 'imagePulled': False, 'repositorySettingsChanged': False, 'gateAComplete': False}
        (output / 'CAPACITY.json').write_bytes(canonical(value) + b'\n')
        print(json.dumps({'observedFreeDiskBytes': resources['freeDiskBytes'],
                          'cacheHeadroomBytes': service['cache']['availableCacheBytes'],
                          'serviceSecondsRemaining': service['clock']['remainingSeconds'],
                          'sourceOrCompilerInvoked': False}))
    except BaseException as error:
        (output / 'FAILURE.json').write_bytes(canonical({'state': 'unavailable', 'error': str(error)[:1000],
                                                        'sourceOrCompilerInvoked': False, 'gateAComplete': False}) + b'\n')
        raise


if __name__ == '__main__':
    main()
