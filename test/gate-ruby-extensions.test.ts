import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { runProcess } from "../src/runner.js";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { projectReport } from "../src/output.js";
import { createPlan, validate } from "../src/engine.js";
import {
  rubyToolsEvidence,
  rubyToolsPacketSchema,
} from "../src/ruby-tools-evidence.js";
import { mavenHash } from "../src/maven.js";
import type { ProcessResult } from "../src/types.js";
import { rubyExtensionsRuntimeWitnessSchema } from "../src/ruby-extensions-contract.js";
import {
  breakRubyQuantity,
  rubyExtensionsFixture,
} from "./ruby-extensions-fixture.js";
const available =
  !!process.env.CHECKTRAIL_RUBY_TOOLS_CACHE &&
  /^ruby 4\.0\.7 /.test(
    spawnSync("ruby", ["--disable-gems", "--version"], { encoding: "utf8" })
      .stdout || "",
  );
const native = {
  skip: available
    ? false
    : "Pinned Ruby extension runtime and cache not selected",
  timeout: 1200000,
};
const brief = (report: Pick<Awaited<ReturnType<typeof validate>>, "checks">) =>
  JSON.stringify(
    report.checks.map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      processes: c.processes.map((p) => ({
        exit: p.exitCode,
        stderr: p.stderr.slice(-1200),
        cancelled: p.cancelled,
        timedOut: p.timedOut,
        truncated: p.truncated,
      })),
    })),
  );
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
function witnesses(
  report: Pick<Awaited<ReturnType<typeof run>>, "checks">,
  id: string,
) {
  const check = report.checks.find((c) => c.id === id)!;
  const packet = rubyToolsPacketSchema.parse(
    JSON.parse(check.processes[0]!.stdout),
  );
  const metadata = JSON.parse(packet.metadata) as { extensions: unknown };
  return rubyExtensionsRuntimeWitnessSchema.parse(metadata.extensions);
}
test("ruby-extensions broken acceptance", native, async (t) => {
  // Each native restore/check gets the engine's unchanged aggregate run budget.
  const reports = [];
  for (const id of [
    "ruby.rubocop-extensions",
    "ruby.rspec-extensions",
    "ruby.minitest-extensions",
  ]) {
    const { root } = await rubyExtensionsFixture(t, [id]);
    await breakRubyQuantity(root);
    reports.push(await run(root));
  }
  assert.deepEqual(
    reports.map((r) => r.outcome),
    ["passed", "failed", "failed"],
    JSON.stringify(reports.map(brief)),
  );
  const report = { checks: reports.flatMap((r) => r.checks) };
  assert.equal(
    report.checks.find((c) => c.id === "ruby.rubocop-extensions")?.status,
    "passed",
  );
  for (const [id, total] of [
    ["ruby.rspec-extensions", 4],
    ["ruby.minitest-extensions", 3],
  ] as const) {
    const check = report.checks.find((c) => c.id === id)!;
    assert.equal(check.status, "failed", brief({ checks: [check] }));
    assert.deepEqual(check.tests, {
      total,
      passed: 0,
      failed: total,
      skipped: 0,
    });
  }
  const shared = report.checks.find((c) => c.id === "ruby.rspec-extensions")!;
  assert.equal(shared.findings?.length, 4);
  assert.ok(
    witnesses(report, "ruby.rspec-extensions").cases.every(
      (c) =>
        c.shared.length === 1 && c.shared[0]!.inclusion.file === c.receiverFile,
    ),
  );
  assert.equal(
    witnesses(report, "ruby.minitest-extensions").cases.filter(
      (c) =>
        c.declaring === "OriginalInheritedQuantityBase" &&
        c.receiver === "OriginalQuantityTest",
    ).length,
    2,
  );
  assert.ok(
    shared.findings?.every((f) => f.file === "spec/shared_quantity.rb"),
  );
  const inherited = report.checks.find(
    (c) => c.id === "ruby.minitest-extensions",
  )!;
  assert.equal(
    inherited.findings?.filter((f) => f.file === "test/inherited_base.rb")
      .length,
    2,
  );
});
test("ruby-extensions fixed acceptance", native, async (t) => {
  const reports = [];
  for (const id of ["ruby.rspec-extensions", "ruby.minitest-extensions"]) {
    const { root } = await rubyExtensionsFixture(t, [id]);
    const { file, original } = await breakRubyQuantity(root);
    try {
      assert.equal((await run(root)).outcome, "failed");
    } finally {
      await writeFile(file, original);
    }
    const report = await run(root);
    assert.equal(report.outcome, "passed", brief(report));
    reports.push(report);
  }
  assert.deepEqual(
    reports.flatMap((r) => r.checks).map((c) => c.tests),
    [
      { total: 4, passed: 4, failed: 0, skipped: 0 },
      { total: 3, passed: 3, failed: 0, skipped: 0 },
    ],
  );
});
test("ruby-extensions near-miss acceptance", native, async (t) => {
  const { root } = await rubyExtensionsFixture(t, ["ruby.rspec-extensions"]);
  const report = await run(root);
  assert.equal(report.outcome, "passed", brief(report));
  const shared = witnesses(report, "ruby.rspec-extensions");
  assert.equal(shared.manifest.manifests.length, 2);
  assert.equal(shared.manifest.dependencies.length, 5);
  assert.equal(shared.cases.length, 4);
  assert.ok(
    shared.cases.every(
      (c) =>
        c.source.file === "spec/shared_quantity.rb" &&
        c.receiverFile !== c.source.file &&
        c.shared.length === 1,
    ),
  );
  assert.equal(shared.registeredHooks.length, 10);
  assert.ok(
    shared.hooks.some((h) => h.kind === "around") &&
      shared.hooks.some((h) => h.caseId.startsWith("group:")),
  );
  assert.ok(shared.hooks.every((h) => h.entered && h.returned));
  const { root: minitestRoot } = await rubyExtensionsFixture(t, [
    "ruby.minitest-extensions",
  ]);
  const minitestReport = await run(minitestRoot);
  assert.equal(minitestReport.outcome, "passed", brief(minitestReport));
  const { root: lintRoot } = await rubyExtensionsFixture(t, [
    "ruby.rubocop-extensions",
  ]);
  const lintReport = await run(lintRoot);
  assert.equal(lintReport.outcome, "passed", brief(lintReport));
  assert.equal(lintReport.checks[0]!.status, "passed");
  const inherited = witnesses(minitestReport, "ruby.minitest-extensions");
  assert.equal(inherited.cases.length, 3);
  assert.equal(
    inherited.cases.filter(
      (c) =>
        c.declaring === "OriginalInheritedQuantityBase" &&
        c.receiver === "OriginalQuantityTest" &&
        c.source.file === "test/inherited_base.rb",
    ).length,
    2,
  );
  const file = path.join(root, "lib/quantity.rb"),
    original = await readFile(file, "utf8");
  await writeFile(file, original + "\n# value + 2 is adjacent literal prose\n");
  const manifest = path.join(root, "Gemfile"),
    lock = path.join(root, "Gemfile.lock"),
    policyFile = path.join(root, "checktrail.ruby-tools.json");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")) +
      '\nplatforms :jruby do\n  gem "ast", "2.4.3"\nend\ninstall_if -> { RUBY_ENGINE == "original_adjacent_engine" } do\n  gem "rspec-support", "3.13.7"\nend\n',
  );
  const lockText = await readFile(lock, "utf8");
  assert.equal(lockText.split("DEPENDENCIES\n").length, 2);
  assert.equal(lockText.split("  rspec-core (= 3.13.6)\n").length, 2);
  await writeFile(
    lock,
    lockText
      .replace("DEPENDENCIES\n", "DEPENDENCIES\n  ast (= 2.4.3)\n")
      .replace(
        "  rspec-core (= 3.13.6)\n",
        "  rspec-core (= 3.13.6)\n  rspec-support (= 3.13.7)\n",
      ),
  );
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  policy.extensions.dependencies.push(
    {
      name: "ast",
      version: "2.4.3",
      groups: ["default"],
      platforms: ["jruby"],
      included: false,
      platformMatches: false,
    },
    {
      name: "rspec-support",
      version: "3.13.7",
      groups: ["default"],
      platforms: [],
      included: false,
      platformMatches: true,
    },
  );
  await writeFile(policyFile, JSON.stringify(policy));
  const adjacent = await run(root);
  assert.equal(adjacent.outcome, "passed", brief(adjacent));
  const dependencies = witnesses(adjacent, "ruby.rspec-extensions").manifest
    .dependencies;
  assert.equal(dependencies.length, 7);
  assert.deepEqual(
    dependencies.find((d) => d.name === "ast"),
    {
      name: "ast",
      requirement: "= 2.4.3",
      groups: ["default"],
      platforms: ["jruby"],
      included: false,
      platformMatches: false,
      source: "https://rubygems.org/",
    },
  );
  assert.deepEqual(
    dependencies.find((d) => d.name === "rspec-support"),
    {
      name: "rspec-support",
      requirement: "= 3.13.7",
      groups: ["default"],
      platforms: [],
      included: false,
      platformMatches: true,
      source: "https://rubygems.org/",
    },
  );
});

function rewrite(
  process: ProcessResult,
  edit: (packet: ReturnType<typeof rubyToolsPacketSchema.parse>) => void,
): ProcessResult {
  const packet = rubyToolsPacketSchema.parse(JSON.parse(process.stdout));
  edit(packet);
  packet.metadataSha256 = mavenHash(packet.metadata);
  packet.dataSha256 = mavenHash(packet.data);
  if (packet.restoreWitness !== undefined)
    packet.restoreWitnessSha256 = mavenHash(packet.restoreWitness);
  return { ...process, stdout: JSON.stringify(packet) };
}
function rewriteWitness(
  process: ProcessResult,
  edit: (
    witness: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>,
  ) => void,
) {
  return rewrite(process, (packet) => {
    const metadata = JSON.parse(packet.metadata) as { extensions: unknown };
    const witness = rubyExtensionsRuntimeWitnessSchema.parse(
      metadata.extensions,
    );
    edit(witness);
    if (packet.restoreWitness) {
      const restored = JSON.parse(packet.restoreWitness);
      restored.manifest = witness.manifest;
      packet.restoreWitness = JSON.stringify(restored);
    }
    metadata.extensions = witness;
    packet.metadata = JSON.stringify(metadata);
  });
}
test("ruby-extensions prerequisite acceptance", native, async (t) => {
  const { root, config } = await rubyExtensionsFixture(t);
  const runtime = spawnSync(
    "ruby",
    ["--disable-gems", "-r", "rbconfig", "-e", "print RbConfig.ruby"],
    { encoding: "utf8" },
  );
  assert.equal(runtime.status, 0);
  assert.match(runtime.stdout, /^\/[A-Za-z0-9_./-]+$/);
  const shim = await mkdtemp(
      path.join(tmpdir(), "ruby-extension-prerequisite-"),
    ),
    executable = path.join(shim, "ruby"),
    originalPath = process.env.PATH,
    manifestFile = path.join(root, "Gemfile"),
    originalManifest = await readFile(manifestFile, "utf8"),
    forbidden = path.join(root, ".checktrail/prerequisite-manifest-executed");
  try {
    await writeFile(
      manifestFile,
      `File.write(${JSON.stringify(forbidden)}, "unexpected execution")\n` +
        originalManifest,
    );
    for (const output of [
      "4.0.6\nruby\n0\n4.0.20",
      "4.0.7\nruby\n0\n4.0.19",
      null,
    ]) {
      if (output === null) await rm(executable);
      else {
        await writeFile(
          executable,
          `#!/bin/sh\nif [ "$2" = "-r" ]; then printf '%s' '${output}'; else exec ${runtime.stdout} "$@"; fi\n`,
        );
        await chmod(executable, 0o755);
      }
      process.env.PATH = shim;
      const report = await run(root);
      assert.equal(report.outcome, "incomplete", brief(report));
      assert.ok(
        report.checks.every((c) => c.status === "unavailable"),
        brief(report),
      );
      assert.ok(
        report.checks.every(
          (c) =>
            c.processes.length === 1 &&
            c.processes[0]!.exitCode === 0 &&
            JSON.parse(c.processes[0]!.stdout).prerequisite === "unavailable",
        ),
      );
      await assert.rejects(access(forbidden));
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await writeFile(manifestFile, originalManifest);
    await rm(shim, { recursive: true, force: true });
  }
  const manifest = path.join(root, "Gemfile"),
    original = await readFile(manifest, "utf8"),
    marker = path.join(root, ".checktrail/passive-marker");
  await writeFile(
    manifest,
    'File.write(".checktrail/passive-marker", "unexpected execution")\n' +
      original,
  );
  const planned = await createPlan(root);
  assert.equal(planned.plan.checks.length, 3);
  assert.ok(planned.plan.checks.every((c) => c.commands.length === 1));
  await assert.rejects(access(marker));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(marker));
  await writeFile(manifest, original);
  const file = path.join(root, "checktrail.ruby-tools.json"),
    text = await readFile(file, "utf8");
  for (const edit of [
    (c: typeof config) => {
      c.extensions.manifests = [];
    },
    (c: typeof config) => {
      c.extensions.profile = "adjacent" as typeof c.extensions.profile;
    },
    (c: typeof config) => {
      c.extensions.dependencies[0]!.version = "1.91.1";
    },
    (c: typeof config) => {
      c.extensions.manifests.push("missing.rb");
    },
    (c: typeof config) => {
      c.extensions.rspecHooks[0]!.file = "lib/quantity.rb";
    },
  ]) {
    const changed = structuredClone(config);
    edit(changed);
    await writeFile(file, JSON.stringify(changed));
    const { plan } = await createPlan(root);
    assert.equal(plan.checks.length, 3);
    assert.ok(
      plan.checks.every(
        (c) => c.commands.length === 0 && !!c.unavailableReason,
      ),
    );
  }
  await writeFile(file, text);
  const { plan } = await createPlan(root);
  assert.ok(plan.checks.every((c) => c.commands.length === 1));
});
test("ruby-extensions stale acceptance", native, async (t) => {
  const { root } = await rubyExtensionsFixture(t, ["ruby.rspec-extensions"]);
  const report = await run(root);
  assert.equal(report.outcome, "passed", brief(report));
  const { plan } = await createPlan(root),
    check = plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  assert.equal(rubyToolsEvidence(check, [process], root).status, "passed");
  for (const file of [
    "Gemfile",
    "Gemfile.lock",
    "gemfiles/tools.rb",
    "lib/quantity.rb",
    "spec/shared_quantity.rb",
    "spec/quantity_spec.rb",
    "checktrail.ruby-tools.json",
  ]) {
    const target = path.join(root, file),
      original = await readFile(target);
    try {
      await writeFile(target, Buffer.concat([original, Buffer.from("\n")]));
      assert.equal(
        rubyToolsEvidence(check, [process], root).status,
        "inconclusive",
        file,
      );
    } finally {
      await writeFile(target, original);
    }
  }
  const artifact = path.join(
    root,
    ".checktrail/dependencies/artifacts/unlisted.gem",
  );
  try {
    await writeFile(artifact, "unlisted public synthetic bytes");
    assert.equal(
      rubyToolsEvidence(check, [process], root).status,
      "inconclusive",
    );
  } finally {
    await rm(artifact);
  }
  const extra = path.join(root, "lib/unlisted.rb");
  try {
    await writeFile(extra, "# unlisted original input\n");
    assert.equal(
      rubyToolsEvidence(check, [process], root).status,
      "inconclusive",
    );
  } finally {
    await rm(extra);
  }
  assert.equal(rubyToolsEvidence(check, [process], root).status, "passed");
  for (const mutate of [
    (p: ReturnType<typeof rubyToolsPacketSchema.parse>) => {
      p.observerSha256 = "0".repeat(64);
    },
    (p: ReturnType<typeof rubyToolsPacketSchema.parse>) => {
      p.restoreObserverSha256 = "0".repeat(64);
    },
    (p: ReturnType<typeof rubyToolsPacketSchema.parse>) => {
      p.receipts[0]!.phase = "restore-adjacent";
    },
  ])
    assert.equal(
      rubyToolsEvidence(check, [rewrite(process, mutate)], root).status,
      "inconclusive",
    );
});
test("ruby-extensions empty acceptance", native, async (t) => {
  const { root } = await rubyExtensionsFixture(t, ["ruby.rspec-extensions"]);
  const report = await run(root);
  assert.equal(report.outcome, "passed", brief(report));
  const { plan } = await createPlan(root),
    check = plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  assert.equal(rubyToolsEvidence(check, [process]).status, "inconclusive");
  for (const changed of [
    { ...process, stdout: "" },
    { ...process, stdout: "{}" },
    { ...process, cancelled: true },
    { ...process, timedOut: true },
    { ...process, truncated: true },
    { ...process, exitCode: 1 },
    { ...process, stderr: "unexpected native error" },
  ])
    assert.equal(
      rubyToolsEvidence(check, [changed], root).status,
      "inconclusive",
    );
  assert.equal(rubyToolsEvidence(check, [], root).status, "inconclusive");
  for (const edit of [
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases.pop();
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.manifest.sources = ["https://rubygems.org.invalid/"];
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases[0]!.receiver = "adjacent native receiver";
      w.cases[0]!.declaring = w.cases[0]!.receiver;
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases[0]!.declaring = "adjacent native declaring owner";
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases[0]!.method += " adjacent";
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases[0]!.ancestors.push(w.cases[0]!.ancestors[0]!);
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases[0]!.receiverFile = "spec/shared_quantity.rb";
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases[0]!.source.line++;
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.cases[0]!.shared[0]!.inclusion.file = "lib/quantity.rb";
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.manifest.dependencies[0]!.groups = ["validation-adjacent"];
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.manifest.dependencies[0]!.platforms = ["jruby"];
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.manifest.dependencies[0]!.included = false;
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.manifest.manifests.pop();
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.hooks.pop();
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.hooks[0]!.caseId = "omitted native case";
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.hooks[0]!.returned = false;
    },
    (w: ReturnType<typeof rubyExtensionsRuntimeWitnessSchema.parse>) => {
      w.registeredHooks.pop();
    },
  ])
    assert.equal(
      rubyToolsEvidence(check, [rewriteWitness(process, edit)], root).status,
      "inconclusive",
    );
  const file = path.join(root, "spec/shared_quantity.rb"),
    original = await readFile(file, "utf8");
  try {
    await writeFile(file, original.replaceAll('  it("', '  xit("'));
    const skipped = await run(root);
    assert.equal(skipped.outcome, "incomplete", brief(skipped));
    const packet = rubyToolsPacketSchema.parse(
      JSON.parse(skipped.checks[0]!.processes[0]!.stdout),
    );
    const data = JSON.parse(packet.data) as {
      summary: { total: number; skipped: number };
    };
    assert.equal(data.summary.total, 4);
    assert.equal(data.summary.skipped, 4);
  } finally {
    await writeFile(file, original);
  }
});

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
test("ruby-extensions privacy acceptance", native, async (t) => {
  const { root } = await rubyExtensionsFixture(t, ["ruby.rspec-extensions"]);
  const source = path.join(root, "spec/shared_quantity.rb"),
    original = await readFile(source, "utf8"),
    canary = "original_ruby_extension_synthetic_canary";
  assert.equal(original.split('"positive defect"').length, 2);
  await writeFile(
    source,
    original.replace('"positive defect"', JSON.stringify(canary)),
  );
  await breakRubyQuantity(root);
  const report = await run(root);
  assert.equal(report.outcome, "failed", brief(report));
  assert.equal(report.checks[0]!.tests?.failed, 4);
  assert.ok(
    !JSON.stringify(projectReport(report, false)).includes(root) &&
      !JSON.stringify(projectReport(report, false)).includes(canary),
  );
  assert.ok(JSON.stringify(projectReport(report, true)).includes(canary));
  const invoke = (trusted: boolean, detailed: boolean) =>
    spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        root,
        "--timeout-ms",
        "120000",
        ...(trusted ? ["--trust-project"] : []),
        ...(detailed ? ["--detailed"] : []),
      ],
      { encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1024 * 1024 },
    );
  const denied = invoke(false, false);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /trust/i);
  for (const detailed of [false, true]) {
    const response = invoke(true, detailed);
    assert.equal(response.status, 1, response.stderr);
    assert.equal(response.stdout.includes(canary), detailed);
    assert.equal(response.stdout.includes(root), detailed);
    assert.equal(
      (JSON.parse(response.stdout) as { outcome: string }).outcome,
      "failed",
    );
  }
  for (const { allow, detailed } of [
    { allow: false, detailed: false },
    { allow: true, detailed: false },
    { allow: true, detailed: true },
  ]) {
    const client = new Client(
      { name: "original-ruby-extension-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            root,
            ...(allow ? ["--allow-execution"] : []),
            ...(detailed ? ["--detailed"] : []),
          ],
          stderr: "pipe",
        }),
      );
      assert.equal(
        (
          await client.callTool({
            name: "validation_run",
            arguments: { trusted: true },
          })
        ).isError,
        true,
      );
      assert.equal(
        (
          await client.callTool({
            name: "validation_run",
            arguments: { detailed: true },
          })
        ).isError,
        true,
      );
      const result = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
      );
      if (!allow) assert.equal(result.isError, true);
      else {
        assert.notEqual(result.isError, true);
        assert.equal(
          (result.structuredContent as { outcome: string }).outcome,
          "failed",
        );
        assert.equal(JSON.stringify(result).includes(canary), detailed);
        assert.equal(JSON.stringify(result).includes(root), detailed);
      }
    } finally {
      await client.close();
    }
  }
});

test(
  "ruby-extensions lifecycle acceptance",
  { ...native, timeout: 600000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"] as const) {
      const { root } = await rubyExtensionsFixture(t, [
          "ruby.rspec-extensions",
        ]),
        marker = path.join(root, ".checktrail/native-body"),
        control = path.join(root, "original-wait.cjs");
      await writeFile(
        control,
        `const fs=require('node:fs');const helper=process.ppid,args=fs.readFileSync('/proc/'+helper+'/cmdline','utf8').split('\\0');const marker=process.env.CHECKTRAIL_RUBY_STARTED;fs.writeFileSync(marker+'.prepared',JSON.stringify({pid:process.pid,helper,owned:args.some(a=>a.endsWith('/observer.rb'))&&args.includes('rspec'),scratch:process.env.TMPDIR,owner:process.env.CHECKTRAIL_TEMP}));fs.renameSync(marker+'.prepared',marker);${mode === "output" ? "setTimeout(()=>{},1000);" : "setInterval(()=>{},1000);"}`,
      );
      const file = path.join(root, "spec/shared_quantity.rb"),
        original = await readFile(file, "utf8"),
        anchor =
          'raise "positive defect" unless OriginalQuantity.next_quantity(2) == 3';
      assert.equal(original.split(anchor).length, 2);
      await writeFile(
        file,
        original.replace(
          anchor,
          'child = Process.spawn("node", ENV.fetch("CHECKTRAIL_RUBY_CONTROL")); Process.wait(child); ' +
            anchor,
        ),
      );
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: ["ruby.rspec-extensions"],
              environment: [
                "CHECKTRAIL_RUBY_CONTROL",
                "CHECKTRAIL_RUBY_STARTED",
              ],
            },
          ],
        }),
      );
      const check = (await createPlan(root)).plan.checks[0]!,
        owner = await mkdtemp(
          path.join(tmpdir(), "original-ruby-extension-owned-"),
        ),
        previous = process.env.TMPDIR,
        abort = new AbortController();
      process.env.TMPDIR = owner;
      const pending = runProcess(root, check.commands[0]!, {
        timeoutMs: mode === "timeout" ? 90000 : 120000,
        maxOutputBytes: mode === "output" ? 1024 : 4 * 1024 * 1024,
        signal: abort.signal,
        environment: {
          CHECKTRAIL_RUBY_CONTROL: control,
          CHECKTRAIL_RUBY_STARTED: marker,
        },
      });
      void pending.catch(() => {});
      let record:
        | {
            pid: number;
            helper: number;
            owned: boolean;
            scratch: string;
            owner: string;
          }
        | undefined;
      try {
        const deadline = Date.now() + 80000;
        while (Date.now() < deadline) {
          try {
            record = JSON.parse(await readFile(marker, "utf8"));
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(record, "Actual shared-example test body was reached");
        assert.equal(record.owned, true);
        assert.ok(
          record.scratch.startsWith(record.owner + path.sep) &&
            record.owner.startsWith(owner + path.sep),
        );
        if (mode !== "output")
          for (const pid of [record.pid, record.helper]) process.kill(pid, 0);
        if (mode === "cancel") abort.abort();
        const result = await pending;
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.truncated, mode === "output");
        assert.equal(
          rubyToolsEvidence(check, [result], root).status,
          "inconclusive",
        );
        await assert.rejects(access(record.scratch), { code: "ENOENT" });
        assert.deepEqual(await readdir(owner), []);
        for (const pid of [record.pid, record.helper])
          await assert.rejects(readFile(`/proc/${pid}/cmdline`), {
            code: "ENOENT",
          });
      } finally {
        abort.abort();
        await pending;
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        await rm(owner, { recursive: true, force: true });
      }
    }
  },
);

test(
  "ruby-extensions installed acceptance",
  { ...native, timeout: 1200000 },
  async () => {
    if (process.env.CHECKTRAIL_RUBY_EXTENSIONS_INSTALLED === "1") {
      assert.match(
        await import("node:fs/promises").then((fs) =>
          fs.realpath(
            fileURLToPath(new URL("../src/engine.js", import.meta.url)),
          ),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "ruby-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const installed = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 1170000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(installed.error, undefined, installed.error?.message ?? "");
    assert.equal(installed.status, 0, installed.stderr.slice(-3000));
    const receipt = JSON.parse(installed.stdout);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_RUBY_EXTENSIONS_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_RUBY_EXTENSIONS_INSTALL_RECEIPT,
        JSON.stringify(receipt),
      );
  },
);
