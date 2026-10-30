// Explicit operator development utility. Discovery, CLI review and MCP never call it.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { setInterval, clearInterval } from "node:timers";
import { promisify } from "node:util";
import {
  loadAcquisitionPlan,
  pinnedSnapshot,
  bytePin,
  safeRelative,
} from "./producer-qualification/binutils-acquisition-plan.mjs";
import {
  atomicReceipt,
  identifyFile,
  observeForeground,
  physicalPath,
  validateInputs,
} from "./qualify-binutils-producer.mjs";

const exec = promisify(execFile);
const sourceDirectory = fileURLToPath(
  new URL("producer-qualification/", import.meta.url),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const absent = async (file) =>
  assert.rejects(
    lstat(file),
    (error) => error.code === "ENOENT",
    "Destination already exists",
  );

/** Consume one response into an exclusive private partial file; never publish bad bytes. */
export async function retainDownload(response, target, pin, signal) {
  bytePin(pin);
  assert.ok(pin.bytes > 0);
  await physicalPath(path.dirname(target), true);
  await absent(target);
  assert.equal(response.status, 200, "Expected original HTTP200 response");
  assert.ok(
    response.body && !response.redirected,
    "Missing or redirected download body",
  );
  const length = response.headers.get("content-length");
  if (length !== null)
    assert.equal(
      length,
      String(pin.bytes),
      "Content-Length differs from frozen pin",
    );
  const encoding = response.headers.get("content-encoding");
  assert.ok(
    encoding === null || encoding === "identity",
    "Encoded response refused",
  );
  const partial = target + ".part";
  const file = await open(
    partial,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      bytes += chunk.length;
      assert.ok(bytes <= pin.bytes, "Download exceeds frozen byte limit");
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = await file.write(chunk, offset, chunk.length - offset);
        assert.ok(
          written.bytesWritten > 0,
          "Download storage made no progress",
        );
        offset += written.bytesWritten;
      }
    }
    signal.throwIfAborted();
    assert.equal(bytes, pin.bytes, "Download ended before frozen byte count");
    assert.equal(
      digest.digest("hex"),
      pin.sha256,
      "Download SHA256 differs from frozen pin",
    );
    await file.sync();
  } finally {
    await file.close();
  }
  assert.deepEqual(await identifyFile(partial, pin.bytes), {
    bytes: pin.bytes,
    sha256: pin.sha256,
  });
  // link is exclusive, unlike a rename which can overwrite an intervening file.
  await link(partial, target);
  await unlink(partial);
  return { bytes, sha256: pin.sha256 };
}

export async function downloadOriginal(row, target, signal) {
  pinnedSnapshot(row.url);
  const response = await globalThis.fetch(row.url, {
    redirect: "error",
    signal,
    headers: {
      "accept-encoding": "identity",
      "user-agent": "Checktrail-frozen-producer-inputs",
    },
  });
  try {
    assert.equal(response.url, row.url, "Response origin changed");
    return await retainDownload(response, target, row, signal);
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
}

export async function parallelDownloads(
  rows,
  root,
  { workers, perFileMs },
  signal,
  request = downloadOriginal,
) {
  assert.ok(Number.isSafeInteger(workers) && workers >= 1 && workers <= 4);
  assert.ok(
    Number.isSafeInteger(perFileMs) && perFileMs > 0 && perFileMs <= 180000,
  );
  assert.ok(rows.length > 0 && rows.length <= 348);
  const names = new Set();
  for (const row of rows) {
    safeRelative(row.id);
    pinnedSnapshot(row.url);
    bytePin(row);
    assert.ok(!names.has(row.id), "Duplicate download target");
    names.add(row.id);
  }
  // Admit every target before starting any request.
  await physicalPath(root, true);
  for (const row of rows) {
    const target = path.join(root, row.id);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await physicalPath(path.dirname(target), true);
    await absent(target);
    await absent(target + ".part");
  }
  const stop = new globalThis.AbortController();
  const joined = globalThis.AbortSignal.any([signal, stop.signal]);
  let next = 0;
  const results = new Array(rows.length);
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(workers, rows.length) }, async () => {
      while (!joined.aborted) {
        const index = next++;
        if (index >= rows.length) return;
        const row = rows[index],
          startedAt = new Date().toISOString();
        try {
          const timeout = globalThis.AbortSignal.timeout(perFileMs);
          const result = await request(
            row,
            path.join(root, row.id),
            globalThis.AbortSignal.any([joined, timeout]),
          );
          assert.deepEqual(
            result,
            { bytes: row.bytes, sha256: row.sha256 },
            "Downloader result differs from frozen pin",
          );
          results[index] = {
            id: row.id,
            state: "matched",
            startedAt,
            finishedAt: new Date().toISOString(),
            ...result,
          };
        } catch (error) {
          results[index] = {
            id: row.id,
            state: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
            error: String(error).slice(0, 2048),
          };
          failed = true;
          stop.abort("download-failed");
        }
      }
    }),
  );
  for (let index = 0; index < rows.length; index++)
    results[index] ??= { id: rows[index].id, state: "unrun" };
  return {
    complete:
      !failed &&
      !signal.aborted &&
      results.every((row) => row.state === "matched"),
    results,
  };
}

async function docker(args) {
  return exec("docker", args, { timeout: 10000, maxBuffer: 1048576 });
}
async function imageObservation(plan) {
  const result = await docker(["image", "inspect", plan.transform.image]);
  const images = JSON.parse(result.stdout);
  assert.equal(images.length, 1);
  const image = images[0];
  assert.equal(image.Id, plan.transform.observedImageId);
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  assert.ok(
    image.RepoDigests.some(
      (ref) => ref.split("@")[1] === plan.transform.image.split("@")[1],
    ),
  );
  return { id: image.Id, os: image.Os, architecture: image.Architecture };
}
async function cleanup(name, attempt) {
  const ids = (
    await docker(["ps", "--all", "--quiet", "--filter", "name=^/" + name + "$"])
  ).stdout.trim();
  if (ids) {
    assert.match(ids, /^[a-f0-9]{12,64}$/);
    const [found] = JSON.parse((await docker(["inspect", ids])).stdout);
    assert.equal(found.Name, "/" + name);
    assert.equal(
      found.Config.Labels["checktrail.acquisition-attempt"],
      attempt,
    );
    await docker(["rm", "--force", ids]);
  }
  assert.equal(
    (
      await docker([
        "ps",
        "--all",
        "--quiet",
        "--filter",
        "name=^/" + name + "$",
      ])
    ).stdout.trim(),
    "",
  );
  return { state: "absent", ownershipCheckedBeforeRemoval: Boolean(ids) };
}
async function checkedJson(file, limit) {
  const before = await identifyFile(file, limit);
  const raw = await readFile(file);
  assert.deepEqual({ bytes: raw.length, sha256: sha(raw) }, before);
  return JSON.parse(raw.toString("utf8"));
}
export async function retainedTreeBytes(root, maximum) {
  let total = 0,
    entries = 0;
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      assert.ok(++entries <= 10000, "Retention inventory exceeded bound");
      const file = path.join(directory, name),
        info = await lstat(file).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (info === null) continue;
      assert.ok(!info.isSymbolicLink(), "Retention contains a linked path");
      if (info.isDirectory()) await walk(file);
      else {
        assert.ok(info.isFile(), "Retention contains a special file");
        total += info.size;
        assert.ok(
          Number.isSafeInteger(total) && total <= maximum,
          "Retained inputs exceeded bound",
        );
      }
    }
  }
  await walk(root);
  return total;
}

export async function verifyExactBundle(root, rows) {
  await validateInputs(root, rows);
  const actualFiles = [],
    actualDirectories = [];
  let entries = 0;
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      assert.ok(++entries <= 10000, "Bundle inventory exceeded bound");
      const file = path.join(directory, name),
        info = await lstat(file);
      const relative = path.relative(root, file).split(path.sep).join("/");
      assert.ok(!info.isSymbolicLink(), "Linked bundle entry refused");
      if (info.isDirectory()) {
        actualDirectories.push(relative);
        await walk(file);
      } else {
        assert.ok(info.isFile(), "Special bundle entry refused");
        actualFiles.push(relative);
      }
    }
  }
  await walk(root);
  const expectedDirectories = new Set();
  for (const row of rows) {
    let parent = path.posix.dirname(row.file);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  assert.deepEqual(
    actualFiles.sort(),
    rows.map((row) => row.file).sort(),
    "Physical bundle files differ from frozen inventory",
  );
  assert.deepEqual(
    actualDirectories.sort(),
    [...expectedDirectories].sort(),
    "Physical bundle directories differ from frozen inventory",
  );
  return {
    files: actualFiles.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
}

async function acquire(output) {
  assert.ok(
    typeof process.getuid === "function" &&
      typeof process.getgid === "function",
    "POSIX host identity required for the original metadata container",
  );
  const plan = await loadAcquisitionPlan();
  const outputRoot = path.resolve(output);
  assert.ok(!/[\0\r\n,]/u.test(outputRoot), "Mount path is ambiguous");
  await physicalPath(path.dirname(outputRoot), true);
  await absent(outputRoot);
  const before = await imageObservation(plan); // Admission must not start an implicit pull.
  await mkdir(outputRoot, { mode: 0o700 });
  const attempt = randomUUID(),
    name = "checktrail-acquire-binutils-" + attempt;
  const state = {
    schemaVersion: 1,
    state: "acquiring",
    attempt,
    startedAt: new Date().toISOString(),
    planSha256: sha(JSON.stringify(plan)),
    image: before,
    compilationExecuted: false,
    originalPackageBuildExecuted: false,
    completeInputBundleReacquisitionVerified: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort("interrupted");
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  const signal = globalThis.AbortSignal.any([
    controller.signal,
    globalThis.AbortSignal.timeout(30 * 60 * 1000),
  ]);
  let retentionPending;
  const timer = setInterval(() => {
    if (retentionPending) return;
    retentionPending = retainedTreeBytes(outputRoot, plan.limits.retainedBytes)
      .catch((error) => {
        state.retentionError = String(error).slice(0, 2048);
        controller.abort("retention-observer-failed");
      })
      .finally(() => {
        retentionPending = undefined;
      });
  }, 1000);
  const downloadRoot = path.join(outputRoot, "downloads"),
    controls = path.join(outputRoot, "controls"),
    staging = path.join(outputRoot, "bundle-staging"),
    data = path.join(outputRoot, "transform");
  try {
    await atomicReceipt(outputRoot, state);
    for (const folder of [downloadRoot, controls, staging, data])
      await mkdir(folder, { mode: 0o700 });
    const helper = path.join(sourceDirectory, "binutils-prepare-inputs.py");
    const helperIdentity = await identifyFile(helper, 1048576);
    await copyFile(
      helper,
      path.join(controls, "prepare.py"),
      constants.COPYFILE_EXCL,
    );
    await writeFile(path.join(controls, "plan.json"), JSON.stringify(plan), {
      mode: 0o600,
      flag: "wx",
    });
    state.downloads = await parallelDownloads(
      plan.downloads,
      downloadRoot,
      plan.limits,
      signal,
    );
    await atomicReceipt(outputRoot, state);
    assert.equal(
      state.downloads.complete,
      true,
      "Input download batch is incomplete",
    );
    signal.throwIfAborted();
    for (const row of plan.operations) {
      const target = path.join(staging, row.file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (row.kind === "copy-original-download")
        await link(path.join(downloadRoot, row.input), target);
      else if (row.kind === "generate-empty-lock")
        await writeFile(target, "", { mode: 0o600, flag: "wx" });
    }
    const args = [
      "run",
      "--rm",
      "--init",
      "--pull=never",
      "--name",
      name,
      "--label",
      "checktrail.acquisition-attempt=" + attempt,
      "--platform",
      plan.transform.platform,
      "--network",
      "none",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--pids-limit",
      "64",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=128m",
    ];
    for (const [source, target, readonly] of [
      [downloadRoot, "/inputs", true],
      [controls, "/controller", true],
      [staging, "/bundle", false],
      [data, "/output", false],
    ])
      args.push(
        "--mount",
        `type=bind,src=${source},target=${target}${readonly ? ",readonly" : ""}`,
      );
    args.push(
      "--entrypoint",
      "/usr/bin/env",
      before.id,
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "python3",
      "/controller/prepare.py",
    );
    state.transform = await observeForeground(
      () => spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }),
      path.join(outputRoot, "transform.log"),
      {
        timeoutMs: plan.limits.transformMs,
        maxBytes: 8 * 1024 ** 2,
        signal,
        stop: () => cleanup(name, attempt),
      },
    );
    assert.deepEqual(
      [
        state.transform.exitCode,
        state.transform.signal,
        state.transform.error,
        state.transform.reason,
        state.transform.stopError,
      ],
      [0, null, null, null, null],
      "Original data transformation was incomplete",
    );
    state.preparation = await checkedJson(
      path.join(data, "preparation.json"),
      1048576,
    );
    assert.equal(state.preparation.complete, true);
    assert.equal(state.preparation.releaseSignatures.length, 3);
    assert.equal(state.preparation.sourceSignatureVerified, true);
    for (const key of [
      "sourceSignatureFaultControl",
      "releaseSignatureFaultControl",
    ]) {
      assert.ok(
        Number.isInteger(state.preparation[key]?.changedExitCode) &&
          state.preparation[key].changedExitCode !== 0,
      );
      assert.equal(state.preparation[key]?.restoredExitCode, 0);
    }
    assert.equal(
      state.preparation.allSourceArchivesBoundBySignedDescriptor,
      true,
    );
    const recipe = JSON.parse(
      await readFile(path.join(sourceDirectory, "binutils.v1.json"), "utf8"),
    );
    const bundleInventory = await verifyExactBundle(staging, recipe.files);
    for (const row of plan.downloads)
      assert.deepEqual(
        await identifyFile(path.join(downloadRoot, row.id), row.bytes),
        { bytes: row.bytes, sha256: row.sha256 },
      );
    assert.deepEqual(await identifyFile(helper, 1048576), helperIdentity);
    assert.deepEqual(
      await identifyFile(path.join(controls, "prepare.py"), 1048576),
      helperIdentity,
    );
    assert.deepEqual(
      await loadAcquisitionPlan(),
      plan,
      "Planning inputs changed during acquisition",
    );
    assert.deepEqual(
      await imageObservation(plan),
      before,
      "Selected image changed during acquisition",
    );
    signal.throwIfAborted();
    await cleanup(name, attempt);
    state.retainedBytesBeforePublication = await retainedTreeBytes(
      outputRoot,
      plan.limits.retainedBytes,
    );
    assert.ok(!state.retentionError);
    await rename(staging, path.join(outputRoot, "bundle"));
    state.state = "complete-original-input-bundle";
    state.completeInputBundleReacquisitionVerified = true;
    state.physicalPinnedInputs = bundleInventory.files;
    state.physicalInputBytes = bundleInventory.bytes;
  } catch (error) {
    state.state = "failed";
    state.error = String(error).slice(0, 2048);
  } finally {
    clearInterval(timer);
    await retentionPending;
    try {
      state.cleanup = await cleanup(name, attempt);
    } catch (error) {
      state.state = "failed";
      state.completeInputBundleReacquisitionVerified = false;
      state.cleanup = {
        state: "unavailable",
        error: String(error).slice(0, 2048),
      };
    }
    if (state.retentionError) {
      state.state = "failed";
      state.completeInputBundleReacquisitionVerified = false;
    }
    state.finishedAt = new Date().toISOString();
    await atomicReceipt(outputRoot, state);
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
  process.stdout.write(
    JSON.stringify({
      state: state.state,
      bundle: path.join(outputRoot, "bundle"),
      gateAComplete: false,
    }) + "\n",
  );
  if (!state.completeInputBundleReacquisitionVerified) process.exitCode = 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 3);
    assert.equal(args[0], "--output");
    assert.equal(args[2], "--operator-trust-execution");
    await acquire(args[1]);
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
