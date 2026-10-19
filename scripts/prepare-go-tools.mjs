import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { acquirePinnedGoAnalyzer } from "./retry-go-acquisition.mjs";

const bin = path.join(process.cwd(), ".checktrail/go-tools/bin");
await mkdir(bin, { recursive: true });
const env = { ...process.env, GOBIN: bin };
const invoke = (executable, args, timeout, maxBuffer) => {
  const result = spawnSync(executable, args, {
    env,
    encoding: "utf8",
    timeout,
    maxBuffer,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Object.assign(new Error("Pinned Go analyzer command failed"), {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  return result.stdout;
};
for (const tool of [
  {
    module: "honnef.co/go/tools/cmd/staticcheck@v0.8.1",
    name: "staticcheck",
    version: ["-version"],
  },
  {
    module: "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2",
    name: "golangci-lint",
    version: ["version", "--short"],
  },
]) {
  await acquirePinnedGoAnalyzer({
    invoke: () => invoke("go", ["install", tool.module], 300000, 2 * 1048576),
    onRetry: ({ attempt, delayMs }) =>
      process.stderr.write(
        JSON.stringify({
          stage: "go-analyzer-acquisition-retry",
          analyzer: tool.name,
          failedAttempt: attempt,
          delayMs,
        }) + "\n",
      ),
  });
  invoke(
    path.join(bin, tool.name + (process.platform === "win32" ? ".exe" : "")),
    tool.version,
    15000,
    65536,
  );
}
