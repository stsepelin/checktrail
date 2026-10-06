import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFile,
  readlink,
  readdir,
  mkdtemp,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validate } from "../src/engine.js";
import {
  kustomizeFixture,
  kustomizeNative,
  kustomizeInvocation,
} from "./kustomize-fixture.js";
import { originalDeployment } from "./kubeconform-fixture.js";
async function reached(owner: string, phase: "build" | "validate") {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const exe = await readlink(`/proc/${pid}/exe`);
        if (
          exe !==
          (phase === "build"
            ? "/usr/local/bin/kustomize"
            : "/usr/local/bin/kubeconform")
        )
          continue;
        const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split(
          "\0",
        );
        let workspace: string;
        if (phase === "build") {
          if (
            !args.includes("build") ||
            !args.includes("overlay") ||
            !args.includes("LoadRestrictionsRootOnly")
          )
            continue;
          workspace = await readlink(`/proc/${pid}/cwd`);
          if (
            !workspace.startsWith(owner + path.sep) ||
            !workspace.endsWith("/native")
          )
            continue;
        } else {
          const schema = args[args.indexOf("-schema-location") + 1];
          if (
            !args.includes("-strict") ||
            !args.includes("documents/31.yaml") ||
            !schema?.startsWith(owner + path.sep)
          )
            continue;
          workspace = path.dirname(path.dirname(schema));
          assert.ok(workspace.endsWith("/native"));
        }
        const raw = await readFile(`/proc/${pid}/stat`, "utf8");
        const stat = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        return { pid: Number(pid), start: stat[19]!, workspace };
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        )
          throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Actual native ${phase} body was not observed`);
}
async function exercise(
  t: Parameters<typeof kustomizeFixture>[0],
  mode: "cancel" | "source" | "copy" | "document",
  phase: "build" | "validate",
) {
  const root = await kustomizeFixture(t),
    input = kustomizeInvocation(),
    files = Array.from({ length: 32 }, (_, i) => `base/original-${i}.yaml`);
  const config = { ...input.config, resources: files };
  await writeFile(
    path.join(root, "checktrail.kustomize.json"),
    JSON.stringify(config),
  );
  await writeFile(
    path.join(root, "base/kustomization.yaml"),
    "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n" +
      files.map((f) => "  - " + path.basename(f) + "\n").join(""),
  );
  const overlay = input.inputs.find(
    (i) => i.path === "overlay/kustomization.yaml",
  )!.text;
  await writeFile(
    path.join(root, "overlay/kustomization.yaml"),
    overlay.replace("name: original-worker", "name: original-worker-0"),
  );
  for (const file of input.config.resources) await rm(path.join(root, file));
  for (const [i, file] of files.entries())
    await writeFile(
      path.join(root, file),
      originalDeployment
        .replace("name: original-worker", `name: original-worker-${i}`)
        .replace(
          "spec:\n",
          "  annotations:\n    original-padding: " +
            "a".repeat(1400) +
            "\nspec:\n",
        ),
    );
  const owner = await mkdtemp(
      path.join(tmpdir(), "original-kustomize-reached-"),
    ),
    previous = process.env.TMPDIR,
    controller = new AbortController();
  process.env.TMPDIR = owner;
  const running = validate(root, {
    trusted: true,
    timeoutMs: 120000,
    signal: controller.signal,
  });
  try {
    const native = await reached(owner, phase);
    assert.ok(
      native.pid > 0 && native.start.length > 0,
      "Real pinned native body reached before steering execution",
    );
    if (mode === "cancel") controller.abort();
    else {
      const file =
        mode === "source"
          ? path.join(root, files[0]!)
          : mode === "copy"
            ? path.join(native.workspace, files[0]!)
            : path.join(native.workspace, "documents/0.yaml");
      await writeFile(file, (await readFile(file, "utf8")) + "\n");
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    if (mode === "document") {
      assert.equal(
        report.checks[0]!.processes[0]!.exitCode,
        2,
        "Collector rejects changed rendered bytes before emitting a packet",
      );
      assert.equal(report.checks[0]!.processes[0]!.stdout, "");
    }
    if (mode === "cancel")
      assert.ok(report.checks[0]!.processes.some((p) => p.cancelled));
    else assert.equal(report.sourceChanged, mode === "source");
    await assert.rejects(access(native.workspace), { code: "ENOENT" });
    assert.deepEqual(await readdir(owner), []);
    try {
      const stat = await readFile(`/proc/${native.pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      assert.notEqual(
        start,
        native.start,
        "Observed native process survived completion/cancellation",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    controller.abort();
    await running;
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(owner, { recursive: true, force: true });
  }
}
test(
  "native Kustomize build cancellation observes the actual pinned body and removes its process and owned outputs",
  kustomizeNative,
  async (t) => exercise(t, "cancel", "build"),
);
test(
  "native Kustomize source changed after the actual build starts invalidates the execution",
  kustomizeNative,
  async (t) => exercise(t, "source", "build"),
);
test(
  "native Kustomize copied assembly changed after the actual build starts invalidates unchanged original source",
  kustomizeNative,
  async (t) => exercise(t, "copy", "build"),
);
test(
  "native Kustomize validator cancellation observes the actual pinned body and removes its process and owned outputs",
  kustomizeNative,
  async (t) => exercise(t, "cancel", "validate"),
);
test(
  "native Kustomize rendered document changed after the actual validator starts invalidates unchanged original source",
  kustomizeNative,
  async (t) => exercise(t, "document", "validate"),
);
