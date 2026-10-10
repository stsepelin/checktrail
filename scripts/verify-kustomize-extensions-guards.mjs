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
import { extendedKustomizeFixture } from "../dist/test/kustomize-extensions-fixture.js";
import { createPlan, validate } from "../dist/src/engine.js";
const root = fileURLToPath(new URL("../", import.meta.url)),
  cleanups = [],
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  fixture = await extendedKustomizeFixture({
    after: (callback) => cleanups.push(callback),
  });
const directory = path.join(fixture, ".checktrail/operator-tools");
await mkdir(directory, { recursive: true });
for (const name of ["kustomize", "kubeconform"]) {
  const tool = path.join(directory, name);
  await copyFile("/usr/local/bin/" + name, tool);
  await chmod(tool, 0o755);
}
const overlay = path.join(fixture, "overlay/kustomization.yaml"),
  base = path.join(fixture, "base/kustomization.yaml");
await writeFile(
  overlay,
  (await readFile(overlay, "utf8")).replace(
    "namePrefix: original-preview-",
    "namePrefix: original-preview-\nnameSuffix: -checked",
  ),
);
await writeFile(
  base,
  (await readFile(base, "utf8")) +
    "  - name: original-other-settings\n    literals:\n      - mode=original\n      - channel=review\n",
);
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
      "dist/test/kustomize-evidence-controls.test.js",
    ),
    before = await readFile(callback),
    schemaGate = [
      [
        "kustomizeCanonical(packet.schemas) ===",
        "true || kustomizeCanonical(packet.schemas) ===",
      ],
    ],
    controls = [
      ...[
        "source",
        "policy",
        "schema",
        "kustomize tool",
        "kubeconform tool",
      ].map((label) => ({
        name: "Kustomize guard checks current physical " + label + " bytes",
        file: "kubernetes-extensions.js",
        edits: [["mavenHash(bytes) !== sha256", "false"]],
      })),
      {
        name: "Kustomize guard checks native schema inventory",
        file: "kustomize-evidence.js",
        edits: [...schemaGate, [".length(kubeSchemaPins.length)", ".min(1)"]],
      },
      ...["native schema pre-hash", "native schema post-hash"].map((label) => ({
        name: "Kustomize guard checks " + label,
        file: "kustomize-evidence.js",
        edits: schemaGate,
      })),
      {
        name: "Kustomize guard checks native stdout hash",
        file: "kustomize-evidence.js",
        edits: [["row.stdoutSha256 === mavenHash(row.stdout)", "true"]],
      },
      {
        name: "Kustomize guard checks native stderr hash",
        file: "kustomize-evidence.js",
        edits: [["row.stderrSha256 === mavenHash(row.stderr)", "true"]],
      },
      {
        name: "Kustomize guard checks native command arguments",
        file: "kustomize-evidence.js",
        edits: [
          ["kustomizeCanonical(row.args) === kustomizeCanonical(args)", "true"],
        ],
      },
      {
        name: "Kustomize guard checks rendered document post-hash",
        file: "kustomize-evidence.js",
        edits: [["observed.afterSha256 === sha256", "true"]],
      },
      {
        name: "Kustomize guard checks complete rendered resource participation",
        file: "kustomize-evidence.js",
        edits: [
          ["parsed.length === expected.length", "true"],
          ["packet.documents.length === expected.length", "true"],
        ],
      },
      {
        name: "Kustomize guard checks declared patch participation",
        file: "kustomize-extensions.js",
        edits: [
          [
            /patches.size ===\s*\(config.patches \?\? \[\]\)\s*\.length/.exec(
              await readFile(
                path.join(root, "dist/src/kustomize-extensions.js"),
                "utf8",
              ),
            )[0],
            "true",
          ],
        ],
      },
      {
        name: "Kustomize guard checks whole JSON patch identifiers",
        file: "kustomize-extensions.js",
        edits: [
          [
            "m.aliases.has(selector.name)",
            "[...m.aliases].some(n => selector.name.startsWith(n))",
          ],
        ],
      },
      {
        name: "Kustomize guard checks whole strategic patch identifiers",
        file: "kustomize-extensions.js",
        edits: [
          [
            "m.aliases.has(String(metadata.name))",
            "[...m.aliases].some(n => String(metadata.name).startsWith(n))",
          ],
        ],
      },
      {
        name: "Kustomize guard checks whole replica identifiers",
        file: "kustomize-extensions.js",
        edits: [
          [
            "m.aliases.has(replica.name)",
            "[...m.aliases].some(n => replica.name.startsWith(n))",
          ],
        ],
      },
      {
        name: "Kustomize guard checks raw policy identity",
        file: "kustomize-extensions.js",
        edits: [
          [
            "kustomizeCanonical(JSON.parse(policy.text)) ===",
            "true || kustomizeCanonical(JSON.parse(policy.text)) ===",
          ],
        ],
      },
      {
        name: "Kustomize guard checks physical patch source file",
        file: "kustomize-extensions.js",
        edits: [
          [
            "overrides.push({ pointer, ...t.address });",
            "overrides.push({ pointer, ...t.address, file: m.source.file });",
          ],
        ],
      },
      {
        name: "Kustomize guard checks physical patch source line",
        file: "kustomize-extensions.js",
        edits: [
          [
            "overrides.push({ pointer, ...t.address });",
            "overrides.push({ pointer, ...t.address, line: t.address.line + 1 });",
          ],
        ],
      },
      {
        name: "Kustomize guard checks whole image identifiers",
        file: "kustomize-extensions.js",
        edits: [["base !== image.name", "!base.startsWith(image.name)"]],
      },
      {
        name: "Kustomize guard reconciles native generated content hash",
        file: "kustomize-extensions.js",
        edits: [["mavenHash(goJson(payload)).slice(0, 10)", '"ffffffffff"']],
      },
      {
        name: "Kustomize guard reconciles native generated ConfigMap references",
        file: "kustomize-extensions.js",
        edits: [
          [
            'leaf.scalar = scalar(found[0].root, ["metadata", "name"]);',
            "leaf.scalar = current;",
          ],
        ],
      },
      {
        name: "Kustomize guard reconciles native namespace transform",
        file: "kustomize-extensions.js",
        edits: [["if (d.namespace)", "if (false)"]],
      },
      {
        name: "Kustomize guard reconciles native name prefix",
        file: "kustomize-extensions.js",
        edits: [['(d.namePrefix ?? "") + prior', '"" + prior']],
      },
      {
        name: "Kustomize guard reconciles native name suffix",
        file: "kustomize-extensions.js",
        edits: [['(d.nameSuffix ?? "")', '""']],
      },
      {
        name: "Kustomize guard reconciles native image transform",
        file: "kustomize-extensions.js",
        edits: [["base !== image.name", "true"]],
      },
      {
        name: "Kustomize guard reconciles native replica transform",
        file: "kustomize-extensions.js",
        edits: [["replica.count, p.address", "0, p.address"]],
      },
    ],
    results = [];
  const run = (name) => {
    const env = {
      ...process.env,
      CHECKTRAIL_KUSTOMIZE_GUARD_RECEIPT: receipt,
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
      profile: "kustomize-extensions",
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
