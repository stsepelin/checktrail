import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";
const profile = JSON.stringify({
  schemaVersion: 1,
  library: {
    sourceDirectory: "lib",
    entry: "lib/index.ts",
    consumers: ["use.ts"],
  },
});
const files = {
  "package.json": '{"type":"module"}',
  "checktrail.json": JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: ".", checks: ["javascript.vite-library"] }],
  }),
  "checktrail.javascript.json": profile,
  "lib/index.ts": "export {value} from './value.js';",
  "lib/value.ts": "export const value: number=42;",
  "use.ts":
    "import {value} from 'checktrail:library';export const actual: number=value;",
  "dist/index.d.ts": "export declare const value: string;",
};
const skip = !(
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" &&
    process.arch === "arm64" &&
    !(
      process.report.getReport() as {
        header?: { glibcVersionRuntime?: string };
      }
    ).header?.glibcVersionRuntime)
)
  ? "Selected native library platform unavailable"
  : false;
const native = async (root: string) =>
  copyInstalledPackages(root, ["vite", "typescript"]);
test(
  "native library emits both formats and fresh declarations and detects producer and downstream defects",
  { skip, timeout: 60000 },
  async (t) => {
    const root = await fixture(t, files);
    await native(root);
    const passed = await validate(root, { trusted: true });
    assert.equal(
      passed.outcome,
      "passed",
      passed.checks[0]!.reason + " " + passed.checks[0]!.processes[0]!.stderr,
    );
    const process = passed.checks[0]!.processes[0]!;
    const raw = JSON.parse(process.stdout);
    assert.equal(raw.complete, true);
    assert.deepEqual(
      raw.builds.map((b: { format: string }) => b.format),
      ["es", "cjs"],
    );
    assert.deepEqual(
      raw.builds.map(
        (b: { chunks: { exports: string[] }[] }) => b.chunks[0]!.exports,
      ),
      [["value"], ["value"]],
    );
    assert.ok(
      raw.declarations.some((d: { path: string }) => d.path === "index.d.ts"),
    );
    assert.equal(passed.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, "dist/index.d.ts"), "utf8"),
      files["dist/index.d.ts"],
    );
    await assert.rejects(access(path.join(root, ".checktrail")));
    await writeFile(
      path.join(root, "lib/value.ts"),
      'export const value: number="incorrect";',
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed");
    assert.ok(
      broken.checks[0]!.findings?.some(
        (f) => f.ruleId === "TS2322" && f.file === "lib/value.ts",
      ),
    );
    await writeFile(
      path.join(root, "lib/value.ts"),
      'export const value: string="valid producer, incompatible consumer";',
    );
    const incompatible = await validate(root, { trusted: true });
    assert.equal(incompatible.outcome, "failed");
    assert.ok(
      incompatible.checks[0]!.findings?.some(
        (f) => f.ruleId === "TS2322" && f.file === "use.ts",
      ),
    );
    await writeFile(
      path.join(root, "use.ts"),
      files["use.ts"].replace("actual: number", "actual: string"),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await writeFile(
      path.join(root, "lib/orphan.ts"),
      "export const unreachable=3;",
    );
    const omitted = await validate(root, { trusted: true });
    assert.equal(omitted.outcome, "incomplete");
    assert.equal(
      JSON.parse(omitted.checks[0]!.processes[0]!.stdout).complete,
      false,
    );
  },
);
test(
  "native library refuses forged declaration, format, export, module and consumer accounting",
  { skip, timeout: 30000 },
  async (t) => {
    const root = await fixture(t, files);
    await native(root);
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      "passed",
      report.checks[0]!.processes[0]!.stderr,
    );
    const process = report.checks[0]!.processes[0]!;
    const planned = (await createPlan(root)).plan.checks[0]!;
    for (const change of [
      "manifest",
      "declarations",
      "formats",
      "exports",
      "modules",
      "consumer",
      "resolution",
      "external",
    ]) {
      const raw = JSON.parse(process.stdout);
      if (change === "manifest")
        raw.manifest.sourceFingerprint = "0".repeat(64);
      if (change === "declarations") raw.declarations = [];
      if (change === "formats") raw.builds[1].format = "es";
      if (change === "exports") raw.builds[1].chunks[0].exports = ["different"];
      if (change === "modules") raw.builds[0].modules.pop();
      if (change === "consumer") raw.consumerFiles = [];
      if (change === "resolution") raw.resolutions = [];
      if (change === "external")
        raw.builds[0].chunks[0].imports = ["outside-library"];
      assert.equal(
        evaluate(planned, [{ ...process, stdout: JSON.stringify(raw) }], root)
          .status,
        "inconclusive",
        change,
      );
    }
  },
);
test("native library planning imports no tool and changed selected API bytes remain unavailable", async (t) => {
  const root = await fixture(t, {
    ...files,
    "node_modules/vite/dist/node/index.js":
      "import fs from 'node:fs';fs.writeFileSync('executed','yes');",
    "node_modules/typescript/lib/typescript.js":
      "require('node:fs').writeFileSync('compiled','yes');",
  });
  assert.equal(
    (await createPlan(root)).plan.checks[0]!.unavailableReason,
    undefined,
  );
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(access(path.join(root, "compiled")));
  await native(root);
  const entry = path.join(root, "node_modules/vite/dist/node/index.js");
  await writeFile(entry, (await readFile(entry, "utf8")) + "\n");
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.checks[0]!.status, "unavailable");
  assert.equal(
    JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
    "runtime-byte-mismatch",
  );
  await assert.rejects(access(path.join(root, "executed")));
});
