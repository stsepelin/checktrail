import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { scalaLibraries } from "../src/scala-archive.js";
import { scalaArtifacts } from "../src/scala-artifacts.js";
import path from "node:path";
import { validate } from "../src/engine.js";
import {
  nativeOptions,
  nativeArchive,
  scalaFixture,
  scalaConfig,
} from "./scala-fixture.js";
test(
  "native Scala baseline observes post-typer inline and quote flags before declaring a complete source profile",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t);
    for (const [source, flag] of [
      [
        "object Original { inline def twice(inline n:Int):Int=n+n; val result:Int=twice(2) }\n",
        "inline",
      ],
      [
        "import scala.quoted.*\nobject Original { def code(using Quotes):Expr[Int]='{ 1+2 } }\n",
        "staging",
      ],
      [
        "import scala.quoted.*\nobject Original { inline def answer:Int=\u0024{impl}; def impl(using Quotes):Expr[Int]=Expr(4) }\n",
        "macro",
      ],
    ] as const) {
      await writeFile(path.join(root, "Original.scala"), source);
      const report = await validate(root, { trusted: true }),
        result = report.checks[0]!;
      assert.equal(result.status, "inconclusive", flag);
      const data = JSON.parse(result.processes[0]!.stdout);
      assert.equal(data.native.errors, 0);
      assert.equal(data.native.featureStages, 1);
      const original = data.native.sources.find((s: { file: string }) =>
        s.file.endsWith("/Original.scala"),
      );
      assert.equal(original.featureVisits, 1);
      assert.equal(original[flag], true, flag);
    }
  },
);

test(
  "native Scala baseline observes an executed macro annotation and accepts a distinct ordinary annotation near miss",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t),
      directory = path.join(root, ".checktrail/macro-annotation"),
      libraries = path.join(directory, "lib"),
      classes = path.join(directory, "classes"),
      source = path.join(directory, "Marker.scala"),
      jar = path.join(root, ".checktrail/marker.jar"),
      marker = path.join(directory, "invoked");
    await mkdir(libraries, { recursive: true });
    await mkdir(classes);
    for (const [name, bytes] of scalaLibraries(await readFile(nativeArchive)))
      await writeFile(path.join(libraries, name), bytes);
    const classPath = scalaArtifacts.runtimeLibraries
      .map((p) => path.join(libraries, p.name))
      .join(path.delimiter);
    await writeFile(
      source,
      "import scala.quoted.*\nimport scala.annotation.{experimental, MacroAnnotation}\n@experimental class Marker extends MacroAnnotation { def transform(using Quotes)(definition: quotes.reflect.Definition, companion: Option[quotes.reflect.Definition]): List[quotes.reflect.Definition] = { java.nio.file.Files.writeString(java.nio.file.Path.of(" +
        JSON.stringify(marker) +
        '),"compile-time"); List(definition) ++ companion.toList } }\n',
    );
    const env = { ...process.env };
    for (const key of [
      "JAVA_TOOL_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "_JAVA_OPTIONS",
      "CLASSPATH",
    ])
      delete env[key];
    let compiled = spawnSync(
      "java",
      [
        "-Xmx512m",
        "-classpath",
        classPath,
        "dotty.tools.dotc.Main",
        "-encoding",
        "UTF-8",
        "-source",
        "3.9",
        "-release:17",
        "-classpath",
        classPath,
        "-d",
        classes,
        source,
      ],
      { encoding: "utf8", timeout: 30000, env },
    );
    assert.equal(compiled.error, undefined);
    assert.equal(compiled.signal, null);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    compiled = spawnSync(
      "jar",
      ["--create", "--file", jar, "--no-manifest", "-C", classes, "."],
      { encoding: "utf8", timeout: 10000, env },
    );
    assert.equal(compiled.error, undefined);
    assert.equal(compiled.signal, null);
    assert.equal(compiled.status, 0, compiled.stderr);
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify({
        ...scalaConfig,
        classPath: [
          {
            path: ".checktrail/marker.jar",
            sha256: createHash("sha256")
              .update(await readFile(jar))
              .digest("hex"),
          },
        ],
      }),
    );
    await writeFile(
      path.join(root, "Original.scala"),
      "import scala.annotation.experimental\n@experimental object Original { @Marker def answer:Int=4 }\n",
    );
    let report = await validate(root, { trusted: true }),
      result = report.checks[0]!;
    assert.equal(result.status, "inconclusive", JSON.stringify(result));
    const data = JSON.parse(result.processes[0]!.stdout),
      original = data.native.sources.find((s: { file: string }) =>
        s.file.endsWith("/Original.scala"),
      );
    assert.equal(data.native.errors, 0);
    assert.equal(data.native.featureStages, 1);
    assert.equal(original.featureVisits, 1);
    assert.equal(original.macro, true);
    assert.equal(await readFile(marker, "utf8"), "compile-time");
    await writeFile(
      path.join(root, "Original.scala"),
      "class MarkerExtra extends scala.annotation.StaticAnnotation\nobject Original { @MarkerExtra val answer:Int=4 }\n",
    );
    report = await validate(root, { trusted: true });
    result = report.checks[0]!;
    assert.equal(result.status, "passed", JSON.stringify(result));
    const near = JSON.parse(result.processes[0]!.stdout).native.sources.find(
      (s: { file: string }) => s.file.endsWith("/Original.scala"),
    );
    assert.equal(near.macro, false);
    assert.equal(near.inline, false);
    assert.equal(near.staging, false);
  },
);
