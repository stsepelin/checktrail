import assert from "node:assert/strict";
import { test } from "node:test";
const { pullPinnedImage } = await import(
  new URL("../../scripts/pull-pinned-image.mjs", import.meta.url).href
);
const reference = "public.ecr.aws/docker/library/node@sha256:" + "a".repeat(64);
const failure = (stderr: string) =>
  Object.assign(new Error("Synthetic pinned image failure"), {
    status: 1,
    stderr: Buffer.from(stderr),
  });
test("pinned image delivery retries only explicit throttling and temporary server responses while keeping every reference identical", async () => {
  for (const stderr of [
    "toomanyrequests: Rate exceeded\n",
    "Error response from daemon: toomanyrequests: Rate exceeded\n",
    "unexpected HTTP status: 503 Service Unavailable\n",
    "unexpected status code 429 Too Many Requests\n",
  ]) {
    const calls: string[] = [],
      waits: number[] = [],
      events: { attempt: number; waitMs: number }[] = [];
    const result = await pullPinnedImage(reference, {
      runImpl: async (image: string) => {
        calls.push(image);
        if (calls.length < 3) throw failure(stderr);
      },
      delayImpl: async (ms: number) => {
        waits.push(ms);
      },
      onRetry: async (event: { attempt: number; waitMs: number }) => {
        events.push(event);
      },
    });
    assert.deepEqual(calls, [reference, reference, reference]);
    assert.deepEqual(waits, [2000, 5000]);
    assert.deepEqual(events, [
      { attempt: 1, waitMs: 2000 },
      { attempt: 2, waitMs: 5000 },
    ]);
    assert.deepEqual(result, {
      reference,
      attempts: 3,
      deliveryComplete: true,
    });
  }
});
test("pinned image delivery propagates permanent errors and exhausted attempts instead of reporting successful preparation", async () => {
  for (const error of [
    failure("manifest unknown"),
    failure("denied: unauthenticated"),
    failure("authentication token expired"),
    failure("pull access denied for toomanyrequests:example"),
    Object.assign(failure("toomanyrequests: Rate exceeded"), {
      signal: "SIGTERM",
    }),
    Object.assign(failure("toomanyrequests: Rate exceeded"), {
      code: "ETIMEDOUT",
    }),
  ]) {
    let calls = 0,
      waits = 0;
    await assert.rejects(
      pullPinnedImage(reference, {
        runImpl: async () => {
          calls++;
          throw error;
        },
        delayImpl: async () => {
          waits++;
        },
        onRetry: async () => {},
      }),
      (actual: unknown) => actual === error,
    );
    assert.equal(calls, 1);
    assert.equal(waits, 0);
  }
  const error = failure("toomanyrequests: Rate exceeded\n");
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    pullPinnedImage(reference, {
      runImpl: async () => {
        calls++;
        throw error;
      },
      delayImpl: async (ms: number) => {
        waits.push(ms);
      },
      onRetry: async () => {},
    }),
    (actual: unknown) => actual === error,
  );
  assert.equal(calls, 5);
  assert.deepEqual(waits, [2000, 5000, 15000, 30000]);
});
test("pinned image delivery rejects unpinned adjacent references and cancellation before any Docker request", async () => {
  for (const image of [
    reference + "\n",
    reference + "x",
    reference.replace("public.ecr.aws", "public.ecr.aws.attacker.invalid"),
    reference.replace("/docker/library/", "/other/library/"),
    reference.replace("@sha256:", ":sha256:"),
    "public.ecr.aws/docker/library/node:latest",
    reference.toUpperCase(),
  ]) {
    let calls = 0;
    await assert.rejects(
      pullPinnedImage(image, {
        runImpl: async () => {
          calls++;
        },
        delayImpl: async () => {},
        onRetry: async () => {},
      }),
      /exact pinned/,
    );
    assert.equal(calls, 0);
  }
  let calls = 0;
  const cancelled = new Error("Synthetic cancellation");
  await assert.rejects(
    pullPinnedImage(reference, {
      signal: AbortSignal.abort(cancelled),
      runImpl: async () => {
        calls++;
      },
      onRetry: async () => {},
    }),
    (actual: unknown) => actual === cancelled,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    pullPinnedImage(reference, {
      signal: controller.signal,
      runImpl: async () => {
        calls++;
        throw failure("toomanyrequests: Rate exceeded");
      },
      delayImpl: async () => {
        controller.abort(cancelled);
      },
      onRetry: async () => {},
    }),
    (actual: unknown) => actual === cancelled,
  );
  assert.equal(calls, 1);
});
test("pinned image delivery checks monotonic elapsed time even when a synchronous Docker command blocks the abort timer", async () => {
  let clock = 0,
    calls = 0;
  await assert.rejects(
    pullPinnedImage(reference, {
      timeoutMs: 10,
      nowImpl: () => clock,
      runImpl: async () => {
        calls++;
        clock = 11;
      },
      onRetry: async () => {},
    }),
    /wall limit exhausted/,
  );
  assert.equal(calls, 1);
  clock = 0;
  calls = 0;
  const result = await pullPinnedImage(reference, {
    timeoutMs: 10,
    nowImpl: () => clock,
    runImpl: async (_image: string, remaining: number) => {
      assert.equal(remaining, 10);
      calls++;
      clock = 10;
    },
    onRetry: async () => {},
  });
  assert.equal(result.deliveryComplete, true);
  assert.equal(calls, 1);
  clock = 0;
  calls = 0;
  let waits = 0;
  await assert.rejects(
    pullPinnedImage(reference, {
      timeoutMs: 2000,
      nowImpl: () => clock,
      runImpl: async () => {
        calls++;
        throw failure("toomanyrequests: Rate exceeded");
      },
      delayImpl: async () => {
        waits++;
      },
      onRetry: async () => {},
    }),
    /wall limit exhausted/,
  );
  assert.equal(calls, 1);
  assert.equal(waits, 0);
  for (const timeoutMs of [0, -1, 0.5, 180001, NaN]) {
    calls = 0;
    await assert.rejects(
      pullPinnedImage(reference, {
        timeoutMs,
        runImpl: async () => {
          calls++;
        },
        onRetry: async () => {},
      }),
      /wall limit is invalid/,
    );
    assert.equal(calls, 0);
  }
});
