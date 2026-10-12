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
import { kotlinHash } from "./kotlin-archive.js";
import { kotlinRead } from "./kotlin-io.js";
import { kotlinRegistrarSource } from "./kotlin-native.js";
import { kotlinExtensionsNativeSource } from "./kotlin-extensions-native.js";
import { kotlinJavaObserverSource } from "./kotlin-java-native.js";
import { kotlinEvidenceSchema } from "./kotlin-evidence.js";
import { captureProcessOutput } from "./process-output.js";
import { withinRoot } from "./inventory.js";
import { verifyJvmToolchain } from "./jvm-extensions.js";
import {
  generateJvmSources,
  jvmGeneratedClassObserverSource,
} from "./jvm-workspace-extensions.js";
import { jvmInvoker, type JvmInvocationResult } from "./jvm-invoke.js";
import { validateKotlinExtensionScope } from "./kotlin-extensions.js";
const env = { ...process.env };
for (const name of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "KOTLIN_HOME",
  "KOTLIN_RUNNER",
])
  delete env[name];
const chunks: Buffer[] = [];
const invocations: JvmInvocationResult[] = [];
const nativeInvoke = jvmInvoker(env, true, (chunk) =>
  chunks.push(Buffer.from(chunk)),
);
const invoke = async (tool: string, args: string[], cwd?: string) => {
  const result = await nativeInvoke(tool, args, cwd);
  invocations.push(result);
  if (result.status !== 0 || result.signal || result.error)
    throw Error("Kotlin extension native process failed");
  return result;
};
const silent = (result: JvmInvocationResult) => {
  if (result.stdoutBytes || result.stderrBytes)
    throw Error("Original Kotlin helper produced unexpected output");
};
const binding = async (file: string) => {
  const bytes = await kotlinRead(file, 1024 * 1024);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const native = bytes.subarray(
    bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 3 : 0,
  );
  return {
    file,
    sha256: kotlinHash(bytes),
    bytes: bytes.length,
    nativeSha256: kotlinHash(native),
    nativeBytes: native.length,
  };
};
async function outputInventory(directory: string) {
  const files: { file: string; bytes: number; sha256: string }[] = [];
  let total = 0,
    nodes = 0;
  const walk = async (prefix: string) => {
    for (const entry of await readdir(path.join(directory, prefix), {
      withFileTypes: true,
    })) {
      if (++nodes > 10000) throw Error("Mixed Kotlin output inventory bound");
      const file = path.join(directory, prefix, entry.name),
        info = await lstat(file);
      if (info.isSymbolicLink()) throw Error("Mixed Kotlin output link");
      if (info.isDirectory()) await walk(path.join(prefix, entry.name));
      else if (info.isFile()) {
        const bytes = await kotlinRead(file, 32 * 1024 * 1024);
        total += bytes.length;
        if (total > 64 * 1024 * 1024 || files.length >= 4001)
          throw Error("Mixed Kotlin output byte/file bound");
        files.push({
          file: path.relative(directory, file),
          bytes: bytes.length,
          sha256: kotlinHash(bytes),
        });
      } else throw Error("Mixed Kotlin output special entry");
    }
  };
  await walk("");
  return files;
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".";
  const serialized = process.argv[3]!,
    invocation = kotlinInvocationSchema.parse(JSON.parse(serialized)),
    ext = invocation.config.extensions;
  if (!ext) throw Error("Select the mixed Kotlin extension declaration");
  validateKotlinExtensionScope(ext, invocation.scope);
  let toolchain: string;
  try {
    toolchain = await verifyJvmToolchain();
  } catch {
    process.stdout.write(JSON.stringify({ unavailable: "kotlin-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const version = await jvmInvoker(env, false)("java", ["--version"]);
  if (version.status !== 0 || version.signal || version.stderrBytes)
    throw Error("Selected Java version probe failed");
  const inputs = await kotlinInputs(root, project, invocation.config);
  const original = [];
  let total = 0;
  for (const file of invocation.scope) {
    const absolute = path.resolve(root, project, file);
    if ((await withinRoot(root, path.relative(root, absolute))) !== absolute)
      throw Error("Mixed Kotlin source link");
    const value = await binding(absolute);
    total += value.bytes;
    original.push(value);
  }
  if (total > 32 * 1024 * 1024)
    throw Error("Mixed Kotlin selected source byte bound");
  const temporary = await mkdtemp(
    path.join(
      process.env.CHECKTRAIL_TEMP ?? tmpdir(),
      "checktrail-kotlin-ext-",
    ),
  );
  try {
    const snapshot = path.join(temporary, "snapshot"),
      libraries = path.join(temporary, "kotlinc/lib"),
      classes = path.join(temporary, "classes"),
      output = path.join(temporary, "output"),
      javaOutput = path.join(temporary, "java-output"),
      plugin = path.join(temporary, "original-plugin.jar");
    for (const dir of [
      snapshot,
      libraries,
      classes,
      output,
      javaOutput,
      path.join(temporary, "dependencies"),
    ])
      await mkdir(dir, { recursive: true });
    const libraryFiles = [];
    for (const [name, bytes] of inputs.libraries) {
      const file = path.join(libraries, name);
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      libraryFiles.push(file);
    }
    const dependencyFiles: string[] = [];
    for (const [i, dep] of inputs.dependencies.entries()) {
      const file = path.join(temporary, "dependencies", i + ".jar");
      await writeFile(file, dep.bytes, { flag: "wx", mode: 0o600 });
      dependencyFiles.push(file);
    }
    const snapshots = [];
    for (const [i, file] of invocation.scope.entries()) {
      const target = path.resolve(snapshot, file);
      if (!target.startsWith(snapshot + path.sep))
        throw Error("Mixed Kotlin snapshot path escape");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        await kotlinRead(original[i]!.file, 1024 * 1024),
        { flag: "wx", mode: 0o600 },
      );
      if ((await binding(target)).sha256 !== original[i]!.sha256)
        throw Error("Mixed Kotlin source changed before staging");
      snapshots.push({ ...original[i]!, nativeFile: target });
    }
    const helperSources = [
      ["VerifierKotlin.java", kotlinExtensionsNativeSource],
      ["VerifierKotlinRegistrar.java", kotlinRegistrarSource],
      ["VerifierKotlinJava.java", kotlinJavaObserverSource],
      ["VerifierJvmGeneratedClasses.java", jvmGeneratedClassObserverSource],
    ];
    const helpers = [];
    for (const [name, text] of helperSources) {
      const file = path.join(temporary, name!);
      await writeFile(file, text!, { flag: "wx", mode: 0o600 });
      helpers.push(file);
    }
    silent(
      await invoke("javac", [
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
        ...helpers,
      ]),
    );
    const service = path.join(classes, "META-INF/services");
    await mkdir(service, { recursive: true });
    await writeFile(
      path.join(
        service,
        "org.jetbrains.kotlin.compiler.plugin.CompilerPluginRegistrar",
      ),
      "VerifierKotlinRegistrar\n",
      { flag: "wx" },
    );
    silent(
      await invoke("jar", [
        "--create",
        "--file",
        plugin,
        "--no-manifest",
        "-C",
        classes,
        ".",
      ]),
    );
    if (process.argv[4] === "--version") {
      const result = await jvmInvoker(env, false)("java", [
        "-classpath",
        [classes, ...libraryFiles].join(path.delimiter),
        "VerifierKotlin",
        "--version",
      ]);
      if (result.status !== 0 || result.signal || result.stderrBytes)
        throw Error("Selected Kotlin compiler version did not complete");
      process.stdout.write(result.stdout);
      return;
    }
    const observerBefore = await outputInventory(classes);
    const pluginBefore = await kotlinRead(plugin, 2 * 1024 * 1024);
    const runtimeFiles = [
      ...[...inputs.libraries].map(([name, bytes]) => ({
        file: path.join(libraries, name),
        bytes: bytes.length,
        sha256: kotlinHash(bytes),
      })),
      ...inputs.dependencies.map((dependency, i) => ({
        file: dependencyFiles[i]!,
        bytes: dependency.bytes.length,
        sha256: dependency.sha256,
      })),
    ];
    const verifyStagedRuntime = async () => {
      for (const original of runtimeFiles) {
        const bytes = await kotlinRead(original.file, original.bytes + 1);
        if (
          bytes.length !== original.bytes ||
          kotlinHash(bytes) !== original.sha256
        )
          throw Error("Staged Kotlin artifacts changed");
      }
      const actual = await outputInventory(classes);
      const order = (rows: typeof actual) =>
        [...rows].sort((a, b) => a.file.localeCompare(b.file));
      if (
        JSON.stringify(order(actual)) !==
          JSON.stringify(order(observerBefore)) ||
        kotlinHash(await kotlinRead(plugin, pluginBefore.length + 1)) !==
          kotlinHash(pluginBefore)
      )
        throw Error("Staged Kotlin artifacts changed");
    };
    const generated = await generateJvmSources(
      { generators: ext.generators.map((g) => ({ ...g, module: "." })) },
      original.map((b, i) => ({
        path: invocation.scope[i]!,
        sha256: b.sha256,
      })),
      snapshot,
      temporary,
      invoke,
    );
    await verifyStagedRuntime();
    const payloads = [];
    for (const item of generated.flatMap((g) => g.outputs)) {
      const physical = path.join(snapshot, item.path),
        bytes = await kotlinRead(physical, 131072);
      if (kotlinHash(bytes) !== item.sha256 || bytes.length !== item.bytes)
        throw Error("Fresh generated Kotlin source identity changed");
      payloads.push({ ...item, base64: bytes.toString("base64") });
      snapshots.push({
        ...(await binding(physical)),
        file: path.resolve(root, project, item.path),
        nativeFile: physical,
      });
    }
    const selected = snapshots.filter((s) => /\.(kt|kts)$/.test(s.nativeFile));
    const compilerScope = selected.map((s) =>
      path
        .relative(path.resolve(root, project), s.file)
        .split(path.sep)
        .join("/"),
    );
    const derived = JSON.stringify({
      config: invocation.config,
      scope: compilerScope,
    });
    const result = await invoke("java", [
      "--enable-native-access=ALL-UNNAMED",
      "-Xmx512m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-Dkotlin.home=" + path.dirname(libraries),
      "-Dchecktrail.kotlin.target=" + invocation.config.jvmTarget,
      "-classpath",
      [classes, ...libraryFiles].join(path.delimiter),
      "VerifierKotlin",
      output,
      [
        path.join(libraries, "kotlin-stdlib.jar"),
        path.join(libraries, "annotations-13.0.jar"),
        path.join(libraries, "kotlin-script-runtime.jar"),
        ...dependencyFiles,
      ].join(path.delimiter),
      plugin,
      String(invocation.config.warningsAsErrors),
      ...selected.map((s) => s.nativeFile),
      ...ext.javaSources.map((s) => path.join(snapshot, s)),
    ]);
    const native = JSON.parse(result.stdout);
    let java: unknown = null;
    if (native.exit === "OK" && ext.javaSources.length) {
      const classpath = [
        output,
        path.join(libraries, "kotlin-stdlib.jar"),
        path.join(libraries, "annotations-13.0.jar"),
        ...dependencyFiles,
      ];
      const encode = (value: string) => Buffer.from(value).toString("base64");
      const request = path.join(temporary, "java-request");
      await writeFile(
        request,
        [
          invocation.config.jvmTarget,
          String(invocation.config.warningsAsErrors),
          encode(javaOutput),
          String(classpath.length),
          ...classpath.map(encode),
          String(ext.javaSources.length),
          ...ext.javaSources.map((s) => encode(path.join(snapshot, s))),
        ].join("\n") + "\n",
        { flag: "wx" },
      );
      const observed = await invoke("java", [
        "-cp",
        classes,
        "VerifierKotlinJava",
        request,
      ]);
      if (observed.stderrBytes)
        throw Error("Selected Java observer produced unexpected stderr");
      java = JSON.parse(observed.stdout);
    }
    let generatedClasses: unknown = [];
    if (native.exit === "OK" && payloads.length) {
      const observed = await invoke("java", [
        "-cp",
        classes,
        "VerifierJvmGeneratedClasses",
        ...payloads.flatMap((p) => [
          p.path,
          path.join(output, p.className.replaceAll(".", "/") + ".class"),
        ]),
      ]);
      if (observed.stderrBytes)
        throw Error(
          "Generated Kotlin class observer produced unexpected stderr",
        );
      generatedClasses = JSON.parse(observed.stdout);
    }
    const basic = ({
      file,
      sha256,
      bytes,
    }: {
      file: string;
      sha256: string;
      bytes: number;
    }) => ({ file, sha256, bytes });
    const after = (await Promise.all(original.map((o) => binding(o.file)))).map(
      basic,
    );
    const snapshotAfter = (
      await Promise.all(snapshots.map((s) => binding(s.nativeFile)))
    ).map(basic);
    const kotlin = kotlinEvidenceSchema.parse({
      version: 1,
      requestDigest: kotlinHash(derived),
      kotlin: native.kotlin,
      kotlinHome: path.dirname(libraries),
      toolchain: version.stdout,
      sources: selected,
      after: selected.map((s) => {
        const i = invocation.scope.indexOf(
          path
            .relative(path.resolve(root, project), s.file)
            .split(path.sep)
            .join("/"),
        );
        return i < 0
          ? { file: s.file, sha256: s.sha256, bytes: s.bytes }
          : after[i];
      }),
      snapshotAfter: selected.map((s) =>
        snapshotAfter.find((b) => b.file === s.nativeFile),
      ),
      outputAfter: await outputInventory(output),
      native,
      nativeExit: result.status,
      nativeSignal: result.signal,
      nativeError: null,
      nativeOutput: captureProcessOutput(
        Buffer.from(result.stdout),
        Buffer.from(result.stderr),
        result.stdoutBytes + result.stderrBytes,
        true,
      ),
      warningJarUrl: pathToFileURL(
        path.join(libraries, "kotlin-compiler.jar"),
      ).href.replace(/^file:\/\/\//, "file:/"),
    });
    if ((await verifyJvmToolchain()) !== toolchain)
      throw Error("Mixed Kotlin toolchain changed");
    await kotlinInputs(root, project, invocation.config);
    await verifyStagedRuntime();
    const mirrored = Buffer.concat(chunks);
    if (mirrored.length > 2 * 1024 * 1024)
      throw Error("Mixed Kotlin aggregate output bound");
    const packet = JSON.stringify({
      schemaVersion: 1,
      stagedArtifactsVerified: true,
      requestDigest: kotlinHash(serialized),
      toolchain,
      snapshot,
      sources: snapshots.slice(0, original.length),
      after,
      snapshotAfter: snapshotAfter.slice(0, original.length),
      generated,
      payloads,
      generatedClasses,
      kotlin,
      java,
      javaOutputAfter: await outputInventory(javaOutput),
      invocations,
      mirrored: captureProcessOutput(
        Buffer.alloc(0),
        mirrored,
        mirrored.length,
        true,
      ),
    });
    if (Buffer.byteLength(packet) > 4 * 1024 * 1024)
      throw Error("Mixed Kotlin receipt byte bound");
    process.stdout.write(packet);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error &&
      error.message === "Staged Kotlin artifacts changed"
      ? "Staged Kotlin artifacts changed\n"
      : "Mixed Kotlin native evidence collection could not complete\n",
  );
  process.exitCode = 2;
});
