import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  dotnetTestEvidence,
  dotnetTestPacketSchema,
} from "../src/dotnet-test-evidence.js";
import { createPlan } from "../src/engine.js";
import { expect, native, run } from "./dotnet-test-controls.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";

test(
  "native .NET empty discovery and custom names without method provenance stay incomplete",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t),
      file = "CSharpTests/CounterTests.cs",
      original = await readFile(path.join(root, file), "utf8");
    try {
      await writeFile(
        path.join(root, file),
        original.replace("[TestCase(-1)]", "").replace("[TestCase(2)]", ""),
      );
      const empty = (await run(root)).checks[0]!;
      expect(empty, "inconclusive");
      assert.equal(empty.findingsComplete, false);
      const packet = dotnetTestPacketSchema.parse(
        JSON.parse(empty.processes[0]!.stdout),
      );
      assert.equal(
        packet.runs[0]!.discoveryEvents.find(
          (e) => e.type === "discoveryFinished",
        )!.total,
        0,
        "The native empty discovery was retained",
      );
      await writeFile(
        path.join(root, file),
        original.replace(
          "[TestCase(-1)]",
          '[TestCase(-1, TestName = "Original custom case")]',
        ),
      );
      const custom = (await run(root)).checks[0]!;
      expect(custom, "passed");
      assert.equal(custom.findingsComplete, true);
      const check = (await createPlan(root)).plan.checks[0]!,
        process = custom.processes[0]!,
        missing = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
      missing.runs[0]!.nunit = null;
      const unsupported = dotnetTestEvidence(check, [
        { ...process, stdout: JSON.stringify(missing) },
      ]);
      assert.equal(unsupported.status, "inconclusive");
      assert.equal(unsupported.findingsComplete, false);
    } finally {
      await writeFile(path.join(root, file), original);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);
