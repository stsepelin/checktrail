import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lifecycleExecute,
  lifecycleProject,
} from "./lifecycle-platforms-fixture.js";
import type { ProcessIdentity } from "../src/process-tree.js";

test("lifecycle readiness preserves early terminal evidence without replacing a pending-run observation error", async () => {
  for (const early of [true, false]) {
    const original = Error("Original synthetic readiness refusal");
    const terminal = {
      outcome: "incomplete",
      errorCode: "OriginalFixtureProcessUnavailable",
    };
    const cleanups: ProcessIdentity[][] = [];
    const project = {
      root: "synthetic-root",
      control: "synthetic-control",
      marker: "synthetic-marker",
      release: "synthetic-release",
      file: "synthetic.test.js",
      observe: async () => {
        await Promise.resolve();
        throw original;
      },
      identities: async () => {
        throw Error("Unreached body has no identities");
      },
      continue: async () => {
        throw Error("Unreached body must not continue");
      },
      cleanup: async (rows: ProcessIdentity[]) => {
        cleanups.push(rows);
      },
    } satisfies Awaited<ReturnType<typeof lifecycleProject>>;
    await assert.rejects(
      lifecycleExecute(project, (signal) =>
        early
          ? Promise.resolve(terminal)
          : new Promise<typeof terminal>((resolve) => {
              signal.addEventListener("abort", () => resolve(terminal), {
                once: true,
              });
            }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        if (early) {
          assert.match(error.message, /execution ended before body readiness/);
          assert.match(error.message, /OriginalFixtureProcessUnavailable/);
          assert.equal(error.cause, original);
        } else assert.equal(error, original);
        return true;
      },
    );
    assert.deepEqual(
      cleanups,
      [[]],
      "Every refusal still closes only reached identities",
    );
  }
});
