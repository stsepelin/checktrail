import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fixture } from "./helpers.js";
const diagnostic = await import(
  new URL("../../scripts/consumer-runtime-diagnostics.mjs", import.meta.url)
    .href
);
const runtime = await import(
  new URL("../../scripts/consumer-runtime-evidence.mjs", import.meta.url).href
);
const names = [
  "broken",
  "fixed",
  "near-miss",
  "prerequisite",
  "stale",
  "empty",
  "privacy",
  "lifecycle",
  "installed",
].map((kind) => `consumer-impact ${kind} acceptance`);
const requirements = names.map((name) => ({
  file: "dist/test/gate-consumer-impact.test.js",
  name,
}));
const sha = "a".repeat(64),
  secret = "original-private-project-path-token";
function profile() {
  return {
    complete: false,
    problems: [
      {
        name: names[1]!,
        reason: "failed",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
        message: secret,
      },
      { name: names[1]!, reason: "required-test-not-passed" },
    ],
    ledger: {
      schemaVersion: 1,
      truncated: false,
      terminalEventCount: 3,
      files: [
        {
          id: "file-1",
          stable: true,
          before: { state: "present", sha256: sha },
          after: { state: "present", sha256: sha },
        },
      ],
      events: names.slice(0, 3).map((name, index) => ({
        sequence: index + 1,
        fileId: "file-1",
        name,
        nameTruncated: false,
        kind: "test",
        required: true,
        outcome: index === 1 ? "failed" : "passed",
        durationMs: index + 0.25,
      })),
    },
  };
}
test("consumer terminal diagnostics retain multiple exact frozen outcomes and durations without private assertion messages", () => {
  const p = profile(),
    value = diagnostic.projectConsumerTerminalDiagnostic(p, requirements, sha);
  assert.equal(value.state, "observed");
  assert.equal(value.sourceFileSha256, sha);
  assert.equal(value.qualifiesNativeAcceptance, false);
  assert.deepEqual(value.cases, [
    {
      name: names[0],
      outcome: "passed",
      durationMs: 0.25,
      code: null,
      failureType: null,
    },
    {
      name: names[1],
      outcome: "failed",
      durationMs: 1.25,
      code: "ERR_TEST_FAILURE",
      failureType: "testCodeFailure",
    },
    {
      name: names[2],
      outcome: "passed",
      durationMs: 2.25,
      code: null,
      failureType: null,
    },
  ]);
  assert.deepEqual(value.missingCases, names.slice(3));
  assert.equal(JSON.stringify(value).includes(secret), false);
  Object.defineProperty(p.problems[0], "message", {
    get() {
      throw Error(secret);
    },
  });
  assert.deepEqual(
    diagnostic.projectConsumerTerminalDiagnostic(p, requirements, sha),
    value,
  );
  assert.deepEqual(diagnostic.readConsumerTerminalDiagnostic(value), value);
});
test("consumer terminal diagnostic projection refuses foreign duplicated oversized nonfinite or unknown source and event values", () => {
  const mutations: Array<(value: ReturnType<typeof profile>) => void> = [
    (p) => {
      p.ledger.events[0]!.name = secret;
    },
    (p) => {
      p.ledger.events[1]!.name = p.ledger.events[0]!.name;
    },
    (p) => {
      p.ledger.events[1]!.sequence = 1;
    },
    (p) => {
      p.ledger.events[0]!.durationMs = NaN;
    },
    (p) => {
      p.ledger.events[0]!.durationMs = Infinity;
    },
    (p) => {
      p.ledger.events[0]!.durationMs = -1;
    },
    (p) => {
      p.ledger.events[0]!.durationMs = 1200001;
    },
    (p) => {
      p.ledger.events[0]!.outcome = secret;
    },
    (p) => {
      p.ledger.events[0]!.fileId = secret;
    },
    (p) => {
      p.ledger.events[0]!.required = false;
    },
    (p) => {
      p.ledger.events[0]!.nameTruncated = true;
    },
    (p) => {
      p.ledger.files[0]!.after.sha256 = "b".repeat(64);
    },
    (p) => {
      p.ledger.files[0]!.stable = false;
    },
    (p) => {
      p.ledger.events = Array.from({ length: 10 }, () => ({
        ...p.ledger.events[0]!,
      }));
      p.ledger.terminalEventCount = 10;
    },
    (p) => {
      p.problems.push({ ...p.problems[0]! });
    },
    (p) => {
      p.problems[0]!.name = secret;
    },
    (p) => {
      p.ledger.truncated = true;
    },
    (p) => {
      p.ledger.terminalEventCount = 50000;
    },
  ];
  for (const mutate of mutations) {
    const p = profile();
    mutate(p);
    const value = diagnostic.projectConsumerTerminalDiagnostic(
      p,
      requirements,
      sha,
    );
    assert.equal(value.state, "refused");
    assert.deepEqual(value.cases, []);
    assert.deepEqual(value.missingCases, names);
    assert.equal(JSON.stringify(value).includes(secret), false);
  }
  for (const list of [
    requirements.slice(1),
    [...requirements, { file: secret, name: secret }],
    requirements.map((row, i) => (i ? row : { ...row, name: secret })),
  ])
    assert.equal(
      diagnostic.projectConsumerTerminalDiagnostic(profile(), list, sha).state,
      "refused",
    );
});
test("consumer terminal diagnostics keep absent evidence explicit and unknown failure codes categorical", () => {
  for (const p of [undefined, null]) {
    const value = diagnostic.projectConsumerTerminalDiagnostic(
      p,
      requirements,
      sha,
    );
    assert.equal(value.state, "missing");
    assert.deepEqual(value.missingCases, names);
  }
  const p = profile();
  p.problems[0]!.code = secret;
  p.problems[0]!.failureType = secret;
  const value = diagnostic.projectConsumerTerminalDiagnostic(
    p,
    requirements,
    sha,
  );
  assert.equal(value.state, "observed");
  assert.equal(value.cases[1].code, null);
  assert.equal(value.cases[1].failureType, "unknown");
  assert.equal(JSON.stringify(value).includes(secret), false);
  p.ledger.events = [];
  p.ledger.terminalEventCount = 0;
  p.problems = [{ name: names[1]!, reason: "required-test-not-passed" }];
  assert.equal(
    diagnostic.projectConsumerTerminalDiagnostic(p, requirements, sha).state,
    "missing",
  );
});
test("consumer terminal diagnostic transport refuses private extra fields malformed complements and forged unknown values", () => {
  const value = diagnostic.projectConsumerTerminalDiagnostic(
    profile(),
    requirements,
    sha,
  );
  for (const forged of [
    { ...value, privatePath: secret },
    { ...value, cases: [{ ...value.cases[0], name: secret }] },
    { ...value, missingCases: [] },
    { ...value, cases: [...value.cases, value.cases[0]] },
    { ...value, cases: [{ ...value.cases[0], durationMs: NaN }] },
    { ...value, sourceFileSha256: secret },
    { ...value, schemaVersion: 2 },
    { ...value, profile: secret },
    { ...value, file: secret },
    { ...value, state: secret },
    {
      ...value,
      cases: [
        value.cases[0],
        { ...value.cases[1], code: secret },
        value.cases[2],
      ],
    },
    {
      ...value,
      cases: [
        value.cases[0],
        { ...value.cases[1], failureType: secret },
        value.cases[2],
      ],
    },
    {
      ...value,
      cases: [
        { ...value.cases[0], outcome: secret },
        value.cases[1],
        value.cases[2],
      ],
    },
    { ...value, qualifiesNativeAcceptance: true },
  ]) {
    const projected = diagnostic.readConsumerTerminalDiagnostic(forged);
    assert.equal(projected.state, "refused");
    assert.equal(JSON.stringify(projected).includes(secret), false);
  }
  assert.equal(
    diagnostic.readConsumerTerminalDiagnostic({
      get schemaVersion() {
        throw Error(secret);
      },
    }).state,
    "refused",
  );
});
test("consumer profile refusal preserves its original assertion while attaching only the sanitized selected callback diagnostic", () => {
  const p = profile();
  let caught;
  try {
    runtime.requireConsumerTerminalCases(p, requirements, sha);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof assert.AssertionError);
  assert.match(caught.message, new RegExp(secret));
  const attached = (caught as Error & { consumerTerminalDiagnostic?: unknown })
    .consumerTerminalDiagnostic;
  assert.deepEqual(
    attached,
    diagnostic.projectConsumerTerminalDiagnostic(p, requirements, sha),
  );
  assert.equal(JSON.stringify(attached).includes(secret), false);
});

test("consumer terminal diagnostics reconcile the real runner terminal failure and same-address accounting row", async (t) => {
  const program =
    "import assert from 'node:assert/strict';import {test} from 'node:test';" +
    names
      .map(
        (name, index) =>
          `test(${JSON.stringify(name)},()=>assert.equal(${index},${index === 1 ? 2 : index},'original-private-real-runner-message'));`,
      )
      .join("");
  const root = await fixture(t, {
      "dist/test/gate-consumer-impact.test.js": program,
    }),
    file = path.join(root, "dist/test/gate-consumer-impact.test.js");
  const runnerFile = path.join(root, "observe.mjs"),
    runnerModule = new URL(
      "../../scripts/required-test-evidence.mjs",
      import.meta.url,
    ).href;
  await writeFile(
    runnerFile,
    `import {runRequiredTests} from ${JSON.stringify(runnerModule)};const result=await runRequiredTests(${JSON.stringify(names.map((name) => ({ file, name })))},{timeoutMs:2000});process.stdout.write(JSON.stringify(result));`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const observed = spawnSync(process.execPath, [runnerFile], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1048576,
  });
  assert.equal(observed.error, undefined);
  assert.equal(observed.status, 0, observed.stderr);
  const actual = JSON.parse(observed.stdout);
  assert.equal(actual.complete, false);
  assert.equal(actual.passed, 8);
  assert.equal(actual.required, 9);
  assert.deepEqual(
    actual.problems
      .filter((row: { name: string }) => row.name === names[1])
      .map((row: { reason: string }) => row.reason),
    ["failed", "required-test-not-passed"],
  );
  const sourceHash = createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
    value = diagnostic.projectConsumerTerminalDiagnostic(
      actual,
      requirements,
      sourceHash,
    );
  assert.equal(value.state, "observed");
  assert.equal(value.cases.length, 9);
  assert.deepEqual(value.missingCases, []);
  assert.equal(value.cases[1].outcome, "failed");
  assert.equal(value.cases[1].code, "ERR_TEST_FAILURE");
  assert.equal(value.cases[1].failureType, "testCodeFailure");
  assert.equal(
    value.cases.filter((row: { outcome: string }) => row.outcome === "passed")
      .length,
    8,
  );
  assert.equal(JSON.stringify(value).includes("original-private"), false);
});

test("consumer terminal diagnostics reconcile skipped accounting while refusing contradictory repeated or foreign terminal problems", () => {
  const skipped = profile();
  skipped.ledger.events[1]!.outcome = "skipped";
  skipped.problems[0]!.reason = "skipped-or-todo";
  assert.equal(
    diagnostic.projectConsumerTerminalDiagnostic(skipped, requirements, sha)
      .cases[1].outcome,
    "skipped",
  );
  const mutations: Array<(p: ReturnType<typeof profile>) => void> = [
    (p) => {
      p.problems.push({ ...p.problems[1]! });
    },
    (p) => {
      p.problems.push({ ...p.problems[0]! });
    },
    (p) => {
      p.problems[1]!.name = names[0]!;
    },
    (p) => {
      p.problems[0]!.reason = "required-private-reason";
    },
    (p) => {
      p.problems[0]!.reason = "skipped-or-todo";
    },
    (p) => {
      p.problems[0]!.name = names[8]!;
    },
  ];
  for (const mutate of mutations) {
    const p = profile();
    mutate(p);
    assert.equal(
      diagnostic.projectConsumerTerminalDiagnostic(p, requirements, sha).state,
      "refused",
    );
  }
});
