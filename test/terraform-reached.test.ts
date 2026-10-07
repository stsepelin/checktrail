import { readNativeProcCommand } from "./native-process-observer.js";
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
  terraformFixture,
  terraformNative,
  terraformRewrite,
} from "./terraform-fixture.js";
async function reached(owner: string, version = false) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = await readNativeProcCommand(
          pid,
          "/usr/local/bin/terraform",
        );
        if (!args) continue;
        if (
          !args.includes(version ? "version" : "validate") ||
          !args.includes("-json") ||
          (!version && !args.includes("-no-color"))
        )
          continue;
        const workspace = await readlink(`/proc/${pid}/cwd`);
        if (!workspace.startsWith(owner + path.sep)) continue;
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
  t: Parameters<typeof terraformFixture>[0],
  mode: "cancel" | "source" | "document" | "version",
) {
  const root = await terraformFixture(t);
  for (const file of ["main.tf.json", "support.tf.json"])
    await terraformRewrite(root, file, (p) => {
      const locals = (p.locals ?? {}) as Record<string, string>;
      for (let i = 0; i < 120; i++)
        locals[
          (file === "main.tf.json"
            ? "original_scale_main_"
            : "original_scale_support_") + i
        ] =
          i === 0
            ? "${var.original_count + 1}"
            : "${local." +
              (file === "main.tf.json"
                ? "original_scale_main_"
                : "original_scale_support_") +
              (i - 1) +
              " + 1}";
      p.locals = locals;
    });
  const owner = await mkdtemp(
      path.join(tmpdir(), "original-terraform-reached-"),
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
    const native = await reached(owner, mode === "version");
    assert.ok(
      native.pid > 0 && native.start.length > 0,
      "Real pinned Terraform validation reached before steering execution",
    );
    if (mode === "cancel" || mode === "version") controller.abort();
    else {
      const file =
        mode === "source"
          ? path.join(root, "main.tf.json")
          : path.join(native.workspace, "main.tf.json");
      await writeFile(file, (await readFile(file, "utf8")) + "\n");
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    if (mode === "cancel")
      assert.ok(report.checks[0]!.processes.some((p) => p.cancelled));
    else if (mode === "version")
      assert.ok(
        report.checks[0]!.tools?.some(
          (t) => t.name === "terraform" && t.process?.cancelled,
        ),
      );
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
  "native Terraform cancellation observes the real validator body and removes its process and owned outputs",
  terraformNative,
  async (t) => exercise(t, "cancel"),
);
test(
  "native Terraform source changed after the real validator starts invalidates the execution",
  terraformNative,
  async (t) => exercise(t, "source"),
);
test(
  "native Terraform copied module changed after the real validator starts invalidates unchanged original source",
  terraformNative,
  async (t) => exercise(t, "document"),
);

test(
  "native Terraform cancellation during version collection observes the actual native process and removes fresh outputs",
  terraformNative,
  async (t) => exercise(t, "version"),
);
