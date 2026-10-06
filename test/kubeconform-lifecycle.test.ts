import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import { kubeconformPacketSchema } from "../src/kubeconform-evidence.js";
import { kubeFixture, kubeNative } from "./kubeconform-fixture.js";
import { runProcess } from "../src/runner.js";
import { kubeconformEvidence } from "../src/kubeconform-evidence.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Kubernetes concurrent validations use distinct owned document and schema copies and remove them all",
  kubeNative,
  async (t) => {
    const root = await kubeFixture(t),
      reports = await Promise.all([run(root), run(root)]),
      directories = [];
    for (const report of reports) {
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      assert.equal(report.sourceChanged, false);
      const packet = kubeconformPacketSchema.parse(
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
  "native Kubernetes missing tools remain unavailable and operator environment cannot replace protected execution settings",
  kubeNative,
  async (t) => {
    const root = await kubeFixture(t),
      missing = await mkdtemp(
        path.join(tmpdir(), "original-kubernetes-no-tools-"),
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
              checks: ["infrastructure.kubeconform"],
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
  "native Kubernetes frozen collection rejects source and schema bytes changed after planning",
  kubeNative,
  async (t) => {
    for (const selected of [
      "manifests/original.yaml",
      "tools/kubernetes/configmap-v1.json",
    ]) {
      const root = await kubeFixture(t),
        check = (await createPlan(root)).plan.checks[0]!,
        file = path.join(root, selected),
        original = await readFile(file, "utf8");
      await writeFile(
        file,
        selected.endsWith(".yaml")
          ? original.replace("replicas: 2", "replicas: 3")
          : original + "\n",
      );
      const result = await runProcess(root, check.commands[0]!, {
        timeoutMs: 120000,
      });
      assert.equal(result.exitCode, 2, selected);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "Kubernetes native collection unavailable or incomplete\n",
      );
      assert.ok(!result.stderr.includes(root));
      assert.equal(kubeconformEvidence(check, [result]).status, "inconclusive");
    }
  },
);
