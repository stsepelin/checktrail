import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import ts from "typescript";
import { parse } from "yaml";
type Requirement = { file: string; name: string };
type BuildOptions = {
  workflow: unknown;
  requirements: Record<string, Requirement[]>;
  files: string[];
  readText: (file: string) => Promise<string>;
};
type Plan = {
  mode: string;
  selected: Record<string, boolean>;
  sharedTestFiles: string[];
};
type Pin = { bytes: number; sha256: string };
type CiInputs = {
  runtime: { platform: string; architecture: string; node: string };
  githubCli: {
    version: string;
    archive: Pin & { name: string };
    executable: Pin;
    license: Pin;
    publisherSignatureVerified: boolean;
    checksums: { selectedLine: string };
  };
  completeLicenseClosureVerified: boolean;
  gateAComplete: boolean;
};
const root = fileURLToPath(new URL("../../", import.meta.url));
const { buildNativeInputs, planNativeJobs, nativeJobIds } = (await import(
  pathToFileURL(path.join(root, "scripts/ci-impact.mjs")).href
)) as {
  buildNativeInputs: (
    options: BuildOptions,
  ) => Promise<Record<string, string[]>>;
  planNativeJobs: (options: {
    jobs: string[];
    inputs: Record<string, string[]>;
    changed: string[];
    eventName: string;
    contractCurrent: boolean;
  }) => Plan;
  nativeJobIds: (workflow: unknown) => string[];
};
const {
  contextRuntimeCiInputs: inputs,
  requireContextCiRuntime,
  verifyContextCiBytes,
  extractContextCiMember,
} = (await import(
  pathToFileURL(path.join(root, "scripts/prepare-context-runtime-proof-ci.mjs"))
    .href
)) as {
  contextRuntimeCiInputs: CiInputs;
  requireContextCiRuntime: (actual: CiInputs["runtime"]) => void;
  verifyContextCiBytes: (raw: Uint8Array, pin: Pin) => Uint8Array;
  extractContextCiMember: (
    archive: string,
    pin: Pin,
    member: Pin & { member: string },
  ) => Uint8Array;
};
const { assertContextRequiredReceipt, assertContextPackageReceipt } =
  (await import(
    pathToFileURL(
      path.join(root, "scripts/verify-context-runtime-proof-ci.mjs"),
    ).href
  )) as {
    assertContextRequiredReceipt: (value: unknown) => void;
    assertContextPackageReceipt: (value: unknown) => void;
  };
const workflow = parse(
  await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"),
);
const profiles = JSON.parse(
  await readFile(path.join(root, "scripts/required-native-tests.json"), "utf8"),
) as Record<string, { file: string; name: string }[]>;
const profile = profiles["context-runtime-proof"]!;

test("context proof CI uses the authoritative pinned ARM64 verifier and exact supported host", () => {
  assert.equal(inputs.githubCli.version, "2.102.1");
  assert.equal(inputs.githubCli.archive.bytes, 13922552);
  assert.equal(
    inputs.githubCli.archive.sha256,
    "5019b3cc6e8a03bb4d88600f8dbda2add8e6407705c159b0c63151036e77a1af",
  );
  assert.equal(
    inputs.githubCli.executable.sha256,
    "2a94934af93acc2161e165841559b532cce266c805a600b71392761941bed264",
  );
  assert.equal(inputs.githubCli.license.bytes, 1068);
  assert.equal(inputs.githubCli.publisherSignatureVerified, false);
  assert.equal(inputs.completeLicenseClosureVerified, false);
  assert.equal(inputs.gateAComplete, false);
  assert.equal(
    inputs.githubCli.checksums.selectedLine,
    inputs.githubCli.archive.sha256 + "  " + inputs.githubCli.archive.name,
  );
  requireContextCiRuntime({
    platform: "linux",
    architecture: "arm64",
    node: "v22.23.2",
  });
  for (const changed of [
    { platform: "darwin" },
    { architecture: "x64" },
    { node: "v22.23.4" },
  ])
    assert.throws(
      () => requireContextCiRuntime({ ...inputs.runtime, ...changed }),
      /runtime differs/,
    );
  const raw = Buffer.from("synthetic bytes");
  const pin = {
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
  assert.deepEqual(verifyContextCiBytes(raw, pin), raw);
  assert.throws(
    () => verifyContextCiBytes(Buffer.concat([raw, Buffer.from("x")]), pin),
    /byte count/,
  );
  assert.throws(
    () =>
      verifyContextCiBytes(Buffer.from("different bytes"), {
        ...pin,
        bytes: 15,
      }),
    /digest/,
  );
});
test("context proof required profile names every original case and the existing workflow adds no jobs", async () => {
  const rows: { file: string; name: string }[] = [];
  for (const file of [
    "test/context-runtime-attestation-policy.test.ts",
    "test/context-runtime-proof.test.ts",
    "test/context-runtime-proof-preparation.test.ts",
  ]) {
    const source = ts.createSourceFile(
      file,
      await readFile(path.join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) &&
          node.expression.text === "test") ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "test" &&
            node.expression.expression.getText(source) === "t"))
      ) {
        assert.ok(
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]),
          "Static case registration required",
        );
        rows.push({
          file: file.replace(/^test\//u, "dist/test/").replace(/\.ts$/u, ".js"),
          name: node.arguments[0].text,
        });
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  assert.equal(rows.length, 29);
  assert.deepEqual(
    [...profile].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  const baseline = parse(
    execFileSync("git", ["show", "HEAD:.github/workflows/ci.yml"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert.deepEqual(
    Object.keys(workflow.jobs).sort(),
    Object.keys(baseline.jobs).sort(),
  );
  const job = workflow.jobs["go-workspaces-arm64"];
  assert.equal(job["runs-on"], "ubuntu-24.04-arm");
  assert.ok(
    job.steps.some(
      (step: { with?: Record<string, string> }) =>
        step.with?.["node-version"] === "22.23.2",
    ),
  );
  const source = job.steps.find((step: { run?: string }) =>
    step.run?.includes("node scripts/prepare-context-runtime-proof-ci.mjs"),
  );
  assert.ok(source);
  assert.match(
    source.run,
    /cp docs\/measurements\/artifact-identities-2026-10-21\/sigstore-trusted-root\.jsonl/u,
  );
  assert.match(
    source.run,
    /cp docs\/measurements\/context-runtime-0\.27\.1-2026-10-30\/attestation-verified\.json/u,
  );
  assert.ok(
    workflow.jobs.checks.steps.some(
      (step: { run?: string; if?: unknown }) =>
        step.run === "node scripts/audit-context-grammars.mjs" &&
        step.if === undefined,
    ),
  );
  const helper = await readFile(
    path.join(root, "scripts/prepare-context-runtime-proof-ci.mjs"),
    "utf8",
  );
  assert.ok(
    !helper.includes("appendFile(process.env.GITHUB_ENV"),
    "Proof authority must stay in the qualified child environment",
  );
});
test("context proof CI graph binds actual retained root and new preparation inputs to the existing consumer and shared audit", async () => {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  const actual = await buildNativeInputs({
    workflow,
    requirements: profiles,
    files,
    readText: (file: string) => readFile(path.join(root, file), "utf8"),
  });
  for (const file of [
    "scripts/context-runtime-proof-ci-inputs.json",
    "scripts/prepare-context-runtime-proof-ci.mjs",
    "scripts/verify-context-runtime-proof-ci.mjs",
    "test/context-runtime-proof-ci.test.ts",
    "docs/measurements/artifact-identities-2026-10-21/sigstore-trusted-root.jsonl",
  ]) {
    assert.deepEqual(actual[file], ["go-workspaces-arm64"], file);
    const plan = planNativeJobs({
      jobs: nativeJobIds(workflow),
      inputs: actual,
      changed: [file],
      eventName: "pull_request",
      contractCurrent: true,
    });
    assert.equal(plan.selected["go-workspaces-arm64"], true, file);
    if (file.startsWith("docs/"))
      assert.ok(
        plan.sharedTestFiles.includes("dist/test/artifact-evidence.test.js"),
      );
  }
  const original = planNativeJobs({
    jobs: nativeJobIds(workflow),
    inputs: actual,
    changed: [
      "docs/measurements/context-runtime-0.27.1-2026-10-30/attestation-verified.json",
    ],
    eventName: "pull_request",
    contractCurrent: true,
  });
  assert.equal(original.mode, "full");
  for (const file of [
    "assets/context-grammars/manifest.json",
    "assets/context-grammars/runtime-manifest.json",
    "assets/context-vb-grammar/manifest.json",
  ])
    assert.ok(actual[file]?.includes("go-workspaces-arm64"), file);
});
test("context proof CI receipt refuses missing skipped duplicate and false-closure cohorts", () => {
  const required = () => ({
    profile: "context-runtime-proof",
    required: 29,
    passed: 29,
    complete: true,
    problems: [],
    ledger: {
      truncated: false,
      terminalEventCount: 29,
      events: profile.map(() => ({ outcome: "passed" })),
      cases: profile.map((row, index) => ({
        fileId: "file",
        name: row.name,
        outcome: "passed",
        terminalSequences: [index + 1],
      })),
    },
  });
  assertContextRequiredReceipt(required());
  for (const mutate of [
    (value: ReturnType<typeof required>) => {
      value.ledger.events[0]!.outcome = "skipped";
    },
    (value: ReturnType<typeof required>) => {
      value.ledger.cases.pop();
    },
    (value: ReturnType<typeof required>) => {
      value.ledger.cases[0]!.name = value.ledger.cases[1]!.name;
    },
    (value: ReturnType<typeof required>) => {
      value.complete = false;
    },
  ]) {
    const value = required();
    mutate(value);
    assert.throws(() => assertContextRequiredReceipt(value));
  }
  const states = [
    "passed-all-qualified-parser-families",
    "passed-qualified-vb-mixed-boundary",
    "passed-warm-cache-physical-guard",
    "passed-final-context-proof-admission",
    "passed-context-proof-transports",
    "passed-context-proof-authority",
  ];
  const packaged = () => ({
    state: "passed-context-runtime-proof-package",
    sourceCohorts: 6,
    installedCohorts: 6,
    cohorts: ["source", "installed"].flatMap((mode) =>
      states.map((state) => ({ mode, state, modelCalls: 0 })),
    ),
    modelCalls: 0,
    fullProducerBuildClosureVerified: false,
    completeLicenseClosureVerified: false,
    gateAComplete: false,
    compiledEngine: {
      fileCount: 2,
      bytes: 100,
      sourceInstalledByteIdentitiesMatch: true,
      sourceBeforeAfterMatch: true,
      installedBeforeAfterMatch: true,
      actualModuleLoadsTraced: false,
    },
    harnessInputsUnchanged: true,
  });
  assertContextPackageReceipt(packaged());
  const missing = packaged();
  missing.cohorts.pop();
  assert.throws(() => assertContextPackageReceipt(missing));
  const falseClaim = packaged();
  falseClaim.compiledEngine.actualModuleLoadsTraced = true;
  assert.throws(() => assertContextPackageReceipt(falseClaim));
});
test(
  "context proof CI selected archive member extraction checks pinned bytes without executing its payload",
  {
    skip:
      process.platform === "win32" ? "POSIX archive setup tool control" : false,
  },
  async () => {
    const temporary = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "context-ci-tar-")),
    );
    try {
      const directory = path.join(temporary, "gh_2.102.1_linux_arm64");
      await mkdir(path.join(directory, "bin"), { recursive: true });
      const content = Buffer.from("synthetic executable data never executed");
      await writeFile(path.join(directory, "bin/gh"), content);
      await writeFile(path.join(directory, "LICENSE"), "synthetic notice");
      const archive = path.join(temporary, "gh.tar.gz");
      execFileSync("/usr/bin/tar", [
        "-czf",
        archive,
        "-C",
        temporary,
        "gh_2.102.1_linux_arm64",
      ]);
      const raw = await readFile(archive);
      const pin = {
          bytes: raw.length,
          sha256: createHash("sha256").update(raw).digest("hex"),
        },
        member = {
          member: "gh_2.102.1_linux_arm64/bin/gh",
          bytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      assert.deepEqual(extractContextCiMember(archive, pin, member), content);
      assert.throws(
        () =>
          extractContextCiMember(
            archive,
            { ...pin, sha256: "0".repeat(64) },
            member,
          ),
        /digest/,
      );
      assert.throws(
        () =>
          extractContextCiMember(archive, pin, {
            ...member,
            sha256: "0".repeat(64),
          }),
        /digest/,
      );
      assert.throws(() =>
        extractContextCiMember(archive, pin, {
          ...member,
          member: "../outside",
        }),
      );
      const link = path.join(temporary, "linked.tar.gz");
      await symlink(archive, link);
      assert.throws(
        () => extractContextCiMember(link, pin, member),
        /Linked input/,
      );
      assert.deepEqual(await readFile(path.join(directory, "bin/gh")), content);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
