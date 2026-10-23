import assert from "node:assert/strict";
import fs from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { nativeJournalAllowsParserPass } from "../src/native-journal-engine.js";
import { engineNativeJournalSchema } from "../src/native-journal-schema.js";
import { reportSchema } from "../src/schemas.js";
import type { Report } from "../src/types.js";
import { alive, stopped } from "./tasks-wire-fixture.js";
import {
  archiveFixture,
  archiveNativeWitness,
  archivePolicies,
} from "./attempt-whole-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const observationMs = process.platform === "win32" ? 35000 : 7000;
async function absent(file: string) {
  await assert.rejects(access(file), { code: "ENOENT" });
}
export async function archivePrerequisite(t: TestContext) {
  for (const kind of ["absent", "manifest", "entry", "runtime"] as const) {
    const d = await archiveFixture(t);
    if (kind === "absent") await rm(d.reference.path);
    if (kind === "manifest") await writeFile(d.reference.path, "{}\n");
    if (kind === "entry")
      await writeFile(
        d.adapter,
        "throw Error('Original unreachable replacement');\n",
      );
    if (kind === "runtime") {
      const changed = JSON.stringify({
        ...d.manifest,
        runtime: "original-unavailable-runtime",
      });
      await writeFile(d.reference.path, changed);
      const { archiveHash } = await import("./attempt-whole-fixture.js");
      d.reference.sha256 = archiveHash(changed);
    }
    await assert.rejects(
      createPlan(d.root, { externalAdapters: [d.reference] }),
    );
    await assert.rejects(
      validate(d.root, { ...d.options, externalAdapters: [d.reference] }),
    );
    await absent(d.ready);
  }
}
function assertSummary(summary: unknown, report?: Report) {
  const text = JSON.stringify(summary);
  for (const value of [
    "nativeJournal",
    "capturedOutput",
    "base64",
    "originalCases",
    archivePolicies.fixed,
    ...(report
      ? [
          report.sourceFingerprint,
          report.checks[0]!.processes[0]!.nativeJournal!.capture!.framesData
            .base64,
        ]
      : []),
  ])
    assert.equal(text.includes(value), false, value);
}
export async function archivePrivacy(t: TestContext) {
  const d = await archiveFixture(t),
    argument = d.reference.path + "#sha256=" + d.reference.sha256;
  const secretName = "CHECKTRAIL_ARCHIVE_SYNTHETIC_SECRET",
    original = process.env[secretName],
    secret = "original-archive-environment-canary";
  process.env[secretName] = secret;
  const clients: Client[] = [];
  let closeFailures: unknown[];
  try {
    await createPlan(d.root, { externalAdapters: [d.reference] });
    await assert.rejects(
      validate(d.root, { ...d.options, trusted: false }),
      /operator trust/,
    );
    const denied = spawnSync(
      process.execPath,
      [cli, "run", "--root", d.root, "--adapter", argument],
      { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1048576 },
    );
    assert.equal(denied.error, undefined);
    assert.equal(denied.status, 2, denied.stderr);
    await absent(d.ready);
    const selection = {
      schemaVersion: 5,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["decision.mjs"],
      supportFiles: [],
      topics: [],
    };
    async function connect(args: string[]) {
      const client = new Client(
        { name: "original-archive-host", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            d.root,
            "--adapter",
            argument,
            ...args,
          ],
          env: {
            ...Object.fromEntries(
              ["TMPDIR", "TMP", "TEMP"].flatMap((name) =>
                process.env[name] === undefined
                  ? []
                  : [[name, process.env[name]!]],
              ),
            ),
            [secretName]: secret,
          },
          stderr: "pipe",
        }),
      );
      return client;
    }
    const deniedClient = await connect([]);
    for (const args of [
      {},
      { trusted: true },
      { nativeJournalContext: d.reference },
      { allowExecution: true },
    ])
      assert.equal(
        (
          await deniedClient.callTool({
            name: "validation_run",
            arguments: args,
          })
        ).isError,
        true,
      );
    const context = await deniedClient.callTool({
      name: "review_context",
      arguments: selection,
    });
    assert.equal(context.isError, undefined);
    assert.equal(
      (context.structuredContent as { sourceIncluded: boolean }).sourceIncluded,
      false,
    );
    assertSummary(context.structuredContent);
    assert.equal(
      (
        await deniedClient.callTool({
          name: "review_context",
          arguments: { ...selection, allowSourceDisclosure: true },
        })
      ).isError,
      true,
    );
    await absent(d.ready);
    const local = await validate(d.root, d.options);
    assert.equal(local.outcome, "passed");
    archiveNativeWitness(local);
    assertSummary(projectReport(local, false), local);
    const detailed = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        d.root,
        "--adapter",
        argument,
        "--trust-project",
        "--detailed",
        "--timeout-ms",
        String(d.options.timeoutMs),
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(detailed.error, undefined);
    assert.equal(detailed.status, 0, detailed.stderr);
    const cliReport = reportSchema.parse(JSON.parse(detailed.stdout)) as Report;
    archiveNativeWitness(cliReport);
    assert.equal(detailed.stdout.includes(secret), false);
    const summarized = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        d.root,
        "--adapter",
        argument,
        "--trust-project",
        "--timeout-ms",
        String(d.options.timeoutMs),
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1048576 },
    );
    assert.equal(summarized.error, undefined);
    assert.equal(summarized.status, 0, summarized.stderr);
    const summary = JSON.parse(summarized.stdout);
    assert.equal(summary.outcome, "passed");
    assertSummary(summary);
    const enabled = await connect(["--allow-execution", "--detailed"]);
    const response = await enabled.callTool({
      name: "validation_run",
      arguments: { timeoutMs: d.options.timeoutMs },
    });
    assert.equal(response.isError, undefined);
    const mcpReport = reportSchema.parse(response.structuredContent) as Report;
    archiveNativeWitness(mcpReport);
    assert.equal(JSON.stringify(response).includes(secret), false);
    const withheld = await enabled.callTool({
      name: "review_context",
      arguments: selection,
    });
    assert.equal(withheld.isError, undefined);
    assert.equal(
      (withheld.structuredContent as { sourceIncluded: boolean })
        .sourceIncluded,
      false,
    );
    const sourceEnabled = await connect([
      "--detailed",
      "--allow-review-source",
    ]);
    const granted = await sourceEnabled.callTool({
      name: "review_context",
      arguments: selection,
    });
    assert.equal(granted.isError, undefined);
    assert.deepEqual(
      (
        granted.structuredContent as { files: Array<{ content: string }> }
      ).files.map((file) => file.content),
      [archivePolicies.fixed],
    );
    assert.equal(
      JSON.stringify(granted.structuredContent).includes(secret),
      false,
    );
  } finally {
    const closures = await Promise.allSettled(clients.map((c) => c.close()));
    if (original === undefined) delete process.env[secretName];
    else process.env[secretName] = original;
    closeFailures = closures
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
  }
  if (closeFailures.length)
    throw new AggregateError(
      closeFailures,
      "Archive MCP fixture cleanup failed",
    );
}
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const until = performance.now() + observationMs;
  while (performance.now() < until) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw Error("Original native archive readiness was not reached");
}
export async function archiveLifecycle(t: TestContext) {
  for (const mode of ["cancel", "timeout", "output"] as const) {
    const d = await archiveFixture(t, "fixed", {
      hold: true,
      child: true,
      prefix: true,
      flood: mode === "output",
    });
    const directories: string[] = [],
      original = fs.mkdtempSync;
    // Observe actual engine-created namespaces without replacing any file or process result.
    const observer = t.mock.method(fs, "mkdtempSync", (...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args);
      if (String(args[0]).includes("checktrail-native-attempt-"))
        directories.push(fs.realpathSync(result));
      return result;
    });
    syncBuiltinESMExports();
    const controller = new AbortController(),
      sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
      }),
      siblingExit = once(sibling, "exit");
    const running = validate(d.root, {
      ...d.options,
      timeoutMs:
        mode === "timeout"
          ? process.platform === "win32"
            ? 45000
            : 10000
          : d.options.timeoutMs,
      signal: controller.signal,
    });
    let pids: { pid: number; child: number; group: number } | undefined;
    try {
      const ready = await waitFor(async () => {
        try {
          return JSON.parse(await readFile(d.ready, "utf8")) as {
            pid: number;
            child: number;
          };
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" &&
            !(error instanceof SyntaxError)
          )
            throw error;
        }
      });
      pids = { ...ready, group: 0 };
      assert.ok(ready.pid > 1 && ready.child > 1 && ready.child !== ready.pid);
      assert.equal(await alive(ready.pid), true);
      assert.equal(await alive(ready.child), true);
      const directory = await waitFor(async () => {
        for (const directory of directories) {
          const frames = await readFile(
            path.join(directory, "frames.jsonl"),
            "utf8",
          );
          if (frames.includes('"type":"output"')) return directory;
        }
      });
      if (mode === "cancel") controller.abort();
      if (mode === "output") await writeFile(d.release, "Original release.\n");
      const report = await running;
      reportSchema.parse(report);
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.sourceChanged, false);
      assert.equal(report.checks.length, 1);
      const body = report.checks[0]!.processes[0]!,
        journal = body.nativeJournal!;
      engineNativeJournalSchema.parse(journal);
      assert.equal(body.cancelled, mode === "cancel");
      assert.equal(body.timedOut, mode === "timeout");
      assert.equal(nativeJournalAllowsParserPass(journal), false);
      const capture = journal.capture!;
      assert.equal(capture.replay!.attempts.length, 1);
      const attempt = capture.replay!.attempts[0]!;
      assert.equal(attempt.pid, ready.pid);
      assert.notEqual(attempt.state, "exited");
      const prefix = Buffer.from(attempt.capturedOutput.stdout.base64, "base64")
        .toString("utf8")
        .split("\n")[0]!;
      const observed = JSON.parse(prefix);
      assert.equal(observed.pid, ready.pid);
      assert.deepEqual(observed.originalPrefix, [
        {
          consumer: "first.mjs",
          exact: { visible: true },
          adjacent: { visible: false },
        },
        {
          consumer: "second.mjs",
          exact: { state: "ready" },
          adjacent: { state: "blocked" },
        },
      ]);
      if (mode === "output") {
        assert.ok(attempt.capturedOutput.stdout.bytes > 0);
        assert.ok(
          attempt.state === "output-limit" ||
            attempt.state === "transport-error",
        );
      } else {
        assert.equal(capture.state, "incomplete");
        assert.equal(attempt.exitCode, null);
      }
      await stopped(pids);
      await absent(directory);
      assert.equal(
        await alive(sibling.pid!),
        true,
        "An unrelated sibling must survive owned-tree cleanup",
      );
    } finally {
      controller.abort();
      await Promise.allSettled([running]);
      observer.mock.restore();
      syncBuiltinESMExports();
      sibling.kill();
      await siblingExit;
      if (pids) await stopped(pids);
    }
  }
}
