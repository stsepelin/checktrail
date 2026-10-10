import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { kubeSchemaPins } from "../src/kubeconform.js";
import { kustomizeAssemblyScope } from "../src/kustomize.js";
import {
  kustomizeEvidence,
  kustomizePacketSchema,
} from "../src/kustomize-evidence.js";
import { mavenHash } from "../src/maven.js";
import { runProcess } from "../src/runner.js";
import { readNativeProcCommand } from "./native-process-observer.js";
import {
  extendedKustomizeFixture,
  kustomizeExtensionNative as native,
  originalKustomizeExtensionConfig,
  originalKustomizeExtensionFiles,
} from "./kustomize-extensions-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
async function brokenFixture(
  t: Parameters<typeof extendedKustomizeFixture>[0],
) {
  const root = await extendedKustomizeFixture(t);
  await writeFile(
    path.join(root, "overlay/strategic.yaml"),
    originalKustomizeExtensionFiles["overlay/strategic.yaml"].replace(
      "value: original-extra",
      "value: [original-invalid]",
    ),
  );
  await writeFile(
    path.join(root, "overlay/json.yaml"),
    "- op: add\n  path: /spec/template/spec/containers/0/resources\n  value:\n    limits:\n      cpu: [original-invalid]\n",
  );
  return root;
}
test("kustomize-extensions broken acceptance", native, async (t) => {
  const root = await brokenFixture(t),
    report = await run(root),
    result = report.checks[0]!;
  assert.equal(report.outcome, "failed", JSON.stringify(result));
  assert.equal(result.findingsComplete, true);
  assert.deepEqual(
    new Set(result.findings!.map((f) => f.file)),
    new Set(["overlay/strategic.yaml", "overlay/json.yaml"]),
  );
  assert.ok(result.findings!.every((f) => f.line! > 0));
  const p = kustomizePacketSchema.parse(
    JSON.parse(result.processes[0]!.stdout),
  );
  assert.equal(p.documents.length, 3);
  assert.deepEqual(JSON.parse(p.receipts[3]!.stdout).summary, {
    valid: 2,
    invalid: 1,
    errors: 0,
    skipped: 0,
  });
});
test("kustomize-extensions fixed acceptance", native, async (t) => {
  const root = await brokenFixture(t);
  assert.equal((await run(root)).outcome, "failed");
  for (const file of ["overlay/strategic.yaml", "overlay/json.yaml"] as const)
    await writeFile(
      path.join(root, file),
      originalKustomizeExtensionFiles[file],
    );
  const report = await run(root);
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  assert.equal(report.checks[0]!.findingsComplete, true);
  assert.deepEqual(report.checks[0]!.findings, []);
  assert.equal(
    kustomizePacketSchema.parse(
      JSON.parse(report.checks[0]!.processes[0]!.stdout),
    ).documents.length,
    3,
  );
});
test("kustomize-extensions near-miss acceptance", native, async (t) => {
  const root = await extendedKustomizeFixture(t),
    file = path.join(root, "base/deployment.yaml"),
    text = await readFile(file, "utf8");
  await writeFile(
    file,
    text +
      "      initContainers:\n        - name: original-adjacent\n          image: registry.example.invalid/original-other:v1\n",
  );
  const report = await run(root);
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  const build = kustomizePacketSchema.parse(
    JSON.parse(report.checks[0]!.processes[0]!.stdout),
  ).receipts[2]!.stdout;
  assert.match(build, /registry.example.invalid\/original-other:v1/);
  assert.match(build, /registry.example.invalid\/repaired:v2/);
  const overlay = path.join(root, "overlay/kustomization.yaml"),
    original = await readFile(overlay, "utf8");
  for (const field of [
    "plugins:\n  - original.yaml\n",
    "namespaceSelector: original\n",
  ]) {
    await writeFile(overlay, original + field);
    const plan = (await createPlan(root)).plan.checks[0]!;
    assert.equal(plan.commands.length, 0);
    assert.equal((await run(root)).checks[0]!.status, "unavailable");
  }
});
test("kustomize-extensions prerequisite acceptance", native, async (t) => {
  const root = await extendedKustomizeFixture(t);
  for (const pin of kubeSchemaPins) {
    const file = path.join(
        root,
        originalKustomizeExtensionConfig.schemaDirectory,
        pin.file,
      ),
      bytes = await readFile(file);
    try {
      const changed = Buffer.from(bytes);
      changed[0] = changed[0]! ^ 1;
      await writeFile(file, changed);
      const check = (await createPlan(root)).plan.checks[0]!,
        result = (await run(root)).checks[0]!;
      assert.equal(check.commands.length, 0);
      assert.equal(result.status, "unavailable");
      assert.equal(result.processes.length, 0);
    } finally {
      await writeFile(file, bytes);
    }
  }
  const absent = await mkdtemp(
      path.join(tmpdir(), "original-kustomize-no-tools-"),
    ),
    previous = process.env.PATH;
  try {
    process.env.PATH = absent;
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.deepEqual(
      check.scope,
      kustomizeAssemblyScope(originalKustomizeExtensionConfig),
    );
    assert.equal((await run(root)).checks[0]!.processes.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(absent, { recursive: true, force: true });
  }
});
test("kustomize-extensions stale acceptance", native, async (t) => {
  const root = await extendedKustomizeFixture(t),
    directory = path.join(root, ".checktrail/operator-tools");
  await mkdir(directory, { recursive: true });
  const tools = [];
  for (const name of ["kustomize", "kubeconform"]) {
    const file = path.join(directory, name);
    await copyFile("/usr/local/bin/" + name, file);
    await chmod(file, 0o755);
    tools.push(file);
  }
  const previous = process.env.PATH;
  process.env.PATH = directory + path.delimiter + (previous ?? "");
  try {
    const check = (await createPlan(root)).plan.checks[0]!,
      report = await run(root),
      processResult = report.checks[0]!.processes[0]!;
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.deepEqual(
      kustomizePacketSchema
        .parse(JSON.parse(processResult.stdout))
        .tools.map((t) => t.entry),
      tools,
    );
    for (const file of [
      path.join(root, "checktrail.kustomize.json"),
      ...kustomizeAssemblyScope(originalKustomizeExtensionConfig).map((f) =>
        path.join(root, f),
      ),
      ...kubeSchemaPins.map((p) =>
        path.join(
          root,
          originalKustomizeExtensionConfig.schemaDirectory,
          p.file,
        ),
      ),
      ...tools,
    ]) {
      const bytes = await readFile(file);
      try {
        const changed = Buffer.from(bytes);
        changed[0] = changed[0]! ^ 1;
        await writeFile(file, changed);
        const result = kustomizeEvidence(check, [processResult]);
        assert.equal(result.status, "inconclusive", file);
        assert.equal(result.findingsComplete, false);
      } finally {
        await writeFile(file, bytes);
      }
      assert.equal(
        kustomizeEvidence(check, [processResult]).status,
        "passed",
        file,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
test("kustomize-extensions empty acceptance", native, async (t) => {
  const root = await extendedKustomizeFixture(t),
    check = (await createPlan(root)).plan.checks[0]!,
    processResult = (await run(root)).checks[0]!.processes[0]!,
    good = kustomizePacketSchema.parse(JSON.parse(processResult.stdout));
  for (const mutate of [
    (p: typeof good) => {
      p.documents.pop();
    },
    (p: typeof good) => {
      p.schemas.pop();
    },
    (p: typeof good) => {
      p.receipts[2]!.stdout = "";
      p.receipts[2]!.stdoutSha256 = mavenHash("");
    },
    (p: typeof good) => {
      const row = p.receipts[3]!,
        data = JSON.parse(row.stdout);
      data.resources = [];
      data.summary = { valid: 0, invalid: 0, errors: 0, skipped: 0 };
      row.stdout = JSON.stringify(data);
      row.stdoutSha256 = mavenHash(row.stdout);
    },
    (p: typeof good) => {
      const row = p.receipts[3]!,
        data = JSON.parse(row.stdout);
      for (const r of data.resources) r.status = "statusSkipped";
      data.summary = { valid: 0, invalid: 0, errors: 0, skipped: 3 };
      row.stdout = JSON.stringify(data);
      row.stdoutSha256 = mavenHash(row.stdout);
    },
  ]) {
    const changed = structuredClone(good);
    mutate(changed);
    assert.equal(
      kustomizeEvidence(check, [
        { ...processResult, stdout: JSON.stringify(changed) },
      ]).status,
      "inconclusive",
    );
  }
  for (const flags of [
    { truncated: true },
    { cancelled: true },
    { timedOut: true },
    { stdout: "[" },
  ])
    assert.equal(
      kustomizeEvidence(check, [{ ...processResult, ...flags }]).status,
      "inconclusive",
    );
});
test("kustomize-extensions privacy acceptance", native, async (t) => {
  const root = await brokenFixture(t);
  const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
    encoding: "utf8",
  });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /trust/i);
  const invoke = (detailed: boolean) =>
    spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        root,
        "--trust-project",
        ...(detailed ? ["--detailed"] : []),
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1048576 },
    );
  const summary = invoke(false),
    detailed = invoke(true);
  assert.equal(summary.status, 1, summary.stderr);
  assert.equal(detailed.status, 1, detailed.stderr);
  assert.ok(
    !summary.stdout.includes(root) &&
      !summary.stdout.includes("original-invalid") &&
      !summary.stdout.includes("overlay/strategic.yaml"),
  );
  assert.ok(
    detailed.stdout.includes(root) &&
      detailed.stdout.includes("original-invalid"),
  );
  for (const { allow, detailedOutput } of [
    { allow: false, detailedOutput: false },
    { allow: true, detailedOutput: false },
    { allow: true, detailedOutput: true },
  ]) {
    const client = new Client(
      { name: "original-extended-kustomize-client", version: "1.0.0" },
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
            ...(detailedOutput ? ["--detailed"] : []),
          ],
          env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: tmpdir(),
            TMP: tmpdir(),
            TEMP: tmpdir(),
          },
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
      const result = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      if (!allow) assert.equal(result.isError, true);
      else {
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const content = result.structuredContent as {
          outcome: string;
          checks: unknown;
        };
        assert.equal(content.outcome, "failed");
        if (!detailedOutput) {
          assert.deepEqual(content.checks, JSON.parse(summary.stdout).checks);
          assert.ok(
            !JSON.stringify(content).includes(root) &&
              !JSON.stringify(content).includes("original-invalid"),
          );
        } else {
          assert.ok(
            JSON.stringify(content).includes(root) &&
              JSON.stringify(content).includes("original-invalid"),
          );
        }
        const toolDisclosure = await client.callTool({
          name: "validation_run",
          arguments: { detailed: true },
        });
        assert.equal(
          toolDisclosure.isError,
          true,
          "Source disclosure remains a startup setting",
        );
      }
    } finally {
      await client.close();
    }
  }
});
async function reachedNative(owner: string, phase: "build" | "validate") {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = await readNativeProcCommand(
          pid,
          phase === "build"
            ? "/usr/local/bin/kustomize"
            : "/usr/local/bin/kubeconform",
        );
        if (!args) continue;
        let workspace: string;
        if (phase === "build") {
          if (
            !args.includes("build") ||
            !args.includes("overlay") ||
            !args.includes("LoadRestrictionsRootOnly")
          )
            continue;
          workspace = await readlink(`/proc/${pid}/cwd`);
        } else {
          const schema = args[args.indexOf("-schema-location") + 1];
          if (
            !args.includes("-strict") ||
            !args.includes("documents/31.yaml") ||
            !schema
          )
            continue;
          workspace = path.dirname(path.dirname(schema));
        }
        if (
          !workspace.startsWith(owner + path.sep) ||
          !workspace.endsWith("/native")
        )
          continue;
        await access(path.join(workspace, "overlay/kustomization.yaml"));
        return { pid: Number(pid), workspace };
      } catch (error) {
        if (
          !["ENOENT", "ESRCH", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("Actual selected native " + phase + " body was not reached");
}
async function lifecycleFixture(
  t: Parameters<typeof extendedKustomizeFixture>[0],
) {
  const root = await extendedKustomizeFixture(t),
    files = Array.from({ length: 32 }, (_v, i) => `base/original-${i}.yaml`);
  await rm(path.join(root, "base/deployment.yaml"));
  await rm(path.join(root, "base/service.yaml"));
  for (const [i, file] of files.entries()) {
    const original = originalKustomizeExtensionFiles["base/deployment.yaml"],
      text =
        i === 0
          ? original
          : original.replaceAll("original-worker", "original-worker-" + i);
    await writeFile(path.join(root, file), text);
  }
  await writeFile(
    path.join(root, "base/kustomization.yaml"),
    "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n" +
      files.map((f) => "  - " + path.posix.basename(f)).join("\n") +
      "\n",
  );
  await writeFile(
    path.join(root, "checktrail.kustomize.json"),
    JSON.stringify({ ...originalKustomizeExtensionConfig, resources: files }),
  );
  return root;
}
test(
  "kustomize-extensions lifecycle acceptance",
  { ...native, timeout: 240000 },
  async (t) => {
    for (const phase of ["build", "validate"] as const)
      for (const mode of ["cancel", "timeout", "output"] as const) {
        const root = await lifecycleFixture(t),
          check = (await createPlan(root)).plan.checks[0]!,
          owner = await mkdtemp(
            path.join(tmpdir(), "original-extended-kustomize-owned-"),
          ),
          previous = process.env.TMPDIR,
          abort = new AbortController();
        assert.equal(
          check.commands.length,
          1,
          check.unavailableReason ??
            "Expected the complete extended native plan",
        );
        process.env.TMPDIR = owner;
        const before = await readdir(owner),
          pending = runProcess(root, check.commands[0]!, {
            timeoutMs: mode === "timeout" ? 15000 : 120000,
            maxOutputBytes: mode === "output" ? 4096 : 1048576,
            signal: abort.signal,
          });
        void pending.catch(() => {});
        try {
          const reached = await reachedNative(owner, phase);
          process.kill(reached.pid, 0);
          if (mode === "cancel") abort.abort();
          if (mode === "timeout") process.kill(reached.pid, "SIGSTOP");
          const result = await pending;
          assert.equal(result.cancelled, mode === "cancel");
          assert.equal(result.timedOut, mode === "timeout");
          assert.equal(result.truncated, mode === "output");
          assert.equal(
            kustomizeEvidence(check, [result]).findingsComplete,
            false,
          );
          await assert.rejects(access(reached.workspace), { code: "ENOENT" });
          await assert.rejects(readFile(`/proc/${reached.pid}/cmdline`), {
            code: "ENOENT",
          });
          assert.deepEqual(await readdir(owner), before);
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
  "kustomize-extensions installed acceptance",
  { ...native, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_KUSTOMIZE_EXTENSIONS_INSTALLED === "1") {
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "kustomize-extensions",
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
      { env, encoding: "utf8", timeout: 570000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(installed.status, 0, installed.stderr);
    const receipt = JSON.parse(installed.stdout);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_KUSTOMIZE_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_KUSTOMIZE_INSTALL_RECEIPT,
        JSON.stringify(receipt),
      );
  },
);
