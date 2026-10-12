import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  detektInputs,
  detektInvocationSchema,
  detektConfigSchema,
} from "./detekt.js";
import {
  detektFullConfigFile,
  detektFullCompilerConfig,
  validateDetektFullScope,
} from "./detekt-extensions.js";
import { detektExtensionsNativeSource } from "./detekt-extensions-native.js";
import { detektHash } from "./detekt-configuration.js";
import { kotlinInputs } from "./kotlin.js";
import { kotlinRead } from "./kotlin-io.js";
import { verifyJvmToolchain, verifyJvmFile } from "./jvm-extensions.js";
import { jvmInvoker, type JvmInvocationResult } from "./jvm-invoke.js";
import { captureProcessOutput } from "./process-output.js";
import { withinRoot } from "./inventory.js";
const env = { ...process.env };
for (const key of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
])
  delete env[key];
async function main() {
  const root = await realpath(process.argv[2]!);
  const project = path.relative(root, await realpath(process.cwd())) || ".";
  const serialized = process.argv[3]!;
  const request = detektInvocationSchema.parse(JSON.parse(serialized));
  if (request.config.profile !== "core-default-full-all-selected-v1")
    throw Error("Expected selected full detekt profile");
  validateDetektFullScope(request.scope);
  let jdkHome: string;
  try {
    jdkHome = await verifyJvmToolchain();
  } catch {
    process.stdout.write(JSON.stringify({ unavailable: "detekt-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const configFile = detektFullConfigFile(root, project);
  if ((await withinRoot(root, path.relative(root, configFile))) !== configFile)
    throw Error("Full detekt configuration path identity");
  const configBytes = await kotlinRead(configFile, 100 * 1024);
  if (
    JSON.stringify(
      detektConfigSchema.parse(JSON.parse(configBytes.toString("utf8"))),
    ) !== JSON.stringify(request.config)
  )
    throw Error("Full detekt declaration changed before capture");
  const projectConfiguration = {
    file: configFile,
    bytes: configBytes.length,
    sha256: detektHash(configBytes),
  };
  const inputs = await detektInputs(root, project, request.config);
  if (process.argv[4] === "--version") {
    const result = await jvmInvoker(env, false)("java", [
      "-jar",
      inputs.jar,
      "--version",
    ]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 2;
    return;
  }
  const compiler = detektFullCompilerConfig(request.config.types);
  const kotlin = await kotlinInputs(root, project, compiler);
  const sourceBytes: Buffer[] = [],
    sources = [];
  let total = 0;
  for (const file of request.scope) {
    const declared = path.resolve(root, project, file);
    if ((await withinRoot(root, path.relative(root, declared))) !== declared)
      throw Error("Selected source link");
    const bytes = await kotlinRead(declared, 1024 * 1024);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    total += bytes.length;
    if (total > 32 * 1024 * 1024) throw Error("Selected source byte bound");
    sourceBytes.push(bytes);
    sources.push({
      file: declared,
      bytes: bytes.length,
      sha256: detektHash(bytes),
      canonicalSha256: detektHash(text.replace(/\r\n?/g, "\n")),
    });
  }
  const temporary = await mkdtemp(
    path.join(
      process.env.CHECKTRAIL_TEMP ?? tmpdir(),
      "checktrail-detekt-full-",
    ),
  );
  try {
    const snapshot = path.join(temporary, "snapshot"),
      stagedJar = path.join(temporary, "detekt.jar"),
      helper = path.join(temporary, "VerifierDetekt.java"),
      classes = path.join(temporary, "classes"),
      plugin = path.join(temporary, "listener.jar"),
      receipt = path.join(temporary, "receipt.json"),
      configuration = path.join(temporary, "rules.yml");
    const staged: { file: string; bytes: number; sha256: string }[] = [];
    async function stage(file: string, bytes: Buffer | string) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      staged.push({
        file,
        bytes: Buffer.byteLength(bytes),
        sha256: detektHash(bytes),
      });
    }
    const nativeFiles: string[] = [];
    for (const [i, f] of request.scope.entries()) {
      const file = path.join(snapshot, f);
      await stage(file, sourceBytes[i]!);
      nativeFiles.push(file);
    }
    await stage(stagedJar, inputs.bytes);
    await stage(helper, detektExtensionsNativeSource);
    await stage(configuration, inputs.configuration);
    const classPath = [],
      dependencies = [];
    const stdlib = path.join(temporary, "libraries/kotlin-stdlib.jar");
    await stage(stdlib, kotlin.libraries.get("kotlin-stdlib.jar")!);
    classPath.push(stdlib);
    for (const [i, d] of kotlin.dependencies.entries()) {
      const file = path.join(
        temporary,
        "dependencies",
        String(i),
        "dependency.jar",
      );
      await stage(file, d.bytes);
      classPath.push(file);
      dependencies.push({
        file: d.file,
        bytes: d.bytes.length,
        sha256: d.sha256,
        nativeFile: file,
      });
    }
    const invocations: JvmInvocationResult[] = [],
      mirrored: Buffer[] = [];
    let observedBytes = 0;
    const invoke = jvmInvoker(env, true, (chunk) => {
      observedBytes += chunk.length;
      mirrored.push(Buffer.from(chunk));
    });
    const original = async (tool: string, args: string[]) => {
      for (const item of staged) await verifyJvmFile(item.file, item);
      const result = await invoke(tool, args, temporary);
      invocations.push(result);
      if (
        result.status !== 0 ||
        result.signal ||
        result.stdoutBytes ||
        result.stderrBytes
      )
        throw Error("Original full detekt observer did not complete");
    };
    await mkdir(classes);
    await original("javac", [
      "-encoding",
      "UTF-8",
      "-proc:none",
      "-implicit:none",
      "--source-path",
      "",
      "--release",
      "25",
      "-classpath",
      stagedJar,
      "-d",
      classes,
      helper,
    ]);
    const service = path.join(
      classes,
      "META-INF/services/dev.detekt.api.FileProcessListener",
    );
    await stage(service, "VerifierDetekt\n");
    for (const name of ["VerifierDetekt.class"]) {
      const file = path.join(classes, name),
        bytes = await kotlinRead(file, 1024 * 1024);
      staged.push({ file, bytes: bytes.length, sha256: detektHash(bytes) });
    }
    await original("jar", [
      "--create",
      "--file",
      plugin,
      "--no-manifest",
      "-C",
      classes,
      ".",
    ]);
    const pluginBytes = await kotlinRead(plugin, 1024 * 1024);
    staged.push({
      file: plugin,
      bytes: pluginBytes.length,
      sha256: detektHash(pluginBytes),
    });
    for (const item of staged) await verifyJvmFile(item.file, item);
    const result = await invoke(
      "java",
      [
        "-Xmx512m",
        "-Dfile.encoding=UTF-8",
        "-Duser.language=en",
        "-Duser.country=US",
        "-Duser.home=" + temporary,
        "-Dchecktrail.receipt=" + receipt,
        "-jar",
        stagedJar,
        "--analysis-mode",
        "full",
        "--input",
        nativeFiles.join(path.delimiter),
        "--config",
        configuration,
        "--base-path",
        snapshot,
        "--language-version",
        "2.4",
        "--api-version",
        "2.4",
        "--jdk-home",
        jdkHome,
        "--jvm-target",
        request.config.types.jvmTarget,
        "--classpath",
        classPath.join(path.delimiter),
        "--plugins",
        plugin,
        "--fail-on-severity",
        "Info",
      ],
      temporary,
    );
    invocations.push(result);
    if (observedBytes > 2 * 1024 * 1024)
      throw Error("Full detekt cumulative native output bound");
    for (const item of staged) await verifyJvmFile(item.file, item);
    let native: unknown = null;
    try {
      native = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await kotlinRead(receipt, 4 * 1024 * 1024),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const after = [];
    for (const before of sources) {
      const bytes = await kotlinRead(before.file, 1024 * 1024);
      after.push({
        file: before.file,
        bytes: bytes.length,
        sha256: detektHash(bytes),
      });
    }
    await verifyJvmFile(configFile, projectConfiguration);
    await detektInputs(root, project, request.config);
    await kotlinInputs(root, project, compiler);
    if ((await verifyJvmToolchain()) !== jdkHome)
      throw Error("Selected native toolchain changed");
    const stream = Buffer.concat(mirrored);
    process.stdout.write(
      JSON.stringify({
        version: 1,
        requestDigest: detektHash(serialized),
        detekt: "2.0.0-alpha.6",
        configurationSha256: detektHash(inputs.configuration),
        sources: sources.map((s, i) => ({ ...s, nativeFile: nativeFiles[i] })),
        after,
        native,
        nativeExit: result.status,
        nativeSignal: result.signal,
        nativeError: null,
        nativeOutput: captureProcessOutput(
          Buffer.from(result.stdout),
          Buffer.from(result.stderr),
          result.stdoutBytes + result.stderrBytes,
          !result.signal,
        ),
        warningJarUrl: pathToFileURL(stagedJar).href.replace(
          /^file:\/\/\//,
          "file:/",
        ),
        snapshot,
        jdkHome,
        classPath,
        dependencies,
        projectConfiguration,
        stagedArtifactsVerified: true,
        invocations,
        mirrored: captureProcessOutput(
          Buffer.alloc(0),
          stream,
          stream.length,
          true,
        ),
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write("Full detekt native collection could not complete\n");
  process.exitCode = 2;
});
