import { cp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
export const kubeNative = {
  skip:
    process.env.CHECKTRAIL_INFRA_TOOLS_NATIVE === "1" &&
    spawnSync("kubeconform", ["-v"], { encoding: "utf8" }).stdout === "v0.8.0\n"
      ? false
      : "Pinned infrastructure native profile not selected",
  timeout: 120000,
};
export const kubeConfig = {
  schemaVersion: 1,
  kubeconformVersion: "0.8.0",
  kubernetesVersion: "1.36.0",
  platform: "linux_arm64",
  schemaDirectory: "tools/kubernetes",
  manifests: ["manifests/original.yaml"],
} as const;
export const originalDeployment =
  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: original-worker\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: original-worker\n  template:\n    metadata:\n      labels:\n        app: original-worker\n    spec:\n      containers:\n        - name: original-worker\n          image: example.invalid/original-worker:1.0.0\n";
export const originalConfigMap =
  'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: original-settings\ndata:\n  original: "value"\n';
export function kubeInvocation(
  text = originalDeployment + "---\n" + originalConfigMap,
) {
  const inputs = [
    { path: "checktrail.kubeconform.json", text: JSON.stringify(kubeConfig) },
    { path: "manifests/original.yaml", text },
  ].map((p) => ({ ...p, sha256: mavenHash(p.text) }));
  return { config: kubeConfig, inputs };
}
export async function kubeFixture(t: TestContext, text?: string) {
  const root = await fixture(t, {
    "manifests/original.yaml":
      text ?? originalDeployment + "---\n" + originalConfigMap,
    "checktrail.kubeconform.json": JSON.stringify(kubeConfig),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["infrastructure.kubeconform"] }],
    }),
  });
  await cp(
    fileURLToPath(new URL("../../examples/kubeconform/", import.meta.url)),
    root,
    { recursive: true },
  );
  if (text !== undefined)
    await writeFile(path.join(root, "manifests/original.yaml"), text);
  await cp("/opt/checktrail-schemas", path.join(root, "tools/kubernetes"), {
    recursive: true,
  });
  return root;
}
