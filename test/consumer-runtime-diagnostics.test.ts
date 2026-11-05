import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fixture } from "./helpers.js";
const diagnostic = await import(
  new URL("../../scripts/consumer-runtime-diagnostics.mjs", import.meta.url)
    .href
);
const runner = await import(
  new URL("../../scripts/required-test-evidence.mjs", import.meta.url).href
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

test("consumer terminal diagnostics retain known native spawn causes while discarding foreign cause text", async (t) => {
  for (const code of ["ETIMEDOUT", "ENOBUFS", "ENOENT", "ABORT_ERR", secret]) {
    const p = profile();
    Object.assign(p.problems[0]!, { causeCode: code });
    const value = diagnostic.projectConsumerTerminalDiagnostic(
      p,
      requirements,
      sha,
    );
    assert.equal(value.state, "observed");
    assert.equal(
      value.cases[1].code,
      code === secret ? "ERR_TEST_FAILURE" : code,
    );
    assert.equal(JSON.stringify(value).includes(secret), false);
  }
  const program =
    "import {test}from'node:test';import{spawnSync}from'node:child_process';" +
    names
      .map(
        (name, index) =>
          `test(${JSON.stringify(name)},()=>{${index === 8 ? "const result=spawnSync(process.execPath,['-e','setTimeout(()=>{},1000)'],{timeout:40});if(result.error)throw result.error;" : ""}});`,
      )
      .join("");
  const root = await fixture(t, {
      "dist/test/gate-consumer-impact.test.js": program,
    }),
    file = path.join(root, "dist/test/gate-consumer-impact.test.js"),
    observer = path.join(root, "observe.mjs"),
    runner = new URL(
      "../../scripts/required-test-evidence.mjs",
      import.meta.url,
    ).href;
  await writeFile(
    observer,
    `import{runRequiredTests}from${JSON.stringify(runner)};process.stdout.write(JSON.stringify(await runRequiredTests(${JSON.stringify(names.map((name) => ({ file, name })))},{timeoutMs:2000})));`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const observed = spawnSync(process.execPath, [observer], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1048576,
  });
  assert.equal(observed.error, undefined);
  assert.equal(observed.status, 0, observed.stderr);
  const actual = JSON.parse(observed.stdout),
    sourceHash = createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
    value = diagnostic.projectConsumerTerminalDiagnostic(
      actual,
      requirements,
      sourceHash,
    );
  assert.equal(actual.complete, false);
  assert.equal(actual.passed, 8);
  assert.equal(actual.required, 9);
  assert.equal(value.state, "observed");
  assert.equal(value.cases[8].outcome, "failed");
  assert.equal(value.cases[8].code, "ETIMEDOUT");
  assert.equal(value.cases[8].failureType, "testCodeFailure");
  assert.equal(value.qualifiesNativeAcceptance, false);
  assert.equal(JSON.stringify(value).includes(root), false);
});

test("consumer failure sites accept only exact source paths or URLs and one physically bounded original stack location", () => {
  for (const file of [
    "/original synthetic/dist/test/gate-consumer-impact.test.js",
    "C:\\original synthetic\\dist\\test\\gate-consumer-impact.test.js",
  ]) {
    const url = file.startsWith("C:")
      ? "file:///C:/original%20synthetic/dist/test/gate-consumer-impact.test.js"
      : pathToFileURL(file).href;
    const source = { file, url, sha256: sha, lineLengths: [6, 10, 0] };
    const site = { sourceFileSha256: sha, line: 2, column: 11 };
    for (const frame of [
      `    at TestContext.<anonymous> (${url}:2:11)`,
      `    at ${url}:2:11`,
      `    at async TestContext.<anonymous> (${file}:2:11)`,
      `    at ${file}:2:11`,
    ]) {
      assert.deepEqual(
        runner.boundTestFailureSite(`Error: ${secret}\n${frame}`, source),
        site,
      );
      assert.deepEqual(
        runner.boundTestFailureSite(
          `Error: ${secret}\n${frame}\n${frame}`,
          source,
        ),
        site,
      );
    }
    assert.deepEqual(
      runner.boundTestFailureSite(`Error\n    at ${url}:3:1`, source),
      {
        sourceFileSha256: sha,
        line: 3,
        column: 1,
      },
    );
    for (const stack of [
      `Error: ${url}:2:11`,
      `Error\n    at ${url}.private:2:11`,
      `Error\n    at prefix-${url}:2:11`,
      `Error\n    at ${url}?private=1:2:11`,
      `Error\n    at ${url}#private:2:11`,
      `Error\n    at other/${file}:2:11`,
      `Error\n    at gate-consumer-impact.test.js:2:11`,
      `Error\n    at ${url.replace("/dist/", "/other/")}:2:11`,
      `Error\n    at ${url}:0:1`,
      `Error\n    at ${url}:1:0`,
      `Error\n    at ${url}:2:12`,
      `Error\n    at ${url}:4:1`,
      `Error\n    at ${url}:9007199254740992:1`,
      `Error\n    at ${url}:1:9007199254740992`,
      `Error\n    at ${url}:2:1\n    at ${url}:2:2`,
      `Error\n    at ${url}:2:11\n    at ${url}:4:1`,
      `Error\n    at ${url}:2:11 ${secret}`,
      `Error\n    at fake(${url}:2:11)`,
      `Error\n${"x".repeat(65536)}\n    at ${url}:2:11`,
      `Error\n${"\n".repeat(256)}    at ${url}:2:11`,
    ])
      assert.equal(
        runner.boundTestFailureSite(stack, source),
        undefined,
        stack.slice(0, 200),
      );
    assert.equal(runner.boundTestFailureSite(null, source), undefined);
    assert.equal(
      runner.boundTestFailureSite(`Error\n    at ${url}:2:11`, undefined),
      undefined,
    );
  }
});

test("consumer terminal diagnostics bind optional numeric sites to the existing file digest while retaining v1 rows", () => {
  const p = profile();
  Object.assign(p.problems[0]!, {
    failureSite: { sourceFileSha256: sha, line: 42, column: 7 },
    causeName: secret,
    causeCode: secret,
    operator: secret,
    stack: secret,
    actual: secret,
    expected: secret,
  });
  const value = diagnostic.projectConsumerTerminalDiagnostic(
    p,
    requirements,
    sha,
  );
  assert.equal(value.state, "observed");
  assert.deepEqual(value.cases[1].failureSite, { line: 42, column: 7 });
  assert.equal(value.cases[1].code, "ERR_TEST_FAILURE");
  assert.equal(value.qualifiesNativeAcceptance, false);
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.deepEqual(diagnostic.readConsumerTerminalDiagnostic(value), value);
  const legacy = diagnostic.projectConsumerTerminalDiagnostic(
    profile(),
    requirements,
    sha,
  );
  assert.equal(Object.hasOwn(legacy.cases[1], "failureSite"), false);
  assert.deepEqual(diagnostic.readConsumerTerminalDiagnostic(legacy), legacy);
  for (const failureSite of [
    { sourceFileSha256: "b".repeat(64), line: 42, column: 7 },
    { sourceFileSha256: sha, line: 42, column: 7, privatePath: secret },
    { sourceFileSha256: sha, line: Infinity, column: 7 },
    { sourceFileSha256: sha, line: 42, column: 0 },
    { sourceFileSha256: sha, line: 42.5, column: 7 },
    { sourceFileSha256: sha, line: 4194306, column: 7 },
    { sourceFileSha256: sha, line: 42, column: secret },
  ]) {
    Object.assign(p.problems[0]!, { failureSite });
    const refused = diagnostic.projectConsumerTerminalDiagnostic(
      p,
      requirements,
      sha,
    );
    assert.equal(refused.state, "refused");
    assert.equal(JSON.stringify(refused).includes(secret), false);
  }
  for (const failureSite of [
    { line: 42, column: 7, stack: secret },
    { line: NaN, column: 7 },
    { line: -1, column: 7 },
    { line: 42, column: 4194306 },
    { line: 42, column: 7.1 },
    null,
  ]) {
    const forged = structuredClone(value);
    forged.cases[1].failureSite = failureSite;
    assert.equal(
      diagnostic.readConsumerTerminalDiagnostic(forged).state,
      "refused",
    );
  }
  const passed = structuredClone(value);
  passed.cases[0].failureSite = { line: 42, column: 7 };
  assert.equal(
    diagnostic.readConsumerTerminalDiagnostic(passed).state,
    "refused",
  );
});

test("consumer terminal sites require an explicitly selected required source and original Node cause without raw exception projection", async (t) => {
  const program =
    "import assert from 'node:assert/strict';import {test} from 'node:test';\n" +
    names
      .map(
        (name, index) =>
          `test(${JSON.stringify(name)},()=>assert.equal(${index},${index === 6 ? 0 : index},'${secret}'));`,
      )
      .join("\n") +
    "\n";
  const runnerModule = new URL(
    "../../scripts/required-test-evidence.mjs",
    import.meta.url,
  ).href;
  const root = await fixture(t, {
    "dist/test/gate-consumer-impact.test.js": program,
    "foreign/dist/test/gate-consumer-impact.test.js": program,
  });
  for (const [relative, selected] of [
    ["dist/test/gate-consumer-impact.test.js", true],
    ["dist/test/gate-consumer-impact.test.js", false],
    ["foreign/dist/test/gate-consumer-impact.test.js", false],
  ] as const) {
    const file = path.join(root, relative),
      observer = path.join(root, "observe.mjs");
    await writeFile(
      observer,
      `import{runRequiredTests}from${JSON.stringify(runnerModule)};process.stdout.write(JSON.stringify(await runRequiredTests(${JSON.stringify(names.map((name) => ({ file, name })))},${JSON.stringify({ timeoutMs: 2000, ...(selected ? { diagnosticSourceFile: file } : {}) })})));`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const observed = spawnSync(process.execPath, [observer], {
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1048576,
    });
    assert.equal(observed.error, undefined);
    assert.equal(observed.status, 0, observed.stderr);
    const actual = JSON.parse(observed.stdout);
    const failure = actual.problems.find(
      (row: { reason: string }) => row.reason === "failed",
    );
    const sourceHash = createHash("sha256").update(program).digest("hex");
    assert.equal(actual.required, 9);
    assert.equal(actual.passed, 8);
    if (!selected) assert.equal(Object.hasOwn(failure, "failureSite"), false);
    else
      assert.deepEqual(failure.failureSite, {
        sourceFileSha256: sourceHash,
        line: 8,
        column: program.split("\n")[7]!.indexOf("assert.equal") + 8,
      });
    const value = diagnostic.projectConsumerTerminalDiagnostic(
      actual,
      requirements,
      sourceHash,
    );
    assert.equal(value.state, "observed");
    assert.equal(value.cases[6].outcome, "failed");
    assert.equal(value.cases[6].code, "ERR_TEST_FAILURE");
    assert.equal(value.cases[6].failureType, "testCodeFailure");
    assert.equal(value.qualifiesNativeAcceptance, false);
    assert.equal(Object.hasOwn(value.cases[6], "failureSite"), selected);
    for (const raw of [
      secret,
      root,
      program,
      "AssertionError",
      "strictEqual",
      "actual",
      "expected",
      "stack",
    ])
      assert.equal(JSON.stringify(value).includes(raw), false, raw);
  }
});

test("diagnostic source selection stays bound across unrelated named batches and accepts already-resolved required aliases", async (t) => {
  const program =
    "import assert from 'node:assert/strict';import {test} from 'node:test';\n" +
    names
      .map(
        (name, index) =>
          `test(${JSON.stringify(name)},()=>assert.equal(${index},${index === 6 ? 0 : index},'${secret}'));`,
      )
      .join("\n") +
    "\n";
  const root = await fixture(t, {
    "dist/test/gate-consumer-impact.test.js": program,
    "dist/test/unrelated.test.js":
      "import {test}from'node:test';test('unrelated required case',()=>{});",
  });
  const file = path.join(root, "dist/test/gate-consumer-impact.test.js"),
    unrelated = path.join(root, "dist/test/unrelated.test.js"),
    observer = path.join(root, "observe.mjs"),
    runnerModule = new URL(
      "../../scripts/required-test-evidence.mjs",
      import.meta.url,
    ).href;
  for (const [selection, fromProfiles] of [
    [file, false],
    [await realpath(file), true],
  ] as const) {
    const selectedRequirements = [
      { file: unrelated, name: "unrelated required case" },
      ...names.map((name) => ({ file, name })),
    ];
    const invocation = fromProfiles
      ? `runRequiredProfiles(${JSON.stringify({ unrelated: [selectedRequirements[0]], consumer: selectedRequirements.slice(1) })},["unrelated","consumer"],`
      : `runRequiredTests(${JSON.stringify(selectedRequirements)},`;
    await writeFile(
      observer,
      `import{runRequiredTests,runRequiredProfiles}from${JSON.stringify(runnerModule)};process.stdout.write(JSON.stringify(await ${invocation}${JSON.stringify({ timeoutMs: 2000, isolatedCaseWorkers: 1, diagnosticSourceFile: selection })})));`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const observed = spawnSync(process.execPath, [observer], {
      env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1048576,
    });
    assert.equal(observed.error, undefined);
    assert.equal(observed.status, 0, observed.stderr);
    const actual = JSON.parse(observed.stdout);
    assert.equal(actual.required, 10);
    assert.equal(actual.passed, 9);
    assert.equal(actual.complete, false);
    assert.equal(actual.ledger.events.length, 10);
    assert.equal(actual.ledger.events[0].name, "unrelated required case");
    assert.equal(actual.ledger.events[0].outcome, "passed");
    const failure = actual.problems.find(
      (row: { reason: string }) => row.reason === "failed",
    );
    assert.equal(failure.name, names[6]);
    assert.deepEqual(failure.failureSite, {
      sourceFileSha256: createHash("sha256").update(program).digest("hex"),
      line: 8,
      column: program.split("\n")[7]!.indexOf("assert.equal") + 8,
    });
    assert.equal(JSON.stringify(actual).includes(file), false);
    assert.equal(JSON.stringify(actual).includes(selection), false);
  }
});

test("diagnostic source selection cannot admit optional foreign or malformed paths before any required callback executes", async (t) => {
  const marker = "diagnostic-selection-executed";
  const program = `import{writeFileSync}from'node:fs';import{test}from'node:test';writeFileSync(${JSON.stringify(marker)},'yes');test('required synthetic case',()=>{});`;
  const root = await fixture(t, {
    "required.test.mjs": program,
    "foreign.test.mjs": program,
  });
  const file = path.join(root, "required.test.mjs"),
    foreign = path.join(root, "foreign.test.mjs"),
    observer = path.join(root, "observe.mjs"),
    runnerModule = new URL(
      "../../scripts/required-test-evidence.mjs",
      import.meta.url,
    ).href,
    diagnosticModule = new URL(
      "../../scripts/consumer-runtime-diagnostics.mjs",
      import.meta.url,
    ).href;
  for (const selected of [
    foreign,
    path.join(root, "missing.mjs"),
    "",
    null,
    1,
    {},
  ]) {
    await writeFile(
      observer,
      `import assert from'node:assert/strict';import{runRequiredTests}from${JSON.stringify(runnerModule)};import{projectConsumerTerminalDiagnostic}from${JSON.stringify(diagnosticModule)};let caught;try{await runRequiredTests(${JSON.stringify([{ file, name: "required synthetic case" }])},${JSON.stringify({ timeoutMs: 2000, additionalFiles: [foreign], diagnosticSourceFile: selected })});}catch(error){caught=error;}assert.equal(caught?.code,'ERR_ASSERTION');assert.equal(caught.message.includes(${JSON.stringify(root)}),false);process.stdout.write(JSON.stringify(projectConsumerTerminalDiagnostic(null,${JSON.stringify(requirements)},${JSON.stringify(sha)})));`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const observed = spawnSync(process.execPath, [observer], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1048576,
    });
    assert.equal(observed.error, undefined);
    assert.equal(observed.status, 0, observed.stderr);
    const publicValue = JSON.parse(observed.stdout);
    assert.equal(publicValue.state, "missing");
    assert.equal(publicValue.qualifiesNativeAcceptance, false);
    for (const raw of [root, foreign, "ERR_ASSERTION", "stack", "message"])
      assert.equal(observed.stdout.includes(raw), false, raw);
    await assert.rejects(readFile(path.join(root, marker)), { code: "ENOENT" });
  }
});
