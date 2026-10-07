import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import {
  kubeDocuments,
  kubePointerLine,
  kubeconformInvocationSchema,
} from "../src/kubeconform.js";
import { kubeconformEvidence } from "../src/kubeconform-evidence.js";
import { validate, createPlan } from "../src/engine.js";
import { mavenHash } from "../src/maven.js";
import {
  kubeFixture,
  kubeNative,
  kubeInvocation,
  originalDeployment,
  originalConfigMap,
} from "./kubeconform-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test("Kubernetes document binding accounts for every raw document and rejects empty aliases duplicate keys foreign kinds and stale text", () => {
  const invocation = kubeconformInvocationSchema.parse(kubeInvocation());
  const docs = kubeDocuments(invocation.inputs, invocation.config);
  assert.equal(docs.length, 2);
  assert.equal(docs[0]!.sha256, mavenHash(docs[0]!.text));
  assert.equal(docs[1]!.kind, "ConfigMap");
  assert.equal(kubePointerLine(docs[0]!, "/spec/replicas"), 6);
  assert.equal(
    kubePointerLine(docs[1]!, "/data/original"),
    (originalDeployment + "---\n" + originalConfigMap)
      .split("\n")
      .indexOf('  original: "value"') + 1,
  );
  for (const text of [
    "# empty original\n",
    originalConfigMap.replace(
      'original: "value"',
      'original: "value"\n  original: "other"',
    ),
    originalConfigMap.replace("kind: ConfigMap", "kind: OriginalUnknown"),
    originalConfigMap.replace(
      'original: "value"',
      "original: &original value\n  other: *original",
    ),
  ]) {
    const changed = kubeconformInvocationSchema.parse(kubeInvocation(text));
    assert.throws(() => kubeDocuments(changed.inputs, changed.config));
  }
  invocation.inputs[1]!.text += "\n";
  assert.throws(() => kubeDocuments(invocation.inputs, invocation.config));
});
test("Kubernetes physical source pointers preserve UTF8 and decode JSON pointer escapes once", () => {
  const input = kubeconformInvocationSchema.parse(
    kubeInvocation(
      originalConfigMap.replace(
        'original: "value"',
        'original: "é"\n  "original/key~name": "yes"',
      ),
    ),
  );
  const doc = kubeDocuments(input.inputs, input.config)[0]!;
  assert.equal(kubePointerLine(doc, "/data/original~1key~0name"), 7);
  assert.throws(() => kubePointerLine(doc, "/data/original~2key"));
  assert.throws(() => kubePointerLine(doc, "/data/absent"));
});
test(
  "native kubeconform validates all documents with source-bound defects repair and valid zero-replica near misses",
  kubeNative,
  async (t) => {
    const root = await kubeFixture(t),
      plan = (await createPlan(root)).plan;
    assert.equal(plan.checks.length, 1);
    assert.equal(plan.checks[0]!.unavailableReason, undefined);
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.findings, []);
    const file = path.join(root, "manifests/original.yaml"),
      original = await readFile(file, "utf8");
    await writeFile(
      file,
      original.replace("replicas: 2", "replicas: original-invalid"),
    );
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.equal(failed.checks[0]!.status, "failed");
    assert.equal(failed.checks[0]!.findings?.length, 1);
    assert.equal(
      failed.checks[0]!.findings![0]!.file,
      "manifests/original.yaml",
    );
    assert.equal(failed.checks[0]!.findings![0]!.line, 6);
    assert.match(
      failed.checks[0]!.findings![0]!.message,
      /got string, want null or integer/,
    );
    await writeFile(file, original.replace("replicas: 2", "replicas: 0"));
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(file, original.replace('original: "value"', "original: 2"));
    const second = await run(root);
    assert.equal(second.outcome, "failed", JSON.stringify(second.checks));
    assert.equal(second.checks[0]!.findings?.length, 1);
    assert.equal(
      second.checks[0]!.findings![0]!.line,
      original.split("\n").indexOf('  original: "value"') + 1,
    );
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native kubeconform evidence rejects changed source documents schemas tools commands skips errors and inconsistent resource counters",
  kubeNative,
  async (t) => {
    const root = await kubeFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      result = await run(root);
    assert.equal(result.outcome, "passed", JSON.stringify(result.checks));
    const process = result.checks[0]!.processes[0]!,
      packet = JSON.parse(process.stdout);
    assert.equal(kubeconformEvidence(check, [process]).status, "passed");
    await assert.rejects(access(packet.temporary), { code: "ENOENT" });
    const mutation = (label: string, edit: (p: typeof packet) => void) => {
      const changed = structuredClone(packet);
      edit(changed);
      assert.equal(
        kubeconformEvidence(check, [
          { ...process, stdout: JSON.stringify(changed) },
        ]).status,
        "inconclusive",
        label,
      );
    };
    const output = (
      p: typeof packet,
      edit: (native: Record<string, unknown>) => void,
    ) => {
      const row = p.receipts[1];
      const native = JSON.parse(row.stdout);
      edit(native);
      row.stdout = JSON.stringify(native);
      row.stdoutSha256 = mavenHash(row.stdout);
    };
    mutation("input identity", (p) => (p.inputSha256 = "0".repeat(64)));
    mutation("tool freshness", (p) => (p.tool.afterSha256 = "0".repeat(64)));
    mutation(
      "schema closure",
      (p) => (p.schemas[0].afterSha256 = "0".repeat(64)),
    );
    mutation(
      "copied document bytes",
      (p) => (p.documents[0].afterSha256 = "0".repeat(64)),
    );
    mutation("native command", (p) =>
      p.receipts[1].args.push("-skip", "Deployment"),
    );
    mutation("resource total", (p) =>
      output(p, (n) => {
        (n.resources as unknown[]).pop();
      }),
    );
    mutation("resource identity", (p) =>
      output(p, (n) => {
        (n.resources as { name: string }[])[0]!.name = "original-other";
      }),
    );
    mutation("native summary", (p) =>
      output(p, (n) => {
        (n.summary as { valid: number }).valid++;
      }),
    );
    for (const [status, key] of [
      ["statusSkipped", "skipped"],
      ["statusError", "errors"],
    ])
      mutation(status!, (p) =>
        output(p, (n) => {
          (n.resources as { status: string }[])[0]!.status = status!;
          const summary = n.summary as Record<string, number>;
          summary.valid!--;
          summary[key!]!++;
        }),
      );
    mutation("native exit", (p) => (p.receipts[1].exitCode = 1));
    mutation("native stderr", (p) => {
      p.receipts[1].stderr = "original-error";
      p.receipts[1].stderrSha256 = mavenHash(p.receipts[1].stderr);
    });
  },
);
test(
  "native kubeconform planning rejects empty duplicate-key omitted and corrupted-schema inputs with no executable command",
  kubeNative,
  async (t) => {
    for (const text of [
      "# original empty\n",
      originalConfigMap.replace(
        'original: "value"',
        'original: "value"\n  original: "other"',
      ),
    ]) {
      const root = await kubeFixture(t, text);
      const plan = (await createPlan(root)).plan;
      assert.ok(plan.checks[0]!.unavailableReason);
      assert.deepEqual(plan.checks[0]!.commands, []);
    }
    const root = await kubeFixture(t);
    await writeFile(
      path.join(root, "manifests/omitted.yaml"),
      originalConfigMap,
    );
    let plan = (await createPlan(root)).plan;
    assert.ok(plan.checks[0]!.unavailableReason);
    assert.deepEqual(plan.checks[0]!.commands, []);
    const other = await kubeFixture(t);
    await writeFile(
      path.join(other, "tools/kubernetes/configmap-v1.json"),
      "{}\n",
    );
    plan = (await createPlan(other)).plan;
    assert.ok(plan.checks[0]!.unavailableReason);
    assert.deepEqual(plan.checks[0]!.commands, []);
  },
);
