import assert from "node:assert/strict";
import { test } from "node:test";
import {
  terraformExtensionsConfig,
  terraformExtensionsFiles,
} from "./terraform-extensions-fixture.js";
import {
  terraformExtensionsConfigSchema,
  terraformExtensionsModules,
  terraformExtensionsRender,
  terraformExtensionsLock,
  terraformExtensionsExpressionSchema,
} from "../src/terraform-extensions-contract.js";

test("Terraform finite declaration preserves a reused transitive module graph and distinct HCL/JSON expression contexts", () => {
  const config = terraformExtensionsConfig(),
    files = terraformExtensionsFiles();
  assert.deepEqual(terraformExtensionsModules(config), [
    { key: "", source: "", directory: ".", id: "root" },
    {
      key: "first",
      source: "./modules/child",
      directory: "modules/child",
      id: "child",
    },
    {
      key: "first.leaf",
      source: "../leaf",
      directory: "modules/leaf",
      id: "leaf",
    },
    {
      key: "second",
      source: "./modules/child",
      directory: "modules/child",
      id: "child",
    },
    {
      key: "second.leaf",
      source: "../leaf",
      directory: "modules/leaf",
      id: "leaf",
    },
  ]);
  assert.deepEqual(Object.keys(files).sort(), [
    ".terraform.lock.hcl",
    "checktrail.terraform-extensions.json",
    "main.tf",
    "modules/child/main.tf.json",
    "modules/leaf/main.tf",
  ]);
  assert.equal(files[".terraform.lock.hcl"], terraformExtensionsLock);
  const child = JSON.parse(files["modules/child/main.tf.json"]!);
  assert.deepEqual(child.module.leaf, {
    source: "../leaf",
    providers: { random: "random" },
    floor: "${var.floor}",
  });
  assert.match(files["main.tf"]!, /providers = \{ random = random \}/);
  assert.match(files["main.tf"]!, /floor = var\.floor/);
  assert.match(files["modules/leaf/main.tf"]!, /min = var\.floor/);
  config.modules[2]!.resources.selected!.max = {
    reference: "var.floor",
    offset: -2,
  };
  config.modules[2]!.format = "json";
  const leaf = JSON.parse(
    terraformExtensionsRender(config)["modules/leaf/main.tf.json"]!,
  );
  assert.equal(leaf.resource.random_integer.selected.max, "${var.floor + -2}");
});

test("Terraform declaration rejects remote-install overrides cycles omitted modules and executable expressions while preserving exact identifier near misses", () => {
  for (const key of [
    "source",
    "version",
    "providers",
    "depends_on",
    "count",
    "for_each",
  ]) {
    const config = terraformExtensionsConfig();
    config.modules[0]!.calls[0]!.arguments[key] =
      "https://original.invalid/remote";
    assert.throws(
      () => terraformExtensionsRender(config),
      /Module meta-arguments/,
    );
  }
  const adjacent = terraformExtensionsConfig();
  adjacent.modules[0]!.calls[0]!.arguments.source_name = "literal";
  assert.match(
    terraformExtensionsRender(adjacent)["main.tf"]!,
    /source_name = "literal"/,
  );
  const cycle = terraformExtensionsConfig();
  cycle.modules[2]!.calls.push({
    name: "cycle",
    target: "child",
    arguments: {},
  });
  assert.throws(() => terraformExtensionsRender(cycle), /cyclic/);
  const unreachable = terraformExtensionsConfig();
  unreachable.modules.push({
    ...structuredClone(unreachable.modules[2]!),
    id: "unreached",
    directory: "modules/unreached",
  });
  assert.throws(
    () => terraformExtensionsRender(unreachable),
    /Every local module/,
  );
  const duplicate = terraformExtensionsConfig();
  duplicate.modules[1]!.directory = ".";
  assert.throws(
    () => terraformExtensionsRender(duplicate),
    /directories repeated/,
  );
  const omitted = terraformExtensionsConfig();
  omitted.modules.splice(2, 1);
  assert.throws(
    () => terraformExtensionsRender(omitted),
    /Declare every local call target/,
  );
  for (const value of [
    '${file("original.txt")}',
    "%{for item in list}",
    { reference: "path.module" },
    { reference: "var.floor", script: "exec" },
    { reference: "var.floor", offset: 1.2 },
  ])
    assert.equal(
      terraformExtensionsExpressionSchema.safeParse(value).success,
      false,
    );
  const escape = terraformExtensionsConfig();
  escape.modules[1]!.directory = "../foreign";
  assert.equal(
    terraformExtensionsConfigSchema.safeParse(escape).success,
    false,
  );
  for (const key of [
    "count",
    "for_each",
    "provider",
    "depends_on",
    "lifecycle",
    "provisioner",
    "connection",
  ]) {
    const config = terraformExtensionsConfig();
    config.modules[2]!.resources.selected![key] = 1;
    assert.throws(
      () => terraformExtensionsRender(config),
      /Resource meta-arguments/,
    );
  }
  const defect = terraformExtensionsConfig();
  defect.modules[2]!.resources.selected!.max = "not numeric";
  assert.match(
    terraformExtensionsRender(defect)["modules/leaf/main.tf"]!,
    /max = "not numeric"/,
  );
});
