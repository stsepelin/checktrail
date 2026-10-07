import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createPlan } from "../src/engine.js";
import { helmInputs, helmProtectedEnvironment } from "../src/helm.js";
import { mavenHash } from "../src/maven.js";
import { helmFixture, helmInvocation } from "./helm-fixture.js";
import { fixture } from "./helpers.js";
test("Helm planning is passive and rejects incomplete chart closure unsupported functions schemas and source spoofing", async (t) => {
  const root = await helmFixture(t),
    plan = (await createPlan(root)).plan;
  assert.equal(plan.checks.length, 1);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  assert.equal(plan.checks[0]!.parser, "helm-json");
  const automatic = await helmFixture(t);
  await unlink(path.join(automatic, "checktrail.json"));
  assert.deepEqual(
    (await createPlan(automatic)).plan.checks.map((c) => c.id),
    ["infrastructure.helm"],
  );
  const original = helmInvocation();
  for (const [file, update] of [
    ["templates/settings.yaml", () => '{{ lookup "v1" "Secret" "" "" }}\n'],
    ["templates/settings.yaml", () => '{{ .Files.Get "secret.yaml" }}\n'],
    ["templates/settings.yaml", () => "{{ randAlpha 4 }}\n"],
    ["templates/settings.yaml", () => '{{ tpl "original" . }}\n'],
    [
      "templates/settings.yaml",
      () => "# Source: original-worker/templates/worker.yaml\n",
    ],
    [
      "values.schema.json",
      () =>
        JSON.stringify({
          type: "object",
          $ref: "https://example.invalid/schema",
        }),
    ],
    ["Chart.yaml", (s) => s + "dependencies: []\n"],
    ["values.yaml", () => "replicas: 2\nreplicas: 3\nlabel: original\n"],
    ["values.yaml", () => "replicas: &original 2\nlabel: *original\n"],
  ] as [string, (s: string) => string][]) {
    const changed = globalThis.structuredClone(original),
      input = changed.inputs.find((i) => i.path === file)!;
    input.text = update(input.text);
    input.sha256 = mavenHash(input.text);
    assert.throws(() => helmInputs(changed), file);
  }
  for (const extra of [
    "Chart.lock",
    ".helmignore",
    "templates/_helpers.tpl",
    "charts/child/Chart.yaml",
    "crds/original.yaml",
    "unexpected.txt",
    "templates/original.key",
    "templates/build/original.yaml",
  ]) {
    const candidate = await fixture(t, {
      ...Object.fromEntries(original.inputs.map((i) => [i.path, i.text])),
      [extra]: "original\n",
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["infrastructure.helm"] }],
      }),
    });
    assert.ok(
      (await createPlan(candidate)).plan.checks.every(
        (c) => c.commands.length === 0,
      ),
      extra,
    );
  }
  const file = path.join(root, "checktrail.helm.json"),
    config = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...config,
      templates: ["templates/settings.yaml", "templates/settings.yaml"],
    }),
  );
  assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
});
test("Helm startup environment cannot override native chart cluster plugin and credential settings", async (t) => {
  const root = await helmFixture(t);
  for (const key of new Set(
    helmProtectedEnvironment.filter((key) => /^[A-Z_][A-Z0-9_]*$/.test(key)),
  )) {
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: ".", checks: ["infrastructure.helm"], environment: [key] },
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
