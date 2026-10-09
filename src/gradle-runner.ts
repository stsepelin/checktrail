import { jvmInvoker } from "./jvm-invoke.js";
import { verifyJvmWrapper, verifyJvmToolchain } from "./jvm-extensions.js";
import {
  stageJvmWrapper,
  findJvmWrapperDistribution,
  generateJvmSources,
  captureJvmModules,
  captureJvmGeneratedClasses,
} from "./jvm-workspace-extensions.js";
import { gradleDistributionFiles } from "./gradle-distribution.js";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gradleInvocationSchema,
  gradleTools,
  gradleProtectedEnvironment,
} from "./gradle.js";
import { mavenHash, mavenLocal, verifyMavenTree } from "./maven.js";
import {
  gradleDeclarationSource,
  gradleJUnitSource,
  gradleNativeSource,
  gradleJvmArguments,
} from "./gradle-native.js";
const env = { ...process.env };
for (const name of gradleProtectedEnvironment) delete env[name];
const invoke = jvmInvoker(env, process.argv[4] !== "--version");
async function jsonLines(file: string) {
  const bytes = await readFile(file);
  if (bytes.length > 2 * 1024 * 1024) throw Error("Native event byte bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw Error("Truncated native event");
  const records = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  if (records.length > 20000) throw Error("Native event count bound");
  return records;
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".",
    invocation = gradleInvocationSchema.parse(JSON.parse(process.argv[3]!));
  const extensions = invocation.config.extensions;
  if (extensions) {
    env.JAVA_HOME = await verifyJvmToolchain();
    await verifyJvmWrapper(root, project, "gradle", extensions);
  }
  const version = await invoke("java", ["--version"]);
  if (
    version.status !== 0 ||
    version.stderr ||
    !version.stdout.startsWith(
      "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
    )
  ) {
    process.stdout.write(JSON.stringify({ unavailable: "gradle-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const tools = await gradleTools(root, project, invocation.config),
    temporary = await mkdtemp(
      path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "checktrail-gradle-"),
    );
  try {
    const workspace = path.join(temporary, "workspace"),
      repository = path.join(temporary, "repository"),
      home = path.join(temporary, "home"),
      classes = path.join(temporary, "observer"),
      observer = path.join(temporary, "observer.jar"),
      events = path.join(temporary, "gradle.jsonl"),
      junit = path.join(temporary, "junit.jsonl");
    for (const directory of [workspace, home, classes]) await mkdir(directory);
    env.HOME = home;
    for (const item of invocation.inputs) {
      const bytes = await readFile(await mavenLocal(root, project, item.path));
      if (bytes.length > 4 * 1024 * 1024 || mavenHash(bytes) !== item.sha256)
        throw Error("Gradle source changed");
      if (/\.(?:java|gradle|kts|properties|xml)$/.test(item.path))
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const destination = path.join(workspace, item.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
    const wrapper = extensions
      ? await stageJvmWrapper(
          workspace,
          "gradle",
          await verifyJvmWrapper(root, project, "gradle", extensions),
        )
      : null;
    if (extensions) {
      env.GRADLE_USER_HOME = home;
      env.JAVA_OPTS = gradleJvmArguments.join(" ");
      env.GRADLE_OPTS =
        "'-Dorg.gradle.jvmargs=" + gradleJvmArguments.join(" ") + "'";
    }
    const invokeGradle = async (args: string[], cwd: string) =>
      extensions
        ? await invoke(
            "/bin/sh",
            [path.join(workspace, "gradlew"), ...args],
            cwd,
          )
        : await invoke(
            "java",
            [
              ...gradleJvmArguments,
              `-javaagent:${path.join(tools.distribution, "lib/agents/gradle-instrumentation-agent-9.8.0.jar")}`,
              "-Dorg.gradle.appname=gradle",
              `-Dorg.gradle.jvmargs=${gradleJvmArguments.join(" ")}`,
              "-jar",
              path.join(
                tools.distribution,
                "lib/gradle-gradle-cli-main-9.8.0.jar",
              ),
              ...args,
            ],
            cwd,
          );
    const nativeVersion = await invokeGradle(
      ["--version", "--no-daemon", "--gradle-user-home", home],
      home,
    );
    if (
      nativeVersion.status !== 0 ||
      nativeVersion.stderr ||
      !nativeVersion.stdout.includes("Gradle 9.8.0\n")
    )
      throw Error("Gradle version mismatch");
    const distribution = extensions
      ? await findJvmWrapperDistribution(home, "gradle")
      : tools.distribution;
    if (extensions)
      await verifyMavenTree(distribution, gradleDistributionFiles);
    if (process.argv[4] === "--version") {
      const marker =
        "------------------------------------------------------------\nGradle 9.8.0\n------------------------------------------------------------\n";
      if (extensions && nativeVersion.stdout.split(marker).length !== 2)
        throw Error(
          "Selected wrapper must emit one native Gradle version block",
        );
      process.stdout.write(
        extensions
          ? nativeVersion.stdout.slice(nativeVersion.stdout.indexOf(marker))
          : nativeVersion.stdout,
      );
      return;
    }
    const generated = extensions
      ? await generateJvmSources(
          extensions,
          invocation.inputs,
          workspace,
          temporary,
          invoke,
        )
      : [];
    await cp(tools.repository, repository, {
      recursive: true,
      errorOnExist: true,
    });
    const listener = path.join(temporary, "VerifierGradleTests.java"),
      declarations = path.join(temporary, "VerifierGradleSources.java");
    await writeFile(listener, gradleJUnitSource);
    await writeFile(declarations, gradleDeclarationSource);
    const jars = tools.pins.files
      .filter((file) => file.path.endsWith(".jar"))
      .map((file) => path.join(repository, file.path));
    const compiled = await invoke("javac", [
      "-proc:none",
      "-encoding",
      "UTF-8",
      "-cp",
      jars.join(path.delimiter),
      "-d",
      classes,
      listener,
      declarations,
    ]);
    if (compiled.status !== 0 || compiled.error || compiled.signal)
      throw Error("Gradle native helpers did not compile");
    await mkdir(path.join(classes, "META-INF/services"), { recursive: true });
    await writeFile(
      path.join(
        classes,
        "META-INF/services/org.junit.platform.launcher.TestExecutionListener",
      ),
      "VerifierGradleTests\n",
    );
    const packed = await invoke("jar", [
      "--create",
      "--file",
      observer,
      "-C",
      classes,
      ".",
    ]);
    if (packed.status !== 0 || packed.error || packed.signal)
      throw Error("Gradle native helpers did not package");
    const observerPin = mavenHash(await readFile(observer)),
      script = path.join(temporary, "observer.gradle");
    await writeFile(script, gradleNativeSource);
    const result = await invokeGradle(
      [
        "-Dorg.gradle.java.home=/opt/java/openjdk",
        ...(extensions ? ["-Dchecktrail.wrapper=1"] : []),
        "--offline",
        "--no-daemon",
        "--no-configuration-cache",
        "--no-build-cache",
        "--no-watch-fs",
        "--rerun-tasks",
        "--continue",
        "--max-workers=1",
        "--console=plain",
        "--gradle-user-home",
        home,
        "--init-script",
        script,
        `-Dchecktrail.repository=${repository}`,
        `-Dchecktrail.observer=${observer}`,
        `-Dchecktrail.gradle.events=${events}`,
        `-Dchecktrail.junit.events=${junit}`,
        "test",
      ],
      workspace,
    );
    if (result.error || result.signal || result.status === null)
      throw Error("Gradle did not terminate normally");
    const captured = await jsonLines(events);
    let tests: unknown[] = [];
    try {
      tests = await jsonLines(junit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const modules = [];
    for (const module of invocation.config.modules) {
      const base = path.resolve(workspace, module.path),
        reportDirectory = path.join(base, "build/test-results/test"),
        reports = [];
      let names: string[] = [];
      try {
        names = await readdir(reportDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of names) {
        if (name === "binary") {
          const binary = path.join(reportDirectory, name);
          if (
            !(await lstat(binary)).isDirectory() ||
            (await realpath(binary)) !== binary
          )
            throw Error("Gradle binary report directory must be regular");
          continue;
        }
        if (!name.startsWith("TEST-") || !name.endsWith(".xml"))
          throw Error("Unexpected Gradle test report");
        const file = path.join(reportDirectory, name);
        if ((await realpath(file)) !== file)
          throw Error("Gradle test report link");
        const bytes = await readFile(file);
        if (bytes.length > 2 * 1024 * 1024 || reports.length >= 256)
          throw Error("Gradle test report bound");
        reports.push({
          file,
          xml: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        });
      }
      let sourceDeclarations: unknown[] = [];
      const sources = invocation.inputs
        .filter(
          (input) =>
            input.path.startsWith(
              path.posix.join(module.path, "src/test/java") + "/",
            ) && input.path.endsWith(".java"),
        )
        .map((input) => path.join(workspace, input.path));
      if (sources.length) {
        const parsed = await invoke("java", [
          "-cp",
          [classes, ...jars].join(path.delimiter),
          "VerifierGradleSources",
          ...sources,
        ]);
        if (parsed.status === 0 && !parsed.error && !parsed.signal)
          sourceDeclarations = JSON.parse(parsed.stdout) as unknown[];
      }
      modules.push({ path: base, reports, declarations: sourceDeclarations });
    }
    for (const item of invocation.inputs) {
      for (const base of [path.resolve(root, project), workspace]) {
        const file = path.resolve(base, item.path);
        if (
          (await realpath(file)) !== file ||
          mavenHash(await readFile(file)) !==
            (base === workspace && wrapper?.file === item.path
              ? wrapper.stagedSha256
              : item.sha256)
        )
          throw Error("Gradle input changed during execution");
      }
    }
    const moduleWitnesses = extensions
      ? await captureJvmModules(
          extensions,
          workspace,
          temporary,
          "gradle",
          invoke,
        )
      : [];
    const generatedClasses = extensions
      ? await captureJvmGeneratedClasses(
          extensions,
          workspace,
          temporary,
          "gradle",
          invoke,
        )
      : [];
    if (extensions) {
      await verifyJvmWrapper(root, project, "gradle", extensions);
      await verifyJvmToolchain();
      await verifyMavenTree(distribution, gradleDistributionFiles);
      for (const output of generated.flatMap((g) => g.outputs))
        if (
          mavenHash(await readFile(path.join(workspace, output.path))) !==
          output.sha256
        )
          throw Error("Generated Java source changed after native witnesses");
    }
    await gradleTools(root, project, invocation.config);
    for (const item of tools.pins.files.filter((file) =>
      /\.(?:jar|pom)$/.test(file.path),
    )) {
      const file = path.join(repository, item.path);
      if (
        (await realpath(file)) !== file ||
        mavenHash(await readFile(file)) !== item.sha256
      )
        throw Error("Gradle dependency artifact changed");
    }
    if (
      mavenHash(await readFile(observer)) !== observerPin ||
      (await readFile(script, "utf8")) !== gradleNativeSource
    )
      throw Error("Gradle native helpers changed");
    process.stdout.write(
      JSON.stringify({
        version: 1,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        runtime: "25.0.4+7-LTS",
        gradle: "9.8.0",
        launcherPid: result.pid,
        workspace,
        distribution,
        ...(extensions && wrapper
          ? {
              extensions: {
                schemaVersion: 1,
                nativeToolchainVerified: true,
                wrapper: { ...wrapper, installedDistributionVerified: true },
                generated,
                modules: moduleWitnesses,
                generatedClasses,
              },
            }
          : {}),
        repositoryManifest: tools.manifestText,
        artifacts: tools.pins.files.map((file) => file.path),
        exitCode: result.status,
        events: captured,
        tests,
        modules,
        console: {
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          stdoutSha256: result.stdoutSha256,
          stderrSha256: result.stderrSha256,
        },
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
try {
  await main();
} catch {
  process.stdout.write(
    JSON.stringify({ collectorError: "gradle-native-evidence" }),
  );
  process.exitCode = 2;
}
