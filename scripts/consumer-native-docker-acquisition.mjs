import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  requireConsumerPrivateDirectory,
  readConsumerPrivateFile,
} from "./consumer-native-host-storage.mjs";
import { decodeConsumerCaptureRegistry } from "./consumer-native-capture-registry.mjs";
import { validateConsumerCaptureExport } from "./consumer-native-docker-protocol.mjs";
import {
  requireConsumerExportRegistry,
  readConsumerDockerCaptureContext,
} from "./consumer-native-docker-storage.mjs";
const json = (bytes) => JSON.parse(bytes.toString("utf8"));
/** Re-observe every durable private Docker export after the original controller returns. No Docker process is launched. */
export async function acquireConsumerDockerCaptures(
  directory,
  expectedContext,
) {
  await requireConsumerPrivateDirectory(directory);
  assert.deepEqual(
    readConsumerDockerCaptureContext(
      path.join(directory, "docker-context.json"),
    ).registryContext,
    expectedContext,
  );
  const names = await readdir(directory);
  assert.ok(names.length <= 513);
  for (const name of names)
    assert.ok(
      name === "docker-context.json" || /^docker-[a-f0-9-]{36}$/.test(name),
      "Unknown native Docker capture entry",
    );
  const transports = [],
    captures = [];
  for (const name of (await readdir(directory))
    .filter((name) => /^docker-[a-f0-9-]{36}$/.test(name))
    .sort()) {
    const invocation = path.join(directory, name);
    await requireConsumerPrivateDirectory(invocation);
    const capture = json(
      (
        await readConsumerPrivateFile(
          path.join(invocation, "capture.json"),
          1048576,
        )
      ).bytes,
    );
    assert.equal(capture.profile, "owned-native-docker-capture-v1");
    assert.equal(name, "docker-" + capture.invocationId);
    assert.deepEqual(capture.cleanupIssues, []);
    assert.equal(capture.error, null);
    assert.equal(capture.operatorInterrupted, false);
    assert.ok(capture.body);
    assert.equal(capture.body.signal, null);
    assert.equal(capture.body.errorCode, null);
    assert.equal(capture.body.captureError, null);
    assert.equal(capture.body.timedOut, false);
    assert.equal(capture.body.truncated, false);
    captures.push({
      invocationId: capture.invocationId,
      clientStatus: capture.body.status,
      exportVerified: capture.exportVerified,
    });
    if (capture.volume === null) continue; // Preserve actual handled metadata failures as failures; they are not native witness passes.
    assert.equal(capture.body.status, 0, "Native Docker body did not pass");
    assert.equal(capture.exportVerified, true);
    const observe = capture.operations.filter(
      (operation) => operation.kind === "observe-user",
    );
    assert.equal(observe.length, 1);
    assert.equal(observe[0].status, 0);
    const observedPath = observe[0].stdout.path;
    assert.equal(path.dirname(path.dirname(observedPath)), invocation);
    assert.equal(path.basename(observedPath), "stdout");
    assert.match(
      path.basename(path.dirname(observedPath)),
      /^[0-9]{3}-observe-user$/,
    );
    const ownerBytes = await readConsumerPrivateFile(observedPath, 1048576);
    assert.equal(ownerBytes.sha256, observe[0].stdout.sha256);
    assert.equal(ownerBytes.bytes.length, observe[0].stdout.bytes);
    const owner = json(ownerBytes.bytes);
    const manifest = validateConsumerCaptureExport(
        json(
          (
            await readConsumerPrivateFile(
              path.join(invocation, "native-export.json"),
              1048576,
            )
          ).bytes,
        ),
        owner,
      ),
      verified = json(
        (
          await readConsumerPrivateFile(
            path.join(invocation, "verified-export.json"),
            1048576,
          )
        ).bytes,
      ),
      location = path.join(invocation, "export");
    await requireConsumerPrivateDirectory(location);
    assert.equal(verified.manifestSha256, manifest.manifestSha256);
    const registryBytes = await readConsumerPrivateFile(
      path.join(location, "capture-registry.jsonl"),
      1048576,
    );
    assert.equal(verified.registrySha256, registryBytes.sha256);
    const registry = requireConsumerExportRegistry(
        manifest,
        decodeConsumerCaptureRegistry(registryBytes.bytes),
        expectedContext,
      ),
      namespaces = [];
    assert.deepEqual(
      verified.files,
      manifest.files.map(({ path, bytes, sha256 }) => ({
        path,
        bytes,
        sha256,
      })),
    );
    const files = new Map();
    for (const file of manifest.files) {
      const stored = await readConsumerPrivateFile(
        path.join(location, file.path),
        32 * 1048576,
      );
      assert.equal(stored.bytes.length, file.bytes);
      assert.equal(stored.sha256, file.sha256);
      files.set(file.path, stored.bytes);
    }
    for (const registration of registry.registrations) {
      const relative = path.posix.basename(registration.path),
        prefix = relative + "/";
      namespaces.push({
        registrationId: registration.id,
        files: manifest.files
          .filter((file) => file.path.startsWith(prefix))
          .map((file) => ({
            name: file.path.slice(prefix.length),
            bytes: files.get(file.path),
          })),
      });
    }
    transports.push({ registryBytes: registryBytes.bytes, namespaces });
  }
  return { transports, captures };
}
