import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { kotlinJar } from "../src/kotlin-jar.js";
import { kotlinHash } from "../src/kotlin-archive.js";
import { kotlinRead, kotlinReadSync } from "../src/kotlin-io.js";
import {
  kotlinFixture,
  nativeOptions,
  kotlinConfig,
  fixedKotlin,
} from "./kotlin-fixture.js";
import { fixture } from "./helpers.js";
function dataJar(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [],
    directories: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name),
      bytes = Buffer.from(text),
      local = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes);
    directories.push(directory, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directories),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
test("Kotlin dependency data rejects source entries duplicate manifests and undeclared folded classpath without loading code", () => {
  assert.deepEqual(
    kotlinJar(
      dataJar([["META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n\r\n"]]),
    ),
    { classPath: [], entries: 1 },
  );
  assert.deepEqual(
    kotlinJar(
      dataJar([
        [
          "META-INF/MANIFEST.MF",
          "Manifest-Version: 1.0\r\nClass-Path: original-\r\n dependency.jar\r\n\r\n",
        ],
      ]),
    ).classPath,
    ["original-dependency.jar"],
  );
  for (const entries of [
    [["Original.kt", "fun original()=0"]],
    [["Original.kts", 'error("never execute")']],
    [["Original.java", "class Original {}"]],
    [["Original.scala", "object Original"]],
    [
      ["META-INF/MANIFEST.MF", ""],
      ["META-INF/MANIFEST.MF", ""],
    ],
    [["meta-inf/manifest.mf", "Manifest-Version: 1.0\n"]],
    [["../Original.class", ""]],
  ] as [string, string][][])
    assert.throws(
      () => kotlinJar(dataJar(entries)),
      /Kotlin (?:dependency JAR contains unselected source|JAR)/,
    );
  assert.throws(
    () => kotlinJar(Buffer.from("not a JAR")),
    /Unsupported Kotlin JAR/,
  );
});
test("Kotlin physical reads enforce zero exact and over byte limits for both planner and evidence", async (t) => {
  const root = await fixture(t, { "Empty.kt": "", "One.kt": "x" });
  assert.equal((await kotlinRead(path.join(root, "Empty.kt"), 0)).length, 0);
  assert.equal(kotlinReadSync(path.join(root, "Empty.kt"), 0).length, 0);
  assert.equal(
    (await kotlinRead(path.join(root, "One.kt"), 1)).toString(),
    "x",
  );
  assert.equal(kotlinReadSync(path.join(root, "One.kt"), 1).toString(), "x");
  await assert.rejects(kotlinRead(path.join(root, "One.kt"), 0), /byte bound/);
  assert.throws(
    () => kotlinReadSync(path.join(root, "One.kt"), 0),
    /byte bound/,
  );
});
test(
  "native Kotlin resolves pinned dependency classes without initializing them and rejects missing changed source bearing or manifest dependencies",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t),
      directory = path.join(root, ".checktrail"),
      classes = path.join(directory, "classes");
    await mkdir(classes);
    const source = path.join(directory, "OriginalLibrary.java");
    await writeFile(
      source,
      'public final class OriginalLibrary { static { throwIfInvoked(); } private static void throwIfInvoked() { throw new IllegalStateException("must never initialize"); } public static int length(String value) { return value.length(); } }\n',
    );
    const compiled = spawnSync(
      "javac",
      [
        "-proc:none",
        "-implicit:none",
        "--release",
        "17",
        "-d",
        classes,
        source,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const jar = path.join(directory, "dependency.jar"),
      packed = spawnSync(
        "jar",
        ["--create", "--file", jar, "--no-manifest", "-C", classes, "."],
        { encoding: "utf8", timeout: 30000 },
      );
    assert.equal(packed.status, 0, packed.stderr);
    const bytes = await kotlinRead(jar, 32 * 1024 * 1024),
      config = {
        ...kotlinConfig,
        classPath: [
          { path: ".checktrail/dependency.jar", sha256: kotlinHash(bytes) },
        ],
      };
    await writeFile(
      path.join(root, "checktrail.kotlin.json"),
      JSON.stringify(config),
    );
    await writeFile(
      path.join(root, "Original.kt"),
      "fun originalLength(value:String):Int=OriginalLibrary.length(value)\n",
    );
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    await writeFile(
      path.join(root, "checktrail.kotlin.json"),
      JSON.stringify(kotlinConfig),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.ok(
      report.checks[0]!.findings!.some(
        (f) => f.ruleId === "kotlinc/UNRESOLVED_REFERENCE",
      ),
    );
    for (const payload of [
      Buffer.from("changed"),
      dataJar([["Original.kt", fixedKotlin]]),
      dataJar([
        [
          "META-INF/MANIFEST.MF",
          "Manifest-Version: 1.0\r\nClass-Path: other.jar\r\n\r\n",
        ],
      ]),
    ]) {
      await writeFile(jar, payload);
      await writeFile(
        path.join(root, "checktrail.kotlin.json"),
        JSON.stringify({
          ...config,
          classPath: [
            { path: ".checktrail/dependency.jar", sha256: kotlinHash(payload) },
          ],
        }),
      );
      const check = (await createPlan(root)).plan.checks[0]!;
      assert.equal(check.commands.length, 0);
      assert.ok(check.unavailableReason);
    }
  },
);
test(
  "native Kotlin applies the declared warning policy and preserves compiler partial failure",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t, {
      "Original.kt":
        'fun originalLength(value:String?):Int { "discarded";return value?.length ?: 0 }\n',
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.ok(report.checks[0]!.findings!.some((f) => f.level === "warning"));
    assert.equal(report.checks[0]!.findingsComplete, true);
    await writeFile(
      path.join(root, "checktrail.kotlin.json"),
      JSON.stringify({ ...kotlinConfig, warningsAsErrors: true }),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.ok(report.checks[0]!.findings!.some((f) => f.level === "warning"));
  },
);

test(
  "native Kotlin binds every generated class to the declared JVM 17 21 and 25 target",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t);
    for (const target of ["17", "21", "25"]) {
      await writeFile(
        path.join(root, "checktrail.kotlin.json"),
        JSON.stringify({ ...kotlinConfig, jvmTarget: target }),
      );
      const report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      const data = JSON.parse(report.checks[0]!.processes[0]!.stdout);
      const classes = data.native.outputs.filter((o: { file: string }) =>
        o.file.endsWith(".class"),
      );
      assert.ok(classes.length >= 2);
      assert.ok(
        classes.every(
          (o: { classMajor: number }) => o.classMajor === Number(target) + 44,
        ),
      );
    }
  },
);
