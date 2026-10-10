import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { terraformExtensionsPolicyFile } from "../src/terraform-extensions-contract.js";
import {
  terraformExtensionsConfigSchema,
  terraformExtensionsRender,
} from "../src/terraform-extensions-contract.js";
export function terraformExtensionsConfig() {
  return terraformExtensionsConfigSchema.parse({
    schemaVersion: 1,
    profile: "declared-local-modules-random-v1",
    terraformVersion: "1.16.5",
    provider: "registry.terraform.io/hashicorp/random",
    providerVersion: "3.9.1",
    platform: "linux_arm64",
    modules: [
      {
        id: "root",
        directory: ".",
        format: "hcl",
        variables: { floor: { type: "number", default: 2 } },
        locals: {},
        resources: {},
        calls: [
          {
            name: "first",
            target: "child",
            arguments: { floor: { reference: "var.floor" } },
          },
          { name: "second", target: "child", arguments: { floor: 3 } },
        ],
        outputs: {
          first: { reference: "module.first.picked" },
          second: { reference: "module.second.picked" },
        },
      },
      {
        id: "child",
        directory: "modules/child",
        format: "json",
        variables: { floor: { type: "number" } },
        locals: {},
        resources: {},
        calls: [
          {
            name: "leaf",
            target: "leaf",
            arguments: { floor: { reference: "var.floor" } },
          },
        ],
        outputs: { picked: { reference: "module.leaf.picked" } },
      },
      {
        id: "leaf",
        directory: "modules/leaf",
        format: "hcl",
        variables: { floor: { type: "number" } },
        locals: {},
        resources: { selected: { min: { reference: "var.floor" }, max: 5 } },
        calls: [],
        outputs: { picked: { reference: "random_integer.selected.result" } },
      },
    ],
  });
}
export function terraformExtensionsFiles(): Record<string, string> {
  const config = terraformExtensionsConfig();
  return {
    "checktrail.terraform-extensions.json":
      JSON.stringify(config, null, 2) + "\n",
    ...terraformExtensionsRender(config),
  };
}

export const terraformExtensionsNative = {
  skip:
    process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_NATIVE === "1" &&
    process.platform === "linux" &&
    process.arch === "arm64"
      ? false
      : "Pinned Terraform extension native profile not selected",
  timeout: 300000,
};
export async function terraformExtensionsFixture(t: TestContext) {
  const root = await realpath(await fixture(t, terraformExtensionsFiles()));
  return { root, config: terraformExtensionsConfig() };
}
export async function terraformExtensionsWriteConfig(
  root: string,
  config: ReturnType<typeof terraformExtensionsConfig>,
) {
  const files = {
    [terraformExtensionsPolicyFile]: JSON.stringify(config, null, 2) + "\n",
    ...terraformExtensionsRender(config),
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}
