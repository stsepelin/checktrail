import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runFullSuiteShard } from "./ci-full-suite-shards.mjs";
const match = /^--shard([012])$/u.exec(process.argv[2] ?? "");
assert.ok(
  match && process.argv.length >= 3,
  "Use --shard0|--shard1|--shard2 and required profiles",
);
const report = await runFullSuiteShard(
  fileURLToPath(new URL("../", import.meta.url)),
  match[1],
  process.argv.slice(3),
);
process.stderr.write(
  JSON.stringify({
    kind: "full-suite-shard-timing",
    shard: report.shard,
    elapsedMilliseconds: report.elapsedMilliseconds,
    files: report.assignedFiles.length,
    durationScope:
      "Inclusive callback sums may overlap; they are scheduling hints, not per-file wall times",
    slowestFiles: report.timingHints
      .toSorted(
        (a, b) =>
          (b.inclusiveCallbackDurationMs ?? 0) -
          (a.inclusiveCallbackDurationMs ?? 0),
      )
      .slice(0, 10),
  }) + "\n",
);
process.stdout.write(JSON.stringify(report) + "\n");
process.exitCode = report.fragmentComplete ? 0 : 1;
