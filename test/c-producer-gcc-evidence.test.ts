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
  "0309dcd61b505020cc19bb67beeca7b6a62103c8194784c9eb224bb75466dbc6";
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
  originalCommandDeadlineSeconds: 28800,
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

test("GCC external carrier schema retains the original eight-hour deadline and refuses cutoff, stale and weakly typed terminals", () => {
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
    step.name?.includes("unchanged eight-hour"),
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
  assert.equal(profile.limits.deadlineSeconds, 28800);
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
    const program = String.raw`
import base64,copy,datetime,hashlib,importlib.util,json,os,pathlib,shutil,subprocess,sys,time,zipfile
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);selected_sources=json.loads(sys.argv[3])
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
exporter=module('gcc_fixture_export',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
r=module('gcc_fixture_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
collector=module('gcc_fixture_collect',repo/'scripts/producer-qualification/c-producer-test-reports.py')
catalog=json.loads((repo/'scripts/producer-qualification/c-producer-profiles.v1.json').read_bytes());profile=catalog['profiles']['gcc-12'];catalog_sha=r.CATALOG_SHA256
caller={'uid':os.getuid(),'gid':os.getgid()};assert caller['uid']>0
reviewed=root/'operator-source';reviewed.mkdir()
for name in exporter.SOURCE_FILES:
 target=reviewed/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(repo/name,target)
env=dict(os.environ);env.update(SKIP_CODEX_REVIEW='1',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
git=['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false','-c','commit.gpgsign=false']
for args in [['init','--quiet'],['add','--',*exporter.SOURCE_FILES],['-c','user.name=Synthetic Protocol','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','Synthetic operator frame']]:
 p=subprocess.run(git+args,cwd=reviewed,env=env,capture_output=True,timeout=10);assert p.returncode==0,p.stderr
head=subprocess.check_output(git+['rev-parse','HEAD'],cwd=reviewed,env=env).decode().strip()
def write(file,value):
 file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes((json.dumps(value)+'\n').encode());file.chmod(0o600);return r.pin(file.read_bytes())
source_pins=[{'file':name,**r.pin((reviewed/name).read_bytes())} for name in exporter.SOURCE_FILES]
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
collector.collect('gcc-12',source,work/'test-reports.json',caller)
original_reports=json.loads((work/'test-reports.json').read_bytes());original_reports['exportCustody']['producerEffectiveUid']=0;write(work/'test-reports.json',original_reports)
pre_source=root/'custody-source';(pre_source/'build-tree/amd64-libc').mkdir(parents=True)
(pre_source/'build-tree/amd64-libc/tests.sum').write_bytes(b'PASS: synthetic custody preflight\n');(pre_source/'build-tree/amd64-libc/tests.log').write_bytes(b'Original synthetic custody bytes\n')
pre_root=result/'custody-preflight';pre_root.mkdir(mode=0o700);collector.collect('glibc',pre_source,pre_root/'test-reports.json',caller)
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
carrier_value={'schemaVersion':1,'selectedProfile':selected,'originalCommandDeadlineSeconds':28800,'carrierLimits':{'observationSeconds':14700,'cleanupSeconds':600,'softStopSeconds':480,'logBytes':8*1024**2},'state':'original-controller-terminal-observed','stopCause':None,'controllerObserver':{'exitCode':child.returncode,'signal':None,'error':None,'reason':None,'retainedBytes':len(child.stdout)+len(child.stderr),'stopError':None},'log':r.pin((carrier/'controller.log').read_bytes()),'startupInput':startup_pin,'ownerFrame':owner_pin,'ownerAttempt':attempt,'cleanup':{'producer':cleanup,'retention':retention_cleanup},'controllerTerminalSeconds':1.0,'elapsedSeconds':2.0,'startedAt':'2026-01-01T00:00:00.000Z','cutoffAt':'2026-01-01T04:05:00.000Z'}
carrier_value.update(cleanupStartedSeconds=1.0,cleanupDeadlineSeconds=601.0,stopObservation={'ownerAdmissionError':None,'childTerminalObserved':True,'childReaped':True,'softFamilyAbsent':True,'familyAbsent':True,'processGroupId':1001})
for key in ['originalProducerDefaultsOrBudgetChanged','fullEightHourHostedCapacityVerified','originalCommandCompletionClaimed','fullCompilerSdkBootstrapClosureVerified','completeOriginalNoticeClosureVerified','historicalPublisherConsumptionVerified','gateAComplete']:carrier_value[key]=False
carrier_pin=write(carrier/'receipt.json',carrier_value)
observed['carrier']={'receipt':carrier_pin,'ownerFrame':owner_pin,'controllerLog':carrier_value['log']};write(result/'build-observation.json',observed)
archive=root/'gcc-protocol.zip';exporter.export(reviewed,inputs,common,result,startup_file,archive,profile_name='gcc-12',carrier=carrier)
replayed=r.replay(archive,reviewed,'gcc-12');assert replayed['state']=='retained-original-gcc-12-observation-replayed' and replayed['reports']==2 and replayed['observedOutcomeLines']==4 and replayed['testEvidenceState']=='failed' and replayed['gateAComplete'] is False
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
try:r.replay(cutoff_archive,reviewed,'gcc-12')
except ValueError as error:assert 'Incomplete raw C export' in str(error),str(error)
else:raise AssertionError('Actual incomplete cutoff export qualified')
(carrier/'.owner-frame.part').unlink();(result/'build-observation.json').write_bytes(complete_observation);(carrier/'receipt.json').write_bytes(complete_carrier)
rejected_labels=[]
def mutant(label,change,expected_error):
 assert label not in rejected_labels,'Duplicate rejected packet label'
 with zipfile.ZipFile(archive) as z:members={name:z.read(name) for name in z.namelist()}
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
 try:r.replay(target,reviewed,'gcc-12')
 except ValueError as error:
  assert expected_error in str(error),(label,str(error));rejected_labels.append(label);return
 raise AssertionError('Invalid coherently rehashed GCC protocol packet accepted: '+label)
def edit_member(members,name,update):
 value=json.loads(members[name]);update(value);members[name]=json.dumps(value).encode()
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
mutant('short-original-budget',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(originalCommandDeadlineSeconds=14700)),'eight-hour deadline')
mutant('unobserved-cleanup',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x['cleanup']['retention'].update(state='unavailable')),'owned cleanup')
mutant('scope-promoted',lambda m,v:edit_member(m,'carrier/receipt.json',lambda x:x.update(fullEightHourHostedCapacityVerified=0)),'overclaims')
mutant('different-owner',lambda m,v:edit_member(m,'carrier/owner-frame.json',lambda x:x.update(attempt='87654321-1234-4234-8234-123456789012')),'Carrier owner attempt differs')
def cross_preflight(members,manifest):
 edit_member(members,'result/custody-preflight/test-reports.json',lambda x:x.update(profile='gcc-12',generatedBuildRoots=['build','build-cross']))
 edit_member(members,'result/receipt.json',lambda x:x['custodyPreflight'].update(manifest=r.pin(members['result/custody-preflight/test-reports.json'])))
mutant('cross-preflight-profile',cross_preflight,'Wrong original report profile')
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
print(json.dumps({'positivePhysicalGccProtocolReplay':True,'preservedFailedOriginalOutcomes':True,'incompleteCutoffBytesRetained':True,'coherentNegativePacketsRejected':len(rejected_labels),'rejectedPacketLabels':rejected_labels,'nativeCompilerOrRootContainerQualificationPerformed':False,'gateAComplete':False}))
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
      "unobserved-cleanup",
      "scope-promoted",
      "different-owner",
      "cross-preflight-profile",
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
      positivePhysicalGccProtocolReplay: true,
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
