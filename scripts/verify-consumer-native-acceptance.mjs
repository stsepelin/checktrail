import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  readFile,
  mkdir,
  lstat,
  realpath,
  writeFile,
  access,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, URL } from "node:url";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  selectConsumerNativeAcceptance,
  consumerNativeAcceptanceScopes,
} from "./consumer-native-acceptance-scope.mjs";
import {
  captureConsumerNativeSourceFrame,
  requireConsumerNativeSourceFrame,
  consumerNativeCIRunObservation,
} from "./consumer-native-acceptance-frame.mjs";
import {
  captureConsumerControllerEntry,
  consumerNativeFailureDiagnostic,
} from "./consumer-native-controller-entry.mjs";
import { createConsumerCaptureRegistry } from "./consumer-native-capture-registry.mjs";
import {
  requireConsumerPrivateDirectory,
  readConsumerPrivateFile,
  writeConsumerPrivateFile,
  acquireConsumerHostCapture,
  releaseConsumerHostCapture,
} from "./consumer-native-host-storage.mjs";
import { createConsumerDockerCaptureContext } from "./consumer-native-docker-storage.mjs";
import { acquireConsumerDockerCaptures } from "./consumer-native-docker-acquisition.mjs";
import {
  normalizeConsumerNativeCapsule,
  consumerNativeCapsuleFilename,
  consumerNativeScopeSummary,
} from "./consumer-native-acceptance-capsule.mjs";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url))),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function privateDirectory(parent, name) {
  const target = path.join(parent, name);
  await mkdir(target, { mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(target, "directory", true);
  await requireConsumerPrivateDirectory(target);
  return target;
}
async function outputDirectory(value) {
  assert.ok(path.isAbsolute(value));
  const parent = await realpath(path.dirname(value)),
    target = path.join(parent, path.basename(value));
  const relative = path.relative(root, target);
  assert.ok(
    path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep),
    "Native capsule output must be outside its source tree",
  );
  try {
    await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return privateDirectory(parent, path.basename(target));
  }
  await requireConsumerPrivateDirectory(target);
  return target;
}
async function dockerInvocation() {
  for (const directory of (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((value) => path.isAbsolute(value))) {
    const candidate = path.join(directory, "docker");
    try {
      await access(candidate, constants.X_OK);
      assert.ok((await lstat(await realpath(candidate))).isFile());
      return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  throw Error("Original Docker invocation unavailable");
}
let attemptId = null,
  directory = null,
  scope = null,
  hostAcquisition = null,
  capturedEntry = null,
  diagnosticDirectory = null,
  sourceBeforeSha256 = null,
  failureStage = "admission";
try {
  const [manifest, inventory, profiles] = await Promise.all(
    [
      "docs/gate-a-consumer-witnesses.v1.json",
      "docs/gate-a-profiles.v1.json",
      "scripts/required-native-tests.json",
    ].map(async (file) =>
      JSON.parse(await readFile(path.join(root, file), "utf8")),
    ),
  );
  if (process.argv.length === 3 && process.argv[2] === "--list")
    process.stdout.write(
      JSON.stringify({
        scopes: consumerNativeAcceptanceScopes(
          manifest,
          inventory,
          profiles,
        ).map(consumerNativeScopeSummary),
        executionInvoked: false,
        gateAComplete: false,
      }) + "\n",
    );
  else {
    assert.equal(
      process.argv.length,
      4,
      "Usage: verify-consumer-native-acceptance.mjs PROFILE RUNTIME_SLOT",
    );
    scope = selectConsumerNativeAcceptance(
      manifest,
      inventory,
      profiles,
      process.argv[2],
      process.argv[3],
    );
    for (const key of [
      "CHECKTRAIL_CONSUMER_WITNESS_DIR",
      "CHECKTRAIL_CONSUMER_CAPTURE_ROOT",
      "CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY",
      "CHECKTRAIL_CONSUMER_DOCKER_CONTEXT",
    ])
      assert.equal(
        process.env[key],
        undefined,
        "Independent native acceptance refuses inherited capture context",
      );
    let capsuleDirectory = null;
    if (process.env.CHECKTRAIL_NATIVE_CAPSULE_DIRECTORY) {
      capsuleDirectory = await outputDirectory(
        process.env.CHECKTRAIL_NATIVE_CAPSULE_DIRECTORY,
      );
      await assert.rejects(
        lstat(
          path.join(capsuleDirectory, consumerNativeCapsuleFilename(scope)),
        ),
        { code: "ENOENT" },
      );
    }
    if (process.env.CHECKTRAIL_NATIVE_DIAGNOSTIC_DIRECTORY)
      diagnosticDirectory = await outputDirectory(
        process.env.CHECKTRAIL_NATIVE_DIAGNOSTIC_DIRECTORY,
      );
    failureStage = "source-before";
    const frameBefore = await captureConsumerNativeSourceFrame(root);
    sourceBeforeSha256 = hash(JSON.stringify(frameBefore));
    attemptId = randomUUID();
    directory = await privateDirectory(
      await realpath(os.tmpdir()),
      "checktrail-native-acceptance-" + attemptId,
    );
    failureStage = "registry";
    const context = {
        attemptId,
        scopeId: scope.id,
        captureKind: scope.selectedClang
          ? "selected-clang-producer-consumer"
          : "native-consumer",
        sourceFrameSha256: sourceBeforeSha256,
      },
      hostRegistry = await createConsumerCaptureRegistry(directory, context),
      before = {
        path: process.env.PATH,
        registry: process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY,
        docker: process.env.CHECKTRAIL_CONSUMER_DOCKER_CONTEXT,
        task: process.env.CHECKTRAIL_TEST_TASK,
      };
    await writeConsumerPrivateFile(
      path.join(directory, "source-before.json"),
      Buffer.from(JSON.stringify(frameBefore) + "\n"),
    );
    await writeConsumerPrivateFile(
      path.join(directory, "context.json"),
      Buffer.from(JSON.stringify(context) + "\n"),
    );
    let dockerDirectory = null,
      entry;
    try {
      process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = hostRegistry.path;
      failureStage = scope.docker ? "docker-capture" : "controller-entry";
      if (scope.docker) {
        assert.notEqual(process.platform, "win32");
        const original = await dockerInvocation();
        dockerDirectory = await privateDirectory(directory, "docker");
        const capture = createConsumerDockerCaptureContext(
            dockerDirectory,
            context,
            original,
            before.task ?? "consumer-native-" + attemptId,
          ),
          bin = await privateDirectory(directory, "bin"),
          quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
        await writeFile(
          path.join(bin, "docker"),
          "#!/bin/sh\nexec " +
            quote(process.execPath) +
            " " +
            quote(
              path.join(root, "scripts/consumer-native-docker-wrapper.mjs"),
            ) +
            ' "$@"\n',
          { flag: "wx", mode: 0o700 },
        );
        process.env.PATH = bin + path.delimiter + (before.path ?? "");
        process.env.CHECKTRAIL_CONSUMER_DOCKER_CONTEXT = capture.path;
        if (before.task === undefined)
          process.env.CHECKTRAIL_TEST_TASK = capture.context.task;
      }
      failureStage = "controller-entry";
      entry = capturedEntry = await captureConsumerControllerEntry(
        root,
        scope.command,
        directory,
      );
    } finally {
      for (const [key, value] of [
        ["PATH", before.path],
        ["CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY", before.registry],
        ["CHECKTRAIL_CONSUMER_DOCKER_CONTEXT", before.docker],
        ["CHECKTRAIL_TEST_TASK", before.task],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    failureStage = "host-capture";
    hostAcquisition = await acquireConsumerHostCapture(
      hostRegistry.path,
      directory,
      context,
    );
    failureStage = "controller-result";
    assert.equal(
      entry.complete,
      true,
      "Original controller failed; raw attempts remain retained",
    );
    failureStage = dockerDirectory ? "docker-capture" : "controller-result";
    const docker = dockerDirectory
        ? await acquireConsumerDockerCaptures(dockerDirectory, context)
        : { transports: [], captures: [] },
      stdout = await readConsumerPrivateFile(entry.stdout.path, 32 * 1048576),
      stderr = await readConsumerPrivateFile(entry.stderr.path, 32 * 1048576);
    let selectedClangPacket = null,
      retainedParent = null;
    if (scope.selectedClang) {
      const outer = JSON.parse(stdout.bytes.toString("utf8")),
        receipt = outer.acceptance.consumerWitnesses.retainedReceipt;
      assert.equal(
        receipt.profile,
        "private-selected-clang-consumer-packet-v1",
      );
      retainedParent = path.dirname(receipt.path);
      assert.equal(path.basename(receipt.path), "packet.json");
      assert.match(
        path.basename(retainedParent),
        /^checktrail-clang-receipt-[A-Za-z0-9]{6}$/,
      );
      assert.equal(path.dirname(retainedParent), await realpath(os.tmpdir()));
      await requireConsumerPrivateDirectory(retainedParent);
      assert.deepEqual(await readdir(retainedParent), ["packet.json"]);
      const raw = await readConsumerPrivateFile(receipt.path, 288 * 1048576);
      assert.equal(raw.bytes.length, receipt.bytes);
      assert.equal(raw.sha256, receipt.sha256);
      await writeConsumerPrivateFile(
        path.join(directory, "selected-clang-packet.json"),
        raw.bytes,
      );
      selectedClangPacket = JSON.parse(raw.bytes.toString("utf8"));
    }
    failureStage = "source-after";
    const frameAfter = await captureConsumerNativeSourceFrame(root);
    requireConsumerNativeSourceFrame(frameAfter, frameBefore);
    failureStage = "normalize-capsule";
    const capsule = await normalizeConsumerNativeCapsule({
      repository: root,
      scope,
      frameBefore,
      frameAfter,
      entry,
      stdout: stdout.bytes,
      stderr: stderr.bytes,
      transports: [hostAcquisition.transport, ...docker.transports],
      context,
      ci: consumerNativeCIRunObservation(),
      selectedClangPacket,
    });
    failureStage = "persist-capsule";
    await writeConsumerPrivateFile(
      path.join(directory, "scope-capsule.json"),
      Buffer.from(JSON.stringify(capsule) + "\n"),
    );
    failureStage = "release-captures";
    await releaseConsumerHostCapture(hostAcquisition);
    if (retainedParent) {
      await requireConsumerPrivateDirectory(retainedParent);
      const current = await readConsumerPrivateFile(
          path.join(retainedParent, "packet.json"),
          288 * 1048576,
        ),
        retained = await readConsumerPrivateFile(
          path.join(directory, "selected-clang-packet.json"),
          288 * 1048576,
        );
      assert.equal(current.sha256, retained.sha256);
      await rm(retainedParent, { recursive: true, force: false });
    }
    failureStage = "publish-capsule";
    if (capsuleDirectory)
      await writeConsumerPrivateFile(
        path.join(capsuleDirectory, consumerNativeCapsuleFilename(scope)),
        Buffer.from(JSON.stringify(capsule) + "\n"),
      );
    process.stdout.write(
      JSON.stringify({
        scope: scope.id,
        attemptId,
        capsuleSha256: capsule.capsuleSha256,
        moduleCompleted: true,
        requiresSuccessfulOuterJob: true,
        gateAComplete: false,
      }) + "\n",
    );
  }
} catch (error) {
  let diagnostic = null,
    diagnosticRetained = false;
  if (scope)
    try {
      diagnostic = consumerNativeFailureDiagnostic({
        stage: failureStage,
        scopeId: scope.id,
        attemptId,
        error,
        entry: capturedEntry,
        repository: root,
        sourceBeforeSha256,
      });
    } catch {
      /* Diagnostics never replace the original refusal. */
    }
  if (directory)
    try {
      await writeConsumerPrivateFile(
        path.join(directory, "failure.json"),
        Buffer.from(
          JSON.stringify({
            scope: scope?.id ?? null,
            attemptId,
            error: String(error?.stack ?? error),
            hostCopy: hostAcquisition?.directory ?? null,
            gateAComplete: false,
          }) + "\n",
        ),
      );
    } catch {
      /* Preserve the original failure if diagnostic storage also refuses. */
    }
  if (diagnosticDirectory && attemptId && diagnostic)
    try {
      await writeConsumerPrivateFile(
        path.join(diagnosticDirectory, attemptId + ".json"),
        Buffer.from(JSON.stringify(diagnostic) + "\n"),
      );
      diagnosticRetained = true;
    } catch {
      /* The private original failure remains authoritative. */
    }
  process.stderr.write(
    "Native consumer acceptance refused" +
      (scope ? " for " + scope.id : "") +
      (attemptId ? "; private attempt " + attemptId : "") +
      "\n",
  );
  if (diagnostic)
    process.stderr.write(
      JSON.stringify({ ...diagnostic, diagnosticRetained }) + "\n",
    );
  process.exitCode = 1;
}
