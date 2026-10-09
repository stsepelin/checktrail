import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import {
  kotlinConfig,
  kotlinPolicy,
  nativeArchive,
  nativeOptions,
} from "./kotlin-fixture.js";
export const kotlinExtensionsOptions = nativeOptions;
export const generatedKotlin =
  "package policy\nobject Rules { fun value(): Int = 3 }\n";
export const kotlinGenerator = (body = generatedKotlin) =>
  `import java.nio.file.*;public class BuildKotlinGenerator {public static void main(String[] args)throws Exception {Path root=Path.of(args[0]);Path rules=root.resolve("src/main/kotlin/policy/Rules.kt");Files.createDirectories(rules.getParent());Files.writeString(rules,${JSON.stringify(body)});Files.writeString(root.resolve("src/main/kotlin/policy/GeneratedMarker.kt"),"package policy\\nobject GeneratedMarker { fun value(): Int = 2 }\\n");}}\n`;
export const javaProducer =
  "package producer;public class JavaProducer {public static int value(){return 5;}public static int cycle(){return KotlinProducer.value();}}\n";
export const kotlinProducer =
  "package producer\nimport policy.Rules\nimport policy.GeneratedMarker\nobject KotlinProducer { @JvmStatic fun value(): Int = Rules.value() + GeneratedMarker.value(); fun cycle(): Int = JavaProducer.value() }\n";
export const mixedKotlinConfig = {
  ...kotlinConfig,
  extensions: {
    profile: "linux-arm64-mixed-generated-script-v1" as const,
    javaSources: ["producer/JavaProducer.java"],
    scripts: ["scripts/Compile only.kts"],
    generators: [
      {
        source: "generators/BuildKotlinGenerator.java",
        className: "BuildKotlinGenerator",
        outputs: [
          {
            file: "src/main/kotlin/policy/Rules.kt",
            className: "policy.Rules",
          },
          {
            file: "src/main/kotlin/policy/GeneratedMarker.kt",
            className: "policy.GeneratedMarker",
          },
        ],
      },
    ],
  },
};
export async function mixedKotlinFixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    "checktrail.json": kotlinPolicy,
    "checktrail.kotlin.json": JSON.stringify(mixedKotlinConfig),
    "producer/JavaProducer.java": javaProducer,
    "producer/KotlinProducer.kt": kotlinProducer,
    "generators/BuildKotlinGenerator.java": kotlinGenerator(),
    "scripts/Compile only.kts":
      "val declared = producer.KotlinProducer.value() + producer.JavaProducer.value()\n",
    "build/classes/preserve": "keep",
    ...files,
  });
  const marker = path.join(root, ".checktrail/script-executed");
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await copyFile(nativeArchive, path.join(root, kotlinConfig.archive));
  await writeFile(
    path.join(root, "scripts/Compile only.kts"),
    "val declared = producer.KotlinProducer.value() + producer.JavaProducer.value()\njava.nio.file.Files.writeString(java.nio.file.Path.of(" +
      JSON.stringify(marker) +
      '), "executed")\n',
  );
  return { root, marker };
}
export function waitingKotlinGenerator(mode: string) {
  return String.raw`import java.nio.file.*;
public class BuildKotlinGenerator {
 public static void main(String[] args)throws Exception {
  String marker=System.getenv("CHECKTRAIL_KOTLIN_WAITING");
  if(args.length==2){Files.writeString(Path.of(marker+".child"),Long.toString(ProcessHandle.current().pid()));while(true){if(Files.exists(Path.of(marker+".release"))){System.err.print("x".repeat(65536));System.err.flush();}Thread.sleep(10);}}
  Process child=new ProcessBuilder("setsid",System.getProperty("java.home")+"/bin/java","-cp",System.getProperty("java.class.path"),"BuildKotlinGenerator",args[0],"child").inheritIO().start();
  while(!Files.exists(Path.of(marker+".child")))Thread.sleep(10);
  String json="{\"parent\":"+ProcessHandle.current().pid()+",\"child\":"+child.pid()+",\"temporary\":\""+System.getenv("CHECKTRAIL_TEMP")+"\",\"token\":\"${mode}\"}";
  Files.writeString(Path.of(marker+".pending"),json);Files.move(Path.of(marker+".pending"),Path.of(marker+".ready"));
  while(true){child.isAlive();Thread.sleep(10);}
 }
}`;
}
