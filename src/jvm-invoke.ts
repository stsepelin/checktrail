import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
): JvmInvoke {
  return (tool, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(tool, args, {
        env,
        ...(cwd ? { cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let bytes = 0,
        exhausted = false;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          exhausted = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(Buffer.from(chunk));
        observe?.(chunk);
        if (mirror && !process.stderr.write(chunk)) {
          child.stdout.pause();
          child.stderr.pause();
          process.stderr.once("drain", () => {
            child.stdout.resume();
            child.stderr.resume();
          });
        }
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", reject);
      child.once("close", (status, signal) => {
        if (exhausted) {
          reject(Error("JVM native output bound exhausted"));
          return;
        }
        if (!child.pid) {
          reject(Error("JVM native process identity unavailable"));
          return;
        }
        try {
          const out = Buffer.concat(stdout),
            err = Buffer.concat(stderr);
          resolve({
            status,
            signal,
            pid: child.pid,
            stdoutBytes: out.length,
            stderrBytes: err.length,
            stdoutSha256: createHash("sha256").update(out).digest("hex"),
            stderrSha256: createHash("sha256").update(err).digest("hex"),
            stdout: new TextDecoder("utf-8", { fatal: true }).decode(out),
            stderr: new TextDecoder("utf-8", { fatal: true }).decode(err),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
}
