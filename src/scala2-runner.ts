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
import { scalaInvocationSchema } from "./scala.js";
import { scala2Inputs, scala2ConfigSchema } from "./scala2.js";
import { scala2Artifacts } from "./scala2-artifacts.js";
import { scala2Hash } from "./scala2-archive.js";
import { scala2NativeSource } from "./scala2-native.js";
import { kotlinRead } from "./kotlin-io.js";
import { withinRoot } from "./inventory.js";
import { verifyJvmToolchain } from "./jvm-extensions.js";
import { jvmInvoker, type JvmInvocationResult } from "./jvm-invoke.js";
import { captureProcessOutput } from "./process-output.js";
const env = { ...process.env };
for (const name of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
])
  delete env[name];
const chunks: Buffer[] = [];
const invocations: JvmInvocationResult[] = [];
const nativeInvoke = jvmInvoker(env, true, (chunk) =>
  chunks.push(Buffer.from(chunk)),
);
const invoke = async (args: string[]) => {
  const r = await nativeInvoke("java", [
    "-Xmx512m",
    "-Dfile.encoding=UTF-8",
    ...args,
  ]);
  invocations.push(r);
  if (r.status !== 0 || r.signal || r.error)
    throw Error("Scala 2 native process failed");
  return r;
};
const silent = (r: JvmInvocationResult) => {
  if (r.stdoutBytes || r.stderrBytes)
    throw Error("Original Scala 2 helper emitted unexpected output");
};
async function binding(file: string) {
  const bytes = await kotlinRead(file, 1024 * 1024);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { file, bytes: bytes.length, sha256: scala2Hash(bytes) };
}
async function outputInventory(directory: string) {
  const values: { file: string; bytes: number; sha256: string }[] = [];
  let nodes = 0,
    total = 0;
  const walk = async (prefix: string) => {
    for (const entry of await readdir(path.join(directory, prefix), {
      withFileTypes: true,
    })) {
      if (++nodes > 10000) throw Error("Scala 2 output inventory bound");
      const file = path.join(directory, prefix, entry.name),
        info = await lstat(file);
      if (info.isSymbolicLink()) throw Error("Scala 2 output link");
      if (info.isDirectory()) await walk(path.join(prefix, entry.name));
      else if (info.isFile()) {
        const bytes = await kotlinRead(file, 32 * 1024 * 1024);
        total += bytes.length;
        if (total > 64 * 1024 * 1024 || values.length >= 4001)
          throw Error("Scala 2 output bytes/count bound");
        values.push({
          file: path.relative(directory, file),
          bytes: bytes.length,
          sha256: scala2Hash(bytes),
        });
      } else throw Error("Scala 2 output special entry");
    }
  };
  await walk("");
  return values.sort((a, b) => a.file.localeCompare(b.file));
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".",
    serialized = process.argv[3]!,
    invocation = scalaInvocationSchema.parse(JSON.parse(serialized)),
    config = scala2ConfigSchema.parse(invocation.config);
  let home: string;
  try {
    home = await verifyJvmToolchain();
  } catch {
    process.stdout.write(JSON.stringify({ unavailable: "scala-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const version = await jvmInvoker(env, false)("java", ["--version"]);
  if (version.status !== 0 || version.signal || version.stderrBytes)
    throw Error("Pinned Java version probe failed");
  const inputs = await scala2Inputs(root, project, config);
  const original = [];
  let total = 0;
  for (const file of invocation.scope) {
    if (!file.endsWith(".scala"))
      throw Error("Selected Scala 2 source extension");
    const absolute = path.resolve(root, project, file);
    if ((await withinRoot(root, path.relative(root, absolute))) !== absolute)
      throw Error("Scala 2 source link");
    const value = await binding(absolute);
    total += value.bytes;
    original.push(value);
  }
  if (total > 32 * 1024 * 1024) throw Error("Scala 2 source bytes bound");
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "checktrail-scala2-"),
  );
  try {
    const libraries = path.join(temporary, "scala2/lib"),
      classes = path.join(temporary, "classes"),
      snapshot = path.join(temporary, "snapshot"),
      output = path.join(temporary, "output"),
      dependencies = path.join(temporary, "dependencies");
    for (const dir of [libraries, classes, snapshot, output, dependencies])
      await mkdir(dir, { recursive: true });
    const libraryFiles = [];
    for (const library of scala2Artifacts.runtimeLibraries) {
      const file = path.join(libraries, library.name);
      await writeFile(file, inputs.libraries.get(library.name)!, {
        flag: "wx",
        mode: 0o600,
      });
      libraryFiles.push(file);
    }
    const dependencyFiles: string[] = [];
    for (const [i, dep] of inputs.dependencies.entries()) {
      const file = path.join(dependencies, i + ".jar");
      await writeFile(file, dep.bytes, { flag: "wx", mode: 0o600 });
      dependencyFiles.push(file);
    }
    const staged = [];
    for (const [i, file] of invocation.scope.entries()) {
      const target = path.resolve(snapshot, file);
      if (!target.startsWith(snapshot + path.sep))
        throw Error("Scala 2 snapshot escape");
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = await kotlinRead(original[i]!.file, 1024 * 1024);
      if (scala2Hash(bytes) !== original[i]!.sha256)
        throw Error("Scala 2 source changed before staging");
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      staged.push({ ...original[i]!, nativeFile: target });
    }
    const helper = path.join(temporary, "VerifierScala2.scala");
    await writeFile(helper, scala2NativeSource, { flag: "wx", mode: 0o600 });
    const compilerClasspath = libraryFiles.join(path.delimiter);
    silent(
      await invoke([
        "-classpath",
        compilerClasspath,
        "scala.tools.nsc.Main",
        "-encoding",
        "UTF-8",
        "-release:25",
        "-classpath",
        compilerClasspath,
        "-d",
        classes,
        helper,
      ]),
    );
    const observerBefore = await outputInventory(classes);
    const runtimeFiles = [
      ...libraryFiles.map((file, i) => ({
        file,
        bytes: scala2Artifacts.runtimeLibraries[i]!.bytes,
        sha256: scala2Artifacts.runtimeLibraries[i]!.sha256,
      })),
      ...dependencyFiles.map((file, i) => ({
        file,
        bytes: inputs.dependencies[i]!.bytes.length,
        sha256: inputs.dependencies[i]!.sha256,
      })),
    ];
    const classpath = classes + path.delimiter + compilerClasspath;
    if (process.argv[4] === "--version") {
      const probe = await jvmInvoker(env, false)("java", [
        "-classpath",
        classpath,
        "VerifierScala2",
        "--version",
      ]);
      if (
        probe.status !== 0 ||
        probe.signal ||
        probe.stderrBytes ||
        probe.stdout !== "Scala compiler 2.13.18\n"
      )
        throw Error("Scala 2 observer version disagrees");
      process.stdout.write(probe.stdout);
      return;
    }
    const applicationClasspath = [
      libraryFiles.find((f) => path.basename(f) === "scala-library.jar")!,
      ...dependencyFiles,
    ].join(path.delimiter);
    const native = await invoke([
      "-classpath",
      classpath,
      "VerifierScala2",
      output,
      applicationClasspath,
      config.jvmTarget,
      String(config.warningsAsErrors),
      ...staged.map((s) => s.nativeFile),
    ]);
    for (const value of runtimeFiles) {
      const bytes = await kotlinRead(value.file, 32 * 1024 * 1024);
      if (bytes.length !== value.bytes || scala2Hash(bytes) !== value.sha256)
        throw Error("Staged Scala 2 runtime artifacts changed");
    }
    if (
      JSON.stringify(await outputInventory(classes)) !==
        JSON.stringify(observerBefore) ||
      scala2Hash(await kotlinRead(helper, 1024 * 1024)) !==
        scala2Hash(scala2NativeSource)
    )
      throw Error("Original Scala 2 observer changed");
    const fresh = await scala2Inputs(root, project, config);
    if (
      !fresh.bytes.equals(inputs.bytes) ||
      fresh.dependencies.some(
        (dep, i) => !dep.bytes.equals(inputs.dependencies[i]!.bytes),
      )
    )
      throw Error("Original Scala 2 tool inputs changed");
    await verifyJvmToolchain();
    process.stdout.write(
      JSON.stringify({
        version: 1,
        requestDigest: scala2Hash(serialized),
        scala: scala2Artifacts.version,
        javaHome: home,
        toolchain: version.stdout.trim(),
        sources: staged,
        after: await Promise.all(original.map((s) => binding(s.file))),
        snapshotAfter: await Promise.all(
          staged.map((s) => binding(s.nativeFile)),
        ),
        outputAfter: await outputInventory(output),
        native: JSON.parse(native.stdout),
        nativeOutput: captureProcessOutput(
          Buffer.from(native.stdout),
          Buffer.from(native.stderr),
          native.stdoutBytes + native.stderrBytes,
          true,
        ),
        invocations: invocations.map((r) => ({
          stdoutBytes: r.stdoutBytes,
          stderrBytes: r.stderrBytes,
        })),
        mirroredOutput: captureProcessOutput(
          Buffer.alloc(0),
          Buffer.concat(chunks),
          chunks.reduce((n, b) => n + b.length, 0),
          true,
        ),
        stagedArtifactsVerified: true,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stdout.write(
    JSON.stringify({ error: "Scala 2 native collection failed" }),
  );
  process.exitCode = 2;
});
