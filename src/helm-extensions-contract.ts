import path from "node:path";
import { z } from "zod";
import { stringify } from "yaml";
import { helmRequire } from "./helm.js";
const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const scalar = z.union([
  z
    .string()
    .max(2048)
    .regex(/^[\x20-\x7e]*$/),
  z.number().finite().min(-1e6).max(1e6),
  z.boolean(),
]);
export type HelmExtensionsValue =
  z.infer<typeof scalar> | { [key: string]: HelmExtensionsValue };
const value: z.ZodType<HelmExtensionsValue> = z.lazy(() =>
  z.union([scalar, z.record(key, value)]),
);
const property = z.union([
  z.strictObject({
    type: z.literal("integer"),
    minimum: z.number().int().min(-1e6).max(1e6).optional(),
    maximum: z.number().int().min(-1e6).max(1e6).optional(),
  }),
  z.strictObject({
    type: z.literal("string"),
    minLength: z.number().int().min(0).max(2048).optional(),
    maxLength: z.number().int().min(0).max(2048).optional(),
    enum: z
      .array(
        z
          .string()
          .max(2048)
          .regex(/^[\x20-\x7e]*$/),
      )
      .min(1)
      .max(16)
      .optional(),
    pattern: z
      .enum(["^[a-z]+$", "^[A-Za-z0-9_-]+$", "^[a-z][a-z0-9-]*$"])
      .optional(),
  }),
  z.strictObject({ type: z.literal("boolean") }),
]);
const chart = z.strictObject({
  id: name,
  directory: z.union([
    z.literal("."),
    z
      .string()
      .max(256)
      .regex(
        /^(?:charts\/[a-z][a-z0-9-]{0,62})(?:\/charts\/[a-z][a-z0-9-]{0,62})*$/,
      ),
  ]),
  name,
  properties: z.record(key, property),
  values: z.record(key, value),
  dependencies: z.array(z.strictObject({ target: name, alias: name })).max(8),
  templates: z.record(
    z.string().regex(/^templates\/[A-Za-z0-9][A-Za-z0-9_.-]*\.yaml$/),
    z
      .array(
        z
          .string()
          .max(2048)
          .refine(
            (line) =>
              !["\r", "\n", "\0"].some((character) => line.includes(character)),
          ),
      )
      .min(1)
      .max(128),
  ),
});
export const helmExtensionsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("local-application-subcharts-v1"),
  helmVersion: z.literal("4.3.0"),
  kubernetesVersion: z.literal("1.36.0"),
  platform: z.literal("linux_arm64"),
  release: z.literal("original"),
  namespace: z.literal("original"),
  charts: z.array(chart).min(3).max(16),
});
export type HelmExtensionsConfig = z.infer<typeof helmExtensionsConfigSchema>;
export const helmExtensionsPolicyFile = "checktrail.helm-extensions.json";
export const helmExtensionsLintArgs = [
  "lint",
  "chart",
  "--strict",
  "--with-subcharts",
  "--kube-version",
  "1.36.0",
  "--color",
  "never",
];
export function helmExtensionsAction(line: string) {
  helmRequire(
    !line.includes("# Source:") &&
      !line.includes("# checktrail-source-line:") &&
      !line.includes("---"),
    "Native source and document markers reserved",
  );
  for (const match of line.matchAll(/\{\{(.*?)(?:\}\}|$)/g)) {
    let action = match[1]!;
    helmRequire(
      !action.includes("\\") &&
        !action.includes("`") &&
        !action.includes("$") &&
        !action.includes("/*") &&
        !/^\s*-/.test(action) &&
        !/-\s*$/.test(action),
      "Line-changing template syntax requires another profile",
    );
    action = action
      .replace(/"[^"\\]*"/g, '""')
      .replace(
        /\.Values\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*/g,
        "",
      )
      .replace(/\.Release\.(?:Name|Namespace)\b/g, "")
      .replace(/\.Chart\.(?:Name|Version)\b/g, "");
    // Bare if is retained solely as a native parse defect. Valid control flow and
    // newline-producing functions require another physical/rendered mapping.
    helmRequire(
      match[1]!.trim() === "if" ||
        (!action.includes(".") &&
          [...action.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].every((m) =>
            [
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
          )),
      "Unsupported template function/context",
    );
  }
}
export function helmExtensionsGraph(
  config: HelmExtensionsConfig,
  start = config.charts[0]!.id,
) {
  helmRequire(
    new Set(config.charts.map((c) => c.id)).size === config.charts.length &&
      new Set(config.charts.map((c) => c.directory)).size ===
        config.charts.length,
    "Physical charts repeated",
  );
  const root = config.charts[0]!;
  helmRequire(
    root.id === "root" &&
      root.directory === "." &&
      root.dependencies.length >= 2,
    "Root with multiple dependency instances required",
  );
  const charts = new Map(config.charts.map((c) => [c.id, c]));
  let templateCount = 0,
    valuesCount = 0;
  for (const c of config.charts) {
    const keys = Object.keys(c.properties),
      aliases = c.dependencies.map((d) => d.alias);
    helmRequire(
      keys.length >= 1 &&
        keys.length <= 32 &&
        !keys.includes("global") &&
        new Set(aliases).size === aliases.length &&
        !aliases.some((a) => keys.includes(a) || a === "global"),
      "Scalar schema and dependency keys must be distinct",
    );
    const templates = Object.entries(c.templates);
    templateCount += templates.length;
    helmRequire(
      templates.length >= 1 && templates.length <= 8 && templateCount <= 64,
      "Every application chart declares bounded resource templates",
    );
    for (const [file, lines] of templates) {
      helmRequire(
        lines[0]!.trim() && lines.at(-1)!.trim(),
        "Leading/trailing empty source lines unsupported",
      );
      for (const line of lines) helmExtensionsAction(line);
      helmRequire(file.length <= 256, "Template path bound");
    }
    for (const d of c.dependencies) {
      const target = charts.get(d.target);
      helmRequire(
        target &&
          target.directory ===
            path.posix.join(c.directory, "charts", target.name),
        "Dependency must name a declared immediate physical chart",
      );
    }
    const walkValues = (v: HelmExtensionsValue, depth: number) => {
      helmRequire(depth <= 16 && ++valuesCount <= 512, "Value graph bound");
      if (typeof v === "object")
        for (const child of Object.values(v)) walkValues(child, depth + 1);
    };
    walkValues(c.values, 0);
    const validateKeys = (
      current: HelmExtensionsConfig["charts"][number],
      v: Record<string, HelmExtensionsValue>,
      chain: string[],
    ) => {
      helmRequire(!chain.includes(current.id), "Cyclic local chart values");
      for (const [k, child] of Object.entries(v)) {
        const dep = current.dependencies.find((d) => d.alias === k);
        if (dep) {
          helmRequire(
            typeof child === "object",
            "Dependency overrides must be objects",
          );
          validateKeys(charts.get(dep.target)!, child, [...chain, current.id]);
        } else
          helmRequire(
            Object.hasOwn(current.properties, k) && typeof child !== "object",
            "Unknown nested scalar value/global requires another profile",
          );
      }
    };
    validateKeys(c, c.values, []);
  }
  const instances: {
      id: string;
      name: string;
      address: string;
      directory: string;
    }[] = [],
    used = new Set<string>();
  const visit = (
    id: string,
    effective: string,
    address: string,
    chain: string[],
  ) => {
    helmRequire(
      !chain.includes(id) && chain.length < 16 && instances.length < 64,
      "Chart instance graph bound/cycle",
    );
    const c = charts.get(id)!;
    used.add(id);
    instances.push({ id, name: effective, address, directory: c.directory });
    for (const d of c.dependencies)
      visit(d.target, d.alias, address + "/charts/" + d.alias, [...chain, id]);
  };
  const selected = charts.get(start);
  helmRequire(selected, "Unknown starting chart");
  visit(start, selected.name, selected.name, []);
  if (start === root.id)
    helmRequire(
      used.size === charts.size &&
        instances.some((i) => i.address.split("/charts/").length > 2),
      "Every physical chart and a transitive dependency must participate",
    );
  return instances;
}
export function helmExtensionsSchema(
  c: HelmExtensionsConfig["charts"][number],
) {
  return {
    type: "object",
    properties: {
      ...c.properties,
      ...Object.fromEntries(
        c.dependencies.map((d) => [d.alias, { type: "object" }]),
      ),
      global: { type: "object", additionalProperties: false },
    },
    required: Object.keys(c.properties).toSorted(),
    additionalProperties: false,
  };
}
export function helmExtensionsRender(config: HelmExtensionsConfig) {
  config = helmExtensionsConfigSchema.parse(config);
  helmExtensionsGraph(config);
  const result: Record<string, string> = {};
  for (const c of config.charts) {
    const prefix = c.directory === "." ? "" : c.directory + "/";
    result[prefix + "Chart.yaml"] = stringify({
      apiVersion: "v2",
      name: c.name,
      version: "0.1.0",
      type: "application",
      description: "Original declared local application chart",
      ...(c.dependencies.length
        ? {
            dependencies: c.dependencies.map((d) => ({
              name: config.charts.find((x) => x.id === d.target)!.name,
              version: "0.1.0",
              repository:
                "file://charts/" +
                config.charts.find((x) => x.id === d.target)!.name,
              alias: d.alias,
            })),
          }
        : {}),
    });
    result[prefix + "values.yaml"] = stringify(c.values);
    result[prefix + "values.schema.json"] =
      JSON.stringify(helmExtensionsSchema(c), null, 2) + "\n";
    for (const [file, lines] of Object.entries(c.templates))
      result[prefix + file] = lines
        .map(
          (line, index) =>
            "# checktrail-source-line:" + (index + 1) + "\n" + line + "\n",
        )
        .join("");
  }
  return result;
}
