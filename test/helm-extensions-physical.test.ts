import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import {
  helmExtensionsConfig,
  helmExtensionsFixture,
  helmExtensionsFiles,
} from "./helm-extensions-fixture.js";
import {
  helmExtensionsCurrent,
  helmExtensionsVerify,
} from "../src/helm-extensions-physical.js";
import { helmExtensionsPolicyFile } from "../src/helm-extensions-contract.js";
import { mavenHash } from "../src/maven.js";
test("Helm extension physical cohort binds declaration chart schemas values templates and bounded metadata against current bytes", async (t) => {
  const root = await helmExtensionsFixture(t);
  await writeFile(
    path.join(root, "README.md"),
    "original synthetic metadata\n",
  );
  const current = helmExtensionsCurrent(root);
  assert.equal(current.files.length, 14);
  assert.deepEqual(
    current.invocation.inputs.map((i) => i.path),
    current.files,
  );
  for (const i of current.invocation.inputs)
    assert.equal(i.sha256, mavenHash(await readFile(path.join(root, i.path))));
  assert.deepEqual(
    helmExtensionsVerify(root, current.invocation).invocation,
    current.invocation,
  );
  await writeFile(path.join(root, "README.md"), "changed synthetic metadata\n");
  assert.throws(
    () => helmExtensionsVerify(root, current.invocation),
    /Current physical/,
  );
  await writeFile(
    path.join(root, "README.md"),
    "original synthetic metadata\n",
  );
  const c = helmExtensionsConfig();
  c.charts[1]!.values.count = 0;
  for (const [f, text] of Object.entries(helmExtensionsFiles(c)))
    await writeFile(path.join(root, f), text);
  assert.doesNotThrow(() => helmExtensionsCurrent(root));
  assert.throws(
    () => helmExtensionsVerify(root, current.invocation),
    /Current physical/,
  );
});
test("Helm extension physical import rejects undeclared native paths duplicate declarations changed templates and aliases", async (t) => {
  const root = await helmExtensionsFixture(t);
  for (const name of [
    "Chart.lock",
    ".helmignore",
    "foreign.yaml",
    "foreign.json",
    "foreign.tpl",
    "foreign.tgz",
  ]) {
    await writeFile(
      path.join(root, name),
      "original unsupported native input\n",
    );
    assert.throws(() => helmExtensionsCurrent(root), /entire physical chart/);
    await rm(path.join(root, name));
  }
  const file = path.join(root, "charts/worker/templates/object.yaml"),
    original = await readFile(file);
  await writeFile(file, Buffer.concat([original, Buffer.from("# altered\n")]));
  assert.throws(() => helmExtensionsCurrent(root), /declared bytes/);
  await writeFile(file, original);
  await rm(file);
  await symlink(path.join(root, "templates/object.yaml"), file);
  try {
    assert.throws(() => helmExtensionsCurrent(root), /aliases/);
  } finally {
    await rm(file);
    await writeFile(file, original);
  }
  const policy = path.join(root, helmExtensionsPolicyFile),
    text = await readFile(policy, "utf8");
  await writeFile(
    policy,
    text.replace(
      '"schemaVersion": 1,',
      '"schemaVersion": 1, "schemaVersion": 1,',
    ),
  );
  assert.throws(() => helmExtensionsCurrent(root), /unique-key JSON/);
});

test("Helm extension rendering canonicalizes optional property order while retaining the original declaration fingerprint", async (t) => {
  const c = helmExtensionsConfig();
  const label = c.charts[0]!.properties.label!;
  assert.equal(label!.type, "string");
  if (label!.type !== "string")
    throw new Error("Original fixture schema differs");
  label.enum = ["root", "other"];
  const root = await helmExtensionsFixture(t, c),
    current = helmExtensionsCurrent(root);
  assert.deepEqual(current.config.charts[0]!.properties.label, label);
  assert.equal(
    current.invocation.configSha256,
    mavenHash(await readFile(path.join(root, helmExtensionsPolicyFile))),
  );
});
