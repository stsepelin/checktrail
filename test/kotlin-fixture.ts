import { access, copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TestContext } from "node:test";
import { kotlinArtifacts } from "../src/kotlin-artifacts.js";
import { fixture } from "./helpers.js";
export const nativeArchive = "/opt/checktrail/kotlin-compiler-2.4.10.zip";
export const nativeKotlin =
  (await access(nativeArchive).then(
    () => true,
    () => false,
  )) &&
  /^openjdk 25\.0\.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25\.0\.4\+7 /.test(
    spawnSync("java", ["--version"], { encoding: "utf8", timeout: 10000 })
      .stdout ?? "",
  );
export const nativeOptions = {
  skip: nativeKotlin ? false : "Pinned kotlin or Temurin toolchain unavailable",
  timeout: 240000,
};
export const kotlinPolicy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["jvm.kotlin"] }],
});
export const kotlinConfig = {
  schemaVersion: 1,
  archive: ".checktrail/kotlin.zip",
  sha256: kotlinArtifacts.archiveSha256,
  profile: kotlinArtifacts.profile,
  jvmTarget: "17",
  warningsAsErrors: false,
  classPath: [],
};
export const brokenKotlin =
  "fun originalLength(value: String?): Int = value.length\n";
export const fixedKotlin =
  "fun originalLength(value: String?): Int = value?.length ?: 0\n";
export const nearMissKotlin =
  'annotation class SuppressAdditional(val name: String)\n@SuppressAdditional("UNSAFE_CALL")\nfun originalLength(value: String?): Int = value?.length ?: 0\n';
export async function kotlinFixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    "checktrail.json": kotlinPolicy,
    "checktrail.kotlin.json": JSON.stringify(kotlinConfig),
    "Original.kt": fixedKotlin,
    "Another with spaces.kt": "typealias OriginalAlias = String\n",
    ...files,
  });
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await copyFile(nativeArchive, path.join(root, kotlinConfig.archive));
  return root;
}
