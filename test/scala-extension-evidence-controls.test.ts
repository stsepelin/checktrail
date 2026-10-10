import assert from "node:assert/strict";
import { readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
import type { z } from "zod";
import { scalaExtensionEvidenceSchema } from "../src/scala-extension-evidence.js";
import { coherent } from "./scala-extension-evidence-fixture.js";
const receipt = process.env.CHECKTRAIL_SCALA_GUARD_RECEIPT,
  options = {
    skip: receipt
      ? false
      : "Fresh captured native Scala extension fixture unavailable",
    timeout: 30000,
  };
type Packet = z.infer<typeof scalaExtensionEvidenceSchema>;
async function captured() {
  const d = JSON.parse(await readFile(receipt!, "utf8")) as {
    root: string;
    check: Check;
    process: ProcessResult;
  };
  assert.equal(evaluate(d.check, [d.process], d.root).status, "passed");
  return d;
}
test(
  "mixed Scala guard checks current original Java bytes",
  options,
  async () => {
    const d = await captured(),
      file = path.join(d.root, "producer/Producer.java"),
      original = await readFile(file, "utf8");
    try {
      await writeFile(file, original.replace("return 4;", "return 5;"));
      assert.equal(
        evaluate(d.check, [d.process], d.root).status,
        "inconclusive",
      );
    } finally {
      await writeFile(file, original);
    }
  },
);
test(
  "mixed Scala guard checks current compiler declaration",
  options,
  async () => {
    const d = await captured(),
      file = path.join(d.root, "checktrail.scala.json"),
      original = await readFile(file);
    try {
      const c = JSON.parse(original.toString());
      c.warningsAsErrors = true;
      await writeFile(file, JSON.stringify(c));
      assert.equal(
        evaluate(d.check, [d.process], d.root).status,
        "inconclusive",
      );
    } finally {
      await writeFile(file, original);
    }
  },
);
test("mixed Scala guard checks current archive bytes", options, async () => {
  const d = await captured(),
    h = await open(path.join(d.root, ".checktrail/scala.zip"), "r+"),
    original = Buffer.alloc(1);
  try {
    await h.read(original, 0, 1, 0);
    await h.write(Buffer.from([original[0]! ^ 1]), 0, 1, 0);
    assert.equal(evaluate(d.check, [d.process], d.root).status, "inconclusive");
  } finally {
    await h.write(original, 0, 1, 0);
    await h.close();
  }
});
const faults: [string, (p: Packet) => void][] = [
  [
    "generator input",
    (p) => {
      p.generated[0]!.sourceSha256 = "0".repeat(64);
    },
  ],
  [
    "generated class name",
    (p) => {
      p.generatedClasses[0]!.className = "policy.Foreign";
    },
  ],
  [
    "generated class source origin",
    (p) => {
      p.generatedClasses[0]!.sourceFile = "Foreign.scala";
    },
  ],
  [
    "generated physical class hash",
    (p) => {
      p.generatedClasses[0]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "Java parse participation",
    (p) => {
      (p.java!.sources[0] as unknown as { parsed: number }).parsed = 0;
    },
  ],
  [
    "Java class target",
    (p) => {
      p.java!.classes[0]!.classMajor = 61;
    },
  ],
  [
    "Java physical class hash",
    (p) => {
      p.java!.classes[0]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "resolved Java suppression",
    (p) => {
      p.java!.sources[0]!.annotations = ["java.lang.SuppressWarnings"];
    },
  ],
  [
    "native feature phase",
    (p) => {
      p.stages[0]!.evidence.native!.featureStages = 0;
    },
  ],
  [
    "native source feature visit",
    (p) => {
      p.stages[0]!.evidence.native!.sources[0]!.featureVisits = 0;
    },
  ],
];
for (const [name, mutate] of faults)
  test("mixed Scala guard checks " + name, options, async () => {
    const d = await captured();
    assert.equal(
      evaluate(d.check, [coherent(d.process, mutate)], d.root).status,
      "inconclusive",
      name,
    );
  });
