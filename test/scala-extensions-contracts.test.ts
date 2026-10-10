import assert from "node:assert/strict";
import { test } from "node:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { scalaConfigSchema } from "../src/scala.js";
import { scala2ConfigSchema } from "../src/scala2.js";
import { scala2Artifacts } from "../src/scala2-artifacts.js";
import { scala2Libraries } from "../src/scala2-archive.js";
import { kotlinJar } from "../src/kotlin-jar.js";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
const config = {
  schemaVersion: 1,
  archive: ".checktrail/scala2.zip",
  sha256: scala2Artifacts.archiveSha256,
  profile: scala2Artifacts.profile,
  jvmTarget: "25",
  warningsAsErrors: false,
  classPath: [],
};
function manifestJar(text: string) {
  const name = Buffer.from("META-INF/MANIFEST.MF"),
    bytes = Buffer.from(text),
    local = Buffer.alloc(30),
    directory = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt32LE(bytes.length, 20);
  directory.writeUInt32LE(bytes.length, 24);
  directory.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, directory, name, end]);
}
test("Scala 2 declarations keep compiler pins and unsupported options strict while missing tools leave planning inert", async (t) => {
  assert.equal(scalaConfigSchema.safeParse(config).success, true);
  assert.equal(scala2ConfigSchema.safeParse(config).success, true);
  for (const patch of [
    { sha256: "0".repeat(64) },
    { profile: "jvm-source-typed-backend-output-v1" },
    { archive: "../outside.zip" },
    { plugins: ["unselected.jar"] },
    { jvmTarget: "8" },
    { classPath: [{ path: "dependency.jar", sha256: "missing" }] },
  ])
    assert.equal(
      scala2ConfigSchema.safeParse({ ...config, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.throws(
    () => scala2Libraries(Buffer.from("unavailable")),
    /pinned Scala 2 compiler archive bytes disagree/,
  );
  const root = await fixture(t, {
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["jvm.scala"] }],
    }),
    "checktrail.scala.json": JSON.stringify(config),
    "Consumer.scala": "object Consumer { val amount:Int=1 }",
    "build.sbt": 'sys.error("never execute")',
  });
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.commands.length, 0);
  assert.ok(check.unavailableReason);
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
});
test("the byte-pinned native manifest limit does not enlarge ordinary dependency admission", () => {
  const large = manifestJar(
    "Manifest-Version: 1.0\r\nClass-Path: exact.jar\r\n\r\n" +
      "x".repeat(161765),
  );
  assert.throws(() => kotlinJar(large), /manifest header disagrees/);
  assert.deepEqual(kotlinJar(large, 256 * 1024).classPath, ["exact.jar"]);
  assert.throws(
    () => kotlinJar(large, large.readUInt32LE(22) - 1),
    /manifest header disagrees/,
  );
  for (const limit of [0, -1, 1.5, NaN, 1024 * 1024 + 1])
    assert.throws(() => kotlinJar(large, limit), /manifest limit is invalid/);
  assert.deepEqual(
    kotlinJar(manifestJar("Manifest-Version: 1.0\r\n\r\n")).classPath,
    [],
  );
});
