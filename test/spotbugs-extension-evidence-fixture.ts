import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { Check, ProcessResult } from "../src/types.js";
import { spotbugsExtensionsEvidence } from "../src/spotbugs-extensions-evidence.js";
import { spotbugsHash } from "../src/spotbugs-extensions-inputs.js";
import { captureProcessOutput } from "../src/process-output.js";
import { spotbugsExtensionsEvidenceSchema } from "../src/spotbugs-extensions-contract.js";
export type Packet = z.infer<typeof spotbugsExtensionsEvidenceSchema>;
export function spotbugsReplay(
  check: Check,
  process: ProcessResult,
  root: string,
  good: Packet,
  d: Packet,
  raw = true,
) {
  if (raw) {
    const oldPackets = [
        ...good.stages.map((s) => s.compiler),
        good.modules,
        good.analysis,
      ],
      newPackets = [...d.stages.map((s) => s.compiler), d.modules, d.analysis];
    for (const invocation of d.invocations) {
      let value: unknown;
      try {
        value = JSON.parse(invocation.stdout);
      } catch {
        continue;
      }
      const index = oldPackets.findIndex((old) =>
        isDeepStrictEqual(old, value),
      );
      if (index < 0) continue;
      invocation.stdout = JSON.stringify(newPackets[index]);
      invocation.stdoutBytes = Buffer.byteLength(invocation.stdout);
      invocation.stdoutSha256 = spotbugsHash(invocation.stdout);
    }
  }
  const stderr = d.invocations.map((i) => i.stdout + i.stderr).join("");
  d.mirrored = captureProcessOutput(
    Buffer.alloc(0),
    Buffer.from(stderr),
    Buffer.byteLength(stderr),
    true,
  );
  const stdout = JSON.stringify(d),
    bytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  return spotbugsExtensionsEvidence(
    check,
    [
      {
        ...process,
        stdout,
        stderr,
        outputBytes: bytes,
        capturedOutput: captureProcessOutput(
          Buffer.from(stdout),
          Buffer.from(stderr),
          bytes,
          true,
        ),
      },
    ],
    root,
  );
}
export const spotbugsFaults: Array<[string, (d: Packet) => void]> = [
  [
    "module analyzed name",
    (d) => {
      d.stages[0]!.compiler.sources.find((s) =>
        s.file.endsWith("module-info.java"),
      )!.analyzed = ["foreign.module.module-info"];
    },
  ],
  [
    "module descriptor identity",
    (d) => {
      d.modules[1]!.name = "foreign.application";
    },
  ],
  [
    "module dependency inventory",
    (d) => {
      d.modules[1]!.requires.pop();
    },
  ],
  [
    "nested binary source attribution",
    (d) => {
      d.stages[1]!.compiler.classes.find((c) =>
        c.name.endsWith("$Nested"),
      )!.sourceFile = "Other.java";
    },
  ],
  [
    "post-compilation class digest",
    (d) => {
      const c = d.stages[1]!.compiler.classes.find((c) =>
        c.name.endsWith("$Nested"),
      )!;
      c.sha256 = "0".repeat(64);
      d.outputsAfter.find((p) => p.file === c.output)!.sha256 = "1".repeat(64);
    },
  ],
  [
    "original source digest",
    (d) => {
      d.original[0]!.sha256 = "0".repeat(64);
      d.after[0]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "generated payload bytes",
    (d) => {
      d.payloads[0]!.base64 = Buffer.from("foreign").toString("base64");
    },
  ],
  [
    "generated source owner",
    (d) => {
      d.generated[0]!.source = "generators/Other.java";
    },
  ],
  [
    "native plugin code origin",
    (d) => {
      d.analysis!.provenance.find(
        (p) => p.plugin === "checktrail.synthetic.rules.v1",
      )!.origin = "file:/unselected.jar";
    },
  ],
  [
    "native core code origin",
    (d) => {
      d.analysis!.provenance[0]!.origin = "file:/unselected.jar";
    },
  ],
  [
    "native disabled prerequisite preference",
    (d) => {
      d.analysis!.provenance.find((p) =>
        p.detector.endsWith(".NoteNonnullReturnValues"),
      )!.enabled = true;
      d.analysis!.detectors.push(
        "edu.umd.cs.findbugs.detect.NoteNonnullReturnValues",
      );
    },
  ],
  [
    "missing effective prerequisite",
    (d) => {
      d.analysis!.effective = d.analysis!.effective.map((pass) =>
        pass.filter((name) => !name.endsWith(".NoteNonnullReturnValues")),
      );
    },
  ],
  [
    "missing effective plugin",
    (d) => {
      d.analysis!.effective = d.analysis!.effective.map((pass) =>
        pass.filter((name) => name !== "original.OriginalDetector"),
      );
    },
  ],
  [
    "missing rule provider",
    (d) => {
      d.analysis!.patterns.pop();
    },
  ],
  [
    "native finding provider",
    (d) => {
      d.analysis!.bugs[0]!.provider = "foreign.rules.v1";
    },
  ],
  [
    "native finding identifier boundary",
    (d) => {
      d.analysis!.bugs[0]!.type = "CHECKTRAIL_UNSAFE_VALUE_EXTRA";
    },
  ],
  [
    "native finding line bound",
    (d) => {
      d.analysis!.bugs[0]!.endLine = 100;
    },
  ],
  [
    "library findings are not selected",
    (d) => {
      d.analysis!.bugs[0]!.className = "provider.Library";
      d.analysis!.bugs[0]!.source = "Library.java";
    },
  ],
  [
    "library stats are not selected",
    (d) => {
      d.analysis!.stats[0] = {
        name: "provider.Library",
        source: "Library.java",
      };
    },
  ],
  [
    "prepass lacks selected application class",
    (d) => {
      const p = d.analysis!.passes[0]!;
      p.classes = p.classes.filter((n) => n !== "demo.Original$Nested");
      p.expected = p.finished = p.classes.length;
      d.analysis!.predicted[0] = p.classes.length;
    },
  ],
  [
    "late pass includes library",
    (d) => {
      const p = d.analysis!.passes[1]!;
      p.classes.push("provider.Library");
      p.expected = p.finished = p.classes.length;
      d.analysis!.predicted[1] = p.classes.length;
    },
  ],
  [
    "duplicate prepass class",
    (d) => {
      const p = d.analysis!.passes[0]!;
      p.classes.push(p.classes[0]!);
      p.expected = p.finished = p.classes.length;
      d.analysis!.predicted[0] = p.classes.length;
    },
  ],
  [
    "native compiler argv identity",
    (d) => {
      d.invocations.find((i) =>
        i.args.includes("VerifierSpotbugsCompiler"),
      )!.args[0] = "-Xmx256m";
    },
  ],
  [
    "native raw stream digest",
    (d) => {
      d.invocations[0]!.stdoutSha256 = "0".repeat(64);
    },
  ],
];
