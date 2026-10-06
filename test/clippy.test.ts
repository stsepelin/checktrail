import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import { createPlan, validate } from "../src/engine.js";
const available = /^clippy 0\.1\.98 /.test(
  spawnSync("cargo-clippy", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
  }).stdout ?? "",
);
const manifest =
  '[package]\nname="synthetic_clippy"\nversion="0.1.0"\nedition="2024"\n';
const lock =
  'version=4\n[[package]]\nname="synthetic_clippy"\nversion="0.1.0"\n';
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["rust.cargo-clippy"] }],
});
const good = "pub fn same(left: i32, right: i32) -> bool { left == right }\n";
const broken = "pub fn same(left: i32, _right: i32) -> bool { left == left }\n";
const assertion =
  '#[cfg(test)] mod tests { #[test] fn not_executed() { panic!("Clippy does not execute tests"); } }\n';
async function replace(file: string, source: string) {
  const next = file + ".replacement";
  await writeFile(next, source);
  await rename(next, file);
}
test("Clippy planning is explicit offline and never evaluates build scripts or installs tools", async (t) => {
  const root = await fixture(t, {
    "Cargo.toml": manifest,
    "Cargo.lock": lock,
    "checktrail.json": policy,
    "src/lib.rs": good,
    "build.rs": 'fn main() { std::fs::write("executed", "yes").unwrap(); }',
  });
  const plan = (await createPlan(root)).plan;
  assert.deepEqual(
    plan.checks.map((check) => check.id),
    ["rust.cargo-clippy"],
  );
  assert.equal(plan.checks[0]!.commands[0]!.env!.RUSTUP_AUTO_INSTALL, "0");
  assert.ok(plan.checks[0]!.commands[0]!.args.includes("--clippy"));
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  const missing = await fixture(t, {
    "Cargo.toml": manifest,
    "src/lib.rs": good,
    "checktrail.json": policy,
  });
  assert.match(
    (await createPlan(missing)).plan.checks[0]!.unavailableReason!,
    /Cargo.lock/,
  );
});
test(
  "native Clippy catches declared lint defects despite allow and expect attributes with fixed near-miss source compiler errors and incomplete-scope controls",
  {
    skip: available ? false : "Pinned native Clippy component unavailable",
    timeout: 120000,
  },
  async (t) => {
    const root = await fixture(t, {
      "Cargo.toml": manifest,
      "Cargo.lock": lock,
      "checktrail.json": policy,
      "src/lib.rs": good + assertion,
      "target/preserve": "keep",
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.tests, undefined);
    assert.equal(
      report.checks[0]!.tools?.find((tool) => tool.name === "clippy")?.version,
      "0.1.98",
    );
    for (const prefix of [
      "",
      "#![allow(clippy::all)]\n",
      "#![expect(clippy::eq_op)]\n",
    ]) {
      await replace(path.join(root, "src/lib.rs"), prefix + broken + assertion);
      report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
      assert.equal(report.sourceChanged, false);
      assert.equal(report.checks[0]!.findingsComplete, true);
      assert.ok(
        report.checks[0]!.findings?.some(
          (finding) =>
            finding.ruleId === "clippy/eq_op" && finding.file === "src/lib.rs",
        ),
      );
      assert.equal(
        report.checks[0]!.findings?.filter(
          (finding) => finding.ruleId === "clippy/eq_op",
        ).length,
        1,
      );
      assert.equal(report.checks[0]!.tests, undefined);
      assert.equal(
        await readFile(path.join(root, "src/lib.rs"), "utf8"),
        prefix + broken + assertion,
      );
    }
    await replace(path.join(root, "src/lib.rs"), good + assertion);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "src/lib.rs"),
      "pub fn same(left:i32,right:i32)->bool { left == right + 1 }\n" +
        assertion,
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "src/lib.rs"),
      'pub fn amount()->i32 { "wrong" }\n',
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed");
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.ok(
      report.checks[0]!.findings?.some(
        (finding) => finding.ruleId === "rustc/E0308",
      ),
    );
    await replace(path.join(root, "src/lib.rs"), good + assertion);
    await replace(path.join(root, "unlinked.rs"), "pub fn extra() {}\n");
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.status, "inconclusive");
    assert.equal(
      await readFile(path.join(root, "target/preserve"), "utf8"),
      "keep",
    );
    assert.equal(await readFile(path.join(root, "Cargo.lock"), "utf8"), lock);
  },
);

test(
  "native Clippy distinguishes configuration failures from source defects and accepts fixed near-miss configuration while offline prerequisites remain errors",
  {
    skip: available ? false : "Pinned native Clippy component unavailable",
    timeout: 90000,
  },
  async (t) => {
    const root = await fixture(t, {
      "Cargo.toml": manifest,
      "Cargo.lock": lock,
      "checktrail.json": policy,
      "src/lib.rs": good,
      "clippy.toml": "msrv = false\n",
    });
    const bad = await validate(root, { trusted: true });
    assert.equal(bad.outcome, "incomplete", JSON.stringify(bad.checks));
    assert.equal(bad.checks[0]!.status, "error");
    assert.equal(bad.checks[0]!.findingsComplete, false);
    assert.equal(bad.sourceChanged, false);
    for (const msrv of ["1.98.1", "1.97.0"]) {
      await replace(path.join(root, "clippy.toml"), `msrv = "${msrv}"\n`);
      assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    }
    const missing = await fixture(t, {
      "Cargo.toml":
        manifest + '[dependencies]\nmissing-synthetic-crate = "=0.0.1"\n',
      "Cargo.lock": lock,
      "checktrail.json": policy,
      "src/lib.rs": good,
    });
    const unavailable = await validate(missing, { trusted: true });
    assert.equal(unavailable.outcome, "incomplete");
    assert.equal(unavailable.checks[0]!.status, "error");
    assert.equal(unavailable.sourceChanged, false);
  },
);
