import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
import {
  kustomizeConfigSchema,
  type KustomizeInvocation,
} from "../src/kustomize.js";
import {
  originalDeployment,
  originalConfigMap,
} from "./kubeconform-fixture.js";
export const kustomizeNative = {
  skip:
    process.env.CHECKTRAIL_INFRA_TOOLS_NATIVE !== "1"
      ? "Pinned infrastructure native profile not selected"
      : false,
  timeout: 120000,
};
export function kustomizeInvocation(): KustomizeInvocation {
  const config = kustomizeConfigSchema.parse({
    schemaVersion: 1,
    kustomizeVersion: "5.8.2",
    kubeconformVersion: "0.8.0",
    kubernetesVersion: "1.36.0",
    platform: "linux_arm64",
    root: "overlay",
    kustomizations: ["base/kustomization.yaml", "overlay/kustomization.yaml"],
    resources: ["base/deployment.yaml", "base/settings.yaml"],
    schemaDirectory: "tools/kubernetes",
  });
  const content = {
    "checktrail.kustomize.json": JSON.stringify(config),
    "base/kustomization.yaml":
      "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\n  - settings.yaml\n",
    "overlay/kustomization.yaml":
      "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../base\nnamePrefix: original-\nreplicas:\n  - name: original-worker\n    count: 3\nbuildMetadata:\n  - originAnnotations\n",
    "base/deployment.yaml": originalDeployment,
    "base/settings.yaml": originalConfigMap,
  };
  return {
    config,
    inputs: Object.entries(content).map(([path, text]) => ({
      path,
      text,
      sha256: mavenHash(text),
    })),
  };
}
export async function kustomizeFixture(t: TestContext) {
  const input = kustomizeInvocation();
  const root = await fixture(t, {
    ...Object.fromEntries(input.inputs.map((i) => [i.path, i.text])),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["infrastructure.kustomize"] }],
    }),
  });
  await cp(
    fileURLToPath(new URL("../../examples/kustomize/", import.meta.url)),
    root,
    { recursive: true },
  );
  await cp(
    "/opt/checktrail-schemas",
    path.join(root, input.config.schemaDirectory),
    { recursive: true },
  );
  return root;
}
