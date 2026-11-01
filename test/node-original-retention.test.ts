import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const { reconcileNodeRetention } = await import(
  new URL(
    "../../scripts/producer-qualification/node-original-retention.mjs",
    import.meta.url,
  ).href
);
function packet(counters: object[]) {
  const messages: { stream: string; value: object }[] = [
    {
      stream: "stdout",
      value: {
        schemaVersion: 1,
        kind: "ready",
        roots: ["bundle", "controls", "work"].map(
          (name) => "/observed/" + name,
        ),
      },
    },
  ];
  const samples = [];
  for (let i = 0; i < counters.length; i++) {
    const sequence = i + 1,
      sample = {
        schemaVersion: 1,
        kind: "sample",
        sequence,
        bytes: 5,
        files: 3,
        directories: 3,
      };
    messages.push({
      stream: "stdin",
      value: { schemaVersion: 1, kind: "sample", sequence },
    });
    messages.push({
      stream: "stderr",
      value: {
        schemaVersion: 1,
        kind: "node-link-object-counts",
        sequence,
        links: 0,
        linkTargetBytes: 0,
        targetContentsFollowed: false,
        sockets: 1,
        socketContentsRead: false,
        ...counters[i],
      },
    });
    messages.push({ stream: "stdout", value: sample });
    samples.push(sample);
  }
  const raw = Buffer.from(
    messages
      .map(({ stream, value }) =>
        JSON.stringify({
          stream,
          base64: Buffer.from(JSON.stringify(value) + "\n").toString("base64"),
        }),
      )
      .join("\n") + "\n",
  );
  return {
    raw,
    receipt: {
      samples: samples.length,
      lastSample: samples.at(-1),
      retainedLogBytes: raw.length,
    },
  };
}

test(
  "Original Node retention accounts for held work sockets without opening endpoints and retains immutable FIFO refusals",
  { skip: process.platform === "win32" },
  async () => {
    const result = await exec(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        path.join(root, "test/node-original-retention-controls.py"),
        path.join(root, "scripts/producer-qualification"),
      ],
      { cwd: root, timeout: 10000, maxBuffer: 32768 },
    );
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Ran 5 tests/u);
    assert.match(result.stderr, /\nOK\s*$/u);
  },
);

test("Original Node socket diagnostics bind separate counters to every actual sample", () => {
  const { raw, receipt } = packet([
    {},
    { sockets: 0, links: 1, linkTargetBytes: 2 },
  ]);
  const value = reconcileNodeRetention(raw, receipt);
  assert.equal(value.samples, 2);
  assert.equal(value.linkObjectSamples[0].sockets, 1);
  assert.equal(value.linkObjectSamples[1].links, 1);
  assert.equal(value.socketContentsRead, false);
  assert.equal(value.symlinkTargetContentsCounted, false);
});

test("Original Node socket diagnostics refuse content claims foreign types and per-sample impossible counts", () => {
  for (const bad of [
    { socketContentsRead: true },
    { sockets: -1 },
    { sockets: 1.5 },
    { sockets: null },
    { sockets: 4 },
    { sockets: 2, links: 2 },
    { sockets: 1, fifos: 0 },
    { links: 1, linkTargetBytes: 6 },
  ]) {
    const { raw, receipt } = packet([bad, {}]);
    assert.throws(() => reconcileNodeRetention(raw, receipt));
  }
});
