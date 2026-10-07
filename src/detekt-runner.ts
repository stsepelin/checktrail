import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detektInputs, detektInvocationSchema } from "./detekt.js";
import { detektArtifacts } from "./detekt-artifacts.js";
import { detektHash } from "./detekt-configuration.js";
import { detektNativeSource } from "./detekt-native.js";
import { pathToFileURL } from "node:url";
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
const invoke = (
  executable: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
) => spawnSync(executable, args, { env, maxBuffer, timeout: 110000 });
async function boundedRead(file: string, maximum: number): Promise<Buffer> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum)
      throw Error("Native input byte bound");
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size)
      throw Error("Native input changed while read");
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".",
    invocation = detektInvocationSchema.parse(JSON.parse(process.argv[3]!)),
    version = invoke("java", ["--version"]);
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
    process.stdout.write(JSON.stringify({ unavailable: "detekt-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const inputs = await detektInputs(root, project, invocation.config);
  if (process.argv[4] === "--version") {
    const result = invoke("java", ["-jar", inputs.jar, "--version"]);
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 2;
    return;
  }
  const files = await Promise.all(
    invocation.scope.map((file) => withinRoot(root, path.join(project, file))),
  );
  const sources = [];
  const sourceBytes: Buffer[] = [];
  let total = 0;
  for (const file of files) {
    const bytes = await boundedRead(file, 1024 * 1024);
    total += bytes.length;
    if (bytes.length > 1024 * 1024 || total > 32 * 1024 * 1024)
      throw Error("Kotlin source exceeds its native profile byte bounds");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    sourceBytes.push(bytes);
    sources.push({
      file,
      sha256: detektHash(bytes),
      canonicalSha256: detektHash(text.replace(/\r\n?/g, "\n")),
      bytes: bytes.length,
    });
  }
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "checktrail-detekt-"),
  );
  try {
    const jar = path.join(temporary, "detekt.jar"),
      helper = path.join(temporary, "VerifierDetekt.java"),
      configuration = path.join(temporary, "rules.yml"),
      classes = path.join(temporary, "classes"),
      plugin = path.join(temporary, "listener.jar"),
      receipt = path.join(temporary, "receipt.json"),
      snapshot = path.join(
        temporary,
        "snapshot",
        path.relative(
          path.parse(path.resolve(root, project)).root,
          path.resolve(root, project),
        ),
      );
    const nativeFiles: string[] = [];
    for (let i = 0; i < invocation.scope.length; i++) {
      const file = path.resolve(snapshot, invocation.scope[i]!);
      if (!file.startsWith(snapshot + path.sep))
        throw Error("Kotlin snapshot path escapes");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, sourceBytes[i]!, { flag: "wx", mode: 0o600 });
      nativeFiles.push(file);
    }
    await writeFile(jar, inputs.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(configuration, inputs.configuration, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(helper, detektNativeSource, { flag: "wx", mode: 0o600 });
    await mkdir(classes);
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
      jar,
      "-d",
      classes,
      helper,
    ]);
    if (
      compiled.error ||
      compiled.signal ||
      compiled.status !== 0 ||
      compiled.stdout.length ||
      compiled.stderr.length
    )
      throw Error("Original detekt listener compilation did not complete");
    const services = path.join(classes, "META-INF/services");
    await mkdir(services, { recursive: true });
    await writeFile(
      path.join(services, "dev.detekt.api.FileProcessListener"),
      "VerifierDetekt\n",
    );
    const packed = invoke("jar", [
      "--create",
      "--file",
      plugin,
      "--no-manifest",
      "-C",
      classes,
      ".",
    ]);
    if (
      packed.error ||
      packed.signal ||
      packed.status !== 0 ||
      packed.stdout.length ||
      packed.stderr.length
    )
      throw Error("Original detekt listener packaging did not complete");
    const result = invoke("java", [
      "-Xmx512m",
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-Dchecktrail.receipt=" + receipt,
      "-jar",
      jar,
      "--analysis-mode",
      "light",
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
      "--plugins",
      plugin,
      "--fail-on-severity",
      "Info",
    ]);
    const stdout = result.stdout ?? Buffer.alloc(0),
      stderr = result.stderr ?? Buffer.alloc(0);
    let native: unknown = null;
    try {
      const bytes = await boundedRead(receipt, 4 * 1024 * 1024);
      if (bytes.length > 4 * 1024 * 1024)
        throw Error("detekt receipt exceeds bound");
      native = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const after = [];
    for (const file of files) {
      const bytes = await boundedRead(file, 1024 * 1024);
      after.push({ file, sha256: detektHash(bytes), bytes: bytes.length });
    }
    await detektInputs(root, project, invocation.config);
    process.stdout.write(
      JSON.stringify({
        version: 1,
        requestDigest: detektHash(process.argv[3]!),
        detekt: detektArtifacts.version,
        configurationSha256: detektHash(await readFile(configuration)),
        sources: sources.map((source, i) => ({
          ...source,
          nativeFile: nativeFiles[i],
        })),
        after,
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
        warningJarUrl: pathToFileURL(jar).href.replace(
          /^file:\/\/\//,
          "file:/",
        ),
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(
    "detekt native evidence collection could not complete\n",
  );
  process.exitCode = 2;
});
