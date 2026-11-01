import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import {
  cppExtensionsDeclaredConfig,
  cppExtensionsOriginalInputs,
} from "./cpp-extensions-fixture.js";
import { cppExtensionsCmake } from "../src/cpp-extensions-contract.js";
import { cppExtensionsPolicyFile } from "../src/cpp-extensions.js";
import { runProcess } from "../src/runner.js";
import type { Report } from "../src/types.js";
const {
  selectedClangWitnessScenarios,
  beginSelectedClangWitness,
  finishSelectedClangWitness,
  inspectSelectedClangConsumerWitnesses,
  requireSelectedClangConsumerWitnesses,
} = await import(
  new URL("../../scripts/selected-clang-consumer-witness.mjs", import.meta.url)
    .href
);
const { readConsumerWitnessNamespace } = await import(
  new URL("../../scripts/consumer-witness-collection.mjs", import.meta.url).href
);
test("selected Clang requires every original graph and repair scenario in source and fresh installs independently of supplementary GCC contexts", async () => {
  assert.equal(selectedClangWitnessScenarios.length, 7);
  assert.equal(
    selectedClangWitnessScenarios.filter(
      (row: { phase: string }) => row.phase === "canonical",
    ).length,
    3,
  );
  assert.deepEqual(
    selectedClangWitnessScenarios.map(
      (row: { scenario: string }) => row.scenario,
    ),
    [
      "mixed-graph",
      "repair-before",
      "mixed-graph",
      "private-link",
      "adjacent-template",
      "private-leaf",
      "pure-c",
    ],
  );
  const report = await inspectSelectedClangConsumerWitnesses({
    observations: [],
    attemptRecords: [],
  });
  assert.equal(report.complete, false);
  assert.equal(report.requiredWitnesses, 6);
  assert.equal(report.requiredObservations, 14);
  assert.equal(report.missing.length, 14);
  assert.equal(report.supplementaryGccQualifies, false);
  assert.equal(report.wholeRuntimeClosureVerified, false);
  assert.throws(
    () => requireSelectedClangConsumerWitnesses(report),
    /remain incomplete/,
  );
  assert.deepEqual(report.unqualified, [
    "actual-selected-OCI-controller-binding-missing",
  ]);
  assert.equal(
    await beginSelectedClangWitness(
      "unused",
      "broken",
      "canonical",
      "mixed-graph",
    ),
    null,
  );
});
test(
  "selected Clang collection retains actual failed outer process bytes before refusing compiler evidence and never manufactures native starts",
  {
    skip:
      process.platform === "win32"
        ? "Selected Clang POSIX collector unavailable on Windows"
        : false,
  },
  async (t) => {
    const config = cppExtensionsDeclaredConfig();
    config.tests.push({
      name: "original_adjacent_boundary",
      target: "original_consumer",
    });
    const root = await realpath(
      await fixture(t, {
        ...cppExtensionsOriginalInputs(),
        ...cppExtensionsCmake(config),
        [cppExtensionsPolicyFile]: JSON.stringify(config),
        "checktrail.json": JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: ["cpp.build-extensions", "cpp.ctest-extensions"],
            },
          ],
        }),
      }),
    );
    const destination = await realpath(await fixture(t, {}));
    const previous = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
    let capture;
    try {
      process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = destination;
      capture = await beginSelectedClangWitness(
        root,
        "broken",
        "canonical",
        "mixed-graph",
      );
    } finally {
      if (previous === undefined)
        delete process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
      else process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = previous;
    }
    assert.ok(capture);
    // Actual Node children exercise storage and failure classification only; they are not compiler witnesses.
    const failed = await runProcess(
      root,
      {
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write('synthetic-failed-clang-wrapper');process.stderr.write('synthetic-native-diagnostic');process.exitCode=7",
        ],
        cwd: ".",
      },
      { timeoutMs: 10000, maxOutputBytes: 65536, captureRawOutput: true },
    );
    const other = await runProcess(
      root,
      {
        executable: process.execPath,
        args: ["-e", "process.stdout.write('synthetic-not-a-native-packet')"],
        cwd: ".",
      },
      { timeoutMs: 10000, maxOutputBytes: 65536, captureRawOutput: true },
    );
    const report: Report = {
      schemaVersion: 1,
      engineVersion: "synthetic",
      runId: "synthetic",
      startedAt: "2026-01-01T00:00:00Z",
      durationMs: 1,
      sourceFingerprint: "a".repeat(64),
      finalSourceFingerprint: "a".repeat(64),
      policyFingerprint: "b".repeat(64),
      sourceChanged: false,
      sourceError: false,
      excluded: [],
      outcome: "failed",
      checks: [
        {
          id: "cpp.build-extensions",
          adapter: "cpp",
          project: ".",
          scope: capture.checks[0].scope,
          status: "failed",
          reason: "synthetic failed outer process",
          processes: [failed],
        },
        {
          id: "cpp.ctest-extensions",
          adapter: "cpp",
          project: ".",
          scope: capture.checks[1].scope,
          status: "passed",
          reason: "synthetic adjacent process",
          processes: [other],
        },
      ],
    };
    await finishSelectedClangWitness(capture, report);
    const retained = await readConsumerWitnessNamespace(
      destination,
      "selected-clang-producer-consumer",
    );
    assert.equal(retained.attemptRecords.length, 2);
    assert.equal(retained.observations.length, 1);
    const actual = retained.attemptRecords.find(
      (row: { value: { result: { exitCode: number } } }) =>
        row.value.result.exitCode === 7,
    )!;
    assert.equal(actual.value.processStartAcknowledgementRetained, false);
    assert.equal(actual.value.nativeTerminalObserved, true);
    assert.equal(
      Buffer.from(
        actual.value.result.capturedOutput.stdout.base64,
        "base64",
      ).toString(),
      failed.stdout,
    );
    assert.equal(
      Buffer.from(
        actual.value.result.capturedOutput.stderr.base64,
        "base64",
      ).toString(),
      failed.stderr,
    );
    assert.equal(
      actual.value.stdoutSha256,
      createHash("sha256").update(failed.stdout).digest("hex"),
    );
    await assert.rejects(
      inspectSelectedClangConsumerWitnesses(retained),
      /Selected Clang outer collection failed/,
    );
    const file = path.join(destination, actual.file),
      bytes = await readFile(file);
    assert.equal(bytes.length, actual.bytes);
    assert.equal((await readdir(destination)).length, 3);
    await assert.rejects(
      finishSelectedClangWitness(capture, report),
      /ProcessResult reused/,
    );
    assert.equal((await readdir(destination)).length, 3);
  },
);

test(
  "selected Clang combined packets remain private physical receipts rather than raw final controller output",
  {
    skip:
      process.platform === "win32"
        ? "Selected Clang POSIX private receipts unavailable on Windows"
        : false,
  },
  async () => {
    const { persistSelectedClangConsumerPacket } = await import(
      new URL(
        "../../scripts/selected-clang-consumer-witness.mjs",
        import.meta.url,
      ).href
    );
    const { lstat, rm } = await import("node:fs/promises");
    const value = {
      syntheticStorageOnly: true,
      nativeQualification: false,
      gateAComplete: false,
    };
    const receipt = await persistSelectedClangConsumerPacket(value);
    try {
      const bytes = await readFile(receipt.path),
        stat = await lstat(receipt.path);
      assert.deepEqual(JSON.parse(bytes.toString()), value);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(stat.nlink, 1);
      assert.equal(bytes.length, receipt.bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        receipt.sha256,
      );
      assert.equal(receipt.gateAComplete, false);
    } finally {
      await rm(path.dirname(receipt.path), { recursive: true, force: true });
    }
  },
);

test("selected Clang callback denominator derives from the frozen inventory and accepts only the same complete selected requirements in a reduced installed harness", async (t) => {
  const { selectSelectedClangRequirements } = await import(
    new URL(
      "../../scripts/selected-clang-consumer-witness.mjs",
      import.meta.url,
    ).href
  );
  const { writeFile } = await import("node:fs/promises");
  const inventory = JSON.parse(
    await readFile(
      new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const profiles = JSON.parse(
    await readFile(
      new URL("../../scripts/required-native-tests.json", import.meta.url),
      "utf8",
    ),
  );
  const expected = profiles["cpp-extensions"];
  const root = await fixture(t, {
    "docs/gate-a-profiles.v1.json": JSON.stringify(inventory),
    "scripts/required-native-tests.json": JSON.stringify({
      "cpp-extensions": profiles["cpp-extensions"],
    }),
  });
  assert.deepEqual(await selectSelectedClangRequirements(root), expected);
  const changed = structuredClone(profiles["cpp-extensions"]);
  changed.pop();
  await writeFile(
    path.join(root, "scripts/required-native-tests.json"),
    JSON.stringify({ "cpp-extensions": changed }),
  );
  await assert.rejects(
    selectSelectedClangRequirements(root),
    /callback inventory differs/,
  );
});
