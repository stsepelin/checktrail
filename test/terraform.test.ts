import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import {
  terraformModules,
  terraformInvocationSchema,
} from "../src/terraform.js";
import { terraformEvidence } from "../src/terraform-evidence.js";
import { mavenHash } from "../src/maven.js";
import {
  terraformFixture,
  terraformNative,
  terraformInvocation,
  terraformRewrite,
} from "./terraform-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test("Terraform planning reads all JSON module files without executing native tools and rejects empty provider module function duplicate and omitted scope", async (t) => {
  const root = await terraformFixture(t);
  const plan = (await createPlan(root)).plan;
  assert.equal(plan.checks.length, 1);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  assert.deepEqual(plan.checks[0]!.scope, ["main.tf.json", "support.tf.json"]);
  const invocation = terraformInvocationSchema.parse(
    await terraformInvocation(root),
  );
  assert.deepEqual(
    terraformModules(invocation).map((m) => m.declarations),
    [
      { variables: 1, locals: 0, outputs: 1 },
      { variables: 0, locals: 2, outputs: 0 },
    ],
  );
  const changed = (edit: (p: typeof invocation) => void) => {
    const p = structuredClone(invocation);
    edit(p);
    for (const input of p.inputs) input.sha256 = mavenHash(input.text);
    assert.throws(() => terraformModules(p));
  };
  changed((p) => (p.inputs[2]!.text = "{}"));
  changed((p) => (p.inputs[2]!.text = '{"locals":{"x":1,"x":2}}'));
  changed((p) => (p.inputs[2]!.text = '{"provider":{"original":{}}}'));
  changed(
    (p) =>
      (p.inputs[2]!.text =
        '{"module":{"original":{"source":"https://example.invalid/original"}}}'),
  );
  changed(
    (p) =>
      (p.inputs[2]!.text = JSON.stringify({
        locals: { x: '${file("original")}' },
      })),
  );
  changed((p) => p.inputs.pop());
  await writeFile(
    path.join(root, "omitted.tf.json"),
    '{"locals":{"original":1}}',
  );
  const unsupported = (await createPlan(root)).plan.checks[0]!;
  assert.ok(unsupported.unavailableReason);
  assert.deepEqual(unsupported.commands, []);
});
test(
  "native Terraform validates complete multi-file modules with reference and typed-default defects repair conversion and unused-local controls",
  terraformNative,
  async (t) => {
    const root = await terraformFixture(t);
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.findings, []);
    assert.equal(
      passed.checks[0]!.tools?.find((t) => t.name === "terraform")?.version,
      "1.16.5",
    );
    const main = path.join(root, "main.tf.json"),
      support = path.join(root, "support.tf.json"),
      original = await readFile(main, "utf8"),
      other = await readFile(support, "utf8");
    await terraformRewrite(
      root,
      "main.tf.json",
      (p) =>
        ((
          p.output as { original_next: { value: string } }
        ).original_next.value = "${local.original_missing}"),
    );
    const broken = await run(root);
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findings?.length, 1);
    assert.equal(broken.checks[0]!.findings![0]!.file, "main.tf.json");
    assert.match(broken.checks[0]!.findings![0]!.message, /undeclared local/);
    const text = await readFile(main, "utf8");
    assert.equal(
      broken.checks[0]!.findings![0]!.line,
      text
        .split("\n")
        .findIndex((l) => l.includes("${local.original_missing}")) + 1,
    );
    await writeFile(main, original);
    assert.equal((await run(root)).outcome, "passed");
    await terraformRewrite(
      root,
      "main.tf.json",
      (p) =>
        ((
          p.variable as { original_count: { default: unknown } }
        ).original_count.default = "original-invalid"),
    );
    const typed = await run(root);
    assert.equal(typed.outcome, "failed", JSON.stringify(typed.checks));
    assert.match(
      typed.checks[0]!.findings![0]!.message,
      /Invalid default value/,
    );
    for (const value of [0, "2"]) {
      await terraformRewrite(
        root,
        "main.tf.json",
        (p) =>
          ((
            p.variable as { original_count: { default: unknown } }
          ).original_count.default = value),
      );
      assert.equal((await run(root)).outcome, "passed");
    }
    await writeFile(main, original);
    await terraformRewrite(
      root,
      "support.tf.json",
      (p) =>
        ((p.locals as Record<string, string>).original_unused =
          "${local.original_missing}"),
    );
    const unused = await run(root);
    assert.equal(unused.outcome, "failed", JSON.stringify(unused.checks));
    assert.equal(unused.checks[0]!.findings![0]!.file, "support.tf.json");
    await writeFile(support, other);
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native Terraform evidence rejects forged module hashes declarations tools commands provider configuration counters source ranges and snippets",
  terraformNative,
  async (t) => {
    const root = await terraformFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await run(root);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const process = report.checks[0]!.processes[0]!,
      packet = JSON.parse(process.stdout);
    assert.equal(terraformEvidence(check, [process]).status, "passed");
    await assert.rejects(access(packet.temporary), { code: "ENOENT" });
    const mutation = (label: string, edit: (p: typeof packet) => void) => {
      const p = structuredClone(packet);
      edit(p);
      assert.equal(
        terraformEvidence(check, [{ ...process, stdout: JSON.stringify(p) }])
          .status,
        "inconclusive",
        label,
      );
    };
    const output = (
      p: typeof packet,
      index: number,
      edit: (n: Record<string, unknown>) => void,
    ) => {
      const row = p.receipts[index],
        n = JSON.parse(row.stdout);
      edit(n);
      row.stdout = JSON.stringify(n);
      row.stdoutSha256 = mavenHash(row.stdout);
    };
    mutation("input identity", (p) => (p.inputSha256 = "0".repeat(64)));
    mutation("tool freshness", (p) => (p.tool.afterSha256 = "0".repeat(64)));
    mutation(
      "module freshness",
      (p) => (p.modules[0].afterSha256 = "0".repeat(64)),
    );
    mutation("module closure", (p) => p.modules.pop());
    mutation("declaration count", (p) => p.modules[0].declarations.outputs++);
    mutation(
      "CLI config freshness",
      (p) => (p.cliConfig.afterSha256 = "0".repeat(64)),
    );
    mutation("native command", (p) =>
      p.receipts[1].args.push("-var", "original_count=0"),
    );
    mutation("native version", (p) =>
      output(p, 0, (n) => (n.terraform_version = "1.16.4")),
    );
    mutation("provider profile", (p) =>
      output(
        p,
        0,
        (n) =>
          (n.provider_selections = { "example.invalid/original": "1.0.0" }),
      ),
    );
    mutation("native counters", (p) =>
      output(p, 1, (n) => (n.error_count = 1)),
    );
    mutation("native warning counters", (p) =>
      output(p, 1, (n) => (n.warning_count = 1)),
    );
    mutation("native validity", (p) => output(p, 1, (n) => (n.valid = false)));
    mutation("native exit", (p) => (p.receipts[1].exitCode = 1));
    mutation("native stderr", (p) => {
      p.receipts[1].stderr = "original warning";
      p.receipts[1].stderrSha256 = mavenHash(p.receipts[1].stderr);
    });
    await terraformRewrite(
      root,
      "main.tf.json",
      (p) =>
        ((
          p.output as { original_next: { value: string } }
        ).original_next.value = "${local.original_missing}"),
    );
    const brokenCheck = (await createPlan(root)).plan.checks[0]!,
      broken = await run(root);
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    const failed = broken.checks[0]!.processes[0]!,
      failure = JSON.parse(failed.stdout);
    const diagnostic = (
      label: string,
      edit: (d: Record<string, unknown>) => void,
    ) => {
      const p = structuredClone(failure);
      output(p, 1, (n) =>
        edit((n.diagnostics as Record<string, unknown>[])[0]!),
      );
      assert.equal(
        terraformEvidence(brokenCheck, [
          { ...failed, stdout: JSON.stringify(p) },
        ]).status,
        "inconclusive",
        label,
      );
    };
    diagnostic(
      "physical line",
      (d) => (d.range as { start: { line: number } }).start.line++,
    );
    diagnostic(
      "physical byte",
      (d) => (d.range as { start: { byte: number } }).start.byte++,
    );
    diagnostic(
      "foreign source",
      (d) => ((d.range as { filename: string }).filename = "other.tf.json"),
    );
    diagnostic(
      "source snippet",
      (d) => ((d.snippet as { code: string }).code = "original forged source"),
    );
    diagnostic(
      "source highlight",
      (d) =>
        (d.snippet as { highlight_start_offset: number })
          .highlight_start_offset++,
    );
  },
);

test(
  "native Terraform binds UTF-8 byte highlights and grapheme columns in single-line diagnostics with repair",
  terraformNative,
  async (t) => {
    const root = await terraformFixture(t),
      main = path.join(root, "main.tf.json"),
      original = JSON.parse(await readFile(main, "utf8"));
    for (const unicode of ["é🙂", "é👨‍👩‍👧"]) {
      const module = {
        terraform: original.terraform,
        variable: original.variable,
        locals: { original_unicode: unicode },
        output: { original_next: { value: "${local.original_missing}" } },
      };
      await writeFile(main, JSON.stringify(module) + "\n");
      const report = await run(root);
      assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
      assert.equal(report.checks[0]!.findings?.length, 1);
      assert.equal(report.checks[0]!.findings![0]!.line, 1);
      assert.equal(report.checks[0]!.findings![0]!.file, "main.tf.json");
      const packet = JSON.parse(report.checks[0]!.processes[0]!.stdout),
        native = JSON.parse(packet.receipts[1].stdout),
        diagnostic = native.diagnostics[0];
      assert.ok(
        diagnostic.range.start.byte > diagnostic.range.start.column - 1,
        "Multibyte source preceded the native diagnostic",
      );
      assert.equal(
        diagnostic.snippet.highlight_start_offset,
        diagnostic.range.start.byte,
        "The one-line native highlight uses bytes",
      );
      assert.notEqual(
        diagnostic.snippet.code.indexOf('"${local.original_missing}"'),
        diagnostic.snippet.highlight_start_offset,
        "Native highlight differs from the JavaScript string offset",
      );
      module.output.original_next.value = "${local.original_next}";
      await writeFile(main, JSON.stringify(module) + "\n");
      assert.equal((await run(root)).outcome, "passed");
    }
  },
);
