import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Check, ProcessResult } from "../src/types.js";
import type { z } from "zod";
import { evaluate } from "../src/evidence.js";
import { scalaExtensionEvidenceSchema } from "../src/scala-extension-evidence.js";
import { scalaHash } from "../src/scala-archive.js";
import { captureProcessOutput } from "../src/process-output.js";
import { validate } from "../src/engine.js";
import { scalaFixture, scalaConfig, nativeOptions } from "./scala-fixture.js";

test(
  "mixed Scala retains source warnings when Java Werror fails compilation",
  nativeOptions,
  async (t) => {
    const config = {
      ...scalaConfig,
      warningsAsErrors: true,
      extensions: {
        profile: "linux-arm64-scala3-mixed-generated-script-v1",
        javaSources: ["Warnings.java"],
        scripts: [],
        generators: [],
        stages: [
          {
            id: "source",
            sources: ["Original.scala", "Another with spaces.scala"],
          },
        ],
      },
    };
    const root = await scalaFixture(t, {
      "checktrail.scala.json": JSON.stringify(config),
      "Warnings.java":
        "import java.util.List;public class Warnings {public static int value(){List raw = List.of(1);return raw.size();}}\n",
      "build/classes/preserve": "keep",
    });
    const check = (await validate(root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    const packet = JSON.parse(check.processes[0]!.stdout);
    assert.equal(packet.stages[0].evidence.native.errors, 0);
    assert.equal(packet.java.success, false);
    assert.equal(
      packet.java.diagnostics.filter(
        (d: { code: string }) => d.code === "compiler.err.warnings.and.werror",
      ).length,
      1,
    );
    assert.ok(
      packet.java.diagnostics.some(
        (d: { file: string | null; kind: string }) =>
          d.file?.endsWith("/Warnings.java") && d.kind === "WARNING",
      ),
    );
    assert.equal(check.status, "failed");
    assert.equal(check.findingsComplete, false);
    const nativeCheck: Check = {
      id: check.id,
      adapter: check.adapter,
      project: check.project,
      scope: check.scope,
      kind: "analysis",
      reason: "Fresh mixed Scala warning evidence",
      parser: "scala-json",
      commands: check.processes.map((p) => p.command),
    };
    const faults: [
      string,
      (p: z.infer<typeof scalaExtensionEvidenceSchema>) => void,
    ][] = [
      [
        "unknown global code",
        (p) => {
          p.java!.diagnostics.find(
            (d) => d.code === "compiler.err.warnings.and.werror",
          )!.code = "compiler.err.unknown";
        },
      ],
      [
        "missing source warnings",
        (p) => {
          p.java!.diagnostics = p.java!.diagnostics.filter(
            (d) => d.code === "compiler.err.warnings.and.werror",
          );
        },
      ],
      [
        "duplicate global summary",
        (p) => {
          p.java!.diagnostics.push({
            ...p.java!.diagnostics.find(
              (d) => d.code === "compiler.err.warnings.and.werror",
            )!,
          });
        },
      ],
      [
        "unrecognized global position",
        (p) => {
          p.java!.diagnostics.find(
            (d) => d.code === "compiler.err.warnings.and.werror",
          )!.line = 0;
        },
      ],
      [
        "foreign warning address",
        (p) => {
          p.java!.diagnostics.find((d) => d.kind === "WARNING")!.file =
            path.join(p.snapshot, "Foreign.java");
        },
      ],
    ];
    faults.push([
      "foreign summary address",
      (p) => {
        p.java!.diagnostics.find(
          (d) => d.code === "compiler.err.warnings.and.werror",
        )!.file = path.join(p.snapshot, "Foreign.java");
      },
    ]);
    assert.equal(
      evaluate(
        nativeCheck,
        [
          coherentJava(check.processes[0]!, (p) => {
            p.java!.diagnostics.find(
              (d) => d.code === "compiler.err.warnings.and.werror",
            )!.file = null;
          }),
        ],
        root,
      ).status,
      "failed",
      "Positionless native warning summary also permits a null source",
    );
    for (const [name, mutate] of faults) {
      assert.equal(
        evaluate(nativeCheck, [coherentJava(check.processes[0]!, mutate)], root)
          .status,
        "inconclusive",
        name,
      );
    }
    assert.ok(
      check.findings?.some(
        (f) =>
          f.file === "Warnings.java" &&
          f.line === 1 &&
          f.level === "warning" &&
          f.ruleId === "javac/compiler.warn.raw.class.use",
      ),
    );
    assert.equal(
      await readFile(path.join(root, "build/classes/preserve"), "utf8"),
      "keep",
    );
    await assert.rejects(access(path.join(root, "Warnings.class")));
    await writeFile(
      path.join(root, "checktrail.scala.json"),
      JSON.stringify({ ...config, warningsAsErrors: false }),
    );
    const permitted = (
      await validate(root, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(permitted.status, "passed");
    assert.equal(permitted.findingsComplete, true);
    assert.ok(
      permitted.findings?.some(
        (f) =>
          f.ruleId === "javac/compiler.warn.raw.class.use" &&
          f.level === "warning" &&
          f.file === "Warnings.java",
      ),
    );
  },
);

function coherentJava(
  process: ProcessResult,
  mutate: (p: z.infer<typeof scalaExtensionEvidenceSchema>) => void,
): ProcessResult {
  const p = scalaExtensionEvidenceSchema.parse(JSON.parse(process.stdout));
  mutate(p);
  const records = p.invocations.filter((i) => {
    try {
      const record = JSON.parse(i.stdout);
      return record?.schemaVersion === 1 && Array.isArray(record.sources);
    } catch {
      return false;
    }
  });
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(process.stderr.split(record.stdout).length, 2);
  const raw = JSON.stringify(p.java) + "\n";
  const stderr = process.stderr.replace(record.stdout, raw);
  record.stdout = raw;
  record.stdoutBytes = Buffer.byteLength(raw);
  record.stdoutSha256 = scalaHash(raw);
  p.mirrored = captureProcessOutput(
    Buffer.alloc(0),
    Buffer.from(stderr),
    Buffer.byteLength(stderr),
    true,
  );
  const stdout = JSON.stringify(p),
    outputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  return {
    ...process,
    stdout,
    stderr,
    outputBytes,
    capturedOutput: captureProcessOutput(
      Buffer.from(stdout),
      Buffer.from(stderr),
      outputBytes,
      true,
    ),
  };
}
