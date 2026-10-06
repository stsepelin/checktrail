import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { CHECKSTYLE_SHA256 } from "../src/checkstyle.js";
import { fixture } from "./helpers.js";
export const nativeJar = "/opt/checktrail/checkstyle-14.3.0-all.jar";
export const nativeCheckstyle =
  (await access(nativeJar).then(
    () => true,
    () => false,
  )) &&
  /^openjdk 25\.0\.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25\.0\.4\+7 /.test(
    spawnSync("java", ["--version"], { encoding: "utf8", timeout: 10000 })
      .stdout ?? "",
  );
export const nativeOptions = {
  skip: nativeCheckstyle
    ? false
    : "Pinned Checkstyle artifact or Temurin toolchain unavailable",
  timeout: 240000,
};
export const checkstylePolicy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["jvm.checkstyle"] }],
});
export const checkstyleConfig = {
  schemaVersion: 1,
  jar: ".checktrail/checkstyle.jar",
  sha256: CHECKSTYLE_SHA256,
  config: "checkstyle.xml",
  failOn: "error",
};
export const checkstyleXml =
  '<module name="Checker"><module name="FileTabCharacter"/><module name="TreeWalker"><module name="NeedBraces"/></module></module>';
export const goodJava =
  "class First {\n  int value(int x) { if (x > 0) { return x; } return 0; }\n}\n";
export const brokenJava =
  "class First {\n\tint value(int x) { if (x > 0) return x; return 0; }\n}\n";
export async function checkstyleFixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    "pom.xml": "<project/>",
    "checktrail.json": checkstylePolicy,
    "checktrail.checkstyle.json": JSON.stringify(checkstyleConfig),
    "checkstyle.xml": checkstyleXml,
    "First.java": goodJava,
    "Second with spaces.java": "class Second {}\n",
    ...files,
  });
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await copyFile(nativeJar, path.join(root, checkstyleConfig.jar));
  return root;
}
