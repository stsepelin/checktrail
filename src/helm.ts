import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseAllDocuments, visit } from "yaml";
import { readProjectFile } from "./inventory.js";
import { mavenHash } from "./maven.js";
import { kustomizeCanonical, kustomizeRequire } from "./kustomize.js";
import { kubeProtectedEnvironment } from "./kubeconform.js";
import type { Check, Inventory, Project } from "./types.js";
export function helmRequire(value: unknown, message: string): asserts value {
  kustomizeRequire(value, message);
}
export const helmBinarySha256 =
  "5bbdb28c8ca3f71daab33996a72392ce3135439a040ee63aed406888f82f2228";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const template = z
  .string()
  .max(256)
  .regex(/^templates\/[A-Za-z0-9][A-Za-z0-9_.-]*\.yaml$/);
export const helmConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  helmVersion: z.literal("4.3.0"),
  kubernetesVersion: z.literal("1.36.0"),
  platform: z.literal("linux_arm64"),
  release: z.literal("original"),
  namespace: z.literal("original"),
  templates: z.array(template).min(1).max(16),
});
export const helmInvocationSchema = z.strictObject({
  config: helmConfigSchema,
  inputs: z
    .array(
      z.strictObject({
        path: z.string().max(256),
        text: z.string().max(65536),
        sha256: digest,
      }),
    )
    .min(5)
    .max(20),
});
export type HelmInvocation = z.infer<typeof helmInvocationSchema>;
export const helmProtectedEnvironment = [
  ...kubeProtectedEnvironment,
  "HELM_CACHE_HOME",
  "HELM_CONFIG_HOME",
  "HELM_DATA_HOME",
  "HELM_PLUGINS",
  "HELM_KUBECONTEXT",
  "HELM_KUBEAPISERVER",
  "HELM_KUBETOKEN",
  "HELM_NAMESPACE",
  "HELM_DRIVER",
  "HELM_DRIVER_SQL_CONNECTION_STRING",
  "HELM_REGISTRY_CONFIG",
  "HELM_REPOSITORY_CONFIG",
  "HELM_REPOSITORY_CACHE",
  "HELM_DEBUG",
];
export const helmVersionArgs = ["version", "--template", "{{.Version}}"];
export const helmLintArgs = [
  "lint",
  "chart",
  "--strict",
  "--kube-version",
  "1.36.0",
  "--color",
  "never",
];
export const helmRenderArgs = [
  "template",
  "original",
  "chart",
  "--kube-version",
  "1.36.0",
  "--namespace",
  "original",
  "--dry-run=client",
  "--color",
  "never",
];
export function helmYaml(text: string) {
  const docs = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  helmRequire(
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
      throw new Error("Aliases unsupported");
    },
    Pair(_key, pair) {
      helmRequire(String(pair.key) !== "<<", "Merge keys unsupported");
    },
  });
  return { doc, value: doc.toJS({ maxAliasCount: 0 }) as unknown };
}
const chartSchema = z.strictObject({
  apiVersion: z.literal("v2"),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  type: z.literal("application"),
  description: z.string().min(1).max(256),
});
const property = z.strictObject({
  type: z.enum(["string", "integer", "boolean"]),
});
const valueSchema = z.strictObject({
  type: z.literal("object"),
  properties: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    property,
  ),
  required: z.array(z.string()).min(1).max(32),
  additionalProperties: z.literal(false),
});
export function helmInputs(invocation: HelmInvocation) {
  const { config, inputs } = invocation;
  const scope = [
    "Chart.yaml",
    "values.yaml",
    "values.schema.json",
    ...config.templates,
  ];
  helmRequire(
    new Set(scope).size === scope.length &&
      inputs.length === scope.length + 1 &&
      new Set(inputs.map((i) => i.path)).size === inputs.length,
    "Input scope differs",
  );
  helmRequire(
    kustomizeCanonical(inputs.map((i) => i.path).sort()) ===
      kustomizeCanonical(["checktrail.helm.json", ...scope].sort()) &&
      inputs.every(
        (i) =>
          mavenHash(i.text) === i.sha256 && Buffer.byteLength(i.text) <= 65536,
      ),
    "Input pins differ",
  );
  const get = (name: string) => inputs.find((i) => i.path === name)!;
  helmRequire(
    kustomizeCanonical(
      helmConfigSchema.parse(JSON.parse(get("checktrail.helm.json").text)),
    ) === kustomizeCanonical(config),
    "Configuration differs",
  );
  const chart = chartSchema.parse(helmYaml(get("Chart.yaml").text).value);
  const schema = valueSchema.parse(JSON.parse(get("values.schema.json").text));
  const keys = Object.keys(schema.properties).sort();
  helmRequire(
    keys.length > 0 &&
      keys.length <= 32 &&
      new Set(schema.required).size === schema.required.length &&
      kustomizeCanonical(keys) ===
        kustomizeCanonical([...schema.required].sort()),
    "Flat complete value schema required",
  );
  const values = z
    .record(
      z.string(),
      z.union([z.string().max(4096), z.number().finite(), z.boolean()]),
    )
    .parse(helmYaml(get("values.yaml").text).value);
  helmRequire(
    kustomizeCanonical(Object.keys(values).sort()) === kustomizeCanonical(keys),
    "Values and schema scope differ",
  );
  for (const file of config.templates) {
    const text = get(file).text;
    helmRequire(
      text.trim() && !text.includes("# Source:"),
      "Template source headers reserved",
    );
    // This is a passive lexical restriction, not a Go-template interpreter.
    // Unclosed or malformed allowed actions remain native syntax failures.
    for (const match of text.matchAll(/\{\{([\s\S]*?)(?:\}\}|$)/g)) {
      let action = match[1]!.replace(/"(?:\\.|[^"\\])*"/g, '""');
      helmRequire(
        !action.includes("`") &&
          !action.includes("$") &&
          !action.includes("/*"),
        "Unsupported action syntax",
      );
      action = action
        .replace(
          /\.Values\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*/g,
          "",
        )
        .replace(/\.Release\.(?:Name|Namespace)\b/g, "");
      helmRequire(
        !action.includes(".") &&
          [...action.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].every((m) =>
            [
              "if",
              "else",
              "end",
              "quote",
              "toString",
              "default",
              "eq",
              "ne",
              "lt",
              "le",
              "gt",
              "ge",
              "and",
              "or",
              "not",
              "true",
              "false",
            ].includes(m[0]),
          ),
        "Unsupported template context or function",
      );
    }
  }
  return { scope, chart, schema, values, get };
}
export async function helmCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "infrastructure.helm",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    kind: "analysis",
    parser: "helm-json",
    commands: [],
    reason:
      "Run pinned native Helm strict lint and client-only rendering for a declared root application chart; reconcile source-bound diagnostics and rendered template participation.",
  };
  try {
    const prefix = project.path === "." ? "" : project.path + "/";
    const config = helmConfigSchema.parse(
      JSON.parse(
        await readProjectFile(source.root, prefix + "checktrail.helm.json"),
      ),
    );
    const scope = [
      "Chart.yaml",
      "values.yaml",
      "values.schema.json",
      ...config.templates,
    ];
    const files = source.files
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length));
    helmRequire(
      files.every((f) =>
        ["checktrail.json", "checktrail.helm.json", ...scope].includes(f),
      ),
      "Root chart file closure differs",
    );
    helmRequire(
      source.excluded
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .every((f) => f === ".git" || f === ".checktrail"),
      "Excluded chart inputs require another profile",
    );
    const inputs = [];
    for (const file of ["checktrail.helm.json", ...scope]) {
      const text = await readProjectFile(source.root, prefix + file);
      inputs.push({ path: file, text, sha256: mavenHash(text) });
    }
    const invocation = helmInvocationSchema.parse({ config, inputs });
    helmInputs(invocation);
    const serialized = JSON.stringify(invocation);
    helmRequire(
      Buffer.byteLength(serialized) <= 100 * 1024,
      "Invocation too large",
    );
    check.scope = scope;
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./helm-runner.js", import.meta.url)),
        source.root,
        serialized,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        ...Object.fromEntries(helmProtectedEnvironment.map((k) => [k, ""])),
        PATH: process.env.PATH ?? "",
      },
    });
  } catch {
    check.unavailableReason =
      "Helm requires a complete declared root application chart, flat typed values, bounded deterministic template actions and exact prepared Linux ARM64 native tools; broader charts remain unavailable";
  }
  return check;
}
