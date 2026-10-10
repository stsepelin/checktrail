import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { terraformExtensionsEvidence } from "../src/terraform-extensions-evidence.js";
import { terraformExtensionsPacketSchema } from "../src/terraform-extensions-packet.js";
import {
  terraformExtensionsPolicyFile,
  terraformExtensionsProvider as provider,
} from "../src/terraform-extensions-contract.js";
import { mavenHash } from "../src/maven.js";
import {
  terraformExtensionsFixture,
  terraformExtensionsNative as native,
  terraformExtensionsWriteConfig,
} from "./terraform-extensions-fixture.js";
import type { ProcessResult } from "../src/types.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const brief = (r: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify(
    r.checks.map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      processes: c.processes.map((p) => ({
        exit: p.exitCode,
        stderr: p.stderr.slice(-200),
        timedOut: p.timedOut,
        truncated: p.truncated,
      })),
    })),
  );
const packet = (p: ProcessResult) =>
  terraformExtensionsPacketSchema.parse(JSON.parse(p.stdout));
const changed = (
  p: ProcessResult,
  edit: (v: ReturnType<typeof packet>) => void,
) => {
  const v = packet(p);
  edit(v);
  return { ...p, stdout: JSON.stringify(v) };
};
const receiptChange = (
  p: ReturnType<typeof packet>,
  index: number,
  edit: (v: Record<string, unknown>) => void,
) => {
  const r = p.receipts[index]!,
    v = JSON.parse(r.stdout) as Record<string, unknown>;
  edit(v);
  r.stdout = JSON.stringify(v);
  r.stdoutSha256 = mavenHash(r.stdout);
};

test("terraform-extensions broken acceptance", native, async (t) => {
  for (const kind of ["type", "required", "output", "local"]) {
    const { root, config } = await terraformExtensionsFixture(t);
    if (kind === "type")
      config.modules[2]!.resources.selected!.max = "original_not_numeric";
    if (kind === "required") delete config.modules[2]!.resources.selected!.min;
    if (kind === "output")
      config.modules[0]!.outputs.first = {
        reference: "module.first.original_missing",
      };
    if (kind === "local")
      config.modules[1]!.outputs.picked = {
        reference: "local.original_missing",
      };
    await terraformExtensionsWriteConfig(root, config);
    const r = await run(root),
      c = r.checks[0]!;
    assert.equal(r.outcome, "failed", kind + brief(r));
    assert.equal(c.findingsComplete, true);
    assert.equal(c.findings!.length, kind === "output" ? 1 : 2);
    assert.ok(
      c.findings!.every(
        (f) =>
          f.file ===
            (kind === "output"
              ? "main.tf"
              : kind === "local"
                ? "modules/child/main.tf.json"
                : "modules/leaf/main.tf") &&
          f.line! > 0 &&
          f.level === "error",
      ),
    );
    if (kind !== "output")
      assert.deepEqual(
        c.findings![0],
        c.findings![1],
        "Repeated physical modules retain both native diagnostics",
      );
  }
});
test("terraform-extensions fixed acceptance", native, async (t) => {
  const { root, config } = await terraformExtensionsFixture(t);
  config.modules[2]!.resources.selected!.max = "original_not_numeric";
  await terraformExtensionsWriteConfig(root, config);
  assert.equal((await run(root)).outcome, "failed");
  config.modules[2]!.resources.selected!.max = 5;
  await terraformExtensionsWriteConfig(root, config);
  const r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  assert.equal(r.sourceChanged, false);
  assert.deepEqual(r.checks[0]!.findings, []);
  assert.equal(r.checks[0]!.findingsComplete, true);
  const p = packet(r.checks[0]!.processes[0]!);
  assert.equal(JSON.parse(p.modules.text).Modules.length, 5);
  assert.deepEqual(
    p.receipts.map((r) => r.phase),
    ["version", "init", "selected-version", "provider-schema", "validate"],
  );
  assert.equal(p.receipts[3]!.stdoutSha256, provider.schemaSha256);
  assert.equal(p.artifacts.length, 4);
  assert.equal(p.providerMembers.length, 2);
  await assert.rejects(access(p.temporary), { code: "ENOENT" });
});
test("terraform-extensions near-miss acceptance", native, async (t) => {
  const { root, config } = await terraformExtensionsFixture(t);
  config.modules[2]!.resources.selected!.max = "5";
  config.modules[2]!.locals.original_unused = 7;
  config.modules[0]!.calls[0]!.arguments.floor = {
    reference: "var.floor",
    offset: 1,
  };
  // A direct second leaf plus the transitive first leaf has four native module instances.
  config.modules[0]!.calls[1]!.target = "leaf";
  await terraformExtensionsWriteConfig(root, config);
  const r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  assert.deepEqual(r.checks[0]!.findings, []);
  assert.equal(
    JSON.parse(packet(r.checks[0]!.processes[0]!).modules.text).Modules.length,
    4,
  );
  config.modules[2]!.resources.selected!.max = 1;
  await terraformExtensionsWriteConfig(root, config);
  assert.equal(
    (await run(root)).outcome,
    "passed",
    "Native validate does not establish min/max runtime semantics",
  );
});
test("terraform-extensions prerequisite acceptance", native, async (t) => {
  const { root } = await terraformExtensionsFixture(t),
    file = path.join(root, "main.tf"),
    original = await readFile(file, "utf8");
  await writeFile(
    file,
    original +
      'module "original_remote" { source = "https://example.invalid/module.zip" }\n',
  );
  const planned = await createPlan(root);
  assert.ok(planned.plan.checks[0]!.unavailableReason);
  assert.deepEqual(planned.plan.checks[0]!.commands, []);
  assert.equal((await run(root)).checks[0]!.status, "unavailable");
  await writeFile(file, original);
  const previous = process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT!,
    temporary = await mkdtemp(
      path.join(tmpdir(), "original-provider-prerequisite-"),
    );
  try {
    for (const kind of ["missing", "changed"]) {
      const cache = path.join(temporary, kind);
      await cp(previous, cache, { recursive: true });
      if (kind === "missing") await rm(path.join(cache, provider.archive));
      else
        await writeFile(
          path.join(cache, provider.members[1]!.path),
          "original unavailable binary",
        );
      process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT = cache;
      const r = await run(root);
      assert.equal(r.outcome, "incomplete", kind + brief(r));
      assert.equal(r.checks[0]!.status, "unavailable");
      assert.equal(r.checks[0]!.processes[0]!.exitCode, 3);
      assert.equal(
        r.checks[0]!.tools!.find((t) => t.name === "terraform")!.status,
        "unavailable",
      );
    }
  } finally {
    process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT = previous;
    await rm(temporary, { recursive: true, force: true });
  }
  assert.equal((await run(root)).outcome, "passed");
});
test("terraform-extensions stale acceptance", native, async (t) => {
  const { root } = await terraformExtensionsFixture(t),
    r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  const { plan, source } = await createPlan(root),
    check = plan.checks[0]!,
    p = r.checks[0]!.processes[0]!;
  assert.equal(
    terraformExtensionsEvidence(check, [p], source.root).status,
    "passed",
  );
  for (const relative of [
    "main.tf",
    "modules/child/main.tf.json",
    "modules/leaf/main.tf",
    ".terraform.lock.hcl",
    terraformExtensionsPolicyFile,
  ]) {
    const file = path.join(root, relative),
      before = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([before, Buffer.from("\n")]));
      assert.equal(
        terraformExtensionsEvidence(check, [p], source.root).status,
        "inconclusive",
        relative,
      );
    } finally {
      await writeFile(file, before);
    }
  }
  assert.equal(
    terraformExtensionsEvidence(check, [p], source.root).status,
    "passed",
  );
  await writeFile(
    path.join(root, "OriginalAdjacent.bin"),
    Buffer.from([0, 255]),
  );
  assert.equal(
    terraformExtensionsEvidence(check, [p], source.root).status,
    "inconclusive",
  );
});
test("terraform-extensions empty acceptance", native, async (t) => {
  const { root } = await terraformExtensionsFixture(t),
    r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  const { plan, source } = await createPlan(root),
    check = plan.checks[0]!,
    p = r.checks[0]!.processes[0]!;
  const edits: ((v: ReturnType<typeof packet>) => void)[] = [
    (v) => {
      v.nativeTemporary.before = v.nativeTemporary.after = v.workspace;
    },
    (v) => {
      v.nativeTemporary.after = v.workspace;
    },
    (v) => {
      v.inputSha256 = "0".repeat(64);
    },
    (v) => {
      v.sourceInputs[0]!.sha256 = v.sourceInputs[0]!.afterSha256 = "0".repeat(
        64,
      );
    },
    (v) => {
      v.nativeFiles[0] = "original-adjacent.tf";
    },
    (v) => {
      v.dataFiles[0] = "original-adjacent.json";
    },
    (v) => {
      v.receipts[3]!.args = ["providers", "original-adjacent", "-json"];
    },
    (v) => {
      v.receipts.pop();
    },
    (v) => {
      v.receipts.reverse();
    },
    (v) => {
      v.sourceInputs.pop();
    },
    (v) => {
      v.nativeFiles.pop();
    },
    (v) => {
      v.dataFiles.pop();
    },
    (v) => {
      v.artifacts.pop();
    },
    (v) => {
      v.providerMembers.pop();
    },
    (v) => {
      v.tool.sha256 = "0".repeat(64);
    },
    (v) => {
      v.tool.afterSha256 = "0".repeat(64);
    },
    (v) => {
      v.artifacts[1]!.afterSha256 = "0".repeat(64);
    },
    (v) => {
      v.providerMembers[1]!.afterSha256 = "0".repeat(64);
    },
    (v) => {
      v.copiedArchive.afterSha256 = "0".repeat(64);
    },
    (v) => {
      v.cliConfig.text += "\nprovider_installation { direct {} }\n";
      v.cliConfig.sha256 = v.cliConfig.afterSha256 = mavenHash(
        v.cliConfig.text,
      );
    },
    (v) => {
      v.lock.sha256 = v.lock.afterSha256 = "0".repeat(64);
    },
    (v) => {
      v.modules.afterSha256 = "0".repeat(64);
    },
    (v) => {
      const m = JSON.parse(v.modules.text);
      m.Modules.pop();
      v.modules.text = JSON.stringify(m);
      v.modules.sha256 = v.modules.afterSha256 = mavenHash(v.modules.text);
    },
    (v) => {
      const m = JSON.parse(v.modules.text);
      m.Modules[1].Dir = "modules/original_adjacent";
      v.modules.text = JSON.stringify(m);
      v.modules.sha256 = v.modules.afterSha256 = mavenHash(v.modules.text);
    },
    (v) => {
      v.receipts[3]!.stdout = v.receipts[3]!.stdout.replace(
        '"random_integer"',
        '"original_omitted_resource"',
      );
      v.receipts[3]!.stdoutSha256 = mavenHash(v.receipts[3]!.stdout);
    },
    (v) => {
      receiptChange(v, 4, (r) => {
        r.error_count = 1;
      });
    },
    (v) => {
      receiptChange(v, 4, (r) => {
        r.valid = false;
      });
    },
    (v) => {
      v.receipts[4]!.exitCode = 1;
    },
    (v) => {
      const r = v.receipts[1]!,
        a = r.stdout.trim().split("\n");
      a.splice(2, 1);
      r.stdout = a.join("\n") + "\n";
      r.stdoutSha256 = mavenHash(r.stdout);
    },
    (v) => {
      const r = v.receipts[1]!,
        a = r.stdout
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
      a[0].message_code = "output_init_success_message";
      r.stdout = a.map((s) => JSON.stringify(s)).join("\n") + "\n";
      r.stdoutSha256 = mavenHash(r.stdout);
    },
    (v) => {
      const r = v.receipts[1]!,
        a = r.stdout
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
      a[1]["@message"] = "original incorrect stage";
      r.stdout = a.map((s) => JSON.stringify(s)).join("\n") + "\n";
      r.stdoutSha256 = mavenHash(r.stdout);
    },
  ];
  for (const [i, edit] of edits.entries())
    assert.equal(
      terraformExtensionsEvidence(check, [changed(p, edit)], source.root)
        .status,
      "inconclusive",
      String(i),
    );
  for (const edit of [
    { stdout: "{}" },
    { stderr: "original unexpected error" },
    { exitCode: null },
    { cancelled: true },
    { timedOut: true },
    { truncated: true },
    { signal: "SIGKILL" },
  ])
    assert.equal(
      terraformExtensionsEvidence(check, [{ ...p, ...edit }], source.root)
        .status,
      "inconclusive",
    );
  assert.equal(
    terraformExtensionsEvidence(check, [p], undefined).status,
    "inconclusive",
  );
  assert.equal(
    terraformExtensionsEvidence(
      check,
      [{ ...p, command: { ...p.command, cwd: "original_other" } }],
      source.root,
    ).status,
    "inconclusive",
  );
  assert.equal(
    terraformExtensionsEvidence(check, [p], source.root).status,
    "passed",
  );
});
test("terraform-extensions diagnostic acceptance", native, async (t) => {
  const { root, config } = await terraformExtensionsFixture(t);
  config.modules[2]!.resources.selected!.max = "original_bad_é_👩‍💻";
  await terraformExtensionsWriteConfig(root, config);
  const r = await run(root);
  assert.equal(r.outcome, "failed", brief(r));
  const { plan, source } = await createPlan(root),
    check = plan.checks[0]!,
    p = r.checks[0]!.processes[0]!;
  const changes: ((v: Record<string, unknown>) => void)[] = [
    (v) => {
      v.error_count = 1;
    },
    (v) => {
      v.valid = true;
    },
    (v) => {
      (v.diagnostics as unknown[]).pop();
    },
    (v) => {
      (v.diagnostics as { range: { filename: string } }[])[0]!.range.filename =
        "main.tf";
    },
    (v) => {
      (v.diagnostics as { range: { start: { byte: number } } }[])[0]!.range
        .start.byte++;
    },
    (v) => {
      (v.diagnostics as { range: { end: { column: number } } }[])[0]!.range.end
        .column++;
    },
    (v) => {
      (v.diagnostics as { snippet: { code: string } }[])[0]!.snippet.code = (
        v.diagnostics as { snippet: { code: string } }[]
      )[0]!.snippet.code.replace("original_bad", "original_xxx");
    },
    (v) => {
      (v.diagnostics as { snippet: { highlight_start_offset: number } }[])[0]!
        .snippet.highlight_start_offset++;
    },
    (v) => {
      (v.diagnostics as { snippet: { highlight_end_offset: number } }[])[0]!
        .snippet.highlight_end_offset--;
    },
  ];
  for (const [i, edit] of changes.entries())
    assert.equal(
      terraformExtensionsEvidence(
        check,
        [changed(p, (v) => receiptChange(v, 4, edit))],
        source.root,
      ).status,
      "inconclusive",
      String(i),
    );
  assert.equal(
    terraformExtensionsEvidence(check, [p], source.root).status,
    "failed",
  );
  assert.equal(r.checks[0]!.findings!.length, 2);
});
test(
  "terraform-extensions installed acceptance",
  { ...native, timeout: 300000 },
  async () => {
    if (process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_INSTALLED === "1") {
      assert.match(
        await realpath(
          fileURLToPath(new URL("../src/engine.js", import.meta.url)),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "terraform-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 285000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.status, 0, result.stderr.slice(-3000));
    const receipt = JSON.parse(result.stdout),
      requirements = JSON.parse(
        await readFile(
          fileURLToPath(
            new URL(
              "../../scripts/required-native-tests.json",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
    assert.equal(
      receipt.profile.required,
      requirements["terraform-extensions"].length,
    );
    assert.equal(receipt.profile.passed, receipt.profile.required);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_INSTALL_RECEIPT,
        JSON.stringify(receipt) + "\n",
      );
  },
);
