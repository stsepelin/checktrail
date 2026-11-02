// Node-only interpretation layered over the unchanged retention transport.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { reconcileRetentionLog } from "./binutils-retention-observer.mjs";

export function reconcileNodeRetention(raw, receipt) {
  const base = reconcileRetentionLog(raw, receipt);
  const stderr = [];
  const stdout = [];
  let bytes = 0;
  for (const line of raw.toString("utf8").slice(0, -1).split("\n")) {
    const row = JSON.parse(line);
    if (row.stream === "stdin") continue;
    const chunk = Buffer.from(row.base64, "base64");
    assert.equal(chunk.toString("base64"), row.base64);
    bytes += chunk.length;
    assert.ok(bytes <= 16 * 1024 ** 2);
    (row.stream === "stderr" ? stderr : stdout).push(chunk);
  }
  const diagnostic = Buffer.concat(stderr).toString("utf8");
  assert.ok(
    diagnostic.endsWith("\n"),
    "Node link counters are absent or truncated",
  );
  let sequence = 1;
  const counters = [];
  for (const line of diagnostic.slice(0, -1).split("\n")) {
    assert.ok(Buffer.byteLength(line) <= 8192);
    const row = JSON.parse(line);
    assert.equal(row.schemaVersion, 1);
    if (row.kind === "mutable-work-scan-retry") {
      assert.deepEqual(Object.keys(row).sort(), [
        "discardedAttempt",
        "errno",
        "kind",
        "maximumAttempts",
        "schemaVersion",
        "sequence",
      ]);
      assert.equal(row.sequence, sequence);
      assert.equal(row.maximumAttempts, 3);
      assert.ok(
        Number.isSafeInteger(row.discardedAttempt) &&
          row.discardedAttempt >= 1 &&
          row.discardedAttempt < 3,
      );
      assert.equal(row.errno, 2);
      continue;
    }
    assert.deepEqual(Object.keys(row).sort(), [
      "kind",
      "linkTargetBytes",
      "links",
      "schemaVersion",
      "sequence",
      "socketContentsRead",
      "sockets",
      "targetContentsFollowed",
    ]);
    assert.equal(row.kind, "node-link-object-counts");
    assert.equal(row.sequence, sequence++);
    assert.equal(row.targetContentsFollowed, false);
    assert.equal(row.socketContentsRead, false);
    assert.ok(
      Number.isSafeInteger(row.links) && row.links >= 0 && row.links <= 1000000,
    );
    assert.ok(
      Number.isSafeInteger(row.linkTargetBytes) &&
        row.linkTargetBytes >= 0 &&
        row.linkTargetBytes <= row.links * 4096,
    );
    assert.ok(
      Number.isSafeInteger(row.sockets) &&
        row.sockets >= 0 &&
        row.sockets <= 1000000,
    );
    counters.push(row);
  }
  assert.equal(
    counters.length,
    base.samples,
    "Every observed sample needs its own link counters",
  );
  const samples = Buffer.concat(stdout)
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.kind === "sample");
  assert.equal(samples.length, counters.length);
  for (let index = 0; index < counters.length; index++) {
    const row = counters[index],
      sample = samples[index];
    assert.equal(row.sequence, sample.sequence);
    assert.ok(
      row.links + row.sockets <= sample.files &&
        row.linkTargetBytes <= sample.bytes,
      "Link/socket metadata exceeds its actual sample leaf/byte counts",
    );
  }
  return {
    ...base,
    linkObjectSamples: counters,
    symlinkTargetContentsCounted: false,
    socketContentsRead: false,
  };
}
