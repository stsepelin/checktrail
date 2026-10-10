import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { captureProcessOutput } from "../src/process-output.js";
import { scala2EvidenceSchema } from "../src/scala2-evidence.js";
import {
  options,
  scala2Fixture,
  scala2Config,
  mixedScalaFixture,
  mixedScalaConfig,
  scalaGenerator,
} from "./scala-extensions-fixture.js";
import { nativeCheck } from "./scala-extension-evidence-fixture.js";
const warning =
  "object Original {def number(x:Option[Int]):Int=x match {case Some(n)=>n}}\n";
test(
  "Scala 2 retains native source warnings and the exact warning escalation summary without admitting unknown globals",
  options,
  async (t) => {
    const root = await scala2Fixture(t, warning);
    let c = (await validate(root, { trusted: true })).checks[0]!;
    assert.equal(c.status, "passed", JSON.stringify(c));
    assert.ok(
      c.findings!.some(
        (f) => f.file === "Original.scala" && f.level === "warning",
      ),
    );
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify({ ...scala2Config, warningsAsErrors: true }),
    );
    c = (await validate(root, { trusted: true })).checks[0]!;
    assert.equal(c.status, "failed", JSON.stringify(c));
    assert.equal(c.findingsComplete, false);
    assert.ok(
      c.findings!.some(
        (f) => f.file === "Original.scala" && f.level === "warning",
      ),
    );
    const p = scala2EvidenceSchema.parse(JSON.parse(c.processes[0]!.stdout));
    assert.equal(p.native.errors, 1);
    assert.equal(p.native.warnings, 1);
    assert.ok(
      p.native.messages.some(
        (m) =>
          m.file === null &&
          m.message === "No warnings can be incurred under -Werror.",
      ),
    );
    for (const fault of [
      "changed-summary",
      "no-warnings",
      "duplicate-summary",
    ]) {
      const q = structuredClone(p),
        global = q.native.messages.find((m) => m.file === null)!;
      if (fault === "changed-summary") global.message = "unknown global error";
      else if (fault === "no-warnings") {
        q.native.messages = q.native.messages.filter((m) => m.file === null);
        q.native.warnings = 0;
      } else {
        q.native.messages.push(structuredClone(global));
        q.native.errors++;
      }
      const raw = JSON.stringify(q.native) + "\n";
      q.nativeOutput = captureProcessOutput(
        Buffer.from(raw),
        Buffer.alloc(0),
        Buffer.byteLength(raw),
        true,
      );
      q.invocations[1]!.stdoutBytes = Buffer.byteLength(raw);
      q.mirroredOutput = captureProcessOutput(
        Buffer.alloc(0),
        Buffer.from(raw),
        Buffer.byteLength(raw),
        true,
      );
      const stdout = JSON.stringify(q);
      assert.equal(
        evaluate(
          nativeCheck(c),
          [
            {
              ...c.processes[0]!,
              stdout,
              stderr: raw,
              capturedOutput: captureProcessOutput(
                Buffer.from(stdout),
                Buffer.from(raw),
                Buffer.byteLength(stdout) + Buffer.byteLength(raw),
                true,
              ),
            },
          ],
          root,
        ).status,
        "inconclusive",
        fault,
      );
    }
  },
);
test(
  "Scala 3 compiles native quoted staging and byte-pinned staging API references while leaving application initializers unexecuted",
  options,
  async (t) => {
    const f = await mixedScalaFixture(t),
      file = "producer/Staging.scala";
    await writeFile(
      path.join(f.root, file),
      "package demo\nimport scala.quoted.*\nobject Staging { val compiler=scala.quoted.staging.Compiler.make(getClass.getClassLoader); def code(using Quotes):Expr[Int]='{ 1+2 } }\n",
    );
    await writeFile(
      path.join(f.root, "checktrail.scala.json"),
      JSON.stringify({
        ...mixedScalaConfig,
        extensions: {
          ...mixedScalaConfig.extensions,
          stages: [
            {
              ...mixedScalaConfig.extensions.stages[0],
              sources: [
                ...mixedScalaConfig.extensions.stages[0]!.sources,
                file,
              ],
            },
            mixedScalaConfig.extensions.stages[1],
          ],
        },
      }),
    );
    const c = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(c.status, "passed", JSON.stringify(c));
    const p = JSON.parse(c.processes[0]!.stdout);
    assert.ok(
      p.stages[0].evidence.native.sources.some(
        (s: { file: string; staging: boolean }) =>
          s.file.endsWith("Staging.scala") && s.staging,
      ),
    );
    assert.equal(await readFile(f.macroMarker, "utf8"), "compile-time");
    await assert.rejects(access(f.marker), { code: "ENOENT" });
  },
);
test(
  "Scala extension generators cannot replace the staged compiler and all declared JVM target outputs retain native class origins",
  options,
  async (t) => {
    const f = await mixedScalaFixture(t);
    await writeFile(
      path.join(f.root, "generators/BuildScalaGenerator.java"),
      scalaGenerator().replace(
        "java.nio.file.Files.writeString(p,",
        'java.nio.file.Path lib=java.nio.file.Path.of(a[0]).getParent().getParent().resolve("scala/lib/scala3-compiler_3-3.9.0.jar");java.nio.file.Files.writeString(lib,"replaced");java.nio.file.Files.writeString(p,',
      ),
    );
    const c = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(c.status, "error", JSON.stringify(c));
    assert.match(c.processes[0]!.stderr, /Staged Scala artifacts changed/);
    await assert.rejects(access(f.marker), { code: "ENOENT" });
    const root = await scala2Fixture(
      t,
      "package demo\nclass Original {def answer:Int=4}\n",
    );
    for (const target of ["17", "21", "25"]) {
      await writeFile(
        path.join(root, "checktrail.scala.json"),
        JSON.stringify({ ...scala2Config, jvmTarget: target }),
      );
      const r = (await validate(root, { trusted: true })).checks[0]!;
      assert.equal(r.status, "passed", JSON.stringify(r));
      const p = JSON.parse(r.processes[0]!.stdout);
      assert.ok(p.native.outputs.length > 0);
      assert.ok(
        p.native.outputs.every(
          (o: { classMajor: number; sourceFile: string }) =>
            o.classMajor === Number(target) + 44 &&
            o.sourceFile === "Original.scala",
        ),
      );
    }
  },
);
