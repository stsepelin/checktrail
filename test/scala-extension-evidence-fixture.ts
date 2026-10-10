import assert from "node:assert/strict";
import type { Check, CheckResult, ProcessResult } from "../src/types.js";
import type { z } from "zod";
import { scalaExtensionEvidenceSchema } from "../src/scala-extension-evidence.js";
import { scalaHash } from "../src/scala-archive.js";
import {
  captureProcessOutput,
  parseCapturedProcessOutput,
} from "../src/process-output.js";
type Packet = z.infer<typeof scalaExtensionEvidenceSchema>;
export const nativeCheck = (c: CheckResult): Check => ({
  id: c.id,
  adapter: c.adapter,
  project: c.project,
  scope: c.scope,
  kind: "analysis",
  reason: "Selected native Scala invocation",
  parser: "scala-json",
  commands: c.processes.map((p) => p.command),
});
export function coherent(process: ProcessResult, mutate: (p: Packet) => void) {
  const p = scalaExtensionEvidenceSchema.parse(JSON.parse(process.stdout));
  const oldStages = p.stages.map((s) =>
    Buffer.from(
      parseCapturedProcessOutput(s.evidence.nativeOutput).stdout.base64,
      "base64",
    ).toString("utf8"),
  );
  mutate(p);
  let mirrored = process.stderr;
  const replaceRaw = (old: string, updated: string) => {
    const matching = p.invocations.filter((i) => i.stdout === old);
    assert.equal(
      matching.length,
      1,
      "One native invocation must own the raw record",
    );
    const i = matching[0]!;
    assert.equal(
      mirrored.split(old).length,
      2,
      "One raw record must occur in the live mirrored stream",
    );
    mirrored = mirrored.replace(old, updated);
    i.stdout = updated;
    i.stdoutBytes = Buffer.byteLength(updated);
    i.stdoutSha256 = scalaHash(updated);
  };
  for (const [n, s] of p.stages.entries()) {
    const updated = JSON.stringify(s.evidence.native) + "\n";
    replaceRaw(oldStages[n]!, updated);
    s.evidence.nativeOutput = captureProcessOutput(
      Buffer.from(updated),
      Buffer.alloc(0),
      Buffer.byteLength(updated),
      true,
    );
  }
  for (const i of [...p.invocations]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(i.stdout);
    } catch {
      continue;
    }
    if (Array.isArray(parsed))
      replaceRaw(i.stdout, JSON.stringify(p.generatedClasses) + "\n");
    else if (
      parsed &&
      typeof parsed === "object" &&
      "schemaVersion" in parsed &&
      "sources" in parsed
    )
      replaceRaw(i.stdout, JSON.stringify(p.java) + "\n");
  }
  p.mirrored = captureProcessOutput(
    Buffer.alloc(0),
    Buffer.from(mirrored),
    Buffer.byteLength(mirrored),
    true,
  );
  const stdout = JSON.stringify(p);
  return {
    ...process,
    stdout,
    stderr: mirrored,
    outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(mirrored),
    capturedOutput: captureProcessOutput(
      Buffer.from(stdout),
      Buffer.from(mirrored),
      Buffer.byteLength(stdout) + Buffer.byteLength(mirrored),
      true,
    ),
  };
}
