import { access, copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TestContext } from "node:test";
import { spotbugsArtifacts } from "../src/spotbugs-artifacts.js";
import { fixture } from "./helpers.js";
export const nativeArchive = "/opt/checktrail/spotbugs-4.10.4.tgz";
export const nativeSpotbugs =
  (await access(nativeArchive).then(
    () => true,
    () => false,
  )) &&
  /^openjdk 25\.0\.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25\.0\.4\+7 /.test(
    spawnSync("java", ["--version"], { encoding: "utf8", timeout: 10000 })
      .stdout ?? "",
  );
export const nativeOptions = {
  skip: nativeSpotbugs
    ? false
    : "Pinned SpotBugs or Temurin toolchain unavailable",
  timeout: 240000,
};
export const spotbugsPolicy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["jvm.spotbugs"] }],
});
export const spotbugsConfig = {
  schemaVersion: 1,
  archive: ".checktrail/spotbugs.tgz",
  sha256: spotbugsArtifacts.archiveSha256,
  profile: "core-default-max-v1",
};
export const javaConfig = {
  schemaVersion: 1,
  release: 17,
  warningsAsErrors: false,
  classPath: [],
};
export const brokenJava =
  "public class First {\n  public static int size(String value) { if (value == null) return value.length(); return value.length(); }\n}\n";
export const goodJava =
  "public class First {\n  public static int size(String value) { if (value == null) return 0; return value.length(); }\n}\n";
export async function spotbugsFixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    "pom.xml": "<project/>",
    "checktrail.json": spotbugsPolicy,
    "checktrail.java.json": JSON.stringify(javaConfig),
    "checktrail.spotbugs.json": JSON.stringify(spotbugsConfig),
    "First.java": goodJava,
    "Second with spaces.java":
      "class Second { public static class Nested { public int value() { return 1; } } }\n",
    ...files,
  });
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await copyFile(nativeArchive, path.join(root, spotbugsConfig.archive));
  return root;
}
