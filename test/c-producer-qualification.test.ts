import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("C producer catalog binds both exact source revisions and original finite profiles", async () => {
  const gcc = await profiles.loadCProducerProfile("gcc-12");
  const glibc = await profiles.loadCProducerProfile("glibc");
  assert.equal(gcc.profile.files.length, 241);
  assert.equal(glibc.profile.files.length, 161);
  assert.equal(gcc.profile.limits.deadlineSeconds, 28800);
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
  for (const name of ["gcc-12", "glibc"]) {
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
