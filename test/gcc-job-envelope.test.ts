import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const api = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/gcc-job-envelope.mjs",
    ),
  ).href
);
const transport = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/gcc-github-job-clock.mjs",
    ),
  ).href
);
const context = {
  repository: "fixture-owner/fixture-repo",
  runId: "51",
  runAttempt: "2",
  jobName: "original-gcc-observation",
  headSha: "a".repeat(40),
};
const job = {
  id: 41,
  run_id: 51,
  run_url:
    "https://api.github.com/repos/fixture-owner/fixture-repo/actions/runs/51",
  name: context.jobName,
  head_sha: context.headSha,
  status: "in_progress",
  conclusion: null,
  started_at: "2026-01-01T00:00:00Z",
};
const bytes = (selected = job) =>
  Buffer.from(JSON.stringify({ total_count: 1, jobs: [selected] }));
const capture = () => ({
  context: { ...context },
  url: api.githubGccJobsUrl(context),
  httpStatus: 200,
  responseBytes: bytes(),
  responseComplete: true,
  observedResponseBytes: bytes().length,
  retainedResponseBytes: bytes().length,
  observedUnretainedBytes: 0,
  contentType: "application/json; charset=utf-8",
  contentEncoding: null,
  serviceDate: "Thu, 01 Jan 2026 00:02:01 GMT",
  requestStartedAt: "2026-01-01T00:02:01.000Z",
  receivedAt: "2026-01-01T00:02:01.100Z",
  requestElapsedMs: 100,
  carrierStartedAt: "2026-01-01T00:02:00.000Z",
  carrierElapsedMs: 1100,
});
function changedJob(change: Record<string, unknown>) {
  const value = capture();
  value.responseBytes = bytes({ ...job, ...change });
  value.observedResponseBytes = value.retainedResponseBytes =
    value.responseBytes.length;
  return value;
}

test("GCC job admission derives a conservative whole-job window and preserves every tail", () => {
  const value = api.admitGccJobEnvelope(capture());
  assert.equal(api.gccJobEnvelopePolicy.totalReservedSeconds, 48 * 60);
  assert.equal(value.observationSeconds, 18298);
  assert.equal(value.fullEightHourHostedCapacityVerified, false);
  assert.equal(value.originalProducerDefaultsOrBudgetChanged, false);
  assert.ok(
    Date.parse(value.cutoffAt) + 48 * 60000 <=
      Date.parse(value.wholeJobDeadlineAt),
  );
  assert.deepEqual(api.replayGccJobEnvelope(value, bytes()), value);
  assert.ok(value.observationSeconds < 330 * 60);
});

test("GCC slower preparation consumes the same job envelope rather than resetting its clock", () => {
  const fast = capture();
  const slow = {
    ...capture(),
    carrierStartedAt: "2026-01-01T00:10:00.000Z",
    requestStartedAt: "2026-01-01T00:10:01.000Z",
    receivedAt: "2026-01-01T00:10:01.100Z",
    serviceDate: "Thu, 01 Jan 2026 00:10:01 GMT",
  };
  assert.equal(
    api.admitGccJobEnvelope(fast).observationSeconds -
      api.admitGccJobEnvelope(slow).observationSeconds,
    8 * 60,
  );
});

test("GCC late admission and stale clock never call the original execution callback", async () => {
  const calls: unknown[] = [];
  const late = {
    ...capture(),
    carrierStartedAt: "2026-01-01T01:00:00.000Z",
    requestStartedAt: "2026-01-01T01:00:01.000Z",
    receivedAt: "2026-01-01T01:00:01.100Z",
    serviceDate: "Thu, 01 Jan 2026 01:00:01 GMT",
  };
  const stale = { ...capture(), serviceDate: "Thu, 01 Jan 2026 00:00:01 GMT" };
  for (const value of [late, stale]) {
    await assert.rejects(
      api.afterGccJobAdmission(
        async () => value,
        async (window: unknown) => {
          calls.push(window);
        },
      ),
      /Insufficient|Stale/u,
    );
  }
  assert.equal(calls.length, 0);
  await api.afterGccJobAdmission(
    async () => capture(),
    async (window: unknown) => {
      calls.push(window);
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], api.admitGccJobEnvelope(capture()));
});

test("GCC source-job identifiers are exact and singleton selection rejects adjacent jobs", () => {
  for (const change of [
    { name: "original-gcc-observation-extra" },
    { run_id: 52 },
    { head_sha: "b".repeat(40) },
    { status: "completed" },
    { conclusion: "success" },
    { run_url: job.run_url + "-adjacent" },
    { started_at: null },
  ]) {
    assert.throws(() => api.admitGccJobEnvelope(changedJob(change)));
  }
  const multiple = capture();
  multiple.responseBytes = Buffer.from(
    JSON.stringify({ total_count: 2, jobs: [job, { ...job, id: 42 }] }),
  );
  multiple.observedResponseBytes = multiple.retainedResponseBytes =
    multiple.responseBytes.length;
  assert.throws(() => api.admitGccJobEnvelope(multiple), /singleton/u);
});

test("GCC repository/decimal/hash context rejects traversal, suffixes and noncanonical values", () => {
  for (const change of [
    { repository: "../fixture-repo" },
    { repository: "fixture-owner/.." },
    { repository: "fixture-owner/fixture-repo/extra" },
    { runId: "51\n" },
    { runId: "051" },
    { runAttempt: "2-extra" },
    { headSha: context.headSha + "\n" },
    { jobName: "original-gcc-observation-extra" },
  ]) {
    assert.throws(() => api.githubGccJobsUrl({ ...context, ...change }));
  }
  assert.equal(
    api.githubGccJobsUrl(context),
    "https://api.github.com/repos/fixture-owner/fixture-repo/actions/runs/51/attempts/2/jobs?per_page=100",
  );
});

test("GCC service freshness and same-process clock mapping reject drift, bad dates and nonfinite clocks", () => {
  for (const change of [
    { serviceDate: "Thu, 01 Jan 2026 00:01:00 GMT" },
    { serviceDate: "Thu, 01 Jan 2026 00:03:00 GMT" },
    { serviceDate: "Fri, 01 Jan 2026 00:02:01 GMT" },
    { requestElapsedMs: Number.NaN },
    { requestElapsedMs: 16000 },
    { carrierElapsedMs: 10 },
    { receivedAt: "2026-01-01T00:02:10.100Z" },
    { carrierStartedAt: "2026-02-30T00:02:00.000Z" },
  ]) {
    assert.throws(() => api.admitGccJobEnvelope({ ...capture(), ...change }));
  }
});

test("GCC incomplete, encoded, duplicate-key and overflowing responses cannot become clock authority", () => {
  for (const change of [
    { httpStatus: 403 },
    { httpStatus: 302 },
    { responseComplete: false },
    { contentEncoding: "gzip" },
    { observedUnretainedBytes: 1 },
    { retainedResponseBytes: 1 },
    { contentType: "text/html" },
  ]) {
    assert.throws(() => api.admitGccJobEnvelope({ ...capture(), ...change }));
  }
  const value = capture();
  value.responseBytes = Buffer.from(
    '{"total_count":1,"total_count":1,"jobs":[]}',
  );
  value.observedResponseBytes = value.retainedResponseBytes =
    value.responseBytes.length;
  assert.throws(() => api.admitGccJobEnvelope(value), /Duplicate JSON/u);
});

test("GCC admitted context is a stable copy and replay rejects capacity or budget promotion", () => {
  const source = capture();
  const record = api.admitGccJobEnvelope(source);
  source.context.headSha = "b".repeat(40);
  assert.equal(record.context.headSha, "a".repeat(40));
  for (const change of [
    { observationSeconds: record.observationSeconds + 1 },
    { fullEightHourHostedCapacityVerified: true },
    { originalProducerDefaultsOrBudgetChanged: true },
  ]) {
    assert.throws(
      () => api.replayGccJobEnvelope({ ...record, ...change }, bytes()),
      /replay differs/u,
    );
  }
});

function fakeRequest(body: Buffer, status = 200, failure?: Error) {
  const state = {
    requests: 0,
    requestDestroyed: 0,
    responseDestroyed: 0,
    headers: {} as Record<string, string>,
  };
  const request = (
    _url: string,
    options: { headers: Record<string, string> },
    callback: (value: EventEmitter) => void,
  ) => {
    state.requests++;
    state.headers = options.headers;
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };
    req.destroy = () => {
      state.requestDestroyed++;
    };
    req.end = () =>
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), {
          statusCode: status,
          headers: {
            date: "Thu, 01 Jan 2026 00:02:01 GMT",
            "content-type": "application/json; charset=utf-8",
            authorization: "synthetic-response-header-must-not-be-copied",
          },
          destroy: () => {
            state.responseDestroyed++;
          },
        });
        callback(response);
        response.emit("data", body.subarray(0, 3));
        response.emit("data", body.subarray(3));
        if (failure) response.emit("error", failure);
        else response.emit("end");
      });
    return req;
  };
  return { state, request };
}
function fakeOptions(request: ReturnType<typeof fakeRequest>["request"]) {
  let sample = 0;
  const clocks = [1000, 1100, 1100];
  const utcClocks = ["2026-01-01T00:02:01.000Z", "2026-01-01T00:02:01.100Z"];
  return {
    request,
    token: "synthetic-not-a-real-token",
    carrierStartedAt: "2026-01-01T00:02:00.000Z",
    carrierMonotonicStarted: 0,
    monotonic: () => clocks[Math.min(sample++, 2)]!,
    utc: () => utcClocks.shift() ?? "2026-01-01T00:02:01.100Z",
  };
}

test("GCC fake transport retains all response bytes while omitting request/response authentication headers", async () => {
  const fake = fakeRequest(bytes());
  const raw = await transport.captureGithubGccJobClock(
    context,
    fakeOptions(fake.request),
  );
  assert.equal(fake.state.requests, 1);
  assert.equal(
    fake.state.headers.Authorization,
    "Bearer synthetic-not-a-real-token",
  );
  assert.equal(fake.state.headers["Accept-Encoding"], "identity");
  assert.equal(raw.observedResponseBytes, bytes().length);
  assert.deepEqual(raw.responseBytes, bytes());
  assert.equal(raw.responseComplete, true);
  assert.equal(raw.requestAuthenticationHeadersRetained, false);
  assert.ok(!JSON.stringify(raw).includes("synthetic-not-a-real-token"));
  assert.ok(
    !JSON.stringify(raw).includes(
      "synthetic-response-header-must-not-be-copied",
    ),
  );
  assert.ok(api.admitGccJobEnvelope(raw).observationSeconds > 270 * 60);
});

test("GCC denied and failed response prefixes are retained before admission and preserve original failure", async () => {
  const denied = fakeRequest(Buffer.from('{"message":"denied"}'), 403);
  const retained: Buffer[] = [];
  const raw = await transport.captureAndRetainGithubGccJobClock(
    context,
    fakeOptions(denied.request),
    async (value: { responseBytes: Buffer }) => {
      retained.push(value.responseBytes);
    },
  );
  assert.throws(() => api.admitGccJobEnvelope(raw), /return200/u);
  assert.deepEqual(retained, [Buffer.from('{"message":"denied"}')]);
  const primary = Object.assign(
    new Error("synthetic primary response failure"),
    { retentionFailure: undefined as string | undefined },
  );
  let failedPrefixRetained = 0;
  const failed = fakeRequest(Buffer.from("original-prefix"), 200, primary);
  await assert.rejects(
    transport.captureAndRetainGithubGccJobClock(
      context,
      fakeOptions(failed.request),
      async (value: { responseBytes: Buffer }) => {
        assert.deepEqual(value.responseBytes, Buffer.from("original-prefix"));
        failedPrefixRetained++;
        throw new Error("synthetic secondary retention failure");
      },
    ),
    /primary response failure/u,
  );
  assert.equal(
    failedPrefixRetained,
    1,
    "The actual failed prefix callback must run exactly once",
  );
  assert.match(
    primary.retentionFailure ?? "",
    /synthetic secondary retention failure/u,
  );
  assert.equal(failed.state.requestDestroyed, 1);
  assert.equal(failed.state.responseDestroyed, 1);
});

test("GCC response cap records bounded retained prefix and actual application-observed unretained bytes", async () => {
  const body = Buffer.alloc(
    api.gccJobEnvelopePolicy.maximumResponseBytes + 1,
    0x61,
  );
  const fake = fakeRequest(body);
  const retained: unknown[] = [];
  await assert.rejects(
    transport.captureAndRetainGithubGccJobClock(
      context,
      fakeOptions(fake.request),
      async (value: {
        responseBytes: Buffer;
        observedResponseBytes: number;
        observedUnretainedBytes: number;
        responseComplete: boolean;
      }) => {
        assert.equal(
          value.responseBytes.length,
          api.gccJobEnvelopePolicy.maximumResponseBytes,
        );
        assert.equal(value.observedResponseBytes, body.length);
        assert.equal(value.observedUnretainedBytes, 1);
        assert.equal(value.responseComplete, false);
        retained.push(value);
      },
    ),
    /response byte cap/u,
  );
  assert.equal(fake.state.requests, 1);
  assert.equal(retained.length, 1);
});

test("GCC GitHub environment selection refuses missing or adjacent operator context", () => {
  const environment = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    GITHUB_REPOSITORY: context.repository,
    GITHUB_RUN_ID: context.runId,
    GITHUB_RUN_ATTEMPT: context.runAttempt,
    GITHUB_JOB: context.jobName,
    GITHUB_SHA: context.headSha,
  };
  assert.deepEqual(
    transport.githubGccContextFromEnvironment(environment),
    context,
  );
  for (const change of [
    { RUNNER_ARCH: "ARM64" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_ACTIONS: "false" },
  ]) {
    assert.throws(() =>
      transport.githubGccContextFromEnvironment({ ...environment, ...change }),
    );
  }
});

test("GCC useful-window boundary admits the exact minimum and refuses one second less", () => {
  const exact = {
    ...capture(),
    carrierStartedAt: "2026-01-01T00:36:58.000Z",
    requestStartedAt: "2026-01-01T00:36:58.000Z",
    receivedAt: "2026-01-01T00:36:58.000Z",
    serviceDate: "Thu, 01 Jan 2026 00:36:58 GMT",
    requestElapsedMs: 0,
    carrierElapsedMs: 0,
  };
  assert.equal(api.admitGccJobEnvelope(exact).observationSeconds, 270 * 60);
  const late = {
    ...exact,
    carrierStartedAt: "2026-01-01T00:36:59.000Z",
    requestStartedAt: "2026-01-01T00:36:59.000Z",
    receivedAt: "2026-01-01T00:36:59.000Z",
    serviceDate: "Thu, 01 Jan 2026 00:36:59 GMT",
  };
  assert.throws(() => api.admitGccJobEnvelope(late), /Insufficient remaining/u);
});

test("GCC global request deadline retains an empty failed prefix and destroys only its request", async () => {
  let destroyed = 0,
    requests = 0,
    cleared = 0;
  const request = () => {
    requests++;
    return Object.assign(new EventEmitter(), {
      end: () => {},
      destroy: () => {
        destroyed++;
      },
    });
  };
  const token = Symbol("synthetic-timer");
  const retained: unknown[] = [];
  await assert.rejects(
    transport.captureAndRetainGithubGccJobClock(
      context,
      {
        ...fakeOptions(request as ReturnType<typeof fakeRequest>["request"]),
        startTimer: (callback: () => void) => {
          queueMicrotask(callback);
          return token;
        },
        stopTimer: (received: unknown) => {
          assert.equal(received, token);
          cleared++;
        },
      },
      async (value: {
        responseBytes: Buffer;
        responseComplete: boolean;
        httpStatus: unknown;
      }) => {
        assert.equal(value.responseBytes.length, 0);
        assert.equal(value.responseComplete, false);
        assert.equal(value.httpStatus, null);
        retained.push(value);
      },
    ),
    /global request deadline/u,
  );
  assert.deepEqual(
    [requests, destroyed, cleared, retained.length],
    [1, 1, 1, 1],
  );
});

// The carrier's own setup/admission time cannot be borrowed from useful producer time.
test("GCC in-carrier preparation consumes the useful original execution window", async () => {
  const late = {
    ...capture(),
    requestStartedAt: "2026-01-01T00:50:00.000Z",
    receivedAt: "2026-01-01T00:50:00.100Z",
    serviceDate: "Thu, 01 Jan 2026 00:50:00 GMT",
    carrierElapsedMs: 48 * 60000 + 100,
  };
  let executed = false;
  await assert.rejects(
    api.afterGccJobAdmission(
      async () => late,
      async () => {
        executed = true;
      },
    ),
    /Insufficient/u,
  );
  assert.equal(executed, false);
});

test("GCC physical response retention time is subtracted immediately before original execution", () => {
  const admitted = api.admitGccJobEnvelope(capture());
  const start = 20;
  assert.equal(
    api.remainingGccObservationMs(admitted, start, start + 1100),
    admitted.observationSeconds * 1000 - 1100,
  );
  assert.throws(
    () => api.remainingGccObservationMs(admitted, start, start + 40 * 60000),
    /Insufficient useful/u,
  );
  assert.throws(
    () => api.remainingGccObservationMs(admitted, start, start + 1000),
    /monotonic admission/u,
  );
});

test("GCC independent Python replay binds the actual raw response, clock capture and unchanged capacity flags", (t) => {
  const python = ["python3", "python"].find((name) => {
    const result = spawnSync(
      name,
      ["-I", "-S", "-B", "-c", "import sys; print(sys.version_info.major)"],
      { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
    );
    return (
      result.status === 0 &&
      result.signal === null &&
      result.stdout.trim() === "3"
    );
  });
  if (!python) {
    t.skip("Python3 independent data replay unavailable");
    return;
  }
  const observed = capture();
  const record = api.admitGccJobEnvelope(observed);
  const { responseBytes, ...metadata } = observed;
  const sourceCapture = {
    ...metadata,
    requestId: "synthetic-request",
    unreadResponseRemainderMagnitudeKnown: true,
    requestAuthenticationHeadersRetained: false,
    response: { bytes: responseBytes.length, sha256: record.response.sha256 },
  };
  const program = `import sys,json,base64,importlib.util,copy
spec=importlib.util.spec_from_file_location('trusted_replay',sys.argv[1]);r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
x=json.load(sys.stdin);raw=base64.b64decode(x['raw']);record=x['record'];capture=x['capture'];encoded=lambda v:json.dumps(v,separators=(',',':')).encode()
assert r.gcc_job_envelope(record,raw,encoded(capture))==18298
count=0
for kind in ['capacity','budget','window','clock','source','response','capture']:
 v=copy.deepcopy(record);c=copy.deepcopy(capture);b=raw
 if kind=='capacity':v['fullEightHourHostedCapacityVerified']=True
 elif kind=='budget':v['originalProducerDefaultsOrBudgetChanged']=True
 elif kind=='window':v['observationSeconds']+=1
 elif kind=='clock':v['response']['serviceDate']='Thu, 01 Jan 2026 00:00:00 GMT'
 elif kind=='source':v['context']['headSha']='b'*40
 elif kind=='response':b+=b' '
 elif kind=='capture':c['requestAuthenticationHeadersRetained']=True
 try:r.gcc_job_envelope(v,b,encoded(c))
 except (ValueError,AssertionError):count+=1
 else:raise AssertionError('Independent replay admitted '+kind)
print(json.dumps({'valid':1,'rejected':count,'nativeOrNetworkExecuted':False}))`;
  const result = spawnSync(
    python,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      program,
      path.join(
        repository,
        "scripts/producer-qualification/c-producer-replay-evidence.py",
      ),
    ],
    {
      input: JSON.stringify({
        raw: responseBytes.toString("base64"),
        record,
        capture: sourceCapture,
      }),
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: 1,
    rejected: 7,
    nativeOrNetworkExecuted: false,
  });
});
