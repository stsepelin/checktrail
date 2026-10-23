import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

const limits = Object.freeze({
  files: 4096,
  entries: 8192,
  depth: 24,
  fileBytes: 8 * 1048576,
  totalBytes: 128 * 1048576,
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
class EvidenceError extends Error {}
function requireValue(condition, message) {
  if (!condition) throw new EvidenceError(message);
}
const sameStat = (a, b) =>
  ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );

// See docs/COMPILED-ENGINE-EVIDENCE.md for the deliberately limited scope.
// This snapshots the configured engine artifact, not the modules actually loaded
// by a worker, its dependencies, producer source or the host filesystem closure.
export async function captureCompiledEngine(directory) {
  try {
    // Installed harnesses deliberately alias dist/src to the fresh package.
    // Resolve that one root alias; links within the artifact remain inadmissible.
    const root = await realpath(directory);
    const files = [];
    let bytes = 0,
      entriesObserved = 0;
    async function walk(relative, depth) {
      requireValue(
        depth <= limits.depth,
        "Compiled engine directory depth exceeded",
      );
      const absolute = path.join(root, relative);
      const before = await lstat(absolute, { bigint: true });
      requireValue(
        before.isDirectory(),
        "Compiled engine directory is not regular",
      );
      const entries = [];
      const directoryHandle = await opendir(absolute);
      for await (const entry of directoryHandle) {
        requireValue(
          ++entriesObserved <= limits.entries,
          "Compiled engine directory entry limit exceeded",
        );
        entries.push(entry);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const entry of entries) {
        const name = path.join(relative, entry.name);
        requireValue(
          !entry.isSymbolicLink(),
          "Compiled engine contains a nested link",
        );
        if (entry.isDirectory()) {
          await walk(name, depth + 1);
          continue;
        }
        requireValue(
          entry.isFile(),
          "Compiled engine contains a nonregular entry",
        );
        requireValue(
          files.length < limits.files,
          "Compiled engine file count exceeded",
        );
        const full = path.join(root, name);
        const entryStat = await lstat(full, { bigint: true });
        requireValue(entryStat.isFile(), "Compiled engine file is not regular");
        requireValue(
          entryStat.size <= BigInt(limits.fileBytes),
          "Compiled engine file byte limit exceeded",
        );
        requireValue(
          BigInt(bytes) + entryStat.size <= BigInt(limits.totalBytes),
          "Compiled engine total byte limit exceeded",
        );
        const handle = await open(
          full,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        );
        let total = 0;
        const digest = createHash("sha256");
        try {
          const opened = await handle.stat({ bigint: true });
          requireValue(
            opened.isFile() && sameStat(entryStat, opened),
            "Compiled engine file identity changed before reading",
          );
          const buffer = Buffer.alloc(65536);
          while (true) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, limits.fileBytes + 1 - total),
              null,
            );
            if (!bytesRead) break;
            total += bytesRead;
            requireValue(
              total <= limits.fileBytes,
              "Compiled engine file byte limit exceeded",
            );
            requireValue(
              bytes + total <= limits.totalBytes,
              "Compiled engine total byte limit exceeded",
            );
            digest.update(buffer.subarray(0, bytesRead));
          }
          const after = await handle.stat({ bigint: true });
          const named = await lstat(full, { bigint: true });
          requireValue(
            named.isFile() &&
              sameStat(opened, after) &&
              sameStat(opened, named) &&
              BigInt(total) === opened.size,
            "Compiled engine file changed while reading",
          );
        } finally {
          await handle.close();
        }
        bytes += total;
        files.push({
          file: name.split(path.sep).join("/"),
          bytes: total,
          sha256: digest.digest("hex"),
        });
      }
      const after = await lstat(absolute, { bigint: true });
      requireValue(
        after.isDirectory() && sameStat(before, after),
        "Compiled engine directory changed while reading",
      );
    }
    await walk("", 0);
    requireValue(
      files.length > 0 && bytes > 0,
      "Compiled engine artifact is empty",
    );
    return {
      schemaVersion: 1,
      scope:
        "Regular files beneath the configured compiled engine root; root aliases resolved, nested links rejected. Not a loaded-module, dependency, producer-source or host identity trace.",
      fileCount: files.length,
      bytes,
      treeSha256: hash(
        JSON.stringify(files.map((file) => [file.file, file.sha256])),
      ),
      manifestSha256: hash(JSON.stringify(files)),
      files,
      limits,
    };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError(
      "Compiled engine filesystem observation unavailable",
    );
  }
}

export function requireUnchangedCompiledEngine(before, after) {
  requireValue(
    before.schemaVersion === 1 &&
      after.schemaVersion === 1 &&
      before.fileCount === after.fileCount &&
      before.bytes === after.bytes &&
      before.treeSha256 === after.treeSha256 &&
      before.manifestSha256 === after.manifestSha256,
    "Compiled engine bytes changed during required test execution",
  );
  return {
    ...before,
    afterTreeSha256: after.treeSha256,
    afterManifestSha256: after.manifestSha256,
    beforeAfterByteIdentitiesMatch: true,
    dependencyBytesCaptured: false,
    actualModuleLoadsTraced: false,
    producerSourceBuildVerified: false,
  };
}
