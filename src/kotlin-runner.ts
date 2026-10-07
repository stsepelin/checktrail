import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { kotlinInputs, kotlinInvocationSchema } from "./kotlin.js";
import { kotlinArtifacts } from "./kotlin-artifacts.js";
import { kotlinHash } from "./kotlin-archive.js";
import { kotlinRead } from "./kotlin-io.js";
import { kotlinNativeSource, kotlinRegistrarSource } from "./kotlin-native.js";
import { captureProcessOutput } from "./process-output.js";
import { withinRoot } from "./inventory.js";
const env = { ...process.env };
for (const name of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
])
  delete env[name];
const started = Date.now();
const invoke = (
  executable: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
) => {
  const remaining = 110000 - (Date.now() - started);
  if (remaining <= 0) throw Error("Kotlin native total runtime bound");
  return spawnSync(executable, args, { env, maxBuffer, timeout: remaining });
};
const completed = (result: ReturnType<typeof invoke>) =>
  !result.error &&
  !result.signal &&
  result.status === 0 &&
  !result.stdout.length &&
  !result.stderr.length;
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".",
    invocation = kotlinInvocationSchema.parse(JSON.parse(process.argv[3]!));
  const version = invoke("java", ["--version"]);
  if (
    version.error ||
    version.signal ||
    version.status !== 0 ||
    version.stderr.length ||
    !version.stdout
      .toString("utf8")
      .startsWith(
        "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
      )
  ) {
    process.stdout.write(JSON.stringify({ unavailable: "kotlin-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const inputs = await kotlinInputs(root, project, invocation.config);
  const files = await Promise.all(
    invocation.scope.map((file) => withinRoot(root, path.join(project, file))),
  );
  const sources = [],
    sourceBytes: Buffer[] = [];
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (file !== path.resolve(root, project, invocation.scope[i]!))
      throw Error("Kotlin selected source traverses links");
    const bytes = await kotlinRead(file, 1024 * 1024);
    total += bytes.length;
    if (total > 32 * 1024 * 1024) throw Error("Kotlin total source byte bound");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const nativeBytes = bytes.subarray(
      bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 3 : 0,
    );
    sourceBytes.push(bytes);
    sources.push({
      file,
      sha256: kotlinHash(bytes),
      bytes: bytes.length,
      nativeSha256: kotlinHash(nativeBytes),
      nativeBytes: nativeBytes.length,
    });
  }
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "checktrail-kotlin-"),
  );
  try {
    const libraries = path.join(temporary, "kotlinc/lib"),
      classes = path.join(temporary, "classes"),
      output = path.join(temporary, "output"),
      plugin = path.join(temporary, "original-plugin.jar"),
      snapshot = path.join(temporary, "snapshot");
    await mkdir(libraries, { recursive: true });
    await mkdir(classes);
    await mkdir(output);
    const libraryFiles = [];
    for (const library of kotlinArtifacts.runtimeLibraries) {
      const file = path.join(libraries, library.name);
      await writeFile(file, inputs.libraries.get(library.name)!, {
        flag: "wx",
        mode: 0o600,
      });
      libraryFiles.push(file);
    }
    const dependencyFiles = [];
    await mkdir(path.join(temporary, "dependencies"));
    for (const [i, dependency] of inputs.dependencies.entries()) {
      const file = path.join(temporary, "dependencies", String(i) + ".jar");
      await writeFile(file, dependency.bytes, { flag: "wx", mode: 0o600 });
      dependencyFiles.push(file);
    }
    const nativeFiles: string[] = [];
    for (const [i, file] of invocation.scope.entries()) {
      const target = path.resolve(snapshot, file);
      if (!target.startsWith(snapshot + path.sep))
        throw Error("Kotlin snapshot path escape");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, sourceBytes[i]!, { flag: "wx", mode: 0o600 });
      nativeFiles.push(target);
    }
    const helper = path.join(temporary, "VerifierKotlin.java"),
      registrar = path.join(temporary, "VerifierKotlinRegistrar.java");
    await writeFile(helper, kotlinNativeSource, { flag: "wx", mode: 0o600 });
    await writeFile(registrar, kotlinRegistrarSource, {
      flag: "wx",
      mode: 0o600,
    });
    const compiled = invoke("javac", [
      "-encoding",
      "UTF-8",
      "-proc:none",
      "-implicit:none",
      "--source-path",
      "",
      "--release",
      "25",
      "-classpath",
      libraryFiles.join(path.delimiter),
      "-d",
      classes,
      helper,
      registrar,
    ]);
    if (!completed(compiled))
      throw Error("Original Kotlin observer compilation did not complete");
    const service = path.join(classes, "META-INF/services");
    await mkdir(service, { recursive: true });
    await writeFile(
      path.join(
        service,
        "org.jetbrains.kotlin.compiler.plugin.CompilerPluginRegistrar",
      ),
      "VerifierKotlinRegistrar\n",
      { flag: "wx", mode: 0o600 },
    );
    if (
      !completed(
        invoke("jar", [
          "--create",
          "--file",
          plugin,
          "--no-manifest",
          "-C",
          classes,
          ".",
        ]),
      )
    )
      throw Error("Original Kotlin observer packaging did not complete");
    const args = [
      "-Xmx512m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-Dchecktrail.kotlin.target=" + invocation.config.jvmTarget,
      "-classpath",
      [classes, ...libraryFiles].join(path.delimiter),
      "VerifierKotlin",
    ];
    if (process.argv[4] === "--version") {
      const result = invoke("java", [...args, "--version"]);
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      process.exitCode = result.status ?? 2;
      return;
    }
    const result = invoke("java", [
      ...args,
      output,
      [
        path.join(libraries, "kotlin-stdlib.jar"),
        path.join(libraries, "annotations-13.0.jar"),
        ...dependencyFiles,
      ].join(path.delimiter),
      plugin,
      String(invocation.config.warningsAsErrors),
      ...nativeFiles,
    ]);
    const stdout = result.stdout ?? Buffer.alloc(0),
      stderr = result.stderr ?? Buffer.alloc(0);
    let native: unknown = null;
    if (!result.error && !result.signal && result.status === 0)
      native = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(stdout),
      );
    const after = [],
      snapshotAfter = [];
    for (const [i, file] of files.entries()) {
      const bytes = await kotlinRead(file, 1024 * 1024);
      after.push({ file, sha256: kotlinHash(bytes), bytes: bytes.length });
      const physical = await kotlinRead(nativeFiles[i]!, 1024 * 1024);
      snapshotAfter.push({
        file: nativeFiles[i]!,
        sha256: kotlinHash(physical),
        bytes: physical.length,
      });
    }
    const outputAfter: { file: string; sha256: string; bytes: number }[] = [];
    let generatedBytes = 0,
      generatedNodes = 0;
    const inspectOutput = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      generatedNodes += entries.length;
      if (generatedNodes > 10000) throw Error("Kotlin output inventory bound");
      for (const entry of entries) {
        const target = path.join(directory, entry.name),
          info = await lstat(target);
        if (info.isSymbolicLink()) throw Error("Kotlin output link");
        if (info.isDirectory()) await inspectOutput(target);
        else if (info.isFile()) {
          if (outputAfter.length >= 4001)
            throw Error("Kotlin output file bound");
          const bytes = await kotlinRead(target, 32 * 1024 * 1024);
          generatedBytes += bytes.length;
          if (generatedBytes > 64 * 1024 * 1024)
            throw Error("Kotlin output total byte bound");
          outputAfter.push({
            file: path.relative(output, target),
            sha256: kotlinHash(bytes),
            bytes: bytes.length,
          });
        } else throw Error("Unexpected Kotlin output kind");
      }
    };
    await inspectOutput(output);
    await kotlinInputs(root, project, invocation.config);
    process.stdout.write(
      JSON.stringify({
        version: 1,
        requestDigest: kotlinHash(process.argv[3]!),
        kotlin: kotlinArtifacts.version,
        kotlinHome: path.dirname(libraries),
        toolchain: version.stdout.toString("utf8"),
        sources: sources.map((source, i) => ({
          ...source,
          nativeFile: nativeFiles[i],
        })),
        after,
        snapshotAfter,
        outputAfter,
        native,
        nativeExit: result.status,
        nativeSignal: result.signal,
        nativeError:
          (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        nativeOutput: captureProcessOutput(
          stdout,
          stderr,
          stdout.length + stderr.length,
          !result.error && !result.signal,
        ),
        warningJarUrl: pathToFileURL(
          path.join(libraries, "kotlin-compiler.jar"),
        ).href.replace(/^file:\/\/\//, "file:/"),
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(
    "Kotlin native evidence collection could not complete\n",
  );
  process.exitCode = 2;
});
