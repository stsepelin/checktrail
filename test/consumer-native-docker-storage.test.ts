import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  chmod,
  lstat,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const { createConsumerDockerCaptureContext, readConsumerDockerCaptureContext } =
  await import(
    new URL("../../scripts/consumer-native-docker-storage.mjs", import.meta.url)
      .href
  );
const wrapper = fileURLToPath(
  new URL("../../scripts/consumer-native-docker-wrapper.mjs", import.meta.url),
);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function context() {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "checktrail-docker-storage-control-")),
  );
  const created = createConsumerDockerCaptureContext(
    directory,
    {
      attemptId: randomUUID(),
      scopeId: "synthetic:cli-storage-only",
      captureKind: "native-consumer",
      sourceFrameSha256: "a".repeat(64),
    },
    process.execPath,
    "synthetic-storage-control",
  );
  return { directory, ...created };
}
async function capture(directory: string) {
  const names = (await readdir(directory)).filter((name) =>
    /^docker-[a-f0-9-]{36}$/.test(name),
  );
  assert.equal(names.length, 1);
  const invocation = path.join(directory, names[0]!);
  return {
    invocation,
    receipt: JSON.parse(
      await readFile(path.join(invocation, "capture.json"), "utf8"),
    ),
  };
}
test(
  "operator CLI storage retains exact failed actual Node stdout/stderr and exit status without claiming Docker/native execution",
  { skip: process.platform === "win32" },
  async () => {
    const created = await context();
    try {
      const result = spawnSync(
        process.execPath,
        [
          wrapper,
          "--input-type=module",
          "-e",
          "process.stdout.write('actual synthetic stdout\\n'); process.stderr.write('actual synthetic stderr\\n'); process.exitCode=7;",
        ],
        {
          env: {
            ...process.env,
            CHECKTRAIL_CONSUMER_DOCKER_CONTEXT: created.path,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 7);
      assert.equal(result.stdout, "actual synthetic stdout\n");
      assert.equal(result.stderr, "actual synthetic stderr\n");
      const { receipt } = await capture(created.directory);
      assert.equal(receipt.body.status, 7);
      assert.equal(receipt.body.captureError, null);
      assert.equal(receipt.volume, null);
      assert.equal(receipt.exportVerified, false);
      assert.equal(receipt.nativeProcessStartAcknowledgementRetained, false);
      assert.equal(receipt.hostAttestationPerformed, false);
      assert.equal(receipt.gateAComplete, false);
      assert.deepEqual(receipt.cleanupIssues, []);
      assert.equal(receipt.operations.length, 1);
      const operation = receipt.operations[0];
      assert.equal(operation.kind, "passthrough");
      for (const [stream, expected] of [
        ["stdout", result.stdout],
        ["stderr", result.stderr],
      ] as const) {
        const stored = await readFile(operation[stream].path);
        assert.equal(stored.toString("utf8"), expected);
        assert.equal(operation[stream].bytes, stored.length);
        assert.equal(operation[stream].observedBytes, stored.length);
        assert.equal(operation[stream].sha256, digest(stored));
        const metadata = await lstat(operation[stream].path);
        assert.equal(metadata.mode & 0o777, 0o600);
        assert.equal(metadata.nlink, 1);
      }
    } finally {
      await rm(created.directory, { recursive: true, force: true });
    }
  },
);
test(
  "operator CLI storage interruption preserves a real child prefix and explicit signal rather than fabricating completion",
  { skip: process.platform === "win32" },
  async () => {
    const created = await context();
    const child = spawn(
      process.execPath,
      [
        wrapper,
        "--input-type=module",
        "-e",
        "process.stdout.write('synthetic stop-ready\\n'); setInterval(()=>{},1000);",
      ],
      {
        env: {
          ...process.env,
          CHECKTRAIL_CONSUMER_DOCKER_CONTEXT: created.path,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      const terminal = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      await new Promise<void>((resolve, reject) => {
        let seen = "";
        timer = setTimeout(
          () =>
            reject(
              Error("Synthetic child did not reach actual stdout boundary"),
            ),
          10000,
        );
        child.stdout.on("data", (bytes) => {
          seen += bytes.toString("utf8");
          if (seen.includes("synthetic stop-ready\n")) resolve();
        });
        child.once("error", reject);
      });
      if (timer) clearTimeout(timer);
      assert.equal(child.kill("SIGTERM"), true);
      const result = await terminal;
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      const { receipt } = await capture(created.directory);
      assert.equal(receipt.operatorInterrupted, true);
      assert.equal(receipt.body.status, null);
      assert.equal(receipt.body.signal, "SIGTERM");
      assert.equal(receipt.body.timedOut, false);
      assert.equal(receipt.body.truncated, false);
      assert.equal(
        (await readFile(receipt.operations[0].stdout.path)).toString("utf8"),
        "synthetic stop-ready\n",
      );
      assert.equal(receipt.gateAComplete, false);
    } finally {
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      await rm(created.directory, { recursive: true, force: true });
    }
  },
);
test(
  "operator CLI storage refuses permissive moved and foreign private context before invoking any command",
  { skip: process.platform === "win32" },
  async () => {
    const created = await context();
    try {
      assert.equal(
        readConsumerDockerCaptureContext(created.path).attemptId,
        created.context.attemptId,
      );
      await chmod(created.path, 0o644);
      assert.throws(() => readConsumerDockerCaptureContext(created.path));
      const result = spawnSync(
        process.execPath,
        [wrapper, "--eval", "process.stdout.write('BODY-MUST-NOT-RUN')"],
        {
          env: {
            ...process.env,
            CHECKTRAIL_CONSUMER_DOCKER_CONTEXT: created.path,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Native Docker capture failed/);
      assert.deepEqual(
        (await readdir(created.directory)).filter((name) =>
          /^docker-[a-f0-9-]{36}$/.test(name),
        ),
        [],
      );
      await chmod(created.path, 0o600);
      const other = path.join(created.directory, "other");
      await mkdir(other, { mode: 0o700 });
      const copy = path.join(other, "docker-context.json");
      await writeFile(copy, await readFile(created.path), { mode: 0o600 });
      assert.throws(() => readConsumerDockerCaptureContext(copy));
      const value = JSON.parse(await readFile(created.path, "utf8"));
      value.registryContext.captureKind = "foreign";
      await writeFile(created.path, JSON.stringify(value), { mode: 0o600 });
      assert.throws(() => readConsumerDockerCaptureContext(created.path));
    } finally {
      await rm(created.directory, { recursive: true, force: true });
    }
  },
);

test(
  "operator CLI storage binds the canonical binary while preserving a real symlink invocation argv0 for multicall clients",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await realpath(
      await mkdtemp(
        path.join(os.tmpdir(), "checktrail-multicall-storage-control-"),
      ),
    );
    try {
      const invocation = path.join(directory, "original-synthetic-cli-name");
      await symlink(process.execPath, invocation);
      const created = createConsumerDockerCaptureContext(
        directory,
        {
          attemptId: randomUUID(),
          scopeId: "synthetic:multicall-storage",
          captureKind: "native-consumer",
          sourceFrameSha256: "d".repeat(64),
        },
        invocation,
        "synthetic-multicall-control",
      );
      assert.equal(
        created.context.realDocker,
        await realpath(process.execPath),
      );
      assert.equal(created.context.dockerInvocation, invocation);
      const result = spawnSync(
        process.execPath,
        [
          wrapper,
          "--input-type=module",
          "-e",
          "process.stdout.write(process.argv0+'\\n');",
        ],
        {
          env: {
            ...process.env,
            CHECKTRAIL_CONSUMER_DOCKER_CONTEXT: created.path,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, invocation + "\n");
      const { receipt } = await capture(directory);
      assert.equal(receipt.body.status, 0);
      assert.equal(
        (await readFile(receipt.operations[0].stdout.path)).toString("utf8"),
        result.stdout,
      );
      await rm(invocation);
      await symlink(wrapper, invocation);
      assert.throws(
        () => readConsumerDockerCaptureContext(created.path),
        /Native Docker invocation target changed/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("transported native registry matches all original root file parent and retained namespace identities without accepting copied-inode claims", async () => {
  const { requireConsumerExportRegistry } = await import(
      new URL(
        "../../scripts/consumer-native-docker-storage.mjs",
        import.meta.url,
      ).href
    ),
    identity = { dev: "1", ino: "2", birthtimeNs: "3", uid: "1000" },
    context = { syntheticTransportOnly: true },
    root = "/operator-consumer-captures",
    name = "checktrail-consumer-witness-ABC123",
    namespace = { ...identity, ino: "5" },
    header = {
      registryPath: root + "/capture-registry.jsonl",
      parentPath: root,
      registryIdentity: { ...identity, ino: "4" },
      parentIdentity: identity,
    },
    registration = {
      id: randomUUID(),
      path: root + "/" + name,
      parent: { path: root, identity },
      identity: namespace,
      state: "collected-retained",
    },
    registry = { context, header, registrations: [registration] },
    manifest = {
      rootIdentity: identity,
      files: [{ path: "capture-registry.jsonl", ...header.registryIdentity }],
      directories: [{ path: name, ...namespace }],
    };
  assert.equal(
    requireConsumerExportRegistry(manifest, registry, context),
    registry,
  );
  for (const field of ["dev", "ino", "birthtimeNs", "uid"]) {
    const file = structuredClone(manifest);
    file.files[0]![field as keyof typeof identity] = "900";
    assert.throws(() => requireConsumerExportRegistry(file, registry, context));
    const parent = structuredClone(registry);
    parent.registrations[0]!.parent.identity[field as keyof typeof identity] =
      "900";
    assert.throws(() =>
      requireConsumerExportRegistry(manifest, parent, context),
    );
    const child = structuredClone(manifest);
    child.directories[0]![field as keyof typeof identity] = "900";
    assert.throws(() =>
      requireConsumerExportRegistry(child, registry, context),
    );
  }
  assert.throws(() =>
    requireConsumerExportRegistry(manifest, registry, {
      syntheticTransportOnly: false,
    }),
  );
  const unknown = structuredClone(manifest);
  unknown.directories.push({ path: "unregistered", ...namespace });
  assert.throws(
    () => requireConsumerExportRegistry(unknown, registry, context),
    /Unregistered/,
  );
  const removed = structuredClone(registry);
  removed.registrations[0]!.state = "collected-removed";
  assert.throws(() =>
    requireConsumerExportRegistry(manifest, removed, context),
  );
  assert.equal(
    requireConsumerExportRegistry(
      { ...manifest, directories: [] },
      removed,
      context,
    ),
    removed,
  );
  const missing = structuredClone(registry);
  missing.header.registryPath = root + "/foreign";
  assert.throws(() =>
    requireConsumerExportRegistry(manifest, missing, context),
  );
});

test(
  "closed Docker capture acquisition preserves handled actual failed metadata status and rejects foreign context or an unregistered capture entry",
  { skip: process.platform === "win32" },
  async () => {
    const { acquireConsumerDockerCaptures } = await import(
        new URL(
          "../../scripts/consumer-native-docker-acquisition.mjs",
          import.meta.url,
        ).href
      ),
      created = await context();
    try {
      const result = spawnSync(
        process.execPath,
        [
          wrapper,
          "--input-type=module",
          "-e",
          "process.stderr.write('synthetic actual metadata refusal');process.exitCode=7",
        ],
        {
          env: {
            ...process.env,
            CHECKTRAIL_CONSUMER_DOCKER_CONTEXT: created.path,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 7);
      const acquired = await acquireConsumerDockerCaptures(
        created.directory,
        created.context.registryContext,
      );
      assert.deepEqual(acquired.transports, []);
      assert.equal(acquired.captures.length, 1);
      assert.equal(acquired.captures[0].clientStatus, 7);
      assert.equal(acquired.captures[0].exportVerified, false);
      await assert.rejects(
        acquireConsumerDockerCaptures(created.directory, {
          ...created.context.registryContext,
          attemptId: randomUUID(),
        }),
      );
      const extra = path.join(created.directory, "unregistered");
      await mkdir(extra);
      await assert.rejects(
        acquireConsumerDockerCaptures(
          created.directory,
          created.context.registryContext,
        ),
        /Unknown native/,
      );
      await rm(extra, { recursive: true });
      assert.equal(
        (
          await acquireConsumerDockerCaptures(
            created.directory,
            created.context.registryContext,
          )
        ).captures[0].clientStatus,
        7,
      );
    } finally {
      await rm(created.directory, { recursive: true, force: true });
    }
  },
);
