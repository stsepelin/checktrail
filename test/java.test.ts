import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { javaEvidence } from "../src/java-evidence.js";
import { fixture } from "./helpers.js";

const version = spawnSync("java", ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});
const native =
  version.status === 0 &&
  version.stdout.startsWith("openjdk 25.0.4 ") &&
  version.stdout.includes("Temurin-25.0.4+7");
const options = {
  skip: native ? false : "Verified Temurin JDK unavailable",
  timeout: 120000,
};
const config = {
  schemaVersion: 1,
  release: 21,
  warningsAsErrors: true,
  classPath: [] as { path: string; sha256: string }[],
};
const simple = {
  "pom.xml": "<project/>",
  "checktrail.java.json": JSON.stringify(config),
  "Value.java": "public class Value { public int value() { return 1; } }",
};

test("Java planning never executes Maven/Gradle and requires explicit bounded configuration", async (t) => {
  const root = await fixture(t, {
    "build.gradle.kts": 'throw Exception("never execute")',
    "Value.java": simple["Value.java"],
  });
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /Prepare/,
  );
  await writeFile(
    path.join(root, "checktrail.java.json"),
    JSON.stringify(config),
  );
  assert.equal(
    (await createPlan(root)).plan.checks[0]!.unavailableReason,
    undefined,
  );
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  for (const invalid of [
    { ...config, release: 26 },
    { ...config, compilerArgs: ["-processor", "Custom"] },
    {
      ...config,
      classPath: [{ path: "../hidden.jar", sha256: "0".repeat(64) }],
    },
  ]) {
    await writeFile(
      path.join(root, "checktrail.java.json"),
      JSON.stringify(invalid),
    );
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason);
  }
  await writeFile(
    path.join(root, "checktrail.java.json"),
    JSON.stringify(config),
  );
  for (const file of [
    "Other.kt",
    "Other.scala",
    "Other.kts",
    "module-info.java",
  ]) {
    await writeFile(path.join(root, file), "");
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason, file);
    await rm(path.join(root, file));
  }
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: ["jvm.javac"],
          environment: ["JAVA_TOOL_OPTIONS"],
        },
      ],
    }),
  );
  await assert.rejects(
    createPlan(root, {
      environment: { JAVA_TOOL_OPTIONS: "-javaagent:custom.jar" },
    }),
    /protected/,
  );
});

test(
  "native Java compiles the public record fixture and reports a type regression without running application initialization",
  options,
  async (t) => {
    const root = await fixture(t, {});
    await cp(
      fileURLToPath(new URL("../../examples/java/", import.meta.url)),
      root,
      { recursive: true },
    );
    await writeFile(
      path.join(root, "NeverRun.java"),
      'class NeverRun { static { try { java.nio.file.Files.writeString(java.nio.file.Path.of("executed"), "bad"); } catch (Exception failure) { throw new RuntimeException(failure); } } }',
    );
    const good = await validate(root, { trusted: true });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(good.checks[0]!.findingsComplete, true);
    assert.equal(good.checks[0]!.tests, undefined);
    assert.ok(
      good.checks[0]!.tools!.every((tool) => tool.status === "identified"),
    );
    await assert.rejects(access(path.join(root, "executed")));
    await assert.rejects(access(path.join(root, "NeverRun.class")));
    const source = path.join(
      root,
      "src/main/java/example/catalog/Quantity.java",
    );
    const text = await readFile(source, "utf8");
    await writeFile(source, text.replace("value + other.value", '"wrong"'));
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findingsComplete, false);
    assert.ok(
      broken.checks[0]!.findings!.some(
        (item) =>
          item.level === "error" &&
          item.file === "src/main/java/example/catalog/Quantity.java" &&
          item.line === 5,
      ),
    );
    await writeFile(source, text);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);

test(
  "native Java accounts for empty files, package metadata and each top-level type; missing analysis cannot pass",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...simple,
      "Empty.java": "// No types",
      "example/package-info.java": "/** Public package. */ package example;",
      "Pair.java": "class First {} class Second {}",
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const { plan } = await createPlan(root);
    const process = report.checks[0]!.processes[0]!;
    type Evidence = {
      sources: {
        file: string;
        parsed: number;
        declared: string[];
        analyzed: string[];
      }[];
      finished: number;
      success: boolean;
      extra: string;
    };
    for (const mutate of [
      (data: Evidence) => data.sources.pop(),
      (data: Evidence) => {
        data.sources.find((item) => item.declared.length > 1)!.analyzed.pop();
      },
      (data: Evidence) => {
        data.sources[0]!.parsed = 0;
      },
      (data: Evidence) => {
        data.sources[0]!.file = "/unknown.java";
      },
      (data: Evidence) => {
        data.finished = 0;
      },
      (data: Evidence) => {
        data.extra = "unparsed diagnostic";
      },
      (data: Evidence) => {
        data.success = false;
      },
    ]) {
      const data = JSON.parse(process.stdout) as Evidence;
      mutate(data);
      assert.equal(
        javaEvidence(
          plan.checks[0]!,
          [{ ...process, stdout: JSON.stringify(data) }],
          root,
        ).status,
        "inconclusive",
      );
    }
  },
);

test(
  "native Java retains warnings, enforces declared release, and does not implicitly compile excluded source",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...simple,
      "Value.java": "class Value { java.util.List values; }",
    });
    const strict = await validate(root, { trusted: true });
    assert.equal(strict.outcome, "failed", JSON.stringify(strict.checks));
    await writeFile(
      path.join(root, "checktrail.java.json"),
      JSON.stringify({ ...config, warningsAsErrors: false }),
    );
    const warnings = await validate(root, { trusted: true });
    assert.equal(
      warnings.checks[0]!.status,
      "passed",
      JSON.stringify(warnings.checks),
    );
    assert.ok(
      warnings.checks[0]!.findings!.some((item) => item.level === "warning"),
    );
    await writeFile(
      path.join(root, "Value.java"),
      "public record Value(int value) {}",
    );
    await writeFile(
      path.join(root, "checktrail.java.json"),
      JSON.stringify({ ...config, release: 11 }),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await writeFile(
      path.join(root, "checktrail.java.json"),
      JSON.stringify(config),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await mkdir(path.join(root, "build"));
    await writeFile(
      path.join(root, "build/Hidden.java"),
      "package build; public class Hidden {}",
    );
    await writeFile(
      path.join(root, "Value.java"),
      "class Value { build.Hidden hidden; }",
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(excluded.outcome, "failed", JSON.stringify(excluded.checks));
    assert.ok(
      excluded.checks[0]!.findings!.some((item) =>
        item.message.includes("package build does not exist"),
      ),
    );
  },
);

test(
  "native Java consumes checksummed JARs but never executes processors or follows manifest classpaths",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...simple,
      "Value.java": "class Value { int value = library.Library.value(); }",
    });
    const prepared = path.join(root, ".checktrail");
    const classes = path.join(prepared, "classes");
    await mkdir(path.join(classes, "META-INF/services"), { recursive: true });
    await writeFile(
      path.join(prepared, "Library.java"),
      "package library; public class Library { public static int value() { return 7; } }",
    );
    await writeFile(
      path.join(prepared, "Processor.java"),
      'import java.util.Set; import javax.lang.model.element.TypeElement; @javax.annotation.processing.SupportedAnnotationTypes("*") @javax.annotation.processing.SupportedSourceVersion(javax.lang.model.SourceVersion.RELEASE_25) public class Processor extends javax.annotation.processing.AbstractProcessor { public boolean process(Set<? extends TypeElement> annotations, javax.annotation.processing.RoundEnvironment round) { throw new IllegalStateException("processor-executed"); } }',
    );
    const run = (tool: string, args: string[]) => {
      const result = spawnSync(tool, args, {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
    };
    run("javac", [
      "--release",
      "21",
      "-proc:none",
      "-d",
      classes,
      path.join(prepared, "Library.java"),
    ]);
    run("javac", [
      "-proc:none",
      "-d",
      classes,
      path.join(prepared, "Processor.java"),
    ]);
    await writeFile(
      path.join(
        classes,
        "META-INF/services/javax.annotation.processing.Processor",
      ),
      "Processor\n",
    );
    const jar = path.join(prepared, "library.jar");
    const pin = async () =>
      writeFile(
        path.join(root, "checktrail.java.json"),
        JSON.stringify({
          ...config,
          classPath: [
            {
              path: ".checktrail/library.jar",
              sha256: createHash("sha256")
                .update(await readFile(jar))
                .digest("hex"),
            },
          ],
        }),
      );
    run("jar", ["--create", "--file", jar, "-C", classes, "."]);
    await pin();
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    const alias = path.join(prepared, "alias.jar");
    await symlink(jar, alias);
    const pinnedConfig = JSON.parse(
      await readFile(path.join(root, "checktrail.java.json"), "utf8"),
    ) as typeof config;
    pinnedConfig.classPath[0]!.path = ".checktrail/alias.jar";
    await writeFile(
      path.join(root, "checktrail.java.json"),
      JSON.stringify(pinnedConfig),
    );
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /symbolic links/,
    );
    await pin();
    const source = path.join(root, "Value.java");
    await writeFile(
      source,
      "class Value { String value = library.Library.value(); }",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await writeFile(
      source,
      "class Value { int value = library.Library.value(); }",
    );
    const manifest = path.join(prepared, "MANIFEST.MF");
    await writeFile(
      manifest,
      "Manifest-Version: 1.0\nClass-Path: hidden.jar\n\n",
    );
    run("jar", [
      "--create",
      "--file",
      jar,
      "--manifest",
      manifest,
      "-C",
      classes,
      ".",
    ]);
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /checksum/,
    );
    await pin();
    const hidden = await validate(root, { trusted: true });
    assert.equal(hidden.outcome, "incomplete");
    assert.equal(hidden.checks[0]!.status, "error");
    await writeFile(path.join(classes, "Hidden.java"), "class Hidden {}");
    run("jar", ["--create", "--file", jar, "-C", classes, "."]);
    await pin();
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
  },
);
