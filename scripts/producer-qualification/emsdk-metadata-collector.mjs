// Operator-only inert source metadata preparation. No transport runs on import.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { readPinnedArchive } from "./emsdk-metadata-archive.mjs";
import { readExactDescriptor } from "./emsdk-metadata-file.mjs";
import {
  digest,
  metadataUrl,
  commitMetadata,
  treeMetadata,
  selectedBlob,
  gitilesJson,
  gitilesBlob,
} from "./emsdk-metadata-values.mjs";

const roots = [
  {
    id: "v8",
    repository: "https://chromium.googlesource.com/v8/v8",
    commit: "b74cc9a7cf395b7ab032986afebc9220fe7f4b20",
  },
  {
    id: "binaryen",
    repository:
      "https://chromium.googlesource.com/external/github.com/WebAssembly/binaryen",
    commit: "cf756c92997182276122c2f0a9ac567d2d39ef42",
  },
];
export function validateCatalog(value) {
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.catalogId, "emsdk-upstream-metadata-v1");
  assert.equal(
    value.state,
    "source-only-metadata-catalog-pending-network-review",
  );
  assert.equal(
    value.emscriptenReleasesSourceCommit,
    "b412b6307e541b93dd93f01b61181e15c17302ec",
  );
  assert.deepEqual(value.roots, roots);
  assert.equal(value.allowedHost, "chromium.googlesource.com");
  assert.equal(value.allowedRedirects, 0);
  assert.deepEqual(value.limits, {
    phaseMs: 120000,
    requestMs: 15000,
    writeReserveMs: 10000,
    wireBytes: 16777216,
    retainedBytes: 33554432,
    reserveDiskBytes: 33554432,
    jsonDepth: 64,
    jsonNodes: 32768,
    treeEntries: 2048,
    decodedBlobBytes: 1572864,
  });
  const expected = roots.flatMap((root) => {
    const base = root.repository + "/+/" + root.commit;
    const roles = [
      {
        id: root.id + "-commit",
        root: root.id,
        kind: "commit",
        url: base + "?format=JSON",
        maximumWireBytes: 1048576,
      },
      {
        id: root.id + "-root",
        root: root.id,
        kind: "tree",
        url: base + "/?format=JSON",
        maximumWireBytes: 1048576,
      },
    ];
    for (const [id, file, required] of root.id === "v8"
      ? [
          ["license", "LICENSE", true],
          ["deps", "DEPS", true],
        ]
      : [
          ["license", "LICENSE", true],
          ["gitmodules", ".gitmodules", false],
        ])
      roles.push({
        id: root.id + "-" + id,
        root: root.id,
        kind: "blob",
        path: file,
        url: base + "/" + file + "?format=TEXT",
        requiredTreeEntry: required,
        maximumWireBytes: 2097152,
      });
    return roles;
  });
  assert.deepEqual(
    value.roles,
    expected,
    "Catalog must retain exactly the eight reviewed URL roles",
  );
  for (const role of value.roles) metadataUrl(role.url, role);
  assert.equal(
    value.retainedIdentityDoesNotImplySignerOrProducerBuildClosure,
    true,
  );
  for (const name of [
    "realGitCheckoutIndexAndHistoryVerified",
    "originalDepsTransitionExecuted",
    "upstreamCodeExecuted",
    "networkAcquisitionPerformed",
    "producerBuildReproduced",
    "gateAComplete",
  ])
    assert.equal(value[name], false);
  assert.deepEqual(
    value.unresolvedRoles.map((role) => [role.id, role.state]),
    [
      [
        "v8-clang-updater-and-helper-closure",
        "unresolved-no-request-authorized",
      ],
      ["binaryen-nested-gitlinks", "unresolved-no-request-authorized"],
      ["depot-tools-history-and-bootstrap", "unknown-no-request-authorized"],
    ],
  );
  assert.equal(
    digest(Buffer.from(JSON.stringify(value))),
    "84835d0669a17578fb01d2d1149686f400d1ba120a402627b365bae0c05e1be5",
    "Catalog value differs from all reviewed metadata, local archive pins and twelve reuse references",
  );
  const copy = JSON.parse(JSON.stringify(value));
  // Copy before any await: callers cannot change a role while a request is pending.
  return copy;
}

function identity(info) {
  return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
}
function within(operation, deadline, now) {
  const remaining = Math.floor(deadline - now());
  assert.ok(remaining > 0, "Metadata deadline exhausted");
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Metadata deadline exhausted")),
        remaining,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function collectMetadata({
  catalog,
  outputRoot,
  transport,
  localArchivePath,
  now = () => performance.now(),
}) {
  const frozen = validateCatalog(catalog);
  assert.equal(
    typeof transport,
    "function",
    "An explicitly reviewed transport is required",
  );
  assert.equal(
    path.resolve(outputRoot),
    outputRoot,
    "Output root must be absolute and canonical",
  );
  assert.equal(
    fs.realpathSync(path.dirname(outputRoot)),
    path.dirname(outputRoot),
    "Output parent cannot use symlink aliases",
  );
  const space = fs.statfsSync(path.dirname(outputRoot));
  assert.ok(
    space.bavail * space.bsize >=
      frozen.limits.retainedBytes + frozen.limits.reserveDiskBytes,
    "Insufficient bounded metadata disk reserve",
  );
  assert.equal(
    typeof process.getuid,
    "function",
    "POSIX ownership controls are required for metadata retention",
  );
  fs.mkdirSync(outputRoot, { mode: 0o700 });
  const rootIdentity = identity(fs.lstatSync(outputRoot));
  assert.equal(fs.realpathSync(outputRoot), outputRoot);
  assert.equal(rootIdentity.mode & 0o777, 0o700);
  if (process.getuid) assert.equal(rootIdentity.uid, process.getuid());
  const start = now(),
    deadline = start + frozen.limits.phaseMs;
  const requestDeadline = deadline - frozen.limits.writeReserveMs;
  let retainedBytes = 0,
    wireBytes = 0,
    stage = "start";
  const receipts = [],
    rootsResult = [],
    files = [];
  function checkRoot() {
    assert.deepEqual(
      identity(fs.lstatSync(outputRoot)),
      rootIdentity,
      "Owned output root changed",
    );
    assert.equal(fs.realpathSync(outputRoot), outputRoot);
    assert.ok(now() < deadline, "Metadata phase deadline exhausted");
  }
  function reserve(length) {
    checkRoot();
    assert.ok(Number.isSafeInteger(length) && length >= 0);
    assert.ok(
      retainedBytes + length <= frozen.limits.retainedBytes,
      "Retained metadata byte limit exceeded",
    );
    retainedBytes += length;
  }
  function writeAll(fd, bytes) {
    let position = 0;
    while (position < bytes.length) {
      const written = fs.writeSync(
        fd,
        bytes,
        position,
        bytes.length - position,
      );
      assert.ok(written > 0, "Metadata write made no progress");
      position += written;
    }
  }
  function verifyWritten(fd, expected) {
    const actual = readExactDescriptor(fd, {
      bytes: expected.length,
      deadline,
      now,
    });
    assert.ok(actual.equals(expected), "Physical metadata output differs");
  }
  function write(name, bytes) {
    reserve(bytes.length);
    const file = path.join(outputRoot, name);
    const fd = fs.openSync(
      file,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_RDWR |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeAll(fd, bytes);
      fs.fsyncSync(fd);
      verifyWritten(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    files.push({ file: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  function json(name, value) {
    write(name, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
  }
  function publish(partial, final) {
    checkRoot();
    fs.linkSync(path.join(outputRoot, partial), path.join(outputRoot, final));
  }
  async function responseBytes(role) {
    stage = role.id;
    assert.ok(now() < requestDeadline, "Metadata request reserve exhausted");
    const end = Math.min(requestDeadline, now() + frozen.limits.requestMs);
    const abort = new globalThis.AbortController();
    let response,
      fd,
      primaryError,
      pendingClose,
      result,
      length = 0,
      complete = false;
    const chunks = [];
    const receipt = {
      role: role.id,
      url: role.url,
      status: null,
      observedWireBytes: 0,
      retainedWireBytes: 0,
      complete: false,
      semanticAdmission: false,
    };
    receipts.push(receipt);
    const cleanupErrors = [];
    const rawName = role.id + ".response.partial";
    try {
      const pending = Promise.resolve().then(() =>
        transport(role, { signal: abort.signal }),
      );
      // The abort/close result must settle within the existing phase reserve.
      pendingClose = pending.then(
        (late) => {
          if (abort.signal.aborted) late.close();
        },
        () => {},
      );
      pendingClose.catch(() => {}); // Observe it here, then preserve any failure below.
      response = await within(() => pending, end, now);
      assert.ok(response && Number.isSafeInteger(response.status));
      receipt.status = response.status;
      const headers = response.headers ?? {};
      const advertised = headers["content-length"];
      if (advertised !== undefined) {
        assert.equal(typeof advertised, "string");
        assert.match(advertised, /^(0|[1-9][0-9]*)$/u);
        assert.ok(
          Number.isSafeInteger(Number(advertised)) &&
            Number(advertised) <= role.maximumWireBytes,
          "Advertised body exceeds role bound",
        );
        receipt.advertisedBytes = Number(advertised);
      }
      const encoding = headers["content-encoding"];
      assert.ok(
        encoding === undefined || encoding === "identity",
        "Encoded response is outside the reviewed byte contract",
      );
      checkRoot();
      fd = fs.openSync(
        path.join(outputRoot, rawName),
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_RDWR |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      const iterator = response.body[Symbol.asyncIterator]();
      for (;;) {
        const next = await within(() => iterator.next(), end, now);
        if (next.done) break;
        assert.ok(
          Buffer.isBuffer(next.value),
          "Transport must deliver byte buffers",
        );
        const chunk = next.value;
        wireBytes += chunk.length;
        receipt.observedWireBytes += chunk.length;
        assert.ok(
          wireBytes <= frozen.limits.wireBytes &&
            length + chunk.length <= role.maximumWireBytes,
          "Streamed metadata byte limit exceeded",
        );
        reserve(chunk.length);
        writeAll(fd, chunk);
        chunks.push(Buffer.from(chunk));
        length += chunk.length;
        receipt.retainedWireBytes = length;
      }
      const bytes = Buffer.concat(chunks, length);
      fs.fsyncSync(fd);
      verifyWritten(fd, bytes);
      fs.closeSync(fd);
      fd = undefined;
      if (receipt.advertisedBytes !== undefined)
        assert.equal(
          length,
          receipt.advertisedBytes,
          "Truncated or extra response bytes",
        );
      complete = true;
      receipt.complete = true;
      files.push({ file: rawName, bytes: length, sha256: digest(bytes) });
      // Persist the bounded original response/receipt before status or payload assertions.
      json(role.id + ".response-receipt.json", receipt);
      assert.equal(
        response.status,
        200,
        "Metadata endpoint did not return 200; no retry or redirect is permitted",
      );
      result = { bytes, rawName, receipt };
    } catch (error) {
      primaryError = error;
    } finally {
      for (const close of [
        () => abort.abort(),
        () => {
          if (fd !== undefined) fs.fsyncSync(fd);
        },
        () => {
          if (fd !== undefined) fs.closeSync(fd);
        },
        () => {
          if (response) response.close();
        },
      ])
        try {
          close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      if (pendingClose)
        try {
          await within(
            () => pendingClose,
            Math.min(deadline, now() + 1000),
            now,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      receipt.cleanupComplete = cleanupErrors.length === 0;
      if (!complete) {
        receipt.complete = false;
        try {
          json(role.id + ".incomplete-receipt.json", receipt);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length)
      throw new globalThis.AggregateError(
        [...(primaryError ? [primaryError] : []), ...cleanupErrors],
        "Metadata request cleanup or failure retention was incomplete",
      );
    if (primaryError) throw primaryError;
    return result;
  }
  try {
    json("catalog.json", frozen);
    for (const root of frozen.roots) {
      const roles = frozen.roles.filter((role) => role.root === root.id);
      const commitResponse = await responseBytes(roles[0]);
      const commit = commitMetadata(
        gitilesJson(commitResponse.bytes, frozen.limits),
        root.commit,
      );
      commitResponse.receipt.semanticAdmission = true;
      publish(commitResponse.rawName, roles[0].id + ".response");
      const treeResponse = await responseBytes(roles[1]);
      const entries = treeMetadata(
        gitilesJson(treeResponse.bytes, frozen.limits),
        commit.tree,
        frozen.limits.treeEntries,
      );
      treeResponse.receipt.semanticAdmission = true;
      publish(treeResponse.rawName, roles[1].id + ".response");
      const blobs = [],
        gitlinks = [...entries.values()]
          .filter((entry) => entry.type === "commit")
          .map((entry) => ({
            path: entry.name,
            commit: entry.id,
            sourceBodyRetained: false,
            moduleUrlBindingVerified: false,
          }));
      for (const role of roles.slice(2)) {
        const blobId = selectedBlob(entries, role);
        if (!blobId) {
          blobs.push({
            role: role.id,
            state: "not-declared-by-bound-root-tree",
          });
          continue;
        }
        const response = await responseBytes(role);
        const bytes = gitilesBlob(
          response.bytes,
          blobId,
          frozen.limits.decodedBlobBytes,
        );
        write(role.id + ".source.partial", bytes);
        publish(role.id + ".source.partial", role.id + ".source");
        response.receipt.semanticAdmission = true;
        publish(response.rawName, role.id + ".response");
        blobs.push({
          role: role.id,
          path: role.path,
          gitBlob: blobId,
          bytes: bytes.length,
          sha256: digest(bytes),
          state: "original-inert-source-retained",
        });
      }
      rootsResult.push({
        root: root.id,
        ...commit,
        treeBytesVerified: true,
        blobs,
        gitlinks,
      });
    }
    let localArchiveMetadata = null;
    if (localArchivePath !== undefined) {
      stage = "local-emscripten-archive";
      const local = await readPinnedArchive({
        archive: localArchivePath,
        metadata: frozen.localArchiveMetadata,
        deadline: requestDeadline,
      });
      const sourceFiles = [];
      for (const file of local.files) {
        const stem = "emscripten-" + file.file.replaceAll("/", "--");
        write(stem + ".source.partial", file.bytes);
        publish(stem + ".source.partial", stem + ".source");
        sourceFiles.push({
          file: file.file,
          output: stem + ".source",
          bytes: file.bytes.length,
          sha256: file.sha256,
        });
      }
      localArchiveMetadata = { ...local, files: sourceFiles };
    }
    const result = {
      schemaVersion: 1,
      state: "first-stage-source-metadata-retained",
      roots: rootsResult,
      receipts,
      files,
      observedWireBytes: wireBytes,
      retainedBytesBeforeManifest: retainedBytes,
      elapsedMs: now() - start,
      unresolvedRoles: frozen.unresolvedRoles,
      localArchiveMetadataCollected: localArchiveMetadata !== null,
      localArchiveMetadata,
      realGitCheckoutIndexAndHistoryVerified: false,
      originalDepsTransitionExecuted: false,
      upstreamCodeExecuted: false,
      producerBuildReproduced: false,
      gateAComplete: false,
    };
    stage = "publish-manifest";
    json("metadata-manifest.partial.json", result);
    publish("metadata-manifest.partial.json", "metadata-manifest.json");
    return result;
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      state: "incomplete-failed-metadata-preparation",
      stage,
      error: {
        name: String(error.name).slice(0, 100),
        message: String(error.message).slice(0, 2048),
      },
      receipts,
      files,
      observedWireBytes: wireBytes,
      retainedBytesBeforeFailureRecord: retainedBytes,
      producerBuildReproduced: false,
      gateAComplete: false,
    };
    try {
      json("failure.json", failure);
    } catch (retentionError) {
      throw new globalThis.AggregateError(
        [error, retentionError],
        "Metadata failed and its bounded failure record could not be retained",
      );
    }
    throw error;
  }
}
