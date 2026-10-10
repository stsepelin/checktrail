import assert from "node:assert/strict";
import {
  copyFile,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { extendedKubernetesFixture } from "../dist/test/kubernetes-extensions-fixture.js";
import { createPlan, validate } from "../dist/src/engine.js";
const root = fileURLToPath(new URL("../", import.meta.url)),
  cleanups = [],
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  fixture = await extendedKubernetesFixture({
    after: (callback) => cleanups.push(callback),
  });
const directory = path.join(fixture, ".checktrail/operator-tools");
await mkdir(directory, { recursive: true });
const tool = path.join(directory, "kubeconform");
await copyFile("/usr/local/bin/kubeconform", tool);
await chmod(tool, 0o755);
const previous = process.env.PATH;
process.env.PATH = directory + path.delimiter + (previous ?? "");
try {
  const check = (await createPlan(fixture)).plan.checks[0],
    report = await validate(fixture, { trusted: true, timeoutMs: 120000 });
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  const receipt = path.join(directory, "receipt.json");
  await writeFile(
    receipt,
    JSON.stringify({
      root: fixture,
      check,
      process: report.checks[0].processes[0],
    }),
  );
  const callback = path.join(
      root,
      "dist/test/kubernetes-evidence-controls.test.js",
    ),
    before = await readFile(callback),
    schemaGate = [
      [
        "JSON.stringify(packet.schemas) ===",
        "true || JSON.stringify(packet.schemas) ===",
      ],
    ],
    hashGate = [["mavenHash(bytes) !== sha256", "false"]],
    controls = [
      ...["source", "policy", "schema", "tool"].map((label) => ({
        name: "Kubernetes guard checks current physical " + label + " bytes",
        file: "kubernetes-extensions.js",
        edits: hashGate,
      })),
      ...[
        "native schema inventory",
        "native schema pre-hash",
        "native schema post-hash",
      ].map((label) => ({
        name: "Kubernetes guard checks " + label,
        file: "kubeconform-evidence.js",
        edits: schemaGate,
      })),
      {
        name: "Kubernetes guard checks native stdout hash",
        file: "kubeconform-evidence.js",
        edits: [["row.stdoutSha256 === mavenHash(row.stdout)", "true"]],
      },
      {
        name: "Kubernetes guard checks native stderr hash",
        file: "kubeconform-evidence.js",
        edits: [["row.stderrSha256 === mavenHash(row.stderr)", "true"]],
      },
      {
        name: "Kubernetes guard checks native command arguments",
        file: "kubeconform-evidence.js",
        edits: [["JSON.stringify(row.args) === JSON.stringify(args)", "true"]],
      },
      {
        name: "Kubernetes guard checks native resource participation",
        file: "kubeconform-evidence.js",
        edits: [
          ["result.resources.length === documents.length", "true"],
          ["counts.valid + counts.invalid === documents.length", "true"],
        ],
      },
      {
        name: "Kubernetes guard checks native skipped resources",
        file: "kubeconform-evidence.js",
        edits: [
          ["counts.skipped === 0", "true"],
          ["counts.valid + counts.invalid === documents.length", "true"],
        ],
      },
      {
        name: "Kubernetes guard checks whole kind identifiers",
        file: "kubeconform.js",
        edits: [["pin.kind === data.kind", "data.kind.startsWith(pin.kind)"]],
      },
      {
        name: "Kubernetes guard checks whole API identifiers",
        file: "kubeconform.js",
        edits: [
          [
            "pin.version === data.apiVersion",
            "data.apiVersion.startsWith(pin.version)",
          ],
        ],
      },
    ],
    results = [];
  const run = (name) => {
    const env = {
      ...process.env,
      CHECKTRAIL_KUBERNETES_GUARD_RECEIPT: receipt,
    };
    delete env.NODE_TEST_CONTEXT;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "--test-name-pattern=^" + escaped + "$",
        callback,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 120000, maxBuffer: 1048576 },
    );
  };
  for (const control of controls) {
    const file = path.join(root, "dist/src", control.file),
      original = await readFile(file, "utf8"),
      originalRun = run(control.name);
    assert.equal(
      originalRun.status,
      0,
      originalRun.stdout + originalRun.stderr,
    );
    assert.match(originalRun.stdout, /^# pass 1$/m);
    assert.match(originalRun.stdout, /^# skipped 0$/m);
    let mutant = original;
    for (const [from, to] of control.edits) {
      assert.equal(
        mutant.split(from).length,
        2,
        "One exact mutation address: " + from,
      );
      mutant = mutant.replace(from, to);
    }
    try {
      await writeFile(file, mutant);
      const compiled = spawnSync(process.execPath, ["--check", file], {
        encoding: "utf8",
      });
      assert.equal(compiled.status, 0, compiled.stderr);
      const failed = run(control.name);
      assert.equal(failed.status, 1, failed.stdout + failed.stderr);
      assert.match(failed.stdout, /code: 'ERR_ASSERTION'/);
      assert.match(failed.stdout, /^# fail 1$/m);
      assert.match(failed.stdout, /^# skipped 0$/m);
    } finally {
      await writeFile(file, original);
    }
    const restored = run(control.name);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /^# pass 1$/m);
    assert.equal(await readFile(file, "utf8"), original);
    results.push({
      name: control.name,
      source: control.file,
      guardsRemovedTogether: control.edits.length,
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
      restoredPassed: true,
      originalSha256: hash(original),
      mutantSha256: hash(mutant),
    });
  }
  assert.deepEqual(await readFile(callback), before);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "kubernetes-extensions",
      controls: results,
      callbacks: [{ file: path.basename(callback), sha256: hash(before) }],
      sourceRestored: true,
      callbacksUnchanged: true,
      allComplete: true,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
} finally {
  if (previous === undefined) delete process.env.PATH;
  else process.env.PATH = previous;
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(directory, { recursive: true, force: true });
}
