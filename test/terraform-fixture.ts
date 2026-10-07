import { cp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
export const terraformNative = {
  skip:
    process.env.CHECKTRAIL_INFRA_TOOLS_NATIVE === "1" &&
    spawnSync("terraform", ["version", "-json"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/tmp", CHECKPOINT_DISABLE: "1" },
    }).stdout.includes('"terraform_version": "1.16.5"')
      ? false
      : "Pinned infrastructure native profile not selected",
  timeout: 120000,
};
export async function terraformFixture(t: TestContext) {
  const root = await fixture(t, {});
  await cp(
    fileURLToPath(new URL("../../examples/terraform/", import.meta.url)),
    root,
    { recursive: true },
  );
  return root;
}
export async function terraformInvocation(root: string) {
  const declaration = JSON.parse(
    await readFile(path.join(root, "checktrail.terraform.json"), "utf8"),
  );
  const inputs = [];
  for (const file of ["checktrail.terraform.json", ...declaration.files]) {
    const text = await readFile(path.join(root, file), "utf8");
    inputs.push({ path: file, text, sha256: mavenHash(text) });
  }
  return { config: declaration, inputs };
}
export async function terraformRewrite(
  root: string,
  file: string,
  edit: (value: Record<string, unknown>) => void,
) {
  const value = JSON.parse(await readFile(path.join(root, file), "utf8"));
  edit(value);
  await writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
}
