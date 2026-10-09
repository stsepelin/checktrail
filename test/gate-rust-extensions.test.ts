import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { projectReport } from "../src/output.js";
import { runProcess } from "../src/runner.js";
import {
  rustAtomic,
  rustOriginal,
  rustReceipt,
  rustExtra,
  rustWaitingSource,
  rustExtensionsSkip as skip,
  type RustNative,
} from "./rust-extensions-fixture.js";
test(
  "rust-extensions broken acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await rustOriginal(t);
    const report = await validate(f.root, { trusted: true });
    assert.equal(report.outcome, "failed");
    const lean = report.checks.find(
      (c) => c.id === "rust.cargo-test" && c.rustBuild?.profile === "lean",
    )!;
    const extra = report.checks.find(
      (c) => c.id === "rust.cargo-test" && c.rustBuild?.profile === "extra",
    )!;
    assert.equal(lean.status, "passed");
    assert.deepEqual(lean.tests, {
      total: 6,
      passed: 6,
      failed: 0,
      skipped: 0,
    });
    assert.equal(extra.status, "failed");
    assert.equal(extra.findingsComplete, true);
    assert.deepEqual(extra.tests, {
      total: 7,
      passed: 6,
      failed: 1,
      skipped: 0,
    });
    assert.match(
      rustReceipt(extra)
        .tests!.groups.map((g) => g.execution?.stdout)
        .join("\n"),
      /identifier_boundary.*FAILED/s,
    );
    const compiled = await rustOriginal(t, {
      checks: ["rust.cargo-check"],
      fixed: true,
    });
    await rustAtomic(
      path.join(compiled.root, "a/src/extra.rs"),
      "pub fn value()->i32 { false }\n",
    );
    const failed = await validate(compiled.root, { trusted: true });
    assert.equal(failed.outcome, "failed");
    const wasm = failed.checks.find(
      (c) => c.rustBuild?.profile === "wasm-extra",
    )!;
    assert.equal(wasm.status, "failed");
    assert.ok(
      wasm.findings?.some(
        (f) => f.ruleId === "rustc/E0308" && f.file === "a/src/extra.rs",
      ),
    );
    assert.equal(wasm.tests, undefined);
  },
);
test(
  "rust-extensions fixed acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await rustOriginal(t, { fixed: true });
    const report = await validate(f.root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks.length, 8);
    assert.equal(new Set(report.checks.map((c) => c.executionId)).size, 8);
    assert.deepEqual(
      report.checks.filter((c) => c.tests).map((c) => c.tests),
      [
        { total: 6, passed: 6, failed: 0, skipped: 0 },
        { total: 7, passed: 7, failed: 0, skipped: 0 },
      ],
    );
    for (const c of report.checks) {
      const r = rustReceipt(c);
      assert.ok(r.depInfoCount > 0);
      assert.equal(r.scopeError, false);
      assert.ok(r.observedSources.includes("b/src/lib.rs"));
      assert.equal(c.findingsComplete, true);
      if (c.rustBuild?.target === "wasm32-unknown-unknown") {
        assert.equal(c.tests, undefined);
        assert.match(r.execution.stdout, /wasm32-unknown-unknown/);
      }
    }
    assert.equal(
      await readFile(path.join(f.root, "target/preserve"), "utf8"),
      "keep",
    );
  },
);
test(
  "rust-extensions near-miss acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await rustOriginal(t, { fixed: true });
    await rustAtomic(
      path.join(f.root, "a/src/extra.rs"),
      rustExtra(true).replace(
        'value=="grant" || value.starts_with("grant:")',
        'matches!(value,"grant" | "grant:read")',
      ),
    );
    assert.equal((await validate(f.root, { trusted: true })).outcome, "passed");
    f.policy.profiles = f.policy.profiles.slice(1, 2).map((p) => ({
      ...p,
      target: "wasm32-unknown-unknown",
      checks: ["rust.cargo-test"],
    }));
    await rustAtomic(
      path.join(f.root, "checktrail.rust-build.json"),
      JSON.stringify(f.policy),
    );
    await rustAtomic(
      path.join(f.root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["rust.cargo-test"] }],
      }),
    );
    const foreign = await validate(f.root, { trusted: true });
    assert.equal(foreign.checks[0]!.status, "unavailable");
    assert.equal(foreign.checks[0]!.tests, undefined);
  },
);
test(
  "rust-extensions prerequisite acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await rustOriginal(t, {
      fixed: true,
      checks: ["rust.cargo-check"],
    });
    await writeFile(
      path.join(f.root, "a/build.rs"),
      'fn main(){std::fs::write(".checktrail/imported","executed").unwrap();}\n',
    );
    for (const target of ["x86_64-pc-windows-msvc"]) {
      f.policy.profiles = f.policy.profiles.map((p) => ({ ...p, target }));
      await rustAtomic(
        path.join(f.root, "checktrail.rust-build.json"),
        JSON.stringify(f.policy),
      );
      const r = await validate(f.root, { trusted: true });
      assert.ok(r.checks.every((c) => c.status === "unavailable"));
      await assert.rejects(access(path.join(f.root, "a/.checktrail/imported")));
    }
    const guarded = await rustOriginal(t, {
      fixed: true,
      checks: ["rust.cargo-check"],
      foreign: false,
    });
    guarded.policy.profiles = guarded.policy.profiles.slice(1);
    await rustAtomic(
      path.join(guarded.root, "checktrail.rust-build.json"),
      JSON.stringify(guarded.policy),
    );
    await writeFile(
      path.join(guarded.root, "a/build.rs"),
      'fn main(){std::fs::write(".checktrail/imported","executed").unwrap();}\n',
    );
    const native = spawnSync("/bin/sh", ["-c", "command -v cargo"], {
      encoding: "utf8",
    });
    assert.equal(native.status, 0);
    const cargo = native.stdout.trim();
    assert.ok(path.isAbsolute(cargo));
    const overrides = path.join(guarded.root, ".checktrail/overrides");
    await mkdir(overrides, { recursive: true });
    await writeFile(
      path.join(overrides, "cargo"),
      "#!/bin/sh\nexec " + JSON.stringify(cargo) + ' "$@"\n',
    );
    await chmod(path.join(overrides, "cargo"), 0o700);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = overrides + path.delimiter + (originalPath ?? "");
      const report = await validate(guarded.root, { trusted: true });
      await assert.rejects(
        access(path.join(guarded.root, "a/.checktrail/imported")),
        { code: "ENOENT" },
        "Changed native executable must fail before workspace build scripts run",
      );
      assert.equal(report.checks[0]!.status, "unavailable");
      assert.match(report.checks[0]!.processes[0]!.stdout, /native-toolchain/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  },
);
test(
  "rust-extensions stale acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await rustOriginal(t, {
      fixed: true,
      checks: ["rust.cargo-check"],
    });
    const check = (await createPlan(f.root)).plan.checks.find(
      (c) => c.rustBuild?.profile === "extra",
    )!;
    const report = await validate(f.root, { trusted: true });
    const process = report.checks.find((c) => c.rustBuild?.profile === "extra")!
      .processes[0]!;
    for (const mutate of [
      (r: RustNative) => {
        r.selection.features = [];
      },
      (r: RustNative) => {
        r.metadata.resolve.nodes[0]!.features = [];
      },
      (r: RustNative) => {
        r.execution.stdout = r.execution.stdout
          .split("\n")
          .filter(Boolean)
          .map((s) => {
            const e = JSON.parse(s);
            if (e.reason === "compiler-artifact")
              e.features = ["invented-feature"];
            return JSON.stringify(e);
          })
          .join("\n");
      },
      (r: RustNative) => {
        r.execution.stdout = r.execution.stdout
          .split("\n")
          .filter(Boolean)
          .map((s) => {
            const e = JSON.parse(s);
            if (
              e.reason === "compiler-artifact" &&
              !e.target.kind.some(
                (k: string) => k === "custom-build" || k === "proc-macro",
              )
            )
              e.filenames = [
                path.join(
                  r.metadata.target_directory,
                  "unselected-target",
                  "artifact.rlib",
                ),
              ];
            return JSON.stringify(e);
          })
          .join("\n");
      },
      (r: RustNative) => {
        r.depInfoCount = 0;
      },
      (r: RustNative) => {
        r.inputsStable = false;
      },
      (r: RustNative) => {
        r.nativeToolchainVerified = false;
      },
      (r: RustNative) => {
        r.sourceFingerprint = "0".repeat(64);
      },
      (r: RustNative) => {
        r.observedSources.pop();
      },
      (r: RustNative) => {
        r.execution.stdout = r.execution.stdout
          .split("\n")
          .filter(Boolean)
          .map((s: string) => {
            const e: { reason: string; fresh?: boolean } = JSON.parse(s);
            if (e.reason === "compiler-artifact") e.fresh = true;
            return JSON.stringify(e);
          })
          .join("\n");
      },
    ]) {
      const r = JSON.parse(process.stdout);
      mutate(r);
      assert.equal(
        evaluate(check, [{ ...process, stdout: JSON.stringify(r) }], f.root)
          .status,
        "inconclusive",
      );
    }
    assert.equal(
      evaluate({ ...check, id: "rust.other" }, [process], f.root).status,
      "inconclusive",
    );
    await rustAtomic(
      path.join(f.root, "a/src/extra.rs"),
      rustExtra(true) + "// changed original source\n",
    );
    const stale = await runProcess(f.root, check.commands[0]!, {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
    });
    assert.equal(stale.exitCode, 3);
    assert.equal(evaluate(check, [stale], f.root).status, "unavailable");
  },
);
test(
  "rust-extensions empty acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await rustOriginal(t, {
      fixed: true,
      checks: ["rust.cargo-test"],
      foreign: false,
    });
    const check = (await createPlan(f.root)).plan.checks[1]!;
    const report = await validate(f.root, { trusted: true });
    const execution = report.checks[1]!.processes[0]!;
    for (const stdout of [
      "",
      "{}",
      "null",
      execution.stdout + execution.stdout,
    ])
      assert.equal(
        evaluate(check, [{ ...execution, stdout }], f.root).status,
        "inconclusive",
      );
    assert.equal(evaluate(check, [], f.root).status, "inconclusive");
    for (const modify of [
      (r: RustNative) => {
        r.tests!.groups = [];
      },
      (r: RustNative) => {
        r.tests!.groups[0]!.listed!.stdout = "0 tests, 0 benchmarks\n";
      },
      (r: RustNative) => {
        r.documentation = null;
      },
      (r: RustNative) => {
        r.scopeError = true;
      },
      (r: RustNative) => {
        r.depInfoCount = 0;
      },
      (r: RustNative) => {
        r.execution.stdout = "";
      },
    ]) {
      const r = JSON.parse(execution.stdout);
      modify(r);
      assert.equal(
        evaluate(check, [{ ...execution, stdout: JSON.stringify(r) }], f.root)
          .status,
        "inconclusive",
      );
    }
    await rustAtomic(
      path.join(f.root, "a/src/lib.rs"),
      (await readFile(path.join(f.root, "a/src/lib.rs"), "utf8")).replace(
        "#[test] fn identifier_boundary",
        "#[test] #[ignore] fn identifier_boundary",
      ),
    );
    const ignored = await validate(f.root, { trusted: true });
    assert.equal(ignored.outcome, "incomplete");
    assert.ok(ignored.checks.every((c) => c.status === "inconclusive"));
    assert.ok(ignored.checks.every((c) => c.tests!.skipped === 1));
  },
);
test(
  "rust-extensions privacy acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await rustOriginal(t, {
      fixed: true,
      checks: ["rust.cargo-test"],
      foreign: false,
    });
    f.policy.profiles = f.policy.profiles.slice(1);
    await rustAtomic(
      path.join(f.root, "checktrail.rust-build.json"),
      JSON.stringify(f.policy),
    );
    const report = await validate(f.root, { trusted: true });
    assert.equal(report.outcome, "passed");
    assert.equal(
      JSON.stringify(projectReport(report, false)).includes(f.root),
      false,
    );
    assert.equal(
      JSON.stringify(projectReport(report, true)).includes(f.root),
      true,
    );
    await assert.rejects(
      validate(f.root, { trusted: false }),
      /operator trust/,
    );
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap(
        (k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]),
      ),
    );
    for (const detailed of [false, true]) {
      const args = ["--root", f.root, ...(detailed ? ["--detailed"] : [])];
      const child = spawnSync(
        process.execPath,
        [cli, "run", ...args, "--trust-project"],
        { env, encoding: "utf8", timeout: 60000 },
      );
      assert.equal(child.status, 0, child.stderr);
      const answer = JSON.parse(child.stdout);
      assert.equal(answer.outcome, "passed");
      assert.equal(JSON.stringify(answer).includes(f.root), detailed);
      const client = new Client(
        { name: "original-rust-extensions", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [cli, "serve", ...args, "--allow-execution"],
            env,
            stderr: "pipe",
          }),
        );
        const result = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        assert.equal(result.isError, undefined);
        assert.equal(
          (result.structuredContent as { outcome: string }).outcome,
          "passed",
        );
        assert.equal(JSON.stringify(result).includes(f.root), detailed);
        assert.equal(
          (
            await client.callTool({
              name: "validation_run",
              arguments: { allowExecution: true, detailed: true },
            })
          ).isError,
          true,
        );
      } finally {
        await client.close();
      }
    }
    const denied = new Client(
      { name: "original-rust-no-trust", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await denied.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", "--root", f.root],
          env,
          stderr: "pipe",
        }),
      );
      assert.equal(
        (await denied.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await denied.close();
    }
  },
);
test(
  "rust-extensions lifecycle acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const f = await rustOriginal(t, {
        fixed: true,
        checks: ["rust.cargo-test"],
        foreign: false,
      });
      f.policy.profiles = f.policy.profiles.slice(1);
      await rustAtomic(
        path.join(f.root, "checktrail.rust-build.json"),
        JSON.stringify(f.policy),
      );
      await rustAtomic(
        path.join(f.root, "a/src/lib.rs"),
        (await readFile(path.join(f.root, "a/src/lib.rs"), "utf8")) +
          rustWaitingSource(mode),
      );
      const abort = new AbortController();
      let ids:
        | {
            token: string;
            parent: number;
            child: number;
            build: string;
            temporary: string;
          }
        | undefined;
      const pending = validate(f.root, {
        trusted: true,
        timeoutMs: mode === "timeout" ? 30000 : 60000,
        signal: abort.signal,
      });
      void pending.catch(() => {});
      try {
        const deadline = performance.now() + 25000;
        while (performance.now() < deadline) {
          try {
            ids = JSON.parse(
              await readFile(
                path.join(f.root, "a/.checktrail/parent.ready"),
                "utf8",
              ),
            );
            break;
          } catch {
            await delay(10);
          }
        }
        assert.ok(ids, "Native test did not reach both waiting processes");
        assert.equal(ids.token, mode);
        assert.ok(ids.parent > 1 && ids.child > 1 && ids.parent !== ids.child);
        process.kill(ids.parent, 0);
        process.kill(ids.child, 0);
        assert.ok(path.isAbsolute(ids.build));
        assert.match(path.basename(ids.build), /^checktrail-rust-workspace-/);
        await access(ids.build);
        if (mode === "cancel") abort.abort();
        else if (mode === "output")
          await writeFile(
            path.join(f.root, "a/.checktrail/release"),
            "release",
          );
        const report = await pending;
        assert.equal(report.outcome, "incomplete");
        const result = report.checks[0]!.processes[0]!;
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(
          result.timedOut,
          mode === "timeout",
          "Native output exhaustion must not wait for a wall timeout",
        );
        assert.equal(result.truncated, mode === "output");
        assert.equal(result.errorCode, undefined);
        assert.throws(() => process.kill(ids!.parent, 0));
        assert.throws(() => process.kill(ids!.child, 0));
        await assert.rejects(
          access(ids.build),
          { code: "ENOENT" },
          "Forced termination must remove the actual reached native build directory",
        );
        assert.equal(path.dirname(ids.build), ids.temporary);
        await assert.rejects(access(ids.temporary));
        assert.equal(result.command.temporaryDirectory, true);
        assert.equal(
          await readFile(path.join(f.root, "target/preserve"), "utf8"),
          "keep",
        );
      } finally {
        abort.abort();
        await pending.catch(() => {});
        if (
          ids &&
          path.isAbsolute(ids.build) &&
          /^checktrail-rust-workspace-/.test(path.basename(ids.build))
        )
          await rm(ids.build, { recursive: true, force: true });
      }
    }
  },
);
test(
  "rust-extensions installed acceptance",
  { skip, timeout: 360000 },
  async () => {
    if (process.env.CHECKTRAIL_RUST_EXTENSIONS_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(new URL("../src/engine.js", import.meta.url)),
      );
      assert.match(
        actual,
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const script = fileURLToPath(
      new URL(
        "../../scripts/verify-import-context-package.mjs",
        import.meta.url,
      ),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "rust-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [script], {
      env,
      encoding: "utf8",
      timeout: 330000,
      maxBuffer: 4 * 1048576,
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
  },
);
