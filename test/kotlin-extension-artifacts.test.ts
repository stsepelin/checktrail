import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { kotlinLibraries, kotlinHash } from "../src/kotlin-archive.js";
import { kotlinJar } from "../src/kotlin-jar.js";
import { kotlinScriptingArtifacts } from "../src/kotlin-extension-artifacts.js";
import { nativeArchive, nativeOptions } from "./kotlin-fixture.js";

test(
  "selected Kotlin script libraries require every exact artifact without broadening the conventional compiler closure",
  nativeOptions,
  async () => {
    const archive = await readFile(nativeArchive);
    const conventional = kotlinLibraries(archive);
    const extended = kotlinLibraries(archive, true);
    assert.equal(conventional.size, 6);
    assert.equal(extended.size, 10);
    for (const pin of kotlinScriptingArtifacts) {
      assert.equal(conventional.has(pin.name), false);
      const bytes = extended.get(pin.name)!;
      assert.equal(bytes.length, pin.bytes);
      assert.equal(kotlinHash(bytes), pin.sha256);
      assert.deepEqual(kotlinJar(bytes).classPath, []);
    }
    const corrupted = Buffer.from(archive);
    corrupted[1024] = corrupted[1024]! ^ 1;
    assert.throws(
      () => kotlinLibraries(corrupted, true),
      /pinned Kotlin compiler archive bytes disagree/,
    );
  },
);
