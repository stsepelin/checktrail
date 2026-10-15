import assert from "node:assert/strict";
import { readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import { kotlinExtensionEvidenceSchema } from "../src/kotlin-extension-evidence.js";
import { captureProcessOutput } from "../src/process-output.js";
import { kotlinHash } from "../src/kotlin-archive.js";
import type { Check, ProcessResult } from "../src/types.js";
import type { z } from "zod";
const receipt = process.env.CHECKTRAIL_KOTLIN_GUARD_RECEIPT;
const options = {
  skip: receipt
    ? false
    : "Fresh captured native Kotlin extension fixture unavailable",
  timeout: 30000,
};
type Packet = z.infer<typeof kotlinExtensionEvidenceSchema>;
async function captured() {
  const data = JSON.parse(await readFile(receipt!, "utf8")) as {
    root: string;
    check: Check;
    process: ProcessResult;
  };
  assert.equal(
    evaluate(data.check, [data.process], data.root).status,
    "passed",
  );
  return data;
}
function coherent(
  data: Awaited<ReturnType<typeof captured>>,
  change: (packet: Packet) => void,
) {
  const packet = kotlinExtensionEvidenceSchema.parse(
    JSON.parse(data.process.stdout),
  );
  change(packet);
  let mirrored = data.process.stderr;
  for (const invocation of packet.invocations) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(invocation.stdout);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) parsed = packet.generatedClasses;
    else if (parsed && typeof parsed === "object" && "schemaVersion" in parsed)
      parsed = packet.java;
    else continue;
    const updated = JSON.stringify(parsed) + "\n";
    assert.equal(
      mirrored.split(invocation.stdout).length,
      2,
      "Exact native raw record must occur once in the mirrored stream",
    );
    mirrored = mirrored.replace(invocation.stdout, updated);
    invocation.stdout = updated;
    invocation.stdoutBytes = Buffer.byteLength(updated);
    invocation.stdoutSha256 = kotlinHash(updated);
  }
  packet.mirrored = captureProcessOutput(
    Buffer.alloc(0),
    Buffer.from(mirrored),
    Buffer.byteLength(mirrored),
    true,
  );
  const stdout = JSON.stringify(packet);
  return {
    ...data.process,
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
test(
  "mixed Kotlin guard checks current original Java bytes",
  options,
  async () => {
    const d = await captured(),
      file = path.join(d.root, "producer/JavaProducer.java"),
      original = await readFile(file, "utf8");
    try {
      await writeFile(file, original.replace("return 5;", "return 6;"));
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
  "mixed Kotlin guard checks current compiler declaration",
  options,
  async () => {
    const d = await captured(),
      file = path.join(d.root, "checktrail.kotlin.json"),
      original = await readFile(file);
    try {
      const config = JSON.parse(original.toString("utf8"));
      config.warningsAsErrors = true;
      await writeFile(file, JSON.stringify(config));
      assert.equal(
        evaluate(d.check, [d.process], d.root).status,
        "inconclusive",
      );
    } finally {
      await writeFile(file, original);
    }
  },
);
test("mixed Kotlin guard checks current archive bytes", options, async () => {
  const d = await captured(),
    file = path.join(d.root, ".checktrail/kotlin.zip"),
    handle = await open(file, "r+"),
    original = Buffer.alloc(1);
  try {
    await handle.read(original, 0, 1, 0);
    await handle.write(Buffer.from([original[0]! ^ 1]), 0, 1, 0);
    assert.equal(evaluate(d.check, [d.process], d.root).status, "inconclusive");
  } finally {
    await handle.write(original, 0, 1, 0);
    await handle.close();
  }
});
const faults: [string, (packet: Packet) => void][] = [
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
      p.generatedClasses[0]!.sourceFile = "Foreign.kt";
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
      p.java!.classes[0]!.classMajor = 69;
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
];
for (const [name, mutate] of faults)
  test("mixed Kotlin guard checks " + name, options, async () => {
    const d = await captured();
    assert.equal(
      evaluate(d.check, [coherent(d, mutate)], d.root).status,
      "inconclusive",
      name,
    );
  });
