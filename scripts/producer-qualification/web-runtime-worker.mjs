import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  realpath,
  access,
  open,
  lstat,
  readdir,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  LIMITS,
  identify,
  originalRecipe,
  originalSourceDirectory,
  originalSdkDirectory,
  validateArtifacts,
  verifyCache,
  completeProcessObservation,
} from "./web-runtime-controller.mjs";

export async function verifyColdSourceDirectory(directory) {
  assert.equal(
    await realpath(directory),
    directory,
    "Source directory crosses a link",
  );
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.deepEqual(
    await readdir(directory),
    [],
    "Original source must start empty",
  );
  return directory;
}

export async function prepareColdSdkDirectory(directory, source) {
  if (directory.startsWith(source + "/")) {
    assert.equal(directory, source + "/emsdk/upstream");
    assert.equal(await realpath(source), source, "SDK parent crosses a link");
    // Neither mkdir is recursive: original source cannot redirect this new subtree.
    await mkdir(path.posix.join(source, "emsdk"), { mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
  }
  return verifyColdSourceDirectory(directory);
}

export async function verifyRuntimeTools(runtime) {
  const names = {
    node: process.execPath,
    npm: "npm",
    cargo: "cargo",
    rustc: "rustc",
    python: "python3",
    tar: "tar",
    git: "git",
  };
  for (const tool of runtime.tools) {
    const candidates = path.isAbsolute(names[tool.id])
      ? [names[tool.id]]
      : process.env.PATH.split(path.delimiter)
          .filter((value) => path.isAbsolute(value))
          .map((directory) => path.join(directory, names[tool.id]));
    let selected = null;
    for (const filename of candidates) {
      try {
        await access(filename, constants.X_OK);
        selected = await realpath(filename);
        break;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
      }
    }
    assert.ok(selected);
    assert.equal(selected, await realpath(tool.file));
    assert.deepEqual(await identify(selected), {
      bytes: tool.bytes,
      sha256: tool.sha256,
    });
  }
}
export function boundedBytes(chunks, maximum = LIMITS.streamBytes) {
  let observedBytes = 0,
    retainedBytes = 0;
  const retained = [];
  for (const bytes of chunks) {
    observedBytes += bytes.length;
    const part = bytes.subarray(0, Math.max(0, maximum - retainedBytes));
    retained.push(part);
    retainedBytes += part.length;
  }
  return {
    observedBytes,
    retained: Buffer.concat(retained),
    truncated: observedBytes > maximum,
  };
}
export function sdkRelocation(recipe, inheritedPath) {
  assert.equal(typeof inheritedPath, "string");
  const sdk = originalSdkDirectory(recipe);
  return {
    configuration:
      "LLVM_ROOT = " +
      JSON.stringify(path.posix.join(sdk, "bin")) +
      "\nBINARYEN_ROOT = " +
      JSON.stringify(sdk) +
      "\nNODE_JS = ['/work/sdk-node/bin/node']\n",
    path: path.posix.join(sdk, "emscripten") + ":" + inheritedPath,
  };
}

export function runtimeVersionProbes(runtime, recipe) {
  return [
    ["npm", ["--version"], runtime.npmVersion],
    ["rustc", ["--version"], "rustc " + runtime.rustVersion + " "],
    ["/work/sdk-node/bin/node", ["--version"], "v22.16.0"],
    [
      originalSdkDirectory(recipe) + "/emscripten/emcc",
      ["--version"],
      "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 4.0.15-git (09f52557f0d48b65b8c724853ed8f4e8bf80e669)",
    ],
  ];
}
export function versionProbeMatches(executable, text, expected) {
  if (executable === "rustc") return text.startsWith(expected);
  if (path.posix.basename(executable) === "emcc") {
    const first = text.split("\n")[0];
    return first === expected || first.startsWith(expected + " ");
  }
  return text === expected;
}
export function inspectResourceObservation(value) {
  const parts = value.cpuMax.trim().split(/\s+/);
  assert.equal(parts.length, 2);
  const [quota, period] = parts.map(Number);
  assert.ok(
    Number.isSafeInteger(quota) &&
      Number.isSafeInteger(period) &&
      period > 0 &&
      quota === 2 * period,
  );
  assert.equal(value.memoryMax.trim(), String(LIMITS.memoryBytes));
  assert.equal(value.pidsMax.trim(), "256");
  return {
    cpus: quota / period,
    memoryBytes: Number(value.memoryMax),
    pids: Number(value.pidsMax),
  };
}
export async function boundedProcess(executable, args, options) {
  assert.ok(Number.isFinite(options.deadline));
  const started = performance.now();
  const result = {
    executable,
    args,
    started: false,
    terminalObserved: false,
    pid: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    interrupted: false,
    truncated: false,
    spawnError: null,
    storageFailure: null,
    logAdmissionFailed: false,
  };
  const targets = {
    stdout: options.prefix + ".stdout.log",
    stderr: options.prefix + ".stderr.log",
    started: options.prefix + ".started.json",
    attempt: options.prefix + ".attempt.json",
  };
  const handles = {},
    identities = {};
  const journal = async (handle, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      assert.ok(wrote.bytesWritten > 0);
      offset += wrote.bytesWritten;
    }
    await handle.sync();
  };
  try {
    // Reserve the complete output family before a producer can start. No deferred stream opens.
    for (const kind of ["stdout", "stderr", "started", "attempt"]) {
      handles[kind] = await open(targets[kind], "wx", 0o600);
      const stat = await handles[kind].stat({ bigint: true });
      identities[kind] = { dev: stat.dev, ino: stat.ino };
    }
    await journal(handles.started, { started: false, state: "admitted" });
    await journal(handles.attempt, { ...result, state: "admitted" });
  } catch (error) {
    result.logAdmissionFailed = true;
    result.storageFailure = String(error).slice(0, 1024);
    result.admissionRollbackErrors = [];
    for (const [kind, handle] of Object.entries(handles)) {
      try {
        await handle.close();
        const stat = await lstat(targets[kind], { bigint: true });
        assert.equal(stat.dev, identities[kind].dev);
        assert.equal(stat.ino, identities[kind].ino);
        await unlink(targets[kind]);
      } catch (rollbackError) {
        result.admissionRollbackErrors.push(
          String(rollbackError).slice(0, 1024),
        );
      }
    }
    result.durationMs = performance.now() - started;
    return result;
  }
  const streams = Object.fromEntries(
    ["stdout", "stderr"].map((kind) => [
      kind,
      { file: targets[kind], observedBytes: 0, retainedBytes: 0 },
    ]),
  );
  const queues = { stdout: Promise.resolve(), stderr: Promise.resolve() },
    failedStreams = new Set();
  let child,
    timeout,
    escalation,
    startedReceipt,
    terminated = false;
  const stop = () => {
    if (!child?.pid || terminated) return;
    terminated = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH")
        result.terminationError = String(error).slice(0, 1024);
    }
    escalation = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH")
          result.terminationError = String(error).slice(0, 1024);
      }
    }, 250);
  };
  const storageFailed = (error) => {
    result.storageFailure ??= String(error).slice(0, 1024);
    stop();
  };
  // Promise rejection handlers exist before spawn; every stream write is serialized and bounded.
  const enqueue = (kind, chunk) => {
    const value = streams[kind];
    value.observedBytes += chunk.length;
    const bytes = Buffer.from(
        chunk.subarray(
          0,
          Math.max(0, LIMITS.streamBytes - value.retainedBytes),
        ),
      ),
      position = value.retainedBytes;
    value.retainedBytes += bytes.length;
    queues[kind] = queues[kind]
      .then(async () => {
        if (failedStreams.has(kind)) return;
        let offset = 0;
        while (offset < bytes.length) {
          const wrote = await handles[kind].write(
            bytes,
            offset,
            bytes.length - offset,
            position + offset,
          );
          assert.ok(wrote.bytesWritten > 0);
          offset += wrote.bytesWritten;
        }
      })
      .catch((error) => {
        failedStreams.add(kind);
        storageFailed(error);
      });
    if (value.observedBytes > LIMITS.streamBytes) {
      result.truncated = true;
      stop();
    }
  };
  const onAbort = () => {
    result.interrupted = true;
    stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal?.aborted) result.interrupted = true;
    else if (performance.now() >= options.deadline) result.timedOut = true;
    else
      await new Promise((resolve) => {
        child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.once("spawn", () => {
          result.started = true;
          result.pid = child.pid;
          startedReceipt = journal(handles.started, {
            executable,
            args,
            started: true,
            pid: child.pid,
          })
            .then(() => options.onSpawn?.(child.pid))
            .catch(storageFailed);
        });
        child.once("error", (error) => {
          result.spawnError = String(error).slice(0, 1024);
        });
        for (const kind of ["stdout", "stderr"]) {
          child[kind].on("error", storageFailed);
          child[kind].on("data", (chunk) => enqueue(kind, chunk));
        }
        child.once("close", (code, signal) => {
          result.exitCode = code;
          result.signal = signal;
          result.terminalObserved =
            result.started && (code !== null || signal !== null);
          resolve();
        });
        timeout = setTimeout(
          () => {
            result.timedOut = true;
            stop();
          },
          Math.max(1, options.deadline - performance.now()),
        );
      });
  } catch (error) {
    result.spawnError ??= String(error).slice(0, 1024);
    stop();
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    clearTimeout(timeout);
    if (startedReceipt) await startedReceipt;
    await Promise.all(Object.values(queues));
    if (result.storageFailure && child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH")
          result.terminationError ??= String(error).slice(0, 1024);
      }
    }
    clearTimeout(escalation);
    for (const kind of ["stdout", "stderr"]) {
      try {
        await handles[kind].sync();
        const identity = await identify(streams[kind].file, LIMITS.streamBytes);
        const stat = await handles[kind].stat({ bigint: true });
        const linked = await lstat(streams[kind].file, { bigint: true });
        assert.equal(stat.dev, identities[kind].dev);
        assert.equal(stat.ino, identities[kind].ino);
        assert.equal(linked.dev, stat.dev);
        assert.equal(linked.ino, stat.ino);
        result[kind] = {
          file: streams[kind].file,
          observedBytes: streams[kind].observedBytes,
          ...identity,
        };
      } catch (error) {
        result.outputIdentityUnavailable = true;
        storageFailed(error);
      }
    }
    result.durationMs = performance.now() - started;
    try {
      await journal(handles.attempt, result);
    } catch (error) {
      storageFailed(error);
    }
    for (const handle of Object.values(handles)) {
      try {
        await handle.close();
      } catch (error) {
        storageFailed(error);
      }
    }
    if (result.storageFailure && child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH")
          result.terminationError ??= String(error).slice(0, 1024);
      }
    }
    clearTimeout(escalation);
  }
  return result;
}

function requireSuccess(result) {
  assert.equal(completeProcessObservation(result), true);
}
async function main(filename) {
  const config = JSON.parse(await readFile(filename, "utf8")),
    frozen = JSON.parse(
      await readFile(new URL("./web-runtime.v1.json", import.meta.url), "utf8"),
    );
  validateArtifacts(config.artifacts);
  assert.match(config.planSha256, /^[a-f0-9]{64}$/);
  const deadline = performance.now() + LIMITS.wallMs - LIMITS.cleanupReserveMs;
  const result = {
    schemaVersion: 1,
    planSha256: config.planSha256,
    recipe: config.recipe,
    nativeInvoked: false,
    infrastructure: [],
    stages: originalRecipe(config.recipe).map((row) => ({
      ...row,
      started: false,
      terminalObserved: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      truncated: false,
      state: "not-run",
    })),
    sdkProducerBuildClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
  const publish = () =>
    writeFile(
      "/receipts/worker-result.json",
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
  try {
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "x64");
    assert.equal(process.versions.node, config.runtime.nodeVersion);
    result.observedLimits = inspectResourceObservation({
      cpuMax: await readFile("/sys/fs/cgroup/cpu.max", "utf8"),
      memoryMax: await readFile("/sys/fs/cgroup/memory.max", "utf8"),
      pidsMax: await readFile("/sys/fs/cgroup/pids.max", "utf8"),
    });
    await verifyRuntimeTools(config.runtime);
    for (const row of config.artifacts)
      assert.deepEqual(await identify(row.file), {
        bytes: row.bytes,
        sha256: row.sha256,
      });
    await mkdir("/work/home", { mode: 0o700 });
    const sdk = originalSdkDirectory(config.recipe);
    const source = originalSourceDirectory(config.recipe);
    for (const [id, destination] of [
      ["tree-sitter-source", originalSourceDirectory(config.recipe)],
      ["emscripten-sdk", sdk],
      ["node-bootstrap", "/work/sdk-node"],
    ]) {
      if (id === "tree-sitter-source")
        result.observedSourceDirectory =
          await verifyColdSourceDirectory(destination);
      else if (id === "emscripten-sdk")
        result.observedSdkDirectory = await prepareColdSdkDirectory(
          destination,
          source,
        );
      else await mkdir(destination, { mode: 0o700 });
      const artifact = config.artifacts.find((row) => row.id === id);
      const attempt = await boundedProcess(
        "tar",
        ["-xf", artifact.file, "-C", destination, "--strip-components=1"],
        {
          cwd: "/work",
          env: process.env,
          deadline,
          prefix: "/receipts/extract-" + id,
        },
      );
      result.infrastructure.push({ id: "extract-" + id, ...attempt });
      await publish();
      requireSuccess(attempt);
    }
    for (const row of frozen.sdkToolFiles)
      assert.deepEqual(await identify(path.posix.join(sdk, row.path)), {
        bytes: row.bytes,
        sha256: row.sha256,
      });
    assert.deepEqual(await identify("/work/sdk-node/bin/node"), {
      bytes: frozen.sdkNodeTool.bytes,
      sha256: frozen.sdkNodeTool.sha256,
    });
    await cp("/npm-cache", "/work/npm-cache", {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await cp("/cargo-cache", "/work/cargo-cache", {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await verifyCache({
      ...config.offlineInputs.npm,
      directory: "/work/npm-cache",
    });
    await verifyCache({
      ...config.offlineInputs.cargo,
      directory: "/work/cargo-cache",
    });
    // Only relocation values are written. Compiler flags and upstream build defaults remain in original scripts.
    const relocation = sdkRelocation(config.recipe, process.env.PATH);
    await writeFile("/work/emscripten-config.py", relocation.configuration, {
      mode: 0o600,
      flag: "wx",
    });
    const env = {
      PATH: relocation.path,
      HOME: "/work/home",
      TMPDIR: "/tmp",
      EM_CONFIG: "/work/emscripten-config.py",
      EMSDK_NODE: "/work/sdk-node/bin/node",
      CARGO_HOME: "/work/cargo-cache",
      CARGO_NET_OFFLINE: "true",
      npm_config_cache: "/work/npm-cache",
      npm_config_offline: "true",
    };
    if (process.env.RUSTUP_HOME) env.RUSTUP_HOME = process.env.RUSTUP_HOME;
    const probes = runtimeVersionProbes(config.runtime, config.recipe);
    for (const [i, [executable, args, expected]] of probes.entries()) {
      const attempt = await boundedProcess(executable, args, {
        cwd: "/work",
        env,
        deadline,
        prefix: "/receipts/probe-" + i,
      });
      result.infrastructure.push({ id: "probe-" + i, ...attempt });
      await publish();
      requireSuccess(attempt);
      const text = (await readFile(attempt.stdout.file, "utf8")).trim();
      assert.ok(versionProbeMatches(executable, text, expected));
    }
    for (const [index, stage] of originalRecipe(config.recipe).entries()) {
      const environment = { ...env };
      if (stage.cjs !== null) environment.CJS = stage.cjs;
      result.stages[index].state = "admitted";
      await publish();
      // Each reached attempt is journaled before the success assertion; later stages remain explicitly not-run on failure.
      const attempt = await boundedProcess(stage.executable, stage.args, {
        cwd: path.posix.join(originalSourceDirectory(config.recipe), stage.cwd),
        env: environment,
        deadline,
        prefix: "/receipts/stage-" + stage.id,
        onSpawn: async (pid) => {
          result.nativeInvoked = true;
          Object.assign(result.stages[index], {
            state: "running",
            started: true,
            pid,
          });
          await publish();
        },
      });
      result.nativeInvoked ||= attempt.started;
      result.stages[index] = {
        ...stage,
        ...attempt,
        cwd: stage.cwd,
        state: attempt.started ? "reached" : "not-started",
      };
      for (const stream of ["stdout", "stderr"])
        result.stages[index][stream] = {
          ...attempt[stream],
          name: "stage-" + stage.id + "." + stream + ".log",
        };
      await publish();
      requireSuccess(attempt);
    }
    await verifyRuntimeTools(config.runtime);
    result.runtimeToolsRechecked = true;
    for (const row of [
      ...frozen.sdkToolFiles.map((row) => ({
        ...row,
        file: path.posix.join(sdk, row.path),
      })),
      { ...frozen.sdkNodeTool, file: "/work/sdk-node/bin/node" },
    ]) {
      assert.deepEqual(await identify(row.file), {
        bytes: row.bytes,
        sha256: row.sha256,
      });
    }
    result.sdkToolsRechecked = true;
  } catch (error) {
    result.error = String(error).slice(0, 2048);
    process.exitCode = 1;
  } finally {
    await publish();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(process.argv[2], "--operator-trust-execution");
  assert.equal(process.argv.length, 4);
  await main(process.argv[3]);
}
