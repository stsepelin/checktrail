import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withinRoot } from "./inventory.js";
import { javaDependencies } from "./java.js";
import { spotbugsInputs, spotbugsInvocationSchema } from "./spotbugs.js";
import { spotbugsLibraries } from "./spotbugs-archive.js";
import { spotbugsCompilerSource } from "./spotbugs-compiler.js";
import { spotbugsNativeSource } from "./spotbugs-native.js";
const env = { ...process.env };
for (const name of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
])
  delete env[name];
const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const invoke = (args: string[]) =>
  spawnSync("java", args, { env, encoding: "utf8", maxBuffer: 1024 * 1024 });
async function main() {
  const root = await realpath(process.argv[2]!);
  const project = path.relative(root, await realpath(process.cwd())) || ".";
  const serialized = process.argv[3]!;
  const invocation = spotbugsInvocationSchema.parse(JSON.parse(serialized));
  const version = invoke(["--version"]);
  if (
    version.status !== 0 ||
    version.stderr ||
    !version.stdout.startsWith(
      "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
    )
  ) {
    process.stdout.write(JSON.stringify({ unavailable: "spotbugs-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const archive = await spotbugsInputs(root, project, invocation.config);
  const jars = await javaDependencies(root, project, invocation.compiler);
  const files = await Promise.all(
    invocation.scope.map((file) => withinRoot(root, path.join(project, file))),
  );
  const freshness = async () =>
    Promise.all(files.map(async (file) => hash(await readFile(file))));
  const before = await freshness();
  const sourceBindings = await Promise.all(
    files.map(async (file, index) => {
      const bytes = await readFile(file);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (hash(bytes) !== before[index])
        throw Error("Source changed before compilation");
      return {
        file,
        sha256: before[index],
        lines: text.split(/\r\n?|\n/).length,
      };
    }),
  );
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "checktrail-spotbugs-"),
  );
  const java = (args: string[]) => {
    const result = invoke([
      "-Xmx256m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      `-Duser.home=${temporary}`,
      `-Dfindbugs.home=${temporary}`,
      "-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory",
      "-Dlog4j2.simplelogLevel=WARN",
      "-Dlog4j2.simplelogLogFile=system.err",
      ...args,
    ]);
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      result.stderr.trim()
    )
      throw Error("SpotBugs native collection did not complete");
    return result.stdout;
  };
  try {
    const retained = spotbugsLibraries(archive);
    const libraries: string[] = [];
    for (const [name, bytes] of retained) {
      const file = path.join(temporary, name);
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      libraries.push(file);
    }
    if (process.argv[4] === "--version") {
      const versionHelper = path.join(
        temporary,
        "VerifierSpotbugsVersion.java",
      );
      await writeFile(
        versionHelper,
        'class VerifierSpotbugsVersion { public static void main(String[] args) { System.out.print("SpotBugs " + edu.umd.cs.findbugs.Version.VERSION_STRING); } }',
      );
      process.stdout.write(
        java(["--class-path", libraries.join(path.delimiter), versionHelper]),
      );
      return;
    }
    const helper = path.join(temporary, "VerifierSpotbugsCompiler.java"),
      input = path.join(temporary, "inputs.txt"),
      classes = path.join(temporary, "classes");
    await mkdir(classes);
    await writeFile(helper, spotbugsCompilerSource);
    await writeFile(
      input,
      [
        String(invocation.compiler.release),
        String(invocation.compiler.warningsAsErrors),
        String(jars.length),
        ...[...jars, ...files].map((file) =>
          Buffer.from(file).toString("base64"),
        ),
      ].join("\n"),
    );
    const compiler = JSON.parse(
      java(["--class-path", temporary, helper, input, classes]),
    ) as {
      success: boolean;
      classes: { name: string; file: string; bytes: number; sha256: string }[];
    };
    let analysis: unknown = null;
    if (compiler.success && compiler.classes.length) {
      for (const item of compiler.classes) {
        const bytes = await readFile(
          path.join(classes, item.name.replaceAll(".", "/") + ".class"),
        );
        if (bytes.length !== item.bytes || hash(bytes) !== item.sha256)
          throw Error("Compiled bytes changed");
      }
      const native = path.join(temporary, "VerifierSpotbugs.java"),
        metadata = path.join(temporary, "classes.json");
      await writeFile(native, spotbugsNativeSource);
      await writeFile(metadata, JSON.stringify(compiler));
      analysis = JSON.parse(
        java([
          "--class-path",
          libraries.join(path.delimiter),
          native,
          metadata,
          classes,
          ...jars,
        ]),
      );
    }
    await spotbugsInputs(root, project, invocation.config);
    await javaDependencies(root, project, invocation.compiler);
    if (JSON.stringify(before) !== JSON.stringify(await freshness()))
      throw Error("Java sources changed during analysis");
    process.stdout.write(
      JSON.stringify({
        version: 1,
        requestDigest: hash(serialized),
        compiler,
        analysis,
        sources: sourceBindings,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write("SpotBugs evidence collection could not complete\n");
  process.exitCode = 2;
});
