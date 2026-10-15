import path from "node:path";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { terraformRequire } from "./terraform.js";

export const terraformExtensionsProvider = {
  address: "registry.terraform.io/hashicorp/random",
  version: "3.9.1",
  archive: "terraform-provider-random_3.9.1_linux_arm64.zip",
  archiveBytes: 5964673,
  archiveSha256:
    "7c7fbb8895eb75bb4de1f933e98553bd99c8d048c89a925ddba490aa5a67f7dc",
  packageHash: "h1:nozfr4CZq73d4HjubKJundX/8A+Mj282oS/hyNfjUPU=",
  schemaSha256:
    "9543ca4877840ef0c5b3b494cefc31a9abc1477e876ba3c6c898aa2a5407c2f7",
  members: [
    {
      path: "LICENSE.txt",
      bytes: 16757,
      sha256:
        "6cc8b40dbd9225bcae53f83bab17b8c01ad162c2093545c5bb7f1dcf5ae99d72",
    },
    {
      path: "terraform-provider-random_v3.9.1_x5",
      bytes: 17039522,
      sha256:
        "0dbc7f4ee8038f92f973c248db4a9783a8c3100d14d8aecda69922b1cb423fa2",
    },
  ],
} as const;
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const file = externalPathSchema
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/);
const scalar = z.union([
  z
    .string()
    .max(2048)
    .refine((value) => !value.includes("${") && !value.includes("%{")),
  z.number().finite(),
  z.boolean(),
]);
export const terraformExtensionsExpressionSchema = z.union([
  scalar,
  z.strictObject({
    reference: z
      .string()
      .max(192)
      .regex(
        /^(?:(?:var|local)\.[A-Za-z_][A-Za-z0-9_]*|module\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|random_integer\.[A-Za-z_][A-Za-z0-9_]*\.(?:result|id|min|max|seed|keepers))$/,
      ),
    offset: z.number().int().min(-1000000).max(1000000).optional(),
  }),
]);
const expression = terraformExtensionsExpressionSchema;
const expressions = z
  .record(name, expression)
  .refine((value) => Object.keys(value).length <= 64);
const moduleSchema = z.strictObject({
  id: name,
  directory: z.union([z.literal("."), file]),
  format: z.enum(["hcl", "json"]),
  variables: z
    .record(
      name,
      z.strictObject({
        type: z.enum(["number", "string", "bool"]),
        default: scalar.optional(),
      }),
    )
    .refine((value) => Object.keys(value).length <= 64),
  locals: expressions,
  resources: z
    .record(name, expressions)
    .refine((value) => Object.keys(value).length <= 64),
  calls: z
    .array(z.strictObject({ name, target: name, arguments: expressions }))
    .max(8),
  outputs: expressions,
});
export const terraformExtensionsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-local-modules-random-v1"),
  terraformVersion: z.literal("1.16.5"),
  provider: z.literal("registry.terraform.io/hashicorp/random"),
  providerVersion: z.literal("3.9.1"),
  platform: z.literal("linux_arm64"),
  modules: z.array(moduleSchema).min(3).max(16),
});
export type TerraformExtensionsConfig = z.infer<
  typeof terraformExtensionsConfigSchema
>;
export type TerraformExtensionsExpression = z.infer<typeof expression>;
export const terraformExtensionsPolicyFile =
  "checktrail.terraform-extensions.json";
export const terraformExtensionsLock = `provider "registry.terraform.io/hashicorp/random" {
  version = "3.9.1"
  constraints = "3.9.1"
  hashes = [
    "h1:nozfr4CZq73d4HjubKJundX/8A+Mj282oS/hyNfjUPU=",
    "zh:7c7fbb8895eb75bb4de1f933e98553bd99c8d048c89a925ddba490aa5a67f7dc",
  ]
}
`;
const unique = (values: string[], message: string) =>
  terraformRequire(new Set(values).size === values.length, message);
const entries = <T>(record: Record<string, T>) =>
  Object.entries(record).sort(([a], [b]) => a.localeCompare(b, "en"));
const references = (module: TerraformExtensionsConfig["modules"][number]) => [
  ...Object.values(module.locals),
  ...Object.values(module.outputs),
  ...Object.values(module.resources).flatMap(Object.values),
  ...module.calls.flatMap((call) => Object.values(call.arguments)),
];
export function terraformExtensionsModules(config: TerraformExtensionsConfig) {
  unique(
    config.modules.map((module) => module.id),
    "Module IDs repeated",
  );
  unique(
    config.modules.map((module) => module.directory),
    "Module directories repeated",
  );
  const root = config.modules[0]!;
  terraformRequire(
    root.id === "root" && root.directory === "." && root.calls.length >= 2,
    "One root with multiple local calls required",
  );
  terraformRequire(
    config.modules.some((module) => module.format === "hcl") &&
      config.modules.some((module) => module.format === "json"),
    "Both selected native formats required",
  );
  const modules = new Map(config.modules.map((module) => [module.id, module]));
  for (const module of config.modules) {
    terraformRequire(
      module.id === "root" || module.directory !== ".",
      "Local root repeated",
    );
    unique(
      module.calls.map((call) => call.name),
      "Local call names repeated",
    );
    terraformRequire(
      Object.keys(module.variables).length +
        Object.keys(module.locals).length +
        Object.keys(module.resources).length +
        module.calls.length +
        Object.keys(module.outputs).length >
        0,
      "Empty module",
    );
    for (const attrs of Object.values(module.resources)) {
      terraformRequire(Object.keys(attrs).length > 0, "Empty resource");
      for (const key of Object.keys(attrs))
        terraformRequire(
          ![
            "count",
            "for_each",
            "provider",
            "depends_on",
            "lifecycle",
            "provisioner",
            "connection",
          ].includes(key),
          "Resource meta-arguments require another profile",
        );
    }
    for (const call of module.calls) {
      terraformRequire(
        modules.has(call.target) && call.target !== "root",
        "Declare every local call target",
      );
      for (const key of Object.keys(call.arguments))
        terraformRequire(
          ![
            "source",
            "version",
            "providers",
            "depends_on",
            "count",
            "for_each",
          ].includes(key),
          "Module meta-arguments cannot replace declared local installation",
        );
    }
    terraformRequire(
      references(module).length <= 256,
      "Module expression bound",
    );
  }
  const used = new Set<string>(),
    instances: {
      key: string;
      source: string;
      directory: string;
      id: string;
    }[] = [];
  let resourceInstances = 0;
  const visit = (id: string, key: string, source: string, chain: string[]) => {
    terraformRequire(
      !chain.includes(id) && chain.length < 16 && instances.length < 64,
      "Local graph is cyclic or excessive",
    );
    const module = modules.get(id)!;
    used.add(id);
    instances.push({ key, source, directory: module.directory, id });
    resourceInstances += Object.keys(module.resources).length;
    for (const call of module.calls) {
      const target = modules.get(call.target)!;
      const relative = path.posix.relative(module.directory, target.directory);
      terraformRequire(
        relative.length > 0,
        "Self-directory local call unsupported",
      );
      visit(
        call.target,
        key ? key + "." + call.name : call.name,
        relative.startsWith(".") ? relative : "./" + relative,
        [...chain, id],
      );
    }
  };
  visit("root", "", "", []);
  terraformRequire(
    used.size === modules.size &&
      resourceInstances >= 2 &&
      instances.some((instance) => instance.key.includes(".")),
    "Every local module must be reached with transitive provider resources",
  );
  return instances;
}
export function terraformExtensionsExpression(
  value: TerraformExtensionsExpression,
  json = false,
) {
  if (typeof value !== "object") return json ? value : JSON.stringify(value);
  const reference =
    value.reference + (value.offset === undefined ? "" : " + " + value.offset);
  return json ? "${" + reference + "}" : reference;
}
export function terraformExtensionsRender(
  config: TerraformExtensionsConfig,
): Record<string, string> {
  terraformExtensionsModules(config);
  const output: Record<string, string> = {
    ".terraform.lock.hcl": terraformExtensionsLock,
  };
  for (const module of config.modules) {
    const terraform = {
      required_version: "=1.16.5",
      required_providers: {
        random: { source: "hashicorp/random", version: "=3.9.1" },
      },
    };
    const calls = Object.fromEntries(
      module.calls.map((call) => {
        const target = config.modules.find(
          (other) => other.id === call.target,
        )!;
        const relative = path.posix.relative(
          module.directory,
          target.directory,
        );
        return [
          call.name,
          {
            source: relative.startsWith(".") ? relative : "./" + relative,
            providers: { random: "random" },
            ...Object.fromEntries(
              entries(call.arguments).map(([key, value]) => [
                key,
                terraformExtensionsExpression(value, true),
              ]),
            ),
          },
        ];
      }),
    );
    const file = path.posix.join(
      module.directory,
      module.format === "hcl" ? "main.tf" : "main.tf.json",
    );
    if (module.format === "json") {
      const value = {
        terraform,
        ...(module.id === "root" ? { provider: { random: {} } } : {}),
        ...(Object.keys(module.variables).length
          ? { variable: Object.fromEntries(entries(module.variables)) }
          : {}),
        ...(Object.keys(module.locals).length
          ? {
              locals: Object.fromEntries(
                entries(module.locals).map(([key, value]) => [
                  key,
                  terraformExtensionsExpression(value, true),
                ]),
              ),
            }
          : {}),
        ...(Object.keys(module.resources).length
          ? {
              resource: {
                random_integer: Object.fromEntries(
                  entries(module.resources).map(([key, attrs]) => [
                    key,
                    Object.fromEntries(
                      entries(attrs).map(([attr, value]) => [
                        attr,
                        terraformExtensionsExpression(value, true),
                      ]),
                    ),
                  ]),
                ),
              },
            }
          : {}),
        ...(module.calls.length ? { module: calls } : {}),
        ...(Object.keys(module.outputs).length
          ? {
              output: Object.fromEntries(
                entries(module.outputs).map(([key, value]) => [
                  key,
                  { value: terraformExtensionsExpression(value, true) },
                ]),
              ),
            }
          : {}),
      };
      output[file] = JSON.stringify(value, null, 2) + "\n";
    } else {
      const lines = [
        "terraform {",
        '  required_version = "=1.16.5"',
        "  required_providers {",
        '    random = { source = "hashicorp/random", version = "=3.9.1" }',
        "  }",
        "}",
      ];
      if (module.id === "root") lines.push('provider "random" {}');
      for (const [key, variable] of entries(module.variables)) {
        lines.push(
          "variable " + JSON.stringify(key) + " {",
          "  type = " + variable.type,
        );
        if (variable.default !== undefined)
          lines.push("  default = " + JSON.stringify(variable.default));
        lines.push("}");
      }
      if (Object.keys(module.locals).length) {
        lines.push("locals {");
        for (const [key, value] of entries(module.locals))
          lines.push("  " + key + " = " + terraformExtensionsExpression(value));
        lines.push("}");
      }
      for (const [key, attrs] of entries(module.resources)) {
        lines.push('resource "random_integer" ' + JSON.stringify(key) + " {");
        for (const [attr, value] of entries(attrs))
          lines.push(
            "  " + attr + " = " + terraformExtensionsExpression(value),
          );
        lines.push("}");
      }
      for (const call of module.calls) {
        const declaration = calls[call.name]!;
        lines.push(
          "module " + JSON.stringify(call.name) + " {",
          "  source = " + JSON.stringify(declaration.source),
          "  providers = { random = random }",
        );
        for (const [key, value] of entries(call.arguments))
          lines.push("  " + key + " = " + terraformExtensionsExpression(value));
        lines.push("}");
      }
      for (const [key, value] of entries(module.outputs))
        lines.push(
          "output " + JSON.stringify(key) + " {",
          "  value = " + terraformExtensionsExpression(value),
          "}",
        );
      output[file] = lines.join("\n") + "\n";
    }
  }
  return output;
}
