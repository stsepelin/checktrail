import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import {
  nativeScala,
  nativeOptions,
  nativeArchive,
  scalaConfig,
  scalaPolicy,
} from "./scala-fixture.js";
import { scala2Artifacts } from "../src/scala2-artifacts.js";
export const scala2Archive = "/opt/checktrail/scala-2.13.18.zip";
export const options = {
  ...nativeOptions,
  skip:
    nativeScala &&
    (await access(scala2Archive).then(
      () => true,
      () => false,
    ))
      ? false
      : "Pinned Scala 2/3 and Temurin toolchain unavailable",
};
export const generatedScala =
  "package policy\nobject Rules { val answer:Int=4 }\n";
export const scalaGenerator = (body = generatedScala) =>
  `package gen; public class BuildScalaGenerator { public static void main(String[] a) throws Exception { java.nio.file.Path p=java.nio.file.Path.of(a[0]).resolve("src/main/scala/policy/Rules.scala"); java.nio.file.Files.createDirectories(p.getParent()); java.nio.file.Files.writeString(p,${JSON.stringify(body)}); } }\n`;
export const javaProducer =
  "package demo; public class Producer { public static int value(){ return 4; } }\n";
export const consumer =
  "package demo\nobject Consumer { val result:Int=Macros.answer; val produced:Int=Producer.value(); val generated:Int=policy.Rules.answer }\n";
export const mixedScalaConfig = {
  ...scalaConfig,
  jvmTarget: "25",
  extensions: {
    profile: "linux-arm64-scala3-mixed-generated-script-v1" as const,
    javaSources: ["producer/Producer.java"],
    scripts: [
      { file: "consumer/compile only.sc", className: "scripts.Original" },
    ],
    generators: [
      {
        source: "generators/BuildScalaGenerator.java",
        className: "gen.BuildScalaGenerator",
        outputs: [
          {
            file: "src/main/scala/policy/Rules.scala",
            className: "policy.Rules",
          },
        ],
      },
    ],
    stages: [
      { id: "producer", sources: ["producer/Macros.scala"] },
      {
        id: "consumer",
        sources: [
          "consumer/Consumer.scala",
          "consumer/compile only.sc",
          "src/main/scala/policy/Rules.scala",
        ],
      },
    ],
  },
};
export const scala2Config = {
  schemaVersion: 1,
  archive: ".checktrail/scala2.zip",
  sha256: scala2Artifacts.archiveSha256,
  profile: scala2Artifacts.profile,
  jvmTarget: "25",
  warningsAsErrors: false,
  classPath: [],
};
export async function scala2Fixture(
  t: TestContext,
  source = "object Original { val answer:Int=4 }\n",
) {
  const root = await fixture(t, {
    "checktrail.json": scalaPolicy,
    "checktrail.scala.json": JSON.stringify(scala2Config),
    "Original.scala": source,
  });
  await mkdir(path.join(root, ".checktrail"));
  await copyFile(scala2Archive, path.join(root, scala2Config.archive));
  return root;
}
export async function mixedScalaFixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    "checktrail.json": scalaPolicy,
    "checktrail.scala.json": JSON.stringify(mixedScalaConfig),
    "producer/Producer.java": javaProducer,
    "consumer/Consumer.scala": consumer,
    "generators/BuildScalaGenerator.java": scalaGenerator(),
    "build/classes/preserve": "keep",
    ...files,
  });
  const marker = path.join(root, ".checktrail/application-invoked"),
    macroMarker = path.join(root, ".checktrail/macro-invoked");
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await copyFile(nativeArchive, path.join(root, mixedScalaConfig.archive));
  await writeFile(
    path.join(root, "producer/Macros.scala"),
    `package demo\nimport scala.quoted.*\nobject Macros { inline def answer:Int=\u0024{impl}; def impl(using Quotes):Expr[Int]={ java.nio.file.Files.writeString(java.nio.file.Path.of(${JSON.stringify(macroMarker)}),"compile-time"); Expr(4) } }\n`,
  );
  await writeFile(
    path.join(root, "consumer/compile only.sc"),
    `val answer:Int=policy.Rules.answer\njava.nio.file.Files.writeString(java.nio.file.Path.of(${JSON.stringify(marker)}),"unexpected")\n`,
  );
  for (const [f, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await writeFile(path.join(root, f), body);
  }
  return { root, marker, macroMarker };
}
export function waitingScalaGenerator(mode: string) {
  return String.raw`package gen; import java.nio.file.*;
 public class BuildScalaGenerator {
 public static void main(String[] args)throws Exception {
 String marker=System.getenv("CHECKTRAIL_SCALA_WAITING");
 if(args.length==2){Files.writeString(Path.of(marker+".child"),Long.toString(ProcessHandle.current().pid()));while(true){if(Files.exists(Path.of(marker+".release"))){System.err.print("x".repeat(65536));System.err.flush();}Thread.sleep(10);}}
 Process child=new ProcessBuilder("setsid",System.getProperty("java.home")+"/bin/java","-cp",System.getProperty("java.class.path"),"gen.BuildScalaGenerator",args[0],"child").inheritIO().start();
 while(!Files.exists(Path.of(marker+".child")))Thread.sleep(10);
 String json="{\"parent\":"+ProcessHandle.current().pid()+",\"child\":"+child.pid()+",\"temporary\":\""+System.getenv("CHECKTRAIL_TEMP")+"\",\"token\":\"${mode}\"}";
 Files.writeString(Path.of(marker+".pending"),json);Files.move(Path.of(marker+".pending"),Path.of(marker+".ready"));
 while(true){child.isAlive();Thread.sleep(10);}
 }
 }`;
}
