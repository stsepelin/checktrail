import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clangInvocationSchema } from "./clang.js";
import { clangDependencies, supportedClangVersion } from "./clang-protocol.js";
import { withinRoot } from "./inventory.js";

function invoke(executable: string, args: string[], cwd: string) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null)
    throw new Error("Clang did not complete within native evidence limits");
  return result;
}

async function main() {
  const [rootInput, encoded] = process.argv.slice(2);
  if (!rootInput || !encoded) throw new Error("Missing Clang invocation");
  const root = await realpath(rootInput);
  const projectRoot = await realpath(process.cwd());
  const invocation = clangInvocationSchema.parse(JSON.parse(encoded));
  const versions = new Map<string, string>();
  for (const name of new Set(invocation.units.map((unit) => unit.compiler))) {
    let output;
    try {
      output = invoke(name, ["--no-default-config", "--version"], projectRoot);
    } catch {
      process.stdout.write(
        JSON.stringify({
          unavailable: "clang-toolchain",
          reason: "missing-tool",
        }),
      );
      process.exitCode = 3;
      return;
    }
    if (
      output.status !== 0 ||
      output.stderr.trim() ||
      !supportedClangVersion(output.stdout)
    ) {
      process.stdout.write(
        JSON.stringify({
          unavailable: "clang-toolchain",
          reason: "unsupported-version",
        }),
      );
      process.exitCode = 3;
      return;
    }
    versions.set(name, output.stdout.trim());
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-clang-"));
  const expected = new Set(
    invocation.scope.map((file) => path.resolve(projectRoot, file)),
  );
  let bytes = 0;
  let dependencyBytes = 0;
  try {
    const units = [];
    for (const [index, unit] of invocation.units.entries()) {
      const cwd = await withinRoot(root, unit.cwd);
      await withinRoot(
        root,
        path.relative(root, path.resolve(projectRoot, unit.file)),
      );
      const dependencyFile = path.join(temporary, `unit-${index}.d`);
      const args = [
        "--no-default-config",
        ...unit.args,
        "-fsyntax-only",
        "-fno-modules",
        "-fno-implicit-modules",
        "-fdiagnostics-format=sarif",
        "-Wno-sarif-format-unstable",
        "-fno-color-diagnostics",
        "-ferror-limit=0",
        "-MD",
        "-MF",
        dependencyFile,
        "-MT",
        "checktrail",
        unit.input,
      ];
      const native = invoke(unit.compiler, args, cwd);
      bytes +=
        Buffer.byteLength(native.stdout) + Buffer.byteLength(native.stderr);
      if (bytes > 4 * 1024 * 1024)
        throw new Error("Clang evidence exceeds total output limits");
      const first = native.stderr.indexOf("{");
      const last = native.stderr.lastIndexOf("}");
      let diagnostics: unknown = null;
      let scopeError = native.stdout.trim() !== "";
      const tail = native.stderr.slice(last + 1).trim();
      if (
        first < 0 ||
        native.stderr.slice(0, first).trim() ||
        (tail &&
          !/^(?:(?:\d+ warnings?(?: and )?)?\d+ errors?|\d+ warnings?) generated\.$/.test(
            tail,
          ))
      )
        scopeError = true;
      else {
        try {
          diagnostics = JSON.parse(native.stderr.slice(first, last + 1));
        } catch {
          scopeError = true;
        }
      }
      const observedSources: string[] = [];
      let externalDependencyCount = 0;
      try {
        const size = (await stat(dependencyFile)).size;
        dependencyBytes += size;
        if (size > 8 * 1024 * 1024 || dependencyBytes > 16 * 1024 * 1024)
          throw new Error("Dependency evidence exceeds limits");
        for (const dependency of clangDependencies(
          await readFile(dependencyFile, "utf8"),
          cwd,
        )) {
          const physical = await realpath(dependency);
          const lexical = path.relative(root, dependency);
          const physicalRelative = path.relative(root, physical);
          const inside = (relative: string) =>
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative);
          if (
            physical !== dependency &&
            (inside(lexical) || inside(physicalRelative))
          )
            scopeError = true;
          if (expected.has(physical))
            observedSources.push(
              path.relative(projectRoot, physical).split(path.sep).join("/"),
            );
          else {
            const relative = path.relative(root, physical);
            if (
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative)
            )
              scopeError = true;
            else externalDependencyCount++;
          }
        }
      } catch {
        scopeError = true;
      }
      units.push({
        index,
        file: unit.file,
        compiler: unit.compiler,
        version: versions.get(unit.compiler),
        exitCode: native.status,
        diagnostics,
        observedSources: observedSources.sort(),
        externalDependencyCount,
        scopeError,
      });
    }
    process.stdout.write(
      JSON.stringify({
        version: 1,
        project:
          path.relative(root, projectRoot).split(path.sep).join("/") || ".",
        units,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write("Clang evidence collection could not complete\n");
  process.exitCode = 2;
});
