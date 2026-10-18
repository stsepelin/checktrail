import { createHash } from "node:crypto";
import { invokeNative } from "./native-invoke.js";
import type { NativeAttemptWriter } from "./native-attempt-storage.js";
export interface JvmInvocationResult {
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
  pid: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdout: string;
  stderr: string;
}
export type JvmInvoke = (
  tool: string,
  args: string[],
  cwd?: string,
) => Promise<JvmInvocationResult>;
export function jvmInvoker(
  env: NodeJS.ProcessEnv,
  mirror = true,
  observe?: (chunk: Buffer) => void,
  journal?: NativeAttemptWriter,
): JvmInvoke {
  return async (tool, args, cwd) => {
    const result = await invokeNative(tool, args, {
      env,
      ...(cwd ? { cwd } : {}),
      maxOutputBytes: 2 * 1024 * 1024,
      timeoutMs: 110000,
      ...(journal ? { journal } : {}),
      ...(observe ? { observe: (chunk: Buffer) => observe(chunk) } : {}),
      ...(mirror ? { mirror: process.stderr } : {}),
    });
    if (result.error) throw result.error;
    if (!result.pid) throw Error("JVM native process identity unavailable");
    return {
      status: result.status,
      signal: result.signal,
      pid: result.pid,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      stdoutSha256: createHash("sha256").update(result.stdout).digest("hex"),
      stderrSha256: createHash("sha256").update(result.stderr).digest("hex"),
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
      stderr: new TextDecoder("utf-8", { fatal: true }).decode(result.stderr),
    };
  };
}
