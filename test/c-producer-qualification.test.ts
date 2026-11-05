import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isBuiltin } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { fixture as sourceFixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const api = await import(
  pathToFileURL(path.join(repository, "scripts/qualify-c-producer.mjs")).href
);
const profiles = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-profile.mjs",
    ),
  ).href
);
const acquisition = await import(
  pathToFileURL(path.join(repository, "scripts/acquire-c-producer-inputs.mjs"))
    .href
);
const fixture = async (
  t: Parameters<typeof sourceFixture>[0],
  files: Record<string, string>,
) => realpath(await sourceFixture(t, files));
const terminal = {
  exitCode: 0,
  signal: null,
  error: null,
  reason: null,
  stopError: null,
  retainedBytes: 27,
};
const command = {
  schemaVersion: 1,
  command: ["dpkg-buildpackage", "-b", "-us", "-uc", "--jobs=4"],
  invoked: true,
  exitCode: 0,
  wrapperExitCode: 0,
};
const sameUidCaller =
  process.platform !== "win32" ? api.captureCProducerCallerIdentity() : null;
const sameUidControl = {
  skip: sameUidCaller
    ? false
    : "POSIX sameUID copy custody is unavailable on this host",
};

const commandObservation = (
  phase: "requested" | "terminal",
  exitCode: number | null = null,
) => ({
  schemaVersion: 1,
  kind: "original-command-" + phase,
  command: command.command,
  invocationRequested: true,
  commandTerminalObserved: phase === "terminal",
  exitCode,
  wrapperTerminalObserved: false,
  wrapperExitCode: null,
});

test("C command request and genuine terminal observations cannot claim a wrapper or invented exit", () => {
  const requested = commandObservation("requested");
  const terminal = commandObservation("terminal", 0);
  assert.deepEqual(
    api.validateCProducerCommandObservation(requested, "requested"),
    requested,
  );
  for (const code of [0, 7, 255])
    api.validateCProducerCommandObservation(
      commandObservation("terminal", code),
      "terminal",
    );
  for (const bad of [null, -1, 256, "0", false, 0.5]) {
    assert.throws(() =>
      api.validateCProducerCommandObservation(
        { ...terminal, exitCode: bad },
        "terminal",
      ),
    );
  }
  for (const changed of [
    { ...requested, exitCode: 0 },
    { ...requested, invocationRequested: false },
    { ...terminal, wrapperTerminalObserved: true },
    { ...terminal, wrapperExitCode: 0 },
    { ...terminal, commandTerminalObserved: false },
    { ...terminal, extra: true },
    { ...terminal, command: [...command.command, "--nocheck"] },
  ])
    assert.throws(() =>
      api.validateCProducerCommandObservation(
        changed,
        changed.kind.endsWith("requested") ? "requested" : "terminal",
      ),
    );
  assert.throws(() =>
    api.validateCProducerCommandObservation(requested, "terminal"),
  );
  const observations = {
    requested: { state: "retained", value: requested },
    terminal: { state: "retained", value: terminal },
  };
  api.validateCProducerCommandObservations(command, observations);
  api.validateCProducerCommandObservations(
    { ...command, exitCode: null },
    { ...observations, terminal: { state: "unavailable" } },
  );
  api.validateCProducerCommandObservations(
    { ...command, invoked: false, exitCode: null },
    { requested: observations.requested },
  );
  assert.throws(
    () =>
      api.validateCProducerCommandObservations(
        { ...command, exitCode: 7 },
        observations,
      ),
    /differs/,
  );
  assert.throws(
    () =>
      api.validateCProducerCommandObservations(
        { ...command, exitCode: null },
        observations,
      ),
    /Unobserved/,
  );
  assert.throws(
    () =>
      api.validateCProducerCommandObservations(
        { ...command, invoked: false },
        observations,
      ),
    /uninvoked/,
  );
  assert.throws(
    () =>
      api.validateCProducerCommandObservations(command, {
        terminal: observations.terminal,
      }),
    /Missing/,
  );
});

test("C evidence format admits only the two closed retention epochs and preserves legacy quotas", async (t) => {
  const policy = {
    sampleIntervalMs: 10000,
    maximumSamples: 9000,
    maximumLogBytes: 256 * 1024 ** 2,
    workObjectPolicy: "c-build-links-and-specials-no-follow",
  };
  const legacy = api.cProducerEvidenceFormat({ schemaVersion: 1 });
  assert.equal(legacy.cBuildWork, false);
  assert.equal(legacy.observerLogByteLimit, 16 * 1024 ** 2);
  for (const source of ["original-trap", "post-stop"]) {
    const prefix =
      source === "original-trap" ? "work" : "work/post-stop-reports";
    const receipt = {
      schemaVersion: 2,
      retentionTransportPolicy: policy,
      reportRetention: {
        source,
        manifest: prefix + "/test-reports.json",
        root: prefix + "/original-test-reports",
      },
    };
    const format = api.cProducerEvidenceFormat(receipt);
    assert.equal(format.cBuildWork, true);
    assert.equal(format.observerLogByteLimit, policy.maximumLogBytes);
    assert.equal(format.maximumSamples, 9000);
    for (const changed of [
      { ...receipt, schemaVersion: 1 },
      { ...receipt, schemaVersion: 3 },
      {
        ...receipt,
        retentionTransportPolicy: {
          ...policy,
          maximumLogBytes: policy.maximumLogBytes + 1,
        },
      },
      {
        ...receipt,
        retentionTransportPolicy: { ...policy, maximumSamples: "9000" },
      },
      { ...receipt, retentionTransportPolicy: { ...policy, extra: true } },
      ...["other", "post-stop-near"].map((source) => ({
        ...receipt,
        reportRetention: { ...receipt.reportRetention, source },
      })),
      {
        ...receipt,
        reportRetention: {
          ...receipt.reportRetention,
          root: "work/../foreign",
        },
      },
      {
        ...receipt,
        reportRetention: { ...receipt.reportRetention, extra: true },
      },
    ])
      assert.throws(() => api.cProducerEvidenceFormat(changed));
  }
  const root = await fixture(t, { "retention-observer.jsonl": "exact" });
  const file = path.join(root, "retention-observer.jsonl");
  assert.equal(
    (
      await api.boundedCProducerRetentionBytes(file, policy.maximumLogBytes)
    ).toString(),
    "exact",
  );
  assert.equal(
    (await api.boundedCProducerRetentionBytes(file, 5)).toString(),
    "exact",
  );
  await assert.rejects(
    api.boundedCProducerRetentionBytes(file, 4),
    /exceeds read bound/,
  );
  await assert.rejects(
    api.boundedCProducerRetentionBytes(file, policy.maximumLogBytes + 1),
    /Finite result/,
  );
  await assert.rejects(
    api.boundedCProducerRetentionBytes(
      path.join(root, "foreign"),
      policy.maximumLogBytes,
    ),
    Error,
  );
  await assert.rejects(
    api.boundedCProducerBytes(file, 64 * 1024 ** 2 + 1),
    /Finite result/,
  );
});

async function syntheticRootMetadataReports(
  t: Parameters<typeof fixture>[0],
  work: string,
) {
  const report = await reportFixture(t);
  await rename(report.root, path.join(work, "original-test-reports"));
  // Only the declared producer UID is authored as root to reach controller
  // policy branches. Physical files remain same-UID; this is no native proof.
  report.value.exportCustody.producerEffectiveUid = 0;
  await writeFile(
    path.join(work, "test-reports.json"),
    JSON.stringify(report.value),
    { mode: 0o600 },
  );
  return report;
}

test(
  "C evidence recovery retains reports and every independent artifact when the final shell record is missing",
  sameUidControl,
  async (t) => {
    const { profile } = await profiles.loadCProducerProfile("glibc");
    const work = await fixture(t, {
      "output/generated.deb": "package",
      "native-build-worktree.tar": "archive",
      "installed-build-package-identities.txt": "packages",
    });
    const order: string[] = [];
    let collects = 0;
    const result = await api.collectCProducerEvidence({
      work,
      profile,
      caller: sameUidCaller,
      executionObserver: null,
      stop: async () => {
        order.push("stop");
        return { state: "removed" };
      },
      verifyBuildRoot: async () => {
        order.push("root");
        return { syntheticRootWitness: true };
      },
      retainReports: async (post: string) => {
        order.push("collect");
        collects++;
        await syntheticRootMetadataReports(t, post);
        return {
          originalCodeExecuted: false,
          primary: null,
          observer: terminal,
          cleanup: { state: "absent" },
        };
      },
    });
    assert.deepEqual(order, ["stop", "root", "collect"]);
    assert.equal(collects, 1);
    assert.deepEqual(result.originalBuild, { invoked: null, exitCode: null });
    assert.deepEqual(result.commandObservations, {
      requested: { state: "unavailable" },
      terminal: { state: "unavailable" },
    });
    assert.equal(result.testEvidence.reports.length, 1);
    assert.equal(result.testEvidence.reports[0].counts.FAIL, 1);
    assert.equal(result.reportRetention.source, "post-stop");
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].file, "generated.deb");
    assert.equal(result.nativeBuildWorktree.bytes, 7);
    assert.equal(result.installedPackageIdentities.bytes, 8);
    assert.deepEqual(
      result.collectionFailures.map((row: { field: string }) => row.field),
      ["originalBuild", "originalTrapReports"],
    );
  },
);

test(
  "C recovery refuses collection before positive absence or after lost raw-root custody",
  sameUidControl,
  async (t) => {
    const { profile } = await profiles.loadCProducerProfile("glibc");
    for (const lostRoot of [false, true]) {
      const work = await fixture(t, {});
      let roots = 0,
        collects = 0;
      const options = {
        work,
        profile,
        caller: sameUidCaller,
        executionObserver: null,
        stop: async () => ({ state: lostRoot ? "absent" : "unknown" }),
        verifyBuildRoot: async () => {
          roots++;
          throw Error("authored held root replaced");
        },
        retainReports: async () => {
          collects++;
          throw Error("collector must not run");
        },
      };
      if (!lostRoot)
        await assert.rejects(
          api.collectCProducerEvidence(options),
          /absence must precede/,
        );
      else {
        const result = await api.collectCProducerEvidence(options);
        assert.deepEqual(
          result.collectionFailures.map((row: { field: string }) => row.field),
          [
            "retainedBuildRoot",
            "originalBuild",
            "originalTrapReports",
            "outputs",
            "nativeBuildWorktree",
            "installedPackageIdentities",
          ],
        );
        assert.match(
          result.collectionFailures[0].error,
          /authored held root replaced/,
        );
      }
      assert.equal(roots, lostRoot ? 1 : 0);
      assert.equal(collects, 0);
      assert.deepEqual(await readdir(work), []);
    }
  },
);

test(
  "C post-stop reports survive collector failures without promoting an incomplete process",
  sameUidControl,
  async (t) => {
    const { profile } = await profiles.loadCProducerProfile("glibc");
    for (const failure of ["primary", "exit", "cleanup", "original-code"]) {
      const work = await fixture(t, {});
      let collects = 0;
      const result = await api.collectCProducerEvidence({
        work,
        profile,
        caller: sameUidCaller,
        executionObserver: null,
        stop: async () => ({ state: "absent" }),
        verifyBuildRoot: async () => ({ synthetic: true }),
        retainReports: async (post: string) => {
          collects++;
          await syntheticRootMetadataReports(t, post);
          return {
            originalCodeExecuted: failure === "original-code",
            primary:
              failure === "primary" ? "authored collector failure" : null,
            observer: { ...terminal, exitCode: failure === "exit" ? 7 : 0 },
            cleanup: { state: failure === "cleanup" ? "pending" : "absent" },
          };
        },
      });
      assert.equal(collects, 1);
      assert.equal(result.testEvidence.reports.length, 1);
      assert.equal(result.reportRetention.source, "post-stop");
      assert.ok(
        result.collectionFailures.some(
          (row: { field: string }) => row.field === "postStopReportProcess",
        ),
      );
    }
  },
);

test(
  "C natural wrapper and complete original report epoch do not start a second collector",
  sameUidControl,
  async (t) => {
    const { profile } = await profiles.loadCProducerProfile("glibc");
    const work = await fixture(t, {
      "original-command.json": JSON.stringify(command),
      "output/generated.deb": "p",
      "native-build-worktree.tar": "a",
      "installed-build-package-identities.txt": "i",
    });
    await syntheticRootMetadataReports(t, work);
    let collects = 0;
    const result = await api.collectCProducerEvidence({
      work,
      profile,
      caller: sameUidCaller,
      executionObserver: terminal,
      stop: async () => ({ state: "absent" }),
      verifyBuildRoot: async () => ({ synthetic: true }),
      retainReports: async () => {
        collects++;
        throw Error("unnecessary collector");
      },
    });
    assert.equal(collects, 0);
    assert.deepEqual(result.collectionFailures, []);
    assert.equal(result.reportRetention.source, "original-trap");
    assert.equal(result.testEvidence.reports[0].counts.FAIL, 1);
  },
);

test(
  "C actual generated shell preserves genuine command return and collects after EXIT bypass",
  sameUidControl,
  () => {
    assert.ok(
      python,
      "Verified Python3 is required for generated shell controls",
    );
    const child = spawnSync(
      python,
      [
        "-I",
        "-S",
        "-B",
        path.join(repository, "test/fixtures/c-producer-interruption.py"),
        repository,
      ],
      { encoding: "utf8", timeout: 45000, maxBuffer: 1048576 },
    );
    assert.equal(child.error, undefined, diagnostic(child));
    assert.equal(child.status, 0, diagnostic(child));
    assert.deepEqual(JSON.parse(child.stdout), {
      cases: ["success", "retention-failure", "command-failure", "interrupted"],
      commandRuns: 4,
      markerAndManifestRefusals: 13,
      originalProducerExecuted: false,
      sameUidHostCustodyOnly: true,
    });
  },
);

test("C producer selected source frames bind every actual static helper import for all three profiles", async () => {
  for (const name of ["gcc-12", "glibc", "glibc-u13"]) {
    const { profile } = await profiles.loadCProducerProfile(name);
    const bound = new Set<string>([
      "scripts/qualify-c-producer.mjs",
      "scripts/qualify-binutils-producer.mjs",
      ...api
        .cProducerSourceFiles(profile)
        .map((file: string) => "scripts/producer-qualification/" + file),
    ]);
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
            ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)
          ) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        )
          continue;
        const specifier = statement.moduleSpecifier.text;
        if (isBuiltin(specifier)) continue;
        assert.ok(
          specifier.startsWith("."),
          "Unbound non-builtin producer runtime dependency: " + specifier,
        );
        const target = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier),
        );
        assert.ok(
          bound.has(target),
          name +
            " selected source frame omits actual static import: " +
            file +
            " -> " +
            target,
        );
      }
    }
  }
});

test("C producer caller IDs admit root and exact near-bound values without coercing malformed identities", () => {
  assert.deepEqual(api.validateCProducerCallerIdentity(0, 0), {
    uid: 0,
    gid: 0,
  });
  assert.deepEqual(
    api.validateCProducerCallerIdentity(4294967294, 4294967294),
    { uid: 4294967294, gid: 4294967294 },
  );
  for (const bad of [
    -1,
    -0,
    4294967295,
    1.5,
    NaN,
    Infinity,
    "1001",
    true,
    undefined,
    null,
  ]) {
    assert.throws(
      () => api.validateCProducerCallerIdentity(bad, 0),
      /Malformed captured caller/,
    );
    assert.throws(
      () => api.validateCProducerCallerIdentity(0, bad),
      /Malformed captured caller/,
    );
  }
});

test("C producer local ARM daemon permission preserves exact GCC limits and default x64 refusal", async () => {
  const selected = await profiles.loadCProducerProfile("gcc-12");
  const plan = { ...selected, syscallPolicy: null };
  const daemon = {
    OSType: "linux",
    Architecture: "aarch64",
    NCPU: 18,
    MemTotal: 16 * 1024 ** 3,
  };
  assert.throws(() => api.validateCProducerDaemonMetadata(daemon, plan));
  const observed = api.validateCProducerDaemonMetadata(daemon, plan, true);
  assert.equal(observed.observedDaemonArchitecture, "aarch64");
  assert.equal(observed.localArm64DaemonPermissionUsed, true);
  assert.equal(observed.targetAndDaemonArchitecturesDiffer, true);
  assert.equal(observed.emulationImplementation, "unknown");
  assert.equal(observed.hardwareHostAttestationPerformed, false);
  for (const architecture of ["x86_64", "amd64"]) {
    assert.equal(
      api.validateCProducerDaemonMetadata(
        { ...daemon, Architecture: architecture },
        plan,
      ).localArm64DaemonPermissionUsed,
      false,
    );
    assert.throws(() =>
      api.validateCProducerDaemonMetadata(
        { ...daemon, Architecture: architecture },
        plan,
        true,
      ),
    );
  }
  for (const architecture of ["x86_64\n", "amd64\n"])
    assert.throws(() =>
      api.validateCProducerDaemonMetadata(
        { ...daemon, Architecture: architecture },
        plan,
      ),
    );
  for (const patch of [
    { OSType: "darwin" },
    { Architecture: "arm64" },
    { Architecture: "aarch64-extra" },
    { NCPU: 3 },
    { NCPU: "18" },
    { MemTotal: 6442450943 },
    { MemTotal: NaN },
  ])
    assert.throws(() =>
      api.validateCProducerDaemonMetadata({ ...daemon, ...patch }, plan, true),
    );
  for (const edit of [
    (v: typeof plan) => {
      v.profile.sourceVersion = "12.2.0-other";
    },
    (v: typeof plan) => {
      v.profile.sourcePackage = "glibc";
    },
    (v: typeof plan) => {
      v.profile.command = ["dpkg-buildpackage", "-b"];
    },
    (v: typeof plan) => {
      v.profile.limits.deadlineSeconds = 28799;
    },
    (v: typeof plan) => {
      v.profile.limits.deadlineSeconds = 28800;
    },
    (v: typeof plan) => {
      v.profile.limits.deadlineSeconds = 43199;
    },
    (v: typeof plan) => {
      v.profile.limits.deadlineSeconds = 43201;
    },
    (v: typeof plan) => {
      Object.assign(v.profile.limits, { deadlineSeconds: true });
    },
    (v: typeof plan) => {
      v.profile.limits.cpuLimit = 2;
    },
    (v: typeof plan) => {
      v.catalog.platform = "linux/arm64";
    },
    (v: typeof plan) => {
      v.catalog.image = "unselected-image";
    },
  ]) {
    const altered = structuredClone(plan);
    edit(altered);
    assert.throws(() =>
      api.validateCProducerDaemonMetadata(daemon, altered, true),
    );
  }
  const minimum = api.validateCProducerDaemonMetadata(
    { ...daemon, NCPU: 4, MemTotal: 6442450944 },
    plan,
    true,
  );
  assert.equal(minimum.observedDaemonArchitecture, "aarch64");
});

test("C producer local ARM CLI flag cannot grant trust or apply to preparation or GLIBC", () => {
  const prefix = [
    "--profile",
    "gcc-12",
    "--inputs",
    "input",
    "--output",
    "output",
  ];
  assert.deepEqual(
    api.cProducerExecutionOptions([...prefix, "--prepare-only"]),
    { prepare: true, allowLocalArm64Daemon: false },
  );
  const execute = [
    ...prefix,
    "--operator-trust-execution",
    "--coordinated-heavy-slot",
  ];
  assert.deepEqual(api.cProducerExecutionOptions(execute), {
    prepare: false,
    allowLocalArm64Daemon: false,
  });
  assert.deepEqual(
    api.cProducerExecutionOptions([...execute, "--allow-local-arm64-daemon"]),
    { prepare: false, allowLocalArm64Daemon: true },
  );
  for (const args of [
    [...prefix, "--prepare-only", "--allow-local-arm64-daemon"],
    [...prefix, "--allow-local-arm64-daemon"],
    [...prefix, "--operator-trust-execution", "--allow-local-arm64-daemon"],
    [...execute, "--allow-local-arm64-daemon-extra"],
    [...execute, "--allow-local-arm64-daemon", "extra"],
    ["--profile", "glibc", ...execute.slice(2), "--allow-local-arm64-daemon"],
    [
      "--profile",
      "glibc-u13",
      ...execute.slice(2),
      "--allow-local-arm64-daemon",
    ],
  ])
    assert.throws(() => api.cProducerExecutionOptions(args));
});

test("C producer catalog binds both exact source revisions and original finite profiles", async () => {
  const gcc = await profiles.loadCProducerProfile("gcc-12");
  const glibc = await profiles.loadCProducerProfile("glibc");
  assert.equal(gcc.profile.files.length, 241);
  assert.equal(glibc.profile.files.length, 161);
  assert.equal(gcc.profile.limits.deadlineSeconds, 43200);
  assert.equal(glibc.profile.limits.deadlineSeconds, 14400);
  assert.equal(
    gcc.profile.files.find((row: { file: string }) =>
      row.file.endsWith(".orig.tar.gz"),
    ).bytes,
    87090343,
  );
  assert.equal(glibc.profile.sourceVersion, "2.36-9+deb12u14");
  assert.equal(
    glibc.profile.priorDifferentSourceNotRelabeled.version,
    "2.36-9+deb12u13",
  );
  assert.equal(
    glibc.profile.priorDifferentSourceNotRelabeled
      .crossRevisionProducerClosureClaimed,
    false,
  );
  await assert.rejects(profiles.loadCProducerProfile("gcc"), /Unknown closed/);
  for (const mutate of [
    (value: typeof gcc.catalog) => {
      value.profiles["gcc-12"].limits.deadlineSeconds = 21600;
    },
    (value: typeof gcc.catalog) => {
      value.profiles.glibc.sourceVersion = "2.36-9+deb12u13";
    },
    (value: typeof gcc.catalog) => {
      value.profiles.glibc.gateAComplete = true;
    },
    (value: typeof gcc.catalog) => {
      value.profiles["gcc-12"].files[0].file = "../foreign";
    },
  ]) {
    const changed = structuredClone(gcc.catalog);
    mutate(changed);
    assert.throws(() => profiles.validateCProducerCatalog(changed));
  }
  assert.equal(
    profiles.safeRelative("apt-archives/gcc-12/file_1%3a5.44-3_amd64.deb"),
    true,
  );
  assert.equal(
    profiles.safeRelative("apt-archives/gcc-12/%2e%2e/foreign"),
    false,
  );
});

test("C producer Docker vector preserves original command time, resource and authentication context", async () => {
  for (const name of ["gcc-12", "glibc", "glibc-u13"]) {
    const { catalog, profile } = await profiles.loadCProducerProfile(name);
    const destination = path.resolve("synthetic-producer-attempt");
    const argv: string[] = api.cProducerArguments(
      catalog,
      profile,
      destination,
      "12345678-1234-4234-8234-123456789012",
      api.validateCProducerCallerIdentity(1001, 1002),
    );
    assert.deepEqual(argv.slice(-9), [
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=30s",
      String(profile.limits.deadlineSeconds),
      "/bin/sh",
      "/controller/c-producer-build.sh",
      name,
      "1001",
      "1002",
    ]);
    assert.equal(argv[argv.indexOf("--cpus") + 1], "4");
    assert.equal(argv[argv.indexOf("--memory") + 1], "6g");
    assert.equal(argv[argv.indexOf("--pids-limit") + 1], "1024");
    assert.equal(argv[argv.indexOf("--network") + 1], "none");
    assert.ok(argv.includes("--pull=never"));
    assert.ok(argv.includes("HOME=/work/home"));
    assert.ok(
      argv.includes(
        `type=bind,src=${path.join(destination, "work/native-build")},target=/build`,
      ),
    );
    const post: string[] = api.cProducerPostStopReportArguments(
      catalog,
      profile,
      destination,
      "12345678-1234-4234-8234-123456789012",
      { uid: 1001, gid: 1002 },
    );
    assert.deepEqual(post.slice(-9), [
      "-I",
      "-S",
      "-B",
      "/controller/c-producer-test-reports.py",
      name,
      "/build/source",
      "/work/test-reports.json",
      "1001",
      "1002",
    ]);
    assert.ok(
      post.includes(
        `type=bind,src=${path.join(destination, "work/native-build")},target=/build,readonly`,
      ),
    );
    assert.ok(
      post.includes(
        `type=bind,src=${path.join(destination, "work/post-stop-reports")},target=/work`,
      ),
    );
    assert.equal(post[post.indexOf("--entrypoint") + 1], "/usr/bin/python3");
    assert.equal(post[post.indexOf("--cpus") + 1], "1");
    assert.equal(post[post.indexOf("--memory") + 1], "1g");
    assert.equal(post[post.indexOf("--pids-limit") + 1], "64");
    assert.equal(post[post.indexOf("--network") + 1], "none");
    assert.ok(post.includes("--read-only") && post.includes("--cap-drop=ALL"));
    assert.deepEqual(
      post.filter((arg) => arg.startsWith("--cap-add=")),
      ["--cap-add=DAC_OVERRIDE", "--cap-add=CHOWN"],
    );
    assert.ok(
      !post.some((arg) =>
        /apt-get|dpkg-buildpackage|native-build-worktree\.tar/u.test(arg),
      ),
    );
    assert.ok(
      argv.includes(
        `type=bind,src=${path.join(destination, "bundle/source")},target=/inputs,readonly`,
      ),
    );
    const preflight: string[] = api.cProducerCustodyPreflightArguments(
      catalog,
      destination,
      "12345678-1234-4234-8234-123456789012",
      api.validateCProducerCallerIdentity(1001, 1002),
    );
    assert.deepEqual(preflight.slice(-4), [
      "--custody-preflight",
      "/custody",
      "1001",
      "1002",
    ]);
    assert.ok(
      preflight.includes("--read-only") && preflight.includes("--pull=never"),
    );
    assert.equal(preflight[preflight.indexOf("--user") + 1], "0:0");
    assert.equal(preflight[preflight.indexOf("--memory") + 1], "128m");
    assert.ok(
      !preflight.some(
        (arg) =>
          arg.includes("target=/inputs") || arg.includes("dpkg-buildpackage"),
      ),
    );
    assert.ok(
      !argv.some((arg) =>
        /nocheck|nocross|disable-multilib|enable-languages/u.test(arg),
      ),
    );
  }
  const shell = await readFile(
    path.join(repository, "scripts/producer-qualification/c-producer-build.sh"),
    "utf8",
  );
  assert.ok(
    shell.includes(
      "dpkg-source --require-valid-signature --require-strong-checksums --extract",
    ),
  );
  assert.ok(shell.includes("Acquire::Check-Valid-Until=true"));
  assert.ok(
    shell.includes("--yes --no-download --no-install-recommends build-dep"),
  );
  assert.ok(
    shell.includes(
      "dpkg-buildpackage -b -us -uc --jobs=4\nchecktrail_command_exit=$?",
    ),
  );
});

test("C producer completion requires physical terminal observation and keeps original test failures scoped", () => {
  const reports = {
    reports: [{ counts: { PASS: 3, FAIL: 1, UNSUPPORTED: 2 } }],
  };
  const outputs = [{ file: "synthetic_1_amd64.deb", bytes: 16 }];
  assert.equal(
    api.cProducerCompletion(command, terminal, outputs, reports)
      .originalCommandCompleted,
    true,
  );
  assert.equal(
    api.cProducerCompletion(command, terminal, outputs, reports).gateAComplete,
    false,
  );
  assert.equal(
    api.cProducerCompletion(command, terminal, outputs, reports)
      .testEvidenceState,
    "failed",
  );
  for (const outcome of [
    "SKIP",
    "UNSUPPORTED",
    "UNTESTED",
    "UNRESOLVED",
    "ERROR",
  ]) {
    const onlyUnavailable = api.cProducerCompletion(
      command,
      terminal,
      outputs,
      { reports: [{ counts: { [outcome]: 1 } }] },
    );
    assert.equal(onlyUnavailable.originalCommandCompleted, false, outcome);
    assert.equal(onlyUnavailable.testEvidenceState, "unavailable", outcome);
  }
  const resolvedOutcomes: readonly (readonly [string, string])[] = [
    ["PASS", "reported"],
    ["FAIL", "failed"],
    ["XFAIL", "reported"],
    ["XPASS", "failed"],
  ];
  for (const [outcome, state] of resolvedOutcomes) {
    const observed = api.cProducerCompletion(command, terminal, outputs, {
      reports: [{ counts: { [outcome]: 1 } }],
    });
    assert.equal(observed.originalCommandCompleted, true, outcome);
    assert.equal(observed.testEvidenceState, state, outcome);
    assert.equal(observed.gateAComplete, false);
  }
  const mixedOutcomes: readonly (readonly [string, string])[] = [
    ["UNRESOLVED", "failed"],
    ["UNSUPPORTED", "reported"],
    ["SKIP", "reported"],
  ];
  for (const [outcome, state] of mixedOutcomes) {
    const mixed = api.cProducerCompletion(command, terminal, outputs, {
      reports: [{ counts: { PASS: 1, [outcome]: 1 } }],
    });
    assert.equal(mixed.originalCommandCompleted, true, outcome);
    assert.equal(mixed.testEvidenceState, state, outcome);
    assert.equal(mixed.gateAComplete, false);
  }
  for (const output of [
    { file: "synthetic.deb", bytes: 0 },
    { file: "synthetic.deb", bytes: -1 },
    { file: "synthetic.deb", bytes: undefined },
    { file: "synthetic.deb.old", bytes: 1 },
    { file: "synthetic.udeb.log", bytes: 1 },
    { file: "../synthetic.deb", bytes: 1 },
  ])
    assert.equal(
      api.cProducerCompletion(command, terminal, [output], reports)
        .originalCommandCompleted,
      false,
    );
  for (const changed of [
    { ...terminal, exitCode: null },
    { ...terminal, signal: "SIGTERM" },
    { ...terminal, error: "synthetic spawn failure" },
    { ...terminal, reason: "output-limit" },
    { ...terminal, stopError: "synthetic cleanup failure" },
    { ...terminal, retainedBytes: -1 },
    { ...terminal, retainedBytes: 512 * 1024 ** 2 + 1 },
    { ...terminal, truncated: true },
  ])
    assert.equal(
      api.cProducerCompletion(command, changed, outputs, reports)
        .originalCommandCompleted,
      false,
    );
  assert.equal(
    api.cProducerCompletion(
      { ...command, invoked: false },
      terminal,
      outputs,
      reports,
    ).originalCommandCompleted,
    false,
  );
  assert.equal(
    api.cProducerCompletion(
      { ...command, exitCode: 2 },
      terminal,
      outputs,
      reports,
    ).originalCommandCompleted,
    false,
  );
  assert.equal(
    api.cProducerCompletion(
      { ...command, wrapperExitCode: 1 },
      terminal,
      outputs,
      reports,
    ).originalCommandCompleted,
    false,
  );
  assert.equal(
    api.cProducerCompletion(
      command,
      terminal,
      [{ file: "synthetic.buildinfo" }],
      reports,
    ).originalCommandCompleted,
    false,
  );
  assert.equal(
    api.cProducerCompletion(command, terminal, outputs, { reports: [] })
      .originalCommandCompleted,
    false,
  );
});

test("C producer download publishes only complete pinned physical bytes and preserves existing targets", async (t) => {
  const root = await fixture(t, { existing: "retained original" });
  const raw = "synthetic archive bytes";
  const pin = { bytes: Buffer.byteLength(raw), sha256: profiles.sha256(raw) };
  const signal = new AbortController().signal;
  const target = path.join(root, "good");
  await acquisition.retainCProducerDownload(
    new Response(raw),
    target,
    pin,
    signal,
  );
  assert.equal(await readFile(target, "utf8"), raw);
  await assert.rejects(
    acquisition.retainCProducerDownload(
      new Response(raw),
      path.join(root, "existing"),
      pin,
      signal,
    ),
    /EEXIST/,
  );
  assert.equal(
    await readFile(path.join(root, "existing"), "utf8"),
    "retained original",
  );
  for (const [name, body, expected] of [
    ["short", raw.slice(1), /incomplete/],
    ["long", raw + "x", /exceeds exact/],
    ["changed", "x".repeat(raw.length), /SHA256 differs/],
  ] as const) {
    await assert.rejects(
      acquisition.retainCProducerDownload(
        new Response(body),
        path.join(root, name),
        pin,
        signal,
      ),
      expected,
    );
    await assert.rejects(readFile(path.join(root, name)), /ENOENT/);
  }
  await assert.rejects(
    acquisition.retainCProducerDownload(
      new Response(raw),
      path.join(root, "aborted"),
      pin,
      AbortSignal.abort(),
    ),
    /interrupted before publication/,
  );
  assert.deepEqual((await readdir(root)).sort(), ["existing", "good"]);
});

test("C producer large-source capability is finite and independent of shared download defaults", async (t) => {
  const root = await fixture(t, {});
  const target = path.join(root, "archive");
  await assert.rejects(
    acquisition.retainCProducerDownload(
      new Response(""),
      target,
      { bytes: 87090343, sha256: "0".repeat(64) },
      new AbortController().signal,
    ),
    /incomplete/,
  );
  await assert.rejects(
    acquisition.retainCProducerDownload(
      new Response(""),
      target,
      { bytes: 128 * 1024 ** 2 + 1, sha256: "0".repeat(64) },
      new AbortController().signal,
    ),
    /Finite C producer input bound/,
  );
  assert.deepEqual(await readdir(root), []);
  for (const url of [
    "http://deb.debian.org/debian/pool/a",
    "https://deb.debian.org.evil.invalid/debian/pool/a",
    "https://user@deb.debian.org/debian/pool/a",
    "https://snapshot.debian.org/file/a?token=x",
    "https://deb.debian.org/arbitrary/a",
  ])
    assert.throws(() => acquisition.validateCProducerDownloadUrl(url));
  assert.equal(
    acquisition.validateCProducerDownloadUrl(
      "https://snapshot.debian.org/file/123abc",
    ),
    "https://snapshot.debian.org/file/123abc",
  );
});

async function reportFixture(t: Parameters<typeof fixture>[0]) {
  const raw =
    "PASS: first\nFAIL: second\nFAILURE: valid near miss\nUNSUPPORTED: third\n";
  const root = await fixture(t, { "build-tree/amd64-libc/tests.sum": raw });
  const counts = {
    PASS: 1,
    FAIL: 1,
    XFAIL: 0,
    XPASS: 0,
    UNSUPPORTED: 1,
    UNRESOLVED: 0,
    UNTESTED: 0,
    ERROR: 0,
    SKIP: 0,
  };
  const value = {
    schemaVersion: 1,
    profile: "glibc",
    generatedBuildRoots: ["build-tree"],
    reports: [
      {
        file: "build-tree/amd64-libc/tests.sum",
        configuration: "build-tree",
        format: "original-sum",
        bytes: Buffer.byteLength(raw),
        sha256: profiles.sha256(raw),
        counts,
        totalLines: 4,
        otherLines: 1,
      },
    ],
    retainedBytes: Buffer.byteLength(raw),
    skippedLinkedDirectories: [],
    completeConfigurationInventoryAssessed: false,
    duplicateReportsAreIndependentEvidence: false,
    allOriginalTestsPassRequired: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    gateAComplete: false,
    exportCustody: await syntheticSameUidCustody(root, [
      "build-tree/amd64-libc/tests.sum",
    ]),
  };
  return { root, raw, value };
}
test(
  "C producer outcome reconciliation rederives failures and rejects changed physical reports",
  sameUidControl,
  async (t) => {
    const { profile } = await profiles.loadCProducerProfile("glibc");
    const { root, raw, value } = await reportFixture(t);
    const result = await api.verifyCProducerReports(
      value,
      root,
      profile,
      sameUidCaller,
    );
    assert.equal(result.reports[0].counts.FAIL, 1);
    assert.equal(result.completeConfigurationInventoryAssessed, false);
    const changed = structuredClone(value);
    changed.reports[0]!.counts.FAIL = 0;
    await assert.rejects(
      api.verifyCProducerReports(changed, root, profile, sameUidCaller),
      /physical bytes/,
    );
    await assert.rejects(
      api.verifyCProducerReports(
        { ...value, retainedBytes: 0 },
        root,
        profile,
        sameUidCaller,
      ),
      /aggregate differs/,
    );
    await writeFile(
      path.join(root, value.reports[0]!.file),
      raw.replace("FAIL:", "PASS:"),
    );
    await assert.rejects(
      api.verifyCProducerReports(value, root, profile, sameUidCaller),
      /Expected values to be strictly deep-equal/,
    );
  },
);

test(
  "C producer result inventories refuse source-fixture reports and duplicate configurations",
  sameUidControl,
  async (t) => {
    const { profile } = await profiles.loadCProducerProfile("glibc");
    const { root, value } = await reportFixture(t);
    const duplicate = structuredClone(value);
    duplicate.reports.push(duplicate.reports[0]!);
    await assert.rejects(
      api.verifyCProducerReports(duplicate, root, profile, sameUidCaller),
      /Foreign or duplicate/,
    );
    const foreign = structuredClone(value);
    foreign.reports[0]!.file = "src/tests.sum";
    await assert.rejects(
      api.verifyCProducerReports(foreign, root, profile, sameUidCaller),
      /Foreign or duplicate/,
    );
    await assert.rejects(
      api.mainCProducer([
        "--profile",
        "glibc",
        "--inputs",
        root,
        "--output",
        path.join(root, "new"),
        "--project-trust-execution",
      ]),
      /two explicit operator flags/,
    );
  },
);

async function syntheticSameUidCustody(root: string, files: string[]) {
  assert.ok(sameUidCaller);
  const directories = new Set(["."]);
  for (const file of files) {
    const parts = file.split("/");
    for (let count = 1; count < parts.length; count++)
      directories.add(parts.slice(0, count).join("/"));
  }
  const observe = async (relative: string, mode: number) => {
    const file = path.join(root, relative);
    await chmod(file, mode);
    const actual = await lstat(file, { bigint: true });
    return {
      uid: Number(actual.uid),
      gid: Number(actual.gid),
      mode: Number(actual.mode & 0o7777n),
      producerDevice: String(actual.dev),
      producerInode: String(actual.ino),
    };
  };
  const observedDirectories = [];
  for (const directory of directories)
    observedDirectories.push({
      directory,
      ownership: await observe(directory, 0o700),
    });
  const observedFiles = [];
  for (const file of files)
    observedFiles.push({ file, ownership: await observe(file, 0o600) });
  return {
    schemaVersion: 1,
    requestedCaller: sameUidCaller,
    producerEffectiveUid: process.geteuid!(),
    directories: observedDirectories,
    files: observedFiles,
    newCopyOwnersVerified: true,
    recursiveOwnershipChangeUsed: false,
    sourceTreePermissionsChanged: false,
    nativeLinuxCrossUidAcceptanceVerified: false,
  };
}

test(
  "C producer sameUID host custody checks owner and mode before manifest parsing",
  sameUidControl,
  async (t) => {
    const root = await fixture(t, {
      "manifest.json": "malformed synthetic JSON",
    });
    const file = path.join(root, "manifest.json");
    await chmod(file, 0o644);
    await assert.rejects(
      api.readCProducerCopyManifest(file, sameUidCaller),
      /Copied export mode differs/,
    );
    await chmod(file, 0o600);
    await assert.rejects(
      api.readCProducerCopyManifest(file, sameUidCaller),
      SyntaxError,
    );
    await writeFile(file, '{"synthetic":true}');
    assert.deepEqual(await api.readCProducerCopyManifest(file, sameUidCaller), {
      synthetic: true,
    });
    await assert.rejects(
      api.readCProducerCopyManifest(file, {
        ...sameUidCaller,
        uid: sameUidCaller.uid + 1,
      }),
      /Copied export owner differs/,
    );
    await assert.rejects(
      api.readCProducerCopyManifest(file, {
        ...sameUidCaller,
        gid: sameUidCaller.gid + 1,
      }),
      /Copied export group differs/,
    );
    const { root: copies, value } = await reportFixture(t);
    const { profile } = await profiles.loadCProducerProfile("glibc");
    const wrong = { ...sameUidCaller, uid: sameUidCaller.uid + 1 };
    await assert.rejects(
      api.verifyCProducerReports(value, copies, profile, wrong),
      /different caller/,
    );
    const changed = structuredClone(value);
    changed.exportCustody.requestedCaller = wrong;
    await assert.rejects(
      api.verifyCProducerReports(changed, copies, profile, sameUidCaller),
      /different caller/,
    );
    await chmod(path.join(copies, value.reports[0]!.file), 0o644);
    await assert.rejects(
      api.verifyCProducerReports(value, copies, profile, sameUidCaller),
      /Copied export mode differs/,
    );
    await chmod(path.join(copies, value.reports[0]!.file), 0o600);
    await chmod(path.join(copies, "build-tree"), 0o755);
    await assert.rejects(
      api.verifyCProducerReports(value, copies, profile, sameUidCaller),
      /Copied export mode differs/,
    );
  },
);

test("C producer physical result reader enforces exact bytes and its finite read bound", async (t) => {
  const root = await fixture(t, { result: "synthetic retained result" });
  const target = path.join(root, "result");
  assert.equal(
    (await api.boundedCProducerBytes(target, 64)).toString("utf8"),
    "synthetic retained result",
  );
  await assert.rejects(
    api.boundedCProducerBytes(target, 5),
    /Physical result exceeds read bound/,
  );
  await assert.rejects(
    api.boundedCProducerBytes(target, 64 * 1024 ** 2 + 1),
    /Finite result read bound refused/,
  );
  if (process.platform !== "win32") {
    await symlink(target, path.join(root, "linked"));
    await assert.rejects(
      api.boundedCProducerBytes(path.join(root, "linked"), 64),
      /Linked path refused/,
    );
  }
});

const diagnostic = (result: SpawnSyncReturns<string>) =>
  [
    result.error?.message,
    `status=${String(result.status)} signal=${String(result.signal)}`,
    result.stdout,
    result.stderr,
  ]
    .filter(Boolean)
    .join("\n");
const probes: string[] = [];
const python = ["python3", "python"].find((executable) => {
  const result = spawnSync(
    executable,
    ["-I", "-S", "-B", "-c", "import sys; print(sys.version_info.major)"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  if (
    !result.error &&
    result.status === 0 &&
    result.signal === null &&
    result.stdout.trim() === "3"
  )
    return true;
  probes.push(executable + ": " + diagnostic(result));
  return false;
});
test(
  "C producer physical Python collector retains generated failures and excludes source fixtures",
  {
    skip: !sameUidCaller
      ? "POSIX sameUID export custody control unavailable on this host"
      : python
        ? false
        : "Verified Python3 data collector unavailable: " + probes.join("; "),
  },
  async (t) => {
    const root = await fixture(t, {
      "source/build-tree/amd64-libc/tests.sum": "PASS: first\nFAIL: second\n",
      "source/build-tree/amd64-libc/elf/tests.sum": "FAIL: second\n",
      "source/src/fixtures.sum": "PASS: fixture only\n",
      "output/.keep": "",
    });
    const execute = (output: string) =>
      spawnSync(
        python!,
        [
          "-I",
          "-S",
          "-B",
          path.join(
            repository,
            "scripts/producer-qualification/c-producer-test-reports.py",
          ),
          "glibc",
          path.join(root, "source"),
          path.join(root, output, "test-reports.json"),
          String(sameUidCaller.uid),
          String(sameUidCaller.gid),
        ],
        { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
      );
    const result = execute("output");
    assert.equal(result.status, 0, diagnostic(result));
    const value = await api.readCProducerCopyManifest(
      path.join(root, "output/test-reports.json"),
      sameUidCaller,
    );
    assert.deepEqual(
      value.reports.map((row: { file: string }) => row.file).sort(),
      [
        "build-tree/amd64-libc/elf/tests.sum",
        "build-tree/amd64-libc/tests.sum",
      ],
    );
    assert.equal(
      value.reports.every(
        (row: { counts: { FAIL: number } }) => row.counts.FAIL === 1,
      ),
      true,
    );
    assert.equal(value.duplicateReportsAreIndependentEvidence, false);
    const { profile } = await profiles.loadCProducerProfile("glibc");
    await api.verifyCProducerReports(
      value,
      path.join(root, "output/original-test-reports"),
      profile,
      sameUidCaller,
    );
    assert.equal(value.exportCustody.producerEffectiveUid, process.geteuid!());
    assert.equal(
      value.exportCustody.nativeLinuxCrossUidAcceptanceVerified,
      false,
    );
    if (process.platform !== "win32") {
      await symlink(
        path.join(root, "source/src"),
        path.join(root, "source/build-tree/linked"),
      );
      await mkdir(path.join(root, "linked-output"));
      const linked = execute("linked-output");
      assert.equal(linked.status, 0, diagnostic(linked));
      const observed = await api.readCProducerCopyManifest(
        path.join(root, "linked-output/test-reports.json"),
        sameUidCaller,
      );
      assert.deepEqual(observed.skippedLinkedDirectories, [
        "build-tree/linked",
      ]);
      assert.equal(observed.completeConfigurationInventoryAssessed, false);
    }
  },
);

test(
  "C producer sameUID Python copy custody preserves original failures and refuses reused node identities",
  {
    skip: !sameUidCaller
      ? "POSIX sameUID export custody control unavailable on this host"
      : python
        ? false
        : "Verified Python3 data collector unavailable: " + probes.join("; "),
  },
  async (t) => {
    const root = await fixture(t, {});
    const program = String.raw`
import importlib.util,json,os,pathlib,sys
spec=importlib.util.spec_from_file_location('synthetic_custody',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2]);caller=module.parse_caller_identity(sys.argv[3],sys.argv[4])
controls=[]
for uid,gid in [('-1','0'),('0','-1'),('00','0'),('+1','0'),('4294967295','0'),('1.0','0')]:
 try:module.parse_caller_identity(uid,gid)
 except RuntimeError as error:assert 'Malformed captured caller' in str(error)
 else:raise AssertionError('Malformed IDs were admitted')
controls.append('malformed-ids-refused')
assert module.parse_caller_identity('0','0')=={'uid':0,'gid':0}
assert module.parse_caller_identity('4294967294','4294967294')=={'uid':4294967294,'gid':4294967294}
controls.append('root-and-near-bound-ids-validated-without-chown-claim')
source=root/'source';(source/'build-tree').mkdir(parents=True)
(source/'build-tree/a.sum').write_bytes(b'PASS: retained partial\n')
(source/'build-tree/z.sum').symlink_to(source/'build-tree/a.sum')
before=(source/'build-tree/a.sum').stat()
output=root/'partial';output.mkdir()
original_finish=module.RetainedCopies.finish
def fail_after_handoff(self):
 original_finish(self)
 raise RuntimeError('synthetic custody diagnostic')
module.RetainedCopies.finish=fail_after_handoff
try:
 try:module.collect('glibc',source,output/'test-reports.json',caller)
 except RuntimeError as error:
  assert 'Nonphysical or oversized original report/log' in str(error) and 'synthetic custody diagnostic' in str(error)
  assert error.__cause__ is not None and 'Nonphysical or oversized original report/log' in str(error.__cause__)
 else:raise AssertionError('Original physical-source failure disappeared')
finally:module.RetainedCopies.finish=original_finish
partial=output/'original-test-reports/build-tree/a.sum'
assert partial.read_bytes()==b'PASS: retained partial\n'
assert partial.stat().st_mode&0o7777==0o600
assert (output/'original-test-reports/build-tree').stat().st_mode&0o7777==0o700
assert not (output/'test-reports.json').exists()
after=(source/'build-tree/a.sum').stat()
assert (before.st_uid,before.st_gid,before.st_mode,before.st_mtime_ns)==(after.st_uid,after.st_gid,after.st_mode,after.st_mtime_ns)
controls.append('original-and-custody-errors-preserved-with-readable-partial-copy-source-unchanged')
try:module.RetainedCopies(output/'original-test-reports',caller)
except FileExistsError:pass
else:raise AssertionError('Existing retained namespace was reused')
assert partial.read_bytes()==b'PASS: retained partial\n'
controls.append('existing-namespace-refused-unchanged')
replaced=root/'replaced';copies=module.RetainedCopies(replaced,caller)
try:
 copies.write('nested/result.sum',b'PASS: inode guard\n')
 (replaced/'nested').rename(replaced/'original-node')
 (replaced/'nested').mkdir(mode=0o700)
 foreign=(replaced/'nested').stat()
 try:copies.finish()
 except RuntimeError as error:assert 'directory inode differs' in str(error)
 else:raise AssertionError('Replacement node was handed over as created node')
 assert (replaced/'nested').stat().st_ino==foreign.st_ino
finally:copies.close()
controls.append('replacement-inode-refused')
fd=os.open(root/'foreign-fd',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
original_chown=module.os.fchown;called=[]
def deny_chown(*args):
 called.append(True)
 raise AssertionError('Foreign inode reached ownership mutation')
module.os.fchown=deny_chown
try:
 info=os.fstat(fd)
 try:module.handoff_new_fd(fd,(info.st_dev,info.st_ino+1),{'uid':caller['uid']+1,'gid':caller['gid']},0o600)
 except RuntimeError as error:assert 'FD/inode/mode changed' in str(error)
 else:raise AssertionError('Foreign inode accepted')
 assert not called and os.fstat(fd).st_uid==caller['uid']
finally:module.os.fchown=original_chown;os.close(fd)
controls.append('foreign-fd-refused-before-any-chown-attempt')
zero=module.RetainedCopies(root/'zero-progress',caller)
original_write=module.os.write
module.os.write=lambda *args:0
try:
 try:zero.write('result.sum',b'PASS: not written\n')
 except RuntimeError as error:assert 'writer made no progress' in str(error)
 else:raise AssertionError('Zero-progress writer succeeded')
finally:module.os.write=original_write
try:zero.finish()
finally:zero.close()
assert (root/'zero-progress/result.sum').read_bytes()==b''
assert (root/'zero-progress/result.sum').stat().st_mode&0o7777==0o600
controls.append('zero-progress-writer-refused-with-private-partial-copy-retained')
print(json.dumps({'sameUidHostOnly':True,'actualUid':os.geteuid(),'requestedCaller':caller,'controls':controls,'nativeLinuxCrossUidAcceptanceVerified':False}))
`;
    const result = spawnSync(
      python!,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        program,
        path.join(
          repository,
          "scripts/producer-qualification/c-producer-test-reports.py",
        ),
        root,
        String(sameUidCaller.uid),
        String(sameUidCaller.gid),
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.sameUidHostOnly, true);
    assert.equal(observed.actualUid, sameUidCaller.uid);
    assert.equal(observed.controls.length, 7);
    assert.equal(observed.nativeLinuxCrossUidAcceptanceVerified, false);
  },
);

test(
  "GCC version2 report verification binds every literal root, compatibility origin and nonpassing root state",
  {
    skip: !sameUidCaller
      ? "POSIX sameUID export custody control unavailable on this host"
      : python
        ? false
        : "Verified Python3 data collector unavailable: " + probes.join("; "),
  },
  async (t) => {
    const roots = [
      "build",
      "build-cross",
      "build-jit",
      "build-nvptx",
      "build-gcn",
      "build-hppa64",
    ];
    const copied =
      "PASS: synthetic copied result\nFAIL: preserved copied result\n";
    const root = await fixture(t, {
      "source/build/native.sum": copied,
      "source/build-cross/compat.sum": "XFAIL: synthetic compatibility data\n",
      "source/build-jit/copied.sum": copied,
      "source/build-nvptx/device.sum":
        "UNSUPPORTED: synthetic unavailable data\n",
      "source/build-gcn/device.sum":
        "UNSUPPORTED: synthetic unavailable data\n",
      "source/build-hppa64/target.sum":
        "UNSUPPORTED: synthetic unavailable data\n",
      "source/build-jit-extra/unselected.sum": "PASS: unselected near prefix\n",
      "output/.keep": "",
    });
    const result = spawnSync(
      python!,
      [
        "-I",
        "-S",
        "-B",
        path.join(
          repository,
          "scripts/producer-qualification/c-producer-test-reports.py",
        ),
        "gcc-12",
        path.join(root, "source"),
        path.join(root, "output/test-reports.json"),
        String(sameUidCaller.uid),
        String(sameUidCaller.gid),
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    const value = await api.readCProducerCopyManifest(
      path.join(root, "output/test-reports.json"),
      sameUidCaller,
    );
    const { profile } = await profiles.loadCProducerProfile("gcc-12");
    const copies = path.join(root, "output/original-test-reports");
    const verified = await api.verifyCProducerReports(
      value,
      copies,
      profile,
      sameUidCaller,
    );
    type RootState = {
      root: string;
      origin: string;
      state: string;
      reports: number;
    };
    const states = value.buildRootStates as RootState[];
    assert.equal(value.schemaVersion, 2);
    assert.deepEqual(value.generatedBuildRoots, roots);
    assert.deepEqual(
      states,
      roots.map((name) => ({
        root: name,
        origin: name === "build-cross" ? "compatibility" : "source",
        state: "present-with-reports",
        reports: 1,
      })),
    );
    assert.equal(verified.reports.length, 6);
    assert.equal(verified.duplicateReportsAreIndependentEvidence, false);
    assert.equal(verified.completeConfigurationInventoryAssessed, false);
    assert.equal(verified.allOriginalTestsPassRequired, false);
    const reportPins = value.reports as Array<{ file: string; sha256: string }>;
    assert.equal(
      reportPins.find((row) => row.file === "build/native.sum")!.sha256,
      reportPins.find((row) => row.file === "build-jit/copied.sum")!.sha256,
    );
    const invalid = [
      [{ ...value, schemaVersion: 1 }, /manifest version/],
      [{ ...value, buildRootStates: states.slice(1) }, /strictly equal/],
      [
        {
          ...value,
          buildRootStates: states.map((row, index) =>
            index === 1 ? { ...row, origin: "source" } : row,
          ),
        },
        /origin differs/,
      ],
      [
        {
          ...value,
          buildRootStates: states.map((row, index) =>
            index === 2 ? { ...row, root: "build-jit-extra" } : row,
          ),
        },
        /identity differs/,
      ],
      [
        {
          ...value,
          buildRootStates: states.map((row, index) =>
            index === 2 ? { ...row, reports: 0 } : row,
          ),
        },
        /report count differs/,
      ],
      [
        {
          ...value,
          buildRootStates: states.map((row, index) =>
            index === 2 ? { ...row, state: "present-no-reports" } : row,
          ),
        },
        /report state differs/,
      ],
    ] as const;
    for (const [changed, reason] of invalid)
      await assert.rejects(
        api.verifyCProducerReports(changed, copies, profile, sameUidCaller),
        reason,
      );
    await api.verifyCProducerReports(value, copies, profile, sameUidCaller);
  },
);
