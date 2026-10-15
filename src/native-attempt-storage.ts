import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ensureWindowsTaskAccess } from "./windows-task-access.js";
import {
  nativeJournalHeaderSchema,
  nativeAttemptFrameSchema,
  replayNativeAttemptFrames,
  type NativeJournalHeader,
  type NativeAttemptFrame,
} from "./native-attempt-frames.js";
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024,
  MAX_HEADER_BYTES = 4096;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const contextSchema = z.strictObject({
  directory: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !value.includes("\0")),
  headerSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeJournalContext = z.infer<typeof contextSchema>;
type Stat = ReturnType<typeof lstatSync>;
function directory(filename: string, created = false) {
  if (!path.isAbsolute(filename) || realpathSync(filename) !== filename)
    throw new Error("Native journal requires a canonical directory");
  const stat = lstatSync(filename);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700))
  )
    throw new Error("Native journal requires a private owned directory");
  if (process.platform === "win32")
    ensureWindowsTaskAccess(filename, "directory", created);
  return stat;
}
function file(filename: string, fd: number, maximum: number, created = false) {
  const before = lstatSync(filename),
    stat = fstatSync(fd);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.dev !== before.dev ||
    stat.ino !== before.ino ||
    stat.size > maximum ||
    (process.platform !== "win32" &&
      (stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600))
  )
    throw new Error(
      "Native journal requires bounded private singly linked files",
    );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(filename, "file", created);
  return stat;
}
function writeAll(fd: number, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length;) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error("Native journal write did not progress");
    offset += written;
  }
}
function readBounded(fd: number, maximum: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const bytes = Buffer.alloc(Math.min(65536, maximum + 1 - total));
    const n = readSync(fd, bytes, 0, bytes.length, total);
    if (!n) break;
    total += n;
    if (total > maximum)
      throw new Error("Native journal exceeds its storage bound");
    chunks.push(bytes.subarray(0, n));
  }
  return Buffer.concat(chunks);
}
/** All target files exist and are validated before the header is written. */
export function createNativeAttemptStorage(headerInput: unknown) {
  const header = nativeJournalHeaderSchema.parse(headerInput);
  const bytes = Buffer.from(JSON.stringify(header) + "\n");
  if (bytes.length > MAX_HEADER_BYTES)
    throw new Error("Native journal header exceeds its bound");
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "checktrail-native-attempt-")),
  );
  let headerFd: number | undefined,
    logFd: number | undefined,
    identity: Stat | undefined,
    destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    if (headerFd !== undefined) {
      closeSync(headerFd);
      headerFd = undefined;
    }
    if (logFd !== undefined) {
      closeSync(logFd);
      logFd = undefined;
    }
    const now = lstatSync(root);
    if (
      identity &&
      (now.dev !== identity.dev ||
        now.ino !== identity.ino ||
        now.isSymbolicLink())
    )
      throw new Error("Native journal directory changed before cleanup");
    rmSync(root, { recursive: true, force: false });
    destroyed = true;
  };
  try {
    identity = lstatSync(root);
    directory(root, true);
    headerFd = openSync(
      path.join(root, "header.json"),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    logFd = openSync(
      path.join(root, "frames.jsonl"),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    const headerIdentity = file(
      path.join(root, "header.json"),
      headerFd,
      MAX_HEADER_BYTES,
      true,
    );
    const logIdentity = file(
      path.join(root, "frames.jsonl"),
      logFd,
      MAX_JOURNAL_BYTES,
      true,
    );
    writeAll(headerFd, bytes);
    const context = { directory: root, headerSha256: hash(bytes) };
    return {
      context,
      header,
      destroy,
      read() {
        directory(root);
        const h = file(
            path.join(root, "header.json"),
            headerFd!,
            MAX_HEADER_BYTES,
          ),
          l = file(path.join(root, "frames.jsonl"), logFd!, MAX_JOURNAL_BYTES);
        if (
          h.dev !== headerIdentity.dev ||
          h.ino !== headerIdentity.ino ||
          l.dev !== logIdentity.dev ||
          l.ino !== logIdentity.ino
        )
          throw new Error("Native journal file identity changed");
        const observedHeader = readBounded(headerFd!, MAX_HEADER_BYTES);
        if (hash(observedHeader) !== context.headerSha256)
          throw new Error("Native journal header changed");
        const raw = readBounded(logFd!, MAX_JOURNAL_BYTES),
          text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        if (text && !text.endsWith("\n"))
          throw new Error("Native journal ends in a partial frame");
        const lines = text ? text.slice(0, -1).split("\n") : [];
        if (lines.some((line) => line.length === 0))
          throw new Error("Native journal contains an empty frame");
        const frames = lines.map((line) => JSON.parse(line) as unknown);
        return {
          ...replayNativeAttemptFrames(header, frames, header),
          journalBytes: raw.length,
          journalSha256: hash(raw),
        };
      },
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
type Input<T> = T extends unknown ? Omit<T, "sequence" | "journalId"> : never;
/** One held descriptor per wrapper: no repeated ACL subprocess for every output chunk. */
export class NativeAttemptWriter {
  readonly header: NativeJournalHeader;
  #fd: number;
  #sequence = 0;
  #fileBytes = 0;
  #retained = 0;
  #closed = false;
  #calls = new Map<string, { pid: number | null; terminal: boolean }>();
  constructor(contextInput: unknown) {
    const context = contextSchema.parse(contextInput);
    directory(context.directory);
    const h = openSync(
      path.join(context.directory, "header.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      file(path.join(context.directory, "header.json"), h, MAX_HEADER_BYTES);
      const bytes = readBounded(h, MAX_HEADER_BYTES);
      if (hash(bytes) !== context.headerSha256)
        throw new Error("Native journal writer has a foreign header");
      this.header = nativeJournalHeaderSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
    } finally {
      closeSync(h);
    }
    this.#fd = openSync(
      path.join(context.directory, "frames.jsonl"),
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
    try {
      const stat = file(
        path.join(context.directory, "frames.jsonl"),
        this.#fd,
        MAX_JOURNAL_BYTES,
      );
      if (stat.size !== 0)
        throw new Error("Native journal writer cannot resume a prior stream");
    } catch (error) {
      closeSync(this.#fd);
      throw error;
    }
  }
  #append(input: Input<NativeAttemptFrame>) {
    if (this.#closed) throw new Error("Native journal writer is closed");
    const frame = nativeAttemptFrameSchema.parse({
      ...input,
      journalId: this.header.journalId,
      sequence: this.#sequence,
    });
    const stat = fstatSync(this.#fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== this.#fileBytes ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600))
    )
      throw new Error("Native journal descriptor changed outside its writer");
    const bytes = Buffer.from(JSON.stringify(frame) + "\n");
    if (
      this.#sequence >= 65536 ||
      this.#fileBytes + bytes.length > MAX_JOURNAL_BYTES
    )
      throw new Error("Native journal frame/storage allowance exhausted");
    writeAll(this.#fd, bytes);
    this.#sequence++;
    this.#fileBytes += bytes.length;
  }
  admit(commandSha256: string) {
    if (this.#calls.size >= this.header.maxNativeCalls)
      throw new Error("Native journal call allowance exhausted");
    const attemptId = randomUUID();
    this.#append({ type: "admitted", attemptId, commandSha256 });
    this.#calls.set(attemptId, { pid: null, terminal: false });
    return attemptId;
  }
  started(attemptId: string, pid: number) {
    const call = this.#active(attemptId);
    if (call.pid !== null)
      throw new Error("Native journal process already acknowledged");
    this.#append({ type: "started", attemptId, pid });
    call.pid = pid;
  }
  output(attemptId: string, stream: "stdout" | "stderr", bytes: Buffer) {
    const call = this.#active(attemptId);
    if (call.pid === null)
      throw new Error("Native journal process not acknowledged");
    let cut = false;
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      const chunk = bytes.subarray(offset, offset + 65536),
        keep = Math.min(
          chunk.length,
          this.header.maxOutputBytes - this.#retained,
        ),
        retained = chunk.subarray(0, keep);
      this.#append({
        type: "output",
        attemptId,
        stream,
        observedBytes: chunk.length,
        retainedBytes: keep,
        base64: retained.toString("base64"),
        sha256: hash(retained),
      });
      this.#retained += keep;
      cut ||= keep !== chunk.length;
    }
    return cut;
  }
  terminal(input: Extract<Input<NativeAttemptFrame>, { type: "terminal" }>) {
    const call = this.#active(input.attemptId);
    this.#append(input);
    call.terminal = true;
  }
  #active(id: string) {
    const value = this.#calls.get(id);
    if (!value || value.terminal)
      throw new Error("Native journal call is missing or terminal");
    return value;
  }
  close() {
    if (this.#closed) return;
    try {
      this.#append({
        type: "journal-end",
        admitted: this.#calls.size,
        terminal: [...this.#calls.values()].filter((call) => call.terminal)
          .length,
      });
    } finally {
      this.#closed = true;
      closeSync(this.#fd);
    }
  }
}
