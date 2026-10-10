import assert from "node:assert/strict";
import { readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import {
  terraformExtensionsConfig,
  terraformExtensionsFiles,
} from "./terraform-extensions-fixture.js";
import {
  terraformExtensionsPolicyFile,
  terraformExtensionsRender,
} from "../src/terraform-extensions-contract.js";
import {
  terraformExtensionsCurrent,
  terraformExtensionsVerify,
} from "../src/terraform-extensions-physical.js";
import { mavenHash } from "../src/maven.js";

test("Terraform current physical cohort binds every declared source lock policy and inventoried metadata byte", async (t) => {
  const root = await realpath(
    await fixture(t, {
      ...terraformExtensionsFiles(),
      "README.md": "original synthetic metadata\n",
    }),
  );
  const current = terraformExtensionsCurrent(root);
  assert.equal(
    current.invocation.configSha256,
    mavenHash(await readFile(path.join(root, terraformExtensionsPolicyFile))),
  );
  assert.deepEqual(
    current.invocation.inputs.map((input) => input.path),
    current.files,
  );
  assert.equal(current.invocation.inputs.length, 6);
  for (const input of current.invocation.inputs)
    assert.equal(
      input.sha256,
      mavenHash(await readFile(path.join(root, input.path))),
    );
  assert.deepEqual(
    terraformExtensionsVerify(root, current.invocation).invocation,
    current.invocation,
  );
  await writeFile(path.join(root, "README.md"), "changed synthetic metadata\n");
  assert.throws(
    () => terraformExtensionsVerify(root, current.invocation),
    /Current physical input/,
  );
  await writeFile(
    path.join(root, "README.md"),
    "original synthetic metadata\n",
  );
  const config = terraformExtensionsConfig();
  config.modules[2]!.resources.selected!.max = 6;
  for (const [file, text] of Object.entries({
    ...terraformExtensionsRender(config),
    [terraformExtensionsPolicyFile]: JSON.stringify(config, null, 2) + "\n",
  }))
    await writeFile(path.join(root, file), text);
  assert.doesNotThrow(() => terraformExtensionsCurrent(root));
  assert.throws(
    () => terraformExtensionsVerify(root, current.invocation),
    /Current physical input/,
  );
});

test("Terraform physical import rejects undeclared modules cache inputs duplicate policy keys modified locks and source aliases", async (t) => {
  const root = await realpath(await fixture(t, terraformExtensionsFiles())),
    file = path.join(root, "main.tf"),
    original = await readFile(file);
  await writeFile(
    path.join(root, "undeclared.tf"),
    'output "foreign" { value = 1 }\n',
  );
  assert.throws(() => terraformExtensionsCurrent(root), /Declare every root/);
  await rm(path.join(root, "undeclared.tf"));
  for (const name of [
    "original.tfvars",
    "original.tfvars.json",
    "original.tfbackend",
    "terraform.tfstate",
    "terraform.tfstate.backup",
  ]) {
    await writeFile(path.join(root, name), "{}");
    assert.throws(() => terraformExtensionsCurrent(root), /State\/backend/);
    await rm(path.join(root, name));
  }
  await writeFile(file, Buffer.concat([original, Buffer.from("\n")]));
  assert.throws(
    () => terraformExtensionsCurrent(root),
    /Native source differs/,
  );
  await writeFile(file, original);
  const policyFile = path.join(root, terraformExtensionsPolicyFile),
    policy = await readFile(policyFile, "utf8");
  await writeFile(
    policyFile,
    policy.replace(
      '"schemaVersion": 1',
      '"schemaVersion": 1, "schemaVersion": 1',
    ),
  );
  assert.throws(() => terraformExtensionsCurrent(root), /Unique strict policy/);
  await writeFile(policyFile, policy);
  const lock = path.join(root, ".terraform.lock.hcl"),
    lockBytes = await readFile(lock);
  await writeFile(lock, Buffer.concat([lockBytes, Buffer.from("\n")]));
  assert.throws(
    () => terraformExtensionsCurrent(root),
    /Native source differs/,
  );
  await writeFile(lock, lockBytes);
  await rm(file);
  await writeFile(path.join(root, "original-source.txt"), original);
  await symlink("original-source.txt", file);
  assert.throws(() => terraformExtensionsCurrent(root), /Declare every root/);
});
