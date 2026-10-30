import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import {
  constants,
  lstatSync,
  fstatSync,
  realpathSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import {
  consumerCaptureRegistryBootstrapProgram,
  decodeConsumerCaptureRegistry,
} from "./consumer-native-capture-registry.mjs";
import {
  consumerCaptureLabels,
  requireOwnedConsumerCaptureResource,
  consumerDockerRunDescription,
  capturedConsumerDockerArguments,
  validateConsumerCaptureExport,
  consumerCaptureUIDProgram,
  consumerCaptureExportProgram,
} from "./consumer-native-docker-protocol.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function ownedDirectory(filename) {
  assert.notEqual(
    process.platform,
    "win32",
    "Native Docker storage requires its POSIX operator host",
  );
  assert.ok(path.isAbsolute(filename));
  assert.equal(realpathSync(filename), filename);
  const stat = lstatSync(filename);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o700,
  );
  return stat;
}
function privateBytes(filename, maximum = 1048576) {
  assert.equal(realpathSync(filename), filename);
  const before = lstatSync(filename, { bigint: true });
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.uid === BigInt(process.getuid()) &&
      (before.mode & 0o777n) === 0o600n &&
      before.size <= BigInt(maximum),
  );
  const fd = openSync(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ),
    parts = [];
  let total = 0;
  try {
    const initial = fstatSync(fd, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(before[field], initial[field]);
    for (;;) {
      const b = Buffer.alloc(65536),
        n = readSync(fd, b, 0, b.length, null);
      if (!n) break;
      total += n;
      assert.ok(total <= maximum);
      parts.push(b.subarray(0, n));
    }
    const after = fstatSync(fd, { bigint: true }),
      linked = lstatSync(filename, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(before[field], after[field]);
      assert.equal(after[field], linked[field]);
    }
    assert.equal(BigInt(total), before.size);
    assert.equal(realpathSync(filename), filename);
    return Buffer.concat(parts, total);
  } finally {
    closeSync(fd);
  }
}
function writePrivate(filename, bytes) {
  ownedDirectory(path.dirname(filename));
  const fd = openSync(filename, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { path: filename, bytes: bytes.length, sha256: hash(bytes) };
}
export function createConsumerDockerCaptureContext(
  directory,
  registryContext,
  realDocker,
  task,
) {
  ownedDirectory(directory);
  const executable = realpathSync(realDocker);
  assert.ok(lstatSync(executable).isFile());
  const context = {
    schemaVersion: 1,
    profile: "owned-native-docker-capture-context-v1",
    attemptId: registryContext.attemptId,
    task,
    directory,
    realDocker: executable,
    registryContext,
  };
  consumerCaptureLabels(context);
  const filename = path.join(directory, "docker-context.json");
  writePrivate(filename, Buffer.from(JSON.stringify(context) + "\n"));
  readConsumerDockerCaptureContext(filename);
  return { path: filename, context };
}
export function readConsumerDockerCaptureContext(filename) {
  ownedDirectory(path.dirname(filename));
  const value = JSON.parse(privateBytes(filename).toString("utf8"));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profile, "owned-native-docker-capture-context-v1");
  consumerCaptureLabels(value);
  assert.equal(value.directory, path.dirname(filename));
  ownedDirectory(value.directory);
  assert.equal(typeof value.realDocker, "string");
  assert.ok(path.isAbsolute(value.realDocker));
  assert.equal(realpathSync(value.realDocker), value.realDocker);
  assert.ok(lstatSync(value.realDocker).isFile());
  assert.deepEqual(
    Object.keys(value.registryContext).sort(),
    ["attemptId", "captureKind", "scopeId", "sourceFrameSha256"].sort(),
  );
  assert.equal(value.registryContext.attemptId, value.attemptId);
  assert.equal(typeof value.registryContext.scopeId, "string");
  assert.ok(
    value.registryContext.scopeId.length > 0 &&
      Buffer.byteLength(value.registryContext.scopeId) <= 512 &&
      value.registryContext.scopeId.trim() === value.registryContext.scopeId &&
      [...value.registryContext.scopeId].every(
        (character) =>
          character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
      ),
  );
  assert.ok(
    ["native-consumer", "selected-clang-producer-consumer"].includes(
      value.registryContext.captureKind,
    ),
  );
  assert.match(value.registryContext.sourceFrameSha256, /^[a-f0-9]{64}$/);
  return value;
}
/** Foreground CLI supervision only; no native PID/start acknowledgement is inferred from this client. */
export async function runCapturedConsumerDocker(args, context) {
  ownedDirectory(context.directory);
  const invocationId = randomUUID(),
    directory = path.join(context.directory, "docker-" + invocationId);
  mkdirSync(directory, { mode: 0o700 });
  ownedDirectory(directory);
  const description = consumerDockerRunDescription(args),
    volume = "checktrail-consumer-capture-" + invocationId,
    body = description?.name ?? volume + "-body",
    labels = consumerCaptureLabels(context),
    helpers = new Set(),
    operations = [];
  let operationIndex = 0,
    active = null,
    aborted = false,
    volumeCreated = false,
    exported = false,
    bodyResult = null,
    resultError = null,
    resultException = null,
    observedImage = null,
    observedOwner = null;
  const failures = [];
  function terminate() {
    aborted = true;
    if (active) {
      active.stop();
      active.child.stdout.resume();
      active.child.stderr.resume();
    }
  }
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
  const outputError = () => terminate();
  process.stdout.on("error", outputError);
  process.stderr.on("error", outputError);
  async function command(
    kind,
    commandArgs,
    {
      timeoutMs = 30000,
      maximum = 1048576,
      passthrough = false,
      allowAfterAbort = false,
    } = {},
  ) {
    if (aborted && !allowAfterAbort)
      throw Error("Native Docker capture operator interrupted");
    const opDirectory = path.join(
      directory,
      String(operationIndex++).padStart(3, "0") + "-" + kind,
    );
    mkdirSync(opDirectory, { mode: 0o700 });
    const stdoutPath = path.join(opDirectory, "stdout"),
      stderrPath = path.join(opDirectory, "stderr"),
      out = openSync(stdoutPath, "wx", 0o600),
      err = openSync(stderrPath, "wx", 0o600),
      stdoutHash = createHash("sha256"),
      stderrHash = createHash("sha256"),
      chunks = [];
    let stdoutBytes = 0,
      stderrBytes = 0,
      observedStdoutBytes = 0,
      observedStderrBytes = 0,
      truncated = false,
      timedOut = false,
      errorCode = null,
      captureError = null,
      signal,
      status,
      spawned = false;
    try {
      const child = spawn(context.realDocker, commandArgs, {
        stdio: ["inherit", "pipe", "pipe"],
        detached: true,
      });
      let killTimer;
      const stop = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* The client may already have exited. */
          }
        }
        if (!killTimer) {
          killTimer = setTimeout(() => {
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                /* The client may already have exited. */
              }
            }
          }, 5000);
          killTimer.unref();
        }
      };
      active = { child, stop };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      timer.unref();
      child.on("spawn", () => {
        spawned = true;
      });
      child.on("error", (error) => {
        errorCode = error.code ?? "SPAWN_ERROR";
      });
      const retain = (chunk, stream) => {
        if (stream === "stdout") observedStdoutBytes += chunk.length;
        else observedStderrBytes += chunk.length;
        if (captureError) return;
        const selected = chunk.subarray(
            0,
            Math.max(0, maximum - stdoutBytes - stderrBytes),
          ),
          fd = stream === "stdout" ? out : err,
          digest = stream === "stdout" ? stdoutHash : stderrHash;
        try {
          let offset = 0;
          while (offset < selected.length) {
            const count = writeSync(
              fd,
              selected,
              offset,
              selected.length - offset,
            );
            assert.ok(count > 0);
            const part = selected.subarray(offset, offset + count);
            digest.update(part);
            if (stream === "stdout") {
              stdoutBytes += count;
              if (!passthrough) chunks.push(Buffer.from(part));
            } else stderrBytes += count;
            offset += count;
          }
          if (passthrough && selected.length && !aborted) {
            const sink = stream === "stdout" ? process.stdout : process.stderr;
            if (!sink.write(selected)) {
              child[stream].pause();
              sink.once("drain", () => child[stream].resume());
            }
          }
        } catch (error) {
          captureError = String(error);
          stop();
        }
        if (selected.length < chunk.length) {
          truncated = true;
          stop();
        }
      };
      child.stdout.on("data", (chunk) => retain(chunk, "stdout"));
      child.stderr.on("data", (chunk) => retain(chunk, "stderr"));
      const result = await new Promise((resolve) =>
        child.once("close", (code, childSignal) =>
          resolve({ code, signal: childSignal }),
        ),
      );
      status = result.code;
      signal = result.signal;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (active?.child === child) active = null;
    } finally {
      try {
        fsyncSync(out);
        fsyncSync(err);
      } catch (error) {
        captureError ??= String(error);
      } finally {
        closeSync(out);
        closeSync(err);
      }
    }
    const receipt = {
      kind,
      arguments: commandArgs,
      status,
      signal,
      errorCode,
      captureError,
      clientSpawnObserved: spawned,
      timedOut,
      truncated,
      stdout: {
        path: stdoutPath,
        bytes: stdoutBytes,
        observedBytes: observedStdoutBytes,
        sha256: stdoutHash.digest("hex"),
      },
      stderr: {
        path: stderrPath,
        bytes: stderrBytes,
        observedBytes: observedStderrBytes,
        sha256: stderrHash.digest("hex"),
      },
      nativeProcessStartAcknowledgementRetained: false,
      hostAttestationPerformed: false,
      gateAComplete: false,
    };
    operations.push(receipt);
    writePrivate(
      path.join(opDirectory, "result.json"),
      Buffer.from(JSON.stringify(receipt) + "\n"),
    );
    return {
      ...receipt,
      stdoutBuffer: Buffer.concat(chunks),
      complete:
        spawned &&
        !errorCode &&
        !captureError &&
        !timedOut &&
        !truncated &&
        !signal,
    };
  }
  async function checked(kind, commandArgs, options) {
    const result = await command(kind, commandArgs, options);
    assert.equal(
      result.complete,
      true,
      "Native capture helper incomplete: " + kind,
    );
    assert.equal(result.status, 0, "Native capture helper failed: " + kind);
    return result;
  }
  async function inspect(kind, name, allowAfterAbort = false) {
    const value = await checked("inspect-" + kind, [kind, "inspect", name], {
      allowAfterAbort,
    });
    const rows = JSON.parse(value.stdoutBuffer.toString("utf8"));
    assert.equal(rows.length, 1);
    return rows[0];
  }
  function helperArgs(
    name,
    image,
    user,
    program,
    request,
    { mount = false, readonly = false } = {},
  ) {
    helpers.add(name);
    const result = [
      "run",
      "--name",
      name,
      "--init",
      "--network",
      "none",
      "--read-only",
      "--cpus",
      "1",
      "--memory",
      program === consumerCaptureExportProgram ? "512m" : "128m",
      "--pids-limit",
      "32",
    ];
    if (user !== null && user !== "") result.push("--user", user);
    for (const [key, value] of Object.entries({
      ...labels,
      "checktrail.task": context.task,
    }))
      result.push("--label", key + "=" + value);
    if (mount)
      result.push(
        "--mount",
        "type=volume,source=" +
          volume +
          ",target=/operator-consumer-captures,volume-nocopy" +
          (readonly ? ",readonly" : ""),
      );
    result.push(
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      program,
    );
    if (request !== undefined) result.push(JSON.stringify(request));
    return result;
  }
  async function removeContainer(name) {
    const observed = await command(
      "cleanup-inspect-container",
      ["container", "inspect", name],
      { allowAfterAbort: true },
    );
    if (observed.status !== 0) {
      assert.equal(
        observed.status,
        1,
        "Native capture container observation failed",
      );
      const absent = await checked(
        "cleanup-confirm-container-absent",
        ["ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"],
        { allowAfterAbort: true },
      );
      assert.equal(
        absent.stdoutBuffer.toString("utf8").trim(),
        "",
        "Native capture container remains after failed inspection",
      );
      return;
    }
    const rows = JSON.parse(observed.stdoutBuffer.toString("utf8"));
    assert.equal(rows.length, 1);
    requireOwnedConsumerCaptureResource(rows[0], context, name);
    await checked("cleanup-remove-container", ["rm", "-f", name], {
      allowAfterAbort: true,
    });
  }
  async function exportVolume(image, owner) {
    const manifestResult = await checked(
      "export-inventory",
      helperArgs(
        volume + "-inventory",
        image.Id,
        "0:0",
        consumerCaptureExportProgram,
        { action: "inventory", ...owner },
        { mount: true, readonly: true },
      ),
      { maximum: 1048576, allowAfterAbort: true },
    );
    const manifest = validateConsumerCaptureExport(
      JSON.parse(manifestResult.stdoutBuffer.toString("utf8")),
      owner,
    );
    writePrivate(
      path.join(directory, "native-export.json"),
      manifestResult.stdoutBuffer,
    );
    const destination = path.join(directory, "export");
    mkdirSync(destination, { mode: 0o700 });
    for (const entry of manifest.directories)
      mkdirSync(path.join(destination, entry.path), { mode: 0o700 });
    const batches = [];
    let batch = [];
    for (const file of manifest.files) {
      const next = [...batch, file];
      if (
        batch.length &&
        (next.length > 64 ||
          Buffer.byteLength(
            JSON.stringify({ action: "read-batch", ...owner, files: next }),
          ) > 65536)
      ) {
        batches.push(batch);
        batch = [];
      }
      batch.push(file);
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ action: "read-batch", ...owner, files: batch }),
        ) <= 65536,
        "Native export metadata argument exceeds bound",
      );
    }
    if (batch.length) batches.push(batch);
    for (const [index, files] of batches.entries()) {
      const contentResult = await checked(
        "export-batch",
        helperArgs(
          volume + "-files-" + index,
          image.Id,
          "0:0",
          consumerCaptureExportProgram,
          { action: "read-batch", ...owner, files },
          { mount: true, readonly: true },
        ),
        { maximum: 384 * 1048576, allowAfterAbort: true },
      );
      const lines = contentResult.stdoutBuffer
        .toString("utf8")
        .trimEnd()
        .split("\n");
      assert.equal(lines.length, files.length);
      for (const [position, line] of lines.entries()) {
        const content = JSON.parse(line),
          { base64, ...identity } = content,
          file = files[position];
        assert.deepEqual(identity, file);
        const bytes = Buffer.from(base64, "base64");
        assert.equal(bytes.toString("base64"), base64);
        assert.equal(bytes.length, file.bytes);
        assert.equal(hash(bytes), file.sha256);
        const stored = writePrivate(path.join(destination, file.path), bytes);
        assert.equal(stored.bytes, file.bytes);
        assert.equal(stored.sha256, file.sha256);
        const physical = privateBytes(stored.path, 32 * 1048576);
        assert.equal(hash(physical), file.sha256);
      }
    }
    const registryPath = path.join(destination, "capture-registry.jsonl"),
      registry = decodeConsumerCaptureRegistry(privateBytes(registryPath));
    assert.deepEqual(registry.context, context.registryContext);
    assert.equal(
      registry.header.registryPath,
      "/operator-consumer-captures/capture-registry.jsonl",
    );
    assert.equal(registry.header.parentPath, "/operator-consumer-captures");
    const registryFile = manifest.files.find(
      (file) => file.path === "capture-registry.jsonl",
    );
    assert.ok(registryFile);
    for (const field of ["dev", "ino", "birthtimeNs", "uid"]) {
      assert.equal(
        String(registryFile[field]),
        registry.header.registryIdentity[field],
      );
      assert.equal(
        manifest.rootIdentity[field],
        registry.header.parentIdentity[field],
      );
    }
    const retainedNamespaces = [];
    for (const registration of registry.registrations) {
      assert.equal(
        path.posix.dirname(registration.path),
        "/operator-consumer-captures",
      );
      assert.equal(registration.parent.path, "/operator-consumer-captures");
      for (const field of ["dev", "ino", "birthtimeNs", "uid"])
        assert.equal(
          manifest.rootIdentity[field],
          registration.parent.identity[field],
        );
      const relative = path.posix.basename(registration.path),
        native = manifest.directories.find((entry) => entry.path === relative);
      if (registration.state === "collected-removed") {
        assert.equal(native, undefined);
        continue;
      }
      assert.ok(native, "Registered native namespace is missing before export");
      retainedNamespaces.push(relative);
      for (const field of ["dev", "ino", "birthtimeNs"])
        assert.equal(native[field], registration.identity[field]);
      assert.equal(String(native.uid), registration.identity.uid);
    }
    assert.deepEqual(
      retainedNamespaces.sort(),
      manifest.directories.map((value) => value.path).sort(),
      "Unregistered native capture namespace exported",
    );
    writePrivate(
      path.join(directory, "verified-export.json"),
      Buffer.from(
        JSON.stringify({
          manifestSha256: manifest.manifestSha256,
          registrySha256: hash(privateBytes(registryPath)),
          files: manifest.files.map((file) => ({
            path: file.path,
            bytes: file.bytes,
            sha256: file.sha256,
          })),
          nativeNamespacesRetainedUntilExport: true,
          hostAttestationPerformed: false,
          gateAComplete: false,
        }) + "\n",
      ),
    );
    exported = true;
  }
  try {
    if (!description) {
      bodyResult = await command("passthrough", args, {
        timeoutMs: 1200000,
        maximum: 320 * 1048576,
        passthrough: true,
      });
    } else {
      const image = await inspect("image", description.image);
      observedImage = image;
      assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
      const uidResult = await checked(
        "observe-user",
        helperArgs(
          volume + "-user",
          image.Id,
          description.user ?? image.Config.User ?? "",
          consumerCaptureUIDProgram,
          undefined,
        ),
        { maximum: 1048576 },
      );
      const owner = JSON.parse(uidResult.stdoutBuffer.toString("utf8"));
      observedOwner = owner;
      assert.ok(
        Number.isSafeInteger(owner.uid) &&
          owner.uid >= 0 &&
          Number.isSafeInteger(owner.gid) &&
          owner.gid >= 0,
      );
      const absent = await checked("volume-must-be-new", [
        "volume",
        "ls",
        "--filter",
        "name=" + volume,
        "--format",
        "{{.Name}}",
      ]);
      assert.equal(
        absent.stdoutBuffer.toString("utf8").trim(),
        "",
        "Native capture volume already exists",
      );
      const create = ["volume", "create", "--driver", "local"];
      for (const [key, value] of Object.entries({
        ...labels,
        "checktrail.task": context.task,
      }))
        create.push("--label", key + "=" + value);
      create.push(volume);
      await checked("create-volume", create);
      volumeCreated = true;
      const created = await inspect("volume", volume);
      requireOwnedConsumerCaptureResource(created, context, volume);
      assert.equal(created.Driver, "local");
      const bootstrap = await checked(
        "initialize-volume",
        helperArgs(
          volume + "-initialize",
          image.Id,
          "0:0",
          consumerCaptureRegistryBootstrapProgram,
          { context: context.registryContext, uid: owner.uid, gid: owner.gid },
          { mount: true },
        ),
      );
      const initialized = JSON.parse(bootstrap.stdoutBuffer.toString("utf8"));
      assert.ok(initialized && typeof initialized === "object");
      writePrivate(
        path.join(directory, "bootstrap.json"),
        bootstrap.stdoutBuffer,
      );
      bodyResult = await command(
        "body",
        capturedConsumerDockerArguments(
          args,
          description,
          volume,
          body,
          context,
        ),
        { timeoutMs: 1200000, maximum: 320 * 1048576, passthrough: true },
      );
      const bodyImage = await inspect("image", description.image);
      assert.equal(
        bodyImage.Id,
        image.Id,
        "Native capture image changed during execution",
      );
    }
  } catch (error) {
    resultError = String(error);
    resultException = error;
  } finally {
    if (description) {
      try {
        await removeContainer(body);
      } catch (error) {
        failures.push(String(error));
      }
      if (volumeCreated && observedImage && observedOwner)
        try {
          await exportVolume(observedImage, observedOwner);
        } catch (error) {
          failures.push("Native capture export failed: " + String(error));
        }
      for (const name of helpers)
        try {
          await removeContainer(name);
        } catch (error) {
          failures.push(String(error));
        }
      if (volumeCreated) {
        try {
          const value = await inspect("volume", volume, true);
          requireOwnedConsumerCaptureResource(value, context, volume);
          if (exported)
            await checked("cleanup-remove-volume", ["volume", "rm", volume], {
              allowAfterAbort: true,
            });
          else
            failures.push(
              "Owned volume retained because a complete verified export is unavailable: " +
                volume,
            );
        } catch (error) {
          failures.push(String(error));
        }
      }
    }
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
    process.stdout.off("error", outputError);
    process.stderr.off("error", outputError);
    writePrivate(
      path.join(directory, "capture.json"),
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          profile: "owned-native-docker-capture-v1",
          invocationId,
          originalArguments: args,
          volume: volumeCreated ? volume : null,
          container: description ? body : null,
          exportVerified: exported,
          operatorInterrupted: aborted,
          body: bodyResult
            ? {
                status: bodyResult.status,
                signal: bodyResult.signal,
                errorCode: bodyResult.errorCode,
                captureError: bodyResult.captureError,
                timedOut: bodyResult.timedOut,
                truncated: bodyResult.truncated,
              }
            : null,
          error: resultError,
          cleanupIssues: failures,
          operations: operations.map((operation) => ({
            kind: operation.kind,
            status: operation.status,
            signal: operation.signal,
            errorCode: operation.errorCode,
            captureError: operation.captureError,
            timedOut: operation.timedOut,
            truncated: operation.truncated,
            stdout: operation.stdout,
            stderr: operation.stderr,
          })),
          nativeProcessStartAcknowledgementRetained: false,
          hostAttestationPerformed: false,
          gateAComplete: false,
        }) + "\n",
      ),
    );
  }
  if (resultError !== null) throw resultException;
  assert.equal(
    failures.length,
    0,
    "Native Docker capture cleanup/export incomplete: " + failures.join("; "),
  );
  return bodyResult;
}
