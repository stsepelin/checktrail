import path from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  dotnetBuildCheck,
  dotnetBuildInvocationSchema,
} from "./dotnet-build.js";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile } from "./inventory.js";
import { verifyFsharpSdk } from "./fsharp-format.js";
import type { Check, Inventory, Project } from "./types.js";
const className = z
  .string()
  .regex(/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/)
  .max(256);
export const dotnetGeneratorExtensionsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("compiled-method-and-project-reference-v1"),
  projectReferences: z
    .array(
      z.strictObject({
        consumer: externalPathSchema,
        producer: externalPathSchema,
        kind: z.enum(["assembly", "analyzer"]),
      }),
    )
    .min(1)
    .max(256),
  incrementalGenerators: z
    .array(z.strictObject({ project: externalPathSchema, className }))
    .min(1)
    .max(64),
});
export function dotnetGeneratorRequire(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw Error(message);
}
export async function selectedDotnetGeneratorSdk() {
  for (const directory of (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    try {
      const executable = await realpath(path.join(directory, "dotnet")),
        root = path.dirname(executable);
      dotnetGeneratorRequire(
        path.basename(executable) === "dotnet",
        "Canonical selected SDK executable",
      );
      await verifyFsharpSdk(root);
      return { root, executable };
    } catch {
      /* Planning never executes a version command to admit a guessed SDK. */
    }
  }
  throw Error("Selected SDK/compiler/runtime components are unavailable");
}
export function validateDotnetGeneratorPolicy(
  config: z.infer<typeof dotnetGeneratorExtensionsConfigSchema>,
  invocation: z.infer<typeof dotnetBuildInvocationSchema>,
) {
  const projects = invocation.config.projects,
    testProjects = projects.filter((p) => p.kind === "test"),
    ids = new Set(projects.map((p) => p.file));
  dotnetGeneratorRequire(
    new Set(projects.map((p) => p.assemblyName)).size === projects.length,
    "Distinct declared assembly names required",
  );
  dotnetGeneratorRequire(
    testProjects.length > 0,
    "Declare at least one native test project",
  );
  dotnetGeneratorRequire(
    7 + 2 * projects.length + 3 * testProjects.length <= 80,
    "Complete native call closure exceeds its bound",
  );
  const references = config.projectReferences.map((r) => JSON.stringify(r)),
    generators = config.incrementalGenerators.map((g) => JSON.stringify(g));
  dotnetGeneratorRequire(
    new Set(references).size === references.length &&
      new Set(generators).size === generators.length,
    "Unique project-reference and generator roles required",
  );
  for (const r of config.projectReferences)
    dotnetGeneratorRequire(
      ids.has(r.consumer) && ids.has(r.producer) && r.consumer !== r.producer,
      "Every project edge names distinct declared projects",
    );
  const active = new Set<string>(),
    done = new Set<string>();
  function visit(project: string) {
    dotnetGeneratorRequire(
      !active.has(project),
      "Declared project-reference graph must be acyclic",
    );
    if (done.has(project)) return;
    active.add(project);
    for (const r of config.projectReferences.filter(
      (r) => r.consumer === project,
    ))
      visit(r.producer);
    active.delete(project);
    done.add(project);
  }
  for (const p of ids) visit(p);
  const expected = new Set(
    projects.flatMap((p) =>
      p.roslynGeneratedSources.map((g) =>
        JSON.stringify({
          project: g.generatorProject,
          className: g.generatorClass,
        }),
      ),
    ),
  );
  dotnetGeneratorRequire(
    generators.length === expected.size &&
      generators.every((g) => expected.has(g)),
    "Every declared incremental generator owns an exact generated output",
  );
  for (const g of config.incrementalGenerators) {
    const p = projects.find((p) => p.file === g.project);
    dotnetGeneratorRequire(
      p?.kind === "library" && p.language === "csharp",
      "Declared incremental producer must be a C# library",
    );
  }
  const analyzerEdges = new Set(
    projects.flatMap((p) =>
      p.roslynGeneratedSources.map((g) =>
        JSON.stringify({
          consumer: p.file,
          producer: g.generatorProject,
          kind: "analyzer",
        }),
      ),
    ),
  );
  dotnetGeneratorRequire(
    config.projectReferences.filter((r) => r.kind === "analyzer").length ===
      analyzerEdges.size &&
      config.projectReferences
        .filter((r) => r.kind === "analyzer")
        .every((r) => analyzerEdges.has(JSON.stringify(r))),
    "Every generated consumer has its exact native analyzer producer edge",
  );
}
export async function dotnetGeneratorExtensionsCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check = await dotnetBuildCheck(source, project);
  check.id = "dotnet.generator-extensions";
  check.kind = "test";
  check.parser = "dotnet-generator-extensions-json";
  check.reason =
    "Reconcile declared incremental generators, native compiled NUnit methods and fresh project-reference producer/consumer assemblies.";
  if (check.unavailableReason) return check;
  try {
    dotnetGeneratorRequire(
      project.files.includes("checktrail.dotnet-generator.json"),
      "Declare an inventoried checktrail.dotnet-generator.json",
    );
    const file = path.posix.join(
        project.path,
        "checktrail.dotnet-generator.json",
      ),
      config = dotnetGeneratorExtensionsConfigSchema.parse(
        JSON.parse(await readProjectFile(source.root, file)),
      ),
      invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      );
    validateDotnetGeneratorPolicy(config, invocation);
    await selectedDotnetGeneratorSdk();
    check.commands[0]!.args.push(
      "--generator-extensions",
      JSON.stringify(config),
    );
  } catch {
    check.commands = [];
    check.unavailableReason =
      "Prepare the bounded native generator/method policy, exact declared project graph and selected SDK component bytes";
  }
  return check;
}
