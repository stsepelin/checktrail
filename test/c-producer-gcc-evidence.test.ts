import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isBuiltin } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import ts from "typescript";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const carrier = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-carrier-observation.mjs",
    ),
  ).href
);
const wrapper = await import(
  pathToFileURL(path.join(repository, "scripts/observe-c-producer-carrier.mjs"))
    .href
);
const producer = await import(
  pathToFileURL(path.join(repository, "scripts/qualify-c-producer.mjs")).href
);
const observation = await import(
  pathToFileURL(
    path.join(repository, "scripts/verify-c-producer-observation.mjs"),
  ).href
);
const profiles = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-profile.mjs",
    ),
  ).href
);
const catalog = JSON.parse(
  await readFile(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-profiles.v1.json",
    ),
    "utf8",
  ),
);
const profile = catalog.profiles["gcc-12"];
const catalogSha256 =
  "3e22395e92f732e1b30cf972c6f6d660f5e499562038ed31a342b018f8d481bd";
const attempt = "12345678-1234-4234-8234-123456789012";
const posixFamilyControl = {
  skip:
    process.platform === "win32"
      ? "POSIX owned process-group controls unavailable"
      : false,
};
const schemaCarrier = () => ({
  schemaVersion: 1,
  selectedProfile: {
    name: "gcc-12",
    profile: profile.profile,
    sourceVersion: profile.sourceVersion,
    catalogSha256,
  },
  originalCommandDeadlineSeconds: 43200,
  carrierLimits: { ...carrier.gccCarrierLimits },
  state: "original-controller-terminal-observed",
  stopCause: null,
  controllerObserver: {
    exitCode: 2,
    signal: null,
    error: null,
    reason: null,
    retainedBytes: 1,
    stopError: null,
  },
  log: { bytes: 1, sha256: "1".repeat(64) },
  ownerAttempt: attempt,
  cleanup: {
    producer: { state: "absent", id: "checktrail-producer-" + attempt },
    retention: { state: "absent", id: "checktrail-retention-" + attempt },
  },
  controllerTerminalSeconds: 1,
  elapsedSeconds: 2,
  cleanupStartedSeconds: 1,
  cleanupDeadlineSeconds: 601,
  stopObservation: {
    ownerAdmissionError: null,
    childTerminalObserved: true,
    childReaped: true,
    softFamilyAbsent: true,
    familyAbsent: true,
    processGroupId: 1001,
  },
  startedAt: "2026-01-01T00:00:00.000Z",
  cutoffAt: "2026-01-01T04:05:00.000Z",
  originalProducerDefaultsOrBudgetChanged: false,
  fullEightHourHostedCapacityVerified: false,
  originalCommandCompletionClaimed: false,
  fullCompilerSdkBootstrapClosureVerified: false,
  completeOriginalNoticeClosureVerified: false,
  historicalPublisherConsumptionVerified: false,
  gateAComplete: false,
});

test("GCC external carrier schema retains the selected twelve-hour operator wall deadline and refuses cutoff, stale and weakly typed terminals", () => {
  assert.equal(
    carrier.validateGccCarrierReceipt(schemaCarrier(), profile, catalogSha256)
      .gateAComplete,
    false,
  );
  for (const edit of [
    (v: ReturnType<typeof schemaCarrier>) => {
      v.originalCommandDeadlineSeconds = 14700;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.originalCommandDeadlineSeconds = 28800;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.originalCommandDeadlineSeconds = 43199;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.originalCommandDeadlineSeconds = 43201;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      Object.assign(v, { originalCommandDeadlineSeconds: true });
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      Object.assign(v, { stopCause: "external-carrier-cutoff" });
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      Object.assign(v.controllerObserver, { signal: "SIGTERM" });
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.controllerObserver.exitCode = 0;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.controllerObserver.retainedBytes = 0;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.selectedProfile.name = "glibc";
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.cleanup.retention.state = "unavailable";
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.controllerTerminalSeconds = 14701;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.fullEightHourHostedCapacityVerified = true;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.cleanupDeadlineSeconds = 602;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.cleanupStartedSeconds = 3;
      v.cleanupDeadlineSeconds = 603;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.startedAt = "2026-01-01T00:00:00Z";
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      v.stopObservation.familyAbsent = false;
    },
    (v: ReturnType<typeof schemaCarrier>) => {
      Object.assign(v.stopObservation, { processGroupId: true });
    },
  ]) {
    const bad = schemaCarrier();
    edit(bad);
    assert.throws(() =>
      carrier.validateGccCarrierReceipt(bad, profile, catalogSha256),
    );
  }
  for (const value of ["gcc", "gcc-12-extra", "GLIBC", ""])
    assert.throws(() => carrier.requireCObservationProfile(value));
});

test("GCC carrier stop and cleanup replay one original deadline and preserve a failed result without restarting work", async () => {
  let calls = 0;
  const originalError = new Error("synthetic retained cleanup failure");
  const deadlines: number[] = [];
  const once = wrapper.onceCarrierStop(async () => {
    calls++;
    deadlines.push(performance.now() + 600000);
    throw originalError;
  });
  const first = once(),
    second = once();
  await Promise.allSettled([first, second]);
  assert.equal(first, second);
  for (const pending of [first, second, once()])
    await assert.rejects(pending, (error: unknown) => error === originalError);
  assert.equal(calls, 1);
  assert.equal(deadlines.length, 1);
});

test("GCC carrier waits on actual bounded child terminals and rejects missing operator authority before execution", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>process.exit(2),60)"],
    { stdio: "ignore" },
  );
  const terminal = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  try {
    assert.equal(
      await wrapper.waitCarrierChild(new Promise(() => {}), 1),
      false,
    );
    assert.equal(await wrapper.waitCarrierChild(terminal, 3000), true);
    assert.equal(child.exitCode, 2);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await terminal;
    }
  }
  await assert.rejects(
    wrapper.mainCProducerCarrier(["--profile", "gcc-12"]),
    /Usage/u,
  );
});

test(
  "GCC carrier soft cutoff signals an actual armed child and still cleans when initial owner admission fails",
  posixFamilyControl,
  async () => {
    const { child, family } = wrapper.spawnCarrierNode([
      "-e",
      'process.on("SIGTERM",()=>process.exit(2));process.stdout.write("ready\\n");setInterval(()=>{},1000)',
    ]);
    const terminal = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    let cleaned = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      const observed = await wrapper.stopCarrierChild(
        child,
        terminal,
        async () => {
          throw new Error("synthetic initial owner unavailable");
        },
        async () => {
          cleaned++;
        },
        { softStopMs: 3000, deadline: performance.now() + 15000, family },
      );
      assert.equal(observed.childTerminalObserved, true);
      assert.equal(observed.childReaped, true);
      assert.match(
        observed.ownerAdmissionError,
        /synthetic initial owner unavailable/u,
      );
      assert.equal(child.exitCode, 2);
      assert.equal(cleaned, 1);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await terminal;
      }
    }
  },
);

test(
  "GCC carrier kills and reaps an actual ignoring child before cleanup after its soft grace expires",
  posixFamilyControl,
  async () => {
    const { child, family } = wrapper.spawnCarrierNode([
      "-e",
      'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)',
    ]);
    const terminal = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    let cleaned = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      const observed = await wrapper.stopCarrierChild(
        child,
        terminal,
        async () => {},
        async () => {
          assert.equal(child.signalCode, "SIGKILL");
          cleaned++;
        },
        { softStopMs: 30, deadline: performance.now() + 15000, family },
      );
      assert.equal(observed.softFamilyAbsent, false);
      assert.equal(observed.childReaped, true);
      assert.equal(cleaned, 1);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await terminal;
      }
    }
  },
);

test(
  "GCC carrier cleanup failure retains its actual stopped-child and owner-admission diagnostics",
  posixFamilyControl,
  async () => {
    for (const injectPending of [false, true]) {
      const { child, family } = wrapper.spawnCarrierNode([
        "-e",
        'process.on("SIGTERM",()=>process.exit(2));process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ]);
      const terminal = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      const originalKill = process.kill;
      let termSent = false,
        injected = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve());
          child.once("error", reject);
        });
        if (injectPending)
          process.kill = (pid, signal) => {
            if (pid === -child.pid) {
              if (signal === 0 && termSent && injected === 0) {
                injected++;
                throw Object.assign(
                  new Error("synthetic cleanup pending existence probe"),
                  { code: "EPERM" },
                );
              }
              if (signal === "SIGTERM") termSent = true;
            }
            return originalKill(pid, signal);
          };
        await assert.rejects(
          wrapper.stopCarrierChild(
            child,
            terminal,
            async () => {
              throw new Error("synthetic owner refusal");
            },
            async () => {
              throw new Error("synthetic cleanup refusal");
            },
            { softStopMs: 3000, deadline: performance.now() + 15000, family },
          ),
          (error: unknown) => {
            assert.ok(error instanceof Error && error.cause instanceof Error);
            assert.equal(error.cause.message, "synthetic cleanup refusal");
            assert.ok("stopObservation" in error);
            const { pendingGroupProbes, ...stopped } =
              error.stopObservation as Record<string, unknown>;
            assert.deepEqual(stopped, {
              ownerAdmissionError: "Error: synthetic owner refusal",
              childTerminalObserved: true,
              childReaped: true,
              softFamilyAbsent: true,
              familyAbsent: true,
              processGroupId: child.pid,
            });
            if (pendingGroupProbes !== undefined) {
              assert.ok(
                pendingGroupProbes !== null &&
                  typeof pendingGroupProbes === "object",
              );
              const pending = pendingGroupProbes as { count: number };
              assert.ok(
                Number.isSafeInteger(pending.count) &&
                  pending.count >= 1 &&
                  pending.count <= 20000,
              );
              assert.deepEqual(pending, {
                operation: "signal-zero",
                code: "EPERM",
                count: pending.count,
                absenceInferred: false,
                signallingAuthorized: false,
              });
            }
            if (injectPending) {
              assert.equal(injected, 1);
              assert.notEqual(pendingGroupProbes, undefined);
            }
            assert.equal(child.exitCode, 2);
            return true;
          },
        );
      } finally {
        process.kill = originalKill;
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await terminal;
        assert.equal(wrapper.carrierFamilyAbsent(family), true);
      }
    }
  },
);

test(
  "GCC carrier quiesces an armed ignoring grandchild before owned cleanup and preserves one absolute reserve",
  posixFamilyControl,
  async () => {
    const grandchild =
      'process.on("SIGTERM",()=>{});process.stdout.write("armed\\n");setInterval(()=>{},1000)';
    const program = `const{spawn}=require("node:child_process");process.on("SIGTERM",()=>process.exit(2));const c=spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:["ignore","pipe","ignore"]});c.stdout.once("data",()=>process.stdout.write(JSON.stringify({grandchild:c.pid})+"\\n"));setInterval(()=>{},1000);`;
    const { child, family } = wrapper.spawnCarrierNode(["-e", program]);
    const terminal = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    let grandchildPid: number | undefined;
    let cleaned = 0;
    const deadline = performance.now() + 15000;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", (raw: Buffer) => {
          grandchildPid = JSON.parse(raw.toString()).grandchild;
          resolve();
        });
        child.once("error", reject);
      });
      assert.ok(Number.isSafeInteger(grandchildPid));
      process.kill(grandchildPid!, 0);
      const observed = await wrapper.stopCarrierChild(
        child,
        terminal,
        async () => {},
        async (actualDeadline: number) => {
          assert.equal(actualDeadline, deadline);
          assert.equal(
            wrapper.carrierFamilyAbsent(family),
            true,
            "Grandchild process group must be absent before cleanup",
          );
          assert.throws(() => process.kill(grandchildPid!, 0), {
            code: "ESRCH",
          });
          cleaned++;
        },
        { softStopMs: 30, deadline, family },
      );
      assert.equal(observed.softFamilyAbsent, false);
      assert.equal(observed.childReaped, true);
      assert.equal(observed.familyAbsent, true);
      assert.equal(cleaned, 1);
    } finally {
      if (!wrapper.carrierFamilyAbsent(family)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          assert.ok(
            error instanceof Error && "code" in error && error.code === "ESRCH",
          );
        }
      }
      await terminal;
      const cleanupUntil = performance.now() + 3000;
      while (
        !wrapper.carrierFamilyAbsent(family) &&
        performance.now() < cleanupUntil
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        wrapper.carrierFamilyAbsent(family),
        true,
        "Synthetic owned grandchild group survived final cleanup",
      );
    }
  },
);

test(
  "GCC carrier refuses an expired reserve without restarting cleanup and stops only its actual owned group",
  posixFamilyControl,
  async () => {
    const { child, family } = wrapper.spawnCarrierNode([
      "-e",
      'process.on("SIGTERM",()=>{});process.stdout.write("armed\\n");setInterval(()=>{},1000)',
    ]);
    const terminal = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    let admitted = 0,
      cleaned = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      await assert.rejects(
        wrapper.stopCarrierChild(
          child,
          terminal,
          async () => {
            admitted++;
          },
          async () => {
            cleaned++;
          },
          { softStopMs: 30, deadline: performance.now() - 1, family },
        ),
        /deadline exhausted before observation/u,
      );
      await terminal;
      assert.equal(child.signalCode, "SIGKILL");
      assert.equal(wrapper.carrierFamilyAbsent(family), true);
      assert.equal(admitted, 0);
      assert.equal(cleaned, 0);
    } finally {
      if (!wrapper.carrierFamilyAbsent(family)) {
        process.kill(-child.pid, "SIGKILL");
        await terminal;
      }
    }
  },
);

test("GCC observation source frames bind every actual static carrier/helper import without executing project code", async () => {
  const bound = new Set<string>(observation.cObservationSources);
  for (const file of bound) {
    if (!file.endsWith(".mjs")) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(path.join(repository, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of source.statements) {
      if (
        !(
          ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (isBuiltin(specifier)) continue;
      assert.ok(
        specifier.startsWith("."),
        "Unbound non-builtin observation dependency: " + specifier,
      );
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      );
      assert.ok(
        bound.has(target),
        "Observation source frame omits actual static helper: " +
          file +
          " -> " +
          target,
      );
    }
  }
});

test("GCC carrier owner admission binds the exact caller, UUID, selected source and original profile", () => {
  const caller = { uid: 1001, gid: 1001 };
  const plan = {
    profile,
    catalogSha256,
    sources: [{ file: "synthetic.mjs", bytes: 1, sha256: "1".repeat(64) }],
    harness: [],
  };
  const owner = {
    profile: profile.profile,
    sourceVersion: profile.sourceVersion,
    catalogSha256,
    limits: profile.limits,
    sourcePins: plan.sources,
    harnessPins: [],
    host: { capturedCaller: caller },
    attempt,
  };
  assert.equal(wrapper.validateCarrierOwner(owner, plan, caller), attempt);
  for (const edit of [
    (v: typeof owner) => {
      v.host.capturedCaller.uid = 0;
    },
    (v: typeof owner) => {
      v.profile = "original-debian-glibc-2.36-9+deb12u14-build-v1";
    },
    (v: typeof owner) => {
      v.sourcePins = [];
    },
    (v: typeof owner) => {
      v.attempt = "12345678-1234-1234-8234-123456789012";
    },
  ]) {
    const bad = structuredClone(owner);
    edit(bad);
    assert.throws(() => wrapper.validateCarrierOwner(bad, plan, caller));
  }
});

test("GCC workflow has a narrow operator namespace, read-only capacity checks and an independent cutoff without altering the profile", async () => {
  const workflow = parse(
    await readFile(
      path.join(repository, ".github/workflows/upstream-gcc.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on.push.branches, ["pr/upstream-producer/gcc-*"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const job = workflow.jobs["original-gcc-observation"];
  const steps = job.steps as {
    name?: string;
    run?: string;
    if?: string;
    "timeout-minutes": number;
  }[];
  // Individual maxima cannot be added: the fresh whole-job gate subtracts elapsed preparation.
  assert.equal(job["timeout-minutes"], 355);
  assert.equal(workflow.permissions.actions, "read");
  assert.ok(steps.every((step) => step["timeout-minutes"] <= 355));
  const preparation = steps.find((step) =>
    step.name?.includes("without compilation"),
  )!.run!;
  assert.ok(preparation.includes('test "$gcc_free" -ge "$gcc_needed"'));
  assert.ok(!/sudo|rm -rf/u.test(preparation));
  const observation = steps.find((step) =>
    step.name?.includes("selected twelve-hour"),
  )!;
  assert.ok(
    observation.run!.includes(
      "scripts/observe-c-producer-carrier.mjs --profile gcc-12",
    ),
  );
  assert.ok(
    observation["timeout-minutes"] * 60 >=
      carrier.gccCarrierLimits.observationSeconds +
        carrier.gccCarrierLimits.cleanupSeconds,
  );
  assert.equal(observation["timeout-minutes"], 345);
  assert.ok(observation.run!.includes("--github-job-envelope"));
  assert.deepEqual((observation as { env?: Record<string, string> }).env, {
    CHECKTRAIL_GITHUB_JOB_TOKEN: "${{ github.token }}",
  });
  assert.equal(profile.limits.deadlineSeconds, 43200);
  assert.equal(profile.files.length, 241);
  for (const step of steps.filter((step) =>
    /export-evidence|replay-evidence/u.test(step.run ?? ""),
  )) {
    assert.equal(step.if, "always()");
    assert.ok(step.run!.includes("--profile gcc-12"));
  }
});

const diagnostic = (r: SpawnSyncReturns<string>) =>
  [
    r.error?.message,
    `status=${String(r.status)} signal=${String(r.signal)}`,
    r.stdout,
    r.stderr,
  ]
    .filter(Boolean)
    .join("\n");
const unavailable: string[] = [];
const python = ["python3", "python"].find((name) => {
  const r = spawnSync(
    name,
    ["-I", "-S", "-B", "-c", "import sys; print(sys.version_info.major)"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  if (
    !r.error &&
    r.status === 0 &&
    r.signal === null &&
    r.stdout.trim() === "3"
  )
    return true;
  unavailable.push(name + ": " + diagnostic(r));
  return false;
});

test(
  "GCC synthetic protocol ZIP physically exports and replays selected source/report bytes without claiming native qualification",
  {
    skip:
      process.platform === "win32"
        ? "POSIX synthetic report-custody component unavailable"
        : python
          ? false
          : "Verified Python3 protocol fixture unavailable: " +
            unavailable.join("; "),
  },
  async (t) => {
    const directory = await realpath(await fixture(t, {}));
    const selectedSources: string[] = producer.cProducerSourceFiles(profile);
    const localPolicy = await profiles.loadCProducerExecutionPolicy(
      "local-gcc12-23h-v1",
      profile,
    );
    const localBinding = profiles.cProducerExecutionPolicyBinding(
      localPolicy,
      profile,
    );
    const program = String.raw`
import ast,base64,copy,datetime,hashlib,importlib.util,json,os,pathlib,shutil,subprocess,sys,time,zipfile
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);selected_sources=json.loads(sys.argv[3]);local_binding=json.loads(sys.argv[4])
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
exporter=module('gcc_fixture_export',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
r=module('gcc_fixture_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
collector=module('gcc_fixture_collect',repo/'scripts/producer-qualification/c-producer-test-reports.py')
catalog=json.loads((repo/'scripts/producer-qualification/c-producer-profiles.v1.json').read_bytes());profile=catalog['profiles']['gcc-12'];catalog_sha=r.CATALOG_SHA256
caller={'uid':os.getuid(),'gid':os.getgid()};assert caller['uid']>0
env=dict(os.environ);env.update(SKIP_CODEX_REVIEW='1',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
git=['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false','-c','commit.gpgsign=false']
history=repo/'test/fixtures/c-controller-history';provenance=json.loads((history/'provenance.json').read_bytes())
legacy_collector_meta=json.loads((history/'report-collector-provenance.json').read_bytes());assert legacy_collector_meta['file']=='schema2-report-collector.py.txt' and legacy_collector_meta['license']['file']=='LICENSE-schema2.txt'
legacy_collector_body=(history/legacy_collector_meta['file']).read_bytes()
assert r.pin(legacy_collector_body)=={key:legacy_collector_meta[key]for key in ['bytes','sha256']}=={'bytes':18397,'sha256':'9dee7066707382c33ba971fe63ded57c407454c81ed38ab30aa66b95b558691c'} and legacy_collector_meta['originalCommit']=='d05fc53fa83e519cab9692c662288c50f67fb11b' and legacy_collector_meta['originalPath']=='scripts/producer-qualification/c-producer-test-reports.py'
assert r.pin((history/legacy_collector_meta['license']['file']).read_bytes())=={key:legacy_collector_meta['license'][key]for key in ['bytes','sha256']}
current_selected_sources=list(selected_sources);legacy_selected_sources=[name for name in selected_sources if name not in [file.rsplit('/',1)[-1]for file in r.REPORT_CODEC_FILES]]
def source_tree(name,epoch,legacy_collector=None):
 if legacy_collector is None:legacy_collector=epoch in [1,2]
 files=[file for file in exporter.SOURCE_FILES if not legacy_collector or file not in r.REPORT_CODEC_FILES]
 reviewed=root/name;reviewed.mkdir()
 for file in files+[exporter.LOCAL_POLICY_SOURCE]:
  target=reviewed/file;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(repo/file,target)
 if legacy_collector:(reviewed/'scripts/producer-qualification/c-producer-test-reports.py').write_bytes(legacy_collector_body)
 if epoch in [1,2]:
  original=next(row for row in provenance['fixtures'] if row['schemaVersion']==epoch)
  body=(history/original['file']).read_bytes();assert r.pin(body)=={'bytes':original['bytes'],'sha256':original['sha256']}
  # Inert original first-party implementation data, never imported/executed.
  (reviewed/'scripts/qualify-c-producer.mjs').write_bytes(body)
 for args in [['init','--quiet'],['add','--',*files,exporter.LOCAL_POLICY_SOURCE],['-c','user.name=Synthetic Protocol','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','Synthetic operator frame']]:
  process=subprocess.run(git+args,cwd=reviewed,env=env,capture_output=True,timeout=10);assert process.returncode==0,process.stderr
 head=subprocess.check_output(git+['rev-parse','HEAD'],cwd=reviewed,env=env).decode().strip()
 pins=[{'file':file,**r.pin((reviewed/file).read_bytes())} for file in files]
 return reviewed,head,pins
reviewed,head,source_pins=source_tree('operator-source-schema1',1)
reviewed2,head2,source_pins2=source_tree('operator-source-schema2',2)
reviewed3,head3,source_pins3=source_tree('operator-source-schema3',3)
reviewed_mixed,head_mixed,source_pins_mixed=source_tree('invalid-old-controller-new-collector',2,False)
def legacy_collect(profile_name,source,destination,caller):
 # Execute only the current collector against synthetic data. Convert its fully
 # verified small files to the historical raw layout; historical code stays data.
 collector.collect(profile_name,source,destination,caller);value=json.loads(destination.read_bytes());retained=destination.parent/'original-test-reports';files=[];directories={'.'}
 def owner(path,mode):
  info=path.stat();return {'uid':info.st_uid,'gid':info.st_gid,'mode':mode,'producerDevice':str(info.st_dev),'producerInode':str(info.st_ino)}
 for report in value['reports']:
  for row in [report]+([report['log']]if 'log'in report else[]):
   assert row['bytes']<=4096
   raw=b''.join(collector.report_codec().iter_report_bytes(row,lambda name,maximum:(retained/name).read_bytes()));assert raw==(source/row['file']).read_bytes();row.pop('chunks');target=retained/row['file'];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw);target.chmod(0o600);parts=row['file'].split('/');directories.update('/'.join(parts[:n])for n in range(1,len(parts)));files.append(row['file'])
 shutil.rmtree(retained/'encoded');value['schemaVersion']=2 if profile_name=='gcc-12'else 1;value.pop('encoding');value.pop('storedBytes');value['exportCustody']['files']=[{'file':name,'ownership':owner(retained/name,0o600)}for name in files];value['exportCustody']['directories']=[]
 for name in sorted(directories):
  path=retained/name;path.chmod(0o700);value['exportCustody']['directories'].append({'directory':name,'ownership':owner(path,0o700)})
 write(destination,value)
selected_sources=legacy_selected_sources
archive_sources={}
def replay_fixture(archive,selected_source,*args):
 return r.replay(archive,archive_sources.get(archive,selected_source),*args)

def write(file,value):
 file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes((json.dumps(value)+'\n').encode());file.chmod(0o600);return r.pin(file.read_bytes())
source_pins=[{'file':name,**r.pin((reviewed/name).read_bytes())} for name in exporter.report_source_files(reviewed)]
selected={'name':'gcc-12','profile':profile['profile'],'sourceVersion':profile['sourceVersion'],'catalogSha256':catalog_sha}
# Native host/root observation fields below are SYNTHETIC SCHEMA DATA.
# Actual exported bytes, owner/modes, ZIP hashes and Git objects are generated.
# This fixture never qualifies a native Linux/root-container producer run.
startup={'schemaVersion':1,'state':'operator-source-and-caller-frame','gitHead':head,'selectedProfile':selected,'caller':caller,'host':{'platform':'linux','architecture':'x64','kernelMachine':'x86_64'},'sourcePins':source_pins,'sourceOrCompilerExecuted':False,'hardwareHostAttestationPerformed':False,'gateAComplete':False}
startup_file=root/'startup.json';startup_pin=write(startup_file,startup)
inputs=root/'inputs';common=root/'common';result=root/'result';work=result/'work';carrier=root/'carrier';work.mkdir(parents=True);carrier.mkdir()
write(inputs/'receipt.json',{'state':'complete-pinned-input-bundle','profile':profile['profile'],'catalogSha256':catalog_sha,'acquired':[{k:row[k] for k in ['file','bytes','sha256']} for row in profile['files']],'buildExecuted':False,'inputAuthenticationAndFreshnessDisabled':False,'fullCompilerSdkBootstrapClosureVerified':False,'completeOriginalNoticeClosureVerified':False,'gateAComplete':False})
prepared={'complete':True,'releaseSignatures':[{}, {}, {}],'sourceSignatureVerified':True,'allSourceArchivesBoundBySignedDescriptor':True,'sourceSignatureFaultControl':{'changedExitCode':1,'restoredExitCode':0},'releaseSignatureFaultControl':{'changedExitCode':1,'restoredExitCode':0},'compilerExecuted':False,'packageInstalled':False}
write(common/'transform/preparation.json',prepared);(common/'transform.log').write_bytes(b'Synthetic data-preparation protocol\n')
write(common/'receipt.json',{'state':'complete-original-input-bundle','completeInputBundleReacquisitionVerified':True,'physicalPinnedInputs':350,'compilationExecuted':False,'originalPackageBuildExecuted':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False,'inferenceInvoked':False,'fieldEvaluationExecuted':False,'cleanup':{'state':'absent'},'preparation':prepared})
source=root/'generated';(source/'build/gcc/testsuite').mkdir(parents=True);(source/'build/gcc/testsuite/gcc.sum').write_bytes(b'PASS: synthetic GCC check\nFAIL: preserved upstream outcome\n')
(source/'build/gcc/testsuite/gcc.log').write_bytes(b'Synthetic physical GCC log\n')
(source/'build-cross/gcc/testsuite').mkdir(parents=True);(source/'build-cross/gcc/testsuite/cross.sum').write_bytes(b'XFAIL: synthetic cross check\nUNSUPPORTED: preserved upstream outcome\n')
(source/'build-cross/gcc/testsuite/cross.log').write_bytes(b'Synthetic physical cross log\n')
for name in ['build-jit','build-nvptx','build-gcn','build-hppa64']:
 (source/name/'gcc/testsuite').mkdir(parents=True)
 (source/name/'gcc/testsuite/extra.sum').write_bytes(b'PASS: synthetic copied outcome\nFAIL: preserved copied outcome\n')
 (source/name/'gcc/testsuite/extra.log').write_bytes(b'Synthetic copied log\n')
legacy_collect('gcc-12',source,work/'test-reports.json',caller)
original_reports=json.loads((work/'test-reports.json').read_bytes());original_reports['exportCustody']['producerEffectiveUid']=0;write(work/'test-reports.json',original_reports)
roots=['build','build-cross','build-jit','build-nvptx','build-gcn','build-hppa64']
assert original_reports['schemaVersion']==2 and original_reports['generatedBuildRoots']==roots
assert [row['root'] for row in original_reports['buildRootStates']]==roots
assert all(row['state']=='present-with-reports' and row['reports']==1 for row in original_reports['buildRootStates'])
assert original_reports['buildRootStates'][1]['origin']=='compatibility'
assert not original_reports['duplicateReportsAreIndependentEvidence'] and not original_reports['completeConfigurationInventoryAssessed']
# Mutate only the actual collector's closed root family, not the fixture or assertions.
collector_raw=(repo/'scripts/producer-qualification/c-producer-test-reports.py').read_text()
new_roots='["build", "build-cross", "build-jit", "build-nvptx", "build-gcn", "build-hppa64"]'
assert collector_raw.count(new_roots)==1
old_namespace={'__name__':'synthetic_old_two_root_collector','__file__':str(repo/'scripts/producer-qualification/c-producer-test-reports.py')}
exec(compile(collector_raw.replace(new_roots,'["build", "build-cross"]'),'<synthetic-two-root-mutant>','exec'),old_namespace)
old_output=root/'old-two-root-output';old_output.mkdir()
old_namespace['collect']('gcc-12',source,old_output/'test-reports.json',caller)
old_reports=json.loads((old_output/'test-reports.json').read_bytes())
assert len(old_reports['reports'])==2 and len(original_reports['reports'])==6
assert set(row['configuration'] for row in original_reports['reports'])-set(row['configuration'] for row in old_reports['reports'])==set(roots[2:])

pre_source=root/'custody-source';(pre_source/'build-tree/amd64-libc').mkdir(parents=True)
(pre_source/'build-tree/amd64-libc/tests.sum').write_bytes(b'PASS: synthetic custody preflight\n');(pre_source/'build-tree/amd64-libc/tests.log').write_bytes(b'Original synthetic custody bytes\n')
pre_root=result/'custody-preflight';pre_root.mkdir(mode=0o700);legacy_collect('glibc',pre_source,pre_root/'test-reports.json',caller)
pre_reports=json.loads((pre_root/'test-reports.json').read_bytes());pre_reports['exportCustody']['producerEffectiveUid']=0;pre_manifest=write(pre_root/'test-reports.json',pre_reports)
(result/'custody-preflight.log').write_bytes(b'Synthetic custody transport\n');pre_log=r.pin((result/'custody-preflight.log').read_bytes())
process=subprocess.run([sys.executable,'-I','-S','-B','-c','print("synthetic original foreground transport")'],capture_output=True,timeout=3)
(result/'build.log').write_bytes(process.stdout+process.stderr)
foreground={'exitCode':process.returncode,'signal':None,'error':None,'reason':None,'retainedBytes':len(process.stdout)+len(process.stderr),'stopError':None}
command={'schemaVersion':1,'command':profile['command'],'invoked':True,'exitCode':0,'wrapperExitCode':0};write(work/'original-command.json',command)
(work/'installed-build-package-identities.txt').write_bytes(b'synthetic\t0\tamd64\n')
(work/'native-build-worktree.tar').write_bytes(b'Synthetic excluded native archive payload\n');(work/'output').mkdir();(work/'output/synthetic.deb').write_bytes(b'Synthetic excluded package payload\n')
outputs=[{'file':'synthetic.deb',**r.pin((work/'output/synthetic.deb').read_bytes())}]
image_record=json.loads((repo/'scripts/producer-qualification/binutils-image-identity.v1.json').read_bytes());manifest_raw=base64.b64decode(image_record['manifest']['base64']);config_raw=base64.b64decode(image_record['config']['base64']);config=json.loads(config_raw)
image={'id':'sha256:'+r.sha(config_raw),'os':'linux','architecture':'amd64','manifestDigest':'sha256:'+r.sha(manifest_raw),'configDigest':'sha256:'+r.sha(config_raw),'rootfsDiffIds':config['rootfs']['diff_ids']}
ready={'schemaVersion':1,'kind':'ready','roots':['/observed/bundle','/observed/controls','/observed/work']};request={'schemaVersion':1,'kind':'sample','sequence':1};sample={'schemaVersion':1,'kind':'sample','sequence':1,'bytes':123,'files':2,'directories':3}
def line(stream,value):return json.dumps({'stream':stream,'base64':base64.b64encode((json.dumps(value,separators=(',',':'))+'\n').encode()).decode()}).encode()+b'\n'
transport=line('stdout',ready)+line('stdin',request)+line('stdout',sample);(result/'retention-observer.jsonl').write_bytes(transport)
observer={'state':'completed','independentImage':catalog['image'],'readOnly':True,'network':'none','capability':'DAC_READ_SEARCH','terminal':{'exitCode':0,'signal':None},'nativeFilesystemQuotaEnforced':False,'retainedLogBytes':len(transport),'log':r.pin(transport),'samples':1,'lastSample':sample}
attempt='12345678-1234-4234-8234-123456789012';cleanup={'state':'absent','id':'checktrail-producer-'+attempt};retention_cleanup={'state':'absent','id':'checktrail-retention-'+attempt}
completion={'originalCommandCompleted':True,'testEvidenceState':'failed','state':'original-command-completed-qualification-incomplete','fullCompilerSdkBootstrapClosureVerified':False,'completeOriginalNoticeClosureVerified':False,'historicalPublisherConsumptionVerified':False,'gateAComplete':False}
receipt={'schemaVersion':1,'profile':profile['profile'],'sourceVersion':profile['sourceVersion'],'catalogSha256':catalog_sha,'limits':profile['limits'],'state':completion['state'],'buildExecuted':True,'originalExecutionInvoked':True,'executionObserver':foreground,'originalBuild':command,'host':{**startup['host'],'capturedCaller':caller},'image':image,'sourcePins':[{'file':name,**r.pin((reviewed/'scripts/producer-qualification'/name).read_bytes())} for name in selected_sources],'harnessPins':[{'file':name,**r.pin((reviewed/'scripts'/name).read_bytes())} for name in ['qualify-c-producer.mjs','qualify-binutils-producer.mjs']],'log':r.pin((result/'build.log').read_bytes()),'retentionObserver':observer,'finalRetention':sample,'cleanup':cleanup,'retentionObserverCleanup':retention_cleanup,'custodyPreflight':{'state':'selected-nonroot-caller-export-verified','capturedCaller':caller,'nativeLinuxCrossUidAcceptanceVerified':True,'sourceOrCompilerInvoked':False,'cleanup':{'state':'absent'},'observer':{**foreground,'retainedBytes':pre_log['bytes']},'log':pre_log,'manifest':pre_manifest},'testEvidence':original_reports,'installedPackageIdentities':r.pin((work/'installed-build-package-identities.txt').read_bytes()),'outputs':outputs,'nativeBuildWorktree':r.pin((work/'native-build-worktree.tar').read_bytes()),'buildCompletion':completion,'attempt':attempt,'syscallRuntime':None}
for key in ['originalBuildChecksDisabled','originalDefaultTargetsDisabled','inputAuthenticationAndFreshnessDisabled','nativeFilesystemQuotaEnforced','fullCompilerSdkBootstrapClosureVerified','completeOriginalNoticeClosureVerified','historicalPublisherConsumptionVerified','gateAComplete']:receipt[key]=False
receipt_pin=write(result/'receipt.json',receipt)
observed={'schemaVersion':1,'state':'original-gcc-12-command-observed-qualification-incomplete','selectedProfile':selected,'controllerExit':2,'originalCommandExitCode':0,'originalTestOutcomesPreserved':True,'completeConfigurationInventoryAssessed':False,'packagePayloadAndNativeArchiveTransported':False,'originalReceipt':receipt_pin,'startup':startup_pin,'originalTestEvidenceState':'failed','physicallyRecheckedPackageOutputs':outputs,'physicallyRecheckedNativeArchive':receipt['nativeBuildWorktree']}
for key in ['fullCompilerSdkBootstrapClosureVerified','completeOriginalNoticeClosureVerified','historicalPublisherConsumptionVerified','gateAComplete']:observed[key]=False
write(result/'build-observation.json',observed)
child=subprocess.run([sys.executable,'-I','-S','-B','-c','print("synthetic controller terminal");raise SystemExit(2)'],capture_output=True,timeout=3);(carrier/'controller.log').write_bytes(child.stdout+child.stderr)
owner_pin=write(carrier/'owner-frame.json',receipt)
carrier_value={'schemaVersion':1,'selectedProfile':selected,'originalCommandDeadlineSeconds':43200,'carrierLimits':{'observationSeconds':14700,'cleanupSeconds':600,'softStopSeconds':480,'logBytes':8*1024**2},'state':'original-controller-terminal-observed','stopCause':None,'controllerObserver':{'exitCode':child.returncode,'signal':None,'error':None,'reason':None,'retainedBytes':len(child.stdout)+len(child.stderr),'stopError':None},'log':r.pin((carrier/'controller.log').read_bytes()),'startupInput':startup_pin,'ownerFrame':owner_pin,'ownerAttempt':attempt,'cleanup':{'producer':cleanup,'retention':retention_cleanup},'controllerTerminalSeconds':1.0,'elapsedSeconds':2.0,'startedAt':'2026-01-01T00:00:00.000Z','cutoffAt':'2026-01-01T04:05:00.000Z'}
carrier_value.update(cleanupStartedSeconds=1.0,cleanupDeadlineSeconds=601.0,stopObservation={'ownerAdmissionError':None,'childTerminalObserved':True,'childReaped':True,'softFamilyAbsent':True,'familyAbsent':True,'processGroupId':1001})
for key in ['originalProducerDefaultsOrBudgetChanged','fullEightHourHostedCapacityVerified','originalCommandCompletionClaimed','fullCompilerSdkBootstrapClosureVerified','completeOriginalNoticeClosureVerified','historicalPublisherConsumptionVerified','gateAComplete']:carrier_value[key]=False
carrier_pin=write(carrier/'receipt.json',carrier_value)
observed['carrier']={'receipt':carrier_pin,'ownerFrame':owner_pin,'controllerLog':carrier_value['log']};write(result/'build-observation.json',observed)
archive=root/'gcc-protocol.zip';exporter.export(reviewed,inputs,common,result,startup_file,archive,profile_name='gcc-12',carrier=carrier)
replayed=replay_fixture(archive,reviewed,'gcc-12');assert replayed['state']=='retained-original-gcc-12-observation-replayed' and replayed['reports']==6 and replayed['observedOutcomeLines']==12 and replayed['testEvidenceState']=='failed' and replayed['gateAComplete'] is False
# Replay the new closed outer protocol through the same complete source/image/
# signature/carrier/report pipeline, then restore the untouched legacy baseline.
legacy_receipt_bytes=(result/'receipt.json').read_bytes();legacy_observed_bytes=(result/'build-observation.json').read_bytes()
legacy_startup_bytes=startup_file.read_bytes();legacy_owner_bytes=(carrier/'owner-frame.json').read_bytes();legacy_carrier_bytes=(carrier/'receipt.json').read_bytes()
modern_startup=copy.deepcopy(startup);modern_startup.update(gitHead=head2,sourcePins=source_pins2);modern_startup_pin=write(startup_file,modern_startup)
work.chmod(0o700);os.chown(work,caller['uid'],caller['gid']);native_root=work/'native-build';native_root.mkdir(mode=0o700)
root_stat=native_root.stat();root_identity=[str(v)for v in(root_stat.st_dev,root_stat.st_ino,root_stat.st_mode,root_stat.st_uid,root_stat.st_gid)]
journal_rows={}
for phase in ['requested','terminal']:
 collector.write_command_observation(phase,work,caller,'0'if phase=='terminal'else None);leaf='original-command-'+phase+'.json';journal_rows[phase]={'state':'retained','file':leaf,'value':json.loads((work/leaf).read_bytes())}
modern_receipt=copy.deepcopy(receipt);modern_receipt.update(schemaVersion=2,retentionTransportPolicy=dict(r.C_BUILD_POLICY),reportRetention=dict(r.REPORT_LOCATIONS['original-trap']),commandObservations=journal_rows,retainedBuildRoot={'before':root_identity,'afterStop':root_identity[:],'namedAfterStop':root_identity[:],'scope':'Directory identity before and after positive producer stop; not a continuous content trace'},nativeBuildRootClose={'state':'closed'},collectionFailures=[],postStopCleanup={'state':'not-started'})
modern_receipt['harnessPins']=[{'file':name,**r.pin((reviewed2/'scripts'/name).read_bytes())} for name in ['qualify-c-producer.mjs','qualify-binutils-producer.mjs']]
modern_receipt['retentionObserver']['workObjectPolicy']='c-build-links-and-specials-no-follow';modern_pin=write(result/'receipt.json',modern_receipt)
modern_owner_pin=write(carrier/'owner-frame.json',modern_receipt)
modern_carrier=copy.deepcopy(carrier_value);modern_carrier.update(startupInput=modern_startup_pin,ownerFrame=modern_owner_pin);modern_carrier_pin=write(carrier/'receipt.json',modern_carrier)
modern_observed=copy.deepcopy(observed);modern_observed.update(startup=modern_startup_pin,originalReceipt=modern_pin,carrier={'receipt':modern_carrier_pin,'ownerFrame':modern_owner_pin,'controllerLog':modern_carrier['log']});write(result/'build-observation.json',modern_observed)
modern_archive=root/'gcc-schema2-protocol.zip';archive_sources[modern_archive]=reviewed2;exporter.export(reviewed2,inputs,common,result,startup_file,modern_archive,profile_name='gcc-12',carrier=carrier)
modern_replay=replay_fixture(modern_archive,reviewed,'gcc-12');assert modern_replay['state']=='retained-original-gcc-12-observation-replayed'and modern_replay['reports']==6 and modern_replay['observedOutcomeLines']==12 and modern_replay['testEvidenceState']=='failed'and modern_replay['gateAComplete']is False

# A separate, explicitly selected local context uses the same full physical
# schema2 protocol, source Git objects and original reports. Host/process clock
# fields remain authored schema data, never a native23hour qualification claim.
# Original schema1 snapshots remain unchanged for later legacy controls.
policy=json.loads((reviewed/exporter.LOCAL_POLICY_SOURCE).read_bytes());assert r.local_policy_binding(policy,profile)==local_binding
local_startup=copy.deepcopy(modern_startup);local_startup.update(executionPolicy=local_binding,sourcePins=source_pins2+[{'file':exporter.LOCAL_POLICY_SOURCE,**r.pin((reviewed/exporter.LOCAL_POLICY_SOURCE).read_bytes())}]);local_startup_pin=write(startup_file,local_startup)
local_receipt=copy.deepcopy(modern_receipt);local_receipt.update(executionPolicy=local_binding,executionLimits=local_binding['executionLimits'],controllerClock={'schemaVersion':1,'scope':'same-controller-process-monotonic','totalSeconds':84000,'elapsedSeconds':2.0,'remainingMs':83998000,'nativeAdmission':{'elapsedSeconds':0.0,'observerSeconds':82890,'recoveryReserveSeconds':510}})
local_receipt['sourcePins'].append({'file':'gcc-local-wall-policy.v1.json',**r.pin((reviewed/exporter.LOCAL_POLICY_SOURCE).read_bytes())})
local_receipt['host'].update(daemonMetadata={'OSType':'linux','Architecture':'aarch64','NCPU':4,'MemTotal':6442450944},finalDaemonMetadata={'OSType':'linux','Architecture':'aarch64','NCPU':4,'MemTotal':6442450944},daemonPolicy={'targetPlatform':'linux/amd64','observedDaemonArchitecture':'aarch64','localArm64DaemonPermissionUsed':True,'targetAndDaemonArchitecturesDiffer':True,'emulationImplementation':'unknown','hardwareHostAttestationPerformed':False})
local_receipt_pin=write(result/'receipt.json',local_receipt);local_owner_pin=write(carrier/'owner-frame.json',local_receipt)
local_carrier=copy.deepcopy(carrier_value);local_carrier.pop('originalProducerDefaultsOrBudgetChanged');local_carrier.update(schemaVersion=2,executionPolicy=local_binding,sourceProfileDefaultsChanged=False,executionPolicyChangesWallDeadline=True,originalCommandDeadlineSeconds=82800,carrierLimits={'observationSeconds':84060,'cleanupSeconds':600,'softStopSeconds':480,'logBytes':8*1024**2},cutoffAt='2026-01-01T23:21:00.000Z',startupInput=local_startup_pin,ownerFrame=local_owner_pin,controllerTerminalSeconds=3.0,elapsedSeconds=4.0,cleanupStartedSeconds=3.0,cleanupDeadlineSeconds=603.0)
local_carrier['managedWindow']={'schemaVersion':1,'authority':'operator-declared-managed-window','clockScope':'one-UTC-capture-then-same-carrier-monotonic','managedStartedAt':'2026-01-01T00:00:00.000Z','managedDeadlineAt':'2026-01-02T00:00:00.000Z','capturedAt':'2026-01-01T00:00:00.000Z','remainingAtCaptureMs':86400000,'admission':{'monotonicAdmissionMs':1,'remainingAtAdmissionMs':86399999,'requiredAtAdmissionMs':85860000},'monotonicElapsedMs':4000,'remainingAtFinishMs':86396000,'independentlyAttestedManagedLease':False}
local_carrier_pin=write(carrier/'receipt.json',local_carrier)
local_observed=copy.deepcopy(modern_observed);local_observed.update(executionPolicy=local_binding,startup=local_startup_pin,originalReceipt=local_receipt_pin,carrier={'receipt':local_carrier_pin,'ownerFrame':local_owner_pin,'controllerLog':local_carrier['log']});write(result/'build-observation.json',local_observed)
local_archive=root/'gcc-local23h-schema2-protocol.zip';archive_sources[local_archive]=reviewed2;exporter.export(reviewed2,inputs,common,result,startup_file,local_archive,profile_name='gcc-12',carrier=carrier,execution_policy=exporter.LOCAL_POLICY_ID)
local_replayed=replay_fixture(local_archive,reviewed,'gcc-12',r.LOCAL_POLICY_ID);assert local_replayed['state']=='retained-original-gcc-12-observation-replayed'and local_replayed['reports']==6 and local_replayed['observedOutcomeLines']==12 and local_replayed['gateAComplete']is False
for selected_archive,requested,fragment in [(local_archive,None,'Legacy replay cannot relabel local archive'),(modern_archive,r.LOCAL_POLICY_ID,'Archive did not bind explicitly requested local policy')]:
 try:replay_fixture(selected_archive,reviewed,'gcc-12',requested)
 except ValueError as error:assert fragment in str(error),(fragment,str(error))
 else:raise AssertionError('Cross-policy archive relabeling passed')
startup_file.write_bytes(legacy_startup_bytes);(carrier/'owner-frame.json').write_bytes(legacy_owner_bytes);(carrier/'receipt.json').write_bytes(legacy_carrier_bytes)
(result/'receipt.json').write_bytes(legacy_receipt_bytes);(result/'build-observation.json').write_bytes(legacy_observed_bytes)

# Complete new-source schema3 capsule with two active interventions. All raw
# counters stay WELL BELOW the allowance for the downgrade control; an omitted
# epoch gate cannot be hidden by the uniform historical byte-ceiling check.
# Historical controller1/2 fixtures use the exact pinned legacy collector and
# raw reports. The current controller3 fixture independently captures v3 bytes.
legacy_work_manifest=(work/'test-reports.json').read_bytes();legacy_pre_manifest=(pre_root/'test-reports.json').read_bytes()
legacy_work_copies=root/'legacy-work-copies';legacy_pre_copies=root/'legacy-pre-copies'
(work/'original-test-reports').rename(legacy_work_copies);(pre_root/'original-test-reports').rename(legacy_pre_copies);(work/'test-reports.json').unlink();(pre_root/'test-reports.json').unlink()
collector.collect('gcc-12',source,work/'test-reports.json',caller);current_reports=json.loads((work/'test-reports.json').read_bytes());current_reports['exportCustody']['producerEffectiveUid']=0;write(work/'test-reports.json',current_reports)
collector.collect('glibc',pre_source,pre_root/'test-reports.json',caller);current_pre_reports=json.loads((pre_root/'test-reports.json').read_bytes());current_pre_reports['exportCustody']['producerEffectiveUid']=0;current_pre_manifest=write(pre_root/'test-reports.json',current_pre_reports)
assert current_reports['schemaVersion']==current_pre_reports['schemaVersion']==3 and len(current_reports['reports'])==6
startup3=copy.deepcopy(startup);startup3.update(gitHead=head3,sourcePins=source_pins3);startup3_pin=write(startup_file,startup3)
rows3=[]
for sequence,phase in enumerate(['initial','active','active','final'],1):
 value={'schemaVersion':1,'kind':'sample','sequence':sequence,'bytes':122+sequence,'files':2,'directories':4}
 rows3.append({'schemaVersion':2,'name':'checktrail-producer-'+attempt,'image':catalog['image'],'id':'b'*64 if phase=='active'else None,'nativeStarted':phase!='initial','nativeTerminalObservedBeforeSample':phase=='final','nativeTerminalObservedAtCompletion':phase=='final','sample':value,'actions':['absent-before-admission','sample-completed']if phase=='initial'else['absent-after-native-terminal','sample-completed']if phase=='final'else['pause-requested','paused-acknowledged','sample-completed','unpause-requested','unpaused-acknowledged'],'elapsedMilliseconds':1,'complete':True,'errors':[]})
transport3=line('stdout',ready)+b''.join(line('stdin',{'schemaVersion':1,'kind':'sample','sequence':row['sample']['sequence']})+line('stdout',row['sample'])for row in rows3)
(result/'retention-observer.jsonl').write_bytes(transport3)
receipt3=copy.deepcopy(modern_receipt);receipt3.update(schemaVersion=3,retentionSamplingPolicy=dict(r.C_SAMPLING_POLICY),quiescentResourceSamples=rows3,finalRetention=rows3[-1]['sample'],harnessPins=[{'file':name,**r.pin((reviewed3/'scripts'/name).read_bytes())}for name in ['qualify-c-producer.mjs','qualify-binutils-producer.mjs']])
receipt3.update(sourcePins=[{'file':name,**r.pin((reviewed3/'scripts/producer-qualification'/name).read_bytes())}for name in current_selected_sources],testEvidence=current_reports);receipt3['custodyPreflight']['manifest']=current_pre_manifest
receipt3['retentionObserver'].update(samples=4,lastSample=rows3[-1]['sample'],retainedLogBytes=len(transport3),log=r.pin(transport3));receipt3_pin=write(result/'receipt.json',receipt3)
owner3_pin=write(carrier/'owner-frame.json',receipt3);carrier3=copy.deepcopy(carrier_value);carrier3.update(startupInput=startup3_pin,ownerFrame=owner3_pin);carrier3_pin=write(carrier/'receipt.json',carrier3)
observed3=copy.deepcopy(observed);observed3.update(startup=startup3_pin,originalReceipt=receipt3_pin,carrier={'receipt':carrier3_pin,'ownerFrame':owner3_pin,'controllerLog':carrier3['log']});write(result/'build-observation.json',observed3)
archive3=root/'gcc-current-schema3-protocol.zip';archive_sources[archive3]=reviewed3;exporter.export(reviewed3,inputs,common,result,startup_file,archive3,profile_name='gcc-12',carrier=carrier)
replayed3=replay_fixture(archive3,reviewed3,'gcc-12');assert replayed3['state']=='retained-original-gcc-12-observation-replayed'and replayed3['gateAComplete']is False
# The source frame and all byte links are coherent, but the frozen old
# controller cannot consume this new collector/report format.
(result/'retention-observer.jsonl').write_bytes(transport)
mixed_startup=copy.deepcopy(startup);mixed_startup.update(gitHead=head_mixed,sourcePins=source_pins_mixed);mixed_startup_pin=write(startup_file,mixed_startup)
mixed_receipt=copy.deepcopy(modern_receipt);mixed_receipt.update(sourcePins=[{'file':name,**r.pin((reviewed_mixed/'scripts/producer-qualification'/name).read_bytes())}for name in current_selected_sources],harnessPins=[{'file':name,**r.pin((reviewed_mixed/'scripts'/name).read_bytes())}for name in ['qualify-c-producer.mjs','qualify-binutils-producer.mjs']],testEvidence=current_reports);mixed_receipt['custodyPreflight']['manifest']=current_pre_manifest;mixed_receipt_pin=write(result/'receipt.json',mixed_receipt)
mixed_owner_pin=write(carrier/'owner-frame.json',mixed_receipt);mixed_carrier=copy.deepcopy(carrier_value);mixed_carrier.update(startupInput=mixed_startup_pin,ownerFrame=mixed_owner_pin);mixed_carrier_pin=write(carrier/'receipt.json',mixed_carrier)
mixed_observed=copy.deepcopy(observed);mixed_observed.update(startup=mixed_startup_pin,originalReceipt=mixed_receipt_pin,carrier={'receipt':mixed_carrier_pin,'ownerFrame':mixed_owner_pin,'controllerLog':mixed_carrier['log']});write(result/'build-observation.json',mixed_observed)
mixed_archive=root/'old-controller-new-collector.zip';exporter.export(reviewed_mixed,inputs,common,result,startup_file,mixed_archive,profile_name='gcc-12',carrier=carrier)
try:r.replay(mixed_archive,reviewed_mixed,'gcc-12')
except ValueError as error:assert 'Historical C controller requires exact legacy raw report collector'in str(error)
else:raise AssertionError('Impossible historical-controller/current-collector tuple replayed')
# Restore the exact raw historical cohort for the historical mutation cases.
shutil.rmtree(work/'original-test-reports');shutil.rmtree(pre_root/'original-test-reports');legacy_work_copies.rename(work/'original-test-reports');legacy_pre_copies.rename(pre_root/'original-test-reports');(work/'test-reports.json').write_bytes(legacy_work_manifest);(pre_root/'test-reports.json').write_bytes(legacy_pre_manifest)
startup_file.write_bytes(legacy_startup_bytes);(carrier/'owner-frame.json').write_bytes(legacy_owner_bytes);(carrier/'receipt.json').write_bytes(legacy_carrier_bytes)
(result/'receipt.json').write_bytes(legacy_receipt_bytes);(result/'build-observation.json').write_bytes(legacy_observed_bytes);(result/'retention-observer.jsonl').write_bytes(transport)

# Exercise physical zero-report versus absent roots through actual collection,
# exporter and offline report replay. Unsupported-only remains unavailable.
state_source=root/'root-state-source';(state_source/'build').mkdir(parents=True);(state_source/'build-jit').mkdir()
(state_source/'build-nvptx').mkdir();(state_source/'build-nvptx/tests.sum').write_bytes(b'UNSUPPORTED: synthetic no executed outcome\n')
(state_source/'build-jit-extra').mkdir();(state_source/'build-jit-extra/unselected.sum').write_bytes(b'PASS: unselected near-prefix sibling\n')
(state_source/'src').mkdir();(state_source/'src/unselected.sum').write_bytes(b'PASS: source fixture excluded\n')
(state_source/'build/linked').symlink_to(state_source/'src',target_is_directory=True)
state_result=root/'root-state-result';(state_result/'work').mkdir(parents=True)
collector.collect('gcc-12',state_source,state_result/'work/test-reports.json',caller)
state_report=json.loads((state_result/'work/test-reports.json').read_bytes())
assert [(row['root'],row['state'],row['reports'])for row in state_report['buildRootStates']]==[
 ('build','present-no-reports',0),('build-cross','absent',0),('build-jit','present-no-reports',0),
 ('build-nvptx','present-with-reports',1),('build-gcn','absent',0),('build-hppa64','absent',0)]
assert state_report['skippedLinkedDirectories']==['build/linked']
assert [row['file']for row in state_report['reports']]==['build-nvptx/tests.sum']
state_archive=root/'root-state-incomplete.zip'
exporter.export(reviewed,inputs,common,state_result,startup_file,state_archive,profile_name='gcc-12',carrier=carrier)
state_packet=r.Packet(state_archive)
try:
 state_replay=r.reports(state_packet,'result/work/original-test-reports',state_report,caller,os.geteuid(),'gcc-12')
 assert state_replay['reports']==1 and not state_replay['resolvedTestOutcomesObserved'] and state_replay['testEvidenceState']=='unavailable'
finally:state_packet.close()
linked_source=root/'linked-root-source';linked_source.mkdir();(linked_source/'target').mkdir();(linked_source/'build-jit').symlink_to(linked_source/'target',target_is_directory=True)
linked_output=root/'linked-root-output';linked_output.mkdir()
try:collector.collect('gcc-12',linked_source,linked_output/'test-reports.json',caller)
except RuntimeError as error:assert str(error)=='Generated report root is not a physical directory'
else:raise AssertionError('Selected linked build root accepted')
assert not(linked_output/'test-reports.json').exists()
# A real incomplete export retains available bytes, never inventing a live
# completion manifest after an external platform cutoff.
complete_observation=(result/'build-observation.json').read_bytes();(result/'build-observation.json').unlink()
complete_carrier=(carrier/'receipt.json').read_bytes()
cutoff_value=copy.deepcopy(carrier_value);cutoff_value.update(state='external-carrier-cutoff-incomplete',stopCause='external-carrier-cutoff');write(carrier/'receipt.json',cutoff_value)
partial=b'Synthetic interrupted exclusive publication bytes\n';(carrier/'.owner-frame.part').write_bytes(partial)
cutoff_archive=root/'cutoff-partial.zip';exporter.export(reviewed,inputs,common,result,startup_file,cutoff_archive,profile_name='gcc-12',carrier=carrier)
with zipfile.ZipFile(cutoff_archive) as z:
 assert z.read('carrier/failed-owner-frame.part')==partial
 cutoff_manifest=json.loads(z.read('manifest.json'));assert any(row['file']=='result/build-observation.json' for row in cutoff_manifest['unavailable'])
 assert 'result/build-observation.json' not in z.namelist()
try:replay_fixture(cutoff_archive,reviewed,'gcc-12')
except ValueError as error:assert 'Incomplete raw C export' in str(error),str(error)
else:raise AssertionError('Actual incomplete cutoff export qualified')
(carrier/'.owner-frame.part').unlink();(result/'build-observation.json').write_bytes(complete_observation);(carrier/'receipt.json').write_bytes(complete_carrier)
rejected_labels=[]
def mutant(label,change,expected_error,selected_archive=archive,expected_policy=None,labels=None):
 if labels is None:labels=rejected_labels
 assert label not in labels,'Duplicate rejected packet label'
 with zipfile.ZipFile(selected_archive) as z:members={name:z.read(name) for name in z.namelist()}
 manifest=json.loads(members['manifest.json']);change(members,manifest)
 # Repair all dependent byte links so the named behavior, not an earlier hash,
 # rejects each intentionally contradictory synthetic protocol observation.
 packet_receipt=json.loads(members['result/receipt.json']);packet_observed=json.loads(members['result/build-observation.json']);packet_carrier=json.loads(members['carrier/receipt.json'])
 packet_carrier['startupInput']=r.pin(members['operator-startup.json']);packet_carrier['ownerFrame']=r.pin(members['carrier/owner-frame.json']);members['carrier/receipt.json']=json.dumps(packet_carrier).encode()
 packet_observed['startup']=r.pin(members['operator-startup.json']);packet_observed['originalReceipt']=r.pin(members['result/receipt.json']);packet_observed['physicallyRecheckedPackageOutputs']=packet_receipt['outputs'];packet_observed['carrier']={'receipt':r.pin(members['carrier/receipt.json']),'ownerFrame':r.pin(members['carrier/owner-frame.json']),'controllerLog':r.pin(members['carrier/controller.log'])};members['result/build-observation.json']=json.dumps(packet_observed).encode()
 for row in manifest['rawFiles']:row.update(r.pin(members[row['file']]))
 manifest['uncompressedBytes']=sum(row['bytes'] for row in manifest['rawFiles']);manifest['originalReportLogBytes']=sum(row['bytes'] for row in manifest['rawFiles'] if row['file'].startswith('result/work/original-test-reports/'));members['manifest.json']=json.dumps(manifest).encode()
 target=root/(label+'.zip')
 with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as z:
  for name,body in members.items():z.writestr(name,body)
 archive_sources[target]=archive_sources.get(selected_archive,reviewed)
 if expected_error is None:
  positive=replay_fixture(target,reviewed,'gcc-12',expected_policy)
  assert positive['state']=='retained-original-gcc-12-observation-replayed'and positive['gateAComplete']is False
  return
 try:replay_fixture(target,reviewed,'gcc-12',expected_policy)
 except (ValueError,RuntimeError) as error:
  assert expected_error in str(error),(label,str(error));labels.append(label);return
 raise AssertionError('Invalid coherently rehashed GCC protocol packet accepted: '+label)
def edit_member(members,name,update):
 value=json.loads(members[name]);update(value);members[name]=json.dumps(value).encode()
epoch_rejected=[]
def downgrade(members,manifest,keep_rows=False):
 value=json.loads(members['result/receipt.json']);value['schemaVersion']=2;value.pop('retentionSamplingPolicy')
 if not keep_rows:value.pop('quiescentResourceSamples')
 # An archive-supplied admission table must never become reader authority.
 digest=next(row['sha256']for row in json.loads(members['operator-startup.json'])['sourcePins']if row['file']=='scripts/qualify-c-producer.mjs')
 value['historicalCControllerEpochs']={digest:2}
 members['result/receipt.json']=json.dumps(value).encode();members['carrier/owner-frame.json']=members['result/receipt.json']
 manifest.update(schemaVersion=2,controllerReceiptFormat='schema2')
mutant('new-source-stripped-policy-and-rows',downgrade,'C controller source identity requires receipt schema3',archive3,labels=epoch_rejected)
mutant('new-source-stripped-policy-with-rows',lambda m,v:downgrade(m,v,True),'C controller source identity requires receipt schema3',archive3,labels=epoch_rejected)
def old_upgrade(members,manifest):
 value=json.loads(members['result/receipt.json']);value.update(schemaVersion=3,retentionSamplingPolicy=dict(r.C_SAMPLING_POLICY),quiescentResourceSamples=copy.deepcopy(rows3),finalRetention=rows3[-1]['sample'])
 value['retentionObserver'].update(samples=4,lastSample=rows3[-1]['sample'],retainedLogBytes=len(transport3),log=r.pin(transport3))
 members['result/retention-observer.jsonl']=transport3;members['result/receipt.json']=json.dumps(value).encode();members['carrier/owner-frame.json']=members['result/receipt.json']
 manifest.update(schemaVersion=3,controllerReceiptFormat='schema3')
mutant('known-old-source-cannot-upgrade3',old_upgrade,'C controller source identity requires receipt schema2',modern_archive,labels=epoch_rejected)
ceiling_rejected=[]
allowance=sum(row['bytes']for row in profile['files'])+sum(row['bytes']for row in modern_receipt['sourcePins']if row['file']in['c-producer-build.sh','c-producer-test-reports.py','binutils-retention-observer.py','glibc-seccomp-probe.py',*[name.rsplit('/',1)[-1]for name in r.REPORT_CODEC_FILES]])
maximum=profile['limits']['workByteLimit']+allowance
def coherent_middle(members,manifest,middle_bytes):
 values=[{'schemaVersion':1,'kind':'sample','sequence':index+1,'bytes':size,'files':2,'directories':4}for index,size in enumerate([123,middle_bytes,126])]
 raw=line('stdout',ready)+b''.join(line('stdin',{'schemaVersion':1,'kind':'sample','sequence':value['sequence']})+line('stdout',value)for value in values)
 value=json.loads(members['result/receipt.json']);value['finalRetention']=values[-1];value['retentionObserver'].update(samples=3,lastSample=values[-1],retainedLogBytes=len(raw),log=r.pin(raw))
 members['result/retention-observer.jsonl']=raw;members['result/receipt.json']=json.dumps(value).encode();members['carrier/owner-frame.json']=members['result/receipt.json']
mutant('known-schema2-exact-work-allowance',lambda m,v:coherent_middle(m,v,maximum),None,modern_archive,labels=[])
mutant('known-schema2-oversized-middle',lambda m,v:coherent_middle(m,v,maximum+1),'C raw retention sample exceeded frozen work allowance',modern_archive,labels=ceiling_rejected)
assert len(epoch_rejected)==3 and ceiling_rejected==['known-schema2-oversized-middle']

local_rejected_labels=[]
def local_mutant(label,change,expected_error):return mutant(label,change,expected_error,local_archive,r.LOCAL_POLICY_ID,local_rejected_labels)
local_mutant('local-wrong-manifest-selector',lambda m,v:v.update(executionPolicy='local-gcc12-23h-v2'),'Archive did not bind')
local_mutant('local-missing-startup-binding',lambda m,v:edit_member(m,'operator-startup.json',lambda x:x.pop('executionPolicy')),'Explicit local policy binding differs')
local_mutant('local-missing-source-frame',lambda m,v:edit_member(m,'operator-startup.json',lambda x:x['sourcePins'].pop()),'Incomplete source/harness inventory')
local_mutant('local-effective-resource-change',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['executionLimits'].update(memory='7g')),'Effective local execution limits differ')
local_mutant('local-controller-remainder-reset',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['controllerClock'].update(remainingMs=83998001)),'Controller remainder reset')
def local_late_native(m,v):
 edit_member(m,'result/receipt.json',lambda x:x['controllerClock'].update(elapsedSeconds=700.0,remainingMs=83300000,nativeAdmission={'elapsedSeconds':601.0,'observerSeconds':82890,'recoveryReserveSeconds':510}))
 edit_member(m,'carrier/receipt.json',lambda x:x.update(controllerTerminalSeconds=701.0,elapsedSeconds=702.0,cleanupStartedSeconds=701.0,cleanupDeadlineSeconds=1301.0,managedWindow={**x['managedWindow'],'monotonicElapsedMs':702000,'remainingAtFinishMs':85698000}))
local_mutant('local-native-admission-too-late',local_late_native,'Native admission/recovery allowance differs')
local_mutant('local-base-profile-relabelled',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['limits'].update(deadlineSeconds=82800)),'Wrong original frozen profile')
local_mutant('local-ungranted-arm',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['host']['daemonPolicy'].update(localArm64DaemonPermissionUsed=False)),'Explicit local ARM permission evidence missing')
local_mutant('local-daemon-capacity',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['host']['daemonMetadata'].update(NCPU=3)),'Observed local ARM daemon capacity differs')
local_mutant('local-wrong-native-deadline',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(originalCommandDeadlineSeconds=82801)),'Wrong local carrier execution policy/deadline')
local_mutant('local-hosted-envelope-confusion',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(githubJobEnvelope={})),'Local carrier masquerades as hosted/legacy')
local_mutant('local-managed-wrong-span',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['managedWindow'].update(managedDeadlineAt='2026-01-02T00:00:00.001Z')),'Expired/future/wrong original managed window')
local_mutant('local-managed-future-origin',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['managedWindow'].update(managedStartedAt='2026-01-01T00:00:00.001Z',managedDeadlineAt='2026-01-02T00:00:00.001Z')),'Expired/future/wrong original managed window')
local_mutant('local-managed-late-admission',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['managedWindow']['admission'].update(monotonicAdmissionMs=540001)),'Managed admission bootstrap exhausted')
local_mutant('local-managed-final-reserve-reset',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['managedWindow'].update(remainingAtFinishMs=86396001)),'Original managed final export reserve exhausted or reset')
local_mutant('local-carrier-managed-clock-disagreement',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(elapsedSeconds=4.001)),'Local carrier elapsed/window clock differs')
assert len(local_rejected_labels)==16
mutant('wrong-archive-profile',lambda m,v:v.update(selectedProfile='glibc'),'Archive selected a different original profile')
mutant('cross-startup-profile',lambda m,v:edit_member(m,'operator-startup.json',lambda x:x['selectedProfile'].update(name='glibc')),'Startup does not bind')
mutant('external-cutoff',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(state='external-carrier-cutoff-incomplete',stopCause='external-carrier-cutoff')),'External carrier cutoff')
mutant('carrier-bool-exit',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['controllerObserver'].update(exitCode=True)),'foreground terminal')
mutant('carrier-unobserved-terminal',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['controllerObserver'].update(signal='SIGKILL')),'foreground terminal')
mutant('carrier-bool-elapsed',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(elapsedSeconds=True)),'monotonic terminal')
mutant('reset-cleanup-clock',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(cleanupDeadlineSeconds=602.0)),'cleanup clock reset')
mutant('cleanup-after-elapsed',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(cleanupStartedSeconds=3.0,cleanupDeadlineSeconds=603.0)),'cleanup clock reset')
mutant('unobserved-family',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['stopObservation'].update(familyAbsent=False)),'process-family quiescence')
mutant('bool-family-identity',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['stopObservation'].update(processGroupId=True)),'process-family quiescence')
mutant('short-original-budget',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(originalCommandDeadlineSeconds=14700)),'twelve-hour operator wall deadline')
mutant('legacy-eight-hour-budget',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(originalCommandDeadlineSeconds=28800)),'twelve-hour operator wall deadline')
mutant('deadline-one-short',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(originalCommandDeadlineSeconds=43199)),'twelve-hour operator wall deadline')
mutant('deadline-one-long',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(originalCommandDeadlineSeconds=43201)),'twelve-hour operator wall deadline')
mutant('bool-original-deadline',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(originalCommandDeadlineSeconds=True)),'twelve-hour operator wall deadline')
mutant('unobserved-cleanup',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['cleanup']['retention'].update(state='unavailable')),'owned cleanup')
mutant('scope-promoted',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(fullEightHourHostedCapacityVerified=0)),'overclaims')
mutant('different-owner',lambda m,v:edit_member(m,'carrier/owner-frame.json',lambda x:x.update(attempt='87654321-1234-4234-8234-123456789012')),'Carrier owner attempt differs')
def cross_preflight(members,manifest):
 def foreign_report(value):
  value.update(profile='gcc-12',generatedBuildRoots=roots,buildRootStates=[{'root':name,'origin':'compatibility'if name=='build-cross'else'source','state':'present-with-reports'if name=='build'else'absent','reports':1 if name=='build'else 0}for name in roots])
  for row in value['reports']:
   row['configuration']='build';row['file']=row['file'].replace('build-tree/','build/',1)
   if 'log'in row:row['log']['file']=row['log']['file'].replace('build-tree/','build/',1)
 edit_member(members,'result/custody-preflight/test-reports.json',foreign_report)
 edit_member(members,'result/receipt.json',lambda x:x['custodyPreflight'].update(manifest=r.pin(members['result/custody-preflight/test-reports.json'])))
mutant('cross-preflight-profile',cross_preflight,'Wrong original report profile')
def change_reports(members,update):
 edit_member(members,'result/work/test-reports.json',update)
 value=json.loads(members['result/work/test-reports.json'])
 edit_member(members,'result/receipt.json',lambda x:x.update(testEvidence=value))
mutant('legacy-gcc-report-version',lambda m,v:change_reports(m,lambda x:x.update(schemaVersion=1)),'Canonical C report collector source requires manifest schema2')
mutant('current-gcc-report-version',lambda m,v:change_reports(m,lambda x:x.update(schemaVersion=2)),'Canonical C report collector source requires manifest schema3',archive3)
def trailing_report_chunk(members,manifest):
 value=json.loads(members['result/work/test-reports.json']);chunk=value['reports'][0]['chunks'][0];name='result/work/original-test-reports/'+chunk['file'];encoded=members[name];changed=encoded[:-8]+b'\0'+encoded[-8:];members[name]=changed;chunk.update(r.pin(changed));value['storedBytes']+=1;members['result/work/test-reports.json']=json.dumps(value).encode();edit_member(members,'result/receipt.json',lambda x:x.update(testEvidence=value))
mutant('coherent-trailing-gzip',trailing_report_chunk,'C report gzip decoded length/trailing stream differs',archive3)
codec_cli=subprocess.run([sys.executable,'-I','-S','-B',str(repo/'scripts/producer-qualification/c-producer-replay-evidence.py'),'--profile','gcc-12','--repository',str(reviewed3),'--archive',str(root/'coherent-trailing-gzip.zip')],capture_output=True,timeout=10)
assert codec_cli.returncode==2 and codec_cli.stderr==b'',(codec_cli.returncode,codec_cli.stderr)
codec_cli_result=json.loads(codec_cli.stdout);assert codec_cli_result['state']=='original-observation-replay-incomplete' and 'trailing stream differs'in codec_cli_result['reason'] and codec_cli_result['qualificationComplete']is False and codec_cli_result['gateAComplete']is False

mutant('missing-root-state',lambda m,v:change_reports(m,lambda x:x['buildRootStates'].pop()),'Wrong GCC build-root state inventory')
mutant('wrong-root-origin',lambda m,v:change_reports(m,lambda x:x['buildRootStates'][1].update(origin='source')),'Wrong GCC build-root identity/origin')
mutant('false-empty-root-state',lambda m,v:change_reports(m,lambda x:x['buildRootStates'][2].update(state='present-no-reports')),'Wrong GCC build-root report state/count')
mutant('wrong-root-report-count',lambda m,v:change_reports(m,lambda x:x['buildRootStates'][2].update(reports=0)),'Wrong GCC build-root report state/count')
mutant('boolean-root-report-count',lambda m,v:change_reports(m,lambda x:x['buildRootStates'][2].update(reports=True)),'Wrong GCC build-root report state/count')
# True equals1 in Python. Delete only the actual new row-count integer call;
# the coherently rehashed packet then qualifies, proving why that call matters.
report_function=next(node for node in ast.parse((repo/'scripts/producer-qualification/c-producer-replay-evidence.py').read_text()).body if isinstance(node,ast.FunctionDef) and node.name=='reports')
class RemoveOnlyRootCountInteger(ast.NodeTransformer):
 def __init__(self):self.changed=0
 def visit_Call(self,node):
  if (isinstance(node.func,ast.Name) and node.func.id=='integer' and len(node.args)==1 and
      isinstance(node.args[0],ast.Subscript) and isinstance(node.args[0].value,ast.Name) and node.args[0].value.id=='row' and
      isinstance(node.args[0].slice,ast.Constant) and node.args[0].slice.value=='reports'):
   self.changed+=1;return ast.copy_location(ast.Constant(True),node)
  return self.generic_visit(node)
remove=RemoveOnlyRootCountInteger();report_function=remove.visit(report_function);assert remove.changed==1
mutated_namespace=dict(r.__dict__)
exec(compile(ast.fix_missing_locations(ast.Module(body=[report_function],type_ignores=[])),'<synthetic-count-guard-counterfactual>','exec'),mutated_namespace)
original_reports_function=r.reports
try:
 r.reports=mutated_namespace['reports']
 counterfactual=replay_fixture(root/'boolean-root-report-count.zip',reviewed,'gcc-12')
 assert counterfactual['reports']==6 and counterfactual['gateAComplete'] is False
finally:r.reports=original_reports_function

mutant('empty-package',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['outputs'][0].update(bytes=0)),'Nonempty physically observed package output')
def failed_original(members,manifest):
 edit_member(members,'result/work/original-command.json',lambda x:x.update(exitCode=2));edit_member(members,'result/receipt.json',lambda x:x['originalBuild'].update(exitCode=2))
mutant('failed-original',failed_original,'Original default command terminal')
mutant('bool-observed-zero',lambda m,v:edit_member(m,'result/build-observation.json',lambda x:x.update(originalCommandExitCode=False)),'Live original observation scope differs')
mutant('bool-observer-zero',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['retentionObserver']['terminal'].update(exitCode=False)),'Independent observer unavailable or altered')
mutant('integer-command-completed',lambda m,v:edit_member(m,'result/receipt.json',lambda x:x['buildCompletion'].update(originalCommandCompleted=1)),'Live completion scope differs')
def weak_signature_restore(members,manifest,key):
 edit_member(members,'common-inputs/transform/preparation.json',lambda x:x[key].update(restoredExitCode=False))
 edit_member(members,'common-inputs/receipt.json',lambda x:x['preparation'][key].update(restoredExitCode=False))
mutant('bool-source-signature-zero',lambda m,v:weak_signature_restore(m,v,'sourceSignatureFaultControl'),'Original signature fault/restoration control missing')
mutant('bool-release-signature-zero',lambda m,v:weak_signature_restore(m,v,'releaseSignatureFaultControl'),'Original signature fault/restoration control missing')
mutant('common-only-restored-bool',lambda m,v:edit_member(m,'common-inputs/receipt.json',lambda x:x['preparation']['sourceSignatureFaultControl'].update(restoredExitCode=False)),'Original signed APT/source preparation differs')
assert len(set(rejected_labels))==len(rejected_labels)
print(json.dumps({'booleanCountPredicateCounterfactual':True,'allSixRootsAndStatesReplayed':True,'zeroAndAbsentRootStatesReplayed':True,'oldTwoRootMutantMissesFourRoots':True,'selectedRootSymlinkRefused':True,'positivePhysicalGccProtocolReplay':True,'positivePhysicalGccSchema2ProtocolReplay':True,'positivePhysicalGccSchema3ProtocolReplay':True,'coherentSourceEpochDowngradesAndUpgradesRefused':True,'knownHistoricalMiddleCeilingAndExactBoundaryReplayed':True,'positivePhysicalGccLocalPolicyProtocolReplay':True,'explicitPolicyRelabelingRefusedBothDirections':True,'localPolicyNegativePacketsRejected':local_rejected_labels,'preservedFailedOriginalOutcomes':True,'incompleteCutoffBytesRetained':True,'coherentNegativePacketsRejected':len(rejected_labels),'rejectedPacketLabels':rejected_labels,'nativeCompilerOrRootContainerQualificationPerformed':False,'gateAComplete':False}))
`;
    const result = spawnSync(
      python!,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        program,
        repository,
        directory,
        JSON.stringify(selectedSources),
        JSON.stringify(localBinding),
      ],
      { encoding: "utf8", timeout: 45000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    const rejectedPacketLabels = [
      "wrong-archive-profile",
      "cross-startup-profile",
      "external-cutoff",
      "carrier-bool-exit",
      "carrier-unobserved-terminal",
      "carrier-bool-elapsed",
      "reset-cleanup-clock",
      "cleanup-after-elapsed",
      "unobserved-family",
      "bool-family-identity",
      "short-original-budget",
      "legacy-eight-hour-budget",
      "deadline-one-short",
      "deadline-one-long",
      "bool-original-deadline",
      "unobserved-cleanup",
      "scope-promoted",
      "different-owner",
      "cross-preflight-profile",
      "legacy-gcc-report-version",
      "current-gcc-report-version",
      "coherent-trailing-gzip",
      "missing-root-state",
      "wrong-root-origin",
      "false-empty-root-state",
      "wrong-root-report-count",
      "boolean-root-report-count",
      "empty-package",
      "failed-original",
      "bool-observed-zero",
      "bool-observer-zero",
      "integer-command-completed",
      "bool-source-signature-zero",
      "bool-release-signature-zero",
      "common-only-restored-bool",
    ];
    assert.equal(
      new Set(rejectedPacketLabels).size,
      rejectedPacketLabels.length,
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      booleanCountPredicateCounterfactual: true,
      allSixRootsAndStatesReplayed: true,
      zeroAndAbsentRootStatesReplayed: true,
      oldTwoRootMutantMissesFourRoots: true,
      selectedRootSymlinkRefused: true,
      positivePhysicalGccProtocolReplay: true,
      positivePhysicalGccSchema2ProtocolReplay: true,
      positivePhysicalGccSchema3ProtocolReplay: true,
      coherentSourceEpochDowngradesAndUpgradesRefused: true,
      knownHistoricalMiddleCeilingAndExactBoundaryReplayed: true,
      positivePhysicalGccLocalPolicyProtocolReplay: true,
      explicitPolicyRelabelingRefusedBothDirections: true,
      localPolicyNegativePacketsRejected: [
        "local-wrong-manifest-selector",
        "local-missing-startup-binding",
        "local-missing-source-frame",
        "local-effective-resource-change",
        "local-controller-remainder-reset",
        "local-native-admission-too-late",
        "local-base-profile-relabelled",
        "local-ungranted-arm",
        "local-daemon-capacity",
        "local-wrong-native-deadline",
        "local-hosted-envelope-confusion",
        "local-managed-wrong-span",
        "local-managed-future-origin",
        "local-managed-late-admission",
        "local-managed-final-reserve-reset",
        "local-carrier-managed-clock-disagreement",
      ],
      preservedFailedOriginalOutcomes: true,
      incompleteCutoffBytesRetained: true,
      coherentNegativePacketsRejected: rejectedPacketLabels.length,
      rejectedPacketLabels,
      nativeCompilerOrRootContainerQualificationPerformed: false,
      gateAComplete: false,
    });
  },
);

test(
  "GCC owned signal-zero permission transients remain pending until strict absence within the original deadline",
  posixFamilyControl,
  async () => {
    const { child, family } = wrapper.spawnCarrierNode([
      "-e",
      'process.on("SIGTERM",()=>setTimeout(()=>process.exit(2),80));process.stdout.write("armed");setInterval(()=>{},1000)',
    ]);
    const terminal = new Promise<void>((resolve) => {
      child.once("close", resolve);
      child.once("error", resolve);
    });
    const originalKill = process.kill;
    const pending = Object.assign(
      new Error("synthetic owned signal-zero permission transient"),
      { code: "EPERM" },
    );
    const groupSignals: (string | number | undefined)[] = [];
    let termSent = false,
      injected = 0,
      cleaned = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      process.kill = (pid, signal) => {
        if (pid === -child.pid) {
          if (signal === 0 && termSent && injected === 0) {
            injected++;
            throw pending;
          }
          if (signal !== 0) {
            groupSignals.push(signal);
            if (signal === "SIGTERM") termSent = true;
          }
        }
        return originalKill(pid, signal);
      };
      const deadline = performance.now() + 15000;
      const result = await wrapper.stopCarrierChild(
        child,
        terminal,
        async () => {},
        async (actual: number) => {
          assert.equal(actual, deadline);
          cleaned++;
        },
        { softStopMs: 3000, deadline, family },
      );
      assert.equal(result.familyAbsent, true);
      assert.equal(result.childReaped, true);
      assert.equal(result.softFamilyAbsent, true);
      assert.ok(
        Number.isSafeInteger(result.pendingGroupProbes.count) &&
          result.pendingGroupProbes.count >= 1 &&
          result.pendingGroupProbes.count <= 20000,
      );
      assert.deepEqual(result.pendingGroupProbes, {
        operation: "signal-zero",
        code: "EPERM",
        count: result.pendingGroupProbes.count,
        absenceInferred: false,
        signallingAuthorized: false,
      });
      assert.deepEqual(groupSignals, ["SIGTERM"]);
      assert.equal(injected, 1);
      assert.equal(cleaned, 1);
      assert.equal(child.exitCode, 2);
    } finally {
      process.kill = originalKill;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await terminal;
      assert.equal(wrapper.carrierFamilyAbsent(family), true);
    }
  },
);

test(
  "GCC unknown group probes never authorize forced signalling with persistent errors or later live observations",
  posixFamilyControl,
  async () => {
    for (const mode of ["persistent-error", "later-live"] as const) {
      const { child, family } = wrapper.spawnCarrierNode([
        "-e",
        'process.on("SIGTERM",()=>{});process.stdout.write("armed");setInterval(()=>{},1000)',
      ]);
      const terminal = new Promise<void>((resolve) => {
        child.once("close", resolve);
        child.once("error", resolve);
      });
      const originalKill = process.kill;
      const pending = Object.assign(
        new Error("synthetic owned signal-zero permission failure: " + mode),
        { code: "EPERM" },
      );
      const signals: (string | number | undefined)[] = [];
      let termSent = false,
        probes = 0,
        cleaned = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve());
          child.once("error", reject);
        });
        process.kill = (pid, signal) => {
          if (pid === -child.pid) {
            if (signal === 0 && termSent) {
              probes++;
              if (mode === "persistent-error" || probes === 1) throw pending;
            }
            if (signal !== 0) {
              signals.push(signal);
              if (signal === "SIGTERM") termSent = true;
            }
          }
          return originalKill(pid, signal);
        };
        await assert.rejects(
          wrapper.stopCarrierChild(
            child,
            terminal,
            async () => {},
            async () => {
              cleaned++;
            },
            { softStopMs: 30, deadline: performance.now() + 15000, family },
          ),
          (error: unknown) => error === pending,
        );
        assert.ok(
          probes >= 2,
          "Unknown permission must be observed within the original polling window",
        );
        assert.deepEqual(signals, ["SIGTERM"]);
        assert.equal(cleaned, 0);
      } finally {
        process.kill = originalKill;
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await terminal;
        assert.equal(wrapper.carrierFamilyAbsent(family), true);
      }
    }
  },
);

test("GCC pending group observations remain explicit unavailable probes rather than absence or signal authority", () => {
  const value = {
    ...schemaCarrier(),
    stopObservation: {
      ...schemaCarrier().stopObservation,
      pendingGroupProbes: {
        operation: "signal-zero",
        code: "EPERM",
        count: 1,
        absenceInferred: false,
        signallingAuthorized: false,
      },
    },
  };
  assert.equal(
    carrier.validateGccCarrierReceipt(value, profile, catalogSha256)
      .gateAComplete,
    false,
  );
  for (const edit of [
    { code: "EPERM-extra" },
    { operation: "SIGKILL" },
    { count: 0 },
    { count: true },
    { count: 20001 },
    { absenceInferred: true },
    { signallingAuthorized: true },
    { extra: true },
  ]) {
    const changed = structuredClone(value);
    Object.assign(changed.stopObservation.pendingGroupProbes, edit);
    assert.throws(() =>
      carrier.validateGccCarrierReceipt(changed, profile, catalogSha256),
    );
  }
});

test("GCC source-job credential is confined to metadata admission and omitted from the original controller environment", () => {
  const input = {
    CHECKTRAIL_GITHUB_JOB_TOKEN: "synthetic-token",
    GITHUB_RUN_ID: "51",
    PATH: "synthetic-path",
  };
  assert.deepEqual(wrapper.carrierChildEnvironment(input), {
    GITHUB_RUN_ID: "51",
    PATH: "synthetic-path",
  });
  assert.equal(input.CHECKTRAIL_GITHUB_JOB_TOKEN, "synthetic-token");
});

test("GCC admitted carrier validates retained source-job bytes and refuses a substituted envelope", async () => {
  const api = await import(
    pathToFileURL(
      path.join(
        repository,
        "scripts/producer-qualification/gcc-job-envelope.mjs",
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
  const responseBytes = Buffer.from(
    JSON.stringify({
      total_count: 1,
      jobs: [
        {
          id: 41,
          run_id: 51,
          run_url:
            "https://api.github.com/repos/fixture-owner/fixture-repo/actions/runs/51",
          name: context.jobName,
          head_sha: context.headSha,
          status: "in_progress",
          conclusion: null,
          started_at: "2026-01-01T00:00:00Z",
        },
      ],
    }),
  );
  const admitted = api.admitGccJobEnvelope({
    context,
    url: api.githubGccJobsUrl(context),
    httpStatus: 200,
    responseBytes,
    responseComplete: true,
    observedResponseBytes: responseBytes.length,
    retainedResponseBytes: responseBytes.length,
    observedUnretainedBytes: 0,
    contentType: "application/json",
    contentEncoding: null,
    serviceDate: "Thu, 01 Jan 2026 00:02:01 GMT",
    requestStartedAt: "2026-01-01T00:02:01.000Z",
    receivedAt: "2026-01-01T00:02:01.100Z",
    requestElapsedMs: 100,
    carrierStartedAt: "2026-01-01T00:02:00.000Z",
    carrierElapsedMs: 1100,
  });
  const value = {
    ...schemaCarrier(),
    githubJobEnvelope: admitted,
    carrierLimits: {
      ...carrier.gccCarrierLimits,
      observationSeconds: admitted.observationSeconds,
    },
    startedAt: admitted.carrierStartedAt,
    cutoffAt: admitted.cutoffAt,
  };
  assert.equal(
    carrier.validateGccCarrierReceipt(
      value,
      profile,
      catalogSha256,
      responseBytes,
    ).fullEightHourHostedCapacityVerified,
    false,
  );
  assert.throws(() =>
    carrier.validateGccCarrierReceipt(value, profile, catalogSha256),
  );
  assert.throws(() =>
    carrier.validateGccCarrierReceipt(
      value,
      profile,
      catalogSha256,
      Buffer.concat([responseBytes, Buffer.from(" ")]),
    ),
  );
  const edited = structuredClone(value);
  edited.githubJobEnvelope.observationSeconds++;
  assert.throws(() =>
    carrier.validateGccCarrierReceipt(
      edited,
      profile,
      catalogSha256,
      responseBytes,
    ),
  );
});

test("GCC retained clock publication preserves a write failure and closes BOTH reserved handles after raw close fails", async () => {
  const primary = new Error("synthetic-write-primary"),
    secondary = new Error("synthetic-raw-close-secondary");
  const events: string[] = [];
  const handles = [
    {
      writeFile: async () => {
        throw primary;
      },
      close: async () => {
        events.push("raw.close");
        throw secondary;
      },
    },
    {
      close: async () => {
        events.push("metadata.close");
      },
    },
  ];
  await assert.rejects(
    wrapper.retainCarrierJobClock(
      "synthetic-carrier",
      { responseBytes: Buffer.from("{}") },
      {
        open: async () => handles.shift(),
        link: async () => assert.fail("no failed bytes may publish"),
        unlink: async () => assert.fail("no failed bytes may publish"),
      },
    ),
    (error: unknown) => error === primary,
  );
  assert.deepEqual(events, ["raw.close", "metadata.close"]);
  assert.deepEqual(wrapper.carrierPublicationFailureDetails(primary), {
    primary: String(primary),
    secondary: [String(secondary)],
  });
});

test("GCC reserved publication preserves directory sync failure while retaining directory close failure", async () => {
  const primary = new Error("synthetic-directory-sync-primary"),
    secondary = new Error("synthetic-directory-close-secondary");
  const events: string[] = [];
  const raw = {
    writeFile: async () => {
      events.push("write");
    },
    sync: async () => {
      events.push("file.sync");
    },
    close: async () => {
      events.push("file.close");
    },
  };
  const directory = {
    sync: async () => {
      events.push("directory.sync");
      throw primary;
    },
    close: async () => {
      events.push("directory.close");
      throw secondary;
    },
  };
  await assert.rejects(
    wrapper.publishReserved(
      raw,
      "synthetic.part",
      "synthetic.final",
      Buffer.from("{}"),
      {
        link: async () => {
          events.push("link");
        },
        unlink: async () => {
          events.push("unlink");
        },
        open: async () => directory,
      },
    ),
    (error: unknown) => error === primary,
  );
  assert.deepEqual(events, [
    "write",
    "file.sync",
    "file.close",
    "link",
    "unlink",
    "directory.sync",
    "directory.close",
  ]);
  assert.deepEqual(wrapper.carrierPublicationFailureDetails(primary), {
    primary: String(primary),
    secondary: [String(secondary)],
  });
});

test("GCC publication cleanup attempts every handle and retains frozen primary and secondary errors", async () => {
  const primary = Object.freeze(new Error("synthetic-frozen-primary"));
  const closes: number[] = [];
  const failures = [new Error("first-close"), new Error("second-close")];
  const handles = failures.map((failure, index) => ({
    close: async () => {
      closes.push(index);
      throw failure;
    },
  }));
  const result = await wrapper.closeCarrierPublicationHandles(handles, primary);
  assert.equal(result.cause, primary);
  assert.deepEqual(closes, [0, 1]);
  assert.deepEqual(wrapper.carrierPublicationFailureDetails(result), {
    primary: String(primary),
    secondary: failures.map(String),
  });
  const first = await wrapper.closeCarrierPublicationHandles(
    handles,
    undefined,
  );
  assert.equal(first, failures[0]);
  assert.deepEqual(wrapper.carrierPublicationFailureDetails(first), {
    primary: String(failures[0]),
    secondary: [String(failures[1])],
  });
});

test("GCC clock metadata reservation failure retains its primary and still closes the raw handle", async () => {
  const primary = new Error("synthetic-metadata-reservation-primary"),
    secondary = new Error("synthetic-raw-close-secondary");
  let opened = 0,
    closed = 0;
  await assert.rejects(
    wrapper.retainCarrierJobClock(
      "synthetic-carrier",
      { responseBytes: Buffer.from("{}") },
      {
        open: async () => {
          opened++;
          if (opened === 2) throw primary;
          return {
            close: async () => {
              closed++;
              throw secondary;
            },
          };
        },
        link: async () =>
          assert.fail("reservation must finish before publication"),
        unlink: async () =>
          assert.fail("reservation must finish before publication"),
      },
    ),
    (error: unknown) => error === primary,
  );
  assert.equal(opened, 2);
  assert.equal(closed, 1);
  assert.deepEqual(wrapper.carrierPublicationFailureDetails(primary), {
    primary: String(primary),
    secondary: [String(secondary)],
  });
});

test("GCC successful retained clock publication closes each exact reserved file and directory once", async () => {
  const closes: number[] = [],
    writes: { file: string; bytes: Buffer }[] = [];
  const actions: string[] = [];
  let next = 0;
  const io = {
    open: async (file: string) => {
      const id = next++;
      actions.push("open:" + path.basename(file));
      return {
        writeFile: async (raw: string | Buffer) => {
          writes.push({ file, bytes: Buffer.from(raw) });
        },
        sync: async () => {},
        close: async () => {
          closes.push(id);
        },
      };
    },
    link: async (part: string, target: string) => {
      actions.push("link:" + path.basename(part) + ":" + path.basename(target));
    },
    unlink: async (part: string) => {
      actions.push("unlink:" + path.basename(part));
    },
  };
  await wrapper.retainCarrierJobClock(
    "synthetic-carrier",
    {
      responseBytes: Buffer.from("{}"),
      requestAuthenticationHeadersRetained: false,
    },
    io,
  );
  assert.deepEqual(closes, [0, 2, 1, 3]);
  assert.deepEqual(actions.slice(0, 2), [
    "open:.github-job-response.part",
    "open:.github-job-capture.part",
  ]);
  assert.equal(actions.filter((entry) => entry.startsWith("link:")).length, 2);
  assert.equal(
    actions.filter((entry) => entry.startsWith("unlink:")).length,
    2,
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.bytes.toString(), "{}");
  assert.deepEqual(JSON.parse(writes[1]!.bytes.toString()), {
    requestAuthenticationHeadersRetained: false,
    response: {
      bytes: 2,
      sha256:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    },
  });
});

test("GCC final publication preserves an earlier observation failure and all publication cleanup errors", async () => {
  const observation = new Error("synthetic-observation-primary"),
    publication = new Error("synthetic-publication-secondary"),
    close = new Error("synthetic-publication-close-secondary");
  const failedPublication = await wrapper.closeCarrierPublicationHandles(
    [
      {
        close: async () => {
          throw close;
        },
      },
    ],
    publication,
  );
  assert.throws(
    () => wrapper.finishCarrierPublication(observation, failedPublication),
    (error: unknown) => error === observation,
  );
  assert.deepEqual(wrapper.carrierPublicationFailureDetails(observation), {
    primary: String(observation),
    secondary: [String(publication), String(close)],
  });
  assert.equal(
    wrapper.finishCarrierPublication(observation, undefined),
    undefined,
    "An ordinary recorded observation failure keeps its existing nonthrowing terminal behavior",
  );
  assert.equal(
    wrapper.finishCarrierPublication(undefined, undefined),
    undefined,
  );
  assert.throws(
    () => wrapper.finishCarrierPublication(undefined, publication),
    (error: unknown) => error === publication,
  );
});

test(
  "C schema2 archives reconcile both report epochs, journals and stopped roots for every fixed profile without promoting native qualification",
  {
    skip:
      process.platform === "win32"
        ? "POSIX synthetic report-custody component unavailable"
        : python
          ? false
          : "Verified Python3 protocol fixture unavailable: " +
            unavailable.join("; "),
  },
  async (t) => {
    const directory = await realpath(await fixture(t, {}));
    const program = String.raw`
import copy,hashlib,importlib.util,json,os,pathlib,stat,sys,zipfile
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);MIB=1024**2
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
e=module('closed_c_export',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
r=module('closed_c_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
c=module('closed_c_collect',repo/'scripts/producer-qualification/c-producer-test-reports.py')
catalog=json.loads((repo/'scripts/producer-qualification/c-producer-profiles.v1.json').read_bytes());caller={'uid':os.getuid(),'gid':os.getgid()};assert caller['uid']>0
def write(p,value):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(value if isinstance(value,bytes)else(json.dumps(value)+'\n').encode());p.chmod(0o600)
def reports(profile,source,destination,status):
 name='build'if profile=='gcc-12'else'build-tree';p=source/name/'tests.sum';write(p,(status+': authored result\n').encode());write(p.with_suffix('.log'),b'Authored original report log\n')
 destination.parent.mkdir(parents=True,exist_ok=True);destination.parent.chmod(0o700);os.chown(destination.parent,caller['uid'],caller['gid'])
 c.collect(profile,source,destination,caller);value=json.loads(destination.read_bytes());value['exportCustody']['producerEffectiveUid']=0;write(destination,value);return value
def fixture(profile_name):
 base=root/profile_name;base.mkdir();result=base/'result';work=result/'work';work.mkdir(parents=True,mode=0o700);os.chown(work,caller['uid'],caller['gid']);work.chmod(0o700)
 profile=catalog['profiles'][profile_name];native=work/'native-build';native.mkdir(mode=0o700);s=native.stat();identity=[str(v)for v in(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)]
 trap=reports(profile_name,base/'trap-source',work/'test-reports.json','PASS');post=reports(profile_name,base/'post-source',work/'post-stop-reports/test-reports.json','FAIL')
 command={'schemaVersion':1,'command':profile['command'],'invoked':True,'exitCode':0,'wrapperExitCode':0};write(work/'original-command.json',command)
 journals={}
 for phase in ['requested','terminal']:
  c.write_command_observation(phase,work,caller,'0'if phase=='terminal'else None);name='original-command-'+phase+'.json';journals[phase]={'state':'retained','file':name,'value':json.loads((work/name).read_bytes())}
 post_log=b'Authored data-only post-stop collection\n';write(result/'post-stop-reports.log',post_log)
 foreground={'exitCode':0,'signal':None,'error':None,'reason':None,'retainedBytes':len(post_log),'stopError':None};cleanup={'state':'absent','id':'checktrail-producer-12345678-1234-4234-8234-123456789012'}
 receipt={'schemaVersion':2,'profile':profile['profile'],'sourceVersion':profile['sourceVersion'],'limits':profile['limits'],'catalogSha256':r.CATALOG_SHA256,'retentionTransportPolicy':dict(r.C_BUILD_POLICY),'reportRetention':dict(r.REPORT_LOCATIONS['post-stop']),'originalBuild':command,'commandObservations':journals,'retainedBuildRoot':{'before':identity,'afterStop':identity[:],'namedAfterStop':identity[:],'scope':'Directory identity before and after positive producer stop; not a continuous content trace'},'nativeBuildRootClose':{'state':'closed'},'collectionFailures':[],'postStopRetention':{'originalCodeExecuted':False,'observer':foreground,'cleanup':cleanup,'primary':None},'postStopCleanup':dict(cleanup),'testEvidence':post,'gateAComplete':False}
 write(result/'receipt.json',receipt);write(result/'build-observation.json',{});write(result/'build.log',b'Authored foreground bytes\n');write(result/'retention-observer.jsonl',b'authored raw observer placeholder\n');write(work/'installed-build-package-identities.txt',b'authored\t0\tamd64\n');write(result/'custody-preflight.log',b'authored\n');write(result/'custody-preflight/test-reports.json',{})
 if profile_name!='gcc-12':
  for name in ['seccomp-baseline.log','seccomp-derived.log','controls/glibc-native-seccomp.json']:write(result/name,{})
 carrier=base/'carrier'
 for name in ['receipt.json','controller.log','owner-frame.json']:write(carrier/name,{})
 inputs=base/'inputs';common=base/'common';startup=base/'startup.json'
 for p in [inputs/'receipt.json',common/'receipt.json',startup]:write(p,{})
 write(common/'transform.log',b'authored\n');archive=base/'closed.zip';e.export(repo,inputs,common,result,startup,archive,profile_name=profile_name,carrier=carrier)
 return base,result,receipt,profile,archive,trap
def validate(archive,receipt,profile,key):
 p=r.Packet(archive)
 try:
  assert not p.manifest['unavailable'],p.manifest['unavailable'];selected=r.closed_controller_evidence(p,receipt,profile,caller);value,summary=r.selected_reports(p,selected,receipt,caller,key)
  assert summary['reports']==1 and summary['observedOutcomeLines']==1 and summary['testEvidenceState']=='failed' and summary['reportsPooledAsIndependentEvidence']is False
  return p.manifest
 finally:p.close()
for key in ['gcc-12','glibc','glibc-u13']:
 base,result,receipt,profile,archive,trap=fixture(key);manifest=validate(archive,receipt,profile,key)
 assert manifest['schemaVersion']==2 and manifest['controllerReceiptFormat']=='schema2'and manifest['originalReportLogBytes']>0 and manifest['postStopReportLogBytes']>0
 assert manifest['originalReportAggregateByteLimit']==manifest['postStopReportAggregateByteLimit']==512*MIB and manifest['reportFamiliesRetainedSeparately']is True
 near=copy.deepcopy(receipt);near['postStopRetention']['cleanup']['state']='removed';validate(archive,near,profile,key)
 # A fixed original-trap selection is also valid, but never selects post-stop data.
 selected=copy.deepcopy(receipt);selected['reportRetention']=dict(r.REPORT_LOCATIONS['original-trap']);selected['testEvidence']=trap
 packet=r.Packet(archive)
 try:
  fmt=r.closed_controller_evidence(packet,selected,profile,caller);_,summary=r.selected_reports(packet,fmt,selected,caller,key);assert summary['testEvidenceState']=='reported'and summary['observedOutcomeLines']==1
 finally:packet.close()

# Last loop profile is glibc-u13. Mutation negatives exercise that exact tuple;
# the positive loop above covers every closed producer/report root family.
key='glibc-u13';rejected=[]
with zipfile.ZipFile(archive)as z:original={name:z.read(name)for name in z.namelist()}
def mutate(label,change,reason):
 members=dict(original);manifest=json.loads(members['manifest.json']);value=copy.deepcopy(receipt);change(members,manifest,value)
 members['result/receipt.json']=json.dumps(value).encode()
 for row in manifest['rawFiles']:row.update(r.pin(members[row['file']]))
 manifest['uncompressedBytes']=sum(row['bytes']for row in manifest['rawFiles']);manifest['originalReportLogBytes']=sum(row['bytes']for row in manifest['rawFiles']if row['file'].startswith('result/work/original-test-reports/'));manifest['postStopReportLogBytes']=sum(row['bytes']for row in manifest['rawFiles']if row['file'].startswith('result/work/post-stop-reports/original-test-reports/'));members['manifest.json']=json.dumps(manifest).encode()
 target=base/(label+'.zip')
 with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED)as z:
  for name,body in members.items():z.writestr(name,body)
 try:validate(target,value,profile,key)
 except ValueError as error:assert reason in str(error),(label,str(error));rejected.append(label);return
 raise AssertionError('Coherently rehashed closed protocol accepted '+label)
mutate('forged-log-policy',lambda m,f,v:v['retentionTransportPolicy'].update(maximumLogBytes=512*MIB),'C retention transport policy differs')
mutate('forged-sample-policy',lambda m,f,v:v['retentionTransportPolicy'].update(maximumSamples=9001),'C retention transport policy differs')
mutate('forged-work-policy',lambda m,f,v:v['retentionTransportPolicy'].update(workObjectPolicy='follow-links'),'C retention transport policy differs')
mutate('arbitrary-report-path',lambda m,f,v:v['reportRetention'].update(manifest='work/other/test-reports.json'),'Unknown original C report retention source/path')
mutate('journal-filename-substitution',lambda m,f,v:v['commandObservations']['terminal'].update(file='original-command-requested.json'),'Independent command journal retained filename differs')
mutate('journal-byte-value-disagreement',lambda m,f,v:v['commandObservations']['terminal']['value'].update(exitCode=1),'Retained original command journal bytes/value differ')
def journal_terminal(m,f,v):
 name='result/work/original-command-terminal.json';value=json.loads(m[name]);value['exitCode']=1;m[name]=json.dumps(value).encode();v['commandObservations']['terminal']['value']=value
mutate('journal-disagrees-with-final-zero',journal_terminal,'Independent original command journal differs')
def drop(m,f,v,prefix):
 for name in list(m):
  if name.startswith(prefix):del m[name]
 f['rawFiles']=[r for r in f['rawFiles']if not r['file'].startswith(prefix)]
 f['nativeDirectories']=[r for r in f['nativeDirectories']if not r['file'].startswith(prefix)]
mutate('drop-original-trap-family',lambda m,f,v:(drop(m,f,v,'result/work/original-test-reports'),drop(m,f,v,'result/work/test-reports.json')),'Original-trap raw report family was dropped')
selected_chunk='result/work/post-stop-reports/original-test-reports/'+receipt['testEvidence']['reports'][0]['chunks'][0]['file']
mutate('drop-selected-family-file',lambda m,f,v:drop(m,f,v,selected_chunk),'Missing original report/log transport member: '+receipt['testEvidence']['reports'][0]['chunks'][0]['file'])
def drop_unselected_poststop(m,f,v):
 v.update(reportRetention=dict(r.REPORT_LOCATIONS['original-trap']),testEvidence=trap);drop(m,f,v,'result/work/post-stop-reports')
mutate('drop-observed-unselected-poststop-family',drop_unselected_poststop,'Post-stop raw report family was dropped')
mutate('swapped-selected-report-epoch',lambda m,f,v:v.update(reportRetention=dict(r.REPORT_LOCATIONS['original-trap'])),'Selected original report manifest differs')
mutate('changed-native-root',lambda m,f,v:v['retainedBuildRoot']['namedAfterStop'].__setitem__(1,'999999999'),'Stopped native build-root identity/owner/mode differs')
mutate('noncanonical-root-decimal',lambda m,f,v:v['retainedBuildRoot']['before'].__setitem__(0,'01'),'Malformed native build-root identity')
mutate('unclosed-native-root',lambda m,f,v:v.update(nativeBuildRootClose={'state':'not-opened'}),'Native build-root close or evidence collection incomplete')
mutate('hidden-collection-failure',lambda m,f,v:v.update(collectionFailures=[{'field':'originalTrapReports'}]),'Native build-root close or evidence collection incomplete')
mutate('poststop-failed-terminal',lambda m,f,v:v['postStopRetention']['observer'].update(exitCode=2),'Original foreground terminal failed or incomplete')
mutate('poststop-cleanup-substitution',lambda m,f,v:v['postStopCleanup'].update(id='different-owned-id'),'Post-stop collector cleanup identity differs')
def failed_unselected(m,f,v):
 v.update(reportRetention=dict(r.REPORT_LOCATIONS['original-trap']),testEvidence=trap);v['postStopRetention']['primary']='authored collector failure'
mutate('failed-unselected-poststop-attempt',failed_unselected,'Post-stop report collector scope/failure differs')
mutate('missing-outer-poststop-cleanup',lambda m,f,v:v.pop('postStopCleanup'),'Post-stop report collector cleanup incomplete')
mutate('poststop-log-length-disagreement',lambda m,f,v:v['postStopRetention']['observer'].update(retainedBytes=1),'Post-stop report collector raw log/terminal differs')
def poststop_log_owner(manifest,field,value):
 next(row for row in manifest['rawFiles']if row['file']=='result/post-stop-reports.log')[field]=value
mutate('poststop-log-native-mode',lambda m,f,v:poststop_log_owner(f,'nativeMode',0o644),'Wrong original native export owner/group/mode')
mutate('poststop-log-native-uid',lambda m,f,v:poststop_log_owner(f,'nativeUid',caller['uid']+1),'Wrong original native export owner/group/mode')
mutate('poststop-log-native-gid',lambda m,f,v:poststop_log_owner(f,'nativeGid',caller['gid']+1),'Wrong original native export owner/group/mode')
mutate('caller-selected-archive-limit',lambda m,f,v:f.update(retentionObserverLogByteLimit=512*MIB),'Wrong closed C archive2 policy')
# A malformed receipt still exports every available raw family as unverified2.
write(result/'receipt.json',b'{not JSON');unverified=base/'unverified.zip';e.export(repo,base/'inputs',base/'common',result,base/'startup.json',unverified,profile_name=key,carrier=base/'carrier')
packet=r.Packet(unverified)
try:
 assert packet.manifest['controllerReceiptFormat']=='unverified'and packet.manifest['schemaVersion']==2
 assert packet.read('result/work/original-command-terminal.json',4096)
 selected_manifest=packet.json('result/work/post-stop-reports/test-reports.json');selected_pin=selected_manifest['reports'][0];assert b''.join(r.REPORT_CODEC.iter_report_bytes(selected_pin,lambda name,maximum:packet.read('result/work/post-stop-reports/original-test-reports/'+name,maximum)))==b'FAIL: authored result\n'
 try:r.closed_controller_evidence(packet,receipt,profile,caller)
 except ValueError as error:assert 'Unverified controller receipt format'in str(error)
 else:raise AssertionError('Malformed controller receipt promoted')
finally:packet.close()
# Physical byte-limit near miss: old receipt1 retains16MiB, never the new quota.
write(result/'receipt.json',{'schemaVersion':1});write(result/'retention-observer.jsonl',b'X'*(16*MIB+1));legacy=base/'legacy-over.zip';e.export(repo,base/'inputs',base/'common',result,base/'startup.json',legacy,profile_name=key,carrier=base/'carrier')
with zipfile.ZipFile(legacy)as z:
 m=json.loads(z.read('manifest.json'));assert m['schemaVersion']==1 and any(x['file']=='result/retention-observer.jsonl'for x in m['unavailable'])and 'result/retention-observer.jsonl'not in z.namelist()
write(result/'receipt.json',receipt);modern=base/'schema2-near.zip';e.export(repo,base/'inputs',base/'common',result,base/'startup.json',modern,profile_name=key,carrier=base/'carrier')
packet=r.Packet(modern)
try:assert packet.files['result/retention-observer.jsonl']['bytes']==16*MIB+1
finally:packet.close()
print(json.dumps({'allThreeFixedProfilesPhysicallyReconciled':True,'bothReportEpochsRetainedWithoutPooling':True,'actualImmutableJournalWriterUsed':True,'removedThenAbsentSameOwnedCleanupAccepted':True,'coherentlyRehashedNegativesRejected':len(rejected),'legacy16MiBLimitPreserved':True,'schema2FixedLargerTransportRetained':True,'malformedReceiptRawBytesNotPromoted':True,'nativeCompilerOrRootContainerQualificationPerformed':False,'gateAComplete':False}))
`;
    const result = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, repository, directory],
      {
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 65536,
      },
    );
    assert.equal(result.status, 0, diagnostic(result));
    assert.deepEqual(JSON.parse(result.stdout), {
      allThreeFixedProfilesPhysicallyReconciled: true,
      bothReportEpochsRetainedWithoutPooling: true,
      actualImmutableJournalWriterUsed: true,
      removedThenAbsentSameOwnedCleanupAccepted: true,
      coherentlyRehashedNegativesRejected: 24,
      legacy16MiBLimitPreserved: true,
      schema2FixedLargerTransportRetained: true,
      malformedReceiptRawBytesNotPromoted: true,
      nativeCompilerOrRootContainerQualificationPerformed: false,
      gateAComplete: false,
    });
  },
);

test("GCC local carrier requires a distinct explicit policy and original declared managed window", async () => {
  const policy = await profiles.loadCProducerExecutionPolicy(
    "local-gcc12-23h-v1",
    profile,
  );
  const binding = profiles.cProducerExecutionPolicyBinding(policy, profile);
  const { originalProducerDefaultsOrBudgetChanged, ...legacy } =
    schemaCarrier();
  assert.equal(originalProducerDefaultsOrBudgetChanged, false);
  const value = {
    ...legacy,
    schemaVersion: 2,
    executionPolicy: binding,
    originalCommandDeadlineSeconds: 82800,
    carrierLimits: {
      observationSeconds: 84060,
      cleanupSeconds: 600,
      softStopSeconds: 480,
      logBytes: 8 * 1024 ** 2,
    },
    sourceProfileDefaultsChanged: false,
    executionPolicyChangesWallDeadline: true,
    cutoffAt: "2026-01-01T23:21:00.000Z",
    managedWindow: {
      schemaVersion: 1,
      authority: "operator-declared-managed-window",
      clockScope: "one-UTC-capture-then-same-carrier-monotonic",
      managedStartedAt: "2026-01-01T00:00:00.000Z",
      managedDeadlineAt: "2026-01-02T00:00:00.000Z",
      capturedAt: "2026-01-01T00:00:00.000Z",
      remainingAtCaptureMs: 86400000,
      admission: {
        monotonicAdmissionMs: 1,
        remainingAtAdmissionMs: 86399999,
        requiredAtAdmissionMs: 85860000,
      },
      monotonicElapsedMs: Math.round(legacy.elapsedSeconds * 1000),
      remainingAtFinishMs: 86400000 - Math.round(legacy.elapsedSeconds * 1000),
      independentlyAttestedManagedLease: false,
    },
  };
  assert.equal(
    carrier.validateLocalGccCarrierReceipt(
      value,
      profile,
      catalogSha256,
      policy,
    ).originalControllerTerminalObserved,
    true,
  );
  assert.throws(() =>
    carrier.validateGccCarrierReceipt(value, profile, catalogSha256),
  );
  assert.throws(() =>
    carrier.validateLocalGccCarrierReceipt(
      schemaCarrier(),
      profile,
      catalogSha256,
      policy,
    ),
  );
  for (const change of [
    (v: typeof value) => {
      v.originalCommandDeadlineSeconds = 43200;
    },
    (v: typeof value) => {
      v.carrierLimits.observationSeconds -= 1;
    },
    (v: typeof value) => {
      Object.assign(v, { githubJobEnvelope: {} });
    },
    (v: typeof value) => {
      v.managedWindow.independentlyAttestedManagedLease = true;
    },
    (v: typeof value) => {
      v.managedWindow.remainingAtFinishMs += 1;
    },
    (v: typeof value) => {
      v.managedWindow.monotonicElapsedMs += 1;
      v.managedWindow.remainingAtFinishMs -= 1;
    },
    (v: typeof value) => {
      Object.assign(v.managedWindow.admission, { extra: true });
    },
    (v: typeof value) => {
      v.sourceProfileDefaultsChanged = true;
    },
    (v: typeof value) => {
      v.executionPolicyChangesWallDeadline = false;
    },
  ]) {
    const changed = structuredClone(value);
    change(changed);
    assert.throws(() =>
      carrier.validateLocalGccCarrierReceipt(
        changed,
        profile,
        catalogSha256,
        policy,
      ),
    );
  }
});
