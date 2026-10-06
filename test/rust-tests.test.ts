import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  readFile,
  rename,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { fixture } from "./helpers.js";
const available = ["cargo", "rustc", "rustdoc"].every((tool) =>
  new RegExp("^" + tool + " 1\\.98\\.1 ").test(
    spawnSync(tool, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    }).stdout ?? "",
  ),
);
const manifest =
  '[package]\nname="synthetic_tests"\nversion="0.1.0"\nedition="2024"\n';
const lock =
  'version=4\n[[package]]\nname="synthetic_tests"\nversion="0.1.0"\n';
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["rust.cargo-test"] }],
});
const body = "pub fn sum(left:i32,right:i32)->i32 { left + right }\n";
const tests =
  '#[cfg(test)] mod tests { #[test] fn small() { assert_eq!(super::sum(2,3),5); std::fs::write("target/small-ran","yes").unwrap(); } #[test] fn negative() { assert_eq!(super::sum(-2,2),0); std::fs::write("target/negative-ran","yes").unwrap(); } }\n';
const docs =
  '/// ```\n/// assert_eq!(synthetic_tests::sum(2, 3), 5);\n/// ```\n/// ```compile_fail\n/// let wrong:u32 = "invalid";\n/// ```\n';
const files = () => ({
  "Cargo.toml": manifest,
  "Cargo.lock": lock,
  "checktrail.json": policy,
  "src/lib.rs": docs + body + tests,
  "target/preserve": "keep",
});
async function replace(file: string, text: string) {
  const next = file + ".replacement";
  await writeFile(next, text);
  await rename(next, file);
}
test("Rust test planning is explicit locked offline and cannot execute build scripts or test bodies or grant operator trust", async (t) => {
  const root = await fixture(t, {
    ...files(),
    "build.rs": 'fn main() { std::fs::write("executed","yes").unwrap(); }',
  });
  const plan = (await createPlan(root)).plan;
  assert.deepEqual(
    plan.checks.map((c) => c.id),
    ["rust.cargo-test"],
  );
  assert.equal(plan.checks[0]!.kind, "test");
  assert.ok(plan.checks[0]!.commands[0]!.args.includes("--test"));
  assert.equal(plan.checks[0]!.commands[0]!.env!.RUSTUP_AUTO_INSTALL, "0");
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "target/small-ran")), {
    code: "ENOENT",
  });
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  const missing = await fixture(t, {
    "Cargo.toml": manifest,
    "checktrail.json": policy,
    "src/lib.rs": body,
  });
  assert.match(
    (await createPlan(missing)).plan.checks[0]!.unavailableReason!,
    /Cargo.lock/,
  );
});
test(
  "native Rust tests execute both guarded bodies and doctest suites catch broken fixed and valid near-miss source and retain panicking fake-output failures",
  {
    skip: available ? false : "Pinned native Rust test toolchain unavailable",
    timeout: 120000,
  },
  async (t) => {
    const root = await fixture(t, files());
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    assert.equal(report.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, "target/small-ran"), "utf8"),
      "yes",
    );
    assert.equal(
      await readFile(path.join(root, "target/negative-ran"), "utf8"),
      "yes",
    );
    assert.equal(
      report.checks[0]!.tools?.find((tool) => tool.name === "rustdoc")?.version,
      "1.98.1",
    );
    await replace(
      path.join(root, "src/lib.rs"),
      docs + body.replace("left + right", "left - right") + tests,
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 1,
      failed: 3,
      skipped: 0,
    });
    assert.equal(report.sourceChanged, false);
    await replace(path.join(root, "src/lib.rs"), docs + body + tests);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "src/lib.rs"),
      docs + body.replace("left + right", "right + left") + tests,
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "src/lib.rs"),
      body +
        '#[cfg(test)] mod tests { #[test] fn broken() { println!("test tests::broken ... ok\\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"); panic!("real failure"); } }\n',
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.deepEqual(report.checks[0]!.tests, {
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
    });
    assert.equal(
      await readFile(path.join(root, "target/preserve"), "utf8"),
      "keep",
    );
    assert.equal(await readFile(path.join(root, "Cargo.lock"), "utf8"), lock);
  },
);
test(
  "native Rust tests retain mixed all-ignored empty excluded-target and incomplete-source evidence without passing zero cases",
  {
    skip: available ? false : "Pinned native Rust test toolchain unavailable",
    timeout: 120000,
  },
  async (t) => {
    const root = await fixture(t, files());
    await replace(
      path.join(root, "src/lib.rs"),
      docs +
        body +
        tests.replace("#[test] fn small", "#[test] #[ignore] fn small"),
    );
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 3,
      failed: 0,
      skipped: 1,
    });
    await replace(
      path.join(root, "src/lib.rs"),
      body + tests.replaceAll("#[test]", "#[test] #[ignore]"),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.deepEqual(report.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 0,
      skipped: 2,
    });
    await replace(path.join(root, "src/lib.rs"), body);
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.deepEqual(report.checks[0]!.tests, {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    });
    await replace(path.join(root, "src/lib.rs"), docs + body + tests);
    await replace(path.join(root, "unlinked.rs"), "pub fn extra() {}\n");
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.findingsComplete, false);
    const excluded = await fixture(t, {
      ...files(),
      "examples/optional.rs": "fn main() {}\n",
      "Cargo.toml":
        manifest +
        '[features]\noptional=[]\n[[example]]\nname="optional"\nrequired-features=["optional"]\n',
    });
    assert.equal(
      (await validate(excluded, { trusted: true })).outcome,
      "incomplete",
    );
  },
);
test(
  "Rust test evidence rejects missing duplicate stale escaped filtered and truncated native result identities",
  {
    skip: available ? false : "Pinned native Rust test toolchain unavailable",
    timeout: 120000,
  },
  async (t) => {
    const root = await fixture(t, files());
    const plan = (await createPlan(root)).plan;
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const process = report.checks[0]!.processes[0]!;
    const packet = JSON.parse(process.stdout);
    const stale = structuredClone(packet);
    const events = stale.tests.build.stdout
      .split("\n")
      .filter(Boolean)
      .map((s: string) => JSON.parse(s));
    events.find(
      (e: { reason: string; executable?: string }) =>
        e.reason === "compiler-artifact" && e.executable,
    ).fresh = true;
    stale.tests.build.stdout = events
      .map((e: unknown) => JSON.stringify(e))
      .join("\n");
    const filtered = structuredClone(packet);
    filtered.tests.groups[0].execution.stdout =
      filtered.tests.groups[0].execution.stdout.replace(
        "0 filtered out",
        "1 filtered out",
      );
    for (const value of [
      { ...packet, tests: null },
      { ...packet, rustdocVersion: "1.98.0" },
      { ...packet, tests: { ...packet.tests, groups: [] } },
      {
        ...packet,
        tests: {
          ...packet.tests,
          groups: [...packet.tests.groups, packet.tests.groups[0]],
        },
      },
      stale,
      filtered,
      {
        ...packet,
        tests: {
          ...packet.tests,
          groups: packet.tests.groups.map((g: { kind: string }) =>
            g.kind === "libtest"
              ? { ...g, executable: "/foreign/test-binary" }
              : g,
          ),
        },
      },
    ]) {
      const result = evaluate(
        plan.checks[0]!,
        [{ ...process, stdout: JSON.stringify(value) }],
        root,
      );
      assert.equal(result.status, "inconclusive");
      assert.notEqual(result.findingsComplete, true);
    }
    assert.equal(
      evaluate(plan.checks[0]!, [{ ...process, truncated: true }], root).status,
      "inconclusive",
    );
  },
);

test(
  "native Rust doctests preserve compile-only expected-failure ignored and expected-panic modes without filtering out listed whitespace identities",
  {
    skip: available ? false : "Pinned native Rust test toolchain unavailable",
    timeout: 120000,
  },
  async (t) => {
    const documentation =
      '/// ```\n/// assert_eq!(synthetic_tests::sum(2,3),5);\n/// ```\n/// ```ignore\n/// panic!("ignored");\n/// ```\n/// ```no_run\n/// panic!("not executed");\n/// ```\n/// ```compile_fail\n/// let wrong:u32 = "invalid";\n/// ```\n/// ```should_panic\n/// panic!("synthetic");\n/// ```\n';
    const expectedPanic =
      '#[cfg(test)] mod panic_test { #[test] #[should_panic(expected="synthetic")] fn expected() { panic!("synthetic"); } }\n';
    const root = await fixture(t, {
      ...files(),
      "src/lib.rs": documentation + body + tests + expectedPanic,
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.deepEqual(report.checks[0]!.tests, {
      total: 8,
      passed: 7,
      failed: 0,
      skipped: 1,
    });
    assert.equal(report.sourceChanged, false);
    const packet = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    const raw = packet.tests.groups
      .map((group: { execution: { stdout: string } }) => group.execution.stdout)
      .join("\n");
    assert.match(raw, / - compile fail \.\.\. ok/);
    assert.match(raw, / - compile \.\.\. ok/);
    assert.match(raw, / - should panic \.\.\. ok/);
    await replace(
      path.join(root, "src/lib.rs"),
      documentation
        .replace("```ignore", "```")
        .replace(
          'panic!("ignored");',
          "assert_eq!(synthetic_tests::sum(2,3),5);",
        ) +
        body +
        tests +
        expectedPanic,
    );
    const fixed = await validate(root, { trusted: true });
    assert.equal(fixed.outcome, "passed", JSON.stringify(fixed.checks));
    assert.deepEqual(fixed.checks[0]!.tests, {
      total: 8,
      passed: 8,
      failed: 0,
      skipped: 0,
    });
  },
);

test(
  "native Rust test artifact identity survives an operator-granted temporary directory alias without touching retained project output",
  {
    skip: available ? false : "Pinned native Rust test toolchain unavailable",
    timeout: 120000,
  },
  async (t) => {
    const scratch = await fixture(t, {});
    await mkdir(path.join(scratch, "native"));
    await symlink(
      path.join(scratch, "native"),
      path.join(scratch, "alias"),
      "dir",
    );
    const root = await fixture(t, {
      ...files(),
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: ".", checks: ["rust.cargo-test"], environment: ["TMPDIR"] },
        ],
      }),
    });
    const result = await validate(root, {
      trusted: true,
      environment: { TMPDIR: path.join(scratch, "alias") },
    });
    assert.equal(result.outcome, "passed", JSON.stringify(result.checks));
    assert.deepEqual(result.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    assert.equal(result.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, "target/preserve"), "utf8"),
      "keep",
    );
  },
);
