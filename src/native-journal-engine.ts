import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Command } from "./types.js";
import type { NativeJournalCapture } from "./native-journal-capture.js";
import { createNativeAttemptStorage } from "./native-attempt-storage.js";
import type { NativeJournalHeader } from "./native-attempt-frames.js";
const names = [
  "actionlint",
  "checkstyle",
  "clang",
  "cpp-extensions",
  "cpp-tools",
  "detekt",
  "dotnet-build",
  "dotnet",
  "external",
  "go-build",
  "golangci",
  "helm-extensions",
  "helm",
  "java",
  "kotlin",
  "kubeconform",
  "kustomize",
  "pyright",
  "ruby-tools",
  "rust",
  "rustfmt",
  "scala",
  "spotbugs",
  "swift-extensions",
  "swift-tools",
  "swift-version",
  "terraform-extensions",
  "terraform",
  "scala2",
  "scala-extensions",
  "spotbugs-extensions",
  "gradle",
  "maven",
  "fsharp-format",
  "kotlin-extensions",
  "detekt-extensions",
  "rust-workspace",
] as const;
const entries = new Map(
  names.map((name) => [
    fileURLToPath(new URL("./" + name + "-runner.js", import.meta.url)),
    name,
  ]),
);
const hash = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
export function nativeOuterCommandSha256(command: {
  executable: string;
  args: string[];
  cwd: string;
  temporaryDirectory?: boolean | undefined;
  env?: Record<string, string> | undefined;
}): string {
  const values = {
    ...command,
    ...(command.env
      ? {
          env: Object.fromEntries(
            Object.entries(command.env).sort(([a], [b]) =>
              a.localeCompare(b, "en"),
            ),
          ),
        }
      : {}),
  };
  return hash(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(values)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b, "en")),
      ),
    ),
  );
}

export function nativeWrapperEntry(command: Command): string | undefined {
  const name = entries.get(command.args[0] ?? "");
  // These exact identity paths validate metadata without reaching a native call.
  // They keep outer process capture; execution paths still require a journal.
  if (
    (name === "external" &&
      command.args.length === 3 &&
      command.args[1] === "--version") ||
    (name === "fsharp-format" &&
      command.args.length === 4 &&
      command.args[3] === "--version")
  )
    return undefined;
  return command.executable === process.execPath &&
    command.args[0] &&
    entries.has(command.args[0])
    ? command.args[0]
    : undefined;
}
export interface EngineNativeJournal {
  expectedHeader: NativeJournalHeader;
  producer: { name: string; beforeSha256: string; afterSha256: string | null };
  status: "collected" | "unavailable";
  capture?: NativeJournalCapture;
  errorCode?:
    "NATIVE_JOURNAL_STORAGE_UNAVAILABLE" | "NATIVE_JOURNAL_PRODUCER_CHANGED";
  cleanupErrorCode?: "NATIVE_JOURNAL_CLEANUP_UNAVAILABLE";
}
function producerHash(entry: string) {
  const stat = lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw Error("Native wrapper producer unavailable");
  const bytes = readFileSync(entry);
  if (bytes.length !== stat.size)
    throw Error("Native wrapper producer changed");
  return hash(bytes);
}
/** Engine-only preparation, after operator trust. Standalone project commands
 * keep outer capture; only exact shipped Node entrypoints receive this channel.
 */
export function prepareEngineNativeJournal(
  command: Command,
  sourceFingerprint: string,
  maxOutputBytes: number,
) {
  const entry = nativeWrapperEntry(command);
  if (!entry) return undefined;
  const beforeSha256 = producerHash(entry);
  const storage = createNativeAttemptStorage({
    schemaVersion: 1,
    format: "native-attempt-journal",
    journalId: randomUUID(),
    sourceFingerprint,
    outerCommandSha256: nativeOuterCommandSha256(command),
    maxNativeCalls: 4096,
    maxOutputBytes,
  });
  const producer = {
    name: entries.get(entry)!,
    beforeSha256,
    afterSha256: null as string | null,
  };
  const cleanup = () => storage.destroy();
  return {
    context: storage.context,
    cleanup,
    collect(): EngineNativeJournal {
      let result: EngineNativeJournal = {
        expectedHeader: storage.header,
        producer,
        status: "unavailable",
      };
      try {
        result = { ...result, status: "collected", capture: storage.capture() };
        try {
          producer.afterSha256 = producerHash(entry);
        } catch {
          result.errorCode = "NATIVE_JOURNAL_PRODUCER_CHANGED";
        }
        if (producer.afterSha256 !== beforeSha256)
          result.errorCode = "NATIVE_JOURNAL_PRODUCER_CHANGED";
      } catch {
        result.errorCode = "NATIVE_JOURNAL_STORAGE_UNAVAILABLE";
      }
      try {
        cleanup();
      } catch {
        result.cleanupErrorCode = "NATIVE_JOURNAL_CLEANUP_UNAVAILABLE";
      }
      return result;
    },
  };
}
export function nativeJournalAllowsParserPass(
  value: EngineNativeJournal,
): boolean {
  return (
    value.status === "collected" &&
    !value.errorCode &&
    !value.cleanupErrorCode &&
    value.producer.beforeSha256 === value.producer.afterSha256 &&
    value.capture?.state === "complete" &&
    value.capture.replay?.completeForRecordedCalls === true &&
    value.capture.replay.attempts.length > 0
  );
}
