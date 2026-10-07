import { access, copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TestContext } from "node:test";
import { detektArtifacts } from "../src/detekt-artifacts.js";
import { fixture } from "./helpers.js";
export const nativeArchive = "/opt/checktrail/detekt-cli-2.0.0-alpha.6-all.jar";
export const nativeDetekt =
  (await access(nativeArchive).then(
    () => true,
    () => false,
  )) &&
  /^openjdk 25\.0\.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25\.0\.4\+7 /.test(
    spawnSync("java", ["--version"], { encoding: "utf8", timeout: 10000 })
      .stdout ?? "",
  );
export const nativeOptions = {
  skip: nativeDetekt ? false : "Pinned detekt or Temurin toolchain unavailable",
  timeout: 240000,
};
export const detektPolicy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["jvm.detekt"] }],
});
export const detektConfig = {
  schemaVersion: 1,
  jar: ".checktrail/detekt.jar",
  sha256: detektArtifacts.jarSha256,
  profile: "core-default-light-all-selected-v1",
};
export const brokenKotlin =
  "fun originalDecision(value: Int): Int = value + 42\n";
export const fixedKotlin =
  "const val ORIGINAL_INCREMENT = 42\nfun originalDecision(value: Int): Int = value + ORIGINAL_INCREMENT\n";
export const nearMissKotlin =
  "fun originalDecision(value: Int): Int = value + 1\n";
export async function detektFixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    "checktrail.json": detektPolicy,
    "checktrail.detekt.json": JSON.stringify(detektConfig),
    "Original.kt": fixedKotlin,
    "Another with spaces.kt":
      "fun anotherDecision(value: Int): Int = value + 1\n",
    ...files,
  });
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await copyFile(nativeArchive, path.join(root, detektConfig.jar));
  return root;
}
