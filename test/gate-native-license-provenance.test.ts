import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { reportSummarySchema } from "../src/schemas.js";
import {
  coordinator,
  provenanceFixture,
  provenanceNotice,
  provenanceRepository,
  hash,
  retainedProvenanceReceipt,
  runProvenance,
  observeProvenanceBootstrap,
  assertProvenanceProcessGone,
  removeProvenanceNotice,
  type ProvenanceReceipt,
} from "./native-license-provenance-fixture.js";
const exec = promisify(execFile);
const selected = {
  skip:
    process.env.CHECKTRAIL_NATIVE_LICENSE_COMPOSITION_NATIVE !== "1" &&
    "Explicit operator provenance composition profile not selected",
};
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const completeAccounting = (receipt: ProvenanceReceipt) => {
  assert.deepEqual(
    receipt.audits.map((row) => row.phase),
    ["npm-production", "npm-development", "selected-artifact-evidence"],
  );
  assert.deepEqual(
    receipt.proofs.map((row) => row.family),
    ["random-provider", "scala2", "fantomas", "context-runtime"],
  );
  assert.equal(receipt.unresolved.length, 4);
  assert.ok(receipt.unresolved.every((row) => row.state === "unverified"));
  for (const key of [
    "legalComplianceAssessed",
    "cryptographicVerificationExecutedByCoordinator",
    "fullCompilerSdkBootstrapClosureVerified",
    "completeOriginalNoticeClosureVerified",
    "gateAComplete",
  ] as const)
    assert.equal(receipt[key], false);
};
async function cliRun(args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return result;
  }
}
async function rewritePolicy(
  root: string,
  packed: { bytes: Buffer },
  update: (policy: Record<string, unknown>) => void,
) {
  const bundle = JSON.parse(packed.bytes.toString()) as {
    manifestBase64: string;
    files: Array<{ path: string; base64: string }>;
  };
  const file = bundle.files.find((row) => row.path === "policy.json")!;
  const policy = JSON.parse(
    Buffer.from(file.base64, "base64").toString(),
  ) as Record<string, unknown>;
  update(policy);
  const body = Buffer.from(JSON.stringify(policy));
  file.base64 = body.toString("base64");
  const manifest = JSON.parse(
    Buffer.from(bundle.manifestBase64, "base64").toString(),
  ) as { files: Array<{ path: string; sha256: string }> };
  manifest.files.find((row) => row.path === "policy.json")!.sha256 = hash(body);
  bundle.manifestBase64 = Buffer.from(JSON.stringify(manifest)).toString(
    "base64",
  );
  const bytes = Buffer.from(JSON.stringify(bundle)),
    target = path.join(root, "changed-" + hash(bytes) + ".bundle.json");
  await writeFile(target, bytes);
  return { path: target, sha256: hash(bytes) };
}

test(
  "native-license-provenance broken acceptance",
  { ...selected, timeout: 60000 },
  async (t) => {
    const f = await provenanceFixture(t);
    await writeFile(
      path.join(f.evidence, "NOTICE-synthetic.txt"),
      "A changed synthetic notice; the original hash remains pinned\n",
    );
    const packed = await f.prepare(),
      report = await runProvenance(f.project, packed.reference),
      receipt = retainedProvenanceReceipt(report);
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "error");
    assert.equal(receipt.state, "error");
    assert.equal(receipt.audits[0]!.state, "consistent-within-npm-scope");
    assert.equal(receipt.audits[1]!.inspectedPackageCount, 2);
    assert.equal(receipt.audits[2]!.exitCode, 2);
    assert.match(receipt.error!, /selected-artifact-evidence/u);
    assert.ok(receipt.proofs.every((row) => row.state === "unrun"));
    completeAccounting(receipt);
  },
);

test(
  "native-license-provenance fixed acceptance",
  { ...selected, timeout: 60000 },
  async (t) => {
    const f = await provenanceFixture(t),
      packed = await f.prepare();
    const report = await runProvenance(f.project, packed.reference),
      receipt = retainedProvenanceReceipt(report);
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "inconclusive");
    assert.equal(receipt.state, "incomplete");
    assert.deepEqual(
      receipt.audits.map((row) => row.state),
      [
        "consistent-within-npm-scope",
        "consistent-within-npm-scope",
        "consistent-observations-only",
      ],
    );
    assert.deepEqual(
      receipt.audits.slice(0, 2).map((row) => row.inspectedPackageCount),
      [1, 2],
    );
    assert.deepEqual(receipt.inputs, {
      engine: packed.policy.engine.identity,
      npm: packed.policy.npm.identity,
      artifacts: packed.policy.artifacts.identity,
    });
    assert.ok(
      receipt.audits.every(
        (row) =>
          row.exitCode === 0 &&
          /^[a-f0-9]{64}$/u.test(row.stdoutSha256!) &&
          /^[a-f0-9]{64}$/u.test(row.auditorSha256!),
      ),
    );
    assert.ok(receipt.proofs.every((row) => row.state === "unselected"));
    completeAccounting(receipt);
    const events = (await readFile(f.journal, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row) as { state: string });
    assert.equal(
      events.filter((row) => row.state === "audit-bootstrap-entered").length,
      3,
    );
    assert.equal(
      events.filter((row) => row.state === "audit-observed").length,
      3,
    );
  },
);

test(
  "native-license-provenance near-miss acceptance",
  { ...selected, timeout: 60000 },
  async (t) => {
    const f = await provenanceFixture(t);
    await removeProvenanceNotice(f.npm);
    await writeFile(
      path.join(f.project, "inert-project.mjs"),
      "throw new Error('project modules must never be imported by audits');\n",
    );
    const beforeEmpty = (await f.prepare()).policy.npm.identity;
    const empty = path.join(f.npm, "ordinary-empty.txt");
    await writeFile(empty, "");
    const packed = await f.prepare();
    assert.equal(packed.policy.npm.identity.files, beforeEmpty.files + 1);
    assert.equal(packed.policy.npm.identity.bytes, beforeEmpty.bytes);
    assert.notEqual(packed.policy.npm.identity.sha256, beforeEmpty.sha256);
    const report = await runProvenance(f.project, packed.reference),
      receipt = retainedProvenanceReceipt(report);
    assert.equal((await readFile(empty)).length, 0);
    assert.deepEqual(receipt.inputs.npm, packed.policy.npm.identity);
    assert.equal(receipt.state, "incomplete");
    assert.equal(receipt.audits[0]!.gaps, 0);
    assert.equal(receipt.audits[1]!.exitCode, 2);
    assert.equal(receipt.audits[1]!.state, "incomplete");
    assert.equal(receipt.audits[1]!.gaps, 1);
    assert.equal(receipt.audits[2]!.state, "consistent-observations-only");
    assert.equal(
      await readFile(path.join(f.evidence, "NOTICE-synthetic.txt"), "utf8"),
      provenanceNotice,
    );
    assert.ok(
      receipt.proofs.every(
        (row) => row.nativeVerificationObservedByCoordinator === false,
      ),
    );
    completeAccounting(receipt);
  },
);

test(
  "native-license-provenance prerequisite acceptance",
  { ...selected, timeout: 120000 },
  async (t) => {
    const f = await provenanceFixture(t),
      missing = path.join(f.root, "selected-proof");
    await mkdir(missing);
    await writeFile(path.join(missing, "release-signature-proof.json"), "{}");
    await writeFile(path.join(missing, "proof.json"), "{}");
    for (const family of coordinator.provenanceFamilies as string[]) {
      const proofs = coordinator.provenanceFamilies.map((name: string) =>
        name === family
          ? {
              family: name,
              selection: "operator-pinned",
              root: missing,
              sha256: "a".repeat(64),
            }
          : { family: name, selection: "unselected" },
      );
      const packed = await f.prepare({ proofs }),
        report = await runProvenance(f.project, packed.reference),
        receipt = retainedProvenanceReceipt(report);
      assert.equal(receipt.state, "error", family);
      assert.equal(report.outcome, "incomplete");
      assert.equal(
        receipt.proofs.find((row) => row.family === family)!.state,
        "admission-incomplete",
      );
      assert.ok(
        !receipt.proofs.some(
          (row) => row.state === "operator-pinned-scope-reconciled",
        ),
      );
      completeAccounting(receipt);
    }
    const emptyNpmCli = path.join(f.root, "empty-npm-cli.mjs");
    await writeFile(emptyNpmCli, "");
    await assert.rejects(
      f.prepare({ npmCliFile: emptyNpmCli }),
      /Bounded regular provenance file required/,
    );
    const safe = await f.prepare();
    for (const args of [
      ["--npm-cli"],
      ["--npm-cli", "relative-npm.mjs"],
      ["--npm-cli", safe.policy.runtime.npm.file, "--help"],
      ["--include-dev", "--include-dev"],
    ]) {
      const result = await exec(
        process.execPath,
        [path.join(f.npm, "scripts/audit-dependencies.mjs"), ...args],
        { timeout: 10000 },
      )
        .then((row) => ({ ...row, code: 0 }))
        .catch(
          (error) => error as { code: number; stdout: string; stderr: string },
        );
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
    }
    const packed = await f.prepare();
    await rm(path.join(f.npm, "scripts/audit-dependencies.mjs"));
    const receipt = retainedProvenanceReceipt(
      await runProvenance(f.project, packed.reference),
    );
    assert.equal(receipt.state, "error");
    assert.ok(receipt.audits.every((row) => row.state === "unrun"));
    completeAccounting(receipt);
  },
);

test(
  "native-license-provenance stale acceptance",
  { ...selected, timeout: 90000 },
  async (t) => {
    for (const input of ["source", "dependency"]) {
      const f = await provenanceFixture(t),
        packed = await f.prepare();
      await writeFile(
        input === "source"
          ? path.join(f.artifacts, "src/synthetic.ts")
          : path.join(f.npm, "package-lock.json"),
        "Changed after startup selection\n",
      );
      const receipt = retainedProvenanceReceipt(
        await runProvenance(f.project, packed.reference),
      );
      assert.equal(receipt.state, "error");
      assert.match(receipt.error!, /input identity changed/u);
      assert.ok(receipt.audits.every((row) => row.state === "unrun"));
      completeAccounting(receipt);
    }
    const identityControl = await provenanceFixture(t),
      nodeControl = path.join(identityControl.root, "synthetic-node-image"),
      npmControl = path.join(identityControl.root, "synthetic-npm-entry");
    await writeFile(nodeControl, "Original synthetic selected runtime image\n");
    await writeFile(
      npmControl,
      "Original synthetic selected inspection entry\n",
    );
    const selectedRuntime = {
      executable: {
        file: nodeControl,
        sha256: hash(await readFile(nodeControl)),
      },
      npm: { file: npmControl, sha256: hash(await readFile(npmControl)) },
    };
    await coordinator.recheckProvenanceRuntimeFiles(selectedRuntime);
    await writeFile(nodeControl, "Changed synthetic selected runtime image\n");
    await assert.rejects(
      coordinator.recheckProvenanceRuntimeFiles(selectedRuntime),
      /Selected Node executable changed/u,
    );
    await writeFile(nodeControl, "Original synthetic selected runtime image\n");
    await writeFile(
      npmControl,
      "Changed synthetic selected inspection entry\n",
    );
    await assert.rejects(
      coordinator.recheckProvenanceRuntimeFiles(selectedRuntime),
      /Inspection runtime changed/u,
    );
    const f = await provenanceFixture(t),
      packed = await f.prepare();
    const foreign = await rewritePolicy(f.root, packed, (policy) => {
      (policy.runtime as { node: string }).node = "0.0.0";
    });
    const receipt = retainedProvenanceReceipt(
      await runProvenance(f.project, foreign),
    );
    assert.equal(receipt.state, "error");
    assert.match(receipt.error!, /runtime identity changed/u);
    completeAccounting(receipt);
    // A different operator-selected input root must actually be audited, not cwd or Checktrail's install.
    const wrong = await provenanceFixture(t);
    await removeProvenanceNotice(wrong.npm);
    const wrongPacked = await coordinator.createNativeProvenanceBundle({
      engineRoot: f.engineRoot,
      npmRoot: wrong.npm,
      artifactRoot: f.artifacts,
      journal: f.journal,
    });
    const target = path.join(f.root, "wrong-root.bundle.json");
    await writeFile(target, wrongPacked.bytes);
    const wrongReceipt = retainedProvenanceReceipt(
      await runProvenance(f.project, {
        path: target,
        sha256: hash(wrongPacked.bytes),
      }),
    );
    assert.equal(
      wrongReceipt.inputs.npm!.sha256,
      wrongPacked.policy.npm.identity.sha256,
    );
    assert.notEqual(
      wrongReceipt.inputs.npm!.sha256,
      packed.policy.npm.identity.sha256,
    );
    assert.equal(wrongReceipt.audits[1]!.gaps, 1);
    const during = await provenanceFixture(t),
      ordinary = await during.prepare(),
      ready = path.join(during.root, "entered.json"),
      release = path.join(during.root, "release"),
      wrapper = path.join(during.root, "inspection-wrapper.mjs");
    await writeFile(
      wrapper,
      `import{writeFileSync,existsSync}from'node:fs';import{execFileSync}from'node:child_process';writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,5));process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(ordinary.policy.runtime.npm.file)},...process.argv.slice(2)],{encoding:'utf8',timeout:10000}));`,
    );
    const controlled = await during.prepare({ npmCliFile: wrapper }),
      control = new AbortController(),
      running = runProvenance(during.project, controlled.reference, {
        signal: control.signal,
      });
    try {
      await observeProvenanceBootstrap(during.journal);
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (
          await readFile(ready)
            .then(() => true)
            .catch(() => false)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        await readFile(ready),
        "Actual inspection body must be reached before changing an input",
      );
      await writeFile(
        path.join(during.npm, "changed-during-observation.txt"),
        "Original synthetic late input change\n",
      );
      await writeFile(release, "release");
      const changed = retainedProvenanceReceipt(await running);
      assert.equal(changed.state, "error");
      assert.match(
        changed.error!,
        /Provenance input changed during observation/u,
      );
      assert.deepEqual(
        changed.audits.map((row) => row.state),
        [
          "consistent-within-npm-scope",
          "consistent-within-npm-scope",
          "consistent-observations-only",
        ],
      );
      completeAccounting(changed);
    } finally {
      await writeFile(release, "release");
      control.abort();
      await running;
    }
    const beforeExecute = await provenanceFixture(t),
      initial = await beforeExecute.prepare(),
      changedCli = path.join(beforeExecute.root, "changed-cli.mjs"),
      reached = path.join(beforeExecute.root, "must-not-execute");
    await writeFile(
      changedCli,
      `import{execFileSync}from'node:child_process';process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(initial.policy.runtime.npm.file)},...process.argv.slice(2)],{encoding:'utf8'}));`,
    );
    const selectedCli = await beforeExecute.prepare({ npmCliFile: changedCli });
    await writeFile(
      changedCli,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(reached)},'unsafe');import{execFileSync}from'node:child_process';process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(initial.policy.runtime.npm.file)},...process.argv.slice(2)],{encoding:'utf8'}));`,
    );
    const refusedCli = retainedProvenanceReceipt(
      await runProvenance(beforeExecute.project, selectedCli.reference),
    );
    assert.equal(refusedCli.state, "error");
    assert.match(refusedCli.error!, /runtime identity changed/u);
    await assert.rejects(readFile(reached));
    completeAccounting(refusedCli);
    // Synthetic guard instrumentation in a task-owned first-party copy. These
    // observations prove final-call wiring, never native-positive runtime proof.
    const guard = await provenanceFixture(t),
      guardBundle = await guard.prepare(),
      guardDirectory = path.join(guard.root, "synthetic-guard-copy");
    await mkdir(guardDirectory);
    for (const name of [
      "audit-dependencies.mjs",
      "audit-selected-artifact-evidence.mjs",
      "pango-complete-text-binding.mjs",
    ])
      await copyFile(
        path.join(provenanceRepository, "scripts", name),
        path.join(guardDirectory, name),
      );
    const originalCoordinator = await readFile(
      path.join(
        provenanceRepository,
        "scripts/native-provenance-coordinator.mjs",
      ),
      "utf8",
    );
    const declaration =
        "export async function recheckProvenanceRuntimeFiles(runtime) {",
      marker = "SYNTHETIC_FINAL_RUNTIME_GUARD_REACHED";
    assert.equal(originalCoordinator.split(declaration).length, 2);
    const instrumented = originalCoordinator.replace(
        declaration,
        declaration + `\n  throw new Error(${JSON.stringify(marker)});`,
      ),
      instrumentedPath = path.join(
        guardDirectory,
        "instrumented-coordinator.mjs",
      );
    await writeFile(instrumentedPath, instrumented);
    const selectedGuard = await rewritePolicy(
      guard.root,
      guardBundle,
      (policy) => {
        policy.coordinator = {
          file: instrumentedPath,
          sha256: hash(instrumented),
        };
      },
    );
    const witnessed = retainedProvenanceReceipt(
      await runProvenance(guard.project, selectedGuard),
    );
    assert.equal(witnessed.state, "error");
    assert.ok(witnessed.error!.includes(marker));
    assert.deepEqual(
      witnessed.audits.map((row) => row.state),
      [
        "consistent-within-npm-scope",
        "consistent-within-npm-scope",
        "consistent-observations-only",
      ],
    );
    assert.ok(witnessed.proofs.every((row) => row.state === "unselected"));
    completeAccounting(witnessed);
    const finalCall = "await recheckProvenanceRuntimeFiles(policy.runtime);";
    assert.equal(instrumented.split(finalCall).length, 2);
    const bypassed = instrumented.replace(
        finalCall,
        "/* Synthetic counterfactual: final runtime check omitted. */",
      ),
      bypassedPath = path.join(guardDirectory, "bypassed-coordinator.mjs");
    await writeFile(bypassedPath, bypassed);
    const bypass = await rewritePolicy(guard.root, guardBundle, (policy) => {
      policy.coordinator = { file: bypassedPath, sha256: hash(bypassed) };
    });
    const unguarded = retainedProvenanceReceipt(
      await runProvenance(guard.project, bypass),
    );
    assert.equal(unguarded.state, "incomplete");
    assert.equal(unguarded.error, undefined);
    assert.deepEqual(
      unguarded.audits.map((row) => row.stdoutSha256),
      witnessed.audits.map((row) => row.stdoutSha256),
    );
    completeAccounting(unguarded);
  },
);

test(
  "native-license-provenance empty acceptance",
  { ...selected, timeout: 90000 },
  async (t) => {
    const f = await provenanceFixture(t);
    await rm(path.join(f.evidence, "scala2.json"));
    const packed = await f.prepare(),
      receipt = retainedProvenanceReceipt(
        await runProvenance(f.project, packed.reference),
      );
    assert.equal(receipt.state, "error");
    assert.equal(receipt.audits[2]!.exitCode, 2);
    completeAccounting(receipt);
    const near = await provenanceFixture(t),
      good = await near.prepare();
    for (const change of [
      (p: Record<string, unknown>) => {
        (p.proofs as unknown[]).pop();
      },
      (p: Record<string, unknown>) => {
        (p.proofs as unknown[]).push((p.proofs as unknown[])[0]);
      },
    ]) {
      const reference = await rewritePolicy(near.root, good, change);
      const report = await runProvenance(near.project, reference);
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks[0]!.status, "error");
    }
    const promoted = JSON.parse(
      await readFile(path.join(near.evidence, "fantomas.json"), "utf8"),
    ) as { gateAComplete: boolean };
    promoted.gateAComplete = true;
    const raw = Buffer.from(JSON.stringify(promoted));
    await writeFile(path.join(near.evidence, "fantomas.json"), raw);
    const indexPath = path.join(
        near.evidence,
        "artifact-evidence-index.v1.json",
      ),
      index = JSON.parse(await readFile(indexPath, "utf8")) as {
        files: Array<{ file: string; bytes: number; sha256: string }>;
      };
    Object.assign(
      index.files.find((row) => row.file === "fantomas.json")!,
      { bytes: raw.length, sha256: hash(raw) },
    );
    await writeFile(indexPath, JSON.stringify(index));
    const bad = await near.prepare(),
      refused = retainedProvenanceReceipt(
        await runProvenance(near.project, bad.reference),
      );
    assert.equal(refused.state, "error");
    assert.equal(refused.audits[2]!.exitCode, 2);
    completeAccounting(refused);
  },
);

test(
  "native-license-provenance privacy acceptance",
  { ...selected, timeout: 120000 },
  async (t) => {
    const f = await provenanceFixture(t),
      packed = await f.prepare();
    const plan = await createPlan(f.project, {
      externalAdapters: [packed.reference],
    });
    assert.equal(plan.plan.checks.length, 1);
    await assert.rejects(
      validate(f.project, {
        trusted: false,
        externalAdapters: [packed.reference],
      }),
      /operator trust/u,
    );
    await assert.rejects(readFile(f.journal));
    const token = `${packed.reference.path}#sha256=${packed.reference.sha256}`;
    const denied = await cliRun([
      "run",
      "--root",
      f.project,
      "--adapter",
      token,
    ]);
    assert.equal(denied.code, 2);
    await assert.rejects(readFile(f.journal));
    await writeFile(
      path.join(f.project, "unrelated.txt"),
      "Unrelated private source content which the operator audits do not inspect\n",
    );
    const expanded = JSON.parse(packed.bytes.toString()) as {
      manifestBase64: string;
    };
    const expandedManifest = JSON.parse(
      Buffer.from(expanded.manifestBase64, "base64").toString(),
    ) as { checks: Array<{ scope: { names: string[] } }> };
    expandedManifest.checks[0]!.scope.names.push("unrelated.txt");
    expanded.manifestBase64 = Buffer.from(
      JSON.stringify(expandedManifest),
    ).toString("base64");
    const expandedBytes = Buffer.from(JSON.stringify(expanded)),
      expandedPath = path.join(f.root, "expanded-scope.bundle.json");
    await writeFile(expandedPath, expandedBytes);
    const expandedReference = {
        path: expandedPath,
        sha256: hash(expandedBytes),
      },
      sourceReport = await runProvenance(f.project, expandedReference);
    const sourceEnvelope = JSON.parse(
      sourceReport.checks[0]!.processes[0]!.stdout,
    ) as { stdout: string };
    const sourceFiles = (
      JSON.parse(sourceEnvelope.stdout) as {
        files: Array<{ path: string; status: string }>;
      }
    ).files;
    assert.deepEqual(sourceFiles, [
      { path: "native-provenance.project", status: "unavailable" },
      { path: "unrelated.txt", status: "unavailable" },
    ]);
    const expandedCli = await cliRun([
      "run",
      "--root",
      f.project,
      "--adapter",
      `${expandedPath}#sha256=${expandedReference.sha256}`,
      "--trust-project",
      "--detailed",
    ]);
    assert.equal(expandedCli.code, 2);
    const cliFiles = JSON.parse(
      JSON.parse(expandedCli.stdout).checks[0].processes[0].stdout,
    ).stdout;
    assert.deepEqual(JSON.parse(cliFiles).files, sourceFiles);
    assert.ok(!expandedCli.stdout.includes("Unrelated private source content"));

    const cliResult = await cliRun([
      "run",
      "--root",
      f.project,
      "--adapter",
      token,
      "--trust-project",
    ]);
    assert.equal(cliResult.code, 2);
    const summary = reportSummarySchema.parse(JSON.parse(cliResult.stdout));
    assert.equal(summary.outcome, "incomplete");
    for (const secret of [
      f.npm,
      f.artifacts,
      f.engineRoot,
      packed.reference.path,
      provenanceNotice,
      "private marker contents",
    ])
      assert.ok(!cliResult.stdout.includes(secret));
    const connect = async (allow: boolean) => {
      const client = new Client(
        { name: "synthetic-provenance-client", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      t.after(() => client.close());
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            f.project,
            "--adapter",
            token,
            ...(allow ? ["--allow-execution"] : []),
          ],
          stderr: "pipe",
        }),
      );
      return client;
    };
    const readOnlyBefore = await readFile(f.journal, "utf8");
    const readOnly = await connect(false);
    assert.equal(
      (await readOnly.callTool({ name: "validation_plan", arguments: {} }))
        .isError,
      undefined,
    );
    assert.equal(
      (await readOnly.callTool({ name: "validation_run", arguments: {} }))
        .isError,
      true,
    );
    assert.equal(
      (
        await readOnly.callTool({
          name: "validation_run",
          arguments: { trusted: true, externalAdapters: [packed.reference] },
        })
      ).isError,
      true,
    );
    assert.equal(
      await readFile(f.journal, "utf8"),
      readOnlyBefore,
      "Read-only MCP and tool arguments cannot dispatch audit processes",
    );
    const active = await connect(true),
      response = await active.callTool({
        name: "validation_run",
        arguments: {},
      });
    assert.equal(response.isError, undefined);
    assert.equal(
      reportSummarySchema.parse(response.structuredContent).outcome,
      "incomplete",
    );
    const text = JSON.stringify(response);
    for (const secret of [
      f.npm,
      f.artifacts,
      f.engineRoot,
      packed.reference.path,
      provenanceNotice,
    ])
      assert.ok(!text.includes(secret));
    const detailed = await runProvenance(f.project, packed.reference);
    assert.equal(projectReport(detailed, false).outcome, "incomplete");
    assert.ok(
      JSON.stringify(projectReport(detailed, true)).includes(
        "CHECKTRAIL_PROVENANCE_RECEIPT",
      ),
    );
  },
);

test(
  "native-license-provenance lifecycle acceptance",
  { ...selected, timeout: 90000 },
  async (t) => {
    // The pinned synthetic inspection executable never returns metadata. It only
    // proves the real auditor reached its child before cancellation/deadline.
    for (const mode of ["cancel", "timeout"]) {
      const f = await provenanceFixture(t),
        tools = path.join(f.root, "inspection-tools"),
        ready = path.join(f.root, "inspection-ready.json");
      await mkdir(tools);
      const program = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);\n`;
      await writeFile(path.join(tools, "slow-inspection.mjs"), program);
      const packed = await f.prepare({
        npmCliFile: path.join(tools, "slow-inspection.mjs"),
        limits: {
          auditTimeoutMs: mode === "timeout" ? 2000 : 15000,
          auditOutputBytes: 1024 * 1024,
        },
      });
      const control = new AbortController(),
        running = runProvenance(f.project, packed.reference, {
          signal: control.signal,
        });
      let child: { pid: number; temporary: string } | undefined,
        inspection: { pid: number } | undefined;
      try {
        child = await observeProvenanceBootstrap(f.journal);
        const end = Date.now() + 5000;
        while (Date.now() < end && !inspection) {
          inspection = await readFile(ready, "utf8")
            .then((raw) => JSON.parse(raw) as { pid: number })
            .catch(() => undefined);
          if (!inspection)
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(
          inspection,
          "Actual audit must reach the non-returning inspection process",
        );
        process.kill(inspection.pid, 0);
        if (mode === "cancel") control.abort();
        const report = await running;
        assert.equal(report.outcome, "incomplete");
        if (mode === "cancel")
          assert.equal(report.checks[0]!.processes[0]!.cancelled, true);
        else {
          const receipt = retainedProvenanceReceipt(report);
          assert.equal(receipt.audits[0]!.timedOut, true);
          assert.ok(
            receipt.audits.slice(1).every((row) => row.state === "unrun"),
          );
          completeAccounting(receipt);
        }
        await assertProvenanceProcessGone(child.pid);
        await assertProvenanceProcessGone(inspection.pid);
        await assert.rejects(
          readFile(path.join(child.temporary, "npm-production.json")),
        );
      } finally {
        control.abort();
        await running;
      }
    }
    const f = await provenanceFixture(t),
      packed = await f.prepare({
        limits: { auditTimeoutMs: 15000, auditOutputBytes: 1024 },
      });
    const receipt = retainedProvenanceReceipt(
      await runProvenance(f.project, packed.reference),
    );
    assert.equal(receipt.audits[0]!.truncated, true);
    assert.equal(receipt.rawOutputRetentionComplete, false);
    assert.equal(receipt.state, "error");
    completeAccounting(receipt);
  },
);

test(
  "native-license-provenance installed acceptance",
  { ...selected, timeout: 180000 },
  async (t) => {
    if (
      process.env.CHECKTRAIL_NATIVE_PROVENANCE_QUALIFICATION === "1" &&
      process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED !== "1"
    ) {
      const { stdout } = await exec(
        process.execPath,
        [
          path.join(
            provenanceRepository,
            "scripts/verify-native-provenance-runtime-package.mjs",
          ),
          process.env.CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_SLOT ??
            "--development",
        ],
        { timeout: 240000, maxBuffer: 4 * 1048576 },
      );
      const capture = await import(
        pathToFileURL(
          path.join(
            provenanceRepository,
            "scripts/runtime-installation-capture.mjs",
          ),
        ).href
      );
      assert.equal(
        await capture.writeRuntimeInstallation(
          "native-provenance",
          JSON.parse(stdout),
        ),
        true,
        "Source qualification must retain its actual installed receipt",
      );
      return;
    }
    const f = await provenanceFixture(t),
      archiveRoot = path.join(f.root, "archive"),
      consumer = path.join(f.root, "consumer");
    let installedPackage: string;
    if (process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED === "1") {
      installedPackage = await realpath(
        process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE!,
      );
      assert.equal(
        await realpath(f.engineRoot),
        path.join(installedPackage, "dist/src"),
      );
    } else {
      await mkdir(archiveRoot);
      const tools = await import(
        pathToFileURL(
          path.join(
            provenanceRepository,
            "scripts/install-acceptance-package.mjs",
          ),
        ).href
      );
      tools.runAcceptanceNpm(
        ["pack", "--ignore-scripts", "--pack-destination", archiveRoot],
        { cwd: provenanceRepository, stdio: "pipe" },
      );
      const { readdir } = await import("node:fs/promises");
      const archives = (await readdir(archiveRoot)).filter((name) =>
        name.endsWith(".tgz"),
      );
      assert.equal(archives.length, 1);
      const install = await tools.installAcceptancePackage(
        provenanceRepository,
        path.join(archiveRoot, archives[0]!),
        consumer,
      );
      assert.equal(install.offlineProductionInstall, true);
      assert.equal(install.lifecycleScriptsExecuted, false);
      installedPackage = path.join(
        consumer,
        "node_modules/@stsepelin/checktrail",
      );
    }
    const installedEngine = path.join(installedPackage, "dist/src"),
      installedModule = path.join(
        installedPackage,
        "scripts/native-provenance-coordinator.mjs",
      );
    assert.notEqual(
      installedModule,
      path.join(
        provenanceRepository,
        "scripts/native-provenance-coordinator.mjs",
      ),
    );
    assert.equal(
      hash(await readFile(installedModule)),
      hash(
        await readFile(
          path.join(
            provenanceRepository,
            "scripts/native-provenance-coordinator.mjs",
          ),
        ),
      ),
    );
    const installed = await import(pathToFileURL(installedModule).href),
      engine = await import(
        pathToFileURL(path.join(installedEngine, "engine.js")).href
      );
    for (const state of ["broken", "fixed", "near-miss"]) {
      const cohort = await provenanceFixture(t);
      if (state === "broken")
        await writeFile(
          path.join(cohort.evidence, "NOTICE-synthetic.txt"),
          "Changed synthetic installed notice\n",
        );
      if (state === "near-miss") await removeProvenanceNotice(cohort.npm);
      const packed = await installed.createNativeProvenanceBundle({
        engineRoot: installedEngine,
        npmRoot: cohort.npm,
        artifactRoot: cohort.artifacts,
        journal: cohort.journal,
      });
      assert.equal(packed.policy.coordinator.file, installedModule);
      assert.equal(packed.policy.engine.root, installedEngine);
      const target = path.join(cohort.root, "installed.bundle.json");
      await writeFile(target, packed.bytes);
      const report = await engine.validate(cohort.project, {
        trusted: true,
        externalAdapters: [{ path: target, sha256: hash(packed.bytes) }],
        timeoutMs: 30000,
      });
      const receipt = retainedProvenanceReceipt(report);
      assert.equal(report.outcome, "incomplete");
      assert.equal(receipt.state, state === "broken" ? "error" : "incomplete");
      assert.equal(receipt.audits[1]!.gaps, state === "near-miss" ? 1 : 0);
      assert.ok(JSON.stringify(report).includes(installedEngine));
      assert.ok(
        !JSON.stringify(report).includes(
          path.join(provenanceRepository, "dist/src"),
        ),
      );
      completeAccounting(receipt);
    }
  },
);
