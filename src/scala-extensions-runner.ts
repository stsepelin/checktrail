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
import { scalaInputs, scalaInvocationSchema } from "./scala.js";
import { scalaArtifacts } from "./scala-artifacts.js";
import { scalaHash } from "./scala-archive.js";
import { kotlinRead } from "./kotlin-io.js";
import { scalaExtensionsNativeSource } from "./scala-extensions-native.js";
import { kotlinJavaObserverSource } from "./kotlin-java-native.js";
import {
  jvmGeneratedClassObserverSource,
  generateJvmSources,
} from "./jvm-workspace-extensions.js";
import { jvmInvoker, type JvmInvocationResult } from "./jvm-invoke.js";
import { verifyJvmToolchain } from "./jvm-extensions.js";
import { withinRoot } from "./inventory.js";
import { captureProcessOutput } from "./process-output.js";
import {
  scalaScriptSource,
  validateScalaExtensionScope,
} from "./scala-extensions.js";
const env = { ...process.env };
for (const key of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
])
  delete env[key];
const chunks: Buffer[] = [],
  invocations: JvmInvocationResult[] = [];
let observed = 0,
  exhausted = false;
const started = performance.now(),
  nativeInvoke = jvmInvoker(env, true, (chunk) => {
    observed += chunk.length;
    if (observed > 2 * 1024 * 1024) exhausted = true;
    else chunks.push(Buffer.from(chunk));
  });
const invoke = async (tool: string, args: string[], cwd?: string) => {
  if (performance.now() - started >= 110000 || exhausted)
    throw Error("Scala extension native admission budget");
  const result = await nativeInvoke(tool, args, cwd);
  invocations.push(result);
  if (
    result.status !== 0 ||
    result.signal ||
    result.error ||
    exhausted ||
    performance.now() - started > 110000
  )
    throw Error(
      "Scala extension native process did not complete within its budget",
    );
  return result;
};
const silent = (r: JvmInvocationResult) => {
  if (r.stdoutBytes || r.stderrBytes)
    throw Error("Original Scala extension helper produced unexpected output");
};
const binding = async (file: string) => {
  const bytes = await kotlinRead(file, 1024 * 1024);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { file, sha256: scalaHash(bytes), bytes: bytes.length };
};
async function outputs(directory: string) {
  const result: { file: string; sha256: string; bytes: number }[] = [];
  let bytesTotal = 0,
    nodes = 0;
  const walk = async (prefix: string) => {
    for (const e of await readdir(path.join(directory, prefix), {
      withFileTypes: true,
    })) {
      const file = path.join(directory, prefix, e.name),
        info = await lstat(file);
      if (++nodes > 10000 || info.isSymbolicLink())
        throw Error("Scala extension output inventory budget or link");
      if (info.isDirectory()) await walk(path.join(prefix, e.name));
      else if (info.isFile()) {
        const bytes = await kotlinRead(file, 32 * 1024 * 1024);
        bytesTotal += bytes.length;
        if (bytesTotal > 64 * 1024 * 1024 || result.length >= 4001)
          throw Error("Scala extension output byte/count budget");
        result.push({
          file: path.relative(directory, file),
          sha256: scalaHash(bytes),
          bytes: bytes.length,
        });
      } else throw Error("Scala extension output kind");
    }
  };
  await walk("");
  return result;
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".",
    serialized = process.argv[3]!,
    invocation = scalaInvocationSchema.parse(JSON.parse(serialized));
  if (
    invocation.config.profile !== scalaArtifacts.profile ||
    !invocation.config.extensions
  )
    throw Error("Select the declared Scala 3 extension profile");
  const config = invocation.config,
    ext = config.extensions!,
    roles = validateScalaExtensionScope(ext, invocation.scope);
  let toolchain: string;
  try {
    toolchain = await verifyJvmToolchain();
  } catch {
    process.stdout.write(JSON.stringify({ unavailable: "scala-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const version = await jvmInvoker(env, false)("java", ["--version"]);
  if (version.status !== 0 || version.signal || version.stderrBytes)
    throw Error("Scala extension Java version probe failed");
  const inputs = await scalaInputs(root, project, config),
    original = [];
  let sourceBytes = 0;
  for (const f of invocation.scope) {
    const file = path.resolve(root, project, f);
    if ((await withinRoot(root, path.relative(root, file))) !== file)
      throw Error("Scala extension source link");
    const b = await binding(file);
    sourceBytes += b.bytes;
    original.push(b);
  }
  if (sourceBytes > 32 * 1024 * 1024)
    throw Error("Scala extension source byte budget");
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "checktrail-scala-ext-"),
  );
  try {
    const snapshot = path.join(temporary, "snapshot"),
      libraries = path.join(temporary, "scala/lib"),
      classes = path.join(temporary, "classes"),
      javaOutput = path.join(temporary, "java-output");
    for (const dir of [
      snapshot,
      libraries,
      classes,
      javaOutput,
      path.join(temporary, "dependencies"),
    ])
      await mkdir(dir, { recursive: true });
    const libraryFiles: string[] = [],
      runtime: { file: string; bytes: number; sha256: string }[] = [];
    for (const [name, bytes] of inputs.libraries) {
      const file = path.join(libraries, name);
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      libraryFiles.push(file);
      runtime.push({ file, bytes: bytes.length, sha256: scalaHash(bytes) });
    }
    const dependencyFiles = [];
    for (const [i, dep] of inputs.dependencies.entries()) {
      const file = path.join(temporary, "dependencies", i + ".jar");
      await writeFile(file, dep.bytes, { flag: "wx", mode: 0o600 });
      dependencyFiles.push(file);
      runtime.push({ file, bytes: dep.bytes.length, sha256: dep.sha256 });
    }
    const sources = [];
    for (const [i, f] of invocation.scope.entries()) {
      const bytes = await kotlinRead(original[i]!.file, 1024 * 1024);
      if (scalaHash(bytes) !== original[i]!.sha256)
        throw Error("Scala source changed before staging");
      const target = path.join(snapshot, f);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      sources.push({ ...original[i]!, nativeFile: target });
    }
    const helper = path.join(temporary, "VerifierScala.scala");
    await writeFile(helper, scalaExtensionsNativeSource, {
      flag: "wx",
      mode: 0o600,
    });
    const classPath = libraryFiles.join(path.delimiter);
    silent(
      await invoke("java", [
        "-Xmx512m",
        "-Dfile.encoding=UTF-8",
        "-classpath",
        classPath,
        "dotty.tools.dotc.Main",
        "-encoding",
        "UTF-8",
        "-source",
        "3.9",
        "-release:25",
        "-Werror",
        "-color:never",
        "-classpath",
        classPath,
        "-d",
        classes,
        helper,
      ]),
    );
    const helperJava = [];
    for (const [name, text] of [
      ["VerifierKotlinJava.java", kotlinJavaObserverSource],
      ["VerifierJvmGeneratedClasses.java", jvmGeneratedClassObserverSource],
    ]) {
      const file = path.join(temporary, name!);
      await writeFile(file, text!, { flag: "wx", mode: 0o600 });
      helperJava.push(file);
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
        "-d",
        classes,
        ...helperJava,
      ]),
    );
    const launch = [
      "-Xmx512m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-classpath",
      [classes, ...libraryFiles].join(path.delimiter),
      "VerifierScala",
    ];
    if (process.argv[4] === "--version") {
      const v = await jvmInvoker(env, false)("java", [...launch, "--version"]);
      if (v.status !== 0 || v.signal || v.stderrBytes)
        throw Error("Scala extension compiler version probe failed");
      process.stdout.write(v.stdout);
      return;
    }
    const observerBefore = await outputs(classes),
      ordered = (rows: typeof observerBefore) =>
        [...rows].sort((a, b) => a.file.localeCompare(b.file));
    const verifyStagedRuntime = async () => {
      for (const p of runtime) {
        const bytes = await kotlinRead(p.file, p.bytes + 1);
        if (bytes.length !== p.bytes || scalaHash(bytes) !== p.sha256)
          throw Error("Staged Scala artifacts changed");
      }
      if (
        JSON.stringify(ordered(await outputs(classes))) !==
        JSON.stringify(ordered(observerBefore))
      )
        throw Error("Staged Scala artifacts changed");
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
      const file = path.join(snapshot, item.path),
        bytes = await kotlinRead(file, 131072);
      if (bytes.length !== item.bytes || scalaHash(bytes) !== item.sha256)
        throw Error("Generated Scala source changed");
      payloads.push({ ...item, base64: bytes.toString("base64") });
    }
    const compiler = new Map<
      string,
      {
        file: string;
        sha256: string;
        bytes: number;
        nativeFile: string;
        nativeSha256: string;
        nativeBytes: number;
      }
    >();
    for (const f of roles.compilerSources) {
      const bytes = await kotlinRead(path.join(snapshot, f), 1024 * 1024),
        script = ext.scripts.find((s) => s.file === f),
        wrapped = script ? scalaScriptSource(script, bytes) : null;
      const nativeFile = path.join(snapshot, wrapped?.file ?? f),
        nativeBytes = wrapped?.bytes ?? bytes;
      if (wrapped) {
        await mkdir(path.dirname(nativeFile), { recursive: true });
        await writeFile(nativeFile, nativeBytes, { flag: "wx", mode: 0o600 });
      }
      compiler.set(f, {
        file: path.resolve(root, project, f),
        sha256: scalaHash(bytes),
        bytes: bytes.length,
        nativeFile,
        nativeSha256: scalaHash(nativeBytes),
        nativeBytes: nativeBytes.length,
      });
    }
    const stages = [];
    const stageOutputs: string[] = [];
    let failed = false;
    for (const stage of ext.stages) {
      const output = path.join(temporary, "stage-" + stage.id);
      await mkdir(output);
      const selected = stage.sources.map((f) => compiler.get(f)!);
      const derived = JSON.stringify({ config, scope: stage.sources });
      const native = await invoke("java", [
        ...launch,
        output,
        [...libraryFiles, ...dependencyFiles, ...stageOutputs].join(
          path.delimiter,
        ),
        config.jvmTarget,
        String(config.warningsAsErrors),
        ...selected.map((s) => s.nativeFile),
        ...ext.javaSources.map((f) => path.join(snapshot, f)),
      ]);
      if (native.stderrBytes)
        throw Error("Original Scala compiler produced unexpected stderr");
      const data = JSON.parse(native.stdout);
      stages.push({
        id: stage.id,
        output,
        evidence: {
          version: 1,
          requestDigest: scalaHash(derived),
          scala: scalaArtifacts.version,
          scalaHome: path.dirname(libraries),
          toolchain: version.stdout,
          sources: selected,
          after: await Promise.all(
            selected.map(async (s) => ({
              ...(await binding(s.nativeFile)),
              file: s.file,
              sha256: s.sha256,
              bytes: s.bytes,
            })),
          ),
          snapshotAfter: await Promise.all(
            selected.map((s) => binding(s.nativeFile)),
          ),
          outputAfter: await outputs(output),
          native: data,
          nativeExit: native.status,
          nativeSignal: native.signal,
          nativeError: null,
          nativeOutput: captureProcessOutput(
            Buffer.from(native.stdout),
            Buffer.from(native.stderr),
            native.stdoutBytes + native.stderrBytes,
            true,
          ),
        },
      });
      await verifyStagedRuntime();
      if (data.errors) {
        failed = true;
        break;
      }
      stageOutputs.push(output);
    }
    let java: unknown = null;
    if (!failed && ext.javaSources.length) {
      const classpath = [...libraryFiles, ...dependencyFiles, ...stageOutputs],
        encode = (s: string) => Buffer.from(s).toString("base64"),
        request = path.join(temporary, "java-request");
      await writeFile(
        request,
        [
          config.jvmTarget,
          String(config.warningsAsErrors),
          encode(javaOutput),
          String(classpath.length),
          ...classpath.map(encode),
          String(ext.javaSources.length),
          ...ext.javaSources.map((f) => encode(path.join(snapshot, f))),
        ].join("\n") + "\n",
        { flag: "wx" },
      );
      const native = await invoke("java", [
        "-cp",
        classes,
        "VerifierKotlinJava",
        request,
      ]);
      if (native.stderrBytes)
        throw Error("Original Java observer produced unexpected stderr");
      java = JSON.parse(native.stdout);
    }
    let generatedClasses: unknown = [];
    if (!failed && payloads.length) {
      const args = payloads.flatMap((p) => {
        const index = ext.stages.findIndex((s) => s.sources.includes(p.path));
        return [
          p.path,
          path.join(
            stageOutputs[index]!,
            p.className.replaceAll(".", "/") + ".class",
          ),
        ];
      });
      const native = await invoke("java", [
        "-cp",
        classes,
        "VerifierJvmGeneratedClasses",
        ...args,
      ]);
      if (native.stderrBytes)
        throw Error(
          "Original generated class observer produced unexpected stderr",
        );
      generatedClasses = JSON.parse(native.stdout);
    }
    for (const stage of stages) {
      stage.evidence.outputAfter = await outputs(stage.output);
      stage.evidence.snapshotAfter = await Promise.all(
        stage.evidence.sources.map((s) => binding(s.nativeFile)),
      );
    }
    const after = await Promise.all(original.map((s) => binding(s.file))),
      snapshotAfter = await Promise.all(
        sources.map((s) => binding(s.nativeFile)),
      );
    if ((await verifyJvmToolchain()) !== toolchain)
      throw Error("Scala extension toolchain changed");
    await scalaInputs(root, project, config);
    await verifyStagedRuntime();
    const javaOutputAfter = await outputs(javaOutput);
    const allOutputs = [
      ...stages.flatMap((s) => s.evidence.outputAfter),
      ...javaOutputAfter,
    ];
    if (
      allOutputs.length > 4001 ||
      allOutputs.reduce((sum, o) => sum + o.bytes, 0) > 64 * 1024 * 1024
    )
      throw Error("Scala extension aggregate output budget");
    const mirrored = Buffer.concat(chunks),
      packet = JSON.stringify({
        schemaVersion: 1,
        stagedArtifactsVerified: true,
        requestDigest: scalaHash(serialized),
        toolchain,
        snapshot,
        sources,
        after,
        snapshotAfter,
        generated,
        payloads,
        generatedClasses,
        stages,
        java,
        javaOutputAfter,
        invocations,
        mirrored: captureProcessOutput(
          Buffer.alloc(0),
          mirrored,
          mirrored.length,
          true,
        ),
      });
    if (Buffer.byteLength(packet) > 4 * 1024 * 1024)
      throw Error("Scala extension receipt byte budget");
    process.stdout.write(packet);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error && error.message === "Staged Scala artifacts changed"
      ? "Staged Scala artifacts changed\n"
      : "Mixed Scala native evidence collection could not complete\n",
  );
  process.exitCode = 2;
});
