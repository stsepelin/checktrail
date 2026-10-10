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
import { kubeSchemaPinsFor } from "../src/kubeconform.js";
import {
  kubeconformEvidence,
  kubeconformPacketSchema,
} from "../src/kubeconform-evidence.js";
import { kubernetesExtensionPins } from "../src/kubernetes-extensions.js";
import { mavenHash } from "../src/maven.js";
import { runProcess } from "../src/runner.js";
import { readNativeProcCommand } from "./native-process-observer.js";
import {
  extendedKubernetesConfig,
  extendedKubernetesNative as native,
  extendedKubernetesFixture,
  originalKubernetesResources,
  originalKubernetesFaults,
  originalKubernetesText,
  breakOriginalResource,
} from "./kubernetes-extensions-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const brokenResources = () => {
  const resources = originalKubernetesResources();
  for (const fault of originalKubernetesFaults)
    breakOriginalResource(resources, fault);
  return resources;
};
test("kubernetes-extensions broken acceptance", native, async (t) => {
  const root = await extendedKubernetesFixture(t, brokenResources()),
    result = (await run(root)).checks[0]!;
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.findingsComplete, true);
  assert.deepEqual(
    new Set(result.findings!.map((f) => f.message.split(" ")[0])),
    new Set(kubernetesExtensionPins.map((p) => p.kind)),
  );
  assert.ok(
    result.findings!.every(
      (f) => f.file === "manifests/original.yaml" && f.line! > 0,
    ),
  );
  const packet = kubeconformPacketSchema.parse(
    JSON.parse(result.processes[0]!.stdout),
  );
  assert.equal(packet.schemas.length, 13);
  assert.equal(packet.documents.length, 13);
  assert.deepEqual(JSON.parse(packet.receipts[1]!.stdout).summary, {
    valid: 3,
    invalid: 10,
    errors: 0,
    skipped: 0,
  });
});
test("kubernetes-extensions fixed acceptance", native, async (t) => {
  const root = await extendedKubernetesFixture(t, brokenResources());
  assert.equal((await run(root)).outcome, "failed");
  await writeFile(
    path.join(root, "manifests/original.yaml"),
    originalKubernetesText(),
  );
  const report = await run(root),
    result = report.checks[0]!;
  assert.equal(report.outcome, "passed", JSON.stringify(result));
  assert.equal(result.findingsComplete, true);
  assert.deepEqual(result.findings, []);
  const packet = kubeconformPacketSchema.parse(
    JSON.parse(result.processes[0]!.stdout),
  );
  assert.deepEqual(JSON.parse(packet.receipts[1]!.stdout).summary, {
    valid: 13,
    invalid: 0,
    errors: 0,
    skipped: 0,
  });
});
test("kubernetes-extensions near-miss acceptance", native, async (t) => {
  const resources = originalKubernetesResources();
  for (const resource of resources)
    resource.metadata.annotations = {
      "original.example.invalid/name":
        "RoleBindingExtra and apps/v1beta1 are ordinary annotation data",
    };
  const root = await extendedKubernetesFixture(t, resources);
  assert.equal((await run(root)).outcome, "passed");
  const source = path.join(root, "manifests/original.yaml");
  for (const change of [
    () =>
      originalKubernetesResources().map((r) =>
        r.kind === "RoleBinding" ? { ...r, kind: "RoleBindingExtra" } : r,
      ),
    () =>
      originalKubernetesResources().map((r) =>
        r.kind === "Role"
          ? { ...r, apiVersion: "rbac.authorization.k8s.io/v1beta1" }
          : r,
      ),
  ]) {
    await writeFile(source, originalKubernetesText(change()));
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.equal((await run(root)).checks[0]!.status, "unavailable");
  }
});
test("kubernetes-extensions prerequisite acceptance", native, async (t) => {
  const root = await extendedKubernetesFixture(t);
  for (const pin of kubernetesExtensionPins) {
    const file = path.join(
        root,
        extendedKubernetesConfig.schemaDirectory,
        pin.file,
      ),
      original = await readFile(file);
    try {
      const changed = Buffer.from(original);
      changed[0] = changed[0]! ^ 1;
      await writeFile(file, changed);
      const check = (await createPlan(root)).plan.checks[0]!,
        result = (await run(root)).checks[0]!;
      assert.equal(check.commands.length, 0, pin.file);
      assert.equal(result.status, "unavailable", pin.file);
      assert.equal(result.processes.length, 0, pin.file);
    } finally {
      await writeFile(file, original);
    }
  }
  const absent = await mkdtemp(
      path.join(tmpdir(), "original-kubernetes-missing-tool-"),
    ),
    previous = process.env.PATH;
  try {
    process.env.PATH = absent;
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.deepEqual(check.scope, ["manifests/original.yaml"]);
    const result = (await run(root)).checks[0]!;
    assert.equal(result.status, "unavailable");
    assert.equal(result.processes.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(absent, { recursive: true, force: true });
  }
});
test("kubernetes-extensions stale acceptance", native, async (t) => {
  const root = await extendedKubernetesFixture(t),
    directory = path.join(root, ".checktrail/operator-tools");
  await mkdir(directory, { recursive: true });
  const selected = path.join(directory, "kubeconform");
  await copyFile("/usr/local/bin/kubeconform", selected);
  await chmod(selected, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = directory + path.delimiter + (previous ?? "");
  try {
    const check = (await createPlan(root)).plan.checks[0]!,
      report = await run(root),
      processResult = report.checks[0]!.processes[0]!;
    assert.equal(report.outcome, "passed");
    assert.equal(
      JSON.parse(processResult.stdout).tool.entry,
      selected,
      "Actual native capture used the owned pinned tool copy",
    );
    for (const file of [
      path.join(root, "manifests/original.yaml"),
      path.join(root, "checktrail.kubeconform.json"),
      ...kubeSchemaPinsFor(extendedKubernetesConfig).map((p) =>
        path.join(root, extendedKubernetesConfig.schemaDirectory, p.file),
      ),
      selected,
    ]) {
      const bytes = await readFile(file);
      try {
        const changed = Buffer.from(bytes);
        changed[0] = changed[0]! ^ 1;
        await writeFile(file, changed);
        const result = kubeconformEvidence(check, [processResult]);
        assert.equal(result.status, "inconclusive", path.basename(file));
        assert.equal(result.findingsComplete, false);
      } finally {
        await writeFile(file, bytes);
      }
      assert.equal(
        kubeconformEvidence(check, [processResult]).status,
        "passed",
        path.basename(file) + " restoration",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
test("kubernetes-extensions empty acceptance", native, async (t) => {
  const root = await extendedKubernetesFixture(t),
    check = (await createPlan(root)).plan.checks[0]!,
    process = (await run(root)).checks[0]!.processes[0]!;
  const good = kubeconformPacketSchema.parse(JSON.parse(process.stdout));
  for (const mutate of [
    (p: typeof good) => {
      p.documents = [];
    },
    (p: typeof good) => {
      p.schemas.pop();
    },
    (p: typeof good) => {
      p.schemas[3]!.afterSha256 = "0".repeat(64);
    },
    (p: typeof good) => {
      const row = p.receipts[1]!,
        data = JSON.parse(row.stdout);
      data.resources = [];
      data.summary = { valid: 0, invalid: 0, errors: 0, skipped: 0 };
      row.stdout = JSON.stringify(data);
      row.stdoutSha256 = mavenHash(row.stdout);
    },
    (p: typeof good) => {
      const row = p.receipts[1]!,
        data = JSON.parse(row.stdout);
      for (const resource of data.resources) resource.status = "statusSkipped";
      data.summary = { valid: 0, invalid: 0, errors: 0, skipped: 13 };
      row.stdout = JSON.stringify(data);
      row.stdoutSha256 = mavenHash(row.stdout);
    },
  ]) {
    const changed = structuredClone(good);
    mutate(changed);
    const result = kubeconformEvidence(check, [
      { ...process, stdout: JSON.stringify(changed) },
    ]);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.findingsComplete, false);
  }
  for (const flags of [
    { truncated: true },
    { cancelled: true },
    { timedOut: true },
    { stdout: "[" },
  ]) {
    const result = kubeconformEvidence(check, [{ ...process, ...flags }]);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.findingsComplete, false);
  }
});
test("kubernetes-extensions privacy acceptance", native, async (t) => {
  const root = await extendedKubernetesFixture(t, brokenResources());
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
      !summary.stdout.includes("manifests/original.yaml"),
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
      { name: "original-extended-kubernetes-client", version: "1.0.0" },
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
async function reachedValidator(owner: string) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = await readNativeProcCommand(
          entry,
          "/usr/local/bin/kubeconform",
        );
        if (!args) continue;
        const schema = args[args.indexOf("-schema-location") + 1];
        if (
          args.includes("-strict") &&
          args.includes("documents/63.yaml") &&
          schema?.startsWith(owner + path.sep)
        ) {
          const workspace = path.dirname(path.dirname(schema));
          assert.ok(workspace.endsWith("/native"));
          await access(path.join(workspace, "documents/63.yaml"));
          return { pid: Number(entry), workspace };
        }
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
  throw Error("Actual selected native validator body was not reached");
}
test("kubernetes-extensions lifecycle acceptance", native, async (t) => {
  for (const mode of ["cancel", "timeout", "output"] as const) {
    const original = originalKubernetesResources(),
      resources = Array.from({ length: 64 }, (_, i) => ({
        ...original[i % original.length]!,
        metadata: { name: "original-worker-" + i },
      })),
      root = await extendedKubernetesFixture(t, resources),
      check = (await createPlan(root)).plan.checks[0]!,
      owner = await mkdtemp(
        path.join(tmpdir(), "original-extended-kubernetes-owned-"),
      ),
      previous = process.env.TMPDIR,
      abort = new AbortController();
    process.env.TMPDIR = owner;
    const before = await readdir(owner);
    const pending = runProcess(root, check.commands[0]!, {
      timeoutMs: mode === "timeout" ? 15000 : 120000,
      maxOutputBytes: mode === "output" ? 4096 : 1048576,
      signal: abort.signal,
    });
    void pending.catch(() => {});
    try {
      const reached = await reachedValidator(owner);
      process.kill(reached.pid, 0);
      if (mode === "cancel") abort.abort();
      if (mode === "timeout") process.kill(reached.pid, "SIGSTOP");
      const result = await pending;
      assert.equal(result.cancelled, mode === "cancel");
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.truncated, mode === "output");
      assert.equal(
        kubeconformEvidence(check, [result]).findingsComplete,
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
});
test(
  "kubernetes-extensions installed acceptance",
  { ...native, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_KUBERNETES_EXTENSIONS_INSTALLED === "1") {
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "kubernetes-extensions",
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
    if (process.env.CHECKTRAIL_KUBERNETES_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_KUBERNETES_INSTALL_RECEIPT,
        JSON.stringify(receipt),
      );
  },
);
