import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import {
  scalaFixture,
  nativeOptions,
  scalaConfig,
  fixedScala,
} from "./scala-fixture.js";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
test(
  "native Scala resolves pinned dependency classes without initialization and rejects missing changed source bearing and manifest dependencies",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t),
      hidden = path.join(root, ".checktrail/dependency"),
      classes = path.join(hidden, "classes"),
      source = path.join(hidden, "Dependency.java"),
      jar = path.join(root, ".checktrail/dependency.jar"),
      marker = path.join(root, "executed");
    await mkdir(classes, { recursive: true });
    await writeFile(
      source,
      "package synthetic; public class Dependency { static { try { java.nio.file.Files.writeString(java.nio.file.Path.of(" +
        JSON.stringify(marker) +
        '),"unexpected"); } catch(Exception e) { throw new RuntimeException(e); } } public static int number() { return 4; } }',
    );
    let result = spawnSync(
      "javac",
      [
        "-proc:none",
        "-implicit:none",
        "--source-path",
        "",
        "--release",
        "17",
        "-d",
        classes,
        source,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(
      "jar",
      ["--create", "--file", jar, "--no-manifest", "-C", classes, "."],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(jar),
      config = {
        ...scalaConfig,
        classPath: [
          { path: ".checktrail/dependency.jar", sha256: hash(bytes) },
        ],
      };
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify(config),
    );
    await writeFile(
      path.join(root, "Original.scala"),
      "object Original { def number: Int = synthetic.Dependency.number() }\n",
    );
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    await assert.rejects(access(marker), { code: "ENOENT" });
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify(scalaConfig),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify(config),
    );
    await writeFile(jar, bytes.subarray(1));
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    await writeFile(jar, bytes);
    await writeFile(path.join(classes, "Hidden.scala"), fixedScala);
    result = spawnSync(
      "jar",
      ["--create", "--file", jar, "--no-manifest", "-C", classes, "."],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
    config.classPath[0]!.sha256 = hash(await readFile(jar));
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify(config),
    );
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    await rm(path.join(classes, "Hidden.scala"));
    const manifest = path.join(hidden, "MANIFEST.MF");
    await writeFile(
      manifest,
      "Manifest-Version: 1.0\nClass-Path: undeclared.jar\n\n",
    );
    result = spawnSync(
      "jar",
      ["--create", "--file", jar, "--manifest", manifest, "-C", classes, "."],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
    config.classPath[0]!.sha256 = hash(await readFile(jar));
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify(config),
    );
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
  },
);
test(
  "native Scala applies declared warning policy and preserves compiler failure summaries and partial findings",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t, {
      "Original.scala":
        "object Original { def number(x: Option[Int]): Int = x match { case Some(n) => n } }\n",
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => [
        f.ruleId,
        f.level,
        f.file,
        f.line,
      ]),
      [["scalac/PatternMatchExhaustivityID", "warning", "Original.scala", 1]],
    );
    assert.equal(report.checks[0]!.findingsComplete, true);
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify({ ...scalaConfig, warningsAsErrors: true }),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.equal(report.checks[0]!.findings!.length, 1);
  },
);
test(
  "native Scala binds same-named nested sources and all generated classes to declared JVM 17 21 and 25 targets",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t, {
      "a/Same.scala": "package a\nobject Same { val answer: Int = 1 }\n",
      "b/Same.scala": "package b\nobject Same { val answer: Int = 2 }\n",
    });
    for (const target of ["17", "21", "25"]) {
      await writeFile(
        path.join(root, "checktrail.scala.json"),
        JSON.stringify({ ...scalaConfig, jvmTarget: target }),
      );
      const report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      const d = JSON.parse(report.checks[0]!.processes[0]!.stdout);
      assert.ok(
        d.native.outputs.some(
          (o: { file: string; source: string }) =>
            o.file === "a/Same.class" && o.source.endsWith("/a/Same.scala"),
        ),
      );
      assert.ok(
        d.native.outputs.some(
          (o: { file: string; source: string }) =>
            o.file === "b/Same.class" && o.source.endsWith("/b/Same.scala"),
        ),
      );
      const classes = d.native.outputs.filter(
        (o: { classMajor: number | null }) => o.classMajor !== null,
      );
      assert.ok(classes.length >= 4);
      assert.ok(
        classes.every(
          (o: { classMajor: number }) => o.classMajor === Number(target) + 44,
        ),
      );
    }
  },
);
