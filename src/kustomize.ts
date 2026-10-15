import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectFile } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";
import { z } from "zod";
import { parseAllDocuments, visit } from "yaml";
import { mavenHash } from "./maven.js";
import {
  kubePointerLine,
  kubeSchemaPins,
  kubeProtectedEnvironment,
  type KubeDocument,
} from "./kubeconform.js";
import {
  extendedKustomizeResources,
  kustomizeExtensionProfile,
  verifyKustomizeExtensionTools,
} from "./kustomize-extensions.js";
export function kustomizeRequire(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const file = z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const kustomizeConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kustomizeVersion: z.literal("5.8.2"),
  kubeconformVersion: z.literal("0.8.0"),
  kubernetesVersion: z.literal("1.36.0"),
  platform: z.literal("linux_arm64"),
  root: file,
  kustomizations: z.array(file).min(1).max(16),
  resources: z.array(file).min(1).max(32),
  schemaDirectory: file,
  assemblyProfile: z.literal(kustomizeExtensionProfile).optional(),
  patches: z.array(file).max(16).optional(),
});
export const kustomizeInvocationSchema = z.strictObject({
  config: kustomizeConfigSchema,
  inputs: z
    .array(
      z.strictObject({
        path: file,
        text: z.string().max(64 * 1024),
        sha256: digest,
      }),
    )
    .min(3)
    .max(65),
});
export type KustomizeInvocation = z.infer<typeof kustomizeInvocationSchema>;
export function kustomizeAssemblyScope(config: KustomizeInvocation["config"]) {
  return [
    ...config.kustomizations,
    ...config.resources,
    ...(config.patches ?? []),
  ];
}
export const kustomizeBinarySha256 =
  "f16ee4ad0f3991e5236e33070427f630f3e911a4b81be53aeeb70946182e61a8";
const declaration = z.strictObject({
  apiVersion: z.literal("kustomize.config.k8s.io/v1beta1"),
  kind: z.literal("Kustomization"),
  resources: z.array(z.string().min(1).max(256)).min(1).max(32),
  namePrefix: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]*$/)
    .optional(),
  replicas: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128),
        count: z.number().int().nonnegative().max(1000000),
      }),
    )
    .max(32)
    .optional(),
  buildMetadata: z.tuple([z.literal("originAnnotations")]).optional(),
});
type Value = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  [key: string]: unknown;
};
export type KustomizeResource = {
  source: KubeDocument;
  value: Value;
  overrides: { pointer: string; file: string; line: number }[];
};
function raw(input: { path: string; text: string; sha256: string }) {
  const docs = parseAllDocuments(input.text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  kustomizeRequire(
    docs.length === 1 &&
      docs[0]!.contents &&
      docs[0]!.range &&
      !docs[0]!.errors.length &&
      !docs[0]!.warnings.length,
    "One unambiguous YAML document required",
  );
  const doc = docs[0]!;
  visit(doc, {
    Alias() {
      throw new Error("Aliases require another profile");
    },
    Pair(_key, pair) {
      kustomizeRequire(
        String(pair.key) !== "<<",
        "Merge keys require another profile",
      );
    },
  });
  return { doc, value: doc.toJS({ maxAliasCount: 0 }) as unknown };
}
function line(text: string, offset: number) {
  return text.slice(0, offset).split("\n").length;
}
export function kustomizeResources(
  invocation: KustomizeInvocation,
): KustomizeResource[] {
  if (invocation.config.assemblyProfile === kustomizeExtensionProfile)
    return extendedKustomizeResources(invocation);
  kustomizeRequire(
    invocation.config.patches === undefined,
    "Patches require the explicit extension profile",
  );
  const { config, inputs } = invocation,
    scope = [...config.kustomizations, ...config.resources];
  kustomizeRequire(
    new Set(scope).size === scope.length &&
      inputs.length === scope.length + 1 &&
      new Set(inputs.map((i) => i.path)).size === inputs.length,
    "Input scope differs",
  );
  kustomizeRequire(
    scope.every(
      (file) =>
        !["schemas", "documents", "home", "tmp", "data"].includes(
          file.split("/")[0]!,
        ),
    ),
    "Native scratch names are reserved",
  );
  kustomizeRequire(
    inputs.every((i) => mavenHash(i.text) === i.sha256),
    "Input bytes differ",
  );
  const configInput = inputs.find(
    (i) => i.path === "checktrail.kustomize.json",
  );
  kustomizeRequire(
    configInput &&
      JSON.stringify(
        kustomizeConfigSchema.parse(JSON.parse(configInput.text)),
      ) === JSON.stringify(config),
    "Declaration differs",
  );
  for (const name of config.kustomizations)
    kustomizeRequire(
      name.endsWith("/kustomization.yaml"),
      "Canonical kustomization path required",
    );
  for (const name of config.resources)
    kustomizeRequire(/\.ya?ml$/.test(name), "YAML resource path required");
  const visited = new Set<string>(),
    used = new Set<string>(),
    active = new Set<string>();
  const input = (file: string) => {
    const value = inputs.find((i) => i.path === file);
    kustomizeRequire(value, "Declared input missing");
    return value;
  };
  const build = (file: string, depth: number): KustomizeResource[] => {
    kustomizeRequire(
      depth <= 8 && !active.has(file) && !visited.has(file),
      "Cyclic or repeated assembly",
    );
    active.add(file);
    visited.add(file);
    const original = input(file),
      { doc, value } = raw(original),
      data = declaration.parse(value),
      result: KustomizeResource[] = [];
    if (file === config.root + "/kustomization.yaml")
      kustomizeRequire(
        data.buildMetadata?.[0] === "originAnnotations",
        "Native origin annotations required",
      );
    for (const relative of data.resources) {
      kustomizeRequire(
        /^(?:\.\.\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(
          relative,
        ),
        "Local canonical resources required",
      );
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), relative),
      );
      kustomizeRequire(
        !target.startsWith("../") && !path.posix.isAbsolute(target),
        "Resource escapes project",
      );
      const nested = target + "/kustomization.yaml";
      if (config.kustomizations.includes(nested)) {
        result.push(...build(nested, depth + 1));
        continue;
      }
      kustomizeRequire(
        config.resources.includes(target) && !used.has(target),
        "Foreign or repeated resource",
      );
      used.add(target);
      const source = input(target),
        parsed = raw(source);
      const resource = z
        .object({
          apiVersion: z.string(),
          kind: z.string(),
          metadata: z
            .object({
              name: z.string().min(1).max(128),
              namespace: z.string().optional(),
              annotations: z.record(z.string(), z.string()).optional(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(parsed.value) as Value;
      kustomizeRequire(
        (resource.kind === "Deployment" && resource.apiVersion === "apps/v1") ||
          (["ConfigMap", "Service"].includes(resource.kind) &&
            resource.apiVersion === "v1"),
        "Resource schema outside profile",
      );
      kustomizeRequire(
        !Object.hasOwn(
          resource.metadata.annotations ?? {},
          "config.kubernetes.io/origin",
        ),
        "Source cannot claim native origin",
      );
      kustomizeCanonical(resource);
      const text = source.text.slice(
        parsed.doc.range![0],
        parsed.doc.range![2],
      );
      result.push({
        source: {
          file: target,
          index: 0,
          text,
          sha256: mavenHash(text),
          kind: resource.kind,
          version: resource.apiVersion,
          name: resource.metadata.name,
          line: line(source.text, parsed.doc.range![0]),
        },
        value: JSON.parse(JSON.stringify(resource)) as Value,
        overrides: [],
      });
    }
    if (data.replicas) {
      kustomizeRequire(
        new Set(data.replicas.map((r) => r.name)).size === data.replicas.length,
        "Repeated replica override",
      );
      for (const [index, replica] of data.replicas.entries()) {
        const targets = result.filter(
          (r) =>
            r.value.kind === "Deployment" &&
            (r.source.name === replica.name ||
              r.value.metadata.name === replica.name),
        );
        kustomizeRequire(
          targets.length === 1,
          "Replica selector must match one Deployment",
        );
        const target = targets[0]!,
          node = doc.getIn(["replicas", index, "count"], true);
        kustomizeRequire(
          node &&
            typeof node === "object" &&
            "range" in node &&
            Array.isArray(node.range),
          "Replica source missing",
        );
        target.value.spec ??= {};
        target.value.spec.replicas = replica.count;
        target.overrides.push({
          pointer: "/spec/replicas",
          file,
          line: line(original.text, node.range[0] as number),
        });
      }
    }
    if (data.namePrefix) {
      const node = doc.getIn(["namePrefix"], true);
      kustomizeRequire(
        node &&
          typeof node === "object" &&
          "range" in node &&
          Array.isArray(node.range),
        "Name prefix source missing",
      );
      for (const target of result) {
        target.value.metadata.name =
          data.namePrefix + target.value.metadata.name;
        target.overrides.push({
          pointer: "/metadata/name",
          file,
          line: line(original.text, node.range[0] as number),
        });
      }
    }
    active.delete(file);
    return result;
  };
  const result = build(config.root + "/kustomization.yaml", 0);
  kustomizeRequire(
    visited.size === config.kustomizations.length &&
      used.size === config.resources.length &&
      result.length === config.resources.length,
    "Complete assembly scope required",
  );
  const identities = result.map((r) =>
    [
      r.value.apiVersion,
      r.value.kind,
      r.value.metadata.namespace ?? "",
      r.value.metadata.name,
    ].join("|"),
  );
  kustomizeRequire(
    new Set(identities).size === identities.length,
    "Ambiguous rendered resources",
  );
  for (const r of result) {
    r.value.metadata.annotations ??= {};
    r.value.metadata.annotations["config.kubernetes.io/origin"] =
      "path: " + path.posix.relative(config.root, r.source.file) + "\n";
  }
  return result;
}
export function kustomizeSourceAddress(
  resource: KustomizeResource,
  pointer: string,
) {
  const override = [...resource.overrides]
    .reverse()
    .find((o) => o.pointer === pointer);
  return override
    ? { file: override.file, line: override.line }
    : {
        file: resource.source.file,
        line: kubePointerLine(resource.source, pointer),
      };
}
export function kustomizeCanonical(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(kustomizeCanonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, v]) => JSON.stringify(key) + ":" + kustomizeCanonical(v))
        .join(",") +
      "}"
    );
  kustomizeRequire(
    value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)),
    "Finite JSON values required",
  );
  return JSON.stringify(value);
}

export async function kustomizeCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "infrastructure.kustomize",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    kind: "analysis",
    parser: "kustomize-json",
    commands: [],
    reason:
      "Reconcile a complete local Kustomize assembly with pinned native rendering and offline Kubernetes schema validation.",
  };
  try {
    const prefix = project.path === "." ? "" : project.path + "/";
    const config = kustomizeConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          prefix + "checktrail.kustomize.json",
        ),
      ),
    );
    // Nested kustomizations are discovery boundaries; this assembly owns their declared inputs too.
    const files = source.files
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length));
    const own = files.filter(
      (f) =>
        /\.(?:ya?ml|json)$/.test(f) &&
        f !== "checktrail.json" &&
        f !== "checktrail.kustomize.json" &&
        !f.startsWith(config.schemaDirectory + "/"),
    );
    const scope = kustomizeAssemblyScope(config);
    if (config.assemblyProfile === kustomizeExtensionProfile) {
      check.scope = scope;
      await verifyKustomizeExtensionTools();
    }
    kustomizeRequire(
      kustomizeCanonical([...own].sort()) ===
        kustomizeCanonical([...scope].sort()),
      "Declare every YAML/JSON source in the dedicated assembly project",
    );
    const schemas = files.filter((f) =>
      f.startsWith(config.schemaDirectory + "/"),
    );
    kustomizeRequire(
      kustomizeCanonical(schemas.sort()) ===
        kustomizeCanonical(
          kubeSchemaPins
            .map((p) => config.schemaDirectory + "/" + p.file)
            .sort(),
        ),
      "Pinned schema scope differs",
    );
    for (const pin of kubeSchemaPins) {
      const text = await readProjectFile(
        source.root,
        prefix + config.schemaDirectory + "/" + pin.file,
      );
      kustomizeRequire(
        Buffer.byteLength(text) === pin.bytes && mavenHash(text) === pin.sha256,
        "Pinned schema bytes differ",
      );
    }
    const inputs = [];
    for (const file of ["checktrail.kustomize.json", ...scope]) {
      const text = await readProjectFile(source.root, prefix + file);
      kustomizeRequire(
        Buffer.byteLength(text) <= 64 * 1024,
        "Assembly input too large",
      );
      inputs.push({ path: file, text, sha256: mavenHash(text) });
    }
    const invocation = kustomizeInvocationSchema.parse({ config, inputs });
    kustomizeResources(invocation);
    const serialized = JSON.stringify(invocation);
    kustomizeRequire(
      Buffer.byteLength(serialized) <= 100 * 1024,
      "Invocation too large",
    );
    check.scope = scope;
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./kustomize-runner.js", import.meta.url)),
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
      "Kustomize requires a complete bounded local checktrail.kustomize.json assembly and exact prepared native schemas; unsupported transforms remain unavailable";
  }
  return check;
}
