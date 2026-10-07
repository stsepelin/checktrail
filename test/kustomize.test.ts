import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { createPlan, validate } from "../src/engine.js";
import {
  kustomizeEvidence,
  kustomizePacketSchema,
} from "../src/kustomize-evidence.js";
import { mavenHash } from "../src/maven.js";
import { kustomizeFixture, kustomizeNative } from "./kustomize-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Kustomize engine validates nested complete assembly with source-bound defects repair and overridden near misses",
  kustomizeNative,
  async (t) => {
    const root = await kustomizeFixture(t),
      plan = (await createPlan(root)).plan;
    assert.equal(plan.checks.length, 1);
    assert.equal(plan.checks[0]!.unavailableReason, undefined);
    assert.deepEqual(plan.checks[0]!.scope, [
      "base/kustomization.yaml",
      "overlay/kustomization.yaml",
      "base/deployment.yaml",
      "base/settings.yaml",
    ]);
    const good = await run(root);
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.deepEqual(good.checks[0]!.findings, []);
    assert.deepEqual(
      good.checks[0]!.tools!.map((t) => [t.name, t.status, t.version]),
      [
        ["node", "identified", process.versions.node],
        ["kustomize", "identified", "5.8.2"],
        ["kubeconform", "identified", "0.8.0"],
      ],
    );
    const file = path.join(root, "base/settings.yaml"),
      text = await readFile(file, "utf8");
    await writeFile(file, text.replace('original: "value"', "original: 2"));
    const broken = await run(root);
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findings!.length, 1);
    const finding = broken.checks[0]!.findings![0]!;
    assert.equal(finding.ruleId, "kustomize/schema");
    assert.equal(finding.file, "base/settings.yaml");
    assert.equal(finding.line, 6);
    assert.match(finding.message, /got number, want null or string/);
    await writeFile(file, text);
    assert.equal((await run(root)).outcome, "passed");
    const deployment = path.join(root, "base/deployment.yaml"),
      original = await readFile(deployment, "utf8"),
      overlay = path.join(root, "overlay/kustomization.yaml"),
      assembly = await readFile(overlay, "utf8");
    await writeFile(
      deployment,
      original.replace("replicas: 2", "replicas: original-invalid"),
    );
    assert.equal(
      (await run(root)).outcome,
      "passed",
      "The explicit overlay replaces the invalid source replica value before validation",
    );
    await writeFile(
      overlay,
      assembly.replace(
        "replicas:\n  - name: original-worker\n    count: 3\n",
        "",
      ),
    );
    const uncovered = await run(root);
    assert.equal(uncovered.outcome, "failed", JSON.stringify(uncovered.checks));
    assert.equal(
      uncovered.checks[0]!.findings![0]!.file,
      "base/deployment.yaml",
    );
    assert.equal(uncovered.checks[0]!.findings![0]!.line, 6);
    await writeFile(deployment, original);
    await writeFile(overlay, assembly.replace("count: 3", "count: 0"));
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native Kustomize evidence rejects changed assembly rendered sources schemas tools commands counters skips and malformed native verdicts",
  kustomizeNative,
  async (t) => {
    const root = await kustomizeFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await run(root);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const process = report.checks[0]!.processes[0]!,
      packet = kustomizePacketSchema.parse(JSON.parse(process.stdout));
    assert.equal(kustomizeEvidence(check, [process]).status, "passed");
    await assert.rejects(access(packet.temporary), { code: "ENOENT" });
    const mutation = (label: string, edit: (p: typeof packet) => void) => {
      const changed = structuredClone(packet);
      edit(changed);
      assert.equal(
        kustomizeEvidence(check, [
          { ...process, stdout: JSON.stringify(changed) },
        ]).status,
        "inconclusive",
        label,
      );
    };
    const output = (
      p: typeof packet,
      index: number,
      edit: (n: Record<string, unknown>) => void,
    ) => {
      const row = p.receipts[index]!,
        native = JSON.parse(row.stdout) as Record<string, unknown>;
      edit(native);
      row.stdout = JSON.stringify(native);
      row.stdoutSha256 = mavenHash(row.stdout);
    };
    mutation("input pin", (p) => (p.inputSha256 = "0".repeat(64)));
    for (const index of [0, 1])
      mutation(
        "tool freshness " + index,
        (p) => (p.tools[index]!.afterSha256 = "0".repeat(64)),
      );
    mutation(
      "schema closure",
      (p) => (p.schemas[0]!.afterSha256 = "0".repeat(64)),
    );
    mutation(
      "raw document freshness",
      (p) => (p.documents[0]!.afterSha256 = "0".repeat(64)),
    );
    mutation(
      "source origin",
      (p) => (p.documents[0]!.source = "base/original-foreign.yaml"),
    );
    mutation("document order", (p) => p.documents.reverse());
    mutation("build argv", (p) =>
      p.receipts[2]!.args.push("--enable-alpha-plugins"),
    );
    mutation("validator argv", (p) =>
      p.receipts[3]!.args.push("-skip", "Deployment"),
    );
    mutation("version", (p) => {
      p.receipts[0]!.stdout = "v5.8.3\n";
      p.receipts[0]!.stdoutSha256 = mavenHash(p.receipts[0]!.stdout);
    });
    mutation("rendered assembly", (p) => {
      p.receipts[2]!.stdout = p.receipts[2]!.stdout.replace(
        "replicas: 3",
        "replicas: 4",
      );
      p.receipts[2]!.stdoutSha256 = mavenHash(p.receipts[2]!.stdout);
      for (const [index, doc] of parseAllDocuments(
        p.receipts[2]!.stdout,
      ).entries()) {
        assert.ok(doc.range);
        const sha256 = mavenHash(
          p.receipts[2]!.stdout.slice(doc.range[0], doc.range[2]),
        );
        p.documents[index]!.sha256 = sha256;
        p.documents[index]!.afterSha256 = sha256;
      }
    });
    mutation("rendered empty", (p) => {
      p.receipts[2]!.stdout = "";
      p.receipts[2]!.stdoutSha256 = mavenHash("");
    });
    mutation("native total", (p) =>
      output(p, 3, (n) => (n.resources as unknown[]).pop()),
    );
    mutation("native name", (p) =>
      output(
        p,
        3,
        (n) =>
          ((n.resources as { name: string }[])[0]!.name = "original-foreign"),
      ),
    );
    mutation("native summary", (p) =>
      output(p, 3, (n) => (n.summary as { valid: number }).valid++),
    );
    for (const [status, key] of [
      ["statusSkipped", "skipped"],
      ["statusError", "errors"],
    ] as const)
      mutation(status, (p) =>
        output(p, 3, (n) => {
          (n.resources as { status: string }[])[0]!.status = status;
          const summary = n.summary as Record<string, number>;
          summary.valid!--;
          summary[key]!++;
        }),
      );
    mutation("native exit", (p) => (p.receipts[3]!.exitCode = 1));
    mutation("native stderr", (p) => {
      p.receipts[3]!.stderr = "original-error";
      p.receipts[3]!.stderrSha256 = mavenHash(p.receipts[3]!.stderr);
    });
    for (const edit of [
      { cancelled: true },
      { timedOut: true },
      { truncated: true },
      { errorCode: "EIO" },
      { signal: "SIGTERM" },
      { exitCode: 2 },
    ])
      assert.equal(
        kustomizeEvidence(check, [{ ...process, ...edit }]).status,
        "inconclusive",
      );
  },
);
test(
  "native Kustomize planning rejects undeclared nested inputs remote resources plugins duplicate keys and corrupted schemas without executable commands",
  kustomizeNative,
  async (t) => {
    for (const [file, edit] of [
      ["base/omitted.yaml", () => "kind: ConfigMap\n"],
      [
        "overlay/kustomization.yaml",
        (s: string) => s.replace("../base", "https://example.invalid/base"),
      ],
      [
        "overlay/kustomization.yaml",
        (s: string) => s + "generators:\n  - original.yaml\n",
      ],
      ["base/settings.yaml", (s: string) => s + '  original: "duplicate"\n'],
      ["tools/kubernetes/configmap-v1.json", () => "{}\n"],
    ] as const) {
      const root = await kustomizeFixture(t),
        target = path.join(root, file);
      let source = "";
      try {
        source = await readFile(target, "utf8");
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      }
      await writeFile(target, edit(source));
      const check = (await createPlan(root)).plan.checks[0]!;
      assert.ok(check.unavailableReason, file);
      assert.deepEqual(check.commands, [], file);
    }
  },
);
