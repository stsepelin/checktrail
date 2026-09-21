import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { javaCompilerSource } from "./java-compiler.js";
import { javaDependencies, javaInvocationSchema } from "./java.js";
import { withinRoot } from "./inventory.js";

const env = { ...process.env };
for (const name of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
])
  delete env[name];
function invoke(args: string[]) {
  return spawnSync("java", args, {
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}
async function main() {
  const version = invoke(["--version"]);
  if (process.argv[2] === "--version") {
    process.stdout.write(version.stdout ?? "");
    process.stderr.write(version.stderr ?? "");
    process.exitCode = version.status ?? 2;
    return;
  }
  if (
    version.status !== 0 ||
    version.stderr ||
    !version.stdout.startsWith(
      "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
    )
  ) {
    process.stdout.write(JSON.stringify({ unavailable: "java-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const root = await realpath(process.argv[2]!);
  const project = path.relative(root, await realpath(process.cwd())) || ".";
  const invocation = javaInvocationSchema.parse(JSON.parse(process.argv[3]!));
  const jars = await javaDependencies(root, project, invocation.config);
  const files = await Promise.all(
    invocation.scope.map((file) => withinRoot(root, path.join(project, file))),
  );
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-java-"));
  try {
    const helper = path.join(temporary, "VerifierCompiler.java");
    const config = path.join(temporary, "inputs.txt");
    await writeFile(helper, javaCompilerSource);
    await writeFile(
      config,
      [
        String(invocation.config.release),
        String(invocation.config.warningsAsErrors),
        String(jars.length),
        ...[...jars, ...files].map((file) =>
          Buffer.from(file).toString("base64"),
        ),
      ].join("\n"),
    );
    const result = invoke([
      "-Xmx256m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "--class-path",
      temporary,
      helper,
      config,
    ]);
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      result.stderr.trim()
    )
      throw new Error(
        "Java compiler did not complete native evidence collection",
      );
    await javaDependencies(root, project, invocation.config);
    process.stdout.write(result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write("Java evidence collection could not complete\n");
  process.exitCode = 2;
});
