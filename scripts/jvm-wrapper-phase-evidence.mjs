import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

export const jvmWrapperPhases = Object.freeze([
  "baseline",
  "acceptance",
  "guards-regressions",
]);
const outputNames = {
  baseline: "jvm_baseline",
  acceptance: "jvm_acceptance",
  "guards-regressions": "jvm_guards_regressions",
};
export const jvmPhaseDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function selectJvmWrapperPhases(args) {
  assert.ok(
    Array.isArray(args) && args.length <= 1,
    "Select at most one JVM phase",
  );
  const selected = args[0] ?? "all";
  assert.ok(
    selected === "all" || jvmWrapperPhases.includes(selected),
    "Unknown JVM wrapper phase",
  );
  return selected === "all" ? [...jvmWrapperPhases] : [selected];
}

// This binds ordinary checkout bytes and executable modes before/after a phase.
// It does not establish an atomic or adversarial filesystem snapshot.
export async function jvmWrapperSourceIdentity(repository) {
  const root = await realpath(repository);
  const files = execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1048576 },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.ok(files.length > 0 && files.length <= 20000);
  assert.equal(files.length, new Set(files).size);
  const rows = [];
  let bytes = 0;
  for (const relative of files) {
    assert.ok(
      !path.isAbsolute(relative) &&
        !relative
          .split(/[\\/]/)
          .some((part) => !part || part === "." || part === ".."),
    );
    const file = path.join(root, relative);
    assert.equal(
      await realpath(file),
      file,
      "JVM input cannot cross a file link",
    );
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      assert.ok(before.isFile() && before.size <= 64 * 1048576);
      bytes += before.size;
      assert.ok(bytes <= 512 * 1048576, "JVM source inputs exceed their bound");
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      assert.equal(length, before.size, "JVM source changed during capture");
      const content = buffer.subarray(0, length);
      const after = await handle.stat();
      for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode"])
        assert.equal(
          after[key],
          before[key],
          "JVM source changed during capture",
        );
      assert.equal(await realpath(file), file);
      rows.push([
        relative.split(path.sep).join("/"),
        before.mode & 0o111 ? "100755" : "100644",
        jvmPhaseDigest(content),
      ]);
    } finally {
      await handle.close();
    }
  }
  return {
    sha256: jvmPhaseDigest(JSON.stringify(rows)),
    files: rows.length,
    bytes,
  };
}

export async function jvmWrapperCompiledHarnessIdentity(repository) {
  const rows = [];
  const directory = path.join(repository, "dist/test");
  async function walk(relative) {
    const entries = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        assert.equal(
          entry.isFile(),
          true,
          "Compiled JVM harness cannot follow file links",
        );
        rows.push([
          file.split(path.sep).join("/"),
          jvmPhaseDigest(await readFile(path.join(directory, file))),
        ]);
      }
    }
  }
  await walk("");
  assert.ok(rows.length > 0);
  return jvmPhaseDigest(JSON.stringify(rows));
}

export function jvmWrapperCiContext(env) {
  if (env.GITHUB_ACTIONS !== "true") return null;
  const context = {
    run: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    sha: env.GITHUB_SHA,
    job: env.GITHUB_JOB,
  };
  assert.match(context.run, /^[1-9][0-9]{0,19}$/);
  assert.ok(positive(context.attempt));
  assert.match(context.sha, /^[a-f0-9]{40}$/);
  assert.match(context.job, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/);
  return context;
}

export function jvmWrapperPhaseSummary(receipt) {
  assert.ok(jvmWrapperPhases.includes(receipt.phase));
  assert.equal(receipt.scope, "jvm-wrapper-native-phase");
  assert.equal(receipt.phaseComplete, true);
  assert.equal(receipt.allPhasesComplete, false);
  const obligations = {};
  if (receipt.phase === "baseline") {
    assert.equal(receipt.preparationOwnership.positiveComplete, true);
    assert.equal(
      receipt.preparationOwnership.rootOwnedNegativeReproduced,
      true,
    );
    assert.equal(receipt.baseline.complete, true);
    assert.ok(positive(receipt.baseline.required));
    obligations.baseline = receipt.baseline.required;
    obligations.preparationOwnership = true;
  } else if (receipt.phase === "acceptance") {
    for (const evidence of [receipt.source, receipt.installed.profile]) {
      assert.equal(evidence.required, 9);
      assert.equal(evidence.passed, 9);
      assert.equal(evidence.complete, true);
    }
    assert.equal(receipt.installed.offlineProductionInstall, true);
    assert.equal(receipt.installed.harnessOutsideInstalledPackage, true);
    obligations.source = 9;
    obligations.installed = 9;
    obligations.offlineProductionInstall = true;
    obligations.harnessOutsideInstalledPackage = true;
  } else {
    assert.equal(receipt.guardCapture.nativeReceipts, 2);
    assert.equal(receipt.guards.controls.length, 21);
    const ids = receipt.guards.controls.map((control) => {
      assert.ok(typeof control.id === "string" && control.id.length > 0);
      for (const flag of [
        "originalPassed",
        "mutantCompiled",
        "mutantFailedAssertion",
        "restoredPassed",
      ])
        assert.equal(control[flag], true);
      return control.id;
    });
    assert.equal(new Set(ids).size, 21);
    assert.ok(positive(receipt.regressions.passed));
    assert.equal(receipt.regressions.failed, 0);
    assert.equal(receipt.regressions.skipped, 0);
    obligations.guards = 21;
    obligations.guardIdsSha256 = jvmPhaseDigest(JSON.stringify(ids.toSorted()));
    obligations.regressions = receipt.regressions.passed;
  }
  const summary = {
    schemaVersion: 1,
    scope: "jvm-wrapper-ci-phase",
    phase: receipt.phase,
    complete: true,
    bindings: receipt.bindings,
    ci: receipt.ci,
    receiptSha256: jvmPhaseDigest(JSON.stringify(receipt)),
    obligations,
  };
  for (const key of ["source", "compiledCode", "compiledHarness", "runtime"])
    assert.match(summary.bindings[key], digestPattern);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 16384);
  return summary;
}

export function requireJvmWrapperPhaseSummaries(summaries, expected) {
  assert.equal(
    summaries.length,
    jvmWrapperPhases.length,
    "JVM phase receipt missing",
  );
  assert.deepEqual(
    summaries.map((summary) => summary.phase).toSorted(),
    jvmWrapperPhases.toSorted(),
    "JVM phase receipt duplicated or unknown",
  );
  for (const summary of summaries) {
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.scope, "jvm-wrapper-ci-phase");
    assert.equal(summary.complete, true);
    assert.match(summary.receiptSha256, digestPattern);
    for (const key of [
      "source",
      "compiledCode",
      "compiledHarness",
      "runtime",
    ]) {
      assert.match(summary.bindings[key], digestPattern);
      assert.equal(summary.bindings[key], summaries[0].bindings[key]);
    }
    assert.equal(summary.bindings.source, expected.source);
    if (expected.ci === null) assert.equal(summary.ci, null);
    else {
      assert.equal(summary.ci.run, expected.ci.run);
      assert.equal(summary.ci.sha, expected.ci.sha);
      assert.equal(summary.ci.job, "jvm-wrappers-arm64");
      assert.ok(
        positive(summary.ci.attempt) &&
          summary.ci.attempt <= expected.ci.attempt,
        "JVM receipt has an invalid or future execution attempt",
      );
    }
    const obligations = summary.obligations;
    if (summary.phase === "baseline") {
      assert.ok(positive(obligations.baseline));
      assert.equal(obligations.preparationOwnership, true);
    } else if (summary.phase === "acceptance") {
      assert.equal(obligations.source, 9);
      assert.equal(obligations.installed, 9);
      assert.equal(obligations.offlineProductionInstall, true);
      assert.equal(obligations.harnessOutsideInstalledPackage, true);
    } else {
      assert.equal(obligations.guards, 21);
      assert.match(obligations.guardIdsSha256, digestPattern);
      assert.ok(positive(obligations.regressions));
    }
  }
  return {
    complete: true,
    phases: [...jvmWrapperPhases],
    bindings: summaries[0].bindings,
    receipts: summaries.map(({ phase, receiptSha256, ci, obligations }) => ({
      phase,
      receiptSha256,
      ci,
      obligations,
    })),
    gateAComplete: false,
  };
}

export function requireJvmWrapperPhaseOutputs(outputs, expected) {
  assert.deepEqual(
    Object.keys(outputs).toSorted(),
    Object.values(outputNames).toSorted(),
  );
  const summaries = jvmWrapperPhases.map((phase) => {
    const text = outputs[outputNames[phase]];
    assert.ok(typeof text === "string" && Buffer.byteLength(text) <= 16384);
    const summary = JSON.parse(text);
    assert.equal(summary.phase, phase);
    return summary;
  });
  return requireJvmWrapperPhaseSummaries(summaries, expected);
}

export async function publishJvmWrapperPhaseOutput(summary, outputFile) {
  assert.ok(Object.hasOwn(outputNames, summary.phase));
  assert.ok(path.isAbsolute(outputFile));
  const text = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(text) <= 16384);
  await appendFile(outputFile, outputNames[summary.phase] + "=" + text + "\n");
}
