import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import { helmExtensionsFixture } from "./helm-extensions-fixture.js";
import { helmProtectedEnvironment } from "../src/helm.js";
import { helmExtensionsCurrent } from "../src/helm-extensions-physical.js";
import { planSchema } from "../src/schemas.js";
test("Helm extension passive discovery keeps aliased local charts in one physical cohort without running project code", async (t) => {
  const root = await helmExtensionsFixture(t),
    current = helmExtensionsCurrent(root),
    { plan } = await createPlan(root);
  assert.deepEqual(
    plan.projects.map((p) => [p.path, p.adapter]),
    [[".", "infrastructure"]],
  );
  assert.equal(plan.checks.length, 1);
  const check = plan.checks[0]!;
  assert.equal(check.id, "infrastructure.helm-extensions");
  assert.equal(check.unavailableReason, undefined);
  assert.deepEqual(check.scope, current.files);
  assert.equal(check.commands.length, 1);
  assert.deepEqual(check.commands[0]!.args.slice(1), [
    root,
    JSON.stringify(current.invocation),
  ]);
  assert.equal(check.commands[0]!.temporaryDirectory, true);
  assert.deepEqual(planSchema.parse(plan), plan);
  for (const key of [...helmProtectedEnvironment, "NODE_OPTIONS", "NODE_PATH"])
    assert.equal(check.commands[0]!.env?.[key], "");
  await assert.rejects(
    validate(root, { trusted: false }),
    /Execution requires operator trust/,
  );
  await writeFile(
    path.join(root, "foreign.yaml"),
    "kind: OriginalUndeclared\n",
  );
  const broken = await createPlan(root);
  assert.equal(broken.plan.checks[0]!.commands.length, 0);
  assert.match(broken.plan.checks[0]!.unavailableReason!, /outside/);
});
test("Helm extension discovery preserves unrelated infrastructure and project boundaries rather than silently omitting child inputs", async (t) => {
  const root = await helmExtensionsFixture(t);
  await writeFile(
    path.join(root, "charts/worker/checktrail.kubeconform.json"),
    "{}",
  );
  const { plan } = await createPlan(root);
  assert.deepEqual(
    plan.projects.map((p) => [p.path, p.adapter]),
    [
      [".", "infrastructure"],
      ["charts/worker", "infrastructure"],
    ],
  );
  const rootCheck = plan.checks.find(
    (c) => c.id === "infrastructure.helm-extensions" && c.project === ".",
  )!;
  assert.equal(rootCheck.commands.length, 0);
  assert.ok(rootCheck.unavailableReason);
  const nested = path.join(root, "charts/worker/original-project");
  await mkdir(nested);
  await writeFile(
    path.join(nested, "package.json"),
    JSON.stringify({ scripts: { test: "node executed-project.js" } }),
  );
  await writeFile(
    path.join(nested, "executed-project.js"),
    'throw new Error("Discovery must not execute this original fixture")',
  );
  const mixed = await createPlan(root);
  assert.ok(
    mixed.plan.projects.some(
      (p) =>
        p.path === "charts/worker/original-project" &&
        p.adapter === "javascript",
    ),
  );
  assert.equal(
    mixed.plan.checks.find(
      (c) => c.id === "infrastructure.helm-extensions" && c.project === ".",
    )!.commands.length,
    0,
  );
});
test("Helm extension operator environment cannot replace protected command root tool or cluster settings", async (t) => {
  const root = await helmExtensionsFixture(t);
  for (const key of [
    "PATH",
    "KUBECONFIG",
    "HELM_KUBEAPISERVER",
    "HELM_PLUGINS",
    "HELM_CONFIG_HOME",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) {
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["infrastructure.helm-extensions"],
            environment: [key],
          },
        ],
      }),
    );
    await assert.rejects(
      createPlan(root, { environment: { [key]: "original-override" } }),
      /protected adapter settings/,
      key,
    );
  }
});
