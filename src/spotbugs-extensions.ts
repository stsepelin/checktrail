import path from "node:path";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { jvmExtensionsSchema } from "./jvm-extensions.js";
import {
  spotbugsCorePluginId,
  spotbugsCorePatterns,
  spotbugsCoreFactories,
} from "./spotbugs-extensions-artifacts.js";
const identifier = z
  .string()
  .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
const stageId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const bugType = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const spotbugsExtensionsSchema = z.strictObject({
  profile: z.literal("linux-arm64-class-scopes-plugins-v1"),
  stages: z
    .array(
      z.strictObject({
        id: stageId,
        path: z.union([z.literal("."), externalPathSchema]),
        analyze: z.boolean(),
        sources: externalPathSchema.array().max(2000),
        dependsOn: stageId.array().max(32),
      }),
    )
    .min(1)
    .max(64),
  generators: jvmExtensionsSchema.shape.generators,
  jpms: jvmExtensionsSchema.shape.jpms,
  plugins: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
        detectors: z
          .array(
            z.strictObject({
              className: identifier,
              reports: bugType.array().min(1).max(128),
            }),
          )
          .min(1)
          .max(32),
        patterns: z
          .array(
            z.strictObject({
              type: bugType,
              abbreviation: z.string().regex(/^[A-Z][A-Z0-9]{0,31}$/),
              category: bugType,
            }),
          )
          .min(1)
          .max(128),
      }),
    )
    .max(8),
});
export type SpotbugsExtensions = z.infer<typeof spotbugsExtensionsSchema>;
const unique = (items: string[]) => new Set(items).size === items.length;
export function validateSpotbugsExtensionScope(
  config: SpotbugsExtensions,
  inputs: string[],
) {
  if (
    !inputs.length ||
    inputs.length > 2000 ||
    !unique(inputs) ||
    inputs.some(
      (file) =>
        !file.endsWith(".java") ||
        path.posix.basename(file) === "package-info.java" ||
        /[:;\r\n\0]/.test(file),
    )
  )
    throw Error("Declare unique bounded selected Java sources");
  if (!config.stages.some((stage) => stage.analyze))
    throw Error("Select at least one application class cohort for analysis");
  const stages = new Map<string, SpotbugsExtensions["stages"][number]>();
  const paths = new Set<string>(),
    owned = new Set<string>();
  for (const stage of config.stages) {
    if (
      stages.has(stage.id) ||
      paths.has(stage.path) ||
      !unique(stage.dependsOn) ||
      stage.dependsOn.some((id) => !stages.has(id))
    )
      throw Error(
        "Compile cohorts require unique identities, paths and earlier dependencies",
      );
    for (const file of stage.sources) {
      if (
        !inputs.includes(file) ||
        owned.has(file) ||
        (stage.path !== "." && !file.startsWith(stage.path + "/"))
      )
        throw Error(
          "Every selected compiler source requires one declared cohort owner",
        );
      owned.add(file);
    }
    stages.set(stage.id, stage);
    paths.add(stage.path);
  }
  const generated = new Set<string>();
  for (const generator of config.generators) {
    if (
      !paths.has(generator.module) ||
      !inputs.includes(generator.source) ||
      owned.has(generator.source) ||
      !generator.source.startsWith("generators/") ||
      path.posix.basename(generator.source) !==
        generator.className.split(".").at(-1) + ".java"
    )
      throw Error(
        "Declare each inventoried original generator and its compiler cohort",
      );
    owned.add(generator.source);
    for (const output of generator.outputs) {
      const file = path.posix.join(generator.module, output.file);
      if (
        output.file !==
          "src/main/java/" + output.className.replaceAll(".", "/") + ".java" ||
        inputs.includes(file) ||
        generated.has(file)
      )
        throw Error(
          "Generated class sources must have unique fresh conventional addresses",
        );
      generated.add(file);
    }
  }
  if (owned.size !== inputs.length)
    throw Error(
      "Every inventoried Java source needs an explicit source or generator role",
    );
  const modules = new Map<string, SpotbugsExtensions["jpms"][number]>(),
    names = new Set<string>();
  for (const module of config.jpms) {
    const stage = config.stages.find((stage) => stage.path === module.module);
    if (
      !stage ||
      modules.has(module.module) ||
      names.has(module.name) ||
      module.name === "java.base" ||
      module.requires.includes("java.base") ||
      !unique(module.requires) ||
      !unique(module.exports) ||
      !stage.sources.includes(
        path.posix.join(module.module, "src/main/java/module-info.java"),
      )
    )
      throw Error(
        "Named cohorts require exact unique native module descriptor contracts",
      );
    modules.set(module.module, module);
    names.add(module.name);
  }
  if (modules.size && modules.size !== config.stages.length)
    throw Error(
      "Mixing named and unnamed compiler cohorts needs a separate profile",
    );
  for (const stage of config.stages) {
    const descriptors = stage.sources.filter(
      (file) => path.posix.basename(file) === "module-info.java",
    );
    if (descriptors.length !== (modules.has(stage.path) ? 1 : 0))
      throw Error("Declare every selected native module descriptor");
    if (
      !stage.sources.length &&
      !config.generators.some((generator) => generator.module === stage.path)
    )
      throw Error(
        "Every compiler cohort requires original or freshly generated sources",
      );
    if (modules.size) {
      const sourceRoot = path.posix.join(stage.path, "src/main/java") + "/";
      if (stage.sources.some((file) => !file.startsWith(sourceRoot)))
        throw Error(
          "Named compiler cohorts require the exact owned conventional source root",
        );
      const expectedRequires = stage.dependsOn.map(
        (id) => modules.get(stages.get(id)!.path)!.name,
      );
      if (modules.get(stage.path)!.requires.length !== expectedRequires.length)
        throw Error(
          "Named requires contracts must match the declared compiler dependency inventory",
        );
      for (const id of stage.dependsOn) {
        const dependency = stages.get(id)!;
        if (
          !modules
            .get(stage.path)!
            .requires.includes(modules.get(dependency.path)!.name)
        )
          throw Error(
            "Named compiler dependencies must appear in the native requires contract",
          );
      }
    }
  }
  const pluginIds = new Set<string>([spotbugsCorePluginId]),
    pluginPaths = new Set<string>(),
    detectorNames = new Set<string>(
      spotbugsCoreFactories.map((factory) => factory.detector),
    ),
    patternTypes = new Set<string>(
      spotbugsCorePatterns.map((pattern) => pattern.type),
    );
  for (const plugin of config.plugins) {
    if (
      pluginIds.has(plugin.id) ||
      pluginPaths.has(plugin.path) ||
      !plugin.path.endsWith(".jar") ||
      /[:;\r\n\0]/.test(plugin.path)
    )
      throw Error(
        "Declare unique plain byte-pinned plugin JARs and identities",
      );
    pluginIds.add(plugin.id);
    pluginPaths.add(plugin.path);
    if (
      plugin.patterns.some(
        (pattern) =>
          !spotbugsCorePatterns.some(
            (core) => core.category === pattern.category,
          ),
      )
    )
      throw Error("Plugin rules require an existing pinned core category");
    const declared = plugin.patterns.map((pattern) => pattern.type);
    if (!unique(declared))
      throw Error("Plugin rule identifiers must be exact and unique");
    const reported = new Set<string>();
    for (const detector of plugin.detectors) {
      if (
        detectorNames.has(detector.className) ||
        !unique(detector.reports) ||
        detector.reports.some((type) => !declared.includes(type))
      )
        throw Error(
          "Plugin detectors require unique classes and exact declared reports",
        );
      detectorNames.add(detector.className);
      for (const type of detector.reports) reported.add(type);
    }
    if (reported.size !== declared.length)
      throw Error("Every plugin rule needs a declared detector");
    for (const type of declared) {
      if (patternTypes.has(type))
        throw Error("Plugin rule providers cannot overlap");
      patternTypes.add(type);
    }
  }
}
