import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  findingsCliDeadline,
  findingsCliResponseTimeoutMs,
  findingsCliStderrDigest,
  findingsNativeWallMs,
  findingsResponseHeadroomMs,
  readFindingsCliResponse,
  stopFindingsCliFixture,
} from "./review-workflow-findings-fixture.js";
const context = () => ({
  operation: "probe",
  sequence: 7,
  phase: "response",
  childExitCode: null,
  childSignal: null,
});
test("findings CLI observation admits the configured native wall and bounded response cleanup without extending ordinary startup", () => {
  assert.equal(findingsNativeWallMs, 30000);
  assert.equal(findingsResponseHeadroomMs, 10000);
  for (const native of [1, 30000, 120000]) {
    for (const operation of ["probe", "finish", "close"])
      assert.equal(
        findingsCliResponseTimeoutMs(operation, native),
        native + 10000,
      );
    for (const operation of [
      "open",
      "next",
      "submit",
      "status",
      "findings",
      "unknown",
    ])
      assert.equal(findingsCliResponseTimeoutMs(operation, native), 15000);
  }
  for (const invalid of [0, -1, 120001, Infinity, NaN, 1.5])
    assert.throws(() => findingsCliResponseTimeoutMs("probe", invalid));
});
test("findings CLI deadline retains operation sequence and actual terminal context for a stalled reply", async () => {
  await assert.rejects(
    findingsCliDeadline(new Promise<never>(() => {}), 20, context),
    (error: unknown) => {
      const failure = error as Error & {
        code: string;
        context: Record<string, unknown>;
      };
      assert.equal(failure.code, "FINDINGS_CLI_DEADLINE");
      assert.equal(failure.context.operation, "probe");
      assert.equal(failure.context.sequence, 7);
      assert.equal(failure.context.timeoutMs, 20);
      assert.equal(failure.context.childExitCode, null);
      assert.ok(typeof failure.context.readElapsedMs === "number");
      return true;
    },
  );
});
test("findings CLI deadline clears its exact timer on success and preserves an earlier child failure", async (t) => {
  const clear = globalThis.clearTimeout;
  const cleared: unknown[] = [];
  t.mock.method(
    globalThis,
    "clearTimeout",
    (timer: ReturnType<typeof setTimeout>) => {
      cleared.push(timer);
      return clear(timer);
    },
  );
  assert.equal(
    await findingsCliDeadline(Promise.resolve("ready"), 500, context),
    "ready",
  );
  assert.equal(cleared.length, 1);
  assert.ok(cleared[0]);
  const original = Error("public synthetic child error");
  await assert.rejects(
    findingsCliDeadline(Promise.reject(original), 500, context),
    (error: unknown) => error === original,
  );
  assert.equal(cleared.length, 2);
  assert.notEqual(cleared[0], cleared[1]);
});
test("findings CLI real line reader accepts a delayed valid reply and distinguishes EOF from a deadline", async () => {
  const input = new PassThrough();
  const reader = createInterface({ input });
  const iterator = reader[Symbol.asyncIterator]();
  try {
    const pending = readFindingsCliResponse(iterator, 500, context);
    await delay(10);
    input.end('{"accepted":true}\n');
    assert.deepEqual(await pending, { accepted: true });
    await assert.rejects(
      readFindingsCliResponse(iterator, 500, context),
      (error: unknown) => {
        assert.match((error as Error).message, /Original findings CLI EOF/);
        assert.doesNotMatch((error as Error).message, /CLI deadline/);
        assert.match((error as Error).message, /"sequence":7/);
        return true;
      },
    );
  } finally {
    reader.close();
    input.destroy();
  }
});
test("findings CLI completion guard stays finite and rejects invalid observation budgets before waiting", async () => {
  for (const timeout of [0, 130001, Infinity, 0.5])
    await assert.rejects(
      findingsCliDeadline(Promise.resolve(0), timeout, context),
    );
  await assert.rejects(
    findingsCliDeadline(new Promise<never>(() => {}), 20, () => ({
      operation: "close",
      sequence: 8,
      phase: "child-close",
    })),
    /"operation":"close"/,
  );
});

test("findings CLI fixture cleanup escalates only after its guard and preserves the first deadline failure", async () => {
  let resolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((done) => {
    resolve = done;
  });
  const signals: NodeJS.Signals[] = [];
  const child = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        this.signalCode = signal;
        resolve(null);
      }
      return true;
    },
  };
  await assert.rejects(
    stopFindingsCliFixture(child, exited, 20, context),
    (error: unknown) =>
      (error as { code: string }).code === "FINDINGS_CLI_DEADLINE",
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});
test("findings CLI fixture cleanup leaves an already exited child untouched", async () => {
  const signals: NodeJS.Signals[] = [];
  const child = {
    exitCode: 0,
    signalCode: null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      return false;
    },
  };
  await stopFindingsCliFixture(child, Promise.resolve(0), 20, context);
  assert.deepEqual(signals, []);
});

test("findings CLI cleanup retains a later terminal error behind its original guard failure", async () => {
  let reject!: (error: Error) => void;
  const terminal = new Promise<number | null>((resolve, failed) => {
    void resolve;
    reject = failed;
  });
  const secondary = Error("public synthetic terminal failure");
  const child = {
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      if (signal === "SIGKILL") {
        this.signalCode = signal;
        reject(secondary);
      }
      return true;
    },
  };
  await assert.rejects(
    stopFindingsCliFixture(child, terminal, 20, context),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        (error.cause as { code: string }).code,
        "FINDINGS_CLI_DEADLINE",
      );
      assert.equal(error.errors[0], error.cause);
      assert.equal(error.errors[1], secondary);
      return true;
    },
  );
});

test("findings CLI stderr observations hash original binary chunks and allow snapshots before later appends", () => {
  const chunks = [
    Buffer.from([0xce]),
    Buffer.from([0xbb, 0xf0, 0x9f]),
    Buffer.from([0x9a, 0x80, 0xff, 0x00]),
  ];
  const observation = findingsCliStderrDigest();
  const digest = (value: Buffer) => ({
    bytes: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  });
  assert.deepEqual(observation.snapshot(), digest(Buffer.alloc(0)));
  observation.append(chunks[0]!);
  const first = observation.snapshot();
  assert.deepEqual(first, digest(chunks[0]!));
  assert.deepEqual(observation.snapshot(), first);
  for (const chunk of chunks.slice(1)) observation.append(chunk);
  const original = Buffer.concat(chunks);
  const complete = observation.snapshot();
  assert.deepEqual(complete, digest(original));
  assert.deepEqual(first, digest(chunks[0]!));
  assert.notDeepEqual(
    complete,
    digest(Buffer.from(chunks.map((chunk) => chunk.toString()).join(""))),
  );
  assert.deepEqual(Object.keys(complete).sort(), ["bytes", "sha256"]);
});
