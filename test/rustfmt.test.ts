import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { reportSchema } from "../src/schemas.js";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import { createPlan, validate } from "../src/engine.js";
import { rustfmtHasSkip } from "../src/rustfmt-skips.js";
import { rustfmtEvidence } from "../src/rustfmt-evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
const available = /^rustfmt 1\.9\.0-stable /.test(
  spawnSync("rustfmt", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
  }).stdout ?? "",
);
const manifest =
  '[package]\nname="synthetic_format"\nversion="0.1.0"\nedition="2024"\n';
const lock =
  'version = 4\n[[package]]\nname = "synthetic_format"\nversion = "0.1.0"\n';
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["rust.cargo-fmt"] }],
});
const source =
  '#[path = "with spaces.rs"]\nmod other;\n\npub fn amount() -> i32 {\n    other::amount()\n}\n';
const module = "pub fn amount() -> i32 {\n    42\n}\n";
const files = () => ({
  "Cargo.toml": manifest,
  "Cargo.lock": lock,
  "checktrail.json": policy,
  "src/lib.rs": source,
  "src/with spaces.rs": module,
});
async function replace(file: string, source: string) {
  const next = file + ".replacement";
  await writeFile(next, source);
  await rename(next, file);
}
test("Rust formatting planning retains exact workspace source without evaluating manifests or installing components", async (t) => {
  const root = await fixture(t, {
    ...files(),
    "build.rs": 'fn main() { std::fs::write("executed", "yes").unwrap(); }',
  });
  const plan = (await createPlan(root)).plan;
  assert.deepEqual(
    plan.checks.map((c) => c.id),
    ["rust.cargo-fmt"],
  );
  assert.deepEqual(plan.checks[0]!.scope, [
    "build.rs",
    "src/lib.rs",
    "src/with spaces.rs",
  ]);
  assert.equal(plan.checks[0]!.commands[0]!.env!.CARGO_NET_OFFLINE, "true");
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  const missing = await fixture(t, {
    "Cargo.toml": manifest,
    "checktrail.json": policy,
    "src/lib.rs": source,
  });
  assert.match(
    (await createPlan(missing)).plan.checks[0]!.unavailableReason!,
    /Cargo.lock/,
  );
});
test("Rustfmt skip scanning respects exact attributes nested comments raw strings Unicode names and attribute boundaries", () => {
  for (const source of [
    "#[rustfmt::skip] fn x() {}",
    "#![rustfmt::skip]",
    "#[r#rustfmt::r#skip] fn x() {}",
    "#[cfg_attr(false, rustfmt::skip)] fn x() {}",
  ])
    assert.equal(rustfmtHasSkip(source), true, source);
  for (const source of [
    "// #[rustfmt::skip]\nfn x() {}",
    "/* /* nested */ #[rustfmt::skip] */ fn x() {}",
    'const TEXT: &str = r###"#[rustfmt::skip]"###;',
    'const TEXT: &[u8] = br#"#[rustfmt::skip]"#;',
    'const TEXT: &str = "#[rustfmt::skip]";',
    "#[other_rustfmt::skip] fn x() {}",
    "#[rustfmt::skip_other] fn x() {}",
    "#[βrustfmt::skip] fn x() {}",
    "#[derive(Clone)] fn x() { rustfmt::skip(); }",
    "const C: char = '#'; fn f<'a>() {}",
  ])
    assert.equal(rustfmtHasSkip(source), false, source);
  assert.throws(() => rustfmtHasSkip("/* unfinished"));
  assert.throws(() => rustfmtHasSkip('r#"unfinished'));
});
test(
  "native Rust formatting catches broken style and preserves fixed near-miss source while disabled skipped empty and malformed profiles stay incomplete",
  {
    skip: available ? false : "Pinned native Rustfmt component unavailable",
    timeout: 90000,
  },
  async (t) => {
    const root = await fixture(t, { ...files(), "target/preserve": "retain" });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(
      report.checks[0]!.tools?.find((tool) => tool.name === "rustfmt")?.version,
      "1.9.0-stable",
    );
    const broken = "pub fn amount()->i32{42}\n";
    await replace(path.join(root, "src/with spaces.rs"), broken);
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      report.checks[0]!.findings?.map((f) => f.file),
      ["src/with spaces.rs"],
    );
    assert.equal(
      await readFile(path.join(root, "src/with spaces.rs"), "utf8"),
      broken,
    );
    await replace(path.join(root, "src/with spaces.rs"), module);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    for (const encoding of [
      "\ufeff" + module,
      module.replaceAll("\n", "\r\n"),
    ]) {
      await replace(path.join(root, "src/with spaces.rs"), encoding);
      const native = spawnSync("cargo", ["fmt", "--all", "--check"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          CARGO_NET_OFFLINE: "true",
          RUSTUP_AUTO_INSTALL: "0",
        },
      });
      assert.equal(native.status, 0, native.stderr);
      report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      assert.equal(report.sourceChanged, false);
      assert.equal(
        await readFile(path.join(root, "src/with spaces.rs"), "utf8"),
        encoding,
      );
    }

    await replace(path.join(root, "unlinked.rs"), module);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(path.join(root, "unlinked.rs"), broken);
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks[0]!.findings?.map((f) => f.file),
      ["unlinked.rs"],
    );
    await replace(path.join(root, "unlinked.rs"), module);
    await replace(
      path.join(root, "src/with spaces.rs"),
      "// #[rustfmt::skip] is only a comment\n" + module,
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "src/with spaces.rs"),
      "#[rustfmt::skip]\n" + broken,
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "inconclusive");
    await replace(path.join(root, "src/with spaces.rs"), broken);
    await replace(
      path.join(root, "rustfmt.toml"),
      "disable_all_formatting = true\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    const disabledPacket = JSON.parse(
      report.checks[0]!.processes[0]!.stdout,
    ) as { files: { disabled: boolean; process: unknown }[] };
    assert.ok(
      disabledPacket.files.every(
        (file) => file.disabled && file.process === null,
      ),
    );
    await replace(
      path.join(root, "rustfmt.toml"),
      "disable_all_formatting = false\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await replace(path.join(root, "src/with spaces.rs"), "");
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    await replace(path.join(root, "src/with spaces.rs"), "pub fn amount( {\n");
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.status, "error");
    assert.equal(report.checks[0]!.findings?.length ?? 0, 0);
    await replace(path.join(root, "src/with spaces.rs"), module);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    assert.equal(
      await readFile(path.join(root, "target/preserve"), "utf8"),
      "retain",
    );
    assert.equal(await readFile(path.join(root, "Cargo.lock"), "utf8"), lock);
    await replace(path.join(root, "src/rustfmt.toml"), "");
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /Nested/,
    );
  },
);
test(
  "native Rust formatting selects all declared workspace members with per-package editions and generated source",
  {
    skip: available ? false : "Pinned native Rustfmt component unavailable",
    timeout: 90000,
  },
  async (t) => {
    const root = await fixture(t, {
      "Cargo.toml": '[workspace]\nmembers=["first","second"]\nresolver="3"\n',
      "Cargo.lock":
        'version = 4\n[[package]]\nname="first"\nversion="0.1.0"\n[[package]]\nname="second"\nversion="0.1.0"\n',
      "checktrail.json": policy,
      "first/Cargo.toml": manifest.replace("synthetic_format", "first"),
      "first/src/lib.rs": module,
      "second/Cargo.toml": manifest
        .replace("synthetic_format", "second")
        .replace("2024", "2021"),
      "second/src/lib.rs":
        '#[path = "generated.rs"]\nmod generated;\n\npub fn amount() -> i32 {\n    generated::amount()\n}\n',
      "second/src/generated.rs": "// generated synthetic source\n" + module,
    });
    const planned = (await createPlan(root)).plan;
    assert.equal(planned.checks[0]!.scope.length, 3);
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    await replace(
      path.join(root, "second/src/generated.rs"),
      "pub fn amount()->i32{42}\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks[0]!.findings?.map((f) => f.file),
      ["second/src/generated.rs"],
    );
    assert.equal(report.sourceChanged, false);
  },
);
test(
  "native Rust formatting rejects local dependencies outside selected workspace membership without rewriting either source",
  {
    skip: available ? false : "Pinned native Rustfmt component unavailable",
    timeout: 60000,
  },
  async (t) => {
    const root = await fixture(t, {
      ...files(),
      "Cargo.toml": manifest + '[dependencies]\nforeign={path="foreign"}\n',
      "Cargo.lock":
        'version = 4\n[[package]]\nname="synthetic_format"\nversion="0.1.0"\ndependencies=["foreign"]\n[[package]]\nname="foreign"\nversion="0.1.0"\n',
      "foreign/Cargo.toml":
        manifest.replace("synthetic_format", "foreign") + "[workspace]\n",
      "foreign/src/lib.rs": module,
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.status, "error");
    assert.equal(report.checks[0]!.findings?.length ?? 0, 0);
    assert.equal(
      await readFile(path.join(root, "foreign/src/lib.rs"), "utf8"),
      module,
    );
    assert.equal(report.sourceChanged, false);
  },
);

test("Rust formatting evidence reconciles exact scope output digests active processing versions and native exits", () => {
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const value = {
    version: 1,
    cargoVersion: "1.98.1",
    rustfmtVersion: "1.9.0-stable",
    project: ".",
    files: [
      {
        file: "lib.rs",
        inputSha256: hash(module),
        nativeOutputSha256: hash(""),
        disabled: false,
        skipped: false,
        empty: false,
        process: { exitCode: 0, stdout: "", stderr: "" },
      },
    ],
    cargo: {
      exitCode: 0,
      stdout: "Formatting /synthetic/lib.rs\n",
      stderr: "",
    },
  };
  const check: Check = {
    id: "rust.cargo-fmt",
    adapter: "rust",
    project: ".",
    scope: ["lib.rs"],
    kind: "format",
    parser: "rustfmt-json",
    commands: [],
    reason: "synthetic",
  };
  const process: ProcessResult = {
    command: { executable: "node", args: [], cwd: "." },
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  assert.equal(
    rustfmtEvidence(check, [process], "/synthetic").status,
    "passed",
  );
  const forgedOutput = rustfmtEvidence(
    check,
    [
      {
        ...process,
        stdout: JSON.stringify({
          ...value,
          files: [{ ...value.files[0], nativeOutputSha256: hash("different") }],
        }),
      },
    ],
    "/synthetic",
  );
  assert.equal(forgedOutput.status, "inconclusive");
  assert.notEqual(forgedOutput.findingsComplete, true);
  for (const patch of [
    { files: [] },
    { files: [{ ...value.files[0], file: "../foreign.rs" }] },
    { files: [value.files[0], value.files[0]] },
    { files: [{ ...value.files[0], nativeOutputSha256: hash("different") }] },
    { files: [{ ...value.files[0], disabled: true }] },
    { files: [{ ...value.files[0], skipped: true }] },
    { files: [{ ...value.files[0], empty: true }] },
    { files: [{ ...value.files[0], process: null }] },
    { rustfmtVersion: "1.9.1-stable" },
    { cargo: { exitCode: 1, stdout: "", stderr: "" } },
  ])
    assert.notEqual(
      rustfmtEvidence(
        check,
        [{ ...process, stdout: JSON.stringify({ ...value, ...patch }) }],
        "/synthetic",
      ).status,
      "passed",
    );
});

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [cli, "serve", "--root", root, ...args],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  let stopped = false;
  let sequence = 0;
  let stderr = "";
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  child.stderr.on("data", (b) => {
    stderr = (stderr + String(b)).slice(-4096);
  });
  const lines = createInterface({ input: child.stdout });
  child.on("exit", () => {
    stopped = true;
    for (const entry of pending.values())
      entry.reject(new Error(`Server exited: ${stderr}`));
    pending.clear();
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.id === "number") {
      pending.get(value.id)?.resolve(value);
      pending.delete(value.id);
    }
  });
  return {
    async request(name: string, arguments_: Record<string, unknown> = {}) {
      const id = sequence++;
      const timer = setTimeout(() => {
        pending.get(id)?.reject(new Error(`Tool timeout: ${stderr}`));
        pending.delete(id);
      }, 30000);
      try {
        const result = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                  name,
                  arguments: arguments_,
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                },
              }) + "\n",
            );
          },
        );
        assert.equal(result.error, undefined);
        return result.result as {
          isError?: boolean;
          structuredContent?: unknown;
        };
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (!stopped) child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        await exit;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}
test(
  "Rust formatting CLI and MCP agree on native failures preserve summary privacy and reject argument trust injection",
  {
    skip: available ? false : "Pinned native Rustfmt component unavailable",
    timeout: 90000,
  },
  async (t) => {
    const root = await fixture(t, files());
    await replace(
      path.join(root, "src/with spaces.rs"),
      "pub fn amount()->i32{42}\n",
    );
    const output = spawnSync(
      process.execPath,
      [cli, "run", "--root", root, "--trust-project", "--detailed"],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(output.status, 1, output.stderr);
    const report = reportSchema.parse(JSON.parse(output.stdout));
    assert.equal(report.outcome, "failed");
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.findingsComplete, true);
    const server = await connect(root, ["--allow-execution"], process.env);
    try {
      const result = await server.request("validation_run");
      assert.notEqual(result.isError, true);
      const summary = result.structuredContent as {
        outcome: string;
        checks: { id: string; status: string }[];
      };
      assert.equal(summary.outcome, "failed");
      assert.equal(summary.checks[0]!.id, "rust.cargo-fmt");
      assert.equal(summary.checks[0]!.status, report.checks[0]!.status);
      assert.ok(
        !JSON.stringify(result).includes(root) &&
          !JSON.stringify(result).includes("with spaces.rs"),
      );
      assert.equal(
        (await server.request("validation_run", { trusted: true })).isError,
        true,
      );
    } finally {
      await server.close();
    }
    const denied = await connect(root, [], process.env);
    try {
      assert.equal((await denied.request("validation_run")).isError, true);
    } finally {
      await denied.close();
    }
  },
);
