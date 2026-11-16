import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runFullSuiteShard } from "./ci-full-suite-shards.mjs";
const match = /^--shard([012])$/u.exec(process.argv[2] ?? "");
assert.ok(
  match && process.argv.length >= 3,
  "Use --shard0|--shard1|--shard2 and required profiles",
);
assert.ok(
  process.env.CHECKTRAIL_PRESERVED_BASELINE === undefined ||
    process.env.CHECKTRAIL_PRESERVED_BASELINE === "" ||
    process.env.CHECKTRAIL_PRESERVED_BASELINE === "host-core",
  "Unknown preserved baseline controller selection",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
let report;
if (process.env.CHECKTRAIL_PRESERVED_BASELINE === "host-core") {
  const { runFullSuiteShardWithBaseline } =
    await import("./preserved-baseline-full-suite.mjs");
  const collected = await runFullSuiteShardWithBaseline(
    repository,
    match[1],
    process.argv.slice(3),
  );
  report = collected.report;
  process.stderr.write(
    JSON.stringify({
      kind: "preserved-baseline-fresh-fragment-evidence",
      ...collected.baselineEvidence,
    }) + "\n",
  );
  process.stderr.write(
    JSON.stringify({
      kind: "preserved-baseline-fresh-fragment",
      ...collected.baseline,
    }) + "\n",
  );
} else {
  report = await runFullSuiteShard(repository, match[1], process.argv.slice(3));
}
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
