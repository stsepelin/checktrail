import assert from "node:assert/strict";
import { access, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import { kotlinFixture, kotlinConfig } from "./kotlin-fixture.js";
import {
  mixedKotlinFixture,
  mixedKotlinConfig,
  kotlinExtensionsOptions as options,
  javaProducer,
  kotlinGenerator,
} from "./kotlin-extensions-fixture.js";
test(
  "mixed Kotlin reports compile-only script diagnostics without executing Java or script bodies",
  options,
  async (t) => {
    const f = await mixedKotlinFixture(t);
    await writeFile(
      path.join(f.root, "scripts/Compile only.kts"),
      "val broken: Int = unknownValue\n",
    );
    const check = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(check.status, "failed", JSON.stringify(check));
    assert.equal(check.findingsComplete, false);
    assert.ok(
      (check.findings ?? []).some(
        (f) => f.file === "scripts/Compile only.kts" && f.line === 1,
      ),
    );
    assert.equal(JSON.parse(check.processes[0]!.stdout).java, null);
    await assert.rejects(access(f.marker));
  },
);
test(
  "mixed Kotlin records resolved Java and script suppression aliases as incomplete",
  { ...options, timeout: 240000 },
  async (t) => {
    const f = await mixedKotlinFixture(t, {
      "producer/JavaProducer.java": javaProducer.replace(
        "public class",
        '@SuppressWarnings("all") public class',
      ),
    });
    let check = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(check.status, "inconclusive", JSON.stringify(check));
    assert.ok(
      JSON.parse(
        check.processes[0]!.stdout,
      ).java.sources[0].annotations.includes("java.lang.SuppressWarnings"),
    );
    await writeFile(
      path.join(f.root, "producer/JavaProducer.java"),
      javaProducer,
    );
    await writeFile(
      path.join(f.root, "scripts/Compile only.kts"),
      '@file:Quiet("UNUSED_VARIABLE")\nimport kotlin.Suppress as Quiet\nval declared = producer.KotlinProducer.value()\n',
    );
    check = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(check.status, "inconclusive", JSON.stringify(check));
    assert.ok(
      JSON.parse(check.processes[0]!.stdout).kotlin.native.sources.some(
        (s: { annotations: string[] }) =>
          s.annotations.includes("kotlin.Suppress"),
      ),
    );
  },
);
test(
  "mixed Kotlin rejects missing or extra native generated files before compilation",
  { ...options, timeout: 240000 },
  async (t) => {
    for (const mode of ["missing", "extra"]) {
      const f = await mixedKotlinFixture(t);
      const original = kotlinGenerator();
      const body =
        mode === "extra"
          ? original.replace(
              "Files.writeString(rules,",
              'Files.writeString(root.resolve("src/main/kotlin/policy/Foreign.kt"),"package policy\\nobject Foreign\\n");Files.writeString(rules,',
            )
          : original.replace(
              /Files.writeString\(root.resolve\("src\/main\/kotlin\/policy\/GeneratedMarker.kt"\).*?;/,
              "",
            );
      assert.notEqual(body, original);
      await writeFile(
        path.join(f.root, "generators/BuildKotlinGenerator.java"),
        body,
      );
      const check = (
        await validate(f.root, { trusted: true, timeoutMs: 120000 })
      ).checks[0]!;
      assert.equal(check.status, "error", JSON.stringify(check));
      assert.equal(check.processes[0]!.exitCode, 2);
      await assert.rejects(access(f.marker));
      assert.equal(
        await access(path.join(f.root, "src/main/kotlin/policy/Rules.kt")).then(
          () => true,
          () => false,
        ),
        false,
      );
    }
  },
);
test(
  "mixed Kotlin permits declared source-only script-only and generated-only cohorts",
  { ...options, timeout: 240000 },
  async (t) => {
    const base = {
      profile: "linux-arm64-mixed-generated-script-v1",
      javaSources: [],
      scripts: [],
      generators: [],
    };
    const ordinary = await kotlinFixture(t);
    await writeFile(
      path.join(ordinary, "checktrail.kotlin.json"),
      JSON.stringify({ ...kotlinConfig, extensions: base }),
    );
    assert.equal(
      (await validate(ordinary, { trusted: true, timeoutMs: 120000 }))
        .checks[0]!.status,
      "passed",
    );
    const script = await kotlinFixture(t);
    for (const name of ["Original.kt", "Another with spaces.kt"])
      await rm(path.join(script, name));
    const marker = path.join(script, ".checktrail/script-executed");
    await writeFile(
      path.join(script, "Only.kts"),
      "val original: Int = 5\njava.nio.file.Files.writeString(java.nio.file.Path.of(" +
        JSON.stringify(marker) +
        '), "executed")\n',
    );
    await writeFile(
      path.join(script, "checktrail.kotlin.json"),
      JSON.stringify({
        ...kotlinConfig,
        extensions: { ...base, scripts: ["Only.kts"] },
      }),
    );
    const scriptResult = (
      await validate(script, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(scriptResult.status, "passed", JSON.stringify(scriptResult));
    assert.equal(
      JSON.parse(scriptResult.processes[0]!.stdout).kotlin.native.sources
        .length,
      1,
    );
    await assert.rejects(access(marker));
    const generated = await mixedKotlinFixture(t);
    for (const name of [
      "producer/JavaProducer.java",
      "producer/KotlinProducer.kt",
      "scripts/Compile only.kts",
    ])
      await rm(path.join(generated.root, name));
    await writeFile(
      path.join(generated.root, "checktrail.kotlin.json"),
      JSON.stringify({
        ...mixedKotlinConfig,
        extensions: {
          ...base,
          generators: mixedKotlinConfig.extensions.generators,
        },
      }),
    );
    const result = (
      await validate(generated.root, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(
      JSON.parse(result.processes[0]!.stdout).generatedClasses.length,
      2,
    );
  },
);
test(
  "mixed Kotlin binds Java and Kotlin class targets to each declared release",
  { ...options, timeout: 240000 },
  async (t) => {
    for (const jvmTarget of ["17", "21", "25"]) {
      const f = await mixedKotlinFixture(t);
      await writeFile(
        path.join(f.root, "checktrail.kotlin.json"),
        JSON.stringify({ ...mixedKotlinConfig, jvmTarget }),
      );
      const check = (
        await validate(f.root, { trusted: true, timeoutMs: 120000 })
      ).checks[0]!;
      assert.equal(check.status, "passed", JSON.stringify(check));
      const packet = JSON.parse(check.processes[0]!.stdout),
        major = Number(jvmTarget) + 44;
      assert.ok(
        packet.java.classes.every(
          (c: { classMajor: number }) => c.classMajor === major,
        ),
      );
      assert.ok(
        packet.kotlin.native.outputs
          .filter((c: { file: string }) => c.file.endsWith(".class"))
          .every((c: { classMajor: number }) => c.classMajor === major),
      );
      await assert.rejects(access(f.marker));
    }
  },
);

test(
  "mixed Kotlin rejects generator changes to staged libraries and original observer classes",
  { ...options, timeout: 240000 },
  async (t) => {
    for (const relative of [
      "kotlinc/lib/kotlin-script-runtime.jar",
      "classes/VerifierKotlin.class",
      "original-plugin.jar",
    ]) {
      const f = await mixedKotlinFixture(t);
      const body = kotlinGenerator().replace(
        "Path root=",
        "Files.write(Path.of(args[0]).getParent().getParent().resolve(" +
          JSON.stringify(relative) +
          "),new byte[]{0},StandardOpenOption.APPEND);Path root=",
      );
      await writeFile(
        path.join(f.root, "generators/BuildKotlinGenerator.java"),
        body,
      );
      const check = (
        await validate(f.root, { trusted: true, timeoutMs: 120000 })
      ).checks[0]!;
      assert.equal(check.status, "error", JSON.stringify(check));
      assert.equal(check.processes[0]!.exitCode, 2);
      assert.match(
        check.processes[0]!.stderr,
        /Staged Kotlin artifacts changed/,
      );
      await assert.rejects(access(f.marker));
    }
  },
);
