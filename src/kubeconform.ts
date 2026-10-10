import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseAllDocuments, visit } from "yaml";
import { readProjectFile } from "./inventory.js";
import { mavenHash } from "./maven.js";
import {
  kubernetesExtensionPins,
  kubernetesExtensionProfile,
  verifyKubernetesExtensionTool,
} from "./kubernetes-extensions.js";
import type { Check, Inventory, Project } from "./types.js";
export function kubeRequire(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const file = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const kubeSchemaPins = [
  {
    file: "deployment-apps-v1.json",
    sha256: "3725782fb01e3f27d8be2da565e2d653d7b78bf6debe5440804cea993c87b8f9",
    bytes: 691967,
  },
  {
    file: "configmap-v1.json",
    sha256: "e0eaddebd677c08aa092b2da2264d86ac4fc34eed112b9fac2945b3f00c1e9b1",
    bytes: 17083,
  },
  {
    file: "service-v1.json",
    sha256: "8bf019854daed511e7c174896a898173fa65d88ec5937c687a37303d4cc9351b",
    bytes: 43682,
  },
] as const;
export const kubeBinarySha256 =
  "7e77b104b3ae696389f91971c60fd58c72f1f3dc218f139df67a1b070959c012";
export const kubeconformConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kubeconformVersion: z.literal("0.8.0"),
  kubernetesVersion: z.literal("1.36.0"),
  platform: z.literal("linux_arm64"),
  schemaDirectory: file,
  schemaProfile: z.literal(kubernetesExtensionProfile).optional(),
  manifests: z.array(file).min(1).max(64),
});
export function kubeSchemaPinsFor(
  config: z.infer<typeof kubeconformConfigSchema>,
) {
  return config.schemaProfile === kubernetesExtensionProfile
    ? [...kubeSchemaPins, ...kubernetesExtensionPins].map(
        ({ file, bytes, sha256 }) => ({ file, bytes, sha256 }),
      )
    : kubeSchemaPins;
}
export const kubeconformInvocationSchema = z.strictObject({
  config: kubeconformConfigSchema,
  inputs: z
    .array(
      z.strictObject({
        path: file,
        text: z.string().max(80 * 1024),
        sha256: digest,
      }),
    )
    .min(2)
    .max(65),
});
export type KubeInvocation = z.infer<typeof kubeconformInvocationSchema>;
export type KubeDocument = {
  file: string;
  index: number;
  text: string;
  sha256: string;
  kind: string;
  version: string;
  name: string;
  line: number;
};
export function kubeDocuments(
  inputs: { path: string; text: string; sha256: string }[],
  config: KubeInvocation["config"],
): KubeDocument[] {
  kubeRequire(
    new Set(config.manifests).size === config.manifests.length,
    "Duplicate manifests",
  );
  kubeRequire(
    inputs.length === config.manifests.length + 1 &&
      new Set(inputs.map((p) => p.path)).size === inputs.length,
    "Input scope differs",
  );
  kubeRequire(
    inputs.every((p) => mavenHash(p.text) === p.sha256),
    "Input bytes differ",
  );
  const declaration = inputs.find(
    (p) => p.path === "checktrail.kubeconform.json",
  );
  kubeRequire(
    declaration &&
      JSON.stringify(
        kubeconformConfigSchema.parse(JSON.parse(declaration.text)),
      ) === JSON.stringify(config),
    "Declaration differs",
  );
  const result: KubeDocument[] = [];
  for (const file of config.manifests) {
    kubeRequire(
      /\.(?:ya?ml|json)$/.test(file),
      "Unsupported manifest extension",
    );
    const input = inputs.find((p) => p.path === file);
    kubeRequire(input, "Manifest missing");
    const docs = parseAllDocuments(input.text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
    kubeRequire(docs.length > 0 && docs.length <= 64, "No bounded documents");
    for (const [index, doc] of docs.entries()) {
      kubeRequire(
        !doc.errors.length && !doc.warnings.length && doc.contents && doc.range,
        "Unsupported YAML syntax",
      );
      visit(doc, {
        Alias() {
          throw new Error("Aliases require another profile");
        },
        Pair(_key, pair) {
          kubeRequire(
            String(pair.key) !== "<<",
            "Merge keys require another profile",
          );
        },
      });
      const value = doc.toJS({ maxAliasCount: 0 }) as unknown;
      const data = z
        .object({
          apiVersion: z.string(),
          kind: z.string(),
          metadata: z.object({ name: z.string().min(1).max(1024) }),
        })
        .parse(value);
      kubeRequire(
        (data.apiVersion === "apps/v1" && data.kind === "Deployment") ||
          (data.apiVersion === "v1" &&
            ["ConfigMap", "Service"].includes(data.kind)) ||
          (config.schemaProfile === kubernetesExtensionProfile &&
            kubernetesExtensionPins.some(
              (pin) =>
                pin.kind === data.kind && pin.version === data.apiVersion,
            )),
        "Schema kind/version not in verified profile",
      );
      const text = input.text.slice(doc.range[0], doc.range[2]);
      kubeRequire(text.length > 0, "Empty document");
      result.push({
        file,
        index,
        text,
        sha256: mavenHash(text),
        kind: data.kind,
        version: data.apiVersion,
        name: data.metadata.name,
        line: input.text.slice(0, doc.range[0]).split("\n").length,
      });
    }
  }
  kubeRequire(result.length > 0 && result.length <= 64, "No bounded resources");
  return result;
}
export function kubePointerLine(
  document: KubeDocument,
  pointer: string,
): number {
  kubeRequire(
    pointer === "" || /^\/(?:[^~]|~[01])*$/.test(pointer),
    "Invalid native JSON pointer",
  );
  const doc = parseAllDocuments(document.text, {
    strict: true,
    uniqueKeys: true,
  })[0]!;
  const segments =
    pointer === ""
      ? []
      : pointer
          .slice(1)
          .split("/")
          .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const node = segments.length ? doc.getIn(segments, true) : doc.contents;
  kubeRequire(
    node &&
      typeof node === "object" &&
      "range" in node &&
      Array.isArray(node.range),
    "Native diagnostic has no physical source node",
  );
  return (
    document.line +
    document.text.slice(0, node.range[0] as number).split("\n").length -
    1
  );
}
export const kubeProtectedEnvironment = [
  "KUBECONFIG",
  "HELM_CONFIG_HOME",
  "HELM_CACHE_HOME",
  "HELM_DATA_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
];
export function kubeNativeArgs(
  config: KubeInvocation["config"],
  workspace: string,
  count: number,
) {
  return [
    "-strict",
    "-summary",
    "-verbose",
    "-n",
    "1",
    "-output",
    "json",
    "-kubernetes-version",
    config.kubernetesVersion,
    "-schema-location",
    path.join(workspace, "schemas", "{{.ResourceKind}}{{.KindSuffix}}.json"),
    ...Array.from({ length: count }, (_, i) => `documents/${i}.yaml`),
  ];
}
export async function kubeconformCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "infrastructure.kubeconform",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    kind: "analysis",
    parser: "kubeconform-json",
    commands: [],
    reason:
      "Validate complete declared Kubernetes documents against pinned local native schemas without cluster access.",
  };
  try {
    const prefix = project.path === "." ? "" : project.path + "/";
    const config = kubeconformConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          prefix + "checktrail.kubeconform.json",
        ),
      ),
    );
    const schemaPins = kubeSchemaPinsFor(config);
    if (config.schemaProfile === kubernetesExtensionProfile) {
      check.scope = [...config.manifests];
      await verifyKubernetesExtensionTool(kubeBinarySha256);
    }
    const own = project.files.filter(
      (p) =>
        /\.(?:ya?ml|json)$/.test(p) &&
        p !== "checktrail.json" &&
        p !== "checktrail.kubeconform.json" &&
        !p.startsWith(config.schemaDirectory + "/"),
    );
    kubeRequire(
      JSON.stringify([...own].sort()) ===
        JSON.stringify([...config.manifests].sort()),
      "Declare every YAML/JSON input in the dedicated manifest project",
    );
    const schemas = project.files.filter((p) =>
      p.startsWith(config.schemaDirectory + "/"),
    );
    kubeRequire(
      JSON.stringify(schemas.sort()) ===
        JSON.stringify(
          schemaPins.map((p) => config.schemaDirectory + "/" + p.file).sort(),
        ),
      "Pinned schema scope differs",
    );
    for (const pin of schemaPins) {
      const text = await readProjectFile(
        source.root,
        prefix + config.schemaDirectory + "/" + pin.file,
      );
      kubeRequire(
        Buffer.byteLength(text) === pin.bytes && mavenHash(text) === pin.sha256,
        "Pinned schema bytes differ",
      );
    }
    const inputs = [];
    for (const file of ["checktrail.kubeconform.json", ...config.manifests]) {
      const text = await readProjectFile(source.root, prefix + file);
      kubeRequire(
        Buffer.byteLength(text) <= 80 * 1024,
        "Manifest input too large",
      );
      inputs.push({ path: file, text, sha256: mavenHash(text) });
    }
    const invocation = kubeconformInvocationSchema.parse({ config, inputs });
    kubeDocuments(inputs, config);
    const serialized = JSON.stringify(invocation);
    kubeRequire(
      Buffer.byteLength(serialized) <= 100 * 1024,
      "Invocation too large",
    );
    check.scope = [...config.manifests];
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./kubeconform-runner.js", import.meta.url)),
        source.root,
        serialized,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        ...Object.fromEntries(kubeProtectedEnvironment.map((k) => [k, ""])),
        PATH: process.env.PATH ?? "",
      },
    });
  } catch {
    check.unavailableReason =
      "kubeconform requires a complete supported checktrail.kubeconform.json, nonempty unambiguous manifests and exact prepared local schemas";
  }
  return check;
}
