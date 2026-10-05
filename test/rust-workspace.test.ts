import assert from "node:assert/strict";
import { access, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { validatedReport } from "../src/report-validation.js";
import { rustBuildPolicySchema } from "../src/rust-build.js";
import { fixture } from "./helpers.js";
import {
  rustWorkspaceAvailable as available,
  rustWorkspaceFiles as files,
  rustWorkspaceProfiles as profiles,
} from "./rust-workspace-fixture.js";
async function replace(file: string, text: string) {
  const next = file + ".replacement";
  await writeFile(next, text);
  await rename(next, file);
}
test("Rust workspace planning retains complete profiles without executing project code and rejects late invalid profile expansion atomically", async (t) => {
  const root = await fixture(t, {
    ...files(),
    "a/build.rs": 'fn main(){std::fs::write("executed","yes").unwrap();}',
  });
  const plan = (await createPlan(root)).plan;
  assert.equal(plan.checks.length, 4);
  assert.equal(new Set(plan.checks.map((c) => c.executionId)).size, 4);
  assert.ok(
    plan.checks.every(
      (c) =>
        c.scope.includes("b/src/lib.rs") &&
        c.rustBuild?.workspaceMembers.length === 2,
    ),
  );
  await assert.rejects(access(path.join(root, "a/executed")), {
    code: "ENOENT",
  });
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  const bad = profiles();
  bad.profiles[1]!.name = "lean";
  await replace(
    path.join(root, "checktrail.rust-build.json"),
    JSON.stringify(bad),
  );
  const rejected = (await createPlan(root)).plan;
  assert.equal(rejected.checks.length, 2);
  assert.ok(
    rejected.checks.every(
      (c) =>
        c.unavailableReason?.includes("Duplicate") &&
        c.rustBuild === undefined &&
        c.executionId === undefined,
    ),
  );
  assert.equal(
    rustBuildPolicySchema.safeParse({
      ...profiles(),
      profiles: [
        {
          ...profiles().profiles[0],
          excludedSources: [{ path: "unlinked.rs", reason: "not linked" }],
        },
      ],
    }).success,
    true,
  );
  for (const value of [
    { ...profiles(), unknown: true },
    { ...profiles(), workspaceMembers: ["../escape"] },
    { ...profiles(), workspaceMembers: ["a/."] },
    {
      ...profiles(),
      profiles: [{ ...profiles().profiles[0], features: ["a/extra,b/extra"] }],
    },
  ])
    assert.equal(rustBuildPolicySchema.safeParse(value).success, false);
});
test(
  "native Rust workspace profiles cover siblings beyond default members and preserve lean extra broken fixed and valid near-miss source",
  {
    skip: available
      ? false
      : "Pinned native Rust workspace toolchain unavailable",
    timeout: 180000,
  },
  async (t) => {
    const root = await fixture(t, files());
    let report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "passed",
      JSON.stringify(
        report.checks.map((c) => ({
          id: c.id,
          profile: c.rustBuild?.profile,
          status: c.status,
          reason: c.reason,
          tests: c.tests,
          findings: c.findings,
        })),
      ),
    );
    validatedReport(report);
    assert.equal(report.checks.length, 4);
    assert.deepEqual(
      report.checks.filter((c) => c.tests).map((c) => c.tests),
      [
        { total: 4, passed: 4, failed: 0, skipped: 0 },
        { total: 5, passed: 5, failed: 0, skipped: 0 },
      ],
    );
    await replace(
      path.join(root, "a/src/extra.rs"),
      "pub fn value()->i32 { 6 }\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "failed",
      JSON.stringify(
        report.checks.map((c) => ({
          id: c.id,
          profile: c.rustBuild?.profile,
          status: c.status,
          reason: c.reason,
          tests: c.tests,
          findings: c.findings,
        })),
      ),
    );
    assert.equal(
      report.checks.find(
        (c) => c.id === "rust.cargo-test" && c.rustBuild?.profile === "lean",
      )!.status,
      "passed",
    );
    const broken = report.checks.find(
      (c) => c.id === "rust.cargo-test" && c.rustBuild?.profile === "extra",
    )!;
    assert.equal(broken.status, "failed");
    assert.equal(broken.findingsComplete, false);
    assert.equal(broken.tests, undefined);
    assert.match(broken.reason, /aggregate test counts remain unknown/);
    await replace(
      path.join(root, "a/src/extra.rs"),
      "pub fn value()->i32 { 2 + 3 }\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "b/src/lib.rs"),
      "pub fn broken()->u32 { false }\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed");
    assert.ok(
      report.checks.every((c) =>
        c.findings?.some(
          (f) => f.file === "b/src/lib.rs" && f.ruleId === "rustc/E0308",
        ),
      ),
    );
    assert.equal(
      await readFile(path.join(root, "target/preserve"), "utf8"),
      "keep",
    );
    assert.equal(
      await readFile(path.join(root, "Cargo.lock"), "utf8"),
      files()["Cargo.lock"],
    );
    assert.equal(report.sourceChanged, false);
  },
);
test(
  "native Rust workspace accounting keeps missing members targets features stale exclusions unlinked source and ignored empty member tests incomplete",
  {
    skip: available
      ? false
      : "Pinned native Rust workspace toolchain unavailable",
    timeout: 180000,
  },
  async (t) => {
    const policy = profiles(["rust.cargo-test"]);
    policy.profiles = policy.profiles.slice(1);
    const root = await fixture(t, {
      ...files(["rust.cargo-test"]),
      "checktrail.rust-build.json": JSON.stringify(policy),
    });
    const update = async (value: unknown) =>
      replace(
        path.join(root, "checktrail.rust-build.json"),
        JSON.stringify(value),
      );
    await update({ ...policy, workspaceMembers: ["a"] });
    let report = await validate(root, { trusted: true });
    assert.equal(report.checks[0]!.status, "unavailable");
    await update({
      ...policy,
      profiles: policy.profiles.map((p) => ({
        ...p,
        target: "wasm32-unknown-unknown",
      })),
    });
    report = await validate(root, { trusted: true });
    assert.equal(report.checks[0]!.status, "unavailable");
    await update({
      ...policy,
      profiles: policy.profiles.map((p) => ({
        ...p,
        excludedSources: [
          { path: "a/src/extra.rs", reason: "incorrect active exclusion" },
        ],
      })),
    });
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await update(policy);
    await replace(path.join(root, "b/unlinked.rs"), "pub fn hidden(){}\n");
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await update({
      ...policy,
      profiles: policy.profiles.map((p) => ({
        ...p,
        excludedSources: [
          { path: "b/unlinked.rs", reason: "not linked by this profile" },
        ],
      })),
    });
    await replace(
      path.join(root, "b/src/lib.rs"),
      "pub fn value()->i32 { a::value() }\n#[test] fn passed(){assert_eq!(value(),5);}\n#[test] #[ignore] fn ignored(){assert_eq!(value(),5);}\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.tests!.skipped, 1);
    await replace(
      path.join(root, "b/src/lib.rs"),
      "pub fn value()->i32 { a::value() }\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.ok(report.checks[0]!.tests!.passed > 0);
    assert.equal(report.checks[0]!.findingsComplete, false);
  },
);
test(
  "native workspace Clippy retains exact sibling finding addresses and rejects malformed member configuration without passing compiler-only evidence",
  {
    skip: available
      ? false
      : "Pinned native Rust workspace toolchain unavailable",
    timeout: 180000,
  },
  async (t) => {
    const root = await fixture(t, files(["rust.cargo-clippy"]));
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "b/src/lib.rs"),
      files()["b/src/lib.rs"]!.replace(
        "#[cfg(test)]",
        "pub fn choice(b:bool)->bool { if b {true} else {false} }\n#[cfg(test)]",
      ),
    );
    let report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "failed",
      JSON.stringify(
        report.checks.map((c) => ({
          id: c.id,
          profile: c.rustBuild?.profile,
          status: c.status,
          reason: c.reason,
          tests: c.tests,
          findings: c.findings,
        })),
      ),
    );
    assert.ok(
      report.checks.every(
        (c) =>
          c.findings?.some(
            (f) =>
              f.file === "b/src/lib.rs" && f.ruleId === "clippy/needless_bool",
          ) && c.findingsComplete === true,
      ),
    );
    await replace(
      path.join(root, "b/src/lib.rs"),
      files()["b/src/lib.rs"]!.replace(
        "#[cfg(test)]",
        "pub fn choice(b:bool)->bool { b }\n#[cfg(test)]",
      ),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "b/clippy.toml"),
      "synthetic-invalid-key=true\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "incomplete",
      JSON.stringify(
        report.checks.map((c) => ({
          id: c.id,
          profile: c.rustBuild?.profile,
          status: c.status,
          reason: c.reason,
          tests: c.tests,
          findings: c.findings,
        })),
      ),
    );
    assert.ok(report.checks.every((c) => c.findingsComplete !== true));
  },
);
test(
  "Rust workspace evidence rejects altered selection feature coverage member identities stale artifacts filtered cases and omitted execution manifests",
  {
    skip: available
      ? false
      : "Pinned native Rust workspace toolchain unavailable",
    timeout: 180000,
  },
  async (t) => {
    const policy = profiles(["rust.cargo-test"]);
    policy.profiles = policy.profiles.slice(1);
    const root = await fixture(t, {
      ...files(["rust.cargo-test"]),
      "checktrail.rust-build.json": JSON.stringify(policy),
    });
    const plan = (await createPlan(root)).plan;
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "passed",
      JSON.stringify(
        report.checks.map((c) => ({
          id: c.id,
          profile: c.rustBuild?.profile,
          status: c.status,
          reason: c.reason,
          tests: c.tests,
          findings: c.findings,
        })),
      ),
    );
    validatedReport(report);
    const process = report.checks[0]!.processes[0]!;
    const packet = JSON.parse(process.stdout);
    const mutations = [
      (p: typeof packet) => {
        const events = p.execution.stdout
          .split("\n")
          .filter(Boolean)
          .map((s: string) => JSON.parse(s));
        const artifact = events.find(
          (e: { reason: string; target?: { kind: string[] } }) =>
            e.reason === "compiler-artifact" &&
            !e.target!.kind.includes("custom-build"),
        );
        artifact.filenames = [
          p.metadata.target_directory + "/wrong-target/output.rmeta",
        ];
        p.execution.stdout = events
          .map((e: unknown) => JSON.stringify(e))
          .join("\n");
      },
      (p: typeof packet) => (p.selection.features = []),
      (p: typeof packet) => p.metadata.workspace_members.pop(),
      (p: typeof packet) =>
        (p.metadata.resolve.nodes.find(
          (n: { id: string }) =>
            n.id ===
            p.metadata.packages.find((m: { name: string }) => m.name === "a")
              .id,
        ).features = []),
      (p: typeof packet) => p.observedSources.pop(),
      (p: typeof packet) => p.tests.groups.pop(),
      (p: typeof packet) =>
        (p.documentation.execution.stdout =
          p.documentation.execution.stdout.replace(
            "0 filtered out",
            "1 filtered out",
          )),
      (p: typeof packet) => {
        const events = p.tests.build.stdout
          .split("\n")
          .filter(Boolean)
          .map((s: string) => JSON.parse(s));
        events.find((e: { executable?: string }) => e.executable).fresh = true;
        p.tests.build.stdout = events
          .map((e: unknown) => JSON.stringify(e))
          .join("\n");
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(packet);
      mutate(value);
      const result = evaluate(
        plan.checks[0]!,
        [{ ...process, stdout: JSON.stringify(value) }],
        root,
      );
      assert.equal(result.status, "inconclusive");
      assert.notEqual(result.findingsComplete, true);
    }
    for (const processFault of [
      { ...process, truncated: true },
      { ...process, cancelled: true },
      { ...process, timedOut: true },
    ])
      assert.equal(
        evaluate(plan.checks[0]!, [processFault], root).status,
        "inconclusive",
      );
    const omitted = structuredClone(report);
    omitted.checks = [];
    omitted.outcome = "incomplete";
    assert.throws(() => validatedReport(omitted), /manifest/);
    const changed = structuredClone(report);
    changed.checks[0]!.rustBuild!.features = [];
    assert.throws(() => validatedReport(changed), /Rust execution identity/);
  },
);

test(
  "native Rust workspace compilation supports explicit installed foreign targets while foreign tests and missing target libraries remain unavailable",
  {
    skip: available
      ? false
      : "Pinned native Rust workspace toolchain unavailable",
    timeout: 180000,
  },
  async (t) => {
    const policy = profiles(["rust.cargo-check", "rust.cargo-clippy"]);
    policy.profiles = policy.profiles
      .slice(1)
      .map((p) => ({ ...p, target: "wasm32-unknown-unknown" }));
    const root = await fixture(t, {
      ...files(["rust.cargo-check", "rust.cargo-clippy"]),
      "checktrail.rust-build.json": JSON.stringify(policy),
    });
    let report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "passed",
      JSON.stringify(
        report.checks.map((c) => ({ status: c.status, reason: c.reason })),
      ),
    );
    assert.ok(
      report.checks.every(
        (c) =>
          c.rustBuild?.target === "wasm32-unknown-unknown" &&
          c.findingsComplete === true,
      ),
    );
    assert.ok(report.checks.every((c) => c.tests === undefined));
    await replace(
      path.join(root, "a/src/extra.rs"),
      "pub fn value()->i32 { false }\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed");
    assert.ok(
      report.checks.every((c) =>
        c.findings?.some(
          (f) => f.ruleId === "rustc/E0308" && f.file === "a/src/extra.rs",
        ),
      ),
    );
    await replace(
      path.join(root, "a/src/extra.rs"),
      "pub fn value()->i32 { 3 + 2 }\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "checktrail.rust-build.json"),
      JSON.stringify({
        ...policy,
        profiles: policy.profiles.map((p) => ({
          ...p,
          target: "x86_64-pc-windows-msvc",
        })),
      }),
    );
    report = await validate(root, { trusted: true });
    assert.ok(report.checks.every((c) => c.status === "unavailable"));
  },
);

test(
  "native Rust workspace build-script generated modules and proc macros execute only after operator trust with fresh compiler and test artifacts",
  {
    skip: available
      ? false
      : "Pinned native Rust workspace toolchain unavailable",
    timeout: 180000,
  },
  async (t) => {
    const policy = profiles(["rust.cargo-test"]);
    policy.profiles = policy.profiles.slice(1);
    const root = await fixture(t, {
      ...files(["rust.cargo-test"]),
      "checktrail.rust-build.json": JSON.stringify(policy),
      "Cargo.lock":
        'version=4\n[[package]]\nname="a"\nversion="0.1.0"\ndependencies=["b"]\n[[package]]\nname="b"\nversion="0.1.0"\n',
      "a/Cargo.toml":
        files()["a/Cargo.toml"]! + '[dependencies]\nb={path="../b"}\n',
      "b/Cargo.toml":
        '[package]\nname="b"\nversion="0.1.0"\nedition="2024"\n[lib]\nproc-macro=true\ndoctest=false\n',
      "a/build.rs":
        'fn main(){let out=std::env::var("OUT_DIR").unwrap();std::fs::write(std::path::Path::new(&out).join("generated.rs"),"pub fn generated()->i32 { b::five!() }\\n").unwrap();}\n',
      "a/src/extra.rs":
        'include!(concat!(env!("OUT_DIR"),"/generated.rs"));\npub fn value()->i32 { generated() }\n',
      "b/src/lib.rs":
        'extern crate proc_macro;\nfn text()->&\'static str {"5"}\n#[proc_macro] pub fn five(_:proc_macro::TokenStream)->proc_macro::TokenStream { text().parse().unwrap() }\n#[cfg(test)] mod tests { #[test] fn macro_text(){assert_eq!(super::text(),"5");} }\n',
    });
    const plan = (await createPlan(root)).plan;
    assert.equal(plan.checks.length, 1);
    await assert.rejects(validate(root, { trusted: false }), /operator trust/);
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "passed",
      JSON.stringify(
        report.checks.map((c) => ({ status: c.status, reason: c.reason })),
      ),
    );
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    assert.equal(report.sourceChanged, false);
    const packet = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.ok(packet.observedSources.includes("a/build.rs"));
    assert.ok(
      packet.execution.stdout.includes('"reason":"build-script-executed"'),
    );
    assert.ok(packet.execution.stdout.includes('"proc-macro"'));
    await replace(
      path.join(root, "a/build.rs"),
      'fn main(){panic!("synthetic build failure");}\n',
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "incomplete");
    assert.equal(broken.checks[0]!.findingsComplete, false);
    assert.equal(broken.checks[0]!.tests, undefined);
  },
);

test(
  "native Rust workspace root package and child doctests use the most specific manifest owner",
  {
    skip: available
      ? false
      : "Pinned native Rust workspace toolchain unavailable",
    timeout: 180000,
  },
  async (t) => {
    const policy = {
      schemaVersion: 1,
      workspaceMembers: [".", "child"],
      profiles: [
        {
          name: "root-and-child",
          checks: ["rust.cargo-test"],
          features: [],
          defaultFeatures: true,
          target: null,
          excludedSources: [],
        },
      ],
    };
    const root = await fixture(t, {
      "Cargo.toml":
        '[package]\nname="parent"\nversion="0.1.0"\nedition="2024"\n[workspace]\nresolver="3"\nmembers=["child"]\n',
      "Cargo.lock":
        'version=4\n[[package]]\nname="parent"\nversion="0.1.0"\n[[package]]\nname="child"\nversion="0.1.0"\n',
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["rust.cargo-test"] }],
      }),
      "checktrail.rust-build.json": JSON.stringify(policy),
      "src/lib.rs":
        "/// ```\n/// assert_eq!(parent::value(),5);\n/// ```\npub fn value()->i32 {5}\n#[test] fn unit(){assert_eq!(value(),5);}\n",
      "child/Cargo.toml":
        '[package]\nname="child"\nversion="0.1.0"\nedition="2024"\n',
      "child/src/lib.rs":
        "/// ```\n/// assert_eq!(child::value(),5);\n/// ```\npub fn value()->i32 {5}\n",
    });
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "passed",
      JSON.stringify(
        report.checks.map((c) => ({ status: c.status, reason: c.reason })),
      ),
    );
    assert.deepEqual(report.checks[0]!.tests, {
      total: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
    });
    assert.equal(report.sourceChanged, false);
  },
);
