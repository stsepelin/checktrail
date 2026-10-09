import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { runProcess } from "../src/runner.js";
import { evaluate } from "../src/evidence.js";
import { fixture } from "./helpers.js";
import {
  loaderFiles as files,
  loaderProfile as profile,
  cjs,
  asyncEsm,
} from "./javascript-extensions-fixture.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test("declared ESM and CJS native loaders reach each typed test and preserve assertion failures", async (t) => {
  const root = await fixture(t, files);
  const planned = (await createPlan(root)).plan.checks[0]!;
  assert.equal(planned.parser, "node-loader-events");
  assert.deepEqual(planned.scope, ["cjs.test.cts", "esm.test.mts"]);
  const manifest = JSON.parse(planned.commands[0]!.args[2]!);
  assert.deepEqual(
    manifest.loaders.map((l: { kind: string }) => l.kind),
    ["require", "import"],
  );
  const passed = await validate(root, { trusted: true });
  assert.equal(passed.outcome, "passed", passed.checks[0]!.reason);
  assert.deepEqual(passed.checks[0]!.tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  for (const name of ["cjs.test.cts", "esm.test.mts"]) {
    await writeFile(
      path.join(root, name),
      files[name as keyof typeof files].replace("actual,42", "actual,43"),
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed");
    assert.equal(broken.checks[0]!.tests?.failed, 1);
    await writeFile(path.join(root, name), files[name as keyof typeof files]);
  }
  for (const change of [
    "end",
    "manifest",
    "file",
    "duplicate",
    "malformed",
    "runtime",
  ]) {
    const process = passed.checks[0]!.processes[0]!;
    const events = process.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (change === "end") events.pop();
    if (change === "manifest")
      events.at(-1).manifest.loaders[0].sha256 = "0".repeat(64);
    if (change === "file")
      events.find((e) => e.type === "test:summary" && e.data?.file).data.file =
        path.join(root, "unselected.test.cts");
    if (change === "runtime") {
      events[0].runtime = "22.0.0";
      events.at(-1).runtime = "22.0.0";
    }
    if (change === "duplicate") events.push(events.at(-1));
    const stdout =
      change === "malformed"
        ? "not-json"
        : events.map((e) => JSON.stringify(e)).join("\n");
    assert.equal(
      evaluate(planned, [{ ...process, stdout }], root).status,
      "inconclusive",
      change,
    );
  }
});
test("native loader planning does not import hooks and rejects absent, changed and out-of-root declarations", async (t) => {
  const sentinel =
    "import fs from 'node:fs';fs.writeFileSync('executed','yes');";
  const root = await fixture(t, {
    ...files,
    "esm hook.mjs": sentinel,
    "checktrail.javascript.json": JSON.stringify({
      schemaVersion: 1,
      nodeTest: {
        loaders: [
          { kind: "import", path: "esm hook.mjs", sha256: hash(sentinel) },
        ],
      },
    }),
  });
  await createPlan(root);
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")));
  await writeFile(path.join(root, "checktrail.javascript.json"), profile());
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /bytes/,
  );
  for (const name of [
    "absent.cjs",
    "../outside.cjs",
    "/absolute.cjs",
    "C:/absolute.cjs",
    "dir\\hook.cjs",
  ]) {
    await writeFile(
      path.join(root, "checktrail.javascript.json"),
      JSON.stringify({
        schemaVersion: 1,
        nodeTest: {
          loaders: [{ kind: "require", path: name, sha256: hash(cjs) }],
        },
      }),
    );
    if (name === "absent.cjs")
      assert.match(
        (await createPlan(root)).plan.checks[0]!.unavailableReason!,
        /absent/,
      );
    else await assert.rejects(createPlan(root));
  }
});
test("declared native loaders refuse skipped-only, empty and hook-modified execution", async (t) => {
  const root = await fixture(t, files);
  await writeFile(
    path.join(root, "esm.test.mts"),
    files["esm.test.mts"].replace("test(", "test.skip("),
  );
  await writeFile(
    path.join(root, "cjs.test.cts"),
    files["cjs.test.cts"].replace("test(", "test.skip("),
  );
  const skipped = await validate(root, { trusted: true });
  assert.equal(skipped.outcome, "incomplete");
  assert.equal(skipped.checks[0]!.tests?.skipped, 2);
  await writeFile(path.join(root, "esm.test.mts"), "export {}; ");
  await writeFile(path.join(root, "cjs.test.cts"), "module.exports={};");
  assert.equal((await validate(root, { trusted: true })).outcome, "incomplete");
  const mutating = cjs + "require('node:fs').appendFileSync(__filename,' ');";
  await writeFile(path.join(root, "cjs hook.cjs"), mutating);
  const changed = JSON.parse(profile());
  changed.nodeTest.loaders[1].sha256 = hash(mutating);
  await writeFile(
    path.join(root, "checktrail.javascript.json"),
    JSON.stringify(changed),
  );
  await writeFile(path.join(root, "esm.test.mts"), files["esm.test.mts"]);
  await writeFile(path.join(root, "cjs.test.cts"), files["cjs.test.cts"]);
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.sourceChanged, true);
  assert.match(report.checks[0]!.processes[0]!.stderr, /loader changed/);
  assert.notEqual(
    await readFile(path.join(root, "cjs hook.cjs"), "utf8"),
    mutating,
  );
});

test("native loader re-verifies planned hooks and tests before launching any selected test", async (t) => {
  for (const changed of ["hook", "test"]) {
    const hook = cjs + "require('node:fs').writeFileSync('hook-ran','yes');";
    const config = JSON.parse(profile());
    config.nodeTest.loaders[1].sha256 = hash(hook);
    const root = await fixture(t, {
      ...files,
      "cjs hook.cjs": hook,
      "checktrail.javascript.json": JSON.stringify(config),
    });
    const planned = (await createPlan(root)).plan.checks[0]!;
    const file = path.join(
      root,
      changed === "hook" ? "cjs hook.cjs" : "cjs.test.cts",
    );
    await writeFile(file, (await readFile(file, "utf8")) + "\n");
    const process = await runProcess(root, planned.commands[0]!, {
      timeoutMs: 10000,
    });
    assert.equal(process.exitCode, 3);
    assert.equal(JSON.parse(process.stdout).reason, "source-or-hook-mismatch");
    await assert.rejects(access(path.join(root, "hook-ran")));
  }
});

test("declared asynchronous ESM hooks preserve native typed test participation", async (t) => {
  const { "cjs.test.cts": omitted, ...selected } = files;
  assert.ok(omitted);
  const root = await fixture(t, {
    ...selected,
    "esm hook.mjs": asyncEsm,
    "checktrail.javascript.json": JSON.stringify({
      schemaVersion: 1,
      nodeTest: {
        loaders: [
          { kind: "import", path: "esm hook.mjs", sha256: hash(asyncEsm) },
        ],
      },
    }),
  });
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "passed", report.checks[0]!.reason);
  assert.deepEqual(report.checks[0]!.tests, {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
  });
});
