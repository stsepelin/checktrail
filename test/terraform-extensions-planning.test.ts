import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { inventory } from "../src/inventory.js";
import { discover } from "../src/adapters.js";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { terraformExtensionsFiles } from "./terraform-extensions-fixture.js";
import { terraformExtensionsPolicyFile } from "../src/terraform-extensions-contract.js";
import {
  terraformExtensionsInvocationSchema,
  terraformExtensionsVerify,
} from "../src/terraform-extensions-physical.js";

test("Terraform extension discovery owns only Terraform-only descendants and retains adjacent infrastructure boundaries", async (t) => {
  const files = Object.fromEntries(
    Object.entries(terraformExtensionsFiles()).map(([p, v]) => [
      "infra/" + p,
      v,
    ]),
  );
  const root = await fixture(t, {
    ...files,
    "other/main.tf": "locals { original = 1 }\n",
    "infra/chart/Chart.yaml":
      "apiVersion: v2\nname: original\nversion: 1.0.0\n",
    "infra/mixed/main.tf": "locals { original = 1 }\n",
    "infra/mixed/checktrail.kubeconform.json": "{}\n",
  });
  const projects = discover(await inventory(root));
  assert.deepEqual(
    projects.map((p) => ({ path: p.path, adapter: p.adapter })),
    [
      { path: "infra", adapter: "infrastructure" },
      { path: "infra/chart", adapter: "infrastructure" },
      { path: "infra/mixed", adapter: "infrastructure" },
      { path: "other", adapter: "infrastructure" },
    ],
  );
  const parent = projects[0]!;
  assert.ok(parent.files.includes("modules/leaf/main.tf"));
  assert.ok(parent.files.includes("modules/child/main.tf.json"));
  assert.ok(
    !parent.files.some((p) => p.startsWith("chart/") || p.startsWith("mixed/")),
  );
  assert.deepEqual(projects[3]!.files, ["main.tf"]);
  // Removing the opt-in declaration restores all pre-existing Terraform boundaries.
  await writeFile(
    path.join(root, "infra", terraformExtensionsPolicyFile + ".disabled"),
    files["infra/" + terraformExtensionsPolicyFile]!,
  );
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(root, "infra", terraformExtensionsPolicyFile));
  assert.deepEqual(
    discover(await inventory(root)).map((p) => p.path),
    [
      "infra",
      "infra/chart",
      "infra/mixed",
      "infra/modules/child",
      "infra/modules/leaf",
      "other",
    ],
  );
});

test("Terraform extension planning selects one complete local graph without executing source and preserves startup-only trust", async (t) => {
  const root = await fixture(t, terraformExtensionsFiles());
  const planned = await createPlan(root),
    check = planned.plan.checks[0]!;
  assert.deepEqual(
    planned.plan.checks.map((c) => c.id),
    ["infrastructure.terraform-extensions"],
  );
  assert.equal(check.unavailableReason, undefined);
  assert.equal(check.commands.length, 1);
  assert.equal(check.parser, "terraform-extensions-json");
  assert.deepEqual(check.scope, planned.source.files);
  const invocation = terraformExtensionsInvocationSchema.parse(
    JSON.parse(check.commands[0]!.args[2]!),
  );
  assert.equal(
    terraformExtensionsVerify(planned.source.root, invocation).config.modules
      .length,
    3,
  );
  assert.ok(!JSON.stringify(invocation).includes("var.floor"));
  assert.equal(check.commands[0]!.env!.TF_CLI_ARGS, "");
  assert.equal(check.commands[0]!.env!.NODE_OPTIONS, "");
  assert.equal(check.commands[0]!.env!.TF_CLI_ARGS_providers, "");
  await assert.rejects(
    validate(root, { trusted: false }),
    /requires operator trust/,
  );
  const file = path.join(root, "main.tf"),
    original = await readFile(file, "utf8"),
    marker = path.join(root, "original-must-not-run");
  try {
    await writeFile(
      file,
      original +
        `resource "terraform_data" "original" { provisioner "local-exec" { command = "touch ${marker}" } }\n`,
    );
    const bad = await createPlan(root);
    assert.ok(bad.plan.checks[0]!.unavailableReason);
    assert.deepEqual(bad.plan.checks[0]!.commands, []);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await writeFile(file, original);
  }
  assert.equal(
    (await createPlan(root)).plan.checks[0]!.unavailableReason,
    undefined,
  );
});

test("Terraform extension operator environment cannot replace command source or provider settings", async (t) => {
  const root = await fixture(t, terraformExtensionsFiles());
  for (const key of [
    "PATH",
    "TF_CLI_ARGS",
    "TF_DATA_DIR",
    "TF_CLI_CONFIG_FILE",
    "TF_REATTACH_PROVIDERS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT",
  ]) {
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["infrastructure.terraform-extensions"],
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
