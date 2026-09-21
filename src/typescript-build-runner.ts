import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import { withinRoot } from "./inventory.js";

async function main(): Promise<void> {
  const [entry, root] = process.argv.slice(2);
  if (!entry || !root) throw new Error("Invalid TypeScript solution arguments");
  const tool = await withinRoot(root, path.relative(root, entry));
  const ts = createRequire(tool)(tool) as typeof import("typescript");
  if (ts.version !== "6.0.3")
    throw new Error(
      "TypeScript solution integration requires verified version 6.0.3",
    );
  const normalize = (file: string) => path.resolve(file);
  const inside = (file: string) => {
    const relative = path.relative(root, normalize(file));
    return (
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative)
    );
  };
  const readable = (file: string) => {
    try {
      return inside(file) && inside(realpathSync(file));
    } catch {
      return false;
    }
  };
  const memory = new Map<string, string>();
  const directories = new Set<string>();
  let bytes = 0;
  const system: import("typescript").System = {
    ...ts.sys,
    fileExists: (file) =>
      memory.has(normalize(file)) ||
      (!file.endsWith(".tsbuildinfo") &&
        readable(file) &&
        ts.sys.fileExists(file)),
    readFile: (file) =>
      memory.get(normalize(file)) ??
      (!file.endsWith(".tsbuildinfo") && readable(file)
        ? ts.sys.readFile(file)
        : undefined),
    directoryExists: (directory) =>
      directories.has(normalize(directory)) ||
      (readable(directory) && ts.sys.directoryExists(directory)),
    getDirectories: (directory) =>
      readable(directory) ? ts.sys.getDirectories(directory) : [],
    readDirectory: (directory, ...args) =>
      readable(directory)
        ? ts.sys.readDirectory(directory, ...args).filter(readable)
        : [],
    writeFile: (file, text) => {
      const target = normalize(file);
      if (!inside(target))
        throw new Error("TypeScript output escapes the configured root");
      bytes +=
        Buffer.byteLength(text) - Buffer.byteLength(memory.get(target) ?? "");
      if (bytes > 64 * 1024 * 1024 || memory.size >= 20_000)
        throw new Error("TypeScript in-memory output limit exceeded");
      memory.set(target, text);
      let directory = path.dirname(target);
      while (inside(directory)) {
        directories.add(directory);
        if (directory === root) break;
        directory = path.dirname(directory);
      }
    },
    createDirectory: (directory) => {
      if (!inside(directory))
        throw new Error("TypeScript output escapes the configured root");
      directories.add(normalize(directory));
    },
    getModifiedTime: (file) =>
      memory.has(normalize(file))
        ? new Date()
        : file.endsWith(".tsbuildinfo")
          ? undefined
          : readable(file)
            ? ts.sys.getModifiedTime?.(file)
            : undefined,
    setModifiedTime: () => {},
    deleteFile: (file) => {
      memory.delete(normalize(file));
    },
  };
  const diagnostics: import("typescript").Diagnostic[] = [];
  const configs = new Set<string>();
  const files = new Set<string>();
  let programs = 0;
  const host = ts.createSolutionBuilderHost(system, undefined, (diagnostic) =>
    diagnostics.push(diagnostic),
  );
  host.getParsedCommandLine = (file) => {
    if (!readable(file))
      throw new Error(
        "TypeScript referenced configuration is missing or outside the configured root",
      );
    configs.add(normalize(file));
    return ts.getParsedCommandLineOfConfigFile(
      file,
      { noCheck: false, noEmit: false, noEmitOnError: true, incremental: true },
      {
        ...system,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
          diagnostics.push(diagnostic),
      },
    );
  };
  host.afterProgramEmitAndDiagnostics = (program) => {
    programs++;
    for (const file of program.getSourceFiles())
      files.add(normalize(file.fileName));
  };
  const exitStatus = ts
    .createSolutionBuilder(host, [path.resolve("tsconfig.json")], {
      force: true,
    })
    .build();
  process.stdout.write(
    JSON.stringify({
      version: 1,
      exitStatus,
      programs,
      configs: [...configs].sort(),
      files: [...files].sort(),
      diagnostics: diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ...(diagnostic.file
          ? {
              file: normalize(diagnostic.file.fileName),
              ...(diagnostic.start === undefined
                ? {}
                : {
                    line:
                      diagnostic.file.getLineAndCharacterOfPosition(
                        diagnostic.start,
                      ).line + 1,
                  }),
            }
          : {}),
      })),
    }) + "\n",
  );
  process.exitCode = exitStatus === 0 && !diagnostics.length ? 0 : 1;
}
main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "TypeScript solution failed") +
      "\n",
  );
  process.exitCode = 2;
});
