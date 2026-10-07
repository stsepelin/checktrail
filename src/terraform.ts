import { z } from "zod";
import { parseAllDocuments } from "yaml";
import { fileURLToPath } from "node:url";
import { readProjectFile } from "./inventory.js";
import { mavenHash } from "./maven.js";
import type { Check, Inventory, Project } from "./types.js";
export function terraformRequire(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const file = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.tf\.json$/);
const name = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const scalar = z.union([
  z.string().max(2048),
  z.number().finite(),
  z.boolean(),
]);
export const terraformBinarySha256 =
  "c9caf6b26aa487a470bd02d32ffe3e44fe5e95fa7e7f986cb9f2be61654f240c";
export const terraformConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  terraformVersion: z.literal("1.16.5"),
  platform: z.literal("linux_arm64"),
  files: z.array(file).min(1).max(32),
});
export const terraformInvocationSchema = z.strictObject({
  config: terraformConfigSchema,
  inputs: z
    .array(
      z.strictObject({
        path: z.string().max(128),
        text: z.string().max(64 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(2)
    .max(33),
});
export type TerraformInvocation = z.infer<typeof terraformInvocationSchema>;
const moduleSchema = z.strictObject({
  terraform: z
    .strictObject({ required_version: z.literal("=1.16.5") })
    .optional(),
  variable: z
    .record(
      name,
      z.strictObject({
        type: z.enum(["number", "string", "bool"]),
        default: scalar,
      }),
    )
    .optional(),
  locals: z.record(name, scalar).optional(),
  output: z.record(name, z.strictObject({ value: scalar })).optional(),
});
export function terraformModules(invocation: TerraformInvocation) {
  const { config, inputs } = invocation;
  terraformRequire(
    new Set(config.files).size === config.files.length &&
      inputs.length === config.files.length + 1 &&
      new Set(inputs.map((i) => i.path)).size === inputs.length,
    "Input scope differs",
  );
  terraformRequire(
    inputs.every((i) => mavenHash(i.text) === i.sha256),
    "Input bytes differ",
  );
  const declaration = inputs.find(
    (i) => i.path === "checktrail.terraform.json",
  );
  terraformRequire(
    declaration &&
      JSON.stringify(
        terraformConfigSchema.parse(JSON.parse(declaration.text)),
      ) === JSON.stringify(config),
    "Declaration differs",
  );
  let constraints = 0,
    total = 0;
  const modules = config.files.map((file) => {
    const input = inputs.find((i) => i.path === file);
    terraformRequire(input, "Module file missing");
    const documents = parseAllDocuments(input.text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
    terraformRequire(
      documents.length === 1 &&
        !documents[0]!.errors.length &&
        !documents[0]!.warnings.length,
      "Duplicate or unsupported JSON",
    );
    const value = moduleSchema.parse(JSON.parse(input.text));
    if (value.terraform) constraints++;
    const declarations = {
      variables: Object.keys(value.variable ?? {}).length,
      locals: Object.keys(value.locals ?? {}).length,
      outputs: Object.keys(value.output ?? {}).length,
    };
    const count =
      declarations.variables + declarations.locals + declarations.outputs;
    terraformRequire(
      count > 0 && count <= 128,
      "Empty or excessive module declarations",
    );
    total += count;
    const expressions = [
      ...Object.values(value.variable ?? {}).map((v) => v.default),
      ...Object.values(value.locals ?? {}),
      ...Object.values(value.output ?? {}).map((o) => o.value),
    ];
    for (const expression of expressions)
      if (
        typeof expression === "string" &&
        (expression.includes("${") || expression.includes("%{"))
      )
        terraformRequire(
          /^\$\{(?:var|local)\.[A-Za-z_][A-Za-z0-9_]*(?: [+*-] -?[0-9]+)?\}$/.test(
            expression,
          ),
          "Expression requires another profile",
        );
    return { file, sha256: input.sha256, declarations };
  });
  terraformRequire(
    constraints === 1 && total > 0 && total <= 256,
    "One native version constraint and bounded nonempty declarations required",
  );
  return modules;
}
export const terraformProtectedEnvironment = [
  "TF_CLI_ARGS",
  "TF_CLI_ARGS_validate",
  "TF_CLI_ARGS_version",
  "TF_CLI_ARGS_graph",
  "TF_CLI_ARGS_init",
  "TF_CLI_CONFIG_FILE",
  "TF_DATA_DIR",
  "TF_WORKSPACE",
  "TF_IN_AUTOMATION",
  "TF_INPUT",
  "TF_LOG",
  "TF_LOG_PATH",
  "TF_PLUGIN_CACHE_DIR",
  "TF_REATTACH_PROVIDERS",
  "CHECKPOINT_DISABLE",
  "CHECKPOINT_SIGNATURE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
];
export async function terraformCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "infrastructure.terraform-validate",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    kind: "analysis",
    parser: "terraform-json",
    commands: [],
    reason:
      "Validate a complete provider-free JSON Terraform module with fixed native validation; no plan or apply.",
  };
  try {
    const prefix = project.path === "." ? "" : project.path + "/";
    const config = terraformConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          prefix + "checktrail.terraform.json",
        ),
      ),
    );
    const own = project.files.filter(
      (p) =>
        /\.(?:tf|json|tfvars)$/.test(p) &&
        p !== "checktrail.json" &&
        p !== "checktrail.terraform.json",
    );
    terraformRequire(
      JSON.stringify([...own].sort()) ===
        JSON.stringify([...config.files].sort()),
      "Declare all Terraform/JSON inputs in the dedicated project",
    );
    const inputs = [];
    for (const file of ["checktrail.terraform.json", ...config.files]) {
      const text = await readProjectFile(source.root, prefix + file);
      terraformRequire(Buffer.byteLength(text) <= 64 * 1024, "Input too large");
      inputs.push({ path: file, text, sha256: mavenHash(text) });
    }
    const invocation = terraformInvocationSchema.parse({ config, inputs });
    terraformModules(invocation);
    const serialized = JSON.stringify(invocation);
    terraformRequire(
      Buffer.byteLength(serialized) <= 100 * 1024,
      "Invocation too large",
    );
    check.scope = [...config.files];
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./terraform-runner.js", import.meta.url)),
        source.root,
        serialized,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        ...Object.fromEntries(
          terraformProtectedEnvironment.map((k) => [k, ""]),
        ),
        PATH: process.env.PATH ?? "",
      },
    });
  } catch {
    check.unavailableReason =
      "Terraform validation requires a complete nonempty checktrail.terraform.json, exact provider-free JSON scope and bounded passive expressions";
  }
  return check;
}
