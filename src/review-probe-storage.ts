import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureWindowsTaskAccess } from "./windows-task-access.js";

/** Establish an empty private namespace before any captured source is copied. */
export async function createPrivateProbeWorkspace(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "checktrail-probe-"));
  try {
    const directory = await realpath(created);
    if (process.platform === "win32")
      ensureWindowsTaskAccess(directory, "directory", true);
    return directory;
  } catch (error) {
    try {
      await rm(created, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Private probe workspace initialization and cleanup failed",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
