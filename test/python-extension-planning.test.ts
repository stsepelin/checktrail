import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPlan } from "../src/engine.js";
import { pythonConfigSchema } from "../src/python-extensions.js";
import { fixture } from "./helpers.js";
const plugin =
  "from pathlib import Path\nPath('planning-executed-project').write_text('unexpected')\n";
const sha256 = createHash("sha256").update(plugin).digest("hex");
test("Python extension planning binds declared source and plugin bytes without importing configuration", async (t) => {
  const root = await fixture(t, {
    "pyproject.toml": '[tool.mypy]\nplugins=["plugins/type_rules.py"]\n',
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["python.pytest", "python.mypy"] }],
    }),
    "checktrail.python.json": JSON.stringify({
      schemaVersion: 1,
      moduleRoots: ["src"],
      pytestPlugins: [
        { module: "case_plugin", path: "plugins/case_plugin.py", sha256 },
      ],
      mypyPlugins: [{ path: "plugins/type_rules.py", sha256 }],
    }),
    "src/value.py": "value: int = 42\n",
    "src/test_value.py": "def test_value():\n    assert True\n",
    "outside/invalid.py": "not valid python !!!",
    "plugins/type_rules.py": plugin,
    "plugins/case_plugin.py": plugin,
  });
  const plan = (await createPlan(root)).plan;
  assert.equal(plan.checks.length, 2);
  assert.deepEqual(
    plan.checks.map((c) => c.scope),
    [["src/test_value.py"], ["src/test_value.py", "src/value.py"]],
  );
  for (const check of plan.checks) {
    assert.equal(check.unavailableReason, undefined);
    const manifest = JSON.parse(check.commands[0]!.args.at(-1)!);
    assert.equal(manifest.sourceFingerprint, plan.sourceFingerprint);
    assert.equal(
      manifest.bindings.filter((f: { path: string }) =>
        f.path.startsWith("plugins/"),
      ).length,
      1,
    );
  }
  await assert.rejects(access(path.join(root, "planning-executed-project")));
  const before = await readFile(
    path.join(root, "plugins/type_rules.py"),
    "utf8",
  );
  await writeFile(
    path.join(root, "plugins/type_rules.py"),
    before + "# changed\n",
  );
  assert.match(
    (await createPlan(root)).plan.checks[1]!.unavailableReason!,
    /plugin bytes changed/,
  );
  await assert.rejects(access(path.join(root, "planning-executed-project")));
});
test("Python extension declarations retain exact path boundaries and explicit namespace root selection", () => {
  assert.equal(
    pythonConfigSchema.safeParse({ schemaVersion: 1, moduleRoots: ["."] })
      .success,
    true,
  );
  for (const root of [
    "../src",
    "src/../other",
    "/src",
    "C:/src",
    "src//other",
    "src/",
    "src\\other",
  ])
    assert.equal(
      pythonConfigSchema.safeParse({ schemaVersion: 1, moduleRoots: [root] })
        .success,
      false,
      root,
    );
  assert.equal(
    pythonConfigSchema.safeParse({ schemaVersion: 1, moduleRoots: [] }).success,
    false,
  );
  assert.equal(
    pythonConfigSchema.safeParse({
      schemaVersion: 1,
      moduleRoots: ["src"],
      trusted: true,
    }).success,
    false,
  );
});
