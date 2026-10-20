import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { openTaskStore } from "../src/task-store.js";
import {
  openValidationTasks,
  type ValidationTasks,
} from "../src/validation-tasks.js";
import { reportSchema } from "../src/schemas.js";
import { captureNativeJournal } from "../src/native-journal-capture.js";
import {
  taskArchiveChunkSchema,
  taskArchiveLimits,
  type TaskArchiveChunk,
} from "../src/task-report-archives.js";
import type { Report } from "../src/types.js";
import { fixture, passingTest } from "./helpers.js";
import { setup, wire, taskId, terminal } from "./tasks-wire-fixture.js";

// Share the bounded wall-clock observer with the wire controls while reading real library tasks.
async function completed(tasks: ValidationTasks, id: string): Promise<void> {
  await terminal(
    {
      request: async () => ({
        result: { resultType: "complete", ...(await tasks.get(id)) },
      }),
    },
    id,
  );
}

const fingerprint = "a".repeat(64);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function report(): Report {
  return {
    schemaVersion: 1,
    engineVersion: "synthetic",
    runId: "86519a2b-eaaf-4d1f-b4c4-8395e8a9f9fe",
    startedAt: "2026-10-11T00:00:00Z",
    durationMs: 1,
    sourceFingerprint: fingerprint,
    finalSourceFingerprint: fingerprint,
    policyFingerprint: "b".repeat(64),
    sourceChanged: false,
    sourceError: false,
    excluded: [""],
    outcome: "incomplete",
    checks: [],
  };
}
function sizedReport(bytes: number): Report {
  const value = report();
  value.excluded = [
    "x".repeat(bytes - Buffer.byteLength(JSON.stringify(value))),
  ];
  assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
  return value;
}
async function options(t: TestContext, detailed = true) {
  const root = await realpath(await fixture(t, {}));
  const parent = await realpath(await fixture(t, {}));
  return { root, directory: path.join(parent, "tasks"), detailed };
}
function assertNativeOutput(
  report: ReturnType<typeof reportSchema.parse>,
  character: string,
): void {
  const expected = Buffer.from(character.repeat(300000) + "\n");
  const witnessed = [];
  for (const process of report.checks.flatMap((check) => check.processes)) {
    if (!process.capturedOutput) continue;
    const stream = process.capturedOutput.stdout;
    const raw = Buffer.from(stream.base64, "base64");
    assert.equal(raw.length, stream.bytes);
    assert.equal(hash(raw), stream.sha256);
    const messages: string[] = [];
    // Node's selected JSON reporter frames a large console write into multiple events.
    for (const line of raw.toString("utf8").trim().split("\n")) {
      const event: unknown = JSON.parse(line);
      if (
        typeof event !== "object" ||
        event === null ||
        !("type" in event) ||
        event.type !== "test:stdout"
      )
        continue;
      if (
        !("data" in event) ||
        typeof event.data !== "object" ||
        event.data === null ||
        !("message" in event.data) ||
        typeof event.data.message !== "string"
      )
        assert.fail("Native stdout event lacks its original message");
      messages.push(event.data.message);
    }
    if (Buffer.from(messages.join("")).equals(expected))
      witnessed.push(process);
  }
  assert.equal(
    witnessed.length,
    1,
    "Exactly one native body must retain every original stdout message byte",
  );
  assert.equal(witnessed[0]!.capturedOutput!.completeForObservedStreams, true);
}
function database(opt: { directory: string }) {
  return new DatabaseSync(path.join(opt.directory, "tasks.sqlite"));
}
function reconstruct(
  first: TaskArchiveChunk,
  read: (index: number) => TaskArchiveChunk,
): Buffer {
  const chunks = [];
  for (let index = 0; index < first.archive.chunks; index++) {
    const chunk = read(index);
    assert.deepEqual(chunk.archive, first.archive);
    assert.equal(chunk.index, index);
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(chunk) }],
          structuredContent: chunk,
        }),
      ) <
        256 * 1024,
    );
    chunks.push(Buffer.from(chunk.bodyBase64, "base64"));
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, first.archive.bytes);
  assert.equal(hash(bytes), first.archive.reportSha256);
  return bytes;
}

test("task archives retain exact multi-chunk UTF-8 reports and bounded terminal errors across reopening", async (t) => {
  const opt = await options(t);
  const store = await openTaskStore(opt);
  t.after(() => store.close());
  const task = store.create(fingerprint);
  const value = { ...report(), excluded: ["λ🚀\0".repeat(45000)] };
  const expected = Buffer.from(JSON.stringify(value));
  assert.throws(() => store.complete(task.taskId, value), /byte limit/);
  assert.equal(store.completeWithArchive(task.taskId, value), "updated");
  const result = store.get(task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.result!.isError, true);
  assert.equal(result.result!.structuredContent, undefined);
  assert.match(JSON.stringify(result.result), /validation_archive_read/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  const first = store.readArchive(task.taskId, 0);
  assert.ok(first.archive.chunks > 2);
  assert.equal(first.archive.taskId, task.taskId);
  assert.equal(first.archive.sourceFingerprint, fingerprint);
  assert.ok(
    reconstruct(first, (index) => store.readArchive(task.taskId, index)).equals(
      expected,
    ),
  );
  for (const index of [-1, 0.5, first.archive.chunks, Infinity])
    assert.throws(() => store.readArchive(task.taskId, index));
  const other = store.create(fingerprint);
  assert.throws(() => store.readArchive(other.taskId, 0), /unavailable/);
  for (const changed of [
    { ...first, bodyBase64: first.bodyBase64 + "\n" },
    { ...first, sha256: "0".repeat(64) },
    { ...first, index: first.archive.chunks },
    { ...first, bytes: first.bytes - 1 },
    {
      ...first,
      archive: { ...first.archive, chunks: first.archive.chunks + 1 },
    },
  ])
    assert.equal(taskArchiveChunkSchema.safeParse(changed).success, false);
  store.close();
  const reopened = await openTaskStore(opt);
  try {
    assert.deepEqual(reopened.get(task.taskId), result);
    assert.ok(
      reconstruct(reopened.readArchive(task.taskId, 0), (index) =>
        reopened.readArchive(task.taskId, index),
      ).equals(expected),
    );
  } finally {
    reopened.close();
  }
});

test("task archive report and shared quotas admit exact byte boundaries and refuse one extra byte without evicting siblings", async (t) => {
  const opt = await options(t);
  const store = await openTaskStore(opt);
  t.after(() => store.close());
  const tooLarge = store.create(fingerprint);
  assert.throws(
    () =>
      store.completeWithArchive(
        tooLarge.taskId,
        sizedReport(taskArchiveLimits.reportBytes + 1),
      ),
    /report byte limit/,
  );
  assert.equal(store.get(tooLarge.taskId).status, "working");
  const first = store.create(fingerprint),
    second = store.create(fingerprint),
    third = store.create(fingerprint);
  store.completeWithArchive(
    first.taskId,
    sizedReport(taskArchiveLimits.reportBytes),
  );
  store.completeWithArchive(
    second.taskId,
    sizedReport(taskArchiveLimits.reportBytes - 262145),
  );
  const before = store.get(first.taskId);
  assert.throws(
    () => store.completeWithArchive(third.taskId, sizedReport(262146)),
    /capacity/,
  );
  assert.equal(store.get(third.taskId).status, "working");
  assert.throws(() => store.readArchive(third.taskId, 0), /unavailable/);
  assert.deepEqual(store.get(first.taskId), before);
  assert.equal(
    store.completeWithArchive(third.taskId, sizedReport(262145)),
    "updated",
  );
  assert.equal(
    store.readArchive(first.taskId, 0).archive.bytes,
    taskArchiveLimits.reportBytes,
  );
  const db = database(opt);
  try {
    assert.equal(
      db.prepare("SELECT sum(bytes) AS bytes FROM task_archives").get()!.bytes,
      taskArchiveLimits.retainedBytes,
    );
  } finally {
    db.close();
  }
  assert.ok(
    (await stat(path.join(opt.directory, "tasks.sqlite"))).size <=
      taskArchiveLimits.databaseBytes,
  );
  // Reopening must accept the exact shared limit before rejecting one extra byte.
  store.close();
  const reopened = await openTaskStore(opt);
  let changed: TaskArchiveChunk;
  try {
    const firstChunk = reopened.readArchive(second.taskId, 0);
    const previous = reconstruct(firstChunk, (index) =>
      reopened.readArchive(second.taskId, index),
    );
    const next = Buffer.from(
      JSON.stringify(sizedReport(taskArchiveLimits.reportBytes - 262144)),
    );
    assert.equal(next.length, previous.length + 1);
    const last = reopened.readArchive(
      second.taskId,
      firstChunk.archive.chunks - 1,
    );
    const offset = last.index * last.archive.chunkBytes;
    assert.ok(previous.subarray(0, offset).equals(next.subarray(0, offset)));
    const tail = next.subarray(offset);
    changed = taskArchiveChunkSchema.parse({
      ...last,
      archive: {
        ...last.archive,
        bytes: next.length,
        reportSha256: hash(next),
      },
      bytes: tail.length,
      sha256: hash(tail),
      bodyBase64: tail.toString("base64"),
    });
  } finally {
    reopened.close();
  }
  // Keep every per-report, chunk and whole-report binding valid while changing only
  // the aggregate quota condition; an incidental digest failure cannot satisfy this.
  const altered = database(opt);
  try {
    altered.exec("BEGIN IMMEDIATE");
    try {
      altered
        .prepare("UPDATE task_archives SET manifest=?, bytes=? WHERE id=?")
        .run(
          JSON.stringify(changed.archive),
          changed.archive.bytes,
          second.taskId,
        );
      altered
        .prepare(
          "UPDATE task_archive_chunks SET body=?, sha256=? WHERE id=? AND ordinal=?",
        )
        .run(
          Buffer.from(changed.bodyBase64, "base64"),
          changed.sha256,
          second.taskId,
          changed.index,
        );
      assert.equal(
        altered.prepare("SELECT sum(bytes) AS bytes FROM task_archives").get()!
          .bytes,
        taskArchiveLimits.retainedBytes + 1,
      );
      altered.exec("COMMIT");
    } catch (error) {
      altered.exec("ROLLBACK");
      throw error;
    }
  } finally {
    altered.close();
  }
  await assert.rejects(
    openTaskStore(opt),
    /Task archive capacity or ownership differs/,
  );
});

test("task archive completion rolls back every chunk and terminal transition on a real mid-insert SQLite refusal", async (t) => {
  const opt = await options(t);
  let store = await openTaskStore(opt);
  const task = store.create(fingerprint);
  store.close();
  const db = database(opt);
  db.exec(
    "CREATE TRIGGER refuse_archive BEFORE INSERT ON task_archive_chunks WHEN NEW.ordinal = 2 BEGIN SELECT RAISE(ABORT, 'synthetic archive write refusal'); END",
  );
  db.close();
  store = await openTaskStore(opt);
  t.after(() => store.close());
  // Reopening interrupts working rows; create a new task under the faulting writer.
  const active = store.create(fingerprint);
  assert.throws(
    () => store.completeWithArchive(active.taskId, sizedReport(300000)),
    /synthetic archive write refusal/,
  );
  const inspected = database(opt);
  try {
    assert.equal(
      inspected.prepare("SELECT count(*) AS count FROM task_archives").get()!
        .count,
      0,
    );
    assert.equal(
      inspected
        .prepare("SELECT count(*) AS count FROM task_archive_chunks")
        .get()!.count,
      0,
    );
  } finally {
    inspected.close();
  }
  assert.equal(store.get(active.taskId).status, "working");
  store.close();
  const reopened = await openTaskStore(opt);
  try {
    assert.equal(reopened.get(active.taskId).result!.isError, true);
    assert.match(JSON.stringify(reopened.get(active.taskId)), /interrupted/);
    assert.throws(() => reopened.readArchive(active.taskId, 0), /unavailable/);
    assert.equal(reopened.get(task.taskId).status, "completed");
  } finally {
    reopened.close();
  }
});

test("task archive source cancellation expiry and summary disclosure guards preserve independent siblings", async (t) => {
  const opt = await options(t);
  const store = await openTaskStore(opt);
  t.after(() => store.close());
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const value = sizedReport(300000),
    cancel = store.create(fingerprint),
    wrong = store.create(fingerprint),
    expiring = store.create(fingerprint, 1000),
    retained = store.create(fingerprint, 2000);
  assert.throws(
    () =>
      store.completeWithArchive(wrong.taskId, {
        ...value,
        sourceFingerprint: "b".repeat(64),
      }),
    /fingerprints differ/,
  );
  store.requestCancellation(cancel.taskId);
  assert.equal(
    store.completeWithArchive(cancel.taskId, value),
    "cancellation-requested",
  );
  store.finishCancellation(cancel.taskId);
  store.completeWithArchive(expiring.taskId, value);
  store.completeWithArchive(retained.taskId, value);
  assert.equal(
    store.completeWithArchive(retained.taskId, {
      ...value,
      sourceFingerprint: "b".repeat(64),
    }),
    "terminal",
  );
  assert.throws(() => store.readArchive(cancel.taskId, 0), /unavailable/);
  now += 1000;
  assert.throws(() => store.readArchive(expiring.taskId, 0), /expired/);
  store.create(fingerprint);
  assert.equal(
    store.readArchive(retained.taskId, 0).archive.taskId,
    retained.taskId,
  );
  const db = database(opt);
  try {
    assert.deepEqual(
      db
        .prepare("SELECT id FROM task_archives")
        .all()
        .map((x) => x.id),
      [retained.taskId],
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM task_archive_chunks WHERE id = ?",
        )
        .get(expiring.taskId)!.count,
      0,
    );
  } finally {
    db.close();
  }
  const summaryOpt = await options(t, false),
    summary = await openTaskStore(summaryOpt);
  try {
    const id = summary.create(fingerprint).taskId;
    assert.equal(summary.completeWithArchive(id, value), "updated");
    assert.equal(summary.get(id).result!.isError, undefined);
    assert.throws(() => summary.readArchive(id, 0), /unavailable/);
  } finally {
    summary.close();
  }
  const bytes = await readFile(path.join(summaryOpt.directory, "tasks.sqlite"));
  assert.ok(!bytes.includes(Buffer.from("x".repeat(2000))));
  store.close();
  await assert.rejects(
    openTaskStore({ ...opt, detailed: false }),
    /does not match/,
  );
});

test("task archive migration validates legacy bindings and rows before atomically changing its schema", async (t) => {
  for (const damaged of [false, true]) {
    const opt = await options(t);
    const store = await openTaskStore(opt);
    const id = store.create(fingerprint).taskId;
    store.complete(id, report());
    const previous = store.get(id);
    store.close();
    const db = database(opt);
    db.exec(
      "DROP TABLE task_archive_chunks; DROP TABLE task_archives; PRAGMA user_version=1",
    );
    if (damaged)
      db.prepare("UPDATE tasks SET result = ?").run('{"invalid":"synthetic"}');
    db.close();
    const other = await options(t);
    await assert.rejects(
      openTaskStore({ ...opt, root: other.root }),
      /does not match/,
    );
    if (damaged) await assert.rejects(openTaskStore(opt));
    else {
      const upgraded = await openTaskStore(opt);
      try {
        assert.deepEqual(upgraded.get(id), previous);
      } finally {
        upgraded.close();
      }
    }
    const inspected = database(opt);
    try {
      assert.equal(
        inspected.prepare("PRAGMA user_version").get()!.user_version,
        damaged ? 1 : 2,
      );
      assert.equal(
        inspected
          .prepare(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('task_archives','task_archive_chunks')",
          )
          .get()!.count,
        damaged ? 0 : 2,
      );
    } finally {
      inspected.close();
    }
  }
});

test("task archive reopening refuses every manifest chunk source and terminal corruption family", async (t) => {
  for (const mutate of [
    "UPDATE task_archive_chunks SET sha256 = '" +
      "0".repeat(64) +
      "' WHERE ordinal=0",
    "UPDATE task_archive_chunks SET body = zeroblob(length(body)) WHERE ordinal=0",
    "DELETE FROM task_archive_chunks WHERE ordinal=1",
    "UPDATE task_archive_chunks SET ordinal=99 WHERE ordinal=1",
    "UPDATE task_archives SET bytes=bytes-1",
    "UPDATE task_archives SET manifest=json_set(manifest,'$.reportSha256','" +
      "0".repeat(64) +
      "')",
    "UPDATE task_archives SET manifest=json_set(manifest,'$.sourceFingerprint','" +
      "b".repeat(64) +
      "')",
    "UPDATE task_archives SET manifest=json_set(manifest,'$.taskId','00000000-0000-4000-8000-000000000000')",
    (db: DatabaseSync) => {
      const value = db
        .prepare("SELECT body FROM task_archive_chunks WHERE ordinal=0")
        .get()!.body;
      if (!(value instanceof Uint8Array))
        assert.fail("Expected a physical chunk");
      const body = Buffer.from(value);
      assert.equal(body[body.length - 1], 0x78);
      body[body.length - 1] = 0x79;
      db.prepare(
        "UPDATE task_archive_chunks SET body=?,sha256=? WHERE ordinal=0",
      ).run(body, hash(body));
    },
    "UPDATE tasks SET status='working',result=NULL",
    "UPDATE tasks SET result='{}'",
  ]) {
    const opt = await options(t);
    const store = await openTaskStore(opt);
    const task = store.create(fingerprint);
    store.completeWithArchive(task.taskId, sizedReport(300000));
    store.close();
    const db = database(opt);
    if (typeof mutate === "string") db.exec(mutate);
    else mutate(db);
    db.close();
    await assert.rejects(openTaskStore(opt));
  }
});

test("native validation worker retains oversized original reports and supports bounded read-only reopening", async (t) => {
  const opt = {
    ...(await setup(t, passingTest + "\nconsole.log('x'.repeat(300000));")),
    detailed: true,
    allowExecution: true,
  };
  const tasks = await openValidationTasks(opt);
  let id: string;
  let saved: TaskArchiveChunk | undefined;
  try {
    id = (await tasks.start()).taskId;
    await completed(tasks, id);
    assert.equal((await tasks.get(id)).status, "completed");
    assert.equal((await tasks.get(id)).result!.isError, true);
    saved = await tasks.readArchive(id, 0);
    const parts = [];
    for (let index = 0; index < saved.archive.chunks; index++) {
      const chunk = await tasks.readArchive(id, index);
      assert.deepEqual(chunk.archive, saved.archive);
      parts.push(Buffer.from(chunk.bodyBase64, "base64"));
    }
    const bytes = Buffer.concat(parts);
    assert.equal(hash(bytes), saved.archive.reportSha256);
    const result = reportSchema.parse(JSON.parse(bytes.toString("utf8")));
    assert.equal(result.outcome, "passed");
    assertNativeOutput(result, "x");
  } finally {
    await tasks.close();
  }
  const reopened = await openValidationTasks({ ...opt, allowExecution: false });
  try {
    assert.deepEqual(await reopened.readArchive(id, 0), saved);
    await assert.rejects(reopened.start(), /denied/);
  } finally {
    await reopened.close();
  }
});

test("native MCP archive retrieval retains failed outcomes with startup-only detail and exact bounded addresses", async (t) => {
  const opt = await setup(
    t,
    passingTest.replace("2 + 3, 5", "2 + 3, 6") +
      "\nconsole.log('y'.repeat(300000));",
  );
  const detailed = await wire(t, opt, ["--allow-execution", "--detailed"]);
  let id: string;
  let first: TaskArchiveChunk | undefined;
  try {
    id = taskId(
      await detailed.request("tools/call", {
        name: "validation_run",
        arguments: {},
      }),
    );
    const finished = await terminal(detailed, id);
    assert.equal(finished.status, "completed");
    assert.equal((finished.result as { isError: boolean }).isError, true);
    const parts = [];
    for (let index = 0; ; index++) {
      const response = await detailed.request(
        "tools/call",
        { name: "validation_archive_read", arguments: { taskId: id, index } },
        false,
      );
      assert.equal(response.error, undefined);
      assert.equal(response.result?.isError, undefined);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < 256 * 1024);
      const chunk = taskArchiveChunkSchema.parse(
        response.result?.structuredContent,
      );
      first ??= chunk;
      assert.deepEqual(chunk.archive, first.archive);
      assert.equal(chunk.index, index);
      parts.push(Buffer.from(chunk.bodyBase64, "base64"));
      if (index + 1 === first.archive.chunks) break;
    }
    const bytes = Buffer.concat(parts);
    assert.equal(hash(bytes), first!.archive.reportSha256);
    const result = reportSchema.parse(JSON.parse(bytes.toString("utf8")));
    assert.equal(result.outcome, "failed");
    assertNativeOutput(result, "y");
    for (const args of [
      { taskId: id, index: -1 },
      { taskId: id, index: 512 },
      { taskId: id, index: 0, detailed: true },
      { taskId: id, index: 0, trusted: true },
      { taskId: "../tasks.sqlite", index: 0 },
      { taskId: id, index: first!.archive.chunks },
    ]) {
      const response = await detailed.request("tools/call", {
        name: "validation_archive_read",
        arguments: args,
      });
      assert.ok(
        response.error !== undefined || response.result?.isError === true,
      );
    }
  } finally {
    await detailed.close();
  }
  const readonly = await wire(t, opt, ["--detailed"]);
  try {
    const response = await readonly.request("tools/call", {
      name: "validation_archive_read",
      arguments: { taskId: id, index: 0 },
    });
    assert.deepEqual(
      taskArchiveChunkSchema.parse(response.result?.structuredContent),
      first,
    );
  } finally {
    await readonly.close();
  }
  const summary = await wire(t, opt, []);
  try {
    const response = await summary.request("tools/call", {
      name: "validation_archive_read",
      arguments: { taskId: id, index: 0, detailed: true },
    });
    assert.ok(
      response.error !== undefined || response.result?.isError === true,
    );
  } finally {
    await summary.close();
  }
});

test("durable Tasks retain oversized physical inner-wrapper journals with their original PID source and stream bindings", async (t) => {
  const root = await realpath(
    await fixture(t, {
      "retained.project": "synthetic",
      "first.txt": "clean\n",
      "second.txt": "clean\n",
    }),
  );
  const privateParent = await realpath(await fixture(t, {}));
  const marker = path.join(privateParent, "native-pid");
  const program = `import {readFile,writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(marker)},String(process.pid));const r=JSON.parse(await readFile(process.argv[2],'utf8'));const result={protocolVersion:1,identity:r.identity,checkId:r.checkId,sourceFingerprint:r.sourceFingerprint,files:r.scope.map(path=>({path,status:'checked'})),findings:[],findingsComplete:true,tools:[{name:'original-retained-pid',version:String(process.pid)}]};process.stdout.write(' '.repeat(300000));console.log(JSON.stringify(result));`;
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: "external.retained-journal",
    version: "1.0.0",
    description: "Original large inner journal control",
    runtime: "node",
    entry: "adapter.mjs",
    files: [{ path: "adapter.mjs", sha256: hash(Buffer.from(program)) }],
    markers: ["retained.project"],
    checks: [
      {
        id: "analysis",
        kind: "analysis",
        description: "Original two-file native control",
        failOn: "error",
        scope: { extensions: [".txt"], names: [] },
      },
    ],
  });
  const bundle = await fixture(t, {
    "adapter.mjs": program,
    "adapter.json": manifest,
  });
  const opt = {
    root,
    directory: path.join(privateParent, "store"),
    allowExecution: true,
    detailed: true,
    timeoutMs: 5000,
    externalAdapters: [
      {
        path: path.join(bundle, "adapter.json"),
        sha256: hash(Buffer.from(manifest)),
      },
    ],
  };
  const tasks = await openValidationTasks(opt);
  let id: string;
  let first: TaskArchiveChunk;
  try {
    id = (await tasks.start()).taskId;
    await completed(tasks, id);
    assert.equal((await tasks.get(id)).status, "completed");
    assert.equal((await tasks.get(id)).result!.isError, true);
    first = await tasks.readArchive(id, 0);
    assert.ok(first.archive.bytes > 256 * 1024);
    const parts = [];
    for (let index = 0; index < first.archive.chunks; index++)
      parts.push(
        Buffer.from((await tasks.readArchive(id, index)).bodyBase64, "base64"),
      );
    const bytes = Buffer.concat(parts);
    assert.equal(hash(bytes), first.archive.reportSha256);
    const report = reportSchema.parse(JSON.parse(bytes.toString("utf8")));
    assert.equal(report.outcome, "passed");
    assert.equal(report.checks.length, 1);
    const journal = report.checks[0]!.processes[0]!.nativeJournal!;
    assert.equal(journal.status, "collected");
    assert.equal(journal.capture!.state, "complete");
    assert.equal(
      journal.expectedHeader.sourceFingerprint,
      report.sourceFingerprint,
    );
    const captured = captureNativeJournal(
      journal.expectedHeader,
      Buffer.from(journal.capture!.headerData.base64, "base64"),
      Buffer.from(journal.capture!.framesData.base64, "base64"),
      journal.capture!.headerData.sha256,
    );
    assert.deepEqual(captured, journal.capture);
    assert.equal(captured.replay!.attempts.length, 1);
    const call = captured.replay!.attempts[0]!;
    assert.equal(call.pid, Number(await readFile(marker, "utf8")));
    assert.equal(call.exitCode, 0);
    assert.equal(call.capturedOutput.completeForObservedStreams, true);
    const output = Buffer.from(call.capturedOutput.stdout.base64, "base64");
    assert.equal(output.length, call.capturedOutput.stdout.bytes);
    assert.equal(hash(output), call.capturedOutput.stdout.sha256);
    assert.ok(
      output.subarray(0, 300000).equals(Buffer.from(" ".repeat(300000))),
    );
    const physical = JSON.parse(output.subarray(300000).toString("utf8")) as {
      files: unknown[];
      tools: { version: string }[];
    };
    assert.equal(physical.files.length, 2);
    assert.equal(Number(physical.tools[0]!.version), call.pid);
  } finally {
    await tasks.close();
  }
  const reopened = await openValidationTasks({ ...opt, allowExecution: false });
  try {
    assert.deepEqual(await reopened.readArchive(id, 0), first);
  } finally {
    await reopened.close();
  }
});
