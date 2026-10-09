import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash, mavenConfigSchema } from "../src/maven.js";
import { gradleConfigSchema } from "../src/gradle.js";
import { mavenPom } from "./maven-fixture.js";
import { gradleBuild } from "./gradle-fixture.js";
import { jvmWrapperPins, jvmWrapperArchives } from "../src/jvm-wrapper-pins.js";
import type { JvmKind } from "../src/jvm-extensions.js";
export const jvmWrappersSkip =
  process.platform === "linux" &&
  process.arch === "arm64" &&
  process.env.CHECKTRAIL_JVM_WRAPPERS_CACHE &&
  /^javac 25\.0\.4$/.test(
    spawnSync("javac", ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }).stdout?.trim() ?? "",
  )
    ? false
    : "Prepared Linux ARM64 JVM wrapper runtime unavailable";
export const jvmDecision = (fixed = false) =>
  "package policy; public class Rules { public static boolean decision(String value) { return " +
  (fixed
    ? 'value.equals("grant") || value.startsWith("grant:")'
    : 'value.startsWith("grant")') +
  "; } }\n";
export const jvmGenerator = (source: string) =>
  'package gen; import java.nio.file.*; public class BuildJavaGenerator { public static void main(String[] args) throws Exception { Path output=Path.of(args[0],"src/main/java/policy/Rules.java"); Files.createDirectories(output.getParent()); Files.writeString(output,' +
  JSON.stringify(source) +
  '); Files.writeString(output.resolveSibling("GeneratedMarker.java"),"package policy; public class GeneratedMarker { public static String retain(String value){return value;} }\\n"); } }\n';
export async function jvmAtomic(file: string, text: string) {
  await writeFile(file + ".replacement", text);
  await rename(file + ".replacement", file);
}
export async function jvmOriginal(
  t: TestContext,
  kind: JvmKind,
  fixed = false,
  jpms = true,
) {
  const cache = process.env.CHECKTRAIL_JVM_WRAPPERS_CACHE;
  if (!cache) throw Error("JVM wrapper cache not selected");
  const files: Record<string, string> = {
    "generators/BuildJavaGenerator.java": jvmGenerator(jvmDecision(fixed)),
    "policy/src/main/java/policy/Policy.java":
      "package policy; public class Policy { public static boolean decision(String value) {return Rules.decision(GeneratedMarker.retain(value));} }\n",
    "consumer/src/main/java/consumer/Consumer.java":
      "package consumer; public class Consumer { public static boolean route(String value) {return policy.Policy.decision(value);} }\n",
    ".checktrail/keep": "original caller data",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: [kind === "maven" ? "jvm.maven-test" : "jvm.gradle-test"],
        },
      ],
    }),
  };
  for (const module of ["policy", "consumer"]) {
    const type = module === "policy" ? "Policy" : "Consumer",
      call =
        module === "policy"
          ? "policy.Policy.decision"
          : "consumer.Consumer.route";
    const rejected =
      module === "policy"
        ? ["regrant", "pregrant:read"]
        : ["grantToken", "grantToken:read"];
    files[module + "/src/test/java/checks/" + type + "Test.java"] =
      "package checks; import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.*; public class " +
      type +
      "Test { @Test void identifier_boundary(){assertFalse(" +
      call +
      "(" +
      JSON.stringify(rejected[0]) +
      "));assertFalse(" +
      call +
      "(" +
      JSON.stringify(rejected[1]) +
      "));} @Test void exact_and_delimited(){assertTrue(" +
      call +
      '("grant"));assertTrue(' +
      call +
      '("grant:read"));assertFalse(' +
      call +
      '("regrant"));} }\n';
  }
  if (jpms) {
    files["policy/src/main/java/module-info.java"] =
      "module original.policy {exports policy;}\n";
    files["consumer/src/main/java/module-info.java"] =
      "module original.consumer {requires original.policy;exports consumer;}\n";
  }
  if (kind === "maven") {
    files["pom.xml"] =
      '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>original-wrapper-reactor</artifactId><version>1.0.0</version><packaging>pom</packaging><modules><module>policy</module><module>consumer</module></modules></project>';
    files["policy/pom.xml"] = mavenPom().replace(
      "original-counter",
      "original-policy",
    );
    files["consumer/pom.xml"] = mavenPom()
      .replace("original-counter", "original-consumer")
      .replace(
        "<dependencies>",
        "<dependencies><dependency><groupId>example</groupId><artifactId>original-policy</artifactId><version>1.0.0</version></dependency>",
      );
  } else {
    files["settings.gradle"] =
      "rootProject.name='original-wrapper-modules'\ninclude 'policy', 'consumer'\n";
    files["build.gradle"] = "allprojects {group='example';version='1.0.0'}\n";
    files["policy/build.gradle"] = gradleBuild();
    files["consumer/build.gradle"] = gradleBuild(
      "dependencies { implementation project(':policy') }",
    );
  }
  const root = await fixture(t, files);
  for (const name of [kind + "-review-tools", kind + "-dependencies"])
    await cp(path.join(cache, name), path.join(root, ".checktrail", name), {
      recursive: true,
    });
  const tools = path.join(cache, "jvm-wrapper-tools");
  for (const pin of jvmWrapperPins.filter((p) => p.kind === kind)) {
    const target = path.join(root, pin.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(tools, "wrapper-artifacts", pin.path), target);
  }
  const archive = ".checktrail/" + jvmWrapperArchives[kind].file;
  await cp(
    path.join(tools, jvmWrapperArchives[kind].file),
    path.join(root, archive),
  );
  const config = {
    schemaVersion: 1,
    distribution:
      ".checktrail/" +
      kind +
      "-review-tools/" +
      (kind === "maven" ? "apache-maven-3.10.0" : "gradle-9.8.0"),
    repository: ".checktrail/" + kind + "-dependencies/artifacts",
    repositoryManifest: ".checktrail/" + kind + "-dependencies/repository.json",
    repositorySha256: mavenHash(
      await readFile(path.join(cache, kind + "-dependencies/repository.json")),
    ),
    modules: [
      {
        path: ".",
        ...(kind === "maven" ? { packaging: "pom" } : { kind: "aggregator" }),
        testClasses: [],
        supportTests: [],
      },
      ...["policy", "consumer"].map((module) => ({
        path: module,
        ...(kind === "maven" ? { packaging: "jar" } : { kind: "java" }),
        testClasses: [
          {
            file:
              "src/test/java/checks/" +
              (module === "policy" ? "Policy" : "Consumer") +
              "Test.java",
            className:
              "checks." +
              (module === "policy" ? "Policy" : "Consumer") +
              "Test",
          },
        ],
        supportTests: [],
      })),
    ],
    extensions: {
      profile: "linux-arm64-wrappers-v1",
      archive,
      generators: [
        {
          module: "policy",
          source: "generators/BuildJavaGenerator.java",
          className: "gen.BuildJavaGenerator",
          outputs: [
            {
              file: "src/main/java/policy/Rules.java",
              className: "policy.Rules",
            },
            {
              file: "src/main/java/policy/GeneratedMarker.java",
              className: "policy.GeneratedMarker",
            },
          ],
        },
      ],
      jpms: jpms
        ? [
            {
              module: "policy",
              name: "original.policy",
              requires: [],
              exports: ["policy"],
            },
            {
              module: "consumer",
              name: "original.consumer",
              requires: ["original.policy"],
              exports: ["consumer"],
            },
          ]
        : [],
    },
  };
  const parsed =
    kind === "maven"
      ? mavenConfigSchema.parse(config)
      : gradleConfigSchema.parse(config);
  await writeFile(
    path.join(root, "checktrail." + kind + ".json"),
    JSON.stringify(parsed),
  );
  // Caller-owned stale outputs are excluded from inventory and must survive validation.
  const output = kind === "maven" ? "target" : "build";
  await mkdir(path.join(root, "policy", output), { recursive: true });
  await writeFile(path.join(root, "policy", output, "preserve"), "keep");
  return { root, config: parsed, kind, output };
}
export async function jvmRemoveGeneratedDescriptor(
  root: string,
  module: string,
) {
  await rm(path.join(root, module, "src/main/java/module-info.java"));
}

export function jvmWaitingGenerator(mode: string) {
  return String.raw`package gen;
import java.nio.file.*;
public class BuildJavaGenerator {
 public static void main(String[] args)throws Exception{
  String marker=System.getenv("CHECKTRAIL_JVM_WAITING");
  if(args.length==2){Files.writeString(Path.of(marker+".child"),Long.toString(ProcessHandle.current().pid()));while(true){if(Files.exists(Path.of(marker+".release"))){System.err.print("x".repeat(65536));System.err.flush();}Thread.sleep(10);}}
  Process child=new ProcessBuilder("setsid",System.getenv("JAVA_HOME")+"/bin/java","-cp",System.getProperty("java.class.path"),"gen.BuildJavaGenerator",args[0],"child").inheritIO().start();
  while(!Files.exists(Path.of(marker+".child")))Thread.sleep(10);
  String json="{\"parent\":"+ProcessHandle.current().pid()+",\"child\":"+child.pid()+",\"temporary\":\""+System.getenv("CHECKTRAIL_TEMP")+"\",\"token\":\"${mode}\"}";
  Files.writeString(Path.of(marker+".pending"),json);Files.move(Path.of(marker+".pending"),Path.of(marker+".ready"));
  while(true){child.isAlive();Thread.sleep(10);}
 }
}`;
}
