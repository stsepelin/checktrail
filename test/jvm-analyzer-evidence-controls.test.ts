import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Check, ProcessResult } from "../src/types.js";
import {
  spotbugsReplay,
  spotbugsFaults,
} from "./spotbugs-extension-evidence-fixture.js";
import {
  detektExtensionsEvidence,
  detektExtensionsEvidenceSchema,
} from "../src/detekt-extensions-evidence.js";
import type { z } from "zod";
const file = process.env.CHECKTRAIL_JVM_ANALYZER_GUARD_RECEIPT;
const receipts = file
  ? (JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      { root: string; check: Check; process: ProcessResult }
    >)
  : undefined;
for (const [name, mutate] of spotbugsFaults)
  test("analyzer guard checks " + name, { skip: !receipts }, () => {
    const f = receipts!.spotbugs!,
      good = JSON.parse(f.process.stdout),
      changed = structuredClone(good);
    assert.equal(
      spotbugsReplay(f.check, f.process, f.root, good, structuredClone(good))
        .status,
      "failed",
    );
    mutate(changed);
    const result = spotbugsReplay(f.check, f.process, f.root, good, changed);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.findingsComplete, false);
  });
type Typed = z.infer<typeof detektExtensionsEvidenceSchema>;
const faults: Array<[string, (d: Typed) => void]> = [
  [
    "full native rule implementation",
    (d) => {
      d.native!.rules[0]!.className = "original.UnselectedRule";
    },
  ],
  [
    "full native rule origin",
    (d) => {
      d.native!.rules[0]!.origin = "file:/unselected.jar";
    },
  ],
  [
    "full native source symbol",
    (d) => {
      d.native!.typed[0]!.symbols[0] = "LIBRARY";
    },
  ],
  [
    "full unknown annotation",
    (d) => {
      d.native!.typed[0]!.unknownAnnotations = 1;
    },
  ],
  [
    "full resolved suppression",
    (d) => {
      d.native!.typed[0]!.annotations.push("kotlin.Suppress");
    },
  ],
  [
    "full SDK modules",
    (d) => {
      d.native!.typed.forEach((t) => t.sdk.pop());
    },
  ],
  [
    "full classpath roots",
    (d) => {
      d.native!.typed[0]!.roots.push(d.native!.typed[0]!.roots[0]!);
    },
  ],
  [
    "full physical configuration",
    (d) => {
      d.projectConfiguration.sha256 = "0".repeat(64);
    },
  ],
];
for (const [name, mutate] of faults)
  test("analyzer guard checks " + name, { skip: !receipts }, () => {
    const f = receipts!.detekt!,
      good = detektExtensionsEvidenceSchema.parse(JSON.parse(f.process.stdout));
    assert.equal(
      detektExtensionsEvidence(f.check, [f.process], f.root).status,
      "passed",
    );
    mutate(good);
    const result = detektExtensionsEvidence(
      f.check,
      [{ ...f.process, stdout: JSON.stringify(good) }],
      f.root,
    );
    assert.equal(result.status, "inconclusive");
    assert.equal(result.findingsComplete, false);
  });
