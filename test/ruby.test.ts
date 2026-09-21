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
  spawnSync("ruby", ["--disable-gems", "--version"], { timeout: 10_000 })
    .status === 0;
test("Ruby scope includes nested DSL manifests and exact source extensions without loading gems or evaluating manifests", async (t) => {
  const root = await fixture(t, {
    Gemfile: "raise 'not executable during discovery'",
    "nested/Gemfile": "",
    Rakefile: "",
    "catalog.gemspec": "",
    "tasks/catalog.rake": "",
    "catalog.rb": "",
    "catalog.rb.backup": "",
    "view.erb": "",
  });
  const { plan } = await createPlan(root);
  planSchema.parse(plan);
  const check = plan.checks.find((item) => item.project === ".")!;
  assert.deepEqual(
    new Set(check.scope),
    new Set([
      "Gemfile",
      "Rakefile",
      "catalog.gemspec",
      "catalog.rb",
      "tasks/catalog.rake",
    ]),
  );
  assert.ok(
    plan.checks
      .find((item) => item.project === "nested")!
      .scope.includes("Gemfile"),
  );
  assert.ok(
    check.commands.every(
      (command) =>
        command.args[0] === "--disable-gems" && command.args[1] === "-c",
    ),
  );
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
});

test(
  "native Ruby checks the public example and broken/fixed source without executing top-level or BEGIN code",
  { skip: available ? false : "Ruby unavailable", timeout: 30_000 },
  async (t) => {
    const root = await fixture(t, {});
    await cp(
      fileURLToPath(new URL("../../examples/ruby", import.meta.url)),
      root,
      { recursive: true },
    );
    await writeFile(
      path.join(root, "side_effect.rb"),
      'BEGIN { File.write("begin-executed", "yes") }\nFile.write("top-level-executed", "yes")\n',
    );
    const plan = (await createPlan(root)).plan;
    const good = await validate(root, { trusted: true });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(good.sourceChanged, false);
    assert.equal(good.checks[0]!.tests, undefined);
    assert.equal(good.checks[0]!.tools![0]!.status, "identified");
    await assert.rejects(access(path.join(root, "begin-executed")));
    await assert.rejects(access(path.join(root, "top-level-executed")));
    const native = good.checks[0]!.processes;
    assert.equal(
      evaluate(
        plan.checks[0]!,
        native.map((process, index) =>
          index === 0 ? { ...process, stdout: "" } : process,
        ),
      ).status,
      "inconclusive",
    );
    assert.equal(
      evaluate(
        plan.checks[0]!,
        native.map((process, index) =>
          index === 0
            ? { ...process, stderr: "warning: synthetic ambiguity" }
            : process,
        ),
      ).status,
      "inconclusive",
    );
    await writeFile(path.join(root, "catalog.rb"), "def quantity_label(\n");
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed");
    assert.ok(
      broken.checks[0]!.processes.some(
        (process) =>
          process.command.args.at(-1) === "./catalog.rb" &&
          process.exitCode !== 0 &&
          /syntax error|SyntaxError/.test(process.stderr),
      ),
    );
    await writeFile(
      path.join(root, "catalog.rb"),
      'def quantity_label(quantity)\n "syntax error is just literal text: #{quantity}"\nend\n',
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);
