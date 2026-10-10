import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPlan } from "../src/engine.js";
import { runProcess } from "../src/runner.js";
import { helmExtensionsEvidence } from "../src/helm-extensions-evidence.js";
import { helmExtensionsPacketSchema } from "../src/helm-extensions-packet.js";
import { helmBinarySha256 } from "../src/helm.js";
import { mavenHash } from "../src/maven.js";
import {
  helmExtensionsFixture,
  helmExtensionsNative as native,
} from "./helm-extensions-fixture.js";
async function reached(owner: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const id of await readdir("/proc")) {
      if (!/^[1-9][0-9]*$/.test(id)) continue;
      try {
        const workspace = await readlink(`/proc/${id}/cwd`);
        if (
          !workspace.startsWith(owner + path.sep) ||
          !workspace.endsWith("/native")
        )
          continue;
        const args = (await readFile(`/proc/${id}/cmdline`, "utf8")).split(
          "\0",
        );
        if (
          !args.includes("chart") ||
          !(args.includes("lint") || args.includes("template"))
        )
          continue;
        const stat = (await readFile(`/proc/${id}/stat`, "utf8"))
          .split(") ")[1]!
          .split(" ");
        const cpuNanoseconds = (await readFile(`/proc/${id}/schedstat`, "utf8"))
          .trim()
          .split(/\s+/)[0]!;
        if (!/^[0-9]+$/.test(cpuNanoseconds) || BigInt(cpuNanoseconds) === 0n)
          continue;
        process.kill(Number(id), "SIGSTOP");
        assert.equal(
          mavenHash(await readFile(`/proc/${id}/exe`)),
          helmBinarySha256,
        );
        assert.equal(
          (await readFile(`/proc/${id}/stat`, "utf8"))
            .split(") ")[1]!
            .split(" ")[19],
          stat[19],
        );
        return {
          pid: Number(id),
          start: stat[19]!,
          cpuNanoseconds,
          workspace,
          temporary: path.dirname(workspace),
          phase: args.includes("lint") ? "lint" : "render",
        };
      } catch (e) {
        if (
          !["ENOENT", "ESRCH", "EACCES"].includes(
            (e as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(
    "Actual pinned Helm lint/render CPU execution was not observed",
  );
}
async function gone(pid: number, start: string) {
  try {
    assert.notEqual(
      (await readFile(`/proc/${pid}/stat`, "utf8"))
        .split(") ")[1]!
        .split(" ")[19],
      start,
      "Observed native Helm survived cleanup",
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
test("helm-extensions lifecycle acceptance", native, async (t) => {
  const witnesses: { mode: string; phase: string; cpuNanoseconds: string }[] =
    [];
  for (const mode of [
    "cancel",
    "timeout",
    "output",
    "source",
    "policy",
    "copied-source",
    "native-chart",
    "added-native",
    "native-alias",
  ]) {
    const root = await helmExtensionsFixture(t),
      owner = await mkdtemp(
        path.join(tmpdir(), "original-helm-extension-reached-"),
      ),
      previous = process.env.TMPDIR,
      controller = new AbortController();
    process.env.TMPDIR = owner;
    const { plan, source } = await createPlan(root),
      check = plan.checks[0]!;
    const running = runProcess(source.root, check.commands[0]!, {
      timeoutMs: mode === "timeout" ? 8000 : 120000,
      maxOutputBytes: mode === "output" ? 1024 : 1048576,
      signal: controller.signal,
    });
    try {
      const observed = await reached(owner);
      witnesses.push({
        mode,
        phase: observed.phase,
        cpuNanoseconds: observed.cpuNanoseconds,
      });
      assert.ok(observed.pid > 1);
      assert.ok(observed.start.length > 0);
      if (mode === "cancel") controller.abort();
      else if (mode !== "timeout") {
        if (
          ["source", "policy", "copied-source", "native-chart"].includes(mode)
        ) {
          const file =
            mode === "source"
              ? path.join(root, "values.yaml")
              : mode === "policy"
                ? path.join(root, "checktrail.helm-extensions.json")
                : mode === "copied-source"
                  ? path.join(observed.temporary, "source/values.yaml")
                  : path.join(observed.workspace, "chart/values.yaml");
          await writeFile(
            file,
            Buffer.concat([await readFile(file), Buffer.from("\n")]),
          );
        } else if (mode === "added-native")
          await writeFile(
            path.join(observed.workspace, "chart/templates/extra.yaml"),
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: extra\n",
          );
        else if (mode === "native-alias") {
          const file = path.join(observed.workspace, "chart/values.yaml"),
            bytes = await readFile(file);
          await rm(file);
          await writeFile(
            path.join(observed.temporary, "aliased-values"),
            bytes,
          );
          await symlink(path.join(observed.temporary, "aliased-values"), file);
        }
        process.kill(observed.pid, "SIGCONT");
      }
      const result = await running;
      assert.equal(
        helmExtensionsEvidence(check, [result], source.root).status,
        "inconclusive",
        mode,
      );
      if (mode === "cancel") assert.equal(result.cancelled, true);
      if (mode === "timeout") assert.equal(result.timedOut, true);
      if (mode === "output") assert.equal(result.truncated, true);
      await gone(observed.pid, observed.start);
      await assert.rejects(access(observed.temporary), { code: "ENOENT" });
      assert.deepEqual(await readdir(owner), []);
    } finally {
      controller.abort();
      await running;
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(owner, { recursive: true, force: true });
    }
  }
  const first = await helmExtensionsFixture(t),
    second = await helmExtensionsFixture(t),
    owner = await mkdtemp(
      path.join(tmpdir(), "original-helm-extension-siblings-"),
    ),
    previous = process.env.TMPDIR,
    controller = new AbortController();
  process.env.TMPDIR = owner;
  const a = await createPlan(first),
    b = await createPlan(second);
  const running = runProcess(a.source.root, a.plan.checks[0]!.commands[0]!, {
    timeoutMs: 120000,
    signal: controller.signal,
  });
  let sibling: ReturnType<typeof runProcess> | undefined;
  try {
    const observed = await reached(owner);
    witnesses.push({
      mode: "concurrent-cancel",
      phase: observed.phase,
      cpuNanoseconds: observed.cpuNanoseconds,
    });
    sibling = runProcess(b.source.root, b.plan.checks[0]!.commands[0]!, {
      timeoutMs: 120000,
    });
    controller.abort();
    const [cancelled, completed] = await Promise.all([running, sibling]);
    assert.equal(cancelled.cancelled, true);
    assert.equal(
      helmExtensionsEvidence(b.plan.checks[0]!, [completed], b.source.root)
        .status,
      "passed",
    );
    const p = helmExtensionsPacketSchema.parse(JSON.parse(completed.stdout));
    assert.notEqual(p.temporary, observed.temporary);
    await gone(observed.pid, observed.start);
    assert.deepEqual(await readdir(owner), []);
  } finally {
    controller.abort();
    await Promise.all([running, sibling]);
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(owner, { recursive: true, force: true });
  }
  if (process.env.CHECKTRAIL_HELM_EXTENSIONS_LIFECYCLE_RECEIPT)
    await writeFile(
      process.env.CHECKTRAIL_HELM_EXTENSIONS_LIFECYCLE_RECEIPT +
        (process.env.CHECKTRAIL_HELM_EXTENSIONS_INSTALLED === "1"
          ? ".installed"
          : ""),
      JSON.stringify({
        witnesses,
        helmSha256: helmBinarySha256,
        allProcessesGone: true,
        ownedDirectoriesRemoved: true,
      }) + "\n",
    );
});
