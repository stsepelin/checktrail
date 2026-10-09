import path from "node:path";
import { realpathSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { javascriptSource } from "./javascript-source.js";
import {
  viteLibraryManifestSchema,
  viteLibraryReceiptSchema,
} from "./vite-library-contract.js";
import { viteLibraryPrerequisites } from "./vite-library-prerequisites.js";
async function main() {
  const [entry, compiler, root, encoded] = process.argv.slice(2);
  if (
    !entry ||
    !compiler ||
    !root ||
    !encoded ||
    process.argv.length !== 6 ||
    Buffer.byteLength(encoded) > 65536 ||
    !process.env.CHECKTRAIL_TEMP
  )
    throw new Error("Invalid Vite library runner arguments");
  const manifest = viteLibraryManifestSchema.parse(JSON.parse(encoded));
  let ready;
  try {
    ready = await viteLibraryPrerequisites(root, entry, compiler);
  } catch {
    ready = { available: false as const, reason: "missing-runtime" };
  }
  if (!ready.available) {
    process.stdout.write(
      JSON.stringify({ unavailable: "vite-library", reason: ready.reason }) +
        "\n",
    );
    process.exitCode = 3;
    return;
  }
  const cwd = process.cwd();
  const abs = (file: string) => path.resolve(cwd, file);
  const inputs = [...manifest.sources, ...manifest.consumers];
  if (
    new Set(inputs.map((f) => f.path)).size !== inputs.length ||
    !manifest.sources.some((f) => f.path === manifest.profile.entry)
  )
    throw new Error("Invalid Vite source identities");
  const verify = async () => {
    for (const input of inputs) {
      const observed = (
        await javascriptSource(root, path.relative(root, abs(input.path)))
      ).identity;
      if (observed.bytes !== input.bytes || observed.sha256 !== input.sha256)
        throw new Error("Planned Vite library source changed");
    }
  };
  await verify();
  const vite = (await import(
    pathToFileURL(entry).href
  )) as typeof import("vite");
  const ts = createRequire(compiler)(compiler) as typeof import("typescript");
  const memory = new Map<string, string>();
  const temporary = realpathSync(process.env.CHECKTRAIL_TEMP!);
  const stage = async (phase: string) => {
    const file = path.join(temporary, "library-stage.pending");
    await writeFile(
      file,
      JSON.stringify({
        phase,
        pid: process.pid,
        sourceFingerprint: manifest.sourceFingerprint,
      }),
    );
    await rename(file, path.join(temporary, "library-stage.json"));
  };
  const output = path.join(temporary, "declarations");
  let emitted = 0;
  const readable = (file: string) => {
    try {
      const resolved = realpathSync(file);
      const relative = path.relative(root, resolved);
      return (
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
      );
    } catch {
      return false;
    }
  };
  const host = ts.createCompilerHost({});
  host.fileExists = (file) =>
    memory.has(path.resolve(file)) ||
    (readable(file) && ts.sys.fileExists(file));
  host.readFile = (file) =>
    memory.get(path.resolve(file)) ??
    (readable(file) ? ts.sys.readFile(file) : undefined);
  host.getSourceFile = (file, language) => {
    const text = host.readFile(file);
    return text === undefined
      ? undefined
      : ts.createSourceFile(file, text, language);
  };
  host.directoryExists = (directory) =>
    directory === output ||
    [...memory.keys()].some((file) =>
      file.startsWith(path.resolve(directory) + path.sep),
    ) ||
    (readable(directory) && ts.sys.directoryExists(directory));
  host.writeFile = (file, text) => {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(output + path.sep) || !/\.d\.[cm]?ts$/.test(file))
      throw new Error("Unsupported declaration output");
    emitted += Buffer.byteLength(text);
    if (emitted > 16 * 1024 * 1024 || memory.size >= 4096)
      throw new Error("Declaration budget exhausted");
    memory.set(resolved, text);
  };
  const options: import("typescript").CompilerOptions = {
    strict: true,
    skipLibCheck: false,
    noCheck: false,
    noEmitOnError: true,
    declaration: true,
    emitDeclarationOnly: true,
    incremental: false,
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    rootDir: abs(manifest.profile.sourceDirectory),
    outDir: output,
  };
  const producer = ts.createProgram(
    manifest.sources.map((f) => abs(f.path)),
    options,
    host,
  );
  const diagnostics = [...ts.getPreEmitDiagnostics(producer)];
  if (!diagnostics.length) diagnostics.push(...producer.emit().diagnostics);
  await stage("producer-complete");
  const declarationEntry = path
    .join(
      output,
      path.relative(
        abs(manifest.profile.sourceDirectory),
        abs(manifest.profile.entry),
      ),
    )
    .replace(/\.[cm]?[jt]s$/, (file) =>
      file === ".mts" ? ".d.mts" : file === ".cts" ? ".d.cts" : ".d.ts",
    );
  const resolutions: { consumer: string; declaration: string }[] = [];
  const consumerHost = { ...host };
  consumerHost.writeFile = () => {
    throw new Error("Consumer outputs must not be emitted");
  };
  consumerHost.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      if (name === "checktrail:library") {
        resolutions.push({
          consumer: containingFile,
          declaration: declarationEntry,
        });
        return memory.has(declarationEntry)
          ? {
              resolvedFileName: declarationEntry,
              extension: declarationEntry.endsWith(".d.mts")
                ? ts.Extension.Dmts
                : declarationEntry.endsWith(".d.cts")
                  ? ts.Extension.Dcts
                  : ts.Extension.Dts,
            }
          : undefined;
      }
      return ts.resolveModuleName(
        name,
        containingFile,
        { ...options, noEmit: true },
        consumerHost,
      ).resolvedModule;
    });
  const consumerOptions = {
    ...options,
    noEmit: true,
    emitDeclarationOnly: false,
  };
  delete consumerOptions.rootDir;
  delete consumerOptions.outDir;
  const consumer = ts.createProgram(
    manifest.consumers.map((f) => abs(f.path)),
    consumerOptions,
    consumerHost,
  );
  diagnostics.push(...ts.getPreEmitDiagnostics(consumer));
  const builds: {
    format: "es" | "cjs";
    modules: string[];
    chunks: {
      artifact: { path: string; bytes: number; sha256: string };
      exports: string[];
      entry: string;
      imports: string[];
      dynamicImports: string[];
    }[];
  }[] = [];
  const identity = (file: string, text: string) => ({
    path: file,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  const sourceFiles = manifest.sources.map((f) => abs(f.path));
  const consumerFiles = manifest.consumers.map((f) => abs(f.path));
  const compilerDirectory = ready.directories!.typescript!;
  const normal = (program: import("typescript").Program) =>
    program
      .getSourceFiles()
      .filter(
        (f) =>
          !f.fileName.startsWith(
            path.join(compilerDirectory, "lib") + path.sep,
          ),
      )
      .map((f) => path.resolve(f.fileName))
      .sort();
  let complete = true;
  if (!diagnostics.length) {
    await stage("vite-start");
    await vite.build({
      root: cwd,
      configFile: false,
      logLevel: "silent",
      cacheDir: path.join(temporary, "cache"),
      plugins: [
        {
          name: "checktrail-native-library-accounting",
          generateBundle(options, bundle) {
            if (options.format !== "es" && options.format !== "cjs")
              throw new Error("Unexpected native library format");
            const modules = [...this.getModuleIds()].sort();
            const chunks = [];
            for (const artifact of Object.values(bundle)) {
              if (
                artifact.type !== "chunk" ||
                !artifact.isEntry ||
                !artifact.facadeModuleId
              ) {
                complete = false;
                continue;
              }
              chunks.push({
                artifact: identity(artifact.fileName, artifact.code),
                exports: [...artifact.exports].sort(),
                entry: artifact.facadeModuleId,
                imports: [...artifact.imports],
                dynamicImports: [...artifact.dynamicImports],
              });
            }
            builds.push({ format: options.format, modules, chunks });
          },
        },
      ],
      build: {
        write: false,
        emptyOutDir: false,
        watch: null,
        minify: false,
        sourcemap: false,
        lib: {
          entry: abs(manifest.profile.entry),
          formats: ["es", "cjs"],
          fileName: (format) =>
            format === "es" ? "library.mjs" : "library.cjs",
        },
        rolldownOptions: { external: [] },
      },
    });
  }
  const producerFiles = normal(producer);
  const reachedConsumers = normal(consumer);
  complete &&=
    JSON.stringify(producerFiles) === JSON.stringify([...sourceFiles].sort()) &&
    sourceFiles.length > 0 &&
    consumerFiles.every((file) => reachedConsumers.includes(file)) &&
    reachedConsumers.every(
      (file) => consumerFiles.includes(file) || memory.has(file),
    ) &&
    consumerFiles.every((file) =>
      resolutions.some((r) => r.consumer === file),
    ) &&
    memory.has(declarationEntry) &&
    builds.length === 2 &&
    builds.every(
      (build) =>
        build.chunks.length === 1 &&
        build.chunks[0]!.entry === abs(manifest.profile.entry) &&
        build.chunks[0]!.imports.length === 0 &&
        build.chunks[0]!.dynamicImports.length === 0 &&
        build.chunks[0]!.exports.length > 0 &&
        JSON.stringify(build.modules) ===
          JSON.stringify([...sourceFiles].sort()),
    ) &&
    JSON.stringify(builds[0]!.chunks[0]!.exports) ===
      JSON.stringify(builds[1]!.chunks[0]!.exports);
  await verify();
  const finalReady = await viteLibraryPrerequisites(root, entry, compiler);
  if (!finalReady.available)
    throw new Error("Native library tooling changed during build");
  const receipt = viteLibraryReceiptSchema.parse({
    schemaVersion: 1,
    manifest,
    versions: { vite: "8.3.0", rolldown: "1.2.9", typescript: ts.version },
    complete,
    producerFiles,
    consumerFiles: reachedConsumers,
    resolutions,
    diagnostics: diagnostics.map((d) => ({
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ...(d.file
        ? {
            file: d.file.fileName,
            ...(d.start === undefined
              ? {}
              : {
                  line: d.file.getLineAndCharacterOfPosition(d.start).line + 1,
                }),
          }
        : {}),
    })),
    declarations: [...memory].map(([file, text]) =>
      identity(path.relative(output, file), text),
    ),
    builds,
  });
  process.stdout.write(JSON.stringify(receipt) + "\n");
  process.exitCode = diagnostics.length ? 1 : 0;
}
main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "Native library build failed") +
      "\n",
  );
  process.exitCode = 2;
});
