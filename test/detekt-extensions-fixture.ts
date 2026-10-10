import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { detektFixture, detektConfig, nativeDetekt } from "./detekt-fixture.js";
import { nativeArchive, nativeKotlin, kotlinConfig } from "./kotlin-fixture.js";
export const fullDetektConfig = {
  ...detektConfig,
  profile: "core-default-full-all-selected-v1",
  types: {
    profile: "linux-arm64-full-types-v1",
    kotlinArchive: kotlinConfig.archive,
    kotlinSha256: kotlinConfig.sha256,
    jvmTarget: "17",
    classPath: [],
  },
};
export const fullDetektOptions = {
  skip:
    nativeDetekt && nativeKotlin
      ? false
      : "Prepared native full detekt runtime unavailable",
  timeout: 240000,
};
export const originalTypedBroken =
  'fun originalNormalize(value: String): String = value?.trim() ?: ""\n';
export const originalTypedFixed =
  "fun originalNormalize(value: String): String = value.trim()\n";
export const originalTypedNearMiss =
  "fun originalNormalize(value: String?): String? = value?.trim()\n";
export async function fullDetektFixture(
  t: TestContext,
  source = originalTypedFixed,
) {
  const root = await detektFixture(t, {
    "checktrail.detekt.json": JSON.stringify(fullDetektConfig),
    "Original.kt": source,
  });
  await copyFile(nativeArchive, path.join(root, kotlinConfig.archive));
  return root;
}
