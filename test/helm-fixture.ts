import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
import { helmConfigSchema, type HelmInvocation } from "../src/helm.js";
export const helmNative = {
  skip:
    process.env.CHECKTRAIL_INFRA_TOOLS_NATIVE !== "1"
      ? "Pinned infrastructure native profile not selected"
      : false,
  timeout: 120000,
};
export function helmInvocation(): HelmInvocation {
  const config = helmConfigSchema.parse({
    schemaVersion: 1,
    helmVersion: "4.3.0",
    kubernetesVersion: "1.36.0",
    platform: "linux_arm64",
    release: "original",
    namespace: "original",
    templates: ["templates/settings.yaml", "templates/worker.yaml"],
  });
  const content = {
    "checktrail.helm.json": JSON.stringify(config),
    "Chart.yaml":
      "apiVersion: v2\nname: original-worker\nversion: 0.1.0\ntype: application\ndescription: Original synthetic chart\n",
    "values.yaml": "replicas: 2\nlabel: original\n",
    "values.schema.json": JSON.stringify({
      type: "object",
      properties: { replicas: { type: "integer" }, label: { type: "string" } },
      required: ["replicas", "label"],
      additionalProperties: false,
    }),
    "templates/settings.yaml":
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-settings\ndata:\n  label: {{ .Values.label | quote }}\n  replicas: {{ .Values.replicas | quote }}\n",
    "templates/worker.yaml":
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-worker\ndata:\n  label: {{ .Values.label | quote }}\n",
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
export async function helmFixture(t: TestContext) {
  const invocation = helmInvocation();
  return fixture(t, {
    ...Object.fromEntries(invocation.inputs.map((i) => [i.path, i.text])),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["infrastructure.helm"] }],
    }),
  });
}
