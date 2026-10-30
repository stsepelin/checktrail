import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID, createHash } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { test, type TestContext } from "node:test";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
const {
  createConsumerCaptureRegistry,
  registerConsumerCaptureNamespace,
  finishConsumerCaptureRegistration,
  readConsumerCaptureRegistry,
  decodeConsumerCaptureRegistry,
  consumerCaptureRegistryBootstrapProgram,
  consumerCaptureOwner,
} = await import(
  new URL("../../scripts/consumer-native-capture-registry.mjs", import.meta.url)
    .href
);
const moduleUrl = new URL(
  "../../scripts/consumer-native-capture-registry.mjs",
  import.meta.url,
).href;
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const context = () => ({
  attemptId: randomUUID(),
  scopeId: "synthetic-storage-only",
  captureKind: "native-consumer",
  sourceFrameSha256: "a".repeat(64),
});
const run = promisify(execFile);
async function owned(t: TestContext, prefix = "checktrail-registry-test-") {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(directory, "directory", true);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function setup(t: TestContext) {
  const previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY,
    previousParent = process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT;
  delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT;
  t.after(() => {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
    else process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = previous;
    if (previousParent === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT;
    else process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT = previousParent;
  });
  const parent = await owned(t),
    selected = context(),
    registry = await createConsumerCaptureRegistry(parent, selected);
  process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = registry.path;
  return { parent, selected, registry };
}

async function raw(filename: string) {
  return decodeConsumerCaptureRegistry(await readFile(filename));
}

test("absent operator registry and null tokens remain inert without touching supplied paths", async () => {
  const previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  try {
    assert.equal(
      await registerConsumerCaptureNamespace(
        "synthetic-nonexistent-path",
        "unknown",
      ),
      null,
    );
    assert.equal(
      await finishConsumerCaptureRegistration(null, "unknown"),
      null,
    );
  } finally {
    if (previous !== undefined)
      process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = previous;
  }
});
test("exclusive private registry binds exact context and physical header before any registration", async (t) => {
  const { registry, selected } = await setup(t),
    observed = await readConsumerCaptureRegistry(registry.path),
    bytes = await readFile(registry.path);
  assert.deepEqual(observed.context, selected);
  assert.deepEqual(observed.registrations, []);
  assert.equal(observed.file.bytes, bytes.length);
  assert.equal(observed.file.sha256, hash(bytes));
  if (process.platform === "win32")
    ensureWindowsTaskAccess(registry.path, "file", false);
  else assert.equal((await lstat(registry.path)).mode & 0o777, 0o600);
  await assert.rejects(
    createConsumerCaptureRegistry(path.dirname(registry.path), context()),
    { code: "EEXIST" },
  );
  assert.deepEqual(await readFile(registry.path), bytes);
});
test("created registration is durable before synthetic body and successful retained handoff preserves its exact namespace", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    );
  const before = await readConsumerCaptureRegistry(registry.path);
  assert.equal(before.registrations.length, 1);
  assert.equal(before.registrations[0].state, "created");
  assert.equal(before.registrations[0].path, namespace);
  await writeFile(
    path.join(namespace, "synthetic-body.json"),
    '{"synthetic":true}\n',
    { mode: 0o600 },
  );
  await finishConsumerCaptureRegistration(token, "collected-retained");
  const after = await readConsumerCaptureRegistry(registry.path);
  assert.equal(after.registrations[0].state, "collected-retained");
  assert.deepEqual(
    after.registrations[0].identity,
    before.registrations[0].identity,
  );
  assert.equal((await lstat(namespace)).isDirectory(), true);
  await rm(namespace, { recursive: true });
  await assert.rejects(readConsumerCaptureRegistry(registry.path), {
    code: "ENOENT",
  });
  assert.equal(
    (await raw(registry.path)).registrations[0].state,
    "collected-retained",
  );
});
test("successful removed handoff verifies actual disappearance and refuses reused tokens", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    );
  await rm(namespace, { recursive: true });
  await finishConsumerCaptureRegistration(token, "collected-removed");
  assert.equal(
    (await readConsumerCaptureRegistry(registry.path)).registrations[0].state,
    "collected-removed",
  );
  await assert.rejects(
    finishConsumerCaptureRegistration(token, "collected-removed"),
    /foreign or already used/,
  );
  await assert.rejects(
    finishConsumerCaptureRegistration({}, "failed-retained"),
    /foreign or already used/,
  );
});
test("failed retained handoff preserves the registered directory while removed state cannot be asserted for an existing namespace", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    );
  await finishConsumerCaptureRegistration(token, "failed-retained");
  assert.equal(
    (await readConsumerCaptureRegistry(registry.path)).registrations[0].state,
    "failed-retained",
  );
  const other = await owned(t, "checktrail-consumer-witness-"),
    pending = await registerConsumerCaptureNamespace(other, "native-consumer");
  await assert.rejects(
    finishConsumerCaptureRegistration(pending, "collected-removed"),
    /still present/,
  );
  assert.equal((await raw(registry.path)).registrations[1].state, "created");
  assert.equal((await lstat(other)).isDirectory(), true);
});
test("unacknowledged disappeared namespaces remain incomplete in transported bytes and fail live inspection", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-");
  await registerConsumerCaptureNamespace(namespace, "native-consumer");
  await rm(namespace, { recursive: true });
  assert.equal((await raw(registry.path)).registrations[0].state, "created");
  await assert.rejects(readConsumerCaptureRegistry(registry.path), {
    code: "ENOENT",
  });
});
test("changed namespace identity and a reused removed path cannot be accepted as the original owned capture", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    );
  await rm(namespace, { recursive: true });
  await mkdir(namespace, { mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(namespace, "directory", true);
  await assert.rejects(
    readConsumerCaptureRegistry(registry.path),
    /physical identity changed/,
  );
  await assert.rejects(
    finishConsumerCaptureRegistration(token, "failed-retained"),
    /physical identity changed/,
  );
});
test("namespace kinds prefixes and selected parent boundaries are exact rather than substring matches", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-");
  await assert.rejects(
    registerConsumerCaptureNamespace(
      namespace,
      "selected-clang-producer-consumer",
    ),
  );
  const nearName = await owned(t, "checktrail-consumer-witness-ABC123-extra-");
  await assert.rejects(
    registerConsumerCaptureNamespace(nearName, "native-consumer"),
    /only owned consumer namespaces/,
  );
  const wrong = await owned(t, "checktrail-clang-receipt-");
  await assert.rejects(
    registerConsumerCaptureNamespace(wrong, "native-consumer"),
    /only owned consumer namespaces/,
  );
  const nested = path.join(
    await owned(t),
    "checktrail-consumer-witness-ABC123",
  );
  await mkdir(nested, { mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(nested, "directory", true);
  await assert.rejects(
    registerConsumerCaptureNamespace(nested, "native-consumer"),
    /outside its selected operator parent/,
  );
  assert.deepEqual((await raw(registry.path)).registrations, []);
});
test(
  "private POSIX modes on parent namespace and registry are verified without implicit repairs",
  { skip: process.platform === "win32" },
  async (t) => {
    const parent = await owned(t);
    await chmod(parent, 0o755);
    await assert.rejects(
      createConsumerCaptureRegistry(parent, context()),
      /private caller-owned/,
    );
    await assert.rejects(
      readFile(path.join(parent, "capture-registry.jsonl")),
      { code: "ENOENT" },
    );
    assert.equal((await lstat(parent)).mode & 0o777, 0o755);
    await chmod(parent, 0o700);
    const { registry } = await setup(t),
      namespace = await owned(t, "checktrail-consumer-witness-");
    await chmod(namespace, 0o755);
    await assert.rejects(
      registerConsumerCaptureNamespace(namespace, "native-consumer"),
      /private caller-owned/,
    );
    assert.equal((await lstat(namespace)).mode & 0o777, 0o755);
    await chmod(namespace, 0o700);
    await chmod(registry.path, 0o644);
    await assert.rejects(
      registerConsumerCaptureNamespace(namespace, "native-consumer"),
      /private singly linked file/,
    );
    assert.equal((await lstat(registry.path)).mode & 0o777, 0o644);
    await chmod(registry.path, 0o600);
  },
);
test("linked registry files and namespace aliases refuse physical redirection", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    linked = path.join(path.dirname(registry.path), "linked.jsonl");
  await link(registry.path, linked);
  await assert.rejects(
    readConsumerCaptureRegistry(registry.path),
    /singly linked/,
  );
  await rm(linked);
  const alias = path.join(
    await realpath(os.tmpdir()),
    "checktrail-consumer-witness-" + randomUUID().slice(0, 6),
  );
  t.after(() => rm(alias, { recursive: true, force: true }));
  await symlink(
    namespace,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    registerConsumerCaptureNamespace(alias, "native-consumer"),
    /linked path/,
  );
  await readConsumerCaptureRegistry(registry.path);
});
test("copy-replaced registry identity and foreign headers cannot impersonate a created physical stream", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    ),
    original = await readFile(registry.path),
    parts = original.toString().trimEnd().split("\n"),
    header = JSON.parse(parts[0]!);
  header.context.scopeId = "foreign-synthetic-scope";
  parts[0] = JSON.stringify(header);
  const foreign = Buffer.from(parts.join("\n") + "\n");
  assert.throws(() => decodeConsumerCaptureRegistry(foreign), /foreign header/);
  await writeFile(registry.path, foreign);
  await assert.rejects(
    finishConsumerCaptureRegistration(token, "failed-retained"),
    /foreign header/,
  );
  await writeFile(registry.path, original);
  const replacement = path.join(path.dirname(registry.path), "replacement");
  await copyFile(registry.path, replacement);
  if (process.platform === "win32")
    ensureWindowsTaskAccess(replacement, "file", true);
  else await chmod(replacement, 0o600);
  await rename(replacement, registry.path);
  await assert.rejects(
    readConsumerCaptureRegistry(registry.path),
    /physical identity changed/,
  );
});
test("partial UTF8 noncanonical duplicate-key and oversized event bodies are rejected rather than treated as empty evidence", async (t) => {
  const { registry } = await setup(t),
    bytes = await readFile(registry.path),
    line = bytes.toString().trimEnd();
  for (const invalid of [
    bytes.subarray(0, bytes.length - 1),
    Buffer.from([0xff, 10]),
    Buffer.from("\n"),
    Buffer.alloc(1048577),
    Buffer.from(line.slice(0, -1) + ',"extra":"' + "x".repeat(16384) + '"}\n'),
    Buffer.from(
      line.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1') +
        "\n",
    ),
  ])
    assert.throws(() => decodeConsumerCaptureRegistry(invalid));
  assert.throws(
    () => decodeConsumerCaptureRegistry(Buffer.alloc(1048577)),
    /byte allowance/,
  );
  assert.throws(
    () =>
      decodeConsumerCaptureRegistry(
        Buffer.from(
          line.slice(0, -1) + ',"extra":"' + "x".repeat(16384) + '"}\n',
        ),
      ),
    /event exceeds its allowance/,
  );
  assert.deepEqual(decodeConsumerCaptureRegistry(bytes).registrations, []);
});
test("lifecycle decoder rejects duplicate registrations foreign IDs repeated terminal frames and unknown states", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    );
  await finishConsumerCaptureRegistration(token, "collected-retained");
  const original = await readFile(registry.path),
    lines = original.toString().trimEnd().split("\n"),
    created = JSON.parse(lines[1]!),
    finished = JSON.parse(lines[2]!);
  for (const values of [
    [lines[0], lines[1], lines[1]],
    [...lines, lines[2]],
    [lines[0], JSON.stringify({ ...finished, id: randomUUID() })],
    [lines[0], lines[1], JSON.stringify({ ...finished, state: "passed" })],
    [
      lines[0],
      JSON.stringify({ ...created, captureKind: "native-consumer-extra" }),
    ],
  ])
    assert.throws(() =>
      decodeConsumerCaptureRegistry(Buffer.from(values.join("\n") + "\n")),
    );
  assert.equal(
    decodeConsumerCaptureRegistry(original).registrations[0].state,
    "collected-retained",
  );
});
test("decoder admits the exact registration bound and rejects its valid-looking next registration", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-");
  await registerConsumerCaptureNamespace(namespace, "native-consumer");
  const lines = (await readFile(registry.path))
      .toString()
      .trimEnd()
      .split("\n"),
    template = JSON.parse(lines[1]!),
    events: string[] = [];
  for (let i = 0; i < 513; i++)
    events.push(
      JSON.stringify({
        ...template,
        id: randomUUID(),
        path: path.join(
          template.parent.path,
          "checktrail-consumer-witness-" + String(i).padStart(6, "0"),
        ),
      }),
    );
  assert.equal(
    decodeConsumerCaptureRegistry(
      Buffer.from([lines[0], ...events.slice(0, 512)].join("\n") + "\n"),
    ).registrations.length,
    512,
  );
  assert.throws(
    () =>
      decodeConsumerCaptureRegistry(
        Buffer.from([lines[0], ...events].join("\n") + "\n"),
      ),
    /repeats a registration or namespace/,
  );
});
test("independent actual writers serialize durable namespace handoffs without transferable finish tokens", async (t) => {
  const { registry } = await setup(t),
    namespaces = [
      await owned(t, "checktrail-consumer-witness-"),
      await owned(t, "checktrail-consumer-witness-"),
    ];
  const program =
    "const m=await import(process.argv[1]); const token=await m.registerConsumerCaptureNamespace(process.argv[2],'native-consumer'); await m.finishConsumerCaptureRegistration(token,'collected-retained'); process.stdout.write('synthetic-storage-handoff\\n');";
  const results = await Promise.all(
    namespaces.map((namespace) =>
      run(
        process.execPath,
        ["--input-type=module", "-e", program, moduleUrl, namespace],
        { env: process.env, timeout: 30000, maxBuffer: 65536 },
      ),
    ),
  );
  for (const result of results)
    assert.equal(result.stdout, "synthetic-storage-handoff\n");
  const observed = await readConsumerCaptureRegistry(registry.path);
  assert.equal(observed.registrations.length, 2);
  for (const registration of observed.registrations)
    assert.equal(registration.state, "collected-retained");
});
function addPublicWindowsRule(filename: string) {
  const script = String.raw`$ErrorActionPreference='Stop'
[void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$s=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
$r=$s.DeserializeObject([Console]::In.ReadToEnd())
$i=[System.IO.DirectoryInfo]::new($r.path)
$a=$i.GetAccessControl()
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$a.AddAccessRule($rule)
$i.SetAccessControl($a)
`;
  execFileSync(
    path.join(
      process.env.SystemRoot ?? process.env.SYSTEMROOT!,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ path: filename }),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 32768,
      windowsHide: true,
    },
  );
}
test(
  "native Windows uses verified existing namespace ACLs and refuses permissive ones without repair",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { registry } = await setup(t),
      namespace = await owned(t, "checktrail-consumer-witness-");
    ensureWindowsTaskAccess(registry.path, "file", false);
    addPublicWindowsRule(namespace);
    assert.throws(() => ensureWindowsTaskAccess(namespace, "directory", false));
    await assert.rejects(
      registerConsumerCaptureNamespace(namespace, "native-consumer"),
    );
    assert.throws(() => ensureWindowsTaskAccess(namespace, "directory", false));
    assert.deepEqual((await raw(registry.path)).registrations, []);
  },
);
test(
  "native Windows preserves explicit custom-parent refusal before creating registry bytes",
  { skip: process.platform !== "win32" },
  async (t) => {
    const parent = await owned(t),
      previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT;
    process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT = parent;
    try {
      await assert.rejects(
        createConsumerCaptureRegistry(parent, context()),
        /unsupported on Windows/,
      );
      await assert.rejects(
        readFile(path.join(parent, "capture-registry.jsonl")),
        { code: "ENOENT" },
      );
    } finally {
      if (previous === undefined)
        delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT;
      else process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT = previous;
    }
  },
);

test("strict context rejects foreign trust keys and malformed identifiers before any registry file exists", async (t) => {
  const parent = await owned(t);
  for (const invalid of [
    { ...context(), attemptId: "00000000-0000-3000-8000-000000000000" },
    { ...context(), scopeId: " synthetic " },
    { ...context(), scopeId: "synthetic\nsecond" },
    { ...context(), captureKind: "native-consumer-extra" },
    { ...context(), sourceFrameSha256: "a".repeat(63) },
    { ...context(), operatorTrust: true },
  ])
    await assert.rejects(createConsumerCaptureRegistry(parent, invalid));
  await assert.rejects(readFile(path.join(parent, "capture-registry.jsonl")), {
    code: "ENOENT",
  });
});

function limitedEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
test(
  "actual permission-limited writes retain captures and a regular writer completes the durable handoff",
  { skip: process.platform === "win32" },
  async (t) => {
    const { registry } = await setup(t),
      namespace = await owned(t, "checktrail-consumer-witness-"),
      marker = path.join(namespace, "synthetic-body-marker"),
      lock = path.join(path.dirname(registry.path), ".capture-registry.lock"),
      before = await readFile(registry.path);
    const program =
      "const m=await import(process.argv[1]); const token=await m.registerConsumerCaptureNamespace(process.argv[2],'native-consumer'); const f=await import('node:fs/promises'); await f.writeFile(process.argv[3],'synthetic body'); await m.finishConsumerCaptureRegistration(token,'collected-retained');";
    const args = [
      "--permission",
      "--allow-fs-read=*",
      "--allow-fs-write=" + lock,
      "--allow-fs-write=" + namespace,
      "--input-type=module",
      "-e",
      program,
      moduleUrl,
      namespace,
      marker,
    ];
    const denied = spawnSync(process.execPath, args, {
      env: limitedEnvironment(),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
    });
    assert.notEqual(denied.status, 0, String(denied.error) + denied.stderr);
    assert.match(denied.stderr, /ERR_ACCESS_DENIED/);
    assert.match(denied.stderr, /FileSystemWrite/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.deepEqual(await readFile(registry.path), before);
    assert.equal((await lstat(namespace)).isDirectory(), true);
    const durabilityProbe = spawnSync(
      process.execPath,
      [
        "--permission",
        "--allow-fs-read=*",
        "--allow-fs-write=" + registry.path,
        "--input-type=module",
        "-e",
        "const f=await import('node:fs/promises'); const h=await f.open(process.argv[1],'r+'); try{await h.sync();}finally{await h.close();}",
        registry.path,
      ],
      {
        env: limitedEnvironment(),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    const syncDenied = durabilityProbe.status !== 0;
    if (syncDenied) {
      assert.match(durabilityProbe.stderr, /ERR_ACCESS_DENIED/);
      assert.match(durabilityProbe.stderr, /fsync API is disabled/);
    }
    const syncAttempt = spawnSync(
      process.execPath,
      ["--allow-fs-write=" + registry.path, ...args],
      {
        env: limitedEnvironment(),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    if (!syncDenied) {
      assert.equal(
        syncAttempt.status,
        0,
        String(syncAttempt.error) + syncAttempt.stderr,
      );
      assert.equal(await readFile(marker, "utf8"), "synthetic body");
      assert.equal(
        (await readConsumerCaptureRegistry(registry.path)).registrations[0]
          .state,
        "collected-retained",
      );
    } else {
      assert.notEqual(
        syncAttempt.status,
        0,
        "Module must not cross an actual unavailable sync barrier",
      );
      assert.match(syncAttempt.stderr, /ERR_ACCESS_DENIED/);
      assert.match(syncAttempt.stderr, /fsync API is disabled/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.equal(
        (await raw(registry.path)).registrations[0].state,
        "created",
      );
      assert.equal((await lstat(namespace)).isDirectory(), true);
    }
    const fresh = await owned(t, "checktrail-consumer-witness-"),
      freshMarker = path.join(fresh, "synthetic-body-marker");
    const allowed = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program, moduleUrl, fresh, freshMarker],
      {
        env: limitedEnvironment(),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    assert.equal(
      allowed.status,
      0,
      JSON.stringify({
        error: allowed.error?.message,
        status: allowed.status,
        signal: allowed.signal,
        stderr: allowed.stderr,
      }),
    );
    assert.equal(await readFile(freshMarker, "utf8"), "synthetic body");
    assert.equal(
      (await readConsumerCaptureRegistry(registry.path)).registrations.at(-1)
        .state,
      "collected-retained",
    );
    const complete = await readFile(registry.path);
    await writeFile(registry.path, complete.subarray(0, complete.length - 1));
    await assert.rejects(
      readConsumerCaptureRegistry(registry.path),
      /partial event/,
    );
    await writeFile(registry.path, complete);
    await readConsumerCaptureRegistry(registry.path);
  },
);
test("fixed volume bootstrap is valid built-ins-only Node source using the shared exact native header constructor", () => {
  assert.equal(typeof consumerCaptureRegistryBootstrapProgram, "string");
  const source = ts.createSourceFile(
      "synthetic-bootstrap.mjs",
      consumerCaptureRegistryBootstrapProgram,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      assert.fail("Bootstrap cannot dynamically import a project");
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(imports, [
    "node:assert/strict",
    "node:process",
    "node:buffer",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
  ]);
  const checked = spawnSync(
    process.execPath,
    ["--input-type=module", "--check"],
    {
      input: consumerCaptureRegistryBootstrapProgram,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
    },
  );
  assert.equal(checked.status, 0, String(checked.error) + checked.stderr);
});

test("a valid-looking complete-line truncation cannot replace history already observed by its live reader", async (t) => {
  const { registry } = await setup(t),
    namespace = await owned(t, "checktrail-consumer-witness-"),
    token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    );
  await finishConsumerCaptureRegistration(token, "collected-retained");
  const complete = await readFile(registry.path),
    lines = complete.toString().trimEnd().split("\n"),
    prefix = Buffer.from(lines.slice(0, 2).join("\n") + "\n");
  assert.equal(
    decodeConsumerCaptureRegistry(prefix).registrations[0].state,
    "created",
  );
  await writeFile(registry.path, prefix);
  await assert.rejects(
    readConsumerCaptureRegistry(registry.path),
    /history changed or was truncated/,
  );
  await writeFile(registry.path, complete);
  assert.equal(
    (await readConsumerCaptureRegistry(registry.path)).registrations[0].state,
    "collected-retained",
  );
});

test("new owned volume owner validation preserves observed root defaults and both nonroot controller users while refusing malformed identities", () => {
  for (const uid of [0, 1000, 65532])
    assert.deepEqual(consumerCaptureOwner({ uid, gid: uid }), {
      uid,
      gid: uid,
    });
  for (const uid of [-1, 4294967295, Number.NaN, 1.5, "0", undefined])
    assert.throws(() => consumerCaptureOwner({ uid, gid: 1000 }));
  for (const gid of [-1, 4294967295, Number.NaN, 1.5, "0", undefined])
    assert.throws(() => consumerCaptureOwner({ uid: 1000, gid }));
});
