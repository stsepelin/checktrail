import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
const { AbortController } = globalThis;
import { performance } from "node:perf_hooks";
import { stopDescendants } from "../dist/src/process-tree.js";

export const validationPhases = JSON.parse(
  await readFile(
    new URL("./ci-validation-phases.json", import.meta.url),
    "utf8",
  ),
);
export const commandKey = ({ script, args, env }) =>
  JSON.stringify([script, args, Object.entries(env).sort()]);
export function validatePhases(phases) {
  assert.deepEqual(Object.keys(phases).sort(), ["mutations", "packages"]);
  const keys = new Set();
  for (const tasks of Object.values(phases)) {
    assert.ok(
      Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 64,
      "CI lanes must be nonempty and bounded",
    );
    for (const task of tasks) {
      assert.deepEqual(Object.keys(task).sort(), ["args", "env", "script"]);
      assert.match(task.script, /^scripts\/[a-z0-9-]+\.mjs$/);
      assert.ok(
        Array.isArray(task.args) &&
          task.args.length <= 4 &&
          task.args.every((a) => typeof a === "string" && a.length <= 1024),
      );
      assert.ok(
        task.env && typeof task.env === "object" && !Array.isArray(task.env),
      );
      for (const [name, value] of Object.entries(task.env)) {
        assert.equal(name, "CHECKTRAIL_IMPORT_CONTEXT_PROFILE");
        assert.match(value, /^[a-z-]+$/);
      }
      const key = commandKey(task);
      assert.ok(!keys.has(key), "CI command repeated");
      keys.add(key);
    }
  }
}
async function inputs(repository) {
  const files = execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      cwd: repository,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
    },
  )
    .split("\0")
    .filter(Boolean);
  async function compiled(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + "/" + entry.name;
      if (entry.isDirectory())
        await compiled(path.join(directory, entry.name), name);
      else {
        assert.ok(entry.isFile(), "Compiled CI input must be regular");
        files.push(name);
      }
    }
  }
  await compiled(path.join(repository, "dist"), "dist");
  assert.ok(files.length > 0 && files.length < 20000);
  return [...new Set(files)].sort();
}
async function snapshotInputs(root) {
  const files = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && ["node_modules", ".checktrail"].includes(entry.name))
        continue;
      const file = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory())
        await walk(path.join(directory, entry.name), file);
      else {
        assert.ok(entry.isFile(), "Mutation input must remain regular");
        files.push(file);
      }
    }
  }
  await walk(root);
  return files.sort();
}
async function fingerprint(repository, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    assert.ok(
      !path.isAbsolute(file) &&
        !file.split("/").some((part) => ["", ".", ".."].includes(part)),
    );
    assert.ok(
      (await lstat(path.join(repository, file))).isFile(),
      "CI source input must be regular: " + file,
    );
    hash.update(JSON.stringify(file));
    hash.update(
      createHash("sha256")
        .update(await readFile(path.join(repository, file)))
        .digest(),
    );
  }
  return hash.digest("hex");
}
async function snapshot(repository, destination, files) {
  for (const file of files) {
    await mkdir(path.dirname(path.join(destination, file)), {
      recursive: true,
    });
    await cp(path.join(repository, file), path.join(destination, file));
  }
  // These are prepared dependencies, not mutable source. Existing controllers
  // create their projects, installs and caches in the lane's private TMPDIR.
  for (const name of ["node_modules", ".checktrail"]) {
    const source = path.join(repository, name);
    try {
      await symlink(
        await realpath(source),
        path.join(destination, name),
        "dir",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
export async function runCiCommand(
  repository,
  task,
  { signal, temporary, log, maxOutputBytes = 16 * 1048576 },
) {
  assert.ok(!signal.aborted, "CI lane aborted before command admission");
  assert.ok(
    Number.isSafeInteger(maxOutputBytes) &&
      maxOutputBytes > 0 &&
      maxOutputBytes <= 16 * 1048576,
  );
  const output = await open(log, "wx");
  const start = performance.now();
  let child, stopping;
  let outputBytes = 0,
    retainedBytes = 0,
    outputExceeded = false;
  try {
    await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [task.script, ...task.args], {
        cwd: repository,
        detached: true,
        env: {
          ...process.env,
          ...task.env,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stop = () => {
        if (stopping || !child.pid) return;
        stopping = (async () => {
          const killRoot = () => {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (
                error.code !== "ESRCH" &&
                child.exitCode === null &&
                child.signalCode === null
              ) {
                child.kill("SIGKILL");
              }
            }
          };
          try {
            child.kill("SIGSTOP");
            await stopDescendants(child.pid, undefined, killRoot);
          } finally {
            killRoot();
          }
        })();
        stopping.catch(() => {});
      };
      const capture = (chunk) => {
        outputBytes += chunk.length;
        const retained = chunk.subarray(
          0,
          Math.max(0, maxOutputBytes - retainedBytes),
        );
        if (retained.length) {
          writeSync(output.fd, retained);
          retainedBytes += retained.length;
        }
        if (outputBytes > maxOutputBytes) {
          outputExceeded = true;
          stop();
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.once("error", reject);
      child.once("close", (code, childSignal) => {
        signal.removeEventListener("abort", stop);
        if (code === 0 && !childSignal && !signal.aborted && !outputExceeded)
          resolve();
        else
          reject(
            Error(
              (outputExceeded
                ? "CI command output limit exceeded: "
                : "CI command failed or cancelled: ") +
                commandKey(task) +
                " (code=" +
                code +
                ", signal=" +
                childSignal +
                ")",
            ),
          );
      });
    });
    return {
      command: commandKey(task),
      durationMs: Math.round(performance.now() - start),
      passed: true,
      outputBytes,
      log,
    };
  } finally {
    try {
      if (stopping) await stopping;
    } finally {
      await output.close();
    }
  }
}
export async function runValidationLanes(
  repository,
  {
    phases = validationPhases,
    timeoutMs = 45 * 60 * 1000,
    signal,
    logDirectory = path.join(repository, ".checktrail/ci-lanes"),
    progress = () => {},
    emitLog = () => {},
  } = {},
) {
  assert.ok(["darwin", "linux"].includes(process.platform));
  validatePhases(phases);
  assert.ok(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 45 * 60 * 1000,
  );
  for (const task of Object.values(phases).flat())
    assert.ok((await lstat(path.join(repository, task.script))).isFile());
  const files = await inputs(repository),
    before = await fingerprint(repository, files);
  await mkdir(logDirectory, { recursive: true });
  const logs = await mkdtemp(path.join(logDirectory, "run-"));
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-ci-lanes-"));
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  const cancellation = () => abort.abort();
  signal?.addEventListener("abort", cancellation, { once: true });
  if (signal?.aborted) abort.abort();
  const started = performance.now();
  try {
    const mutationRoot = path.join(temporary, "mutations");
    await mkdir(mutationRoot);
    await snapshot(repository, mutationRoot, files);
    assert.equal(
      await fingerprint(mutationRoot, files),
      before,
      "CI snapshot differs from source",
    );
    const outcomes = await Promise.allSettled(
      Object.entries(phases).map(async ([lane, tasks]) => {
        const root = lane === "mutations" ? mutationRoot : repository;
        const namespace = path.join(temporary, lane + "-tmp");
        await mkdir(namespace);
        const receipts = [];
        for (const [index, task] of tasks.entries()) {
          progress({ lane, index, script: task.script, state: "started" });
          const log = path.join(logs, lane + "-" + index + ".log");
          let receipt, failure;
          try {
            receipt = await runCiCommand(root, task, {
              signal: abort.signal,
              temporary: namespace,
              log,
            });
          } catch (error) {
            failure = error;
          }
          try {
            emitLog(
              { lane, index, script: task.script, log },
              await readFile(log),
            );
          } catch (error) {
            failure ??= error;
          }
          if (failure) {
            progress({
              lane,
              index,
              script: task.script,
              state: "failed",
              log,
            });
            throw failure;
          }
          receipts.push(receipt);
          progress({
            lane,
            index,
            script: task.script,
            state: "passed",
            durationMs: receipt.durationMs,
          });
        }
        assert.equal(receipts.length, tasks.length);
        return { lane, receipts };
      }),
    );
    const failures = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    assert.deepEqual(
      await inputs(repository),
      files,
      "CI source inventory changed",
    );
    assert.equal(
      await fingerprint(repository, files),
      before,
      "CI source bytes changed",
    );
    assert.deepEqual(
      await snapshotInputs(mutationRoot),
      files,
      "Mutation source inventory changed",
    );
    assert.equal(
      await fingerprint(mutationRoot, files),
      before,
      "Mutation source was not restored",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((outcome) => outcome.reason),
        "Required CI lanes failed; logs: " + logs,
      );
    assert.ok(
      !abort.signal.aborted,
      "CI lanes did not finish before cancellation/deadline",
    );
    return {
      complete: true,
      sourceSha256: before,
      sourceStable: true,
      mutationsRestored: true,
      maxConcurrentCommands: 2,
      lanes: outcomes.map((outcome) => outcome.value),
      durationMs: Math.round(performance.now() - started),
      logs,
    };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancellation);
    await rm(temporary, { recursive: true, force: true });
  }
}
