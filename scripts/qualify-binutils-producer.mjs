// Explicit operator-only development controller. Discovery and MCP never call it.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { finished } from "node:stream/promises";
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} from "node:timers";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const directory = fileURLToPath(
  new URL("producer-qualification/", import.meta.url),
);
const recipeFile = path.join(directory, "binutils.v1.json");
const exec = promisify(execFile);
const { AbortController } = globalThis;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const relative = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  !name.includes("\\") &&
  !path.posix.isAbsolute(name) &&
  name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const dockerEnvironment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  DOCKER_HOST: "unix:///var/run/docker.sock",
};

export async function physicalPath(file, directoryExpected = false) {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const part of resolved
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    assert.ok(!info.isSymbolicLink(), "Linked path refused: " + current);
  }
  const info = await lstat(resolved);
  assert.ok(
    directoryExpected ? info.isDirectory() : info.isFile(),
    "Unexpected physical input type: " + resolved,
  );
  assert.equal(await realpath(resolved), resolved);
  return resolved;
}
export async function identifyFile(file, maximum = 32 * 1024 ** 3) {
  await physicalPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(
      before.isFile() && Number(before.size) <= maximum,
      "Input exceeds byte bound",
    );
    const digest = createHash("sha256");
    let readBytes = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      readBytes += bytes.length;
      assert.ok(readBytes <= maximum, "Input grew beyond byte bound");
      digest.update(bytes);
    }
    const after = await handle.stat({ bigint: true });
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs],
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
      "Input changed during hashing",
    );
    return { bytes: Number(after.size), sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}
export async function validateInputs(root, rows) {
  await physicalPath(root, true);
  const names = new Set();
  for (const row of rows) {
    assert.ok(
      relative(row.file) && !names.has(row.file),
      "Invalid or duplicate pinned input",
    );
    names.add(row.file);
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        /^[a-f0-9]{64}$/.test(row.sha256),
      "Invalid pinned byte identity",
    );
    const actual = await identifyFile(path.join(root, row.file), row.bytes);
    assert.deepEqual(
      actual,
      { bytes: row.bytes, sha256: row.sha256 },
      "Pinned input mismatch: " + row.file,
    );
  }
  assert.ok(names.size > 0, "Empty pinned input inventory");
}
export async function copyPinnedInput(source, target, expected) {
  await physicalPath(source);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination;
  try {
    const before = await input.stat({ bigint: true });
    assert.ok(before.isFile() && Number(before.size) === expected.bytes);
    const digest = createHash("sha256");
    let readBytes = 0;
    for await (const bytes of input.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      readBytes += bytes.length;
      assert.ok(readBytes <= expected.bytes, "Pinned input grew before copy");
      digest.update(bytes);
    }
    const checked = await input.stat({ bigint: true });
    assert.deepEqual(
      [
        checked.dev,
        checked.ino,
        checked.size,
        checked.mtimeNs,
        checked.ctimeNs,
      ],
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
      "Pinned input changed before copy",
    );
    assert.equal(
      digest.digest("hex"),
      expected.sha256,
      "Pinned input changed before copy",
    );
    destination = await open(
      target,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const copied = createHash("sha256");
    let copiedBytes = 0;
    for await (const bytes of input.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      copiedBytes += bytes.length;
      assert.ok(copiedBytes <= expected.bytes, "Pinned input grew during copy");
      copied.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await destination.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        assert.ok(written.bytesWritten > 0);
        offset += written.bytesWritten;
      }
    }
    const after = await input.stat({ bigint: true });
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs],
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
      "Pinned input changed during copy",
    );
    assert.equal(
      copied.digest("hex"),
      expected.sha256,
      "Copied input byte mismatch",
    );
    assert.equal(Number((await destination.stat()).size), expected.bytes);
  } catch (error) {
    if (destination) await rm(target, { force: true });
    throw error;
  } finally {
    await destination?.close();
    await input.close();
  }
}
export async function validateDestination(inputs, output) {
  const destination = path.resolve(output);
  const parent = await physicalPath(path.dirname(destination), true);
  const source = await physicalPath(inputs, true);
  assert.ok(
    destination !== source &&
      !destination.startsWith(source + path.sep) &&
      !source.startsWith(destination + path.sep),
    "Input and output roots overlap",
  );
  await assert.rejects(
    lstat(destination),
    (error) => error.code === "ENOENT",
    "Output must be a new directory",
  );
  return { destination, parent };
}
export async function caseSensitiveParent(parent) {
  const probe = await mkdtemp(path.join(parent, ".checktrail-case-probe-"));
  try {
    await writeFile(
      path.join(probe, "Elf.h"),
      "Original case-sensitive probe",
      { flag: "wx", mode: 0o600 },
    );
    await assert.rejects(
      lstat(path.join(probe, "elf.h")),
      (error) => error.code === "ENOENT",
      "Case-sensitive build filesystem required",
    );
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
function originalReportOutcomes(raw, format) {
  const text = raw.toString("latin1");
  const lines = raw.length ? text.split(/\r\n|\n|\r/) : [];
  if (raw.length && /[\r\n]$/.test(text)) lines.pop();
  if (format === "dejagnu") {
    const counts = {
      PASS: 0,
      FAIL: 0,
      XFAIL: 0,
      XPASS: 0,
      UNSUPPORTED: 0,
      UNRESOLVED: 0,
      UNTESTED: 0,
      ERROR: 0,
    };
    let other = 0;
    for (const line of lines) {
      const match =
        /^(PASS|FAIL|XFAIL|XPASS|UNSUPPORTED|UNRESOLVED|UNTESTED|ERROR):(?:[ \t\f\v]|$)/.exec(
          line,
        );
      if (match) counts[match[1]]++;
      else other++;
    }
    return { counts, other, total: lines.length, metadata: undefined };
  }
  const metadata = {};
  for (const line of lines) {
    const match =
      /^:(test-result|global-test-result|recheck|copy-in-global-log): ([A-Za-z]+)$/.exec(
        line,
      );
    assert.ok(
      match && !Object.hasOwn(metadata, match[1]),
      "Original Automake result has unknown or duplicate fields",
    );
    metadata[match[1]] = match[2];
  }
  const keys = ["PASS", "FAIL", "XFAIL", "XPASS", "SKIP", "ERROR"];
  const result = metadata["test-result"];
  assert.deepEqual(
    Object.keys(metadata).sort(),
    [
      "test-result",
      "global-test-result",
      "recheck",
      "copy-in-global-log",
    ].sort(),
    "Original Automake result has missing fields",
  );
  assert.ok(keys.includes(result), "Original Automake result is unsupported");
  assert.equal(
    metadata["global-test-result"],
    result,
    "Original Automake global result is inconsistent",
  );
  assert.equal(
    metadata.recheck,
    ["FAIL", "XPASS", "ERROR"].includes(result) ? "yes" : "no",
    "Original Automake recheck is inconsistent",
  );
  assert.equal(
    metadata["copy-in-global-log"],
    result === "PASS" ? "no" : "yes",
    "Original Automake log inclusion is inconsistent",
  );
  return {
    counts: Object.fromEntries(
      keys.map((key) => [key, Number(key === result)]),
    ),
    other: lines.length - 1,
    total: lines.length,
    metadata,
  };
}
export async function summarizeReports(value, root, minimum) {
  await physicalPath(root, true);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.completeConfigurationInventoryAssessed, false);
  assert.ok(Array.isArray(value.reports) && value.reports.length <= 1024);
  const names = new Set();
  let failing = false;
  let observed = false;
  let everyReportObserved = true;
  for (const row of value.reports) {
    const format = row.format ?? "dejagnu";
    assert.ok(
      relative(row.file) &&
        row.file.startsWith(row.configuration + "/") &&
        /^builddir-[A-Za-z0-9_-]+$/.test(row.configuration) &&
        ((format === "dejagnu" && row.file.endsWith(".sum")) ||
          (format === "automake-trs" && row.file.endsWith(".trs"))) &&
        !names.has(row.file),
    );
    names.add(row.file);
    const raw = await boundedPhysicalBytes(path.join(root, row.file), 1048576);
    assert.deepEqual(
      { bytes: raw.length, sha256: sha(raw) },
      { bytes: row.bytes, sha256: row.sha256 },
      "Original report byte identity mismatch",
    );
    const derived = originalReportOutcomes(raw, format);
    assert.deepEqual(
      row.counts,
      derived.counts,
      "Original test outcomes differ from physical report bytes",
    );
    assert.deepEqual(
      row.metadata,
      derived.metadata,
      "Original Automake metadata differs from physical report bytes",
    );
    assert.equal(row.otherLines, derived.other);
    assert.equal(row.totalLines, derived.total);
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        row.bytes <= 1048576 &&
        /^[a-f0-9]{64}$/.test(row.sha256),
    );
    const counts = Object.values(row.counts);
    assert.ok(counts.every((n) => Number.isSafeInteger(n) && n >= 0));
    assert.ok(
      Number.isSafeInteger(row.otherLines) &&
        row.otherLines >= 0 &&
        Number.isSafeInteger(row.totalLines) &&
        row.totalLines >= 0,
    );
    assert.equal(
      counts.reduce((a, b) => a + b, row.otherLines),
      row.totalLines,
      "Original report line accounting does not partition",
    );
    if (row.log !== undefined) {
      assert.equal(
        row.log.file,
        row.file.slice(0, -4) + ".log",
        "Original report log does not match its result path",
      );
      assert.ok(!names.has(row.log.file), "Duplicate original report/log");
      const log = await boundedPhysicalBytes(
        path.join(root, row.log.file),
        8 * 1048576,
      );
      assert.deepEqual(
        { bytes: log.length, sha256: sha(log) },
        { bytes: row.log.bytes, sha256: row.log.sha256 },
        "Original log byte identity mismatch",
      );
      names.add(row.log.file);
    } else
      assert.notEqual(
        format,
        "automake-trs",
        "Original Automake log is missing",
      );
    observed ||= row.counts.PASS + row.counts.XFAIL > 0;
    everyReportObserved &&= row.counts.PASS + row.counts.XFAIL > 0;
    failing ||=
      row.counts.FAIL +
        row.counts.XPASS +
        (row.counts.UNRESOLVED ?? 0) +
        row.counts.ERROR >
      0;
  }
  const physicalNames = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const name of await readdir(current)) {
      const file = path.join(current, name);
      const info = await lstat(file);
      assert.ok(!info.isSymbolicLink(), "Linked original report refused");
      if (info.isDirectory()) pending.push(file);
      else {
        assert.ok(info.isFile());
        physicalNames.push(path.relative(root, file).split(path.sep).join("/"));
      }
    }
  }
  assert.deepEqual(
    physicalNames.sort(),
    [...names].sort(),
    "Original physical report inventory differs from retained declaration",
  );
  let minimumSourceObligationsSatisfied = false;
  if (minimum) {
    assert.equal(minimum.completeUpstreamTestInventoryAssessed, false);
    assert.deepEqual(
      (await readdir(root)).sort(),
      [...minimum.buildConfigurations].sort(),
      "Original default build configurations are missing or unexpected",
    );
    for (const file of minimum.minimumExplicitPackageCheckReports)
      assert.ok(
        names.has(file),
        "Required original package test report missing: " + file,
      );
    minimumSourceObligationsSatisfied = true;
  }
  return {
    state: failing
      ? "failed"
      : observed && everyReportObserved
        ? "reported"
        : "unavailable",
    reports: value.reports,
    minimumSourceObligationsSatisfied,
    completeConfigurationInventoryAssessed: false,
    repeatedConfigurationsPooled: false,
  };
}
// Original package defaults may retain failed/skipped tests and still exit zero.
// Preserve that distinction; neither observation closes producer qualification.
export function summarizeBuildCompletion(originalBuild, testEvidence, outputs) {
  assert.ok(
    originalBuild.commandCompleted,
    "Original package command did not complete successfully",
  );
  assert.ok(
    ["reported", "failed", "unavailable"].includes(testEvidence.state),
    "Unknown original test evidence state",
  );
  assert.ok(
    outputs.files.some((row) => row.file.endsWith(".deb")),
    "No original binary package produced",
  );
  return {
    state: "build-completed-qualification-incomplete",
    testEvidenceState: testEvidence.state,
    qualificationComplete: false,
  };
}
// A fixed synchronous child factory is invoked only after raw-log admission.
export async function observeForeground(
  startChild,
  file,
  { timeoutMs, maxBytes, signal, stop },
) {
  assert.ok(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes > 0,
  );
  assert.ok(!signal.aborted, "Interrupted before child admission");
  const log = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let child,
    output,
    timer,
    abort,
    write,
    onDrain,
    onOutputError,
    onChildError,
    onClose;
  let observedTerminal;
  let stopping;
  try {
    assert.ok(!signal.aborted, "Interrupted before child admission");
    output = log.createWriteStream({ autoClose: false });
    const outputFinished = finished(output, { cleanup: true });
    void outputFinished.catch(() => {});
    let stopError = null;
    let bytes = 0;
    let reason = null;
    child = startChild();
    assert.ok(
      child && typeof child.kill === "function" && child.stdout && child.stderr,
      "A synchronous foreground child is required",
    );
    const requestStop = (value) => {
      if (reason !== null) return;
      reason = value;
      stopping = Promise.resolve()
        .then(stop)
        .catch((error) => {
          stopError = String(error);
        })
        .finally(() => {
          child.kill("SIGKILL");
        });
    };
    write = (chunk) => {
      try {
        const remaining = Math.max(0, maxBytes - bytes);
        const accepted = chunk.subarray(0, remaining);
        bytes += accepted.length;
        if (!output.write(accepted)) {
          child.stdout.pause();
          child.stderr.pause();
        }
        if (chunk.length > remaining) requestStop("output-limit");
      } catch {
        requestStop("log-write-failed");
      }
    };
    onDrain = () => {
      child.stdout.resume();
      child.stderr.resume();
    };
    onOutputError = () => requestStop("log-write-failed");
    output.on("drain", onDrain);
    output.on("error", onOutputError);
    child.stdout.on("data", write);
    child.stderr.on("data", write);
    const terminal = new Promise((resolve) => {
      onChildError = (error) => {
        observedTerminal = {
          exitCode: null,
          signal: null,
          error: String(error),
        };
        resolve(observedTerminal);
      };
      onClose = (exitCode, signal) => {
        observedTerminal = { exitCode, signal, error: null };
        resolve(observedTerminal);
      };
      child.once("error", onChildError);
      child.once("close", onClose);
    });
    abort = () =>
      requestStop(
        typeof signal.reason === "string" ? signal.reason : "interrupted",
      );
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => requestStop("deadline"), timeoutMs);
    if (signal.aborted) abort();
    const result = await terminal;
    await stopping;
    output.end();
    try {
      await outputFinished;
    } catch (error) {
      reason ??= "log-write-failed";
      stopError ??= String(error);
    }
    return { ...result, reason, retainedBytes: bytes, stopError };
  } catch (error) {
    let cleanupError;
    if (
      child &&
      typeof child.kill === "function" &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        await (stopping ?? Promise.resolve().then(stop));
      } catch (failure) {
        cleanupError = String(failure);
      } finally {
        child.kill("SIGKILL");
      }
    }
    const failure = new Error("Foreground observer failed: " + String(error), {
      cause: error,
    });
    failure.observedTerminal = observedTerminal;
    failure.cleanupError = cleanupError;
    throw failure;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    if (write) {
      child?.stdout?.off("data", write);
      child?.stderr?.off("data", write);
    }
    if (onChildError) child?.off("error", onChildError);
    if (onClose) child?.off("close", onClose);
    if (onDrain) output?.off("drain", onDrain);
    if (onOutputError) output?.off("error", onOutputError);
    output?.destroy();
    await log.close();
  }
}

async function boundedJson(file, maximum) {
  return JSON.parse(
    (await boundedPhysicalBytes(file, maximum)).toString("utf8"),
  );
}
async function boundedPhysicalBytes(file, maximum) {
  await physicalPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.size <= BigInt(maximum),
      "Physical JSON/report is nonregular or exceeds its byte bound",
    );
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await handle.read(buffer, size, buffer.length - size, null);
      if (next.bytesRead === 0) break;
      size += next.bytesRead;
    }
    assert.ok(
      size <= maximum,
      "Physical JSON/report grew beyond its byte bound",
    );
    const after = await handle.stat({ bigint: true });
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs],
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
    );
    assert.equal(BigInt(size), after.size);
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

export async function atomicReceipt(output, value) {
  const temporary = path.join(output, "receipt." + randomUUID() + ".tmp");
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path.join(output, "receipt.json"));
}
async function docker(args) {
  return exec("docker", args, {
    env: dockerEnvironment,
    timeout: 15000,
    maxBuffer: 65536,
  });
}
async function cleanupContainer(cidFile, attempt) {
  let id = "checktrail-producer-" + attempt;
  try {
    id = (await boundedPhysicalBytes(cidFile, 128)).toString("utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.ok(
    /^[a-f0-9]{64}$/.test(id) || id === "checktrail-producer-" + attempt,
  );
  let inspected;
  try {
    inspected = JSON.parse((await docker(["inspect", id])).stdout)[0];
  } catch (error) {
    if (/No such (object|container)/i.test(error.stderr ?? ""))
      return { state: "absent", id };
    throw error;
  }
  assert.equal(
    inspected.Config.Labels["io.checktrail.producer-attempt"],
    attempt,
    "Refuse cleanup of a different owner",
  );
  await docker(["rm", "--force", id]);
  try {
    await docker(["inspect", id]);
    throw Error("Owned producer container survived cleanup");
  } catch (error) {
    assert.match(error.stderr ?? "", /No such (object|container)/i);
  }
  return { state: "removed", id };
}
async function retainedWorkBytes(roots) {
  let total = 0;
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    const info = await lstat(file);
    assert.ok(!info.isSymbolicLink(), "Linked retained work refused");
    if (info.isDirectory())
      pending.push(
        ...(await readdir(file)).map((name) => path.join(file, name)),
      );
    else {
      assert.ok(info.isFile(), "Nonphysical retained work refused");
      total += info.size;
    }
  }
  return total;
}
async function outputIdentities(work) {
  const directory = path.join(work, "output");
  await physicalPath(directory, true);
  const files = await readdir(directory);
  assert.ok(files.length <= 1024);
  const rows = [];
  for (const file of files.sort()) {
    assert.ok(
      /^[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb|changes|buildinfo)$/.test(file),
    );
    rows.push({ file, ...(await identifyFile(path.join(directory, file))) });
  }
  return { files: rows, publisherByteEqualityAssessed: false };
}
async function main(args) {
  assert.ok(
    args.length === 4 || (args.length === 5 && args[4] === "--prepare-only"),
    "Usage: node scripts/qualify-binutils-producer.mjs --inputs BUNDLE --output NEW_DIRECTORY [--prepare-only]",
  );
  assert.equal(args[0], "--inputs");
  assert.equal(args[2], "--output");
  const inputs = path.resolve(args[1]);
  assert.ok(
    !/[\r\n,]/.test(inputs + args[3] + directory),
    "Docker mount paths cannot contain commas or line breaks",
  );
  const recipeBytes = await readFile(recipeFile);
  const recipe = JSON.parse(recipeBytes);
  assert.equal(recipe.profile, "original-debian-binutils-2.40-2-build-v1");
  assert.deepEqual(recipe.command, [
    "dpkg-buildpackage",
    "-b",
    "-us",
    "-uc",
    "--jobs=4",
  ]);
  assert.deepEqual(recipe.environment, {
    HOME: "/work/home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    DEBIAN_FRONTEND: "noninteractive",
  });
  const controllerBytes = await readFile(fileURLToPath(import.meta.url));
  const minimum = await boundedJson(
    path.join(directory, "binutils-expectations.v1.json"),
    65536,
  );
  await validateInputs(inputs, recipe.files);
  await validateInputs(directory, recipe.controllerFiles);
  const { destination, parent } = await validateDestination(inputs, args[3]);
  const plan = {
    profile: recipe.profile,
    recipeSha256: sha(recipeBytes),
    pinnedInputs: recipe.files.length,
    command: recipe.command,
    image: recipe.image,
    platform: recipe.platform,
    buildExecuted: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
  if (args[4] === "--prepare-only") {
    process.stdout.write(JSON.stringify(plan) + "\n");
    return;
  }
  assert.equal(
    process.platform,
    "linux",
    "Actual qualification requires a Linux host; preparation executes nothing",
  );
  assert.equal(
    process.arch,
    "x64",
    "Actual qualification requires an x64 Node host",
  );
  assert.equal(
    os.machine(),
    "x86_64",
    "Actual qualification requires an observed x86_64 kernel",
  );
  await caseSensitiveParent(parent);
  const free = await statfs(parent, { bigint: true });
  assert.ok(
    free.bavail * free.bsize >=
      BigInt(
        recipe.limits.workByteLimit +
          recipe.limits.logByteLimit +
          recipe.files.reduce((a, b) => a + b.bytes, 0),
      ),
    "Insufficient output filesystem capacity for frozen retention bounds",
  );
  const daemon = JSON.parse(
    (await docker(["info", "--format", "{{json .}}"])).stdout,
  );
  assert.equal(daemon.OSType, "linux");
  assert.match(daemon.Architecture, /^(x86_64|amd64)$/);
  const image = JSON.parse(
    (await docker(["image", "inspect", recipe.image])).stdout,
  )[0];
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  assert.ok(
    image.RepoDigests.includes(recipe.image.replace("docker.io/", "")) ||
      image.RepoDigests.includes(recipe.image),
  );
  await mkdir(destination, { mode: 0o700 });
  const controller = new AbortController();
  const abort = () => controller.abort("caller-signal");
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  const attempt = randomUUID();
  const work = path.join(destination, "work");
  const bundle = path.join(destination, "bundle");
  const controls = path.join(destination, "controls");
  const cid = path.join(destination, "container.id");
  const state = {
    ...plan,
    controllerSha256: sha(controllerBytes),
    attempt,
    state: "preparing",
    startedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      kernelMachine: os.machine(),
      dockerArchitecture: daemon.Architecture,
      hardwareHostAttestationPerformed: false,
      emulatorImplementationIndependentlyQualified: false,
    },
    originalBuild: { invoked: null, exitCode: null, commandCompleted: false },
    testEvidence: { state: "unavailable" },
    outputs: { files: [], publisherByteEqualityAssessed: false },
    qualificationComplete: false,
    cleanup: { state: "pending" },
    nativeFilesystemQuotaEnforced: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  let workLimitTimer;
  try {
    await atomicReceipt(destination, state);
    await mkdir(work, { mode: 0o700 });
    for (const row of recipe.files) {
      assert.ok(
        !controller.signal.aborted,
        "Interrupted before native execution",
      );
      const target = path.join(bundle, row.file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyPinnedInput(path.join(inputs, row.file), target, row);
    }
    await validateInputs(bundle, recipe.files);
    await mkdir(controls, { mode: 0o700 });
    for (const row of recipe.controllerFiles)
      await copyPinnedInput(
        path.join(directory, row.file),
        path.join(controls, row.file),
        row,
      );
    await validateInputs(controls, recipe.controllerFiles);
    await mkdir(path.join(work, "home"), { mode: 0o700 });
    assert.ok(
      !controller.signal.aborted,
      "Interrupted before native execution",
    );
    const mounts = [
      ["source", "/inputs", true],
      ["apt-lists", "/var/lib/apt/lists", false],
      ["apt-archives", "/var/cache/apt/archives", false],
      [
        "keyrings/debian-keyring.gpg",
        "/usr/share/keyrings/debian-keyring.gpg",
        true,
      ],
    ].flatMap(([file, target, readonly]) => [
      "--mount",
      `type=bind,src=${path.join(bundle, file)},target=${target}${readonly ? ",readonly" : ""}`,
    ]);
    const argv = [
      "run",
      "--rm",
      "--init",
      "--pull=never",
      "--platform",
      recipe.platform,
      "--user",
      "0:0",
      "--cidfile",
      cid,
      "--name",
      "checktrail-producer-" + attempt,
      "--network",
      "none",
      "--cpus",
      String(recipe.limits.cpuLimit),
      "--memory",
      recipe.limits.memory,
      "--pids-limit",
      String(recipe.limits.pidsLimit),
      "--label",
      "io.checktrail.producer-attempt=" + attempt,
      "--entrypoint",
      "/usr/bin/env",
      ...mounts,
      "--mount",
      "type=bind,src=" + work + ",target=/work",
      "--mount",
      "type=bind,src=" + controls + ",target=/controller,readonly",
      "--workdir",
      "/work",
      recipe.image,
      "-i",
      ...Object.entries(recipe.environment).map(
        ([key, value]) => key + "=" + value,
      ),
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=30s",
      String(recipe.limits.deadlineSeconds),
      "/bin/sh",
      "/controller/binutils-build.sh",
    ];

    let measuring = false;
    workLimitTimer = setInterval(async () => {
      if (measuring) return;
      measuring = true;
      try {
        if (
          (await retainedWorkBytes([bundle, controls, work])) >
          recipe.limits.workByteLimit
        )
          controller.abort("retained-work-limit");
      } catch (error) {
        state.retentionObservationError = String(error).slice(0, 1000);
        controller.abort("retained-work-observer-unavailable");
      } finally {
        measuring = false;
      }
    }, 1000);
    state.state = "starting";
    await atomicReceipt(destination, state);
    const native = await observeForeground(
      () => {
        state.executionInvoked = true;
        state.state = "running";
        state.buildExecuted = true;
        return spawn("docker", argv, {
          env: dockerEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });
      },
      path.join(destination, "build.log"),
      {
        timeoutMs: recipe.limits.deadlineSeconds * 1000,
        maxBytes: recipe.limits.logByteLimit,
        signal: controller.signal,
        stop: () => cleanupContainer(cid, attempt),
      },
    );
    state.executionObserver = native;
    const command = await boundedJson(
      path.join(work, "original-command.json"),
      4096,
    );
    assert.equal(command.schemaVersion, 1);
    assert.deepEqual(command.command, recipe.command);
    assert.equal(typeof command.invoked, "boolean");
    assert.ok(
      command.exitCode === null ||
        (Number.isSafeInteger(command.exitCode) &&
          command.exitCode >= 0 &&
          command.exitCode <= 255),
    );
    state.originalBuild = {
      invoked: command.invoked,
      exitCode: command.exitCode,
      commandCompleted:
        command.invoked &&
        command.exitCode === 0 &&
        native.exitCode === 0 &&
        native.reason === null,
      wrapperExitCode: command.wrapperExitCode,
    };
    state.log = await identifyFile(path.join(destination, "build.log"));
    state.cleanup = await cleanupContainer(cid, attempt);
    state.testEvidence = await summarizeReports(
      await boundedJson(path.join(work, "test-reports.json"), 8 * 1024 * 1024),
      path.join(work, "original-test-reports"),
      minimum,
    );
    state.outputs = await outputIdentities(work);
    state.retainedWorkBytes = await retainedWorkBytes([bundle, controls, work]);
    assert.ok(
      state.retainedWorkBytes <= recipe.limits.workByteLimit,
      "Retained work exceeded bound",
    );
    state.retainedNativeWorktree = await identifyFile(
      path.join(work, "native-build-worktree.tar"),
    );
    assert.ok(
      state.retainedNativeWorktree.bytes <= recipe.limits.workByteLimit,
      "Retained work exceeded bound",
    );
    await validateInputs(inputs, recipe.files);
    state.buildCompletion = summarizeBuildCompletion(
      state.originalBuild,
      state.testEvidence,
      state.outputs,
    );
    assert.ok(
      !controller.signal.aborted,
      "Interrupted during result collection",
    );
    state.state = state.buildCompletion.state;
  } catch (error) {
    state.stopTrigger = controller.signal.aborted
      ? controller.signal.reason
      : (state.executionObserver?.reason ?? null);
    state.state =
      state.stopTrigger === "retained-work-limit"
        ? "resource-limit"
        : state.stopTrigger === "retained-work-observer-unavailable"
          ? "observer-failed"
          : controller.signal.aborted
            ? "interrupted"
            : state.stopTrigger === "deadline"
              ? "timed-out"
              : "failed";
    state.executionObserver ??=
      error && typeof error === "object" ? error.observedTerminal : undefined;
    state.error = String(error).slice(0, 2000);
  } finally {
    clearInterval(workLimitTimer);
    try {
      state.cleanup = await cleanupContainer(cid, attempt);
    } catch (error) {
      state.cleanup = {
        state: "unavailable",
        error: String(error).slice(0, 1000),
      };
      state.state = "failed";
    }
    state.finishedAt = new Date().toISOString();
    await atomicReceipt(destination, state);
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
  process.stdout.write(
    JSON.stringify({
      state: state.state,
      receipt: path.join(destination, "receipt.json"),
      gateAComplete: false,
    }) + "\n",
  );
  process.exitCode = 2; // Configuration/ancestry/notice qualification is deliberately still incomplete.
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
