import path from "node:path";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { dotnetBuildInvocationSchema } from "./dotnet-build.js";
import { mavenHash } from "./maven.js";
export class DotnetGeneratedScopeError extends Error {}
interface Context {
  workspace: string;
  invocation: z.infer<typeof dotnetBuildInvocationSchema>;
  compiledSources: Map<string, { bytes: number; sha256: string; sha1: string }>;
  observe: (file: string) => Promise<{ bytes: number; sha256: string }>;
  regular: (file: string, bound: number) => Promise<Buffer>;
}
export async function collectDotnetGeneratedSources(context: Context) {
  const { workspace, invocation, compiledSources, observe, regular } = context;
  const result = [];
  for (const project of invocation.config.projects) {
    if (project.language === "fsharp") continue;
    const directory = path.join(
      workspace,
      path.dirname(project.file),
      "obj/Debug/net10.0/generated",
    );
    let entries: string[] = [];
    try {
      entries = await readdir(directory, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const emitted = entries
        .filter((f) => /\.(?:cs|vb)$/.test(f))
        .map((f) => path.join(directory, f))
        .sort(),
      declared = project.roslynGeneratedSources
        .map((g) => path.join(workspace, g.file))
        .sort();
    if (
      emitted.length > 4096 ||
      new Set(emitted).size !== emitted.length ||
      JSON.stringify(emitted) !== JSON.stringify(declared)
    )
      throw new DotnetGeneratedScopeError(
        "Every native Roslyn emitted source requires an exact declaration",
      );
    for (const spec of project.roslynGeneratedSources) {
      const file = path.join(workspace, spec.file),
        bytes = await regular(file, 4 * 1024 * 1024),
        pin = {
          bytes: bytes.length,
          sha256: mavenHash(bytes),
          sha1: createHash("sha1").update(bytes).digest("hex"),
        };
      if (compiledSources.has(file))
        throw Error("Roslyn outputs must remain distinct from compiler inputs");
      compiledSources.set(file, pin);
      if (compiledSources.size > 4096)
        throw Error("Compilation source closure bound");
      const producer = invocation.config.projects.find(
        (p) => p.file === spec.generatorProject,
      )!;
      const producerAssembly = path.join(
          workspace,
          path.dirname(producer.file),
          "bin/Debug/net10.0",
          producer.assemblyName + ".dll",
        ),
        artifact = await observe(producerAssembly);
      result.push({
        project: project.file,
        file,
        generatorProject: spec.generatorProject,
        generatorClass: spec.generatorClass,
        producerAssembly,
        producerAssemblySha256: artifact.sha256,
        ...pin,
      });
    }
  }
  return result;
}
