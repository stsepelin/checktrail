import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import { kustomizePacketSchema } from "../src/kustomize-evidence.js";
import { kustomizeFixture, kustomizeNative } from "./kustomize-fixture.js";
import { runProcess } from "../src/runner.js";
import { kustomizeEvidence } from "../src/kustomize-evidence.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Kustomize concurrent validations use distinct owned document and schema copies and remove them all",
  kustomizeNative,
  async (t) => {
    const root = await kustomizeFixture(t),
      reports = await Promise.all([run(root), run(root)]),
      directories = [];
    for (const report of reports) {
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      assert.equal(report.sourceChanged, false);
      const packet = kustomizePacketSchema.parse(
        JSON.parse(report.checks[0]!.processes[0]!.stdout),
      );
      directories.push(packet.temporary);
      await assert.rejects(access(packet.temporary), { code: "ENOENT" });
    }
    assert.equal(directories.length, 2);
    assert.equal(new Set(directories).size, 2);
  },
);
test(
  "native Kustomize missing tools remain unavailable and operator environment cannot replace protected execution settings",
  kustomizeNative,
  async (t) => {
    const root = await kustomizeFixture(t),
      missing = await mkdtemp(
        path.join(tmpdir(), "original-kustomize-no-tools-"),
      ),
      previous = process.env.PATH;
    try {
      process.env.PATH = missing;
      const result = await run(root);
      assert.equal(result.outcome, "incomplete");
      assert.equal(
        result.checks[0]!.status,
        "unavailable",
        JSON.stringify(result.checks),
      );
      assert.ok(
        result.checks[0]!.tools?.some((t) => t.status === "unavailable"),
      );
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(missing, { recursive: true, force: true });
    }
    for (const name of ["PATH", "KUBECONFIG", "HTTPS_PROXY", "LD_PRELOAD"]) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: ["infrastructure.kustomize"],
              environment: [name],
            },
          ],
        }),
      );
      await assert.rejects(
        createPlan(root, { environment: { [name]: "original-override" } }),
        /protected adapter settings/,
        name,
      );
    }
  },
);

test(
  "native Kustomize frozen collection rejects source and schema bytes changed after planning",
  kustomizeNative,
  async (t) => {
    for (const selected of [
      "base/settings.yaml",
      "tools/kubernetes/configmap-v1.json",
    ]) {
      const root = await kustomizeFixture(t),
        check = (await createPlan(root)).plan.checks[0]!,
        file = path.join(root, selected),
        original = await readFile(file, "utf8");
      await writeFile(
        file,
        selected.endsWith(".yaml")
          ? original.replace('original: "value"', 'original: "other"')
          : original + "\n",
      );
      const result = await runProcess(root, check.commands[0]!, {
        timeoutMs: 120000,
      });
      assert.equal(result.exitCode, 2, selected);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "Kustomize native collection unavailable or incomplete\n",
      );
      assert.ok(!result.stderr.includes(root));
      assert.equal(kustomizeEvidence(check, [result]).status, "inconclusive");
    }
  },
);
