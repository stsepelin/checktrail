import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import { terraformPacketSchema } from "../src/terraform-evidence.js";
import { terraformFixture, terraformNative } from "./terraform-fixture.js";
import { runProcess } from "../src/runner.js";
import { terraformEvidence } from "../src/terraform-evidence.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Terraform concurrent validations use distinct owned source and module copies and remove them all",
  terraformNative,
  async (t) => {
    const root = await terraformFixture(t),
      reports = await Promise.all([run(root), run(root)]),
      directories = [];
    for (const report of reports) {
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      assert.equal(report.sourceChanged, false);
      const packet = terraformPacketSchema.parse(
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
  "native Terraform missing tools remain unavailable and operator environment cannot replace protected execution settings",
  terraformNative,
  async (t) => {
    const root = await terraformFixture(t),
      missing = await mkdtemp(
        path.join(tmpdir(), "original-terraform-no-tools-"),
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
    for (const name of [
      "PATH",
      "TF_CLI_ARGS",
      "TF_CLI_CONFIG_FILE",
      "TF_DATA_DIR",
      "TF_REATTACH_PROVIDERS",
      "LD_PRELOAD",
    ]) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: ["infrastructure.terraform-validate"],
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
  "native Terraform frozen collection rejects source and declaration bytes changed after planning",
  terraformNative,
  async (t) => {
    for (const selected of [
      "main.tf.json",
      "support.tf.json",
      "checktrail.terraform.json",
    ]) {
      const root = await terraformFixture(t),
        check = (await createPlan(root)).plan.checks[0]!,
        file = path.join(root, selected),
        original = await readFile(file, "utf8");
      await writeFile(file, original + "\n");
      const result = await runProcess(root, check.commands[0]!, {
        timeoutMs: 120000,
      });
      assert.equal(result.exitCode, 2, selected);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "Terraform native collection unavailable or incomplete\n",
      );
      assert.ok(!result.stderr.includes(root));
      assert.equal(terraformEvidence(check, [result]).status, "inconclusive");
    }
  },
);
