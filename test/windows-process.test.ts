import { diagnose } from "../src/onboarding.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { windowsReceiptSchema } from "../src/windows-execution.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  windowsEnvironment,
  resolveWindowsExecutable,
} from "../src/windows-process.js";
import { runProcess } from "../src/runner.js";
import { validate } from "../src/engine.js";
import { reportSummarySchema } from "../src/schemas.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
const native = { skip: process.platform !== "win32" };
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const command = (source: string, args: string[] = []) => ({
  executable: process.execPath,
  args: ["-e", source, ...args],
  cwd: ".",
});
async function waitFor<T>(
  read: () => Promise<T | null>,
  timeout = 10000,
): Promise<T> {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const result = await read();
    if (result !== null) return result;
    await delay(25);
  }
  throw new Error("Native fixture did not reach its declared condition");
}
async function jsonFile(
  file: string,
): Promise<{ root: number; a: number; b: number; temp: string } | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

test(
  "native Windows runs literal hostile arguments Unicode environment and exit status with confirmed job cleanup",
  native,
  async (t) => {
    const root = await fixture(t, {});
    const args = [
      "",
      "quoted value",
      'a"b',
      "a\\",
      'a\\"b',
      "& echo forbidden",
      "%PATH%",
      "!canary!",
      "$(forbidden)",
      "é😀",
      "line\nbreak",
      "\tvalue",
    ];
    const previous = process.env.CHECKTRAIL_SYNTHETIC_SECRET;
    process.env.CHECKTRAIL_SYNTHETIC_SECRET = "not-for-child";
    try {
      const result = await runProcess(
        root,
        {
          ...command(
            "process.stdout.write(JSON.stringify({args:process.argv.slice(1),secret:process.env.CHECKTRAIL_SYNTHETIC_SECRET??null,allowed:process.env.CHECKTRAIL_ALLOWED,systemRoot:process.env.SystemRoot??process.env.SYSTEMROOT}));process.stderr.write('é😀');",
            args,
          ),
          env: { CHECKTRAIL_ALLOWED: "original" },
        },
        { timeoutMs: 10000 },
      );
      assert.equal(result.errorCode, undefined);
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.deepEqual(JSON.parse(result.stdout), {
        args,
        secret: null,
        allowed: "original",
        systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      });
      assert.equal(result.stderr, "é😀");
      assert.equal(result.outputBytes, Buffer.byteLength(result.stdout) + 6);
      assert.equal(result.windowsExecution!.jobAssigned, true);
      assert.equal(result.windowsExecution!.resumed, true);
      assert.equal(result.windowsExecution!.cleanup, "confirmed");
      assert.equal(result.windowsExecution!.activeAfterCleanup, 0);
      assert.equal(result.windowsExecution!.executionSandboxed, false);
      const failed = await runProcess(root, command("process.exit(17)"), {
        timeoutMs: 10000,
      });
      assert.equal(failed.errorCode, undefined);
      assert.equal(failed.exitCode, 17);
      assert.equal(failed.windowsExecution!.childExitCode, 17);
    } finally {
      if (previous === undefined)
        delete process.env.CHECKTRAIL_SYNTHETIC_SECRET;
      else process.env.CHECKTRAIL_SYNTHETIC_SECRET = previous;
    }
  },
);
test(
  "native Windows resolves exact executable paths spaces missing tools ambiguous PATH and refused wrappers without execution",
  native,
  async (t) => {
    const root = await fixture(t, {
      "tools with spaces/wrapper.cmd": "@echo forbidden",
    });
    const bin = path.join(root, "tools with spaces");
    await copyFile(process.execPath, path.join(bin, "probe.exe"));
    const env = windowsEnvironment(process.env);
    assert.equal(
      await resolveWindowsExecutable(path.join(bin, "probe.exe"), root, env),
      await import("node:fs/promises").then((fs) =>
        fs.realpath(path.join(bin, "probe.exe")),
      ),
    );
    assert.equal(
      await resolveWindowsExecutable(path.join(bin, "probe"), root, env),
      await resolveWindowsExecutable(path.join(bin, "probe.exe"), root, env),
    );
    const literal = await runProcess(
      root,
      {
        executable: path.join(bin, "probe.exe"),
        args: ["-e", "process.stdout.write('space-path')"],
        cwd: ".",
      },
      { timeoutMs: 10000 },
    );
    assert.equal(literal.errorCode, undefined);
    assert.equal(literal.stdout, "space-path");
    assert.equal(literal.exitCode, 0);
    const other = path.join(root, "second");
    await mkdir(other);
    await copyFile(process.execPath, path.join(other, "probe.exe"));
    await assert.rejects(
      resolveWindowsExecutable("probe", root, { PATH: bin + ";" + other }),
      /AMBIGUOUS_WINDOWS_EXECUTABLE/,
    );
    const ambiguous = await runProcess(
      root,
      { executable: "probe", args: [], cwd: "." },
      { timeoutMs: 10000, environment: { PATH: bin + ";" + other } },
    );
    assert.equal(ambiguous.errorCode, "AMBIGUOUS_WINDOWS_EXECUTABLE");
    assert.equal(ambiguous.windowsExecution, undefined);
    const wrapper = await runProcess(
      root,
      { executable: path.join(bin, "wrapper.cmd"), args: [], cwd: "." },
      { timeoutMs: 10000 },
    );
    assert.equal(wrapper.errorCode, "WINDOWS_SCRIPT_WRAPPER_UNSUPPORTED");
    assert.equal(wrapper.exitCode, null);
    assert.equal(wrapper.windowsExecution, undefined);
    const missing = await runProcess(
      root,
      { executable: "checktrail-missing-original-tool", args: [], cwd: "." },
      { timeoutMs: 10000 },
    );
    assert.equal(missing.errorCode, "ENOENT");
    assert.equal(missing.windowsExecution, undefined);
    const protectedRoot = await runProcess(
      root,
      {
        ...command("throw new Error('must-not-execute')"),
        env: { systemroot: root },
      },
      { timeoutMs: 10000 },
    );
    assert.equal(protectedRoot.errorCode, "PROTECTED_WINDOWS_ENVIRONMENT");
    assert.equal(protectedRoot.windowsExecution, undefined);
    await assert.rejects(
      resolveWindowsExecutable("C:ambiguous", root, env),
      /INVALID_WINDOWS_EXECUTABLE/,
    );
  },
);
test(
  "native Windows cancellation kills multiple detached descendants preserves an unrelated sibling and removes owned temporary files",
  native,
  async (t) => {
    const root = await fixture(t, {}),
      ids = path.join(root, "started.json"),
      token = randomUUID();
    const leaf = "setInterval(()=>{},1000)";
    const source =
      "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const children=[0,1].map(()=>spawn(process.execPath,['-e'," +
      JSON.stringify(leaf) +
      ",'--'," +
      JSON.stringify(token) +
      "],{detached:true,stdio:'ignore'}));writeFileSync(process.argv[1],JSON.stringify({root:process.pid,a:children[0].pid,b:children[1].pid,temp:process.env.CHECKTRAIL_TEMP}));setInterval(()=>{},1000);";
    const unrelated = spawn(process.execPath, ["-e", leaf, "--", token], {
      stdio: "ignore",
    });
    const controller = new AbortController();
    const running = runProcess(
      root,
      { ...command(source, [ids]), temporaryDirectory: true },
      { timeoutMs: 15000, signal: controller.signal },
    );
    let observed: { root: number; a: number; b: number; temp: string } | null =
      null;
    try {
      observed = await waitFor(() => jsonFile(ids));
      assert.notEqual(observed.a, observed.b);
      assert.ok(alive(observed.a!) && alive(observed.b!));
      controller.abort();
      const result = await running;
      assert.equal(result.cancelled, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.errorCode, undefined);
      assert.equal(result.windowsExecution!.cleanup, "confirmed");
      assert.ok(result.windowsExecution!.activeBeforeCleanup! >= 3);
      assert.equal(result.windowsExecution!.activeAfterCleanup, 0);
      await waitFor(
        async () =>
          ![observed!.root!, observed!.a!, observed!.b!].some(alive)
            ? true
            : null,
        3000,
      );
      assert.equal(alive(unrelated.pid!), true);
      await assert.rejects(
        lstat(observed.temp),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    } finally {
      controller.abort();
      await running;
      if (unrelated.exitCode === null) unrelated.kill("SIGKILL");
      if (observed)
        for (const pid of [observed.root!, observed.a!, observed.b!])
          if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  },
);
test(
  "native Windows deadlines output zero exact overrun and preaborted calls cannot become successful validation",
  native,
  async (t) => {
    const root = await fixture(t, {});
    const timed = await runProcess(root, command("setInterval(()=>{},1000)"), {
      timeoutMs: 5000,
    });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.errorCode, undefined);
    assert.equal(timed.windowsExecution!.cleanup, "confirmed");
    assert.ok(timed.durationMs < 8500);
    const exact = await runProcess(
      root,
      command("process.stdout.write('a');process.stderr.write('b');"),
      { timeoutMs: 10000, maxOutputBytes: 2 },
    );
    assert.equal(exact.exitCode, 0);
    assert.equal(exact.truncated, false);
    assert.equal(exact.outputBytes, 2);
    assert.equal(exact.stdout, "a");
    assert.equal(exact.stderr, "b");
    const empty = await runProcess(root, command("process.exit(0)"), {
      timeoutMs: 10000,
      maxOutputBytes: 0,
    });
    assert.equal(empty.exitCode, 0);
    assert.equal(empty.truncated, false);
    assert.equal(empty.outputBytes, 0);
    for (const maximum of [0, 1]) {
      const over = await runProcess(
        root,
        command(
          "process.stdout.write('é'.repeat(4096));setInterval(()=>{},1000);",
        ),
        { timeoutMs: 10000, maxOutputBytes: maximum },
      );
      assert.equal(over.truncated, true);
      assert.ok(over.outputBytes > maximum);
      assert.notEqual(over.exitCode, 0);
      assert.equal(over.errorCode, undefined);
      assert.equal(over.windowsExecution!.cleanup, "confirmed");
      assert.equal(Buffer.byteLength(over.stdout), maximum === 0 ? 0 : 3);
    }
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runProcess(
      root,
      command("throw new Error('must-not-run')"),
      { timeoutMs: 10000, signal: controller.signal },
    );
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.exitCode, null);
    assert.equal(cancelled.windowsExecution, undefined);
  },
);
test(
  "native Windows shared engine CLI and MCP preserve failing skipped and trusted Node validation accounting",
  native,
  async (t) => {
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "test/subject.test.js": passingTest,
    });
    assert.ok(
      (await diagnose(root)).issues.some(
        (issue) => issue.code === "limited-platform-support",
      ),
    );
    for (const [source, outcome, passed, failed, skipped] of [
      [passingTest, "passed", 1, 0, 0],
      [
        "require('node:test').test('original broken',()=>{throw new Error('original defect')})",
        "failed",
        0,
        1,
        0,
      ],
      [
        "require('node:test').test.skip('original skipped',()=>{})",
        "incomplete",
        0,
        0,
        1,
      ],
    ] as const) {
      const content = source.startsWith("require(")
        ? "import { createRequire } from 'node:module';const require=createRequire(import.meta.url);" +
          source
        : source;
      await writeFile(path.join(root, "test/subject.test.js"), content);
      const library = await validate(root, {
        trusted: true,
        timeoutMs: 15000,
      });
      assert.equal(library.outcome, outcome);
      assert.deepEqual(library.checks[0]!.tests, {
        total: 1,
        passed,
        failed,
        skipped,
      });
      assert.equal(
        library.checks[0]!.processes[0]!.windowsExecution!.cleanup,
        "confirmed",
      );
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          "--trust-project",
          "--timeout-ms",
          "15000",
        ],
        { encoding: "utf8", timeout: 25000 },
      );
      assert.equal(
        result.status,
        outcome === "passed" ? 0 : outcome === "failed" ? 1 : 2,
        result.stderr,
      );
      assert.equal(JSON.parse(result.stdout).outcome, outcome);
      const client = new Client({
        name: "OriginalWindowsOutcomeClient",
        version: "1",
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root, "--allow-execution"],
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const tool = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        assert.equal(tool.isError, undefined);
        const summary = reportSummarySchema.parse(tool.structuredContent);
        assert.equal(summary.outcome, outcome);
        assert.deepEqual(summary.checks[0]!.tests, {
          total: 1,
          passed,
          failed,
          skipped,
        });
      } finally {
        await client.close();
      }
    }
    await writeFile(path.join(root, "test/subject.test.js"), passingTest);
    for (const trusted of [false, true]) {
      const client = new Client({
        name: "OriginalWindowsLifecycleClient",
        version: "1",
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          cli,
          "serve",
          "--root",
          root,
          ...(trusted ? ["--allow-execution"] : []),
        ],
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        if (trusted) {
          assert.equal(result.isError, undefined);
          assert.equal(
            reportSummarySchema.parse(result.structuredContent).outcome,
            "passed",
          );
        } else assert.equal(result.isError, true);
        const denied = await client.callTool({
          name: "validation_run",
          arguments: { trustProject: true },
        });
        assert.equal(denied.isError, true);
      } finally {
        await client.close();
      }
    }
  },
);

const treeSource = `
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const children=[0,1].map(()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'}));
fs.writeFileSync(process.argv[1],JSON.stringify({root:process.pid,a:children[0].pid,b:children[1].pid,temp:process.env.CHECKTRAIL_TEMP}));
const interval=setInterval(()=>{if(process.argv[2] && fs.existsSync(process.argv[2])){clearInterval(interval);process.exit(0)}},25);
`;
async function treeReceipt(state: { root: number; temp: string }) {
  const file = path.join(path.dirname(state.temp), "receipt.json");
  return waitFor(async () => {
    try {
      const receipt = windowsReceiptSchema.parse(
        JSON.parse(await readFile(file, "utf8")),
      );
      return receipt.phase === "running" && receipt.childPid === state.root
        ? receipt
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
}
function cleanupTree(state: { root: number; a: number; b: number } | null) {
  if (state)
    for (const pid of [state.root, state.a, state.b])
      if (alive(pid)) process.kill(pid, "SIGKILL");
}
test(
  "native Windows normal root exit closes detached descendants and inherited output pipes before returning",
  native,
  async (t) => {
    const root = await fixture(t, {}),
      ids = path.join(root, "tree.json"),
      release = path.join(root, "release");
    const controller = new AbortController();
    const running = runProcess(
      root,
      { ...command(treeSource, [ids, release]), temporaryDirectory: true },
      { timeoutMs: 15000, signal: controller.signal },
    );
    let state: Awaited<ReturnType<typeof jsonFile>> = null;
    try {
      state = await waitFor(() => jsonFile(ids));
      await treeReceipt(state);
      assert.ok(alive(state.a) && alive(state.b));
      await writeFile(release, "original control");
      const result = await running;
      assert.equal(result.exitCode, 0);
      assert.equal(result.errorCode, undefined);
      assert.equal(result.timedOut, false);
      assert.equal(result.windowsExecution!.activeAfterCleanup, 0);
      assert.ok(result.windowsExecution!.activeBeforeCleanup! >= 2);
      await waitFor(
        async () =>
          [state!.root, state!.a, state!.b].some(alive) ? null : true,
        3000,
      );
      await assert.rejects(lstat(state.temp), { code: "ENOENT" });
    } finally {
      controller.abort();
      await running;
      cleanupTree(state);
    }
  },
);
test(
  "native Windows parent loss closes the private control pipe job termination and owned temporary directory cleanup",
  native,
  async (t) => {
    const root = await fixture(t, {}),
      ids = path.join(root, "tree.json");
    const runner = pathToFileURL(
      fileURLToPath(new URL("../src/runner.js", import.meta.url)),
    ).href;
    const source = `import {runProcess} from ${JSON.stringify(runner)};await runProcess(${JSON.stringify(root)},${JSON.stringify({ ...command(treeSource, [ids]), temporaryDirectory: true })},{timeoutMs:30000});`;
    const driver = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    driver.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(driver, "close");
    let state: Awaited<ReturnType<typeof jsonFile>> = null;
    try {
      state = await waitFor(() => jsonFile(ids));
      const receipt = await treeReceipt(state);
      assert.ok(alive(receipt.supervisorPid));
      assert.ok(alive(state.a) && alive(state.b));
      driver.kill("SIGKILL");
      await closed;
      await waitFor(
        async () =>
          [receipt.supervisorPid, state!.root, state!.a, state!.b].some(alive)
            ? null
            : true,
        5000,
      );
      await assert.rejects(lstat(path.dirname(state.temp)), { code: "ENOENT" });
      assert.equal(stderr, "");
    } finally {
      if (driver.exitCode === null) driver.kill("SIGKILL");
      await closed;
      cleanupTree(state);
    }
  },
);
test(
  "native Windows guardian crash kills the assigned job but cannot manufacture a completed execution receipt",
  native,
  async (t) => {
    const root = await fixture(t, {}),
      ids = path.join(root, "tree.json");
    const controller = new AbortController();
    const running = runProcess(
      root,
      { ...command(treeSource, [ids]), temporaryDirectory: true },
      { timeoutMs: 15000, signal: controller.signal },
    );
    let state: Awaited<ReturnType<typeof jsonFile>> = null;
    try {
      state = await waitFor(() => jsonFile(ids));
      const receipt = await treeReceipt(state);
      assert.ok(alive(state.a) && alive(state.b));
      process.kill(receipt.supervisorPid, "SIGKILL");
      const result = await running;
      assert.equal(result.errorCode, "PROCESS_TREE_CLEANUP_UNAVAILABLE");
      assert.equal(result.exitCode, null);
      assert.equal(result.windowsExecution!.phase, "running");
      assert.equal(result.windowsExecution!.cleanup, "unavailable");
      await assert.doesNotReject(
        waitFor(
          async () =>
            [state!.root, state!.a, state!.b].some(alive) ? null : true,
          3000,
        ),
        "Owned descendants survived guardian crash",
      );
      await assert.rejects(lstat(path.dirname(state.temp)), { code: "ENOENT" });
    } finally {
      controller.abort();
      await running;
      cleanupTree(state);
    }
  },
);
