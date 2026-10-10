import path from "node:path";
import { copyFile, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import {
  nativeArchive,
  spotbugsConfig,
  spotbugsPolicy,
  javaConfig,
} from "./spotbugs-fixture.js";
import { spotbugsLibraries } from "../src/spotbugs-archive.js";
import { spotbugsHash } from "../src/spotbugs-extensions-inputs.js";
import { kotlinRead } from "../src/kotlin-io.js";
import { spotbugsExtensionsSchema } from "../src/spotbugs-extensions.js";
export const originalAnalyzerSource = (broken: boolean, overload = false) =>
  `package demo; public class Original { public Original(){} public static int result(){return Nested.result()+Generated.result();} public static class Nested { public Nested(){} public static int result(){return provider.Library.${broken ? "unsafeValue()" : overload ? "unsafeValue(4)" : "unsafeValueExtra()"};} } }\n`;
export const originalAnalyzerGenerator = (broken: boolean) =>
  `package generator; import java.nio.file.*; public class OriginalGenerator { public static void main(String[] args)throws Exception { Path file=Path.of(args[0],"src/main/java/demo/Generated.java");Files.createDirectories(file.getParent());Files.writeString(file,${JSON.stringify(`package demo; public class Generated { public Generated(){} public static int result(){return provider.Library.${broken ? "unsafeValue()" : "unsafeValueExtra()"};} }\n`)}); } }\n`;
export async function analyzerFixture(
  t: Pick<TestContext, "after">,
  broken = false,
  overload = false,
) {
  const root = await realpath(
    await fixture(t as TestContext, {
      "pom.xml": "<project/>",
      "checktrail.json": spotbugsPolicy,
      "checktrail.java.json": JSON.stringify(javaConfig),
      "library/src/main/java/module-info.java":
        "module original.library { exports provider; }\n",
      "library/src/main/java/provider/Library.java":
        "package provider; public class Library {public Library(){} public static int unsafeValue(){return 4;}public static int unsafeValue(int value){return value;}public static int unsafeValueExtra(){return 4;}}\n",
      "application/src/main/java/module-info.java":
        "module original.application {requires original.library; exports demo;}\n",
      "application/src/main/java/demo/Original.java": originalAnalyzerSource(
        broken,
        overload,
      ),
      "generators/OriginalGenerator.java": originalAnalyzerGenerator(broken),
    }),
  );
  await mkdir(path.join(root, ".checktrail"));
  await copyFile(nativeArchive, path.join(root, spotbugsConfig.archive));
  const build = path.join(root, ".checktrail/plugin-build"),
    marker = path.join(root, ".checktrail/native-plugin-marker");
  await mkdir(build);
  try {
    const libraries = [];
    for (const [name, bytes] of spotbugsLibraries(
      await kotlinRead(path.join(root, spotbugsConfig.archive), 15831983),
    )) {
      const file = path.join(build, name);
      await writeFile(file, bytes);
      libraries.push(file);
    }
    const source = path.join(build, "OriginalDetector.java"),
      classes = path.join(build, "classes");
    await mkdir(classes);
    await writeFile(
      source,
      `package original; import edu.umd.cs.findbugs.*; public class OriginalDetector extends BytecodeScanningDetector {
 final BugReporter reporter; public OriginalDetector(BugReporter reporter){this.reporter=reporter;try{java.nio.file.Files.writeString(java.nio.file.Path.of(${JSON.stringify(marker)}),"native plugin reached\\n",java.nio.file.StandardOpenOption.CREATE,java.nio.file.StandardOpenOption.APPEND);}catch(java.io.IOException error){throw new RuntimeException(error);}}
 @Override public void sawOpcode(int opcode){if(opcode==org.apache.bcel.Const.INVOKESTATIC&&getClassConstantOperand().equals("provider/Library")&&getNameConstantOperand().equals("unsafeValue")&&getSigConstantOperand().equals("()I"))reporter.reportBug(new BugInstance(this,"CHECKTRAIL_UNSAFE_VALUE",NORMAL_PRIORITY).addClassAndMethod(this).addSourceLine(this));}
}\n`,
    );
    execFileSync(
      "javac",
      [
        "-proc:none",
        "-encoding",
        "UTF-8",
        "-cp",
        libraries.join(path.delimiter),
        "-d",
        classes,
        source,
      ],
      { timeout: 30000, stdio: "pipe" },
    );
    await writeFile(
      path.join(classes, "findbugs.xml"),
      '<FindbugsPlugin pluginid="checktrail.synthetic.rules.v1"><Detector class="original.OriginalDetector" reports="CHECKTRAIL_UNSAFE_VALUE" speed="fast"/><BugPattern abbrev="CTV" type="CHECKTRAIL_UNSAFE_VALUE" category="CORRECTNESS"/></FindbugsPlugin>',
    );
    await writeFile(
      path.join(classes, "messages.xml"),
      '<MessageCollection><Plugin><ShortDescription>Original synthetic detector</ShortDescription><Details>Original selected call rule.</Details></Plugin><Detector class="original.OriginalDetector"><Details>Inspect the exact original call descriptor.</Details></Detector><BugPattern type="CHECKTRAIL_UNSAFE_VALUE"><ShortDescription>Selected unsafe call</ShortDescription><LongDescription>Selected unsafe call</LongDescription><Details>Selected unsafe call.</Details></BugPattern><BugCode abbrev="CTV">Selected unsafe call</BugCode></MessageCollection>',
    );
    execFileSync(
      "jar",
      [
        "--create",
        "--file",
        path.join(root, ".checktrail/rules.jar"),
        "--no-manifest",
        "-C",
        classes,
        ".",
      ],
      { timeout: 30000, stdio: "pipe" },
    );
  } finally {
    await rm(build, { recursive: true, force: true });
  }
  const extensions = spotbugsExtensionsSchema.parse({
    profile: "linux-arm64-class-scopes-plugins-v1",
    stages: [
      {
        id: "library",
        path: "library",
        analyze: false,
        sources: [
          "library/src/main/java/module-info.java",
          "library/src/main/java/provider/Library.java",
        ],
        dependsOn: [],
      },
      {
        id: "application",
        path: "application",
        analyze: true,
        sources: [
          "application/src/main/java/module-info.java",
          "application/src/main/java/demo/Original.java",
        ],
        dependsOn: ["library"],
      },
    ],
    generators: [
      {
        module: "application",
        source: "generators/OriginalGenerator.java",
        className: "generator.OriginalGenerator",
        outputs: [
          {
            file: "src/main/java/demo/Generated.java",
            className: "demo.Generated",
          },
        ],
      },
    ],
    jpms: [
      {
        module: "library",
        name: "original.library",
        requires: [],
        exports: ["provider"],
      },
      {
        module: "application",
        name: "original.application",
        requires: ["original.library"],
        exports: ["demo"],
      },
    ],
    plugins: [
      {
        path: ".checktrail/rules.jar",
        sha256: spotbugsHash(
          await kotlinRead(
            path.join(root, ".checktrail/rules.jar"),
            32 * 1024 * 1024,
          ),
        ),
        id: "checktrail.synthetic.rules.v1",
        detectors: [
          {
            className: "original.OriginalDetector",
            reports: ["CHECKTRAIL_UNSAFE_VALUE"],
          },
        ],
        patterns: [
          {
            type: "CHECKTRAIL_UNSAFE_VALUE",
            abbreviation: "CTV",
            category: "CORRECTNESS",
          },
        ],
      },
    ],
  });
  const config = {
    ...spotbugsConfig,
    profile: "core-default-max-class-scopes-plugins-v1",
    extensions,
  };
  await writeFile(
    path.join(root, "checktrail.spotbugs.json"),
    JSON.stringify(config),
  );
  return { root, marker, config };
}
