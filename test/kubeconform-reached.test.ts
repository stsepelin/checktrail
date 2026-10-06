import { readNativeProcCommand } from "./native-process-observer.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFile,
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
  kubeFixture,
  kubeNative,
  originalDeployment,
} from "./kubeconform-fixture.js";
async function reached(owner: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = await readNativeProcCommand(
          pid,
          "/usr/local/bin/kubeconform",
        );
        if (!args) continue;
        const schema = args[args.indexOf("-schema-location") + 1];
        if (
          !args.includes("-strict") ||
          !args.includes("documents/63.yaml") ||
          !schema?.startsWith(owner + path.sep)
        )
          continue;
        const workspace = path.dirname(path.dirname(schema));
        assert.ok(workspace.endsWith("/native"));
        const raw = await readFile(`/proc/${pid}/stat`, "utf8");
        const stat = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        return { pid: Number(pid), start: stat[19]!, workspace };
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ESRCH" &&
          (error as NodeJS.ErrnoException).code !== "EACCES"
        )
          throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Actual native validator body was not observed");
}
async function exercise(
  t: Parameters<typeof kubeFixture>[0],
  mode: "cancel" | "source" | "document",
) {
  const text = Array.from({ length: 64 }, (_, i) =>
    originalDeployment.replace(
      "name: original-worker",
      `name: original-worker-${i}`,
    ),
  ).join("---\n");
  const root = await kubeFixture(t, text),
    owner = await mkdtemp(path.join(tmpdir(), "original-kubernetes-reached-")),
    previous = process.env.TMPDIR,
    controller = new AbortController();
  process.env.TMPDIR = owner;
  const running = validate(root, {
    trusted: true,
    timeoutMs: 120000,
    signal: controller.signal,
  });
  try {
    const native = await reached(owner);
    assert.ok(
      native.pid > 0 && native.start.length > 0,
      "Real pinned kubeconform validation reached before steering execution",
    );
    if (mode === "cancel") controller.abort();
    else {
      const file =
        mode === "source"
          ? path.join(root, "manifests/original.yaml")
          : path.join(native.workspace, "documents/0.yaml");
      await writeFile(file, (await readFile(file, "utf8")) + "\n");
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
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
        "Observed native validator survived completion/cancellation",
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
  "native Kubernetes cancellation observes the real validator body and removes its process and owned outputs",
  kubeNative,
  async (t) => exercise(t, "cancel"),
);
test(
  "native Kubernetes source changed after the real validator starts invalidates the execution",
  kubeNative,
  async (t) => exercise(t, "source"),
);
test(
  "native Kubernetes copied document changed after the real validator starts invalidates unchanged original source",
  kubeNative,
  async (t) => exercise(t, "document"),
);
