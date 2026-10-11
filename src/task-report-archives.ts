import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { reportSchema } from "./schemas.js";
import type { Report } from "./types.js";

export const taskArchiveLimits = Object.freeze({
  chunkBytes: 64 * 1024,
  reportBytes: 32 * 1024 * 1024,
  retainedBytes: 64 * 1024 * 1024,
  databaseBytes: 96 * 1024 * 1024,
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const taskArchiveManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    format: z.literal("checktrail-report-json-v1"),
    taskId: z.string().uuid(),
    sourceFingerprint: sha256,
    reportSha256: sha256,
    bytes: z.number().int().min(1).max(taskArchiveLimits.reportBytes),
    chunkBytes: z.literal(taskArchiveLimits.chunkBytes),
    chunks: z
      .number()
      .int()
      .min(1)
      .max(taskArchiveLimits.reportBytes / taskArchiveLimits.chunkBytes),
  })
  .superRefine((value, context) => {
    if (value.chunks !== Math.ceil(value.bytes / value.chunkBytes))
      context.addIssue({
        code: "custom",
        message: "Archive chunk accounting differs",
      });
  });
export const taskArchiveChunkSchema = z
  .strictObject({
    archive: taskArchiveManifestSchema,
    index: z.number().int().nonnegative(),
    bytes: z.number().int().min(1).max(taskArchiveLimits.chunkBytes),
    sha256,
    bodyBase64: z
      .string()
      .min(4)
      .max(4 * Math.ceil(taskArchiveLimits.chunkBytes / 3)),
  })
  .superRefine((value, context) => {
    const bytes = Buffer.from(value.bodyBase64, "base64");
    if (
      value.index >= value.archive.chunks ||
      value.bytes !==
        Math.min(
          value.archive.chunkBytes,
          value.archive.bytes - value.index * value.archive.chunkBytes,
        ) ||
      bytes.length !== value.bytes ||
      bytes.toString("base64") !== value.bodyBase64 ||
      digest(bytes) !== value.sha256
    )
      context.addIssue({
        code: "custom",
        message: "Archive chunk bytes, address or digest differ",
      });
  });
export type TaskArchiveManifest = z.infer<typeof taskArchiveManifestSchema>;
export type TaskArchiveChunk = z.infer<typeof taskArchiveChunkSchema>;
export const archivedTaskResult = Object.freeze({
  content: [
    {
      type: "text",
      text: "Detailed validation exceeds the inline result limit. Its exact report was retained privately; use validation_archive_read with this task ID and successive chunk indexes. Task completion does not mean validation passed.",
    },
  ],
  isError: true,
});
export const isArchivedTaskResult = (result: string | null): boolean =>
  result === JSON.stringify(archivedTaskResult);

export function installTaskReportArchives(db: DatabaseSync): void {
  db.exec(`CREATE TABLE task_archives (id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, manifest TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= ${taskArchiveLimits.reportBytes}));
CREATE TABLE task_archive_chunks (id TEXT NOT NULL REFERENCES task_archives(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL CHECK(ordinal >= 0), body BLOB NOT NULL CHECK(length(body) > 0 AND length(body) <= ${taskArchiveLimits.chunkBytes}), sha256 TEXT NOT NULL, PRIMARY KEY(id, ordinal));`);
}

/** All writes belong to the caller's task completion transaction. No project code is executed. */
export class TaskReportArchives {
  constructor(
    private readonly db: DatabaseSync,
    private readonly detailed: boolean,
  ) {}
  manifest(taskId: string, source: string): TaskArchiveManifest | undefined {
    const row = this.db
      .prepare("SELECT manifest, bytes FROM task_archives WHERE id = ?")
      .get(taskId);
    if (!row) return undefined;
    if (!this.detailed)
      throw new Error("Task archives require startup detail permission");
    const manifest = taskArchiveManifestSchema.parse(
      JSON.parse(String(row.manifest)),
    );
    if (
      manifest.taskId !== taskId ||
      manifest.sourceFingerprint !== source ||
      manifest.bytes !== row.bytes
    )
      throw new Error("Task archive identity differs");
    return manifest;
  }
  retain(taskId: string, source: string, report: Report): void {
    if (!this.detailed)
      throw new Error("Task archives require startup detail permission");
    reportSchema.parse(report);
    if (report.sourceFingerprint !== source)
      throw new Error("Task archive source differs");
    const bytes = Buffer.from(JSON.stringify(report), "utf8");
    if (bytes.length > taskArchiveLimits.reportBytes)
      throw new Error("Task archive exceeds the report byte limit");
    const retained = Number(
      this.db
        .prepare("SELECT coalesce(sum(bytes), 0) AS bytes FROM task_archives")
        .get()!.bytes,
    );
    if (retained + bytes.length > taskArchiveLimits.retainedBytes)
      throw new Error("Task archive capacity reached");
    const manifest = taskArchiveManifestSchema.parse({
      schemaVersion: 1,
      format: "checktrail-report-json-v1",
      taskId,
      sourceFingerprint: source,
      reportSha256: digest(bytes),
      bytes: bytes.length,
      chunkBytes: taskArchiveLimits.chunkBytes,
      chunks: Math.ceil(bytes.length / taskArchiveLimits.chunkBytes),
    });
    this.db
      .prepare("INSERT INTO task_archives VALUES (?, ?, ?)")
      .run(taskId, JSON.stringify(manifest), bytes.length);
    const insert = this.db.prepare(
      "INSERT INTO task_archive_chunks VALUES (?, ?, ?, ?)",
    );
    for (let index = 0; index < manifest.chunks; index++) {
      const chunk = bytes.subarray(
        index * manifest.chunkBytes,
        (index + 1) * manifest.chunkBytes,
      );
      insert.run(taskId, index, chunk, digest(chunk));
    }
  }
  read(taskId: string, source: string, index: number): TaskArchiveChunk {
    z.number().int().nonnegative().parse(index);
    const archive = this.manifest(taskId, source);
    if (!archive || index >= archive.chunks)
      throw new Error("Task archive chunk unavailable");
    const row = this.db
      .prepare(
        "SELECT body, sha256 FROM task_archive_chunks WHERE id = ? AND ordinal = ? AND length(body) BETWEEN 1 AND ?",
      )
      .get(taskId, index, taskArchiveLimits.chunkBytes);
    if (!row || !(row.body instanceof Uint8Array))
      throw new Error("Task archive chunk unavailable");
    const body = Buffer.from(row.body);
    return taskArchiveChunkSchema.parse({
      archive,
      index,
      bytes: body.length,
      sha256: row.sha256,
      bodyBase64: body.toString("base64"),
    });
  }
  validateAll(
    rows: readonly {
      id: string;
      source: string;
      status: string;
      result: string | null;
    }[],
  ): void {
    const total = this.db
      .prepare(
        "SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM task_archives",
      )
      .get()!;
    if (
      Number(total.count) > rows.length ||
      Number(total.bytes) > taskArchiveLimits.retainedBytes ||
      Number(total.bytes) < 0
    )
      throw new Error("Task archive capacity or ownership differs");
    if (this.db.prepare("PRAGMA foreign_key_check").all().length !== 0)
      throw new Error("Task archive has orphaned artifacts");
    let observed = 0;
    for (const row of rows) {
      const manifest = this.manifest(row.id, row.source);
      if (
        Boolean(manifest) !== isArchivedTaskResult(row.result) ||
        (manifest && row.status !== "completed")
      )
        throw new Error("Task archive and terminal state disagree");
      if (!manifest) continue;
      observed++;
      const count = Number(
        this.db
          .prepare(
            "SELECT count(*) AS count FROM task_archive_chunks WHERE id = ?",
          )
          .get(row.id)!.count,
      );
      if (count !== manifest.chunks)
        throw new Error("Task archive chunk accounting differs");
      const chunks = [];
      for (let index = 0; index < manifest.chunks; index++)
        chunks.push(
          Buffer.from(
            this.read(row.id, row.source, index).bodyBase64,
            "base64",
          ),
        );
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== manifest.bytes ||
        digest(bytes) !== manifest.reportSha256
      )
        throw new Error("Task archive report digest differs");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      const report = reportSchema.parse(value);
      if (
        report.sourceFingerprint !== row.source ||
        !Buffer.from(JSON.stringify(value), "utf8").equals(bytes)
      )
        throw new Error("Task archive report representation differs");
    }
    if (observed !== Number(total.count))
      throw new Error("Task archive has unknown task ownership");
  }
}
