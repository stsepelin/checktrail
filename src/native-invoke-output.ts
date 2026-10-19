import { invokeNative, type NativeInvocationResult } from "./native-invoke.js";
import type { NativeAttemptWriter } from "./native-attempt-storage.js";

export interface NativeOutputOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout?: number;
  encoding?: "utf8";
  stdio?: readonly ["ignore", "pipe", "pipe"];
  signal?: AbortSignal;
  journal?: NativeAttemptWriter;
}
export type NativeOutputResult = NativeInvocationResult & {
  nativeExitCode: number | null;
};
export type NativeTextResult = Omit<NativeOutputResult, "stdout" | "stderr"> & {
  stdout: string;
  stderr: string;
};
export function invokeNativeOutput(
  executable: string,
  args: string[],
  options: NativeOutputOptions & { encoding: "utf8" },
): Promise<NativeTextResult>;
export function invokeNativeOutput(
  executable: string,
  args: string[],
  options: NativeOutputOptions & { encoding?: undefined },
): Promise<NativeOutputResult>;
/** Async adapter for wrapper parsers. The byte bound is shared across both streams;
 * raw capture precedes UTF-8 replacement decoding, including nonzero exits.
 * Execution authority and any journal belong to the caller.
 */
export async function invokeNativeOutput(
  executable: string,
  args: string[],
  options: NativeOutputOptions,
): Promise<NativeTextResult | NativeOutputResult> {
  if (
    (options.encoding !== undefined && options.encoding !== "utf8") ||
    (options.stdio !== undefined &&
      (options.stdio.length !== 3 ||
        options.stdio[0] !== "ignore" ||
        options.stdio[1] !== "pipe" ||
        options.stdio[2] !== "pipe"))
  )
    throw Error("Invalid native output mode");
  const result = await invokeNative(executable, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.journal ? { journal: options.journal } : {}),
    maxOutputBytes: options.maxBuffer,
    timeoutMs: options.timeout ?? 110000,
  });
  const receipt = nativeOutputReceipt(result);
  return options.encoding === "utf8"
    ? {
        ...receipt,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      }
    : receipt;
}

/** Physical exit and parser completion are separate when capture failed. */
export function nativeOutputReceipt(
  result: NativeInvocationResult,
): NativeOutputResult {
  return {
    ...result,
    nativeExitCode: result.status,
    status: result.error ? null : result.status,
  };
}
