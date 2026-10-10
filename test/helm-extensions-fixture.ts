import type { TestContext } from "node:test";
import { realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
import {
  helmExtensionsConfigSchema,
  helmExtensionsPolicyFile,
  helmExtensionsRender,
  type HelmExtensionsConfig,
} from "../src/helm-extensions-contract.js";
export function helmExtensionsConfig(): HelmExtensionsConfig {
  const properties = {
    count: { type: "integer", minimum: 1, maximum: 5 },
    label: { type: "string", minLength: 2, maxLength: 64, pattern: "^[a-z]+$" },
  };
  const templates = {
    "templates/object.yaml": [
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: {{ .Values.label }}-object",
      "data:",
      "  count: {{ .Values.count | quote }}",
      "  label: {{ .Values.label | quote }}",
    ],
  };
  return helmExtensionsConfigSchema.parse({
    schemaVersion: 1,
    profile: "local-application-subcharts-v1",
    helmVersion: "4.3.0",
    kubernetesVersion: "1.36.0",
    platform: "linux_arm64",
    release: "original",
    namespace: "original",
    charts: [
      {
        id: "root",
        directory: ".",
        name: "original-root",
        properties,
        values: {
          count: 2,
          label: "root",
          first: { label: "first", leaf: { label: "firstleaf" } },
          second: { label: "second", leaf: { label: "secondleaf" } },
        },
        dependencies: [
          { target: "worker", alias: "first" },
          { target: "worker", alias: "second" },
        ],
        templates,
      },
      {
        id: "worker",
        directory: "charts/worker",
        name: "worker",
        properties,
        values: { count: 2, label: "worker" },
        dependencies: [{ target: "leaf", alias: "leaf" }],
        templates,
      },
      {
        id: "leaf",
        directory: "charts/worker/charts/leaf",
        name: "leaf",
        properties,
        values: { count: 2, label: "leaf" },
        dependencies: [],
        templates,
      },
    ],
  });
}
export function helmExtensionsFiles(
  config = helmExtensionsConfig(),
): Record<string, string> {
  return {
    [helmExtensionsPolicyFile]: JSON.stringify(config, null, 2) + "\n",
    ...helmExtensionsRender(config),
  };
}
export async function helmExtensionsFixture(
  t: TestContext,
  config = helmExtensionsConfig(),
) {
  return realpath(await fixture(t, helmExtensionsFiles(config)));
}
export const helmExtensionsNative = {
  skip:
    process.env.CHECKTRAIL_HELM_EXTENSIONS_NATIVE !== "1" ||
    process.platform !== "linux" ||
    process.arch !== "arm64"
      ? "Pinned Helm extension profile not selected"
      : false,
  timeout: 300000,
};

export async function helmExtensionsWriteConfig(
  root: string,
  config: HelmExtensionsConfig,
) {
  for (const [file, text] of Object.entries(helmExtensionsFiles(config))) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}
