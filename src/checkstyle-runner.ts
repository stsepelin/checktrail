import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkstyleNativeSource } from "./checkstyle-native.js";
import {
  checkstyleInputs,
  checkstyleInvocationSchema,
  renderCheckstyleConfiguration,
} from "./checkstyle.js";
import { withinRoot } from "./inventory.js";
const env = { ...process.env };
for (const name of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
])
  delete env[name];
const invoke = (args: string[]) =>
  spawnSync("java", args, { env, encoding: "utf8", maxBuffer: 1024 * 1024 });
async function main() {
  const root = await realpath(process.argv[2]!);
  const project = path.relative(root, await realpath(process.cwd())) || ".";
  const invocation = checkstyleInvocationSchema.parse(
    JSON.parse(process.argv[3]!),
  );
  const version = invoke(["--version"]);
  if (
    version.status !== 0 ||
    version.stderr ||
    !version.stdout.startsWith(
      "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
    )
  ) {
    process.stdout.write(
      JSON.stringify({ unavailable: "checkstyle-toolchain" }),
    );
    process.exitCode = 3;
    return;
  }
  const inputs = await checkstyleInputs(root, project, invocation.config);
  if (
    inputs.configurationSha256 !== invocation.configurationSha256 ||
    JSON.stringify(inputs.configuration) !==
      JSON.stringify(invocation.configuration)
  )
    throw Error("Checkstyle configuration changed");
  if (process.argv[4] === "--version") {
    const result = invoke(["-jar", inputs.jar, "--version"]);
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 2;
    return;
  }
  const files = await Promise.all(
    invocation.scope.map((file) => withinRoot(root, path.join(project, file))),
  );
  for (const file of files)
    new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
  const temporary = await mkdtemp(
    path.join(
      process.env.CHECKTRAIL_TEMP ?? tmpdir(),
      "checktrail-checkstyle-",
    ),
  );
  try {
    const helper = path.join(temporary, "VerifierCheckstyle.java"),
      configuration = path.join(temporary, "checkstyle.xml"),
      input = path.join(temporary, "inputs.txt");
    await writeFile(helper, checkstyleNativeSource);
    await writeFile(
      configuration,
      renderCheckstyleConfiguration(inputs.configuration),
    );
    await writeFile(
      input,
      [
        configuration,
        ...files.map((file) => Buffer.from(file).toString("base64")),
      ].join("\n"),
    );
    const result = invoke([
      "-Xmx256m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "--class-path",
      inputs.jar,
      helper,
      input,
    ]);
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      result.stderr.trim()
    )
      throw Error("Checkstyle native collection did not complete");
    const after = await checkstyleInputs(root, project, invocation.config);
    if (after.configurationSha256 !== inputs.configurationSha256)
      throw Error("Checkstyle configuration changed");
    process.stdout.write(result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write("Checkstyle evidence collection could not complete\n");
  process.exitCode = 2;
});
