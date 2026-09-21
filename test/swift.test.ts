import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { planSchema } from "../src/schemas.js";
import { fixture } from "./helpers.js";

const available =
  spawnSync("swiftc", ["--version"], { timeout: 10_000 }).status === 0;
test("Swift planning covers exact Swift sources and never evaluates a package manifest", async (t) => {
  const root = await fixture(t, {
    "Package.swift": 'fatalError("Manifest must not run")',
    "Sources/Item.swift": "",
    "Sources/Item.swift.backup": "",
    "Sources/Item.h": "",
    ".build/dependency/Package.swift": "fatalError()",
  });
  const { plan } = await createPlan(root);
  planSchema.parse(plan);
  assert.ok(plan.excluded.includes(".build"));
  assert.deepEqual(plan.checks[0]!.scope, [
    "Package.swift",
    "Sources/Item.swift",
  ]);
  assert.ok(
    plan.checks[0]!.commands.every(
      (command) =>
        command.args.includes("-parse") && !command.args.includes("-typecheck"),
    ),
  );
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
});

test(
  "native Swift syntax checks the public package without manifest execution, catches broken grammar and distinguishes parsing from type checking",
  { skip: available ? false : "Swift compiler unavailable", timeout: 60_000 },
  async (t) => {
    const root = await fixture(t, {});
    await cp(
      fileURLToPath(new URL("../../examples/swift", import.meta.url)),
      root,
      { recursive: true },
    );
    await writeFile(
      path.join(root, "not_executed.swift"),
      'import Foundation\ntry "sentinel".write(toFile: "executed", atomically: true, encoding: .utf8)\n',
    );
    const plan = (await createPlan(root)).plan;
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    assert.equal(passed.checks[0]!.tests, undefined);
    assert.equal(passed.checks[0]!.tools![0]!.status, "identified");
    await assert.rejects(access(path.join(root, "executed")));
    await assert.rejects(access(path.join(root, ".build")));
    const processes = passed.checks[0]!.processes;
    assert.equal(
      evaluate(
        plan.checks[0]!,
        processes.map((process, index) =>
          index === 0
            ? { ...process, stdout: "unexpected success text" }
            : process,
        ),
      ).status,
      "inconclusive",
    );
    await writeFile(
      path.join(root, "Sources/Catalog/Quantity.swift"),
      "public func quantityLabel(\n",
    );
    const failed = await validate(root, { trusted: true });
    assert.equal(failed.outcome, "failed");
    assert.ok(
      failed.checks[0]!.processes.some(
        (process) =>
          process.command.args.at(-1) === "./Sources/Catalog/Quantity.swift" &&
          process.exitCode !== 0 &&
          process.stderr.includes("error:"),
      ),
    );
    await writeFile(
      path.join(root, "Sources/Catalog/Quantity.swift"),
      'let syntacticallyValidButTypeIncorrect: Int = "two"\n',
    );
    const syntaxOnly = await validate(root, { trusted: true });
    assert.equal(syntaxOnly.outcome, "passed");
    assert.equal(syntaxOnly.checks[0]!.id, "swift.syntax");
  },
);
