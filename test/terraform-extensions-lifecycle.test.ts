import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPlan } from "../src/engine.js";
import { runProcess } from "../src/runner.js";
import { terraformExtensionsEvidence } from "../src/terraform-extensions-evidence.js";
import { terraformExtensionsPacketSchema } from "../src/terraform-extensions-packet.js";
import { terraformExtensionsProvider as provider } from "../src/terraform-extensions-contract.js";
import { mavenHash } from "../src/maven.js";
import {
  terraformExtensionsFixture,
  terraformExtensionsNative as native,
  terraformExtensionsWriteConfig,
} from "./terraform-extensions-fixture.js";
async function reached(owner: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const id of await readdir("/proc")) {
      if (!/^[1-9][0-9]*$/.test(id)) continue;
      try {
        const executable = await readlink(`/proc/${id}/exe`);
        if (
          !executable.startsWith(owner + path.sep) ||
          !executable.endsWith("/" + provider.members[1]!.path)
        )
          continue;
        const workspace = await readlink(`/proc/${id}/cwd`);
        if (
          !workspace.startsWith(owner + path.sep) ||
          !workspace.endsWith("/native")
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
        const parent = stat[1]!,
          args = (await readFile(`/proc/${parent}/cmdline`, "utf8")).split(
            "\0",
          );
        if (
          !args.includes("-json") ||
          !(
            args.includes("validate") ||
            (args.includes("providers") && args.includes("schema"))
          )
        )
          continue;
        process.kill(Number(id), "SIGSTOP");
        assert.equal(
          mavenHash(await readFile(`/proc/${id}/exe`)),
          provider.members[1]!.sha256,
        );
        assert.equal(
          (await readFile(`/proc/${id}/stat`, "utf8"))
            .split(") ")[1]!
            .split(" ")[19],
          stat[19],
        );
        return {
          cpuNanoseconds,
          pid: Number(id),
          start: stat[19]!,
          workspace,
          temporary: path.dirname(workspace),
          phase: args.includes("validate") ? "validate" : "provider-schema",
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
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Actual pinned provider CPU execution was not observed");
}
async function gone(pid: number, start: string) {
  try {
    const stat = (await readFile(`/proc/${pid}/stat`, "utf8"))
      .split(") ")[1]!
      .split(" ");
    assert.notEqual(stat[19], start, "Observed provider survived cleanup");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
test("terraform-extensions lifecycle acceptance", native, async (t) => {
  const witnesses: { mode: string; phase: string; cpuNanoseconds: string }[] =
    [];
  for (const mode of [
    "cancel",
    "timeout",
    "output",
    "source",
    "copied-source",
    "module-metadata",
    "provider-member",
    "mirror",
    "cli-config",
  ]) {
    const { root, config } = await terraformExtensionsFixture(t);
    for (let i = 0; i < 40; i++)
      config.modules[2]!.resources["original_scale_" + i] = { min: 1, max: 5 };
    await terraformExtensionsWriteConfig(root, config);
    const owner = await mkdtemp(
        path.join(tmpdir(), "original-terraform-extension-reached-"),
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
    let observed: Awaited<ReturnType<typeof reached>> | undefined;
    try {
      observed = await reached(owner);
      witnesses.push({
        mode,
        phase: observed.phase,
        cpuNanoseconds: observed.cpuNanoseconds,
      });
      assert.ok(observed.pid > 1);
      assert.ok(observed.start.length > 0);
      if (mode === "cancel") controller.abort();
      else if (mode !== "timeout") {
        if (mode !== "output") {
          const file =
            mode === "source"
              ? path.join(root, "modules/leaf/main.tf")
              : mode === "copied-source"
                ? path.join(observed.workspace, "modules/leaf/main.tf")
                : mode === "module-metadata"
                  ? path.join(observed.temporary, "data/modules/modules.json")
                  : mode === "provider-member"
                    ? path.join(
                        observed.temporary,
                        "data/providers",
                        provider.address,
                        provider.version,
                        "linux_arm64/LICENSE.txt",
                      )
                    : mode === "mirror"
                      ? path.join(
                          observed.temporary,
                          "mirror",
                          provider.address,
                          provider.archive,
                        )
                      : path.join(observed.temporary, "home/terraform.tfrc");
          await writeFile(
            file,
            Buffer.concat([await readFile(file), Buffer.from("\n")]),
          );
        }
        process.kill(observed.pid, "SIGCONT");
      }
      const result = await running;
      assert.equal(
        terraformExtensionsEvidence(check, [result], source.root).status,
        "inconclusive",
        mode,
      );
      if (mode === "cancel") assert.equal(result.cancelled, true);
      if (mode === "timeout") assert.equal(result.timedOut, true);
      if (mode === "output")
        assert.equal(
          result.truncated,
          true,
          JSON.stringify({
            exit: result.exitCode,
            stderr: result.stderr,
            durationMs: result.durationMs,
            cancelled: result.cancelled,
            timedOut: result.timedOut,
          }),
        );
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
  // Cancelling one real provider leaves a concurrent validation alive.
  const first = await terraformExtensionsFixture(t),
    second = await terraformExtensionsFixture(t),
    owner = await mkdtemp(
      path.join(tmpdir(), "original-terraform-extension-siblings-"),
    ),
    previous = process.env.TMPDIR,
    controller = new AbortController();
  process.env.TMPDIR = owner;
  const a = await createPlan(first.root),
    b = await createPlan(second.root);
  const running = runProcess(a.source.root, a.plan.checks[0]!.commands[0]!, {
    timeoutMs: 120000,
    signal: controller.signal,
  });
  try {
    const observed = await reached(owner);
    witnesses.push({
      mode: "concurrent-cancel",
      phase: observed.phase,
      cpuNanoseconds: observed.cpuNanoseconds,
    });
    const sibling = runProcess(b.source.root, b.plan.checks[0]!.commands[0]!, {
      timeoutMs: 120000,
    });
    controller.abort();
    const [cancelled, completed] = await Promise.all([running, sibling]);
    assert.equal(cancelled.cancelled, true);
    assert.equal(
      terraformExtensionsEvidence(b.plan.checks[0]!, [completed], b.source.root)
        .status,
      "passed",
    );
    await gone(observed.pid, observed.start);
    const p = terraformExtensionsPacketSchema.parse(
      JSON.parse(completed.stdout),
    );
    assert.notEqual(p.temporary, observed.temporary);
    assert.deepEqual(await readdir(owner), []);
  } finally {
    controller.abort();
    await running;
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(owner, { recursive: true, force: true });
  }
  if (process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_LIFECYCLE_RECEIPT)
    await writeFile(
      process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_LIFECYCLE_RECEIPT +
        (process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_INSTALLED === "1"
          ? ".installed"
          : ""),
      JSON.stringify({
        witnesses,
        providerSha256: provider.members[1]!.sha256,
        allProcessesGone: true,
        ownedDirectoriesRemoved: true,
      }) + "\n",
    );
});
