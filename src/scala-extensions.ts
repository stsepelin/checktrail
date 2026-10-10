import path from "node:path";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
const className = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
export const scalaExtensionsSchema = z.strictObject({
  profile: z.literal("linux-arm64-scala3-mixed-generated-script-v1"),
  javaSources: z.array(externalPathSchema).max(1000),
  scripts: z
    .array(z.strictObject({ file: externalPathSchema, className }))
    .max(500),
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
  stages: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        sources: z.array(externalPathSchema).min(1).max(2000),
      }),
    )
    .min(1)
    .max(8),
});
export type ScalaExtensions = z.infer<typeof scalaExtensionsSchema>;
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function validateScalaExtensionScope(
  ext: ScalaExtensions,
  scope: string[],
) {
  if (
    new Set(scope).size !== scope.length ||
    scope.some((f) => !/\.(scala|sc|java)$/.test(f))
  )
    throw Error(
      "Mixed Scala scope requires unique selected Scala, script and Java sources",
    );
  const generators = ext.generators.map((g) => g.source),
    generated = ext.generators.flatMap((g) => g.outputs.map((o) => o.file));
  if (
    !same(
      [...ext.javaSources, ...generators],
      scope.filter((f) => f.endsWith(".java")),
    ) ||
    !ext.javaSources.every(
      (f) =>
        f.endsWith(".java") && path.posix.basename(f) !== "module-info.java",
    ) ||
    !same(
      ext.scripts.map((s) => s.file),
      scope.filter((f) => f.endsWith(".sc")),
    )
  )
    throw Error(
      "Declare every Java source, generator and compile-only Scala script exactly once",
    );
  const used = new Set(scope);
  for (const g of ext.generators) {
    if (
      !g.source.startsWith("generators/") ||
      path.posix.basename(g.source) !== g.className.split(".").at(-1) + ".java"
    )
      throw Error("Declare an inventoried Java generator class source");
    for (const o of g.outputs) {
      if (
        o.file !==
          "src/main/scala/" + o.className.replaceAll(".", "/") + ".scala" ||
        used.has(o.file)
      )
        throw Error(
          "Generated Scala primary classes require fresh conventional source paths",
        );
      used.add(o.file);
    }
  }
  const scripts = ext.scripts.map(
    (s) => "scripts/" + s.className.replaceAll(".", "/") + ".scala",
  );
  if (
    new Set(scripts).size !== scripts.length ||
    scripts.some((s) => used.has(s))
  )
    throw Error(
      "Scala script wrapper names must be unique and distinct from selected sources",
    );
  const compilerSources = [
    ...scope.filter((f) => /\.(scala|sc)$/.test(f)),
    ...generated,
  ];
  if (
    !compilerSources.length ||
    compilerSources.length > 2000 ||
    new Set(ext.stages.map((s) => s.id)).size !== ext.stages.length ||
    !same(
      ext.stages.flatMap((s) => s.sources),
      compilerSources,
    )
  )
    throw Error(
      "Ordered Scala compilation stages must account for every selected compiler source exactly once",
    );
  return { generators, generated, compilerSources };
}
export function scalaScriptSource(
  script: ScalaExtensions["scripts"][number],
  bytes: Buffer,
) {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (unsupportedScriptDirective(text))
    throw Error(
      "Scala script directives, shebangs and package declarations require a separate script profile",
    );
  const parts = script.className.split("."),
    name = parts.pop()!;
  const prefix =
    (parts.length
      ? "package " + parts.map((part) => "`" + part + "`").join(".") + "\n"
      : "") +
    "object " +
    "`" +
    name +
    "`" +
    " {\n";
  const source = Buffer.from(
    prefix + text + (text.endsWith("\n") ? "" : "\n") + "}\n",
  );
  if (source.length > 1024 * 1024)
    throw Error("Scala script wrapper source budget");
  return {
    file: "scripts/" + script.className.replaceAll(".", "/") + ".scala",
    bytes: source,
    lineOffset: prefix.split("\n").length - 1,
  };
}

// Inspect script directives only where the lexer sees code or a real line
// comment. Literal contents and nested block comments do not request tooling.
function unsupportedScriptDirective(text: string): boolean {
  if (text.startsWith("#!")) return true;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i),
        limit = end < 0 ? text.length : end;
      if (/^\/\/>/.test(text.slice(i, limit))) return true;
      i = limit;
      continue;
    }
    if (text.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < text.length && depth) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    const quote = text[i];
    if (quote === '"' || quote === "`" || quote === "'") {
      // A quote before { or [ starts Scala quoted code, rather than a character.
      if (quote === "'" && (text[i + 1] === "{" || text[i + 1] === "[")) {
        i++;
        continue;
      }
      i++;
      while (i < text.length) {
        if (text[i] === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (text[i++] === quote) break;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(text[i]!)) {
      const start = i++;
      while (i < text.length && /[\w$]/.test(text[i]!)) i++;
      if (text.slice(start, i) === "package") return true;
      continue;
    }
    i++;
  }
  return false;
}
