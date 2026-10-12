import { cp } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import {
  kustomizeConfigSchema,
  type KustomizeInvocation,
} from "../src/kustomize.js";
import { mavenHash } from "../src/maven.js";
import { kustomizeNative } from "./kustomize-fixture.js";
export const kustomizeExtensionNative = kustomizeNative;
export const originalKustomizeExtensionConfig = kustomizeConfigSchema.parse({
  schemaVersion: 1,
  kustomizeVersion: "5.8.2",
  kubeconformVersion: "0.8.0",
  kubernetesVersion: "1.36.0",
  platform: "linux_arm64",
  root: "overlay",
  kustomizations: ["base/kustomization.yaml", "overlay/kustomization.yaml"],
  resources: ["base/deployment.yaml", "base/service.yaml"],
  patches: ["overlay/strategic.yaml", "overlay/json.yaml"],
  schemaDirectory: "tools/kubernetes",
  assemblyProfile: "local-transforms-v1",
});
export const originalKustomizeExtensionFiles = {
  "base/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
configMapGenerator:
  - name: original-settings
    literals:
      - mode=original
      - channel=review
`,
  "base/deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: original-worker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: original-worker
  template:
    metadata:
      labels:
        app: original-worker
    spec:
      containers:
        - name: original-worker
          image: registry.example.invalid/original:v1
          envFrom:
            - configMapRef:
                name: original-settings
          env:
            - name: ORIGINAL_MODE
              valueFrom:
                configMapKeyRef:
                  name: original-settings
                  key: mode
      volumes:
        - name: original-settings
          configMap:
            name: original-settings
`,
  "base/service.yaml": `apiVersion: v1
kind: Service
metadata:
  name: original-worker
spec:
  selector:
    app: original-worker
  ports:
    - port: 8080
`,
  "overlay/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../base
namePrefix: original-preview-
namespace: original-preview
images:
  - name: registry.example.invalid/original
    newName: registry.example.invalid/repaired
    newTag: v2
patches:
  - path: strategic.yaml
  - path: json.yaml
    target:
      group: apps
      version: v1
      kind: Deployment
      name: original-worker
replicas:
  - name: original-worker
    count: 3
buildMetadata:
  - originAnnotations
`,
  "overlay/strategic.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: original-worker
spec:
  template:
    spec:
      containers:
        - name: original-worker
          image: registry.example.invalid/original:v0
          env:
            - name: ORIGINAL_EXTRA
              value: original-extra
`,
  "overlay/json.yaml": `- op: replace
  path: /spec/replicas
  value: 2
`,
};
export function originalKustomizeExtensionInvocation(): KustomizeInvocation {
  return {
    config: originalKustomizeExtensionConfig,
    inputs: Object.entries({
      "checktrail.kustomize.json": JSON.stringify(
        originalKustomizeExtensionConfig,
      ),
      ...originalKustomizeExtensionFiles,
    }).map(([path, text]) => ({ path, text, sha256: mavenHash(text) })),
  };
}
export async function extendedKustomizeFixture(t: TestContext) {
  const invocation = originalKustomizeExtensionInvocation();
  const root = await fixture(t, {
    ...Object.fromEntries(invocation.inputs.map((i) => [i.path, i.text])),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["infrastructure.kustomize"] }],
    }),
  });
  await cp(
    "/opt/checktrail-schemas",
    path.join(root, invocation.config.schemaDirectory),
    { recursive: true },
  );
  return root;
}
