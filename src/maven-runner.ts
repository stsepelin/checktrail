import { jvmInvoker } from "./jvm-invoke.js";
import { verifyJvmWrapper, verifyJvmToolchain } from "./jvm-extensions.js";
import {
  stageJvmWrapper,
  findJvmWrapperDistribution,
  generateJvmSources,
  captureJvmModules,
  captureJvmGeneratedClasses,
} from "./jvm-workspace-extensions.js";
import { mavenDistributionFiles } from "./maven-distribution.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mavenHash,
  mavenInvocationSchema,
  mavenLocal,
  mavenTools,
  verifyMavenTree,
} from "./maven.js";
import { mavenNativeSource, mavenJUnitSource } from "./maven-native.js";
const env = { ...process.env };
for (const name of [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "MAVEN_OPTS",
  "MAVEN_ARGS",
  "MAVEN_EXT_CLASS_PATH",
  "MAVEN_CONFIG",
  "MAVEN_SKIP_RC",
  "MAVEN_HOME",
  "MAVEN_USER_HOME",
  "JAVA_HOME",
  "HOME",
  "ENV",
  "BASH_ENV",
  "JAVACMD",
  "MAVEN_BASEDIR",
  "MAVEN_PROJECTBASEDIR",
  "MAVEN_DEBUG_OPTS",
  "MVNW_USERNAME",
  "MVNW_PASSWORD",
  "MVNW_REPOURL",
  "MVNW_VERBOSE",
  "CDPATH",
])
  delete env[name];
const invoke = jvmInvoker(env, process.argv[4] !== "--version");
async function lines(file: string) {
  const bytes = await readFile(file);
  if (bytes.length > 2 * 1024 * 1024) throw Error("Native event bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw Error("Partial native event");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function main() {
  const root = await realpath(process.argv[2]!);
  const project = path.relative(root, await realpath(process.cwd())) || ".";
  const invocation = mavenInvocationSchema.parse(JSON.parse(process.argv[3]!));
  const extensions = invocation.config.extensions;
  if (extensions) {
    env.JAVA_HOME = await verifyJvmToolchain();
    await verifyJvmWrapper(root, project, "maven", extensions);
  }
  const version = await invoke("java", ["--version"]);
  if (
    version.status !== 0 ||
    version.stderr ||
    !version.stdout.startsWith(
      "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
    )
  ) {
    process.stdout.write(JSON.stringify({ unavailable: "maven-toolchain" }));
    process.exitCode = 3;
    return;
  }
  const tools = await mavenTools(root, project, invocation.config);
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "checktrail-maven-"),
  );
  try {
    const workspace = path.join(temporary, "workspace"),
      repository = path.join(temporary, "repository"),
      classes = path.join(temporary, "observer"),
      home = path.join(temporary, "home");
    await mkdir(workspace);
    await mkdir(home);
    await mkdir(classes);
    env.MAVEN_SKIP_RC = "1";
    env.HOME = home;
    for (const item of invocation.inputs) {
      const source = await mavenLocal(root, project, item.path),
        bytes = await readFile(source);
      if (bytes.length > 4 * 1024 * 1024 || mavenHash(bytes) !== item.sha256)
        throw Error("Maven source changed");
      if (item.path.endsWith(".java") || item.path.endsWith(".xml"))
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const destination = path.join(workspace, item.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
    const wrapper = extensions
      ? await stageJvmWrapper(
          workspace,
          "maven",
          await verifyJvmWrapper(root, project, "maven", extensions),
        )
      : null;
    env.MAVEN_USER_HOME = path.join(temporary, "wrapper-cache");
    if (extensions) env.MAVEN_OPTS = "--enable-native-access=ALL-UNNAMED";
    const nativeCommand = extensions
      ? "/bin/sh"
      : path.join(tools.distribution, "bin/mvn");
    const nativeArguments = (args: string[]) =>
      extensions ? [path.join(workspace, "mvnw"), ...args] : args;
    const nativeVersion = await invoke(
      nativeCommand,
      nativeArguments(["--version", `-Duser.home=${home}`]),
      extensions ? workspace : home,
    );
    if (
      nativeVersion.status !== 0 ||
      (extensions
        ? ![
            "",
            "[WARNING] Using an insecure connection to download the Maven distribution. Please consider using HTTPS.\n",
          ].includes(nativeVersion.stderr)
        : !!nativeVersion.stderr) ||
      !nativeVersion.stdout.startsWith("Apache Maven 3.10.0 ")
    )
      throw Error("Maven version mismatch");
    const distribution = extensions
      ? await findJvmWrapperDistribution(env.MAVEN_USER_HOME!, "maven")
      : tools.distribution;
    if (extensions) await verifyMavenTree(distribution, mavenDistributionFiles);
    if (process.argv[4] === "--version") {
      process.stdout.write(nativeVersion.stdout);
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
    const compiler = path.join(temporary, "VerifierMavenObserver.java"),
      listener = path.join(temporary, "VerifierMavenTests.java");
    await writeFile(compiler, mavenNativeSource);
    await writeFile(listener, mavenJUnitSource);
    const jars = tools.pins.files
      .filter((item) => item.path.endsWith(".jar"))
      .map((item) => path.join(repository, item.path));
    const compiled = await invoke("javac", [
      "-proc:none",
      "-encoding",
      "UTF-8",
      "-cp",
      [path.join(distribution, "lib/*"), ...jars].join(path.delimiter),
      "-d",
      classes,
      compiler,
      listener,
    ]);
    if (compiled.status !== 0 || compiled.error || compiled.signal)
      throw Error("Native observer did not compile");
    await mkdir(path.join(classes, "META-INF/plexus"), { recursive: true });
    await mkdir(path.join(classes, "META-INF/services"), { recursive: true });
    await writeFile(
      path.join(classes, "META-INF/plexus/components.xml"),
      "<component-set><components>" +
        [
          "org.apache.maven.eventspy.EventSpy",
          "org.apache.maven.execution.MojoExecutionListener",
        ]
          .map(
            (role) =>
              `<component><role>${role}</role><role-hint>checktrail</role-hint><implementation>VerifierMavenObserver</implementation><instantiation-strategy>singleton</instantiation-strategy></component>`,
          )
          .join("") +
        "</components></component-set>",
    );
    await writeFile(
      path.join(
        classes,
        "META-INF/services/org.junit.platform.launcher.TestExecutionListener",
      ),
      "VerifierMavenTests\n",
    );
    const observer = path.join(temporary, "observer.jar"),
      packed = await invoke("jar", [
        "--create",
        "--file",
        observer,
        "-C",
        classes,
        ".",
      ]);
    if (packed.status !== 0 || packed.error || packed.signal)
      throw Error("Observer packaging failed");
    const settings = path.join(temporary, "settings.xml");
    await writeFile(
      settings,
      '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>',
    );
    env.MAVEN_SKIP_RC = "1";
    const mavenEvents = path.join(temporary, "maven.jsonl"),
      junitEvents = path.join(temporary, "junit.jsonl");
    const args = [
      "--offline",
      "--fail-at-end",
      "--batch-mode",
      "--no-transfer-progress",
      "--strict-checksums",
      "--settings",
      settings,
      "--global-settings",
      settings,
      `-Dmaven.repo.local=${repository}`,
      `-Dmaven.ext.class.path=${observer}`,
      `-Dmaven.test.additionalClasspath=${observer}`,
      `-Dchecktrail.maven.events=${mavenEvents}`,
      `-Dchecktrail.junit.events=${junitEvents}`,
      `-Duser.home=${home}`,
      "test",
    ];
    const result = await invoke(
      nativeCommand,
      nativeArguments(args),
      workspace,
    );
    if (result.error || result.signal || result.status === null)
      throw Error("Maven interrupted");
    const events = await lines(mavenEvents),
      tests = await lines(junitEvents).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const modules = [];
    for (const module of invocation.config.modules) {
      const base = path.resolve(workspace, module.path),
        inputs: Record<string, string[]> = {},
        reports: { file: string; xml: string }[] = [];
      for (const goal of ["compile", "testCompile"]) {
        const file = path.join(
          base,
          `target/maven-status/maven-compiler-plugin/${goal}/default-${goal === "compile" ? "compile" : "testCompile"}/inputFiles.lst`,
        );
        inputs[goal] = await readFile(file, "utf8")
          .then((text) => text.trim().split(/\r?\n/).filter(Boolean))
          .catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
      }
      const directory = path.join(base, "target/surefire-reports");
      for (const file of await readdir(directory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        if (file.startsWith("TEST-") && file.endsWith(".xml")) {
          const bytes = await readFile(path.join(directory, file));
          if (bytes.length > 1024 * 1024) throw Error("Report bound");
          reports.push({
            file,
            xml: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        } else if (file.endsWith(".dump") || file.endsWith(".dumpstream"))
          throw Error("Surefire infrastructure dump");
      }
      modules.push({ path: module.path, inputs, reports });
    }
    for (const item of invocation.inputs)
      if (
        mavenHash(
          await readFile(await mavenLocal(root, project, item.path)),
        ) !== item.sha256 ||
        mavenHash(await readFile(path.join(workspace, item.path))) !==
          (wrapper?.file === item.path ? wrapper.stagedSha256 : item.sha256)
      )
        throw Error("Maven mutated source inputs");
    for (const item of tools.pins.files.filter((item) =>
      /\.(?:jar|pom)$/.test(item.path),
    )) {
      if (
        mavenHash(await readFile(path.join(repository, item.path))) !==
        item.sha256
      )
        throw Error("Maven dependency changed during execution");
    }
    const moduleWitnesses = extensions
      ? await captureJvmModules(
          extensions,
          workspace,
          temporary,
          "maven",
          invoke,
        )
      : [];
    const generatedClasses = extensions
      ? await captureJvmGeneratedClasses(
          extensions,
          workspace,
          temporary,
          "maven",
          invoke,
        )
      : [];
    if (extensions) {
      await verifyJvmWrapper(root, project, "maven", extensions);
      await verifyJvmToolchain();
      await verifyMavenTree(distribution, mavenDistributionFiles);
      for (const output of generated.flatMap((g) => g.outputs))
        if (
          mavenHash(await readFile(path.join(workspace, output.path))) !==
          output.sha256
        )
          throw Error("Generated Java source changed after native witnesses");
    }
    await mavenTools(root, project, invocation.config);
    process.stdout.write(
      JSON.stringify({
        version: 2,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        runtime: "25.0.4+7-LTS",
        maven: "3.10.0",
        launcherPid: result.pid,
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
        workspace,
        artifacts: jars,
        exitCode: result.status,
        events,
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
main().catch(() => {
  process.stderr.write("Maven evidence collection could not complete\n");
  process.exitCode = 2;
});
