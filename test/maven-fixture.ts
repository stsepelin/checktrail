import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
export const mavenPom = (extra = "") =>
  `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>original-counter</artifactId><version>1.0.0</version><properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>6.1.3</version><scope>test</scope></dependency></dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.5.0</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.16.0</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.6.0</version><configuration><failIfNoTests>true</failIfNoTests>${extra}</configuration></plugin></plugins></build></project>`;
export const mavenSources = {
  "src/main/java/example/Counter.java":
    "package example; public class Counter { public static int next(int value) { return value + 1; } }\n",
  "src/test/java/example/CounterTest.java":
    "package example; import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.*; public class CounterTest { @Test void next() { assertEquals(3, Counter.next(2)); } @Test void boundary() { assertEquals(0, Counter.next(-1)); } }\n",
};
export async function mavenFixture(t: TestContext, extra = "") {
  const cache = process.env.CHECKTRAIL_MAVEN_CACHE;
  if (!cache) throw Error("Native Maven artifact cache not selected");
  const root = await fixture(t, {
    "pom.xml": mavenPom(extra),
    ...mavenSources,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["jvm.maven-test"] }],
    }),
  });
  await mkdir(path.join(root, ".checktrail"));
  await cp(
    path.join(cache, "maven-review-tools"),
    path.join(root, ".checktrail/maven-review-tools"),
    { recursive: true },
  );
  await cp(
    path.join(cache, "maven-dependencies"),
    path.join(root, ".checktrail/maven-dependencies"),
    { recursive: true },
  );
  const config = {
    schemaVersion: 1,
    distribution: ".checktrail/maven-review-tools/apache-maven-3.10.0",
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
        packaging: "jar",
        testClasses: [
          {
            file: "src/test/java/example/CounterTest.java",
            className: "example.CounterTest",
          },
        ],
        supportTests: [],
      },
    ],
  };
  await writeFile(
    path.join(root, "checktrail.maven.json"),
    JSON.stringify(config),
  );
  return { root, config };
}
