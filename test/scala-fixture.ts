import { access, copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TestContext } from "node:test";
import { scalaArtifacts } from "../src/scala-artifacts.js";
import { fixture } from "./helpers.js";
export const nativeArchive = "/opt/checktrail/scala3-3.9.0.zip";
export const nativeScala =
  (await access(nativeArchive).then(
    () => true,
    () => false,
  )) &&
  /^openjdk 25\.0\.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25\.0\.4\+7 /.test(
    spawnSync("java", ["--version"], { encoding: "utf8", timeout: 10000 })
      .stdout ?? "",
  );
export const nativeOptions = {
  skip: nativeScala ? false : "Pinned Scala or Temurin toolchain unavailable",
  timeout: 240000,
};
export const scalaPolicy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["jvm.scala"] }],
});
export const scalaConfig = {
  schemaVersion: 1,
  archive: ".checktrail/scala.zip",
  sha256: scalaArtifacts.archiveSha256,
  profile: scalaArtifacts.profile,
  jvmTarget: "17",
  warningsAsErrors: false,
  classPath: [],
};
export const brokenScala = 'object Original { val answer: Int = "wrong" }\n';
export const fixedScala = "object Original { val answer: Int = 4 }\n";
export const nearMissScala =
  "class nowarnAdditional extends scala.annotation.StaticAnnotation\nobject Original { @nowarnAdditional val answer: Int = 4 }\n";
export async function scalaFixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    "checktrail.json": scalaPolicy,
    "checktrail.scala.json": JSON.stringify(scalaConfig),
    "Original.scala": fixedScala,
    "Another with spaces.scala": "type OriginalAlias = String\n",
    ...files,
  });
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await copyFile(nativeArchive, path.join(root, scalaConfig.archive));
  return root;
}
