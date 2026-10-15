import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { stringify } from "yaml";
import { fixture } from "./helpers.js";
import { kubeConfig, kubeNative } from "./kubeconform-fixture.js";
import {
  kubeSchemaPinsFor,
  kubeconformConfigSchema,
} from "../src/kubeconform.js";
import { kubernetesExtensionProfile } from "../src/kubernetes-extensions.js";
export const extendedKubernetesConfig = kubeconformConfigSchema.parse({
  ...kubeConfig,
  schemaProfile: kubernetesExtensionProfile,
});
export const extendedKubernetesNative = { ...kubeNative, timeout: 240000 };
export type OriginalResource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  [key: string]: unknown;
};
export function originalKubernetesResources(): OriginalResource[] {
  const template = () => ({
      metadata: { labels: { app: "original-worker" } },
      spec: {
        containers: [
          {
            name: "original-worker",
            image: "example.invalid/original-worker:1.0.0",
          },
        ],
      },
    }),
    selector = () => ({ matchLabels: { app: "original-worker" } }),
    job = () => ({
      template: {
        ...template(),
        spec: { ...template().spec, restartPolicy: "Never" },
      },
    }),
    resource = (
      kind: string,
      apiVersion: string,
      body = {},
    ): OriginalResource => ({
      apiVersion,
      kind,
      metadata: { name: "original-" + kind.toLowerCase() },
      ...body,
    });
  return [
    resource("Deployment", "apps/v1", {
      spec: { replicas: 2, selector: selector(), template: template() },
    }),
    resource("ConfigMap", "v1", { data: { original: "value" } }),
    resource("Service", "v1", {
      spec: { selector: { app: "original-worker" }, ports: [{ port: 8080 }] },
    }),
    resource("StatefulSet", "apps/v1", {
      spec: {
        serviceName: "original-service",
        replicas: 2,
        selector: selector(),
        template: template(),
      },
    }),
    resource("DaemonSet", "apps/v1", {
      spec: { selector: selector(), template: template() },
    }),
    resource("Job", "batch/v1", { spec: { parallelism: 2, ...job() } }),
    resource("CronJob", "batch/v1", {
      spec: { schedule: "0 * * * *", jobTemplate: { spec: job() } },
    }),
    resource("Ingress", "networking.k8s.io/v1", {
      spec: {
        rules: [
          {
            host: "original.example.invalid",
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "original-service",
                      port: { number: 8080 },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    }),
    resource("Secret", "v1", {
      type: "Opaque",
      data: { original: "b3JpZ2luYWw=" },
    }),
    resource("Namespace", "v1", {
      spec: { finalizers: ["original.example.invalid/finalizer"] },
    }),
    resource("Role", "rbac.authorization.k8s.io/v1", {
      rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
    }),
    resource("RoleBinding", "rbac.authorization.k8s.io/v1", {
      subjects: [
        {
          kind: "ServiceAccount",
          name: "original",
          namespace: "original-synthetic",
        },
      ],
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "original-role",
      },
    }),
    resource("PersistentVolumeClaim", "v1", {
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1Gi" } },
      },
    }),
  ];
}
export const originalKubernetesFaults = [
  {
    kind: "StatefulSet",
    path: ["spec", "replicas"],
    value: "original-invalid",
  },
  {
    kind: "DaemonSet",
    path: ["spec", "selector", "matchLabels", "app"],
    value: 8,
  },
  { kind: "Job", path: ["spec", "parallelism"], value: "original-invalid" },
  { kind: "CronJob", path: ["spec", "schedule"], value: false },
  {
    kind: "Ingress",
    path: [
      "spec",
      "rules",
      "0",
      "http",
      "paths",
      "0",
      "backend",
      "service",
      "port",
      "number",
    ],
    value: "original-invalid",
  },
  { kind: "Secret", path: ["data", "original"], value: 8 },
  { kind: "Namespace", path: ["spec", "finalizers", "0"], value: 8 },
  { kind: "Role", path: ["rules", "0", "verbs", "0"], value: 8 },
  { kind: "RoleBinding", path: ["roleRef", "name"], value: 8 },
  {
    kind: "PersistentVolumeClaim",
    path: ["spec", "accessModes", "0"],
    value: 8,
  },
];
export function breakOriginalResource(
  resources: OriginalResource[],
  fault: (typeof originalKubernetesFaults)[number],
) {
  let node: unknown = resources.find((r) => r.kind === fault.kind);
  for (const part of fault.path.slice(0, -1))
    node = Array.isArray(node)
      ? node[Number(part)]
      : (node as Record<string, unknown>)[part];
  const last = fault.path.at(-1)!;
  if (Array.isArray(node)) node[Number(last)] = fault.value;
  else (node as Record<string, unknown>)[last] = fault.value;
}
export const originalKubernetesText = (
  resources = originalKubernetesResources(),
) => resources.map((r) => stringify(r)).join("---\n");
export async function extendedKubernetesFixture(
  t: TestContext,
  resources = originalKubernetesResources(),
) {
  const root = await fixture(t, {
    "manifests/original.yaml": originalKubernetesText(resources),
    "checktrail.kubeconform.json": JSON.stringify(extendedKubernetesConfig),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["infrastructure.kubeconform"] }],
    }),
  });
  await mkdir(path.join(root, extendedKubernetesConfig.schemaDirectory), {
    recursive: true,
  });
  for (const pin of kubeSchemaPinsFor(extendedKubernetesConfig))
    await writeFile(
      path.join(root, extendedKubernetesConfig.schemaDirectory, pin.file),
      await readFile(path.join("/opt/checktrail-extended-schemas", pin.file)),
    );
  return root;
}
