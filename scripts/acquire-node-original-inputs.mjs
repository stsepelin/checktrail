// Fixed public data acquisition only; no archive, package or producer code runs.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  statfs,
  unlink,
} from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import tls from "node:tls";
import { fileURLToPath, URL } from "node:url";
import {
  inspectNodeDocArchiveManifest,
  nodeOriginalCatalog,
  nodeOriginalCatalogSha256,
  nodeOriginalInputRows,
} from "./producer-qualification/node-original-profile.mjs";
const { AbortController } = globalThis;
const MIB = 1024 ** 2;
export const nodeOriginalAcquisitionLimits = Object.freeze({
  phaseMs: 300000,
  requestMs: 30000,
  bodyBytes: 64 * MIB,
  metadataBytes: 2 * MIB,
  failedPrefixBytes: 65536,
  responseHeaderBytes: 4096,
  freeBytes: 1024 * MIB,
});
const fixedRows = nodeOriginalInputRows();
const fixedUrls = new Set(fixedRows.map((row) => row.url));
const identity = (s) =>
  [
    s.dev,
    s.ino,
    s.mode,
    s.uid,
    s.gid,
    s.nlink,
    s.size,
    s.mtimeNs,
    s.ctimeNs,
  ].map(String);
const directoryIdentity = (s) =>
  [s.dev, s.ino, s.mode, s.uid, s.gid].map(String);

export function describeNodeInputFailure(error, depth = 0) {
  const row = {
    type: error?.name ?? error?.type ?? typeof error,
    message: String(error?.message ?? error).slice(0, 2048),
  };
  if (typeof error?.stage === "string") row.stage = error.stage.slice(0, 128);
  if (typeof error?.code === "string") row.code = error.code.slice(0, 64);
  if (Number.isInteger(error?.status)) row.status = error.status;
  for (const flag of ["causeOmitted", "primaryOmitted"])
    if (error?.[flag] === true) row[flag] = true;
  for (const count of [
    "additionalErrors",
    "additionalSecondaryCount",
    "errorsOmittedCount",
    "secondaryOmittedCount",
  ])
    if (Number.isSafeInteger(error?.[count]) && error[count] >= 0)
      row[count] = error[count];
  // Only our own failure class and its already-rendered typed rows carry this
  // primary/secondary contract. Native Error cause/AggregateError stay separate.
  const knownInputFailure =
    error instanceof InputFailure ||
    error?.type === "NodeInputAcquisitionFailure";
  if (depth < 2) {
    if (error?.cause)
      row.cause = describeNodeInputFailure(error.cause, depth + 1);
    if (Array.isArray(error?.errors)) {
      row.errors = error.errors
        .slice(0, 8)
        .map((cause) => describeNodeInputFailure(cause, depth + 1));
      row.additionalErrors =
        (row.additionalErrors ?? 0) + Math.max(0, error.errors.length - 8);
    }
    if (knownInputFailure && error.primary)
      row.primary = describeNodeInputFailure(error.primary, depth + 1);
    if (knownInputFailure && Array.isArray(error.secondary)) {
      row.secondary = error.secondary
        .slice(0, 8)
        .map((cause) => describeNodeInputFailure(cause, depth + 1));
      row.additionalSecondaryCount =
        (row.additionalSecondaryCount ?? 0) +
        Math.max(0, error.secondary.length - 8);
    }
  } else {
    if (error?.cause) row.causeOmitted = true;
    if (Array.isArray(error?.errors))
      row.errorsOmittedCount =
        (row.errorsOmittedCount ?? 0) +
        error.errors.length +
        (row.additionalErrors ?? 0);
    if (knownInputFailure && error.primary) row.primaryOmitted = true;
    if (knownInputFailure && Array.isArray(error.secondary))
      row.secondaryOmittedCount =
        (row.secondaryOmittedCount ?? 0) +
        error.secondary.length +
        (row.additionalSecondaryCount ?? 0);
  }
  return row;
}

class InputFailure extends Error {
  constructor(primary, secondary, observation) {
    super(primary.message, { cause: primary });
    this.name = "NodeInputAcquisitionFailure";
    this.primary = primary;
    this.secondary = secondary;
    this.observation = observation;
  }
}
const secondaryError = (error, stage) => ({
  stage,
  ...describeNodeInputFailure(error),
});

export function validateNodeOriginalInputUrl(address) {
  assert.ok(
    fixedUrls.has(address),
    "Only one of145 exact public input URLs is admitted",
  );
  const url = new URL(address);
  assert.equal(url.href, address, "Noncanonical input URL");
  assert.equal(url.protocol, "https:");
  assert.equal(
    url.username + url.password + url.port + url.search + url.hash,
    "",
  );
  return url;
}

// Same direct-agent pattern as the reviewed SDK metadata adapter, with request
// failure and all three destroy causes retained. No fetch dispatcher/env proxy.
export function directNodeInputTransport(address, signal) {
  const url = validateNodeOriginalInputUrl(address);
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({
      keepAlive: false,
      maxSockets: 1,
      proxyEnv: {},
      rejectUnauthorized: true,
      ca: tls.rootCertificates,
    });
    let request,
      response,
      resource,
      closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const errors = [];
      for (const destroy of [
        () => response?.destroy(),
        () => request?.destroy(),
        () => agent.destroy(),
      ])
        try {
          destroy();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length)
        throw new AggregateError(
          errors,
          "HTTPS response/request/agent cleanup failed",
        );
    };
    const fail = (primary) => {
      const secondary = [];
      try {
        close();
      } catch (error) {
        secondary.push(secondaryError(error, "https-open-cleanup"));
      }
      const error = new InputFailure(primary, secondary, {
        url: address,
        responseObserved: Boolean(response),
      });
      if (resource) resource.failure = error;
      else reject(error);
    };
    try {
      request = https.request(
        url,
        {
          method: "GET",
          agent,
          signal,
          rejectUnauthorized: true,
          servername: url.hostname,
          headers: {
            Accept: "application/octet-stream",
            "Accept-Encoding": "identity",
          },
        },
        (incoming) => {
          response = incoming;
          resource = {
            status: response.statusCode,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            body: response,
            close,
            failure: null,
          };
          resolve(resource);
        },
      );
      request.once("error", fail);
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

// A short write is progress, never a complete write. Charge real bytes before
// any post-write refusal, including a late write that crossed the deadline.
export async function writeNodeInputBytes(file, raw, charge, check = () => {}) {
  let offset = 0;
  while (offset < raw.length) {
    const { bytesWritten } = await file.write(raw, offset, raw.length - offset);
    assert.ok(
      Number.isSafeInteger(bytesWritten) &&
        bytesWritten > 0 &&
        bytesWritten <= raw.length - offset,
      "Input writer made invalid progress",
    );
    charge(raw.subarray(offset, offset + bytesWritten));
    offset += bytesWritten;
    await check();
  }
}
function headersEvidence(response) {
  const raw = response.rawHeaders ?? [];
  assert.ok(
    Array.isArray(raw) &&
      raw.length % 2 === 0 &&
      raw.every((v) => typeof v === "string"),
    "Invalid raw response headers",
  );
  const retained = [];
  let observed = 0,
    saved = 0;
  let stopped = false;
  for (let index = 0; index < raw.length; index += 2) {
    const pair = raw.slice(index, index + 2),
      bytes = pair.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    observed += bytes;
    if (
      !stopped &&
      retained.length < 128 &&
      saved + bytes <= nodeOriginalAcquisitionLimits.responseHeaderBytes
    ) {
      retained.push(...pair);
      saved += bytes;
    } else stopped = true;
  }
  return {
    rawHeaders: retained,
    rawHeaderBytesObserved: observed,
    rawHeadersComplete: retained.length === raw.length,
  };
}

export async function retainNodeOriginalResponse(
  response,
  partial,
  row,
  ledger,
  check = () => {},
  openOutput = open,
) {
  assert.ok(
    Number.isSafeInteger(row.bytes) &&
      row.bytes > 0 &&
      row.bytes <= nodeOriginalAcquisitionLimits.bodyBytes,
  );
  assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  const observation = {
    file: row.file,
    url: row.url,
    status: response.status,
    bytesObserved: 0,
    bytesWritten: 0,
    partialFile: partial,
    partialCreated: false,
    fileClosed: false,
    bodyComplete: false,
    validated: false,
  };
  let primary, file;
  const secondary = [],
    sha256 = createHash("sha256"),
    sha512 = createHash("sha512");
  if (response.status !== 200) {
    primary = new Error("Original input HTTP status " + response.status);
    primary.name = "NodeInputHttpError";
    primary.status = response.status;
  }
  try {
    Object.assign(observation, headersEvidence(response));
    if (!primary) {
      assert.ok(
        observation.rawHeadersComplete,
        "Input response header evidence exceeds bound",
      );
      assert.equal(
        response.headers?.["content-encoding"] ?? "identity",
        "identity",
        "Encoded input transport refused",
      );
      const length = response.headers?.["content-length"];
      if (length !== undefined)
        assert.equal(
          length,
          String(row.bytes),
          "Input Content-Length differs from exact pin",
        );
    }
    assert.ok(
      response.body?.[Symbol.asyncIterator],
      "Input response has no byte stream",
    );
    file = await openOutput(
      partial,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    observation.partialCreated = true;
    const limit = primary
      ? Math.min(row.bytes, nodeOriginalAcquisitionLimits.failedPrefixBytes)
      : row.bytes;
    let stoppedEarly = false;
    for await (const chunk of response.body) {
      assert.ok(Buffer.isBuffer(chunk), "Input stream yielded a non-Buffer");
      observation.bytesObserved += chunk.length;
      ledger.bodyBytesObserved += chunk.length;
      await check();
      assert.ok(
        ledger.bodyBytesObserved <= nodeOriginalAcquisitionLimits.bodyBytes,
        "Aggregate observed input byte ceiling exceeded",
      );
      if (!primary)
        assert.ok(
          observation.bytesObserved <= row.bytes,
          "Input body exceeds exact declared bytes",
        );
      const prefix = chunk.subarray(
        0,
        Math.max(0, limit - observation.bytesWritten),
      );
      await writeNodeInputBytes(
        file,
        prefix,
        (piece) => {
          observation.bytesWritten += piece.length;
          ledger.bodyBytesWritten += piece.length;
          sha256.update(piece);
          sha512.update(piece);
        },
        check,
      );
      if (primary && observation.bytesWritten === limit) {
        stoppedEarly = true;
        break;
      }
    }
    observation.bodyComplete = !stoppedEarly;
    if (!primary) {
      assert.equal(
        observation.bytesObserved,
        row.bytes,
        "Input body ended before exact declared bytes",
      );
      assert.equal(
        sha256.copy().digest("hex"),
        row.sha256,
        "Original input SHA256 differs",
      );
      if (row.sha512Hex !== undefined) {
        assert.equal(
          sha512.copy().digest("hex"),
          row.sha512Hex,
          "Original lock SHA512 differs",
        );
        assert.equal(
          "sha512-" + sha512.copy().digest("base64"),
          row.integrity,
          "Original lock SRI differs",
        );
      }
    }
    await file.sync();
  } catch (error) {
    if (primary) secondary.push(secondaryError(error, "input-body-retention"));
    else primary = error;
  } finally {
    if (file)
      try {
        await file.close();
        observation.fileClosed = true;
      } catch (error) {
        if (primary) secondary.push(secondaryError(error, "input-file-close"));
        else primary = error;
      }
  }
  observation.writtenPrefixSha256 = sha256.digest("hex");
  if (!primary)
    try {
      await check();
    } catch (error) {
      primary = error;
    }
  if (primary) throw new InputFailure(primary, secondary, observation);
  observation.validated = true;
  return observation;
}
// Exactly one request/body/cleanup interval. Tests inject inert transport/clock;
// the CLI always uses the fixed direct HTTPS transport and monotonic clock.
export async function downloadNodeOriginalInput(
  row,
  partial,
  ledger,
  phaseSignal,
  check = () => {},
  transport = directNodeInputTransport,
  clock = () => performance.now(),
) {
  phaseSignal.throwIfAborted();
  const controller = new AbortController(),
    requestDeadline = clock() + nodeOriginalAcquisitionLimits.requestMs;
  const onAbort = () => controller.abort(phaseSignal.reason);
  phaseSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Node input request deadline exceeded")),
    nodeOriginalAcquisitionLimits.requestMs,
  );
  let response, retained, failure, failedObservation;
  const cleanup = [];
  const requestCheck = async () => {
    controller.signal.throwIfAborted();
    assert.ok(
      clock() < requestDeadline,
      "Node input request deadline exceeded",
    );
    await check();
  };
  try {
    ledger.requestsStarted++;
    response = await transport(row.url, controller.signal);
    retained = await retainNodeOriginalResponse(
      response,
      partial,
      row,
      ledger,
      requestCheck,
    );
  } catch (error) {
    failure = error;
    failedObservation = error.observation;
  } finally {
    try {
      clearTimeout(timer);
    } catch (error) {
      cleanup.push(secondaryError(error, "request-timer-clear"));
    }
    try {
      phaseSignal.removeEventListener("abort", onAbort);
    } catch (error) {
      cleanup.push(secondaryError(error, "request-abort-listener-remove"));
    }
    try {
      await response?.close();
    } catch (error) {
      cleanup.push(secondaryError(error, "https-response-close"));
    }
    if (response?.failure) {
      if (failure?.primary?.name === "NodeInputHttpError")
        cleanup.push(
          secondaryError(response.failure, "request-error-after-http-status"),
        );
      else {
        if (failure)
          cleanup.push(secondaryError(failure, "body-after-request-error"));
        failure = response.failure;
      }
    }
  }
  if (!failure && cleanup.length)
    failure = new Error("Input response cleanup incomplete");
  try {
    await requestCheck();
  } catch (error) {
    if (failure) cleanup.push(secondaryError(error, "request-final-clock"));
    else failure = error;
  }
  if (failure)
    throw new InputFailure(
      failure.primary ?? failure,
      [...(failure.secondary ?? []), ...cleanup],
      failedObservation ??
        failure.observation ??
        retained ?? { file: row.file, url: row.url, responseObserved: false },
    );
  return retained;
}

function privateRegular(s) {
  assert.ok(
    s.isFile() &&
      s.nlink === 1n &&
      (s.mode & 0o777n) === 0o600n &&
      s.uid === BigInt(process.getuid()),
    "Input file is not an owned private regular leaf",
  );
}
export async function publishNodeOriginalInput(partial, target, row) {
  const before = await lstat(partial, { bigint: true });
  privateRegular(before);
  assert.equal(before.size, BigInt(row.bytes));
  await link(partial, target); // Exclusive publication: never overwrites a racing destination.
  await unlink(partial);
  const after = await lstat(target, { bigint: true });
  privateRegular(after);
  for (const key of ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs"])
    assert.equal(after[key], before[key], "Published input identity differs");
  return identity(after);
}
export async function verifyNodeOriginalInput(
  file,
  row,
  ledger,
  check = () => {},
) {
  const before = await lstat(file, { bigint: true });
  privateRegular(before);
  assert.equal(before.size, BigInt(row.bytes));
  let handle, primary;
  const secondary = [],
    sha256 = createHash("sha256"),
    sha512 = createHash("sha512");
  let count = 0;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    assert.deepEqual(
      identity(await handle.stat({ bigint: true })),
      identity(before),
    );
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, row.bytes - count + 1),
        null,
      );
      count += bytesRead;
      ledger.verificationBytesRead += bytesRead;
      await check();
      assert.ok(
        count <= row.bytes &&
          ledger.verificationBytesRead <=
            nodeOriginalAcquisitionLimits.bodyBytes,
        "Input verification byte ceiling exceeded",
      );
      if (!bytesRead) break;
      sha256.update(buffer.subarray(0, bytesRead));
      sha512.update(buffer.subarray(0, bytesRead));
    }
    assert.equal(count, row.bytes);
    assert.equal(
      sha256.digest("hex"),
      row.sha256,
      "Retained input SHA256 changed",
    );
    if (row.sha512Hex !== undefined)
      assert.equal(
        sha512.digest("hex"),
        row.sha512Hex,
        "Retained lock input SHA512 changed",
      );
    assert.deepEqual(
      identity(await handle.stat({ bigint: true })),
      identity(before),
    );
    assert.deepEqual(
      identity(await lstat(file, { bigint: true })),
      identity(before),
    );
  } catch (error) {
    primary = error;
  } finally {
    if (handle)
      try {
        await handle.close();
      } catch (error) {
        if (primary)
          secondary.push(secondaryError(error, "input-verification-close"));
        else primary = error;
      }
  }
  if (primary)
    throw new InputFailure(primary, secondary, {
      file,
      verificationBytesRead: count,
    });
  return identity(before);
}
export function nodeOriginalDocManifest() {
  const { docCache } = nodeOriginalCatalog();
  return inspectNodeDocArchiveManifest({
    schemaVersion: 1,
    packageJsonSha256: docCache.packageJsonSha256,
    lockSha256: docCache.lockSha256,
    lockGitBlob: docCache.lockGitBlob,
    artifacts: docCache.artifacts.map((row) => ({
      ...row,
      file: "docs/" + row.id + ".tgz",
    })),
  });
}

export async function acquireNodeOriginalInputs(
  output,
  transport = directNodeInputTransport,
) {
  const destination = path.resolve(output),
    parent = path.dirname(destination),
    started = performance.now(),
    deadline = started + nodeOriginalAcquisitionLimits.phaseMs;
  const ledger = {
    requestsStarted: 0,
    bodyBytesObserved: 0,
    bodyBytesWritten: 0,
    verificationBytesRead: 0,
    metadataBytesWritten: 0,
  };
  const state = {
    schemaVersion: 1,
    state: "incomplete-original-node-inputs",
    catalogSha256: nodeOriginalCatalogSha256,
    acquired: [],
    failed: null,
    completeInputBundle: false,
    buildExecuted: false,
    packageExecuted: false,
    gateAComplete: false,
    ledger,
    counterScope: "before-final-inputs-json",
  };
  const controller = new AbortController(),
    abort = () =>
      controller.abort(new Error("Node input acquisition interrupted"));
  const timer = setTimeout(abort, nodeOriginalAcquisitionLimits.phaseMs);
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const directories = [];
  let rootCreated = false,
    primary,
    journal;
  const secondary = [];
  async function stable() {
    for (const directory of directories) {
      assert.deepEqual(
        directoryIdentity(await directory.fd.stat({ bigint: true })),
        directory.frame,
        "Held acquisition directory changed",
      );
      assert.deepEqual(
        directoryIdentity(await lstat(directory.path, { bigint: true })),
        directory.frame,
        "Named acquisition directory changed",
      );
    }
  }
  async function check() {
    controller.signal.throwIfAborted();
    assert.ok(
      performance.now() < deadline,
      "Node input phase deadline exceeded",
    );
    await stable();
    const space = await statfs(rootCreated ? destination : parent, {
      bigint: true,
    });
    assert.ok(
      space.bavail * space.bsize >=
        BigInt(nodeOriginalAcquisitionLimits.freeBytes),
      "Node input free-space reserve unavailable",
    );
  }
  async function hold(directory) {
    const before = await lstat(directory, { bigint: true });
    assert.ok(
      before.isDirectory() &&
        before.uid === BigInt(process.getuid()) &&
        (before.mode & 0o022n) === 0n,
      "Private acquisition directory required",
    );
    const fd = await open(
      directory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    directories.push({ path: directory, fd, frame: directoryIdentity(before) });
    await stable();
  }
  async function metadata(file, value, existing) {
    const raw = Buffer.from(JSON.stringify(value) + "\n");
    assert.ok(
      raw.length + ledger.metadataBytesWritten <=
        nodeOriginalAcquisitionLimits.metadataBytes,
      "Node input metadata byte ceiling exceeded",
    );
    let fd = existing,
      failure;
    const closeErrors = [];
    try {
      fd ??= await open(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await writeNodeInputBytes(fd, raw, (piece) => {
        ledger.metadataBytesWritten += piece.length;
      });
      await fd.sync();
    } catch (error) {
      failure = error;
    } finally {
      if (fd && !existing)
        try {
          await fd.close();
        } catch (error) {
          if (failure)
            closeErrors.push(secondaryError(error, "metadata-close"));
          else failure = error;
        }
    }
    if (failure)
      throw new InputFailure(failure, closeErrors, {
        file,
        metadataBytesWritten: ledger.metadataBytesWritten,
      });
  }
  try {
    assert.equal(fixedRows.length, 145);
    assert.equal(new Set(fixedRows.map((row) => row.file)).size, 145);
    for (const row of fixedRows) {
      validateNodeOriginalInputUrl(row.url);
      assert.ok(
        /^(source\/node-v22\.16\.0\.tar\.xz|docs\/node-doc-artifact-[0-9]{3}\.tgz)$/u.test(
          row.file,
        ),
      );
    }
    assert.equal(
      await realpath(parent),
      parent,
      "Canonical output parent required",
    );
    await hold(parent);
    await check();
    await mkdir(destination, { mode: 0o700 });
    rootCreated = true;
    await hold(destination);
    for (const name of ["source", "docs"]) {
      const directory = path.join(destination, name);
      await mkdir(directory, { mode: 0o700 });
      await hold(directory);
    }
    journal = await open(
      path.join(destination, "responses.jsonl"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    for (const row of fixedRows) {
      await check();
      let retained;
      try {
        retained = await downloadNodeOriginalInput(
          row,
          path.join(destination, row.file + ".partial"),
          ledger,
          controller.signal,
          check,
          transport,
        );
      } catch (error) {
        state.failed = {
          ...(error.observation ?? { file: row.file, url: row.url }),
          primary: describeNodeInputFailure(error.primary ?? error),
          secondary: error.secondary ?? [],
        };
        await metadata(
          path.join(destination, "responses.jsonl"),
          { state: "failed", ...state.failed },
          journal,
        ).catch((error) =>
          secondary.push(secondaryError(error, "failed-response-journal")),
        );
        throw error;
      }
      try {
        await check();
        const target = path.join(destination, row.file);
        const physical = await publishNodeOriginalInput(
          retained.partialFile,
          target,
          row,
        );
        const acquired = {
          file: row.file,
          bytes: row.bytes,
          sha256: row.sha256,
          ...(row.sha512Hex ? { sha512Hex: row.sha512Hex } : {}),
          physical,
          origin: {
            kind: "fresh-exact-public-https",
            url: row.url,
            status: retained.status,
          },
        };
        state.acquired.push(acquired);
        await metadata(
          path.join(destination, "responses.jsonl"),
          { state: "matched", ...retained, canonicalFile: row.file },
          journal,
        );
      } catch (error) {
        state.failed = {
          ...retained,
          primary: describeNodeInputFailure(error.primary ?? error),
          secondary: error.secondary ?? [],
        };
        throw new InputFailure(
          error.primary ?? error,
          error.secondary ?? [],
          retained,
        );
      }
    }
    assert.equal(
      state.acquired.length,
      145,
      "All145 bodies must validate and close before completion",
    );
    for (const row of fixedRows)
      await verifyNodeOriginalInput(
        path.join(destination, row.file),
        row,
        ledger,
        check,
      );
    await check();
  } catch (error) {
    primary = error;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    if (journal)
      try {
        await journal.close();
      } catch (error) {
        if (primary)
          secondary.push(secondaryError(error, "response-journal-close"));
        else primary = error;
      }
    for (const directory of directories.reverse())
      try {
        await directory.fd.close();
      } catch (error) {
        if (primary) secondary.push(secondaryError(error, "directory-close"));
        else primary = error;
      }
  }
  try {
    assert.ok(
      performance.now() < deadline,
      "Node input final deadline exceeded",
    );
    if (!primary) {
      await metadata(
        path.join(destination, "doc-archives.json"),
        nodeOriginalDocManifest(),
      );
      state.state = "complete-pinned-original-node-inputs";
      state.docManifest = "doc-archives.json";
      state.completeInputBundle = true;
    }
  } catch (error) {
    if (primary) secondary.push(secondaryError(error, "final-manifest"));
    else primary = error;
  }
  if (primary) {
    state.state = "incomplete-original-node-inputs";
    state.completeInputBundle = false;
    state.error = describeNodeInputFailure(primary.primary ?? primary);
    state.secondary = [...(primary.secondary ?? []), ...secondary];
  }
  if (rootCreated)
    try {
      await metadata(path.join(destination, "inputs.json"), state);
    } catch (error) {
      if (primary) secondary.push(secondaryError(error, "inputs-terminal"));
      else primary = error;
    }
  if (primary) {
    const error = new InputFailure(
      primary.primary ?? primary,
      [...(primary.secondary ?? []), ...secondary],
      primary.observation ?? null,
    );
    error.summary = state;
    throw error;
  }
  assert.ok(
    performance.now() < deadline,
    "Node input terminal write crossed final deadline",
  );
  return {
    state: state.state,
    output: destination,
    files: state.acquired.length,
    ...ledger,
    elapsedMs: performance.now() - started,
    buildExecuted: false,
    packageExecuted: false,
    gateAComplete: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(
      process.argv.length,
      3,
      "Usage: node scripts/acquire-node-original-inputs.mjs NEW_OUTPUT_ROOT",
    );
    process.stdout.write(
      JSON.stringify(await acquireNodeOriginalInputs(process.argv[2])) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        state: "incomplete-original-node-inputs",
        primary: describeNodeInputFailure(error.primary ?? error),
        secondary: error.secondary ?? [],
        observation: error.observation
          ? {
              file: error.observation.file,
              status: error.observation.status,
              bytesObserved: error.observation.bytesObserved,
              bytesWritten: error.observation.bytesWritten,
              writtenPrefixSha256: error.observation.writtenPrefixSha256,
            }
          : null,
        ledger: error.summary?.ledger ?? null,
        buildExecuted: false,
        packageExecuted: false,
        gateAComplete: false,
      }) + "\n",
    );
    process.exitCode = 2;
  }
}
