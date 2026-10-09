import assert from "node:assert/strict";
import { access, cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { rustNativeToolchainMatches } from "../src/rust-toolchain-native.js";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { planSchema } from "../src/schemas.js";
import { fixture } from "./helpers.js";
import { rustWorkspaceFiles } from "./rust-workspace-fixture.js";
import {
  rustAtomic,
  rustOriginal,
  rustReceipt,
  rustExtensionsSkip as skip,
} from "./rust-extensions-fixture.js";
test("Rust extension planning binds the source fingerprint and exact native toolchain declaration without executing build scripts", async (t) => {
  const files = rustWorkspaceFiles(["rust.cargo-check"]);
  const raw = JSON.parse(files["checktrail.rust-build.json"]!);
  raw.profiles = raw.profiles.slice(1).map((p: Record<string, unknown>) => ({
    ...p,
    nativeToolchain: "linux-arm64-gnu-1.98.1",
  }));
  files["checktrail.rust-build.json"] = JSON.stringify(raw);
  files["a/build.rs"] =
    'fn main(){std::fs::write("executed.marker","forbidden").unwrap();}\n';
  const root = await fixture(t, files);
  const { source, plan } = await createPlan(root);
  assert.deepEqual(planSchema.parse(plan), plan);
  assert.equal(plan.checks.length, 1);
  const command = plan.checks[0]!.commands[0]!;
  assert.equal(command.temporaryDirectory, true);
  assert.equal(command.env?.RUSTUP_AUTO_INSTALL, "0");
  assert.equal(
    JSON.parse(command.args[1]!).sourceFingerprint,
    source.fingerprint,
  );
  assert.equal(
    plan.checks[0]!.rustBuild?.nativeToolchain,
    "linux-arm64-gnu-1.98.1",
  );
  await assert.rejects(access(path.join(root, "a/executed.marker")), {
    code: "ENOENT",
  });
  raw.profiles[0].nativeToolchain = "unknown";
  await rustAtomic(
    path.join(root, "checktrail.rust-build.json"),
    JSON.stringify(raw),
  );
  const refused = await createPlan(root);
  assert.ok(
    refused.plan.checks.every(
      (c) => c.unavailableReason && c.rustBuild === undefined,
    ),
  );
});
test(
  "native Rust workspace rechecks source after successful runtime witnesses instead of certifying source changed by a test",
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
    const file = path.join(f.root, "a/src/lib.rs");
    await writeFile(
      file,
      (await readFile(file, "utf8")) +
        '\n#[test] fn rewrite_current_source(){let source=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/extra.rs");let text=std::fs::read_to_string(&source).unwrap();std::fs::write(source,text+"// original witness changed these bytes\\n").unwrap();}\n',
    );
    const report = await validate(f.root, { trusted: true });
    assert.equal(report.sourceChanged, true);
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "inconclusive");
    assert.equal(
      rustReceipt(report.checks[0]!).inputsStable,
      false,
      "Actual post-witness inventory must invalidate completed native evidence",
    );
  },
);
test(
  "native Rust workspace rechecks selected executable bytes after successful test witnesses",
  { skip, timeout: 180000 },
  async (t) => {
    for (const mode of ["size", "digest"]) {
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
      const prefix = path.join(f.root, ".checktrail/mutable-native-tools");
      await cp("/opt/checktrail-rust", prefix, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      const changed = path.join(prefix, "bin/rustfmt");
      const file = path.join(f.root, "a/src/lib.rs");
      await writeFile(
        file,
        (await readFile(file, "utf8")) +
          "\n#[test] fn change_selected_native_tool(){let file=" +
          JSON.stringify(changed) +
          ";let mut bytes=std::fs::read(file).unwrap();" +
          (mode === "size"
            ? "bytes.push(0);"
            : "let last=bytes.len()-1;bytes[last]^=1;") +
          "std::fs::write(file,bytes).unwrap();}\n",
      );
      const originalPath = process.env.PATH;
      try {
        process.env.PATH =
          path.join(prefix, "bin") + path.delimiter + (originalPath ?? "");
        assert.equal(await rustNativeToolchainMatches(), true);
        const report = await validate(f.root, {
          trusted: true,
          timeoutMs: 120000,
        });
        const receipt = rustReceipt(report.checks[0]!);
        assert.ok(
          receipt.tests!.groups.some((g) =>
            /change_selected_native_tool.*ok/.test(g.execution!.stdout),
          ),
        );
        assert.equal(receipt.inputsStable, true);
        assert.equal(report.sourceChanged, false);
        assert.equal(
          receipt.nativeToolchainVerified,
          false,
          "Selected executable bytes changed after a completed native witness must invalidate the receipt",
        );
        assert.equal(report.checks[0]!.status, "inconclusive");
        assert.equal(report.outcome, "incomplete");
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(prefix, { recursive: true, force: true });
      }
    }
  },
);
