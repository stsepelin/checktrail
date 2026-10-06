import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { runProcess } from "../dist/src/runner.js";
const root = await mkdtemp(
  path.join(tmpdir(), "checktrail-windows-diagnostic-"),
);
try {
  const result = await runProcess(
    root,
    {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('original native startup')"],
      cwd: ".",
    },
    { timeoutMs: 10000 },
  );
  process.stdout.write(
    JSON.stringify({
      scope:
        "Original synthetic Windows startup diagnostic; not an acceptance result",
      node: process.version,
      platform: process.platform,
      result,
    }) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
