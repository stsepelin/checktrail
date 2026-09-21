import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { rustDependencyPaths } from "../src/rust-dep-info.js";
import { fixture } from "./helpers.js";

const available = /cargo 1\.98\.1 /.test(
  spawnSync("cargo", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
  }).stdout ?? "",
);
const example = fileURLToPath(new URL("../../examples/rust", import.meta.url));
const manifest = await readFile(path.join(example, "Cargo.toml"), "utf8");
const lock = await readFile(path.join(example, "Cargo.lock"), "utf8");
const source =
  (await readFile(path.join(example, "src/lib.rs"), "utf8")) +
  '\n#[cfg(test)] mod tests { #[test] fn not_executed() { panic!("Cargo check must not run tests"); } }\n';
const moduleSource = await readFile(
  path.join(example, "src/with space.rs"),
  "utf8",
);
const files = () => ({
  "Cargo.toml": manifest,
  "Cargo.lock": lock,
  "src/lib.rs": source,
  "src/with space.rs": moduleSource,
});

test("Rust planning requires a lockfile and supported source paths without executing build scripts or fetching tools", async (t) => {
  const root = await fixture(t, {
    ...files(),
    "build.rs": 'fn main() { std::fs::write("executed", "yes").unwrap(); }',
  });
  const plan = (await createPlan(root)).plan;
  assert.equal(plan.checks[0]!.id, "rust.cargo-check");
  assert.equal(plan.checks[0]!.commands[0]!.env!.RUSTUP_AUTO_INSTALL, "0");
  assert.ok(plan.checks[0]!.scope.includes("src/with space.rs"));
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await rm(path.join(root, "Cargo.lock"));
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /Cargo.lock/,
  );
  await writeFile(path.join(root, "Cargo.lock"), lock);
  await writeFile(path.join(root, "src/unsupported$.rs"), "");
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /source paths/,
  );
});

test("Rust dep-info decodes spaces exactly and rejects unsupported escapes and empty rules", () => {
  assert.deepEqual(
    rustDependencyPaths(
      "/tmp/build\\ output/lib.d: src/lib.rs src/with\\ space.rs\n\nsrc/lib.rs:\n# env-dep:LABEL=anything\n",
      "/synthetic root",
    ),
    ["/synthetic root/src/lib.rs", "/synthetic root/src/with space.rs"],
  );
  for (const input of [
    "",
    "src/lib.rs:",
    "garbage",
    "target: src/name\\q.rs",
    "target: src/$name.rs",
    "target: src/#name.rs",
    "target: src/file.rs\r",
  ])
    assert.throws(() => rustDependencyPaths(input, "/synthetic"));
});

test(
  "native Cargo checks fresh targets and exact source membership, catches compiler errors, and never claims test execution",
  {
    skip: available ? false : "Pinned Rust toolchain unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await fixture(t, files());
    const plan = (await createPlan(root)).plan;
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    assert.equal(passed.checks[0]!.tests, undefined);
    assert.equal(
      passed.checks[0]!.tools!.find((tool) => tool.name === "rustc")!.version,
      "1.98.1",
    );
    assert.equal(await readFile(path.join(root, "Cargo.lock"), "utf8"), lock);
    await assert.rejects(access(path.join(root, "target")));
    const process = passed.checks[0]!.processes[0]!;
    const data = JSON.parse(process.stdout);
    assert.deepEqual(data.observedSources, ["src/lib.rs", "src/with space.rs"]);
    const missingTestTarget = structuredClone(data);
    missingTestTarget.events = missingTestTarget.events.filter(
      (item: { reason: string; profile?: { test: boolean } }) =>
        !(item.reason === "compiler-artifact" && item.profile!.test),
    );
    assert.equal(
      evaluate(
        plan.checks[0]!,
        [{ ...process, stdout: JSON.stringify(missingTestTarget) }],
        root,
      ).status,
      "inconclusive",
    );
    const stale = structuredClone(data);
    stale.events.find(
      (item: { reason: string }) => item.reason === "compiler-artifact",
    ).fresh = true;
    assert.equal(
      evaluate(
        plan.checks[0]!,
        [{ ...process, stdout: JSON.stringify(stale) }],
        root,
      ).status,
      "inconclusive",
    );

    await writeFile(
      path.join(root, "src/with space.rs"),
      'pub fn value() -> usize { "wrong" }\n',
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findingsComplete, false);
    assert.ok(
      broken.checks[0]!.findings!.some(
        (item) =>
          item.ruleId === "rustc/E0308" && item.file === "src/with space.rs",
      ),
    );
    await writeFile(
      path.join(root, "src/with space.rs"),
      "pub fn value() -> usize { 2 }\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await writeFile(
      path.join(root, "src/unlinked.rs"),
      "pub fn unlinked() {}\n",
    );
    const unlinked = await validate(root, { trusted: true });
    assert.equal(unlinked.outcome, "incomplete");
    assert.equal(unlinked.checks[0]!.status, "inconclusive");
  },
);

test(
  "native Cargo cannot reuse configured output, omit a required feature target, or turn invalid package configuration into code success",
  {
    skip: available ? false : "Pinned Rust toolchain unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await fixture(t, {
      ...files(),
      ".cargo/config.toml":
        '[build]\ntarget-dir = "retained-target"\nbuild-dir = "retained-build"\n',
      "retained-target/sentinel": "unchanged",
      "retained-build/sentinel": "unchanged",
    });
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    assert.equal(
      await readFile(path.join(root, "retained-target/sentinel"), "utf8"),
      "unchanged",
    );
    assert.equal(
      await readFile(path.join(root, "retained-build/sentinel"), "utf8"),
      "unchanged",
    );
    await mkdir(path.join(root, "examples"));
    await writeFile(path.join(root, "examples/optional.rs"), "fn main() {}\n");
    await writeFile(
      path.join(root, "Cargo.toml"),
      manifest +
        '\n[features]\noptional = []\n[[example]]\nname = "optional"\nrequired-features = ["optional"]\n',
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(
      excluded.outcome,
      "incomplete",
      JSON.stringify(excluded.checks),
    );
    assert.equal(excluded.checks[0]!.status, "inconclusive");
    await writeFile(path.join(root, "Cargo.toml"), "invalid TOML");
    const invalid = await validate(root, { trusted: true });
    assert.equal(invalid.outcome, "incomplete");
    assert.equal(invalid.checks[0]!.status, "error");
  },
);

test(
  "native Cargo accounts for build-script source and rejects unsupported multi-package workspaces",
  {
    skip: available ? false : "Pinned Rust toolchain unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await fixture(t, {
      ...files(),
      "build.rs":
        'fn main() { println!("cargo::rerun-if-changed=src/lib.rs"); }\n',
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const capture = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.ok(capture.observedSources.includes("build.rs"));
    await mkdir(path.join(root, "member/src"), { recursive: true });
    await writeFile(
      path.join(root, "member/Cargo.toml"),
      '[package]\nname = "synthetic-member"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    await writeFile(
      path.join(root, "member/src/lib.rs"),
      "pub fn value() {}\n",
    );
    await writeFile(
      path.join(root, "Cargo.toml"),
      manifest + '\n[workspace]\nmembers = ["member"]\n',
    );
    await writeFile(
      path.join(root, "Cargo.lock"),
      lock + '\n[[package]]\nname = "synthetic-member"\nversion = "0.1.0"\n',
    );
    const workspace = await validate(root, { trusted: true });
    assert.equal(workspace.outcome, "incomplete");
    assert.equal(
      workspace.checks.find((check) => check.project === ".")!.status,
      "unavailable",
    );
  },
);
