import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
const nativeProcIo = {
  readText: (file: string) => readFile(file, "utf8"),
  readLink: (file: string) => readlink(file),
};
/** A rejected/unreadable PID is not evidence that the target process was reached. */
export async function readNativeProcCommand(
  pid: string,
  executable: string,
  io = nativeProcIo,
): Promise<string[] | null> {
  try {
    const args = (await io.readText(`/proc/${pid}/cmdline`)).split("\0");
    if (args[0] !== executable && args[0] !== path.basename(executable))
      return null;
    if ((await io.readLink(`/proc/${pid}/exe`)) !== executable) return null;
    return args;
  } catch (error) {
    if (
      ["ENOENT", "ESRCH", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return null;
    throw error;
  }
}

export interface NativeParentExpected {
  nodeInvocation: string;
  nodeExecutable: string;
  runner: string;
  root: string;
}
export interface NativeParentObservation {
  phase:
    | "tool-version-probe"
    | "validation-command"
    | "unrecognized-parent"
    | "identity-changed"
    | "unavailable"
    | "read-error";
  nativePid: number;
  parentPid: number | null;
}
function nativeStat(raw: string) {
  const closing = raw.lastIndexOf(")"),
    pid = raw.slice(0, raw.indexOf(" ")),
    fields = raw.slice(closing + 2).split(" ");
  if (
    closing < 0 ||
    !/^[1-9][0-9]{0,15}$/.test(pid) ||
    !/^[1-9][0-9]{0,15}$/.test(fields[1] ?? "") ||
    !/^[0-9]{1,32}$/.test(fields[19] ?? "")
  )
    return null;
  return { pid, parent: fields[1]!, start: fields[19]! };
}
/** Diagnostic classification only. It never credits a native body or changes
 * which process the acceptance fixture selects. Raw arguments are not returned.
 */
export async function readNativeProcParentPhase(
  pid: string,
  expected: NativeParentExpected,
  io = nativeProcIo,
): Promise<NativeParentObservation> {
  const result: NativeParentObservation = {
    phase: "unrecognized-parent",
    nativePid: Number(pid),
    parentPid: null,
  };
  try {
    if (!/^[1-9][0-9]{0,15}$/.test(pid)) return result;
    const child = nativeStat(await io.readText(`/proc/${pid}/stat`));
    if (!child || child.pid !== pid) return result;
    result.parentPid = Number(child.parent);
    const parent = nativeStat(await io.readText(`/proc/${child.parent}/stat`));
    const raw = await io.readText(`/proc/${child.parent}/cmdline`);
    const executable = await io.readLink(`/proc/${child.parent}/exe`);
    const parentAfter = nativeStat(
      await io.readText(`/proc/${child.parent}/stat`),
    );
    const childAfter = nativeStat(await io.readText(`/proc/${pid}/stat`));
    if (
      !parent ||
      !parentAfter ||
      !childAfter ||
      parent.pid !== child.parent ||
      parent.pid !== parentAfter.pid ||
      parent.start !== parentAfter.start ||
      child.pid !== childAfter.pid ||
      child.start !== childAfter.start ||
      child.parent !== childAfter.parent
    )
      return { ...result, phase: "identity-changed" };
    if (Buffer.byteLength(raw) > 256 * 1024 || !raw.endsWith("\0"))
      return result;
    const args = raw.slice(0, -1).split("\0");
    if (
      executable !== expected.nodeExecutable ||
      args[0] !== expected.nodeInvocation ||
      args[1] !== expected.runner ||
      args[2] !== expected.root ||
      !args[3]
    )
      return result;
    if (args.length === 5 && args[4] === "--version")
      return { ...result, phase: "tool-version-probe" };
    if (args.length === 4) return { ...result, phase: "validation-command" };
    return result;
  } catch (error) {
    return {
      ...result,
      phase: ["ENOENT", "ESRCH", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
        ? "unavailable"
        : "read-error",
    };
  }
}
/** Fixed scalar process fields only; stderr, paths, arguments and messages never
 * enter the additional diagnostic text.
 */
export function nativeProcessDiagnostic(process?: {
  exitCode?: number | null;
  signal?: string | null;
  cancelled?: boolean;
  timedOut?: boolean;
}) {
  return {
    present: process !== undefined,
    exitCode: Number.isInteger(process?.exitCode) ? process!.exitCode : null,
    signal:
      typeof process?.signal === "string" &&
      /^SIG[A-Z0-9]{1,12}$/.test(process.signal)
        ? process.signal
        : null,
    cancelled: process?.cancelled === true,
    timedOut: process?.timedOut === true,
  };
}
