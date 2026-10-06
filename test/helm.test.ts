import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validate, createPlan } from "../src/engine.js";
import { helmEvidence, helmPacketSchema } from "../src/helm-evidence.js";
import { mavenHash } from "../src/maven.js";
import { helmFixture, helmNative } from "./helm-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Helm lint and rendering reconcile all templates typed values failures repair and zero near misses",
  helmNative,
  async (t) => {
    const root = await helmFixture(t),
      good = await run(root),
      check = good.checks[0]!;
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(check.findingsComplete, true);
    assert.deepEqual(check.findings, []);
    assert.deepEqual(
      check.tools!.map((tool) => [tool.name, tool.status, tool.version]),
      [
        ["node", "identified", process.versions.node],
        ["helm", "identified", "4.3.0"],
      ],
    );
    const file = path.join(root, "values.yaml"),
      original = await readFile(file, "utf8");
    await writeFile(
      file,
      original.replace("replicas: 2", "replicas: original_bad_type"),
    );
    const broken = await run(root);
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      broken.checks[0]!.findings!.map((f) => [f.ruleId, f.file, f.line]),
      [["helm/values-schema", "values.yaml", 1]],
    );
    await writeFile(file, original.replace("replicas: 2", "replicas: 0"));
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native Helm maps physical Go failures and leaves rendered YAML offsets unresolved",
  helmNative,
  async (t) => {
    const root = await helmFixture(t),
      file = path.join(root, "templates/settings.yaml"),
      original = await readFile(file, "utf8");
    for (const text of [
      original.replace(
        ".Values.label",
        ".Values.original_missing.original_field",
      ),
      original.replace(
        ".Values.label | quote }}",
        ".Values.label } | quote }}",
      ),
    ]) {
      await writeFile(file, text);
      const result = await run(root);
      assert.equal(result.outcome, "failed", JSON.stringify(result.checks));
      assert.equal(result.checks[0]!.findingsComplete, true);
      assert.deepEqual(
        result.checks[0]!.findings!.map((f) => [f.ruleId, f.file, f.line]),
        [["helm/template", "templates/settings.yaml", 6]],
      );
    }
    await writeFile(
      file,
      original.replace("label: {{ .Values.label | quote }}", "label: ["),
    );
    const unresolved = await run(root);
    assert.equal(unresolved.outcome, "incomplete");
    assert.equal(unresolved.checks[0]!.status, "inconclusive");
    assert.equal(unresolved.checks[0]!.findingsComplete, false);
    assert.equal(unresolved.checks[0]!.findings, undefined);
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native Helm evidence rejects changed source copies tools commands outputs and fabricated rendered participation",
  helmNative,
  async (t) => {
    const root = await helmFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      good = (await run(root)).checks[0]!;
    assert.equal(good.status, "passed", JSON.stringify(good));
    const process = good.processes[0]!,
      packet = helmPacketSchema.parse(JSON.parse(process.stdout));
    const mutations: ((p: typeof packet) => void)[] = [
      (p) => {
        p.inputSha256 = "0".repeat(64);
      },
      (p) => {
        p.inputs[0]!.originalAfterSha256 = "0".repeat(64);
      },
      (p) => {
        p.inputs[1]!.sourceAfterSha256 = "0".repeat(64);
      },
      (p) => {
        p.inputs[1]!.nativeAfterSha256 = "0".repeat(64);
      },
      (p) => {
        p.tool.afterSha256 = "0".repeat(64);
      },
      (p) => {
        p.receipts[1]!.args.push("--quiet");
      },
      (p) => {
        p.receipts[1]!.stdout += "original";
      },
      (p) => {
        p.receipts[2]!.exitCode = 1;
      },
      (p) => {
        const r = p.receipts[2]!;
        r.stdout = r.stdout.replace(
          "# Source: original-worker/templates/worker.yaml",
          "# Source: original-worker/templates/settings.yaml",
        );
        r.stdoutSha256 = mavenHash(r.stdout);
      },
      (p) => {
        const r = p.receipts[2]!;
        r.stdout = r.stdout.split("---\n").slice(0, 2).join("---\n");
        r.stdoutSha256 = mavenHash(r.stdout);
      },
    ];
    for (const mutate of mutations) {
      const changed = globalThis.structuredClone(packet);
      mutate(changed);
      assert.equal(
        helmEvidence(check, [{ ...process, stdout: JSON.stringify(changed) }])
          .status,
        "inconclusive",
      );
    }
    for (const alteration of [
      { cancelled: true },
      { timedOut: true },
      { truncated: true },
      { exitCode: 2 },
      { stderr: "unaccounted" },
    ])
      assert.equal(
        helmEvidence(check, [{ ...process, ...alteration }]).status,
        "inconclusive",
      );
    const config = JSON.parse(check.commands[0]!.args[2]!);
    config.inputs[0].text += " ";
    const altered = globalThis.structuredClone(check);
    altered.commands[0]!.args[2] = JSON.stringify(config);
    assert.equal(helmEvidence(altered, [process]).status, "inconclusive");
  },
);
test(
  "native Helm omitted and duplicate resources never become complete coverage",
  helmNative,
  async (t) => {
    const root = await helmFixture(t),
      file = path.join(root, "templates/worker.yaml"),
      original = await readFile(file, "utf8");
    await writeFile(
      file,
      "{{ if .Values.replicas }}\n" + original + "{{ end }}\n",
    );
    const values = path.join(root, "values.yaml"),
      text = await readFile(values, "utf8");
    await writeFile(values, text.replace("replicas: 2", "replicas: 0"));
    const omitted = await run(root);
    assert.equal(omitted.outcome, "incomplete");
    assert.equal(omitted.checks[0]!.findingsComplete, false);
    await writeFile(values, text);
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(file, original.replace("-worker", "-settings"));
    const duplicate = await run(root);
    assert.equal(duplicate.outcome, "incomplete");
    assert.equal(duplicate.checks[0]!.findingsComplete, false);
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
  },
);
