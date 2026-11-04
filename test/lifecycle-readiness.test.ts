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

test("opt-in lifecycle diagnostics identify the failed operation and preserve original and cleanup causes without disclosing values", async () => {
  for (const early of [false, true]) {
    for (const cleanupFails of [false, true]) {
      const original = Error("synthetic-private-original-path"),
        cleanupFailure = Error("synthetic-private-cleanup-path"),
        terminal = {
          outcome: "incomplete",
          path: "synthetic-private-result-path",
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
          throw Error("Unreached identities");
        },
        continue: async () => {
          throw Error("Unreached release");
        },
        cleanup: async (rows: ProcessIdentity[]) => {
          cleanups.push(rows);
          if (cleanupFails) throw cleanupFailure;
        },
      } satisfies Awaited<ReturnType<typeof lifecycleProject>>;
      await assert.rejects(
        lifecycleExecute(
          project,
          (signal) =>
            early
              ? Promise.resolve(terminal)
              : new Promise<typeof terminal>((resolve) => {
                  signal.addEventListener("abort", () => resolve(terminal), {
                    once: true,
                  });
                }),
          { operation: "privacy-cli-summary", enabled: true },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, original);
          assert.deepEqual(
            error.errors,
            cleanupFails ? [original, cleanupFailure] : [original],
          );
          const context = JSON.parse(
            error.message.split("bounded diagnostic ")[1]!,
          );
          assert.equal(context.operation, "privacy-cli-summary");
          assert.equal(context.phase, "observe");
          assert.equal(context.settledBeforeAbort, early);
          assert.equal(context.settledAfterAbort, true);
          assert.equal(context.bodyObserved, false);
          assert.equal(context.cleanup, cleanupFails ? "failed" : "confirmed");
          assert.equal(context.reachedIdentities, 0);
          assert.equal(context.outcome, "incomplete");
          assert.equal(context.failureCount, cleanupFails ? 2 : 1);
          assert.ok(
            Number.isSafeInteger(context.elapsedMs) && context.elapsedMs >= 0,
          );
          assert.ok(Buffer.byteLength(error.message) < 1024);
          assert.equal(error.message.includes("synthetic-private"), false);
          return true;
        },
      );
      assert.deepEqual(cleanups, [[]]);
    }
  }
});
