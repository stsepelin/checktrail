import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  validateCObservationHeader,
  validateCObservationRetention,
  verifyCObservationRetainedFiles,
} = await import(
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
const profile = catalog.profiles.glibc;
const catalogSha256 =
  "3e22395e92f732e1b30cf972c6f6d660f5e499562038ed31a342b018f8d481bd";
const terminal = {
  exitCode: 0,
  signal: null,
  error: null,
  reason: null,
  stopError: null,
  retainedBytes: 27,
};
const startup = {
  schemaVersion: 1,
  state: "operator-source-and-caller-frame",
  caller: { uid: 1001, gid: 1001 },
  host: { platform: "linux", architecture: "x64", kernelMachine: "x86_64" },
  sourceOrCompilerExecuted: false,
  hardwareHostAttestationPerformed: false,
  gateAComplete: false,
  selectedProfile: {
    name: "glibc",
    profile: profile.profile,
    sourceVersion: profile.sourceVersion,
    catalogSha256,
  },
};
const syntheticHeader = () => ({
  schemaVersion: 1,
  catalogSha256,
  state: "original-command-completed-qualification-incomplete",
  profile: profile.profile,
  sourceVersion: profile.sourceVersion,
  limits: profile.limits,
  buildExecuted: true,
  originalExecutionInvoked: true,
  executionObserver: { ...terminal },
  originalBuild: {
    schemaVersion: 1,
    command: profile.command,
    invoked: true,
    exitCode: 0,
    wrapperExitCode: 0,
  },
  host: { ...startup.host, capturedCaller: startup.caller },
  custodyPreflight: {
    state: "selected-nonroot-caller-export-verified",
    capturedCaller: startup.caller,
    nativeLinuxCrossUidAcceptanceVerified: true,
    sourceOrCompilerInvoked: false,
    observer: { ...terminal },
    cleanup: { state: "absent" },
  },
  cleanup: { state: "removed" },
  retentionObserverCleanup: { state: "absent" },
  retentionObserver: {
    state: "completed",
    terminal: { exitCode: 0, signal: null },
    readOnly: true,
    network: "none",
    capability: "DAC_READ_SEARCH",
    nativeFilesystemQuotaEnforced: false,
  },
  outputs: [{ file: "synthetic_0_amd64.deb", bytes: 1 }],
  nativeFilesystemQuotaEnforced: false,
  fullCompilerSdkBootstrapClosureVerified: false,
  completeOriginalNoticeClosureVerified: false,
  historicalPublisherConsumptionVerified: false,
  gateAComplete: false,
  originalBuildChecksDisabled: false,
  originalDefaultTargetsDisabled: false,
  inputAuthenticationAndFreshnessDisabled: false,
});

test("C observation header schema keeps synthetic protocol controls separate from actual upstream qualification", () => {
  const result = validateCObservationHeader(
    syntheticHeader(),
    profile,
    startup,
    2,
  );
  assert.equal(result.originalCommandExitCode, 0);
  assert.equal(result.originalTestOutcomesPreserved, true);
  assert.equal(result.fullCompilerSdkBootstrapClosureVerified, false);
  assert.equal(result.gateAComplete, false);
  for (const controllerExit of [0, 1, 137, null])
    assert.throws(
      () =>
        validateCObservationHeader(
          syntheticHeader(),
          profile,
          startup,
          controllerExit,
        ),
      /Unexpected original controller exit/,
    );
});

test("GCC live header binds its closed startup profile and preserves the GLIBC custody fixture separately", () => {
  const gcc = catalog.profiles["gcc-12"];
  const header = {
    ...syntheticHeader(),
    profile: gcc.profile,
    sourceVersion: gcc.sourceVersion,
    limits: gcc.limits,
  };
  const gccStartup = {
    ...startup,
    selectedProfile: {
      name: "gcc-12",
      profile: gcc.profile,
      sourceVersion: gcc.sourceVersion,
      catalogSha256,
    },
  };
  assert.equal(
    validateCObservationHeader(header, gcc, gccStartup, 2).gateAComplete,
    false,
  );
  assert.throws(
    () => validateCObservationHeader(header, gcc, startup, 2),
    /Startup/u,
  );
  assert.throws(
    () => validateCObservationHeader(header, profile, gccStartup, 2),
    /Startup/u,
  );
  const changed = {
    ...gccStartup,
    selectedProfile: {
      ...gccStartup.selectedProfile,
      catalogSha256: "0".repeat(64),
    },
  };
  assert.throws(
    () => validateCObservationHeader(header, gcc, changed, 2),
    /Startup/u,
  );
});
test("C observation refuses incomplete terminal, stale profile, wrong caller and empty physical output declarations", () => {
  const changes: ((value: ReturnType<typeof syntheticHeader>) => void)[] = [
    (r) => {
      r.executionObserver.exitCode = 1;
    },
    (r) => {
      Object.assign(r.executionObserver, { signal: "SIGTERM" });
    },
    (r) => {
      Object.assign(r.executionObserver, { error: "synthetic spawn failure" });
    },
    (r) => {
      Object.assign(r.executionObserver, { reason: "deadline" });
    },
    (r) => {
      Object.assign(r.executionObserver, {
        stopError: "synthetic cleanup failure",
      });
    },
    (r) => {
      Object.assign(r.executionObserver, { truncated: true });
    },
    (r) => {
      r.originalBuild.invoked = false;
    },
    (r) => {
      r.originalBuild.exitCode = 2;
    },
    (r) => {
      r.profile = "stale-profile";
    },
    (r) => {
      r.sourceVersion = "2.36-9+deb12u13";
    },
    (r) => {
      r.custodyPreflight.nativeLinuxCrossUidAcceptanceVerified = false;
    },
    (r) => {
      r.custodyPreflight.capturedCaller = { uid: 1002, gid: 1001 };
    },
    (r) => {
      r.outputs = [];
    },
    (r) => {
      r.outputs[0]!.bytes = 0;
    },
    (r) => {
      r.gateAComplete = true;
    },
  ];
  for (const change of changes) {
    const value = structuredClone(syntheticHeader());
    change(value);
    assert.throws(() => validateCObservationHeader(value, profile, startup, 2));
  }
});
const retainedBuildScope =
  "Directory identity before and after positive producer stop; not a continuous content trace";
const syntheticRetention = (caller = startup.caller) => {
  const identity = [
    "1",
    "2",
    String(0o40700),
    String(caller.uid),
    String(caller.gid),
  ];
  const command = (phase: "requested" | "terminal") => ({
    state: "retained",
    file: "original-command-" + phase + ".json",
    value: {
      schemaVersion: 1,
      kind: "original-command-" + phase,
      command: profile.command,
      invocationRequested: true,
      commandTerminalObserved: phase === "terminal",
      exitCode: phase === "terminal" ? 0 : null,
      wrapperTerminalObserved: false,
      wrapperExitCode: null,
    },
  });
  return {
    ...syntheticHeader(),
    schemaVersion: 2,
    retentionTransportPolicy: {
      sampleIntervalMs: 10000,
      maximumSamples: 9000,
      maximumLogBytes: 268435456,
      workObjectPolicy: "c-build-links-and-specials-no-follow",
    },
    retentionObserver: {
      ...syntheticHeader().retentionObserver,
      workObjectPolicy: "c-build-links-and-specials-no-follow",
    },
    retainedBuildRoot: {
      scope: retainedBuildScope,
      before: [...identity],
      afterStop: [...identity],
      namedAfterStop: [...identity],
    },
    nativeBuildRootClose: { state: "closed" },
    collectionFailures: [] as string[],
    commandObservations: {
      requested: command("requested"),
      terminal: command("terminal"),
    },
    reportRetention: {
      source: "original-trap",
      manifest: "work/test-reports.json",
      root: "work/original-test-reports",
    },
    postStopCleanup: { state: "not-started" },
  };
};
const withPostStopRetention = (header = syntheticRetention()) => ({
  ...header,
  reportRetention: {
    source: "post-stop",
    manifest: "work/post-stop-reports/test-reports.json",
    root: "work/post-stop-reports/original-test-reports",
  },
  postStopRetention: {
    originalCodeExecuted: false,
    primary: null,
    observer: { ...terminal },
    cleanup: { state: "removed", id: "synthetic-collector" },
  },
  postStopCleanup: { state: "absent", id: "synthetic-collector" },
});

test("C live headers accept both fixed report epochs for each supported profile and retain legacy limits", () => {
  const legacy = validateCObservationRetention(
    syntheticHeader(),
    startup.caller,
  );
  assert.equal(legacy.observerLogByteLimit, 16 * 1024 ** 2);
  assert.equal(legacy.cBuildWork, false);
  for (const name of ["glibc", "glibc-u13", "gcc-12"]) {
    const selected = catalog.profiles[name];
    assert.ok(selected, "Missing fixed profile " + name);
    const selectedStartup = {
      ...startup,
      selectedProfile: {
        name,
        profile: selected.profile,
        sourceVersion: selected.sourceVersion,
        catalogSha256,
      },
    };
    for (const header of [syntheticRetention(), withPostStopRetention()]) {
      Object.assign(header, {
        profile: selected.profile,
        sourceVersion: selected.sourceVersion,
        limits: selected.limits,
      });
      const result = validateCObservationHeader(
        header,
        selected,
        selectedStartup,
        2,
      );
      assert.equal(result.gateAComplete, false);
      assert.equal(result.originalCommandExitCode, 0);
      const format = validateCObservationRetention(header, startup.caller);
      assert.equal(format.observerLogByteLimit, 256 * 1024 ** 2);
      assert.equal(format.maximumSamples, 9000);
      assert.equal(format.reportsRoot, header.reportRetention.root);
    }
  }
});

test("C live retention refuses altered policy, journal phases, root custody and report selection", () => {
  const mutations: [
    string,
    (header: ReturnType<typeof syntheticRetention>) => void,
  ][] = [
    [
      "unknown schema",
      (h) => {
        h.schemaVersion = 3;
      },
    ],
    [
      "schema downgrade",
      (h) => {
        h.schemaVersion = 1;
      },
    ],
    [
      "caller-selected byte cap",
      (h) => {
        h.retentionTransportPolicy.maximumLogBytes += 1;
      },
    ],
    [
      "caller-selected sample cap",
      (h) => {
        h.retentionTransportPolicy.maximumSamples += 1;
      },
    ],
    [
      "caller-selected sample interval",
      (h) => {
        h.retentionTransportPolicy.sampleIntervalMs -= 1;
      },
    ],
    [
      "unknown work policy",
      (h) => {
        h.retentionObserver.workObjectPolicy = "follow-links";
      },
    ],
    [
      "collection failure",
      (h) => {
        h.collectionFailures.push("reports unavailable");
      },
    ],
    [
      "unclosed root",
      (h) => {
        h.nativeBuildRootClose.state = "open";
      },
    ],
    [
      "root replacement",
      (h) => {
        h.retainedBuildRoot.namedAfterStop[1] = "3";
      },
    ],
    [
      "root FD replacement",
      (h) => {
        h.retainedBuildRoot.afterStop[1] = "3";
      },
    ],
    [
      "ambiguous root scope",
      (h) => {
        h.retainedBuildRoot.scope = "continuous trace";
      },
    ],
    [
      "leading zero identity",
      (h) => {
        for (const row of [
          h.retainedBuildRoot.before,
          h.retainedBuildRoot.afterStop,
          h.retainedBuildRoot.namedAfterStop,
        ])
          row[0] = "01";
      },
    ],
    [
      "zero root device",
      (h) => {
        for (const row of [
          h.retainedBuildRoot.before,
          h.retainedBuildRoot.afterStop,
          h.retainedBuildRoot.namedAfterStop,
        ])
          row[0] = "0";
      },
    ],
    [
      "zero root inode",
      (h) => {
        for (const row of [
          h.retainedBuildRoot.before,
          h.retainedBuildRoot.afterStop,
          h.retainedBuildRoot.namedAfterStop,
        ])
          row[1] = "0";
      },
    ],
    [
      "extra root field",
      (h) => {
        Object.assign(h.retainedBuildRoot, { attested: true });
      },
    ],
    [
      "wrong root mode",
      (h) => {
        for (const row of [
          h.retainedBuildRoot.before,
          h.retainedBuildRoot.afterStop,
          h.retainedBuildRoot.namedAfterStop,
        ])
          row[2] = String(0o40755);
      },
    ],
    [
      "wrong root owner",
      (h) => {
        for (const row of [
          h.retainedBuildRoot.before,
          h.retainedBuildRoot.afterStop,
          h.retainedBuildRoot.namedAfterStop,
        ])
          row[3] = "1002";
      },
    ],
    [
      "wrong root group",
      (h) => {
        for (const row of [
          h.retainedBuildRoot.before,
          h.retainedBuildRoot.afterStop,
          h.retainedBuildRoot.namedAfterStop,
        ])
          row[4] = "1002";
      },
    ],
    [
      "unretained requested journal",
      (h) => {
        h.commandObservations.requested.state = "unavailable";
      },
    ],
    [
      "unretained terminal journal",
      (h) => {
        h.commandObservations.terminal.state = "unavailable";
      },
    ],
    [
      "wrong journal basename",
      (h) => {
        h.commandObservations.requested.file =
          "../original-command-requested.json";
      },
    ],
    [
      "requested journal claims terminal",
      (h) => {
        h.commandObservations.requested.value.commandTerminalObserved = true;
      },
    ],
    [
      "terminal journal exit differs",
      (h) => {
        h.commandObservations.terminal.value.exitCode = 1;
      },
    ],
    [
      "terminal journal claims wrapper exit",
      (h) => {
        h.commandObservations.terminal.value.wrapperTerminalObserved = true;
      },
    ],
    [
      "unknown report epoch",
      (h) => {
        h.reportRetention.source = "merged";
      },
    ],
    [
      "arbitrary report root",
      (h) => {
        h.reportRetention.root = "work/other-reports";
      },
    ],
    [
      "arbitrary report manifest",
      (h) => {
        h.reportRetention.manifest = "work/other-reports.json";
      },
    ],
    [
      "missing post-stop collector",
      (h) => {
        Object.assign(
          h.reportRetention,
          withPostStopRetention().reportRetention,
        );
      },
    ],
    [
      "unexpected collector cleanup",
      (h) => {
        h.postStopCleanup.state = "failed";
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const header = syntheticRetention();
    mutate(header);
    assert.throws(
      () => validateCObservationRetention(header, startup.caller),
      Error,
      label,
    );
  }
  const legacy = syntheticHeader();
  Object.assign(legacy.retentionObserver, {
    workObjectPolicy: "c-build-links-and-specials-no-follow",
  });
  assert.throws(() => validateCObservationRetention(legacy, startup.caller));
});

test("C live post-stop retention requires its own complete terminal, cleanup and log bound even when the trap epoch is selected", () => {
  const mutations: [
    string,
    (header: ReturnType<typeof withPostStopRetention>) => void,
  ][] = [
    [
      "collector ran original code",
      (h) => {
        h.postStopRetention.originalCodeExecuted = true;
      },
    ],
    [
      "collector failed",
      (h) => {
        Object.assign(h.postStopRetention, { primary: "collection failed" });
      },
    ],
    [
      "collector nonzero exit",
      (h) => {
        h.postStopRetention.observer.exitCode = 1;
      },
    ],
    [
      "collector interrupted",
      (h) => {
        Object.assign(h.postStopRetention.observer, { signal: "SIGTERM" });
      },
    ],
    [
      "collector cleanup failed",
      (h) => {
        h.postStopRetention.cleanup.state = "failed";
      },
    ],
    [
      "final cleanup failed",
      (h) => {
        h.postStopCleanup.state = "failed";
      },
    ],
    [
      "collector identity changed",
      (h) => {
        h.postStopCleanup.id += "-different";
      },
    ],
    [
      "collector log over bound",
      (h) => {
        h.postStopRetention.observer.retainedBytes = 8 * 1024 ** 2 + 1;
      },
    ],
    [
      "unknown collector field",
      (h) => {
        Object.assign(h.postStopRetention, { profile: profile.profile });
      },
    ],
  ];
  const selectedTrap = withPostStopRetention();
  selectedTrap.reportRetention = syntheticRetention().reportRetention;
  validateCObservationRetention(selectedTrap, startup.caller);
  for (const [label, mutate] of mutations) {
    const header = structuredClone(selectedTrap);
    mutate(header);
    assert.throws(
      () => validateCObservationRetention(header, startup.caller),
      Error,
      label,
    );
  }
});

test(
  "C live retention reads physical journals, held build identity and the separate post-stop collector log",
  {
    skip:
      process.platform === "win32"
        ? "POSIX retained file ownership and no-follow controls"
        : false,
  },
  async (t) => {
    const root = await realpath(await fixture(t, {}));
    const build = path.join(root, "work/native-build");
    await mkdir(build, { recursive: true, mode: 0o700 });
    await chmod(build, 0o700);
    const info = await lstat(build, { bigint: true });
    const caller = { uid: Number(info.uid), gid: Number(info.gid) };
    const header = withPostStopRetention(syntheticRetention(caller));
    const identity = [info.dev, info.ino, info.mode, info.uid, info.gid].map(
      String,
    );
    header.retainedBuildRoot = {
      scope: retainedBuildScope,
      before: [...identity],
      afterStop: [...identity],
      namedAfterStop: [...identity],
    };
    for (const phase of ["requested", "terminal"] as const) {
      const row = header.commandObservations[phase];
      await writeFile(
        path.join(root, "work", row.file),
        JSON.stringify(row.value),
        { flag: "wx", mode: 0o600 },
      );
    }
    const log = path.join(root, "post-stop-reports.log");
    await writeFile(log, Buffer.alloc(terminal.retainedBytes, 0x61), {
      flag: "wx",
      mode: 0o600,
    });
    await verifyCObservationRetainedFiles(root, header, caller);
    const journal = path.join(root, "work/original-command-terminal.json");
    const original = await readFile(journal);
    await writeFile(
      journal,
      JSON.stringify({
        ...header.commandObservations.terminal.value,
        exitCode: 1,
      }),
    );
    await assert.rejects(
      verifyCObservationRetainedFiles(root, header, caller),
      /Physical original C command journal differs/u,
    );
    await writeFile(journal, original);
    await chmod(journal, 0o644);
    await assert.rejects(
      verifyCObservationRetainedFiles(root, header, caller),
      /mode differs/u,
    );
    await chmod(journal, 0o600);
    await writeFile(log, Buffer.alloc(terminal.retainedBytes + 1, 0x61));
    await assert.rejects(
      verifyCObservationRetainedFiles(root, header, caller),
      /collector log differs/u,
    );
    await writeFile(log, Buffer.alloc(terminal.retainedBytes, 0x61));
    await rename(build, build + "-original");
    await mkdir(build, { mode: 0o700 });
    await assert.rejects(
      verifyCObservationRetainedFiles(root, header, caller),
      /Physical retained C build root differs/u,
    );
    await rename(build, build + "-replacement");
    await symlink(build + "-original", build);
    await assert.rejects(
      verifyCObservationRetainedFiles(root, header, caller),
      /Linked path refused/u,
    );
    await unlink(build);
    await rename(build + "-original", build);
    await verifyCObservationRetainedFiles(root, header, caller);
  },
);

test("GLIBC hosted carrier keeps its original budget, bounded export and a branch namespace separate from Binutils and GCC", async () => {
  const workflow = parse(
    await readFile(
      path.join(repository, ".github/workflows/upstream-glibc.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on.push.branches, [
    "pr/upstream-producer/glibc-*",
    "!pr/upstream-producer/glibc-u13-*",
  ]);
  const job = workflow.jobs["original-glibc-observation"];
  assert.ok(job["timeout-minutes"] <= 360);
  assert.equal(profile.limits.deadlineSeconds, 14400);
  assert.equal(catalog.profiles["gcc-12"].limits.deadlineSeconds, 43200);
  const steps = job.steps as {
    name?: string;
    run?: string;
    if?: string;
    "timeout-minutes": number;
  }[];
  assert.ok(
    steps.reduce((sum, step) => sum + step["timeout-minutes"], 0) <=
      job["timeout-minutes"],
  );
  const run = steps.find((step) => step.name?.includes("four-hour"));
  assert.ok(run && typeof run.run === "string");
  assert.ok(
    run?.run?.includes("--profile glibc") &&
      run.run.includes("--operator-trust-execution --coordinated-heavy-slot"),
  );
  assert.ok(run["timeout-minutes"] > profile.limits.deadlineSeconds / 60);
  const exporter = steps.find((step) => step.name?.includes("full bounded"));
  assert.equal(exporter?.if, "always()");
  assert.ok(exporter?.run?.includes("c-producer-export-evidence.py"));
  assert.ok(!steps.some((step) => step.run?.includes("--profile gcc-12")));
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
const failures: string[] = [];
const python = ["python3", "python"].find((executable) => {
  const r = spawnSync(
    executable,
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
  failures.push(executable + ": " + diagnostic(r));
  return false;
});
test(
  "C evidence exports large original logs and independently refuses corrupt bytes, counts, owners, source and incomplete transport",
  {
    skip:
      process.platform === "win32"
        ? "POSIX sameUID export component unavailable on this host"
        : python
          ? false
          : "Verified Python3 data evidence components unavailable: " +
            failures.join("; "),
  },
  async (t) => {
    const root = await fixture(t, {});
    const program = String.raw`
import base64,hashlib,importlib.util,json,os,pathlib,shutil,subprocess,sys,zipfile
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]).resolve()
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
exporter=module('synthetic_export',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
replayer=module('synthetic_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
collector=module('synthetic_copies',repo/'scripts/producer-qualification/c-producer-test-reports.py')
source=root/'synthetic-source';(source/'build-tree/amd64-libc').mkdir(parents=True)
raw=b'PASS: synthetic data line\n'*80000+b'FAIL: preserved failure\nFAILURE: valid near miss\n'
(source/'build-tree/amd64-libc/tests.sum').write_bytes(raw)
log=b'synthetic original log\n'*450000
assert len(raw)>1024**2 and len(log)>8*1024**2
(source/'build-tree/amd64-libc/tests.log').write_bytes(log)
result=root/'result';(result/'work').mkdir(parents=True)
caller={'uid':os.getuid(),'gid':os.getgid()}
collector.collect('glibc',source,result/'work/test-reports.json',caller)
report=json.loads((result/'work/test-reports.json').read_bytes())
reviewed=root/'reviewed-operator-source';reviewed.mkdir()
for name in exporter.SOURCE_FILES:
 p=reviewed/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(repo/name,p)
env=dict(os.environ);env.update(SKIP_CODEX_REVIEW='1',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
git=['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false','-c','commit.gpgsign=false']
for args in [['init','--quiet'],['add','--',*exporter.SOURCE_FILES],['-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','Synthetic evidence source frame']]:
 p=subprocess.run(git+args,cwd=reviewed,env=env,capture_output=True,timeout=10);assert p.returncode==0,p.stderr
head=subprocess.check_output(git+['rev-parse','HEAD'],cwd=reviewed,env=env).decode().strip()
startup={'schemaVersion':1,'state':'synthetic-data-export-not-native-observation','caller':caller,'gitHead':head,'sourcePins':[{'file':n,**replayer.pin((reviewed/n).read_bytes())} for n in exporter.SOURCE_FILES]}
startup_file=root/'startup.json';startup_file.write_text(json.dumps(startup));startup_file.chmod(0o600)
(root/'inputs').mkdir();(root/'common').mkdir()
(result/'work/output').mkdir();(result/'work/output/synthetic.deb').write_bytes(b'not an actual package')
actual_output=result/'work/output/synthetic.deb'
actual_output_observation={'file':actual_output.name,**replayer.pin(actual_output.read_bytes())}
assert replayer.nonempty_package_outputs([actual_output_observation],32*1024**3)
for name,size in [('empty.deb',0),('near.deb.old',1),('near.udeb.log',1),('../outside.deb',1)]:
 assert not replayer.nonempty_package_outputs([{'file':name,'bytes':size,'sha256':'0'*64}],32*1024**3),'Invalid package output observation accepted: '+repr((name,size))
(result/'work/native-build-worktree.tar').write_bytes(b'excluded synthetic archive')
archive=root/'evidence.zip'
summary=exporter.export(reviewed,root/'inputs',root/'common',result,startup_file,archive)
packet=replayer.Packet(archive)
try:
 assert packet.read('result/work/original-test-reports/build-tree/amd64-libc/tests.log',64*1024**2)==log
 assert not any(name.endswith(('.deb','.tar')) for name in packet.files)
 parsed=replayer.reports(packet,'result/work/original-test-reports',report,caller,os.geteuid())
 assert parsed['observedOutcomeLines']==80001 and parsed['originalOutcomesPreserved'] and not parsed['reportsPooledAsIndependentEvidence']
 assert parsed['resolvedTestOutcomesObserved'] and parsed['testEvidenceState']=='failed'
 assert replayer.source_frame(packet,reviewed,startup)['exactOriginalGitSourcePins']==len(exporter.SOURCE_FILES)
finally:packet.close()
try:replayer.replay(archive,reviewed)
except ValueError as error:assert 'Incomplete raw C export' in str(error)
else:raise AssertionError('Synthetic failed/raw fixture qualified as original native observation')
def mutated(label,change):
 with zipfile.ZipFile(archive) as z:members={n:z.read(n) for n in z.namelist()}
 manifest=json.loads(members['manifest.json']);change(members,manifest)
 for row in manifest['rawFiles']:
  row.update(replayer.pin(members[row['file']]))
 manifest['uncompressedBytes']=sum(row['bytes'] for row in manifest['rawFiles'])
 manifest['originalReportLogBytes']=sum(row['bytes'] for row in manifest['rawFiles'] if row['file'].startswith('result/work/original-test-reports/'))
 members['manifest.json']=(json.dumps(manifest)+'\n').encode()
 target=root/(label+'.zip')
 with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as z:
  for name,value in members.items():z.writestr(name,value)
 return target
def wrong_owner(members,manifest):
 next(r for r in manifest['rawFiles'] if r['file'].endswith('/tests.sum'))['nativeUid']+=1
owner_packet=replayer.Packet(mutated('wrong-owner',wrong_owner))
try:
 try:replayer.reports(owner_packet,'result/work/original-test-reports',report,caller,os.geteuid())
 except ValueError as error:assert 'owner/group/mode' in str(error)
 else:raise AssertionError('Wrong native owner was accepted')
finally:owner_packet.close()
report_path='result/work/original-test-reports/build-tree/amd64-libc/tests.sum'
def wrong_counts(members,manifest):
 members[report_path]=members[report_path].replace(b'FAIL: preserved failure',b'PASS: preserved failure')
 value=json.loads(members['result/work/test-reports.json']);value['reports'][0].update(replayer.pin(members[report_path]));members['result/work/test-reports.json']=json.dumps(value).encode()
count_packet=replayer.Packet(mutated('wrong-counts',wrong_counts))
try:
 try:replayer.reports(count_packet,'result/work/original-test-reports',count_packet.json('result/work/test-reports.json'),caller,os.geteuid())
 except ValueError as error:assert 'outcome counts differ' in str(error)
 else:raise AssertionError('Coherently rehashed wrong counts were accepted')
finally:count_packet.close()
def stale_source(members,manifest):members['source/scripts/qualify-c-producer.mjs']+=b'\n// synthetic stale source\n'
stale=replayer.Packet(mutated('stale-source',stale_source))
try:
 try:replayer.source_frame(stale,reviewed,startup)
 except ValueError as error:assert 'Stale or changed' in str(error)
 else:raise AssertionError('Stale harness was accepted')
finally:stale.close()
with zipfile.ZipFile(archive) as z:members={n:z.read(n) for n in z.namelist()}
members[report_path]=b'corrupt original data'
corrupt=root/'corrupt.zip'
with zipfile.ZipFile(corrupt,'w') as z:
 for name,value in members.items():z.writestr(name,value)
try:replayer.Packet(corrupt)
except ValueError as error:assert 'length differs' in str(error) or 'Corrupt exported' in str(error)
else:raise AssertionError('Corrupt raw report accepted')
process=subprocess.run([sys.executable,'-I','-S','-B','-c','print("synthetic foreground data")'],capture_output=True,timeout=3)
actual={'exitCode':process.returncode,'signal':None,'error':None,'reason':None,'retainedBytes':len(process.stdout)+len(process.stderr),'stopError':None}
replayer.terminal(actual)
for family in ['SKIP','UNSUPPORTED','UNTESTED','UNRESOLVED','ERROR']:
 unavailable=replayer.outcome_availability([{'counts':{family:1}}]);assert not unavailable['resolvedTestOutcomesObserved'] and unavailable['testEvidenceState']=='unavailable','Unavailable-only outcome was relabeled resolved: '+family
for family,state in [('PASS','reported'),('FAIL','failed'),('XFAIL','reported'),('XPASS','failed')]:
 resolved=replayer.outcome_availability([{'counts':{family:1}}]);assert resolved['resolvedTestOutcomesObserved'] and resolved['testEvidenceState']==state,'Resolved outcome state differed: '+family
for family,state in [('UNRESOLVED','failed'),('UNSUPPORTED','reported'),('SKIP','reported')]:
 mixed=replayer.outcome_availability([{'counts':{'PASS':1,family:1}}]);assert mixed['resolvedTestOutcomesObserved'] and mixed['testEvidenceState']==state,'Mixed resolved outcome state differed: '+family
for field,value in [('exitCode',None),('signal','SIGTERM'),('error','synthetic'),('reason','deadline'),('stopError','cleanup'),('retainedBytes',-1),('truncated',True)]:
 bad=dict(actual);bad[field]=value
 try:replayer.terminal(bad)
 except ValueError:pass
 else:raise AssertionError('Incomplete foreground dimension accepted')
ready={'schemaVersion':1,'kind':'ready','roots':['/observed/bundle','/observed/controls','/observed/work']}
sample={'schemaVersion':1,'kind':'sample','sequence':1,'bytes':123,'files':2,'directories':3}
def chunk(stream,value):return json.dumps({'stream':stream,'base64':base64.b64encode((json.dumps(value,separators=(',',':'))+'\n').encode()).decode()}).encode()+b'\n'
transport=chunk('stdout',ready)+chunk('stdin',{'schemaVersion':1,'kind':'sample','sequence':1})+chunk('stdout',sample)
transport_receipt={'retainedLogBytes':len(transport),'log':replayer.pin(transport),'samples':1,'lastSample':sample}
assert replayer.retention(transport,transport_receipt)==sample
incomplete=chunk('stdout',ready)+chunk('stdin',{'schemaVersion':1,'kind':'sample','sequence':1})
bad=dict(transport_receipt);bad.update(retainedLogBytes=len(incomplete),log=replayer.pin(incomplete))
try:replayer.retention(incomplete,bad)
except ValueError as error:assert 'Incomplete observer' in str(error)
else:raise AssertionError('Incomplete observer request/response accepted')
print(json.dumps({'sameUidPhysicalExport':True,'largeOriginalLogBytes':len(log),'largeOriginalReportBytes':len(raw),'countsCorruptionOwnerSourceAndTerminalControls':True,'actualNativeCompilerOrRootContainerQualification':False,'gateAComplete':False}))
`;
    const result = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, repository, root],
      { encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.sameUidPhysicalExport, true);
    assert.ok(observed.largeOriginalLogBytes > 8 * 1024 ** 2);
    assert.ok(observed.largeOriginalReportBytes > 1024 ** 2);
    assert.equal(observed.countsCorruptionOwnerSourceAndTerminalControls, true);
    assert.equal(
      observed.actualNativeCompilerOrRootContainerQualification,
      false,
    );
    assert.equal(observed.gateAComplete, false);
  },
);
