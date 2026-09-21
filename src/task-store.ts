import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { projectReport } from "./output.js";
import { reportSchema, reportSummarySchema } from "./schemas.js";
import type { Report } from "./types.js";

const MAX_TASKS = 32;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_DATABASE_BYTES = 16 * 1024 * 1024;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APPLICATION_ID = 0x52565453;
const interruptedResult = {
  content: [
    {
      type: "text",
      text: "Validation interrupted before a durable result was stored. Execution was not resumed.",
    },
  ],
  isError: true,
};
const idSchema = z.string().uuid();
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.strictObject({
  id: idSchema,
  source: fingerprintSchema,
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  expires: z.number().int().nonnegative(),
  status: z.enum(["working", "completed", "cancelled"]),
  cancelling: z.union([z.literal(0), z.literal(1)]),
  result: z.string().nullable(),
});
type Row = z.infer<typeof rowSchema>;

export interface StoredValidationTask {
  taskId: string;
  status: "working" | "completed" | "cancelled";
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  result?: Record<string, unknown>;
}

export type TaskTransition = "updated" | "terminal" | "cancellation-requested";

export interface TaskStoreOptions {
  directory: string;
  root: string;
  detailed?: boolean;
}

function privateFile(filename: string, maximum: number): void {
  let stat;
  try {
    stat = lstatSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const fd = openSync(
      filename,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    stat = lstatSync(filename);
  }
  // Closing another descriptor for an existing SQLite file releases this process's POSIX locks.
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > maximum
  )
    throw new Error(
      "Task store requires bounded, private, singly linked regular files",
    );
}

function applicationId(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA application_id").get()!.application_id);
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // SQLite can roll back the transaction itself on SQLITE_FULL or an I/O error.
    try {
      db.exec("ROLLBACK");
    } catch {
      /* Already rolled back. */
    }
    throw error;
  }
}

function decodeTask(row: Row, detailed: boolean): StoredValidationTask {
  const task: StoredValidationTask = {
    taskId: row.id,
    status: row.status,
    createdAt: new Date(row.created).toISOString(),
    lastUpdatedAt: new Date(row.updated).toISOString(),
    ttlMs: row.expires - row.created,
  };
  if (row.result !== null) {
    if (Buffer.byteLength(row.result) > MAX_RESULT_BYTES)
      throw new Error("Stored task result exceeds the byte limit");
    const value: unknown = JSON.parse(row.result);
    if (JSON.stringify(value) === JSON.stringify(interruptedResult)) {
      task.result = structuredClone(interruptedResult);
    } else {
      const envelope = z
        .strictObject({
          content: z.tuple([
            z.strictObject({ type: z.literal("text"), text: z.string() }),
          ]),
          structuredContent: z.record(z.string(), z.unknown()),
        })
        .parse(value);
      const schema = detailed ? reportSchema : reportSummarySchema;
      schema.parse(envelope.structuredContent);
      if (
        envelope.content[0].text !== JSON.stringify(envelope.structuredContent)
      )
        throw new Error("Stored task result representations disagree");
      task.result = envelope;
    }
  }
  if (
    (row.status === "completed") !== (row.result !== null) ||
    row.expires <= row.created ||
    row.expires - row.created > MAX_TTL_MS ||
    row.updated < row.created
  )
    throw new Error("Invalid stored task state");
  return task;
}

/** Bounded validation-result persistence; this component does not execute or stop workers. */
export class ValidationTaskStore {
  private closed = false;

  constructor(
    private readonly database: DatabaseSync,
    private readonly ownership: DatabaseSync,
    private readonly detailed: boolean,
  ) {}

  private active(): void {
    if (this.closed) throw new Error("Task store is closed");
  }

  private prune(): void {
    this.database
      .prepare("DELETE FROM tasks WHERE expires <= ?")
      .run(Date.now());
  }

  private row(taskId: string): Row {
    this.active();
    idSchema.parse(taskId);
    const row = this.database
      .prepare("SELECT * FROM tasks WHERE id = ? AND expires > ?")
      .get(taskId, Date.now());
    if (!row) throw new Error("Unknown or expired validation task");
    return rowSchema.parse(row);
  }

  create(
    sourceFingerprint: string,
    ttlMs = 24 * 60 * 60 * 1000,
  ): StoredValidationTask {
    this.active();
    fingerprintSchema.parse(sourceFingerprint);
    z.number().int().min(1).max(MAX_TTL_MS).parse(ttlMs);
    return transaction(this.database, () => {
      this.prune();
      const count = Number(
        this.database.prepare("SELECT count(*) AS count FROM tasks").get()!
          .count,
      );
      if (count >= MAX_TASKS) throw new Error("Task store capacity reached");
      const taskId = randomUUID();
      const now = Date.now();
      this.database
        .prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, 'working', 0, NULL)")
        .run(taskId, sourceFingerprint, now, now, now + ttlMs);
      return decodeTask(
        rowSchema.parse(
          this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId),
        ),
        this.detailed,
      );
    });
  }

  get(taskId: string): StoredValidationTask {
    return decodeTask(this.row(taskId), this.detailed);
  }

  complete(taskId: string, report: Report): TaskTransition {
    this.active();
    return transaction(this.database, () => {
      const row = this.row(taskId);
      if (row.status !== "working") return "terminal";
      if (row.cancelling) return "cancellation-requested";
      reportSchema.parse(report);
      if (report.sourceFingerprint !== row.source)
        throw new Error("Task and report source fingerprints differ");
      const projected = projectReport(report, this.detailed);
      const result = JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(projected) }],
        structuredContent: projected,
      });
      if (Buffer.byteLength(result) > MAX_RESULT_BYTES)
        throw new Error("Task result exceeds the byte limit");
      this.database
        .prepare(
          "UPDATE tasks SET status = 'completed', result = ?, updated = ? WHERE id = ? AND status = 'working'",
        )
        .run(result, Math.max(row.updated, Date.now()), taskId);
      return "updated";
    });
  }

  interrupt(taskId: string): TaskTransition {
    this.active();
    return transaction(this.database, () => {
      const row = this.row(taskId);
      if (row.status !== "working") return "terminal";
      if (row.cancelling) return "cancellation-requested";
      this.database
        .prepare(
          "UPDATE tasks SET status = 'completed', result = ?, updated = ? WHERE id = ?",
        )
        .run(
          JSON.stringify(interruptedResult),
          Math.max(row.updated, Date.now()),
          taskId,
        );
      return "updated";
    });
  }

  requestCancellation(taskId: string): TaskTransition {
    this.active();
    return transaction(this.database, () => {
      const row = this.row(taskId);
      if (row.status !== "working") return "terminal";
      if (row.cancelling) return "cancellation-requested";
      this.database
        .prepare("UPDATE tasks SET cancelling = 1, updated = ? WHERE id = ?")
        .run(Math.max(row.updated, Date.now()), taskId);
      return "updated";
    });
  }

  /** Call only after the executor has confirmed its workers have stopped. */
  finishCancellation(taskId: string): TaskTransition {
    this.active();
    return transaction(this.database, () => {
      const row = this.row(taskId);
      if (row.status !== "working") return "terminal";
      if (!row.cancelling) throw new Error("Cancellation was not requested");
      this.database
        .prepare(
          "UPDATE tasks SET status = 'cancelled', updated = ? WHERE id = ?",
        )
        .run(Math.max(row.updated, Date.now()), taskId);
      return "updated";
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } finally {
      this.ownership.close();
    }
  }
}

/** Open an exclusively owned, root- and disclosure-bound local validation store. */
export async function openTaskStore(
  options: TaskStoreOptions,
): Promise<ValidationTaskStore> {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Task storage is supported only on macOS and Linux");
  const root = realpathSync(options.root);
  if (!lstatSync(root).isDirectory())
    throw new Error("Task root must be a directory");
  const directory = path.resolve(options.directory);
  if (realpathSync(path.dirname(directory)) !== path.dirname(directory))
    throw new Error("Task store parent must be canonical");
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error(
      "Task store directory must be private and owned by this user",
    );
  const limits: Record<string, number> = {
    "owner.sqlite": 4096,
    "owner.sqlite-journal": 16384,
    "tasks.sqlite": MAX_DATABASE_BYTES,
    "tasks.sqlite-journal": MAX_DATABASE_BYTES + 1024 * 1024,
  };
  for (const entry of readdirSync(directory)) {
    const limit = limits[entry];
    if (typeof limit !== "number")
      throw new Error("Unexpected file in task store directory");
    privateFile(path.join(directory, entry), limit);
  }
  privateFile(path.join(directory, "owner.sqlite"), 4096);
  const { DatabaseSync } = await import("node:sqlite");
  const ownership = new DatabaseSync(path.join(directory, "owner.sqlite"), {
    allowExtension: false,
  });
  let database: DatabaseSync | undefined;
  try {
    ownership.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    if (
      applicationId(ownership) === 0 &&
      !ownership.prepare("SELECT name FROM sqlite_schema LIMIT 1").get()
    ) {
      ownership.exec(
        `PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1; COMMIT; BEGIN EXCLUSIVE`,
      );
    }
    if (
      applicationId(ownership) !== APPLICATION_ID ||
      ownership.prepare("PRAGMA user_version").get()!.user_version !== 1
    )
      throw new Error("Unrecognized task ownership database");
    privateFile(path.join(directory, "tasks.sqlite"), MAX_DATABASE_BYTES);
    database = new DatabaseSync(path.join(directory, "tasks.sqlite"), {
      allowExtension: false,
    });
    const db = database;
    const detailed = options.detailed === true;
    const scope = createHash("sha256")
      .update(JSON.stringify([root, detailed]))
      .digest("hex");
    const id = applicationId(db);
    if (
      id !== APPLICATION_ID &&
      !(id === 0 && !db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get())
    )
      throw new Error("Unrecognized validation task database");
    if (db.prepare("PRAGMA page_size").get()!.page_size !== 4096)
      throw new Error("Unsupported task database page size");
    db.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF; PRAGMA secure_delete = ON; PRAGMA max_page_count = 4096",
    );
    if (id === 0)
      transaction(db, () => {
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;
        CREATE TABLE metadata (scope TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, source TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL, cancelling INTEGER NOT NULL, result TEXT);
      `);
        db.prepare("INSERT INTO metadata VALUES (?)").run(scope);
      });
    const metadata = db.prepare("SELECT scope FROM metadata").all();
    if (
      db.prepare("PRAGMA user_version").get()!.user_version !== 1 ||
      metadata.length !== 1 ||
      metadata[0]!.scope !== scope
    )
      throw new Error(
        "Task store version, root or disclosure mode does not match",
      );
    if (db.prepare("PRAGMA quick_check").get()!.quick_check !== "ok")
      throw new Error("Task database integrity check failed");
    const store = new ValidationTaskStore(db, ownership, detailed);
    transaction(db, () => {
      const rows = db.prepare("SELECT * FROM tasks LIMIT 33").all();
      if (rows.length > MAX_TASKS)
        throw new Error("Task store exceeds task capacity");
      for (const row of rows) {
        const parsed = rowSchema.parse(row);
        decodeTask(parsed, detailed);
      }
      db.prepare("DELETE FROM tasks WHERE expires <= ?").run(Date.now());
      db.prepare(
        "UPDATE tasks SET status = 'completed', result = ?, updated = max(updated, ?) WHERE status = 'working'",
      ).run(JSON.stringify(interruptedResult), Date.now());
    });
    return store;
  } catch (error) {
    try {
      database?.close();
    } finally {
      ownership.close();
    }
    throw error;
  }
}
