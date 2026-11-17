// Fixed bootstrap: execute only a byte-pinned first-party auditor, never project scripts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
const request = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(request.schemaVersion, 1);
assert.ok(
  ["npm-production", "npm-development", "selected-artifact-evidence"].includes(
    request.phase,
  ),
);
const here = fileURLToPath(new URL("./", import.meta.url));
assert.ok(path.isAbsolute(request.npmCli.file));
assert.equal(await realpath(request.npmCli.file), request.npmCli.file);
assert.equal(
  createHash("sha256")
    .update(await readFile(request.npmCli.file))
    .digest("hex"),
  request.npmCli.sha256,
  "Operator npm CLI source differs",
);
const auditor = request.phase.startsWith("npm")
  ? path.join(request.root, "scripts/audit-dependencies.mjs")
  : path.join(here, "audit-selected-artifact-evidence.mjs");
assert.equal(await realpath(auditor), auditor);
const fd = await open(
  auditor,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
try {
  const before = await fd.stat();
  assert.ok(
    before.isFile() && before.size > 0 && before.size <= 2 * 1024 * 1024,
  );
  const body = await fd.readFile();
  const after = await fd.stat();
  assert.ok(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === body.length &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs,
  );
  assert.equal(
    createHash("sha256").update(body).digest("hex"),
    request.auditorSha256,
    "Actual audit executable differs from pinned first-party source",
  );
} finally {
  await fd.close();
}
assert.equal(
  await realpath(path.dirname(request.journal)),
  path.dirname(request.journal),
);
const journal = await open(
  request.journal,
  constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_APPEND |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK,
  0o600,
);
try {
  const info = await journal.stat();
  assert.ok(info.isFile() && info.size <= 1024 * 1024);
  await journal.appendFile(
    JSON.stringify({
      runId: request.runId,
      phase: request.phase,
      state: "audit-bootstrap-entered",
      pid: process.pid,
      temporary: path.dirname(process.argv[2]),
      sourceFingerprint: request.sourceFingerprint,
      auditorSha256: request.auditorSha256,
    }) + "\n",
  );
  await journal.sync();
} finally {
  await journal.close();
}
process.argv = [
  process.execPath,
  auditor,
  ...(request.phase === "npm-development"
    ? ["--include-dev", "--npm-cli", request.npmCli.file]
    : request.phase === "selected-artifact-evidence"
      ? [request.root]
      : ["--npm-cli", request.npmCli.file]),
];
await import(pathToFileURL(auditor).href);
