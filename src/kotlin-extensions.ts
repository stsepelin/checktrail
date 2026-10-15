import path from "node:path";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
const className = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
export const kotlinExtensionsSchema = z.strictObject({
  profile: z.literal("linux-arm64-mixed-generated-script-v1"),
  javaSources: z.array(externalPathSchema).max(1000),
  scripts: z.array(externalPathSchema).max(500),
  generators: z
    .array(
      z.strictObject({
        source: externalPathSchema,
        className,
        outputs: z
          .array(z.strictObject({ file: externalPathSchema, className }))
          .min(1)
          .max(32),
      }),
    )
    .max(8),
});
export type KotlinExtensions = z.infer<typeof kotlinExtensionsSchema>;
const same = (actual: string[], expected: string[]) =>
  new Set(actual).size === actual.length &&
  new Set(expected).size === expected.length &&
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
export function validateKotlinExtensionScope(
  extensions: KotlinExtensions,
  scope: string[],
) {
  if (
    new Set(scope).size !== scope.length ||
    scope.some((f) => !/\.(kt|kts|java)$/.test(f))
  )
    throw Error("Mixed Kotlin scope must contain unique declared source files");
  const generators = extensions.generators.map((g) => g.source);
  if (
    !same(
      [...extensions.javaSources, ...generators],
      scope.filter((f) => f.endsWith(".java")),
    ) ||
    !extensions.javaSources.every(
      (f) =>
        f.endsWith(".java") && path.posix.basename(f) !== "module-info.java",
    ) ||
    !same(
      extensions.scripts,
      scope.filter((f) => f.endsWith(".kts")),
    )
  )
    throw Error(
      "Declare every selected Java and compile-only Kotlin script exactly once",
    );
  const used = new Set(scope);
  for (const generator of extensions.generators) {
    if (
      !generator.source.startsWith("generators/") ||
      path.posix.basename(generator.source) !==
        generator.className.split(".").at(-1) + ".java"
    )
      throw Error("Declare inventoried Java generator class sources");
    for (const output of generator.outputs) {
      if (
        output.file !==
          "src/main/kotlin/" + output.className.replaceAll(".", "/") + ".kt" ||
        used.has(output.file)
      )
        throw Error(
          "Generated Kotlin primary classes require unique fresh conventional source paths",
        );
      used.add(output.file);
    }
  }
  const generated = extensions.generators.flatMap((g) =>
    g.outputs.map((o) => o.file),
  );
  if (
    scope.filter((f) => !generators.includes(f)).length + generated.length >
      2000 ||
    (!scope.some((f) => f.endsWith(".kt") || f.endsWith(".kts")) &&
      !generated.length)
  )
    throw Error(
      "Selected mixed Kotlin compilation requires bounded nonempty Kotlin inputs",
    );
  return { generators, generated };
}
