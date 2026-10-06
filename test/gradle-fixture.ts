import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
export const gradleBuild = (extra = "") => `plugins { id 'java' }
repositories { maven { url=uri(System.getProperty('checktrail.repository')) } }
dependencies { testImplementation 'org.junit.jupiter:junit-jupiter:6.1.3'; testRuntimeOnly 'org.junit.platform:junit-platform-launcher:6.1.3' }
tasks.withType(JavaCompile).configureEach { options.encoding='UTF-8'; options.release=17 }
test { useJUnitPlatform() }
${extra}
`;
export const gradleSources = {
  "src/main/java/example/Counter.java":
    "package example; public class Counter { public static int next(int n){return n+1;} }\n",
  "src/test/java/example/CounterTest.java":
    "package example; import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.*; public class CounterTest { @Test void next(){assertEquals(3,Counter.next(2));} @Test void boundary(){assertEquals(0,Counter.next(-1));} }\n",
};
export async function gradleFixture(t: TestContext, extra = "") {
  const cache = process.env.CHECKTRAIL_GRADLE_CACHE;
  if (!cache) throw Error("Native Gradle artifact cache not selected");
  const root = await fixture(t, {
    "settings.gradle": "rootProject.name='original-counter'\n",
    "build.gradle": gradleBuild(extra),
    ...gradleSources,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["jvm.gradle-test"] }],
    }),
  });
  await mkdir(path.join(root, ".checktrail"));
  const dependencyDirectory = await import("node:fs/promises").then((fs) =>
    fs.access(path.join(cache, "gradle-dependencies")).then(
      () => "gradle-dependencies",
      (error) => {
        if (error.code === "ENOENT") return "maven-dependencies";
        throw error;
      },
    ),
  );
  for (const name of ["gradle-review-tools", dependencyDirectory])
    await cp(
      path.join(cache, name),
      path.join(
        root,
        ".checktrail",
        name === dependencyDirectory ? "maven-dependencies" : name,
      ),
      { recursive: true },
    );
  const config = {
    schemaVersion: 1,
    distribution: ".checktrail/gradle-review-tools/gradle-9.8.0",
    repository: ".checktrail/maven-dependencies/artifacts",
    repositoryManifest: ".checktrail/maven-dependencies/repository.json",
    repositorySha256: mavenHash(
      await readFile(
        path.join(root, ".checktrail/maven-dependencies/repository.json"),
      ),
    ),
    modules: [
      {
        path: ".",
        kind: "java",
        testClasses: [
          {
            file: "src/test/java/example/CounterTest.java",
            className: "example.CounterTest",
          },
        ],
        supportTests: [] as string[],
      },
    ],
  };
  await writeFile(
    path.join(root, "checktrail.gradle.json"),
    JSON.stringify(config),
  );
  return { root, config };
}
