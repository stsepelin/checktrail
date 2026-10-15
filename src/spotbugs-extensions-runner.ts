import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { withinRoot } from "./inventory.js";
import {
  spotbugsInvocationSchema,
  spotbugsInputs,
  spotbugsConfigSchema,
} from "./spotbugs.js";
import { javaConfigSchema } from "./java.js";
import { spotbugsLibraries } from "./spotbugs-archive.js";
import { validateSpotbugsExtensionScope } from "./spotbugs-extensions.js";
import {
  spotbugsExtensionPlugins,
  spotbugsExtensionLibraries,
  spotbugsHash,
} from "./spotbugs-extensions-inputs.js";
import { spotbugsExtensionsCompilerSource } from "./spotbugs-extensions-compiler.js";
import { spotbugsExtensionsNativeSource } from "./spotbugs-extensions-native.js";
import {
  spotbugsExtensionsEvidenceSchema,
  spotbugsExtensionCompilerSchema,
  spotbugsExtensionAnalysisSchema,
} from "./spotbugs-extensions-contract.js";
import {
  generateJvmSources,
  jvmModuleObserverSource,
  jvmModuleWitnessSchema,
} from "./jvm-workspace-extensions.js";
import { verifyJvmToolchain, verifyJvmFile } from "./jvm-extensions.js";
import { kotlinRead } from "./kotlin-io.js";
import { jvmInvoker, type JvmInvocationResult } from "./jvm-invoke.js";
import { captureProcessOutput } from "./process-output.js";
import type { z } from "zod";
const pin = (file: string, bytes: Buffer) => ({
  file,
  bytes: bytes.length,
  sha256: spotbugsHash(bytes),
});
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".",
    serialized = process.argv[3]!;
  const request = spotbugsInvocationSchema.parse(JSON.parse(serialized));
  if (request.config.profile !== "core-default-max-class-scopes-plugins-v1")
    throw Error("Select the explicit analyzer extension profile");
  const extensions = request.config.extensions;
  validateSpotbugsExtensionScope(extensions, request.scope);
  const jdkHome = await verifyJvmToolchain();
  const archive = await spotbugsInputs(root, project, request.config),
    originalPlugins = await spotbugsExtensionPlugins(root, project, extensions),
    originalLibraries = await spotbugsExtensionLibraries(
      root,
      project,
      request.compiler.classPath,
    );
  const configuration = [];
  for (const [relative, expected] of [
    ["checktrail.spotbugs.json", request.config],
    ["checktrail.java.json", request.compiler],
  ] as const) {
    const file = path.resolve(root, project, relative);
    if ((await withinRoot(root, path.relative(root, file))) !== file)
      throw Error("Configuration path identity");
    const bytes = await kotlinRead(file, 100 * 1024);
    if (
      JSON.stringify(
        (relative === "checktrail.spotbugs.json"
          ? spotbugsConfigSchema
          : javaConfigSchema
        ).parse(JSON.parse(bytes.toString("utf8"))),
      ) !== JSON.stringify(expected)
    )
      throw Error("Analyzer configuration changed before native capture");
    configuration.push(pin(file, bytes));
  }
  const temporary = await mkdtemp(
    path.join(
      process.env.CHECKTRAIL_TEMP ?? tmpdir(),
      "checktrail-spotbugs-extensions-",
    ),
  );
  const snapshot = path.join(temporary, "snapshot"),
    staged: Array<ReturnType<typeof pin>> = [],
    nativeInvocations: z.infer<
      typeof spotbugsExtensionsEvidenceSchema
    >["invocations"] = [],
    mirrored: Buffer[] = [];
  let observed = 0;
  const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: jdkHome };
  for (const name of [
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "_JAVA_OPTIONS",
    "CLASSPATH",
    "JAVA_OPTS",
    "ENV",
    "BASH_ENV",
  ])
    delete env[name];
  const invokeNative = jvmInvoker(env, true, (chunk) => {
    observed += chunk.length;
    mirrored.push(Buffer.from(chunk));
  });
  const invoke = async (
    tool: "java" | "javac" | "jar",
    args: string[],
    cwd = temporary,
  ): Promise<JvmInvocationResult> => {
    const result = await invokeNative(
      path.join(jdkHome, "bin", tool),
      args,
      cwd,
    );
    if (observed > 2 * 1024 * 1024)
      throw Error("Analyzer cumulative native output bound");
    const { error, ...fields } = result;
    if (error) throw error;
    nativeInvocations.push({ tool, args, cwd, ...fields });
    if (result.status !== 0 || result.signal)
      throw Error("Analyzer native invocation did not complete");
    return result;
  };
  const stage = async (file: string, bytes: Buffer) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    staged.push(pin(file, bytes));
  };
  try {
    const toolLibraries = [];
    for (const [name, bytes] of spotbugsLibraries(archive)) {
      const file = path.join(temporary, "tools", name);
      await stage(file, bytes);
      toolLibraries.push(file);
    }
    if (process.argv[4] === "--version") {
      const versionSource = path.join(
        temporary,
        "VerifierSpotbugsVersion.java",
      );
      await stage(
        versionSource,
        Buffer.from(
          'class VerifierSpotbugsVersion { public static void main(String[] args) { System.out.print("SpotBugs " + edu.umd.cs.findbugs.Version.VERSION_STRING); } }',
        ),
      );
      const quiet = jvmInvoker(env, false);
      const compiled = await quiet(
        path.join(jdkHome, "bin/javac"),
        [
          "-proc:none",
          "-cp",
          toolLibraries.join(path.delimiter),
          "-d",
          temporary,
          versionSource,
        ],
        temporary,
      );
      if (
        compiled.status !== 0 ||
        compiled.signal ||
        compiled.stdoutBytes ||
        compiled.stderrBytes
      )
        throw Error("Analyzer version helper did not compile quietly");
      const result = await quiet(
        path.join(jdkHome, "bin/java"),
        [
          "-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory",
          "-Dlog4j2.simplelogLevel=WARN",
          "-Dlog4j2.simplelogLogFile=system.err",
          "-cp",
          [temporary, ...toolLibraries].join(path.delimiter),
          "VerifierSpotbugsVersion",
        ],
        temporary,
      );
      if (result.status !== 0 || result.signal || result.stderrBytes)
        throw Error("Analyzer version capture did not complete");
      for (const item of staged) await verifyJvmFile(item.file, item);
      if ((await verifyJvmToolchain()) !== jdkHome)
        throw Error("Analyzer toolchain changed during version capture");
      process.stdout.write(result.stdout);
      return;
    }
    const helperDirectory = path.join(temporary, "helpers"),
      helperClasses = path.join(helperDirectory, "classes"),
      nativeHome = path.join(temporary, "home");
    await mkdir(helperClasses, { recursive: true });
    await mkdir(nativeHome);
    const sources = [
      ["VerifierSpotbugsCompiler.java", spotbugsExtensionsCompilerSource],
      ["VerifierSpotbugs.java", spotbugsExtensionsNativeSource],
      ["VerifierJvmModules.java", jvmModuleObserverSource],
    ] as const;
    for (const [name, text] of sources)
      await stage(path.join(helperDirectory, name), Buffer.from(text));
    const helperCompile = await invoke("javac", [
      "-proc:none",
      "-encoding",
      "UTF-8",
      "-cp",
      toolLibraries.join(path.delimiter),
      "-d",
      helperClasses,
      ...sources.map(([name]) => path.join(helperDirectory, name)),
    ]);
    if (helperCompile.stdoutBytes || helperCompile.stderrBytes)
      throw Error("Analyzer helper compilation must be quiet");
    // Seal the compiler/observer implementation before any declared generator or plugin can run.
    const { readdir } = await import("node:fs/promises");
    const seal = async (directory: string, depth = 0) => {
      if (depth > 32) throw Error("Helper class depth bound");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await seal(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".class"))
          staged.push(pin(file, await kotlinRead(file, 1024 * 1024)));
        else throw Error("Unexpected helper output");
      }
    };
    await seal(helperClasses);
    const classPath = [helperClasses, ...toolLibraries].join(path.delimiter);
    const javaArgs = [
      "-Xmx512m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-Duser.home=" + nativeHome,
      "-Dfindbugs.home=" + nativeHome,
      "-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory",
      "-Dlog4j2.simplelogLevel=WARN",
      "-Dlog4j2.simplelogLogFile=system.err",
      "-cp",
      classPath,
    ];
    const libraries = [];
    for (const [i, library] of originalLibraries.entries()) {
      const nativeFile = path.join(
        temporary,
        "libraries",
        String(i),
        "library.jar",
      );
      await stage(nativeFile, library.bytes);
      libraries.push({ ...pin(library.file, library.bytes), nativeFile });
    }
    const plugins = [];
    for (const [i, plugin] of originalPlugins.entries()) {
      const nativeFile = path.join(
        temporary,
        "plugins",
        String(i),
        "plugin.jar",
      );
      await stage(nativeFile, plugin.bytes);
      plugins.push({ ...pin(plugin.file, plugin.bytes), nativeFile });
    }
    const original = [];
    let sourceBytes = 0;
    for (const relative of request.scope) {
      const file = path.resolve(root, project, relative);
      if ((await withinRoot(root, path.relative(root, file))) !== file)
        throw Error("Analyzer source path identity");
      const bytes = await kotlinRead(file, 1024 * 1024);
      sourceBytes += bytes.length;
      if (sourceBytes > 16 * 1024 * 1024)
        throw Error("Analyzer source aggregate bound");
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const nativeFile = path.join(snapshot, relative);
      await stage(nativeFile, bytes);
      original.push({ ...pin(file, bytes), relative, nativeFile });
    }
    const generated = await generateJvmSources(
      extensions,
      original.map((p) => ({ path: p.relative, sha256: p.sha256 })),
      snapshot,
      temporary,
      (tool, args, cwd) => invoke(tool as "java" | "javac", args, cwd),
    );
    const payloads = [];
    for (const generator of generated)
      for (const output of generator.outputs) {
        const bytes = await kotlinRead(
          path.join(snapshot, output.path),
          131072,
        );
        if (
          bytes.length !== output.bytes ||
          spotbugsHash(bytes) !== output.sha256
        )
          throw Error("Generated source identity");
        payloads.push({ ...output, base64: bytes.toString("base64") });
        staged.push(pin(path.join(snapshot, output.path), bytes));
      }
    const stages: z.infer<typeof spotbugsExtensionsEvidenceSchema>["stages"] =
      [];
    for (const cohort of extensions.stages) {
      const directory = path.join(temporary, "cohorts", cohort.id),
        outputs = generated
          .flatMap((g) => g.outputs)
          .filter((o) =>
            extensions.generators.some(
              (g) =>
                g.module === cohort.path &&
                g.outputs.some(
                  (d) => path.posix.join(g.module, d.file) === o.path,
                ),
            ),
          ),
        sourceFiles = [
          ...cohort.sources.map((file) => path.join(snapshot, file)),
          ...outputs.map((o) => path.join(snapshot, o.path)),
        ];
      await mkdir(directory, { recursive: true });
      const dependencies = [
          ...libraries.map((p) => p.nativeFile),
          ...cohort.dependsOn.map(
            (id) => stages.find((s) => s.id === id)!.directory,
          ),
        ],
        protocol = path.join(temporary, "cohorts", cohort.id + ".txt");
      await stage(
        protocol,
        Buffer.from(
          [
            String(request.compiler.release),
            String(request.compiler.warningsAsErrors),
            String(dependencies.length),
            ...[...dependencies, ...sourceFiles].map((file) =>
              Buffer.from(file).toString("base64"),
            ),
          ].join("\n"),
        ),
      );
      const capture = await invoke("java", [
          ...javaArgs,
          "VerifierSpotbugsCompiler",
          protocol,
          directory,
          ...(extensions.jpms.length ? ["module"] : []),
        ]),
        compiler = spotbugsExtensionCompilerSchema.parse(
          JSON.parse(capture.stdout),
        );
      stages.push({
        id: cohort.id,
        directory,
        sourceFiles,
        classPath: dependencies,
        compiler,
      });
      for (const output of compiler.classes) {
        await verifyJvmFile(output.output, {
          bytes: output.bytes,
          sha256: output.sha256,
        });
        staged.push({
          file: output.output,
          bytes: output.bytes,
          sha256: output.sha256,
        });
      }
      if (!compiler.success) break;
    }
    let modules: z.infer<typeof jvmModuleWitnessSchema> = [],
      analysis: z.infer<typeof spotbugsExtensionAnalysisSchema> | null = null;
    if (
      stages.length === extensions.stages.length &&
      stages.every((s) => s.compiler.success)
    ) {
      if (extensions.jpms.length) {
        const capture = await invoke("java", [
          ...javaArgs,
          "VerifierJvmModules",
          ...extensions.jpms.flatMap((module) => [
            module.module,
            path.join(
              stages.find(
                (s) =>
                  extensions.stages.find((c) => c.id === s.id)!.path ===
                  module.module,
              )!.directory,
              "module-info.class",
            ),
          ]),
        ]);
        modules = jvmModuleWitnessSchema.parse(JSON.parse(capture.stdout));
      }
      const classes = stages
          .filter((s) => extensions.stages.find((c) => c.id === s.id)!.analyze)
          .flatMap((s) => s.compiler.classes)
          .filter((c) => c.name !== "module-info"),
        metadata = path.join(temporary, "analysis.json");
      if (!classes.length) throw Error("No selected fresh application classes");
      await stage(
        metadata,
        Buffer.from(
          JSON.stringify({
            classes,
            plugins: plugins.map((p) => p.nativeFile),
          }),
        ),
      );
      const capture = await invoke("java", [
        ...javaArgs,
        "VerifierSpotbugs",
        metadata,
        temporary,
        ...stages.map((s) => s.directory),
        ...libraries.map((p) => p.nativeFile),
      ]);
      analysis = spotbugsExtensionAnalysisSchema.parse(
        JSON.parse(capture.stdout),
      );
    }
    const outputsAfter = [];
    for (const item of staged) await verifyJvmFile(item.file, item);
    for (const stage of stages)
      for (const output of stage.compiler.classes)
        outputsAfter.push(
          pin(output.output, await kotlinRead(output.output, 32 * 1024 * 1024)),
        );
    const after = [];
    for (const before of original)
      after.push(pin(before.file, await kotlinRead(before.file, 1024 * 1024)));
    for (const before of configuration)
      await verifyJvmFile(before.file, before);
    await spotbugsInputs(root, project, request.config);
    await spotbugsExtensionPlugins(root, project, extensions);
    await spotbugsExtensionLibraries(root, project, request.compiler.classPath);
    if ((await verifyJvmToolchain()) !== jdkHome)
      throw Error("Analyzer native toolchain changed");
    const stream = Buffer.concat(mirrored);
    const packet = spotbugsExtensionsEvidenceSchema.parse({
      version: 2,
      requestDigest: spotbugsHash(serialized),
      snapshot,
      temporary,
      jdkHome,
      original,
      after,
      configuration,
      libraries,
      plugins,
      generated,
      payloads: payloads.map(({ className, ...payload }) => {
        void className;
        return payload;
      }),
      stages,
      modules,
      analysis,
      outputsAfter,
      invocations: nativeInvocations,
      mirrored: captureProcessOutput(
        Buffer.alloc(0),
        stream,
        stream.length,
        true,
      ),
      stagedArtifactsVerified: true,
    });
    process.stdout.write(JSON.stringify(packet));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(
    "Analyzer extension evidence collection did not complete\n",
  );
  process.exitCode = 2;
});
