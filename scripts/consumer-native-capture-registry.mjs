import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";

const MAX_BYTES = 1048576,
  MAX_EVENT_BYTES = 16384,
  MAX_REGISTRATIONS = 512,
  PROFILE = "checktrail-consumer-native-capture-registry-v1";
const tokens = new WeakMap();
const remembered = new Map();
const noControls = (value) =>
  [...value].every(
    (character) =>
      character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = (value, expected) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
};
function uuid(value) {
  assert.match(
    value,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
}
function kind(value) {
  assert.ok(
    ["native-consumer", "selected-clang-producer-consumer"].includes(value),
  );
}
function context(value) {
  keys(value, ["attemptId", "scopeId", "captureKind", "sourceFrameSha256"]);
  uuid(value.attemptId);
  assert.ok(
    typeof value.scopeId === "string" &&
      value.scopeId.length > 0 &&
      value.scopeId.trim() === value.scopeId &&
      Buffer.byteLength(value.scopeId) <= 512 &&
      noControls(value.scopeId),
  );
  kind(value.captureKind);
  assert.match(value.sourceFrameSha256, /^[a-f0-9]{64}$/);
  return {
    attemptId: value.attemptId,
    scopeId: value.scopeId,
    captureKind: value.captureKind,
    sourceFrameSha256: value.sourceFrameSha256,
  };
}
function flavor(filename) {
  return /^[A-Za-z]:\\/.test(filename) ? path.win32 : path.posix;
}
function storedPath(filename) {
  assert.ok(
    typeof filename === "string" &&
      filename.length > 0 &&
      Buffer.byteLength(filename) <= 4096 &&
      noControls(filename),
  );
  const selected = flavor(filename);
  assert.ok(
    selected.isAbsolute(filename) && selected.normalize(filename) === filename,
  );
  assert.ok(!filename.startsWith("\\\\"));
  return filename;
}
function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
    uid: String(stat.uid),
  };
}
function identityValue(value) {
  keys(value, ["dev", "ino", "birthtimeNs", "uid"]);
  for (const scalar of Object.values(value))
    assert.ok(typeof scalar === "string" && /^\d{1,40}$/.test(scalar));
}
/** Observed Linux image users include both the original root defaults and explicit nonroot users. */
export function consumerCaptureOwner(value) {
  assert.ok(
    Number.isSafeInteger(value.uid) && value.uid >= 0 && value.uid < 4294967295,
  );
  assert.ok(
    Number.isSafeInteger(value.gid) && value.gid >= 0 && value.gid < 4294967295,
  );
  return { uid: value.uid, gid: value.gid };
}
function headerValue(selected, filename, stat, parentPath, parent) {
  return {
    schemaVersion: 1,
    profile: PROFILE,
    registryId: randomUUID(),
    context: selected,
    registryPath: filename,
    registryIdentity: identity(stat),
    parentPath,
    parentIdentity: identity(parent),
  };
}
function sameIdentity(actual, expected) {
  assert.deepEqual(
    identity(actual),
    expected,
    "Capture registry physical identity changed",
  );
}
function privateMode(stat, mode) {
  return (
    process.platform === "win32" ||
    (stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o777n) === BigInt(mode))
  );
}
async function directory(filename, privateRequired = true) {
  storedPath(filename);
  assert.equal(
    await realpath(filename),
    filename,
    "Capture registry crosses a linked path",
  );
  const stat = await lstat(filename, { bigint: true });
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (!privateRequired || privateMode(stat, 0o700)),
    "Capture registry requires a private caller-owned directory",
  );
  if (privateRequired && process.platform === "win32")
    ensureWindowsTaskAccess(filename, "directory", false);
  return stat;
}
async function file(filename, fd, created = false) {
  storedPath(filename);
  assert.equal(
    await realpath(filename),
    filename,
    "Capture registry file crosses a link",
  );
  const linked = await lstat(filename, { bigint: true }),
    stat = await fd.stat({ bigint: true });
  assert.ok(
    linked.isFile() &&
      !linked.isSymbolicLink() &&
      stat.isFile() &&
      stat.nlink === 1n &&
      stat.size <= BigInt(MAX_BYTES) &&
      privateMode(stat, 0o600),
    "Capture registry requires a bounded private singly linked file",
  );
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
    assert.equal(linked[key], stat[key]);
  if (process.platform === "win32")
    ensureWindowsTaskAccess(filename, "file", created);
  return stat;
}
function noWindowsCustomParent() {
  assert.ok(
    process.platform !== "win32" ||
      process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT === undefined,
    "Operator POSIX capture parent is unsupported on Windows",
  );
}
async function namespace(filename, captureKind) {
  noWindowsCustomParent();
  kind(captureKind);
  storedPath(filename);
  assert.match(
    path.basename(filename),
    /^checktrail-consumer-witness-[A-Za-z0-9]{6}$/,
    "Capture registry accepts only owned consumer namespaces",
  );
  const parent = await realpath(
    process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT ?? os.tmpdir(),
  );
  assert.equal(
    path.dirname(filename),
    parent,
    "Capture namespace is outside its selected operator parent",
  );
  if (process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT !== undefined) {
    const stat = await directory(parent, false);
    assert.equal(
      stat.mode & 0o777n,
      0o700n,
      "Operator capture parent must be private",
    );
  }
  return {
    stat: await directory(filename),
    parent: await directory(parent, false),
    parentPath: parent,
  };
}
function namespaceRecord(value, expectedKind) {
  storedPath(value.path);
  storedPath(value.parent.path);
  const selected = flavor(value.path);
  assert.equal(selected.dirname(value.path), value.parent.path);
  assert.match(
    selected.basename(value.path),
    /^checktrail-consumer-witness-[A-Za-z0-9]{6}$/,
  );
  identityValue(value.identity);
  keys(value.parent, ["path", "identity"]);
  identityValue(value.parent.identity);
  assert.equal(value.captureKind, expectedKind);
}
/** Decode transported bytes only; this never establishes a live namespace or process observation. */
export function decodeConsumerCaptureRegistry(input) {
  assert.ok(
    input instanceof Uint8Array &&
      input.byteLength > 0 &&
      input.byteLength <= MAX_BYTES,
    "Capture registry exceeds its byte allowance",
  );
  const bytes = Buffer.from(input),
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(text.endsWith("\n"), "Capture registry ends in a partial event");
  const lines = text.slice(0, -1).split("\n");
  assert.ok(lines.length <= 1 + 2 * MAX_REGISTRATIONS);
  const values = lines.map((line) => {
    assert.ok(
      line.length > 0 && Buffer.byteLength(line) + 1 <= MAX_EVENT_BYTES,
      "Capture registry event exceeds its allowance",
    );
    const value = JSON.parse(line);
    assert.equal(
      JSON.stringify(value),
      line,
      "Capture registry event is noncanonical or has duplicate keys",
    );
    return value;
  });
  const header = values[0];
  keys(header, [
    "schemaVersion",
    "profile",
    "registryId",
    "context",
    "registryPath",
    "registryIdentity",
    "parentPath",
    "parentIdentity",
  ]);
  assert.equal(header.schemaVersion, 1);
  assert.equal(header.profile, PROFILE);
  uuid(header.registryId);
  context(header.context);
  storedPath(header.registryPath);
  storedPath(header.parentPath);
  identityValue(header.registryIdentity);
  identityValue(header.parentIdentity);
  assert.equal(
    flavor(header.registryPath).basename(header.registryPath),
    "capture-registry.jsonl",
  );
  assert.equal(
    flavor(header.registryPath).dirname(header.registryPath),
    header.parentPath,
  );
  const headerSha256 = hash(lines[0] + "\n"),
    registrations = new Map(),
    paths = new Set();
  for (const value of values.slice(1)) {
    assert.equal(value.registryId, header.registryId);
    assert.equal(
      value.headerSha256,
      headerSha256,
      "Capture registry has a foreign header",
    );
    uuid(value.id);
    if (value.type === "created") {
      keys(value, [
        "type",
        "id",
        "registryId",
        "headerSha256",
        "path",
        "identity",
        "parent",
        "captureKind",
      ]);
      namespaceRecord(value, header.context.captureKind);
      assert.ok(
        registrations.size < MAX_REGISTRATIONS &&
          !registrations.has(value.id) &&
          !paths.has(value.path),
        "Capture registry repeats a registration or namespace",
      );
      paths.add(value.path);
      registrations.set(value.id, {
        id: value.id,
        path: value.path,
        identity: value.identity,
        parent: value.parent,
        captureKind: value.captureKind,
        state: "created",
      });
    } else {
      keys(value, ["type", "id", "registryId", "headerSha256", "state"]);
      assert.equal(value.type, "finished");
      assert.ok(
        ["collected-retained", "collected-removed", "failed-retained"].includes(
          value.state,
        ),
      );
      const registered = registrations.get(value.id);
      assert.ok(
        registered && registered.state === "created",
        "Capture registry terminal event is missing or repeated",
      );
      registered.state = value.state;
    }
  }
  return {
    context: header.context,
    registrations: [...registrations.values()],
    registryId: header.registryId,
    headerSha256,
    header,
    file: { bytes: bytes.length, sha256: hash(bytes) },
  };
}
async function readPhysical(filename) {
  storedPath(filename);
  const parentPath = path.dirname(filename),
    parent = await directory(parentPath),
    fd = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  try {
    const before = await file(filename, fd),
      chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - total)),
        { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      assert.ok(
        total <= MAX_BYTES,
        "Capture registry exceeds its byte allowance",
      );
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total),
      after = await file(filename, fd);
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(
        before[key],
        after[key],
        "Capture registry changed during observation",
      );
    assert.equal(BigInt(total), after.size);
    sameIdentity(await directory(parentPath), identity(parent));
    const parsed = decodeConsumerCaptureRegistry(bytes);
    assert.equal(parsed.header.registryPath, filename);
    assert.equal(parsed.header.parentPath, parentPath);
    sameIdentity(after, parsed.header.registryIdentity);
    sameIdentity(parent, parsed.header.parentIdentity);
    const prior = remembered.get(filename);
    if (prior) {
      assert.equal(
        parsed.headerSha256,
        prior.headerSha256,
        "Capture registry header changed",
      );
      assert.ok(
        bytes.length >= prior.prefix.length &&
          bytes.subarray(0, prior.prefix.length).equals(prior.prefix),
        "Capture registry history changed or was truncated",
      );
    }
    remembered.set(filename, {
      headerSha256: parsed.headerSha256,
      prefix: bytes,
    });
    return { parsed, bytes };
  } finally {
    await fd.close();
  }
}
async function liveRegistration(registration) {
  sameIdentity(
    await directory(registration.parent.path, false),
    registration.parent.identity,
  );
  if (registration.state === "collected-removed") {
    try {
      await lstat(registration.path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    throw Error("Removed capture namespace was reused or is still present");
  }
  sameIdentity(await directory(registration.path), registration.identity);
}
/** Live inspection is separate from decoding copied bytes and refuses missing/reused namespaces. */
export async function readConsumerCaptureRegistry(filename) {
  const { parsed } = await readPhysical(filename);
  for (const registration of parsed.registrations)
    await liveRegistration(registration);
  return { ...parsed, file: { path: filename, ...parsed.file } };
}
async function locked(filename, operation) {
  const lock = path.join(path.dirname(filename), ".capture-registry.lock"),
    deadline = performance.now() + 10000;
  let fd;
  for (;;) {
    try {
      fd = await open(
        lock,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        0o600,
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert.ok(
        performance.now() < deadline,
        "Capture registry writer lock is busy",
      );
      await setTimeout(25);
    }
  }
  let original;
  try {
    original = await file(lock, fd, true);
    return await operation();
  } finally {
    await fd.close();
    if (original) {
      const now = await lstat(lock, { bigint: true });
      sameIdentity(now, identity(original));
      assert.ok(now.isFile() && !now.isSymbolicLink());
      await unlink(lock);
    }
  }
}
async function append(filename, parsed, event) {
  const bytes = Buffer.from(JSON.stringify(event) + "\n");
  assert.ok(
    bytes.length <= MAX_EVENT_BYTES &&
      parsed.file.bytes + bytes.length <= MAX_BYTES,
    "Capture registry append allowance exhausted",
  );
  const fd = await open(
    filename,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const stat = await file(filename, fd);
    sameIdentity(stat, parsed.header.registryIdentity);
    assert.equal(
      Number(stat.size),
      parsed.file.bytes,
      "Capture registry changed outside its writer",
    );
    // A partial/error append stays incomplete; never complete a fragment after another writer.
    const { bytesWritten } = await fd.write(bytes, 0, bytes.length, null);
    assert.equal(
      bytesWritten,
      bytes.length,
      "Capture registry append was partial",
    );
    await fd.sync();
  } finally {
    await fd.close();
  }
  const { parsed: after } = await readPhysical(filename);
  assert.equal(after.file.bytes, parsed.file.bytes + bytes.length);
  return after;
}
/** Operator-maintenance storage only: no project/MCP execution trust is granted. */
export async function createConsumerCaptureRegistry(directoryPath, input) {
  noWindowsCustomParent();
  const selected = context(input),
    parent = await directory(directoryPath),
    filename = path.join(directoryPath, "capture-registry.jsonl");
  const fd = await open(
    filename,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await file(filename, fd, true),
      header = headerValue(selected, filename, stat, directoryPath, parent),
      bytes = Buffer.from(JSON.stringify(header) + "\n");
    assert.ok(bytes.length <= MAX_EVENT_BYTES);
    const { bytesWritten } = await fd.write(bytes, 0, bytes.length, 0);
    assert.equal(
      bytesWritten,
      bytes.length,
      "Capture registry header was partial",
    );
    await fd.sync();
  } finally {
    await fd.close();
  }
  const observed = await readConsumerCaptureRegistry(filename);
  assert.deepEqual(observed.context, selected);
  return { path: filename, context: Object.freeze(selected) };
}
export async function registerConsumerCaptureNamespace(
  namespacePath,
  captureKind,
) {
  const filename = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  if (filename === undefined) return null;
  noWindowsCustomParent();
  storedPath(filename);
  const observed = await namespace(namespacePath, captureKind);
  return locked(filename, async () => {
    const { parsed } = await readPhysical(filename);
    assert.equal(parsed.context.captureKind, captureKind);
    assert.ok(
      parsed.registrations.length < MAX_REGISTRATIONS &&
        !parsed.registrations.some((row) => row.path === namespacePath),
      "Capture registry repeats a namespace",
    );
    const event = {
      type: "created",
      id: randomUUID(),
      registryId: parsed.registryId,
      headerSha256: parsed.headerSha256,
      path: namespacePath,
      identity: identity(observed.stat),
      parent: {
        path: observed.parentPath,
        identity: identity(observed.parent),
      },
      captureKind,
    };
    sameIdentity(await directory(namespacePath), event.identity);
    sameIdentity(
      await directory(observed.parentPath, false),
      event.parent.identity,
    );
    await append(filename, parsed, event);
    const token = Object.freeze({});
    tokens.set(token, { filename, event, used: false });
    return token;
  });
}
export async function finishConsumerCaptureRegistration(token, state) {
  if (token === null) return null;
  const saved = tokens.get(token);
  assert.ok(
    saved && !saved.used,
    "Capture registry token is foreign or already used",
  );
  assert.ok(
    ["collected-retained", "collected-removed", "failed-retained"].includes(
      state,
    ),
  );
  saved.used = true;
  return locked(saved.filename, async () => {
    const { parsed } = await readPhysical(saved.filename);
    assert.equal(parsed.registryId, saved.event.registryId);
    assert.equal(parsed.headerSha256, saved.event.headerSha256);
    const registration = parsed.registrations.find(
      (row) => row.id === saved.event.id,
    );
    assert.ok(registration && registration.state === "created");
    assert.equal(registration.path, saved.event.path);
    assert.deepEqual(registration.identity, saved.event.identity);
    await liveRegistration({ ...registration, state });
    await append(saved.filename, parsed, {
      type: "finished",
      id: registration.id,
      registryId: parsed.registryId,
      headerSha256: parsed.headerSha256,
      state,
    });
    return { id: registration.id, state };
  });
}

/** Fixed initializer for a newly created private Docker volume, with no source/tool/project imports. */
export const consumerCaptureRegistryBootstrapProgram = String.raw`
import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, open, readdir, realpath } from "node:fs/promises";
const PROFILE = ${JSON.stringify(PROFILE)};
const noControls = ${noControls};
const keys = ${keys};
${uuid}
${kind}
${context}
${identity}
${headerValue}
${consumerCaptureOwner}
assert.equal(process.platform,"linux","Capture registry volume bootstrap requires Linux");
assert.equal(process.getuid(),0,"Capture registry volume bootstrap requires its root initializer");
assert.equal(process.argv.length,2,"Capture registry bootstrap requires one JSON request argument");
const body=process.argv[1];assert.ok(typeof body==="string"&&Buffer.byteLength(body)<=16384,"Capture registry bootstrap input exceeds bound");
const request=JSON.parse(body);assert.equal(JSON.stringify(request),body,"Capture registry bootstrap request is noncanonical or has duplicate keys");
keys(request,["context","uid","gid"]);
const selected=context(request.context),{uid,gid}=consumerCaptureOwner(request);
const parentPath="/operator-consumer-captures",filename=parentPath+"/capture-registry.jsonl";
assert.equal(await realpath(parentPath),parentPath);
const original=await lstat(parentPath,{bigint:true});
assert.ok(original.isDirectory()&&!original.isSymbolicLink()&&original.uid===0n&&original.gid===0n,"Capture registry bootstrap requires a new root-owned volume parent");
assert.deepEqual(await readdir(parentPath),[],"Capture registry bootstrap refuses populated storage");
await chmod(parentPath,0o700);await chown(parentPath,uid,gid);
const parent=await lstat(parentPath,{bigint:true});
assert.equal(parent.dev,original.dev);assert.equal(parent.ino,original.ino);
assert.equal(parent.uid,BigInt(uid));assert.equal(parent.gid,BigInt(gid));assert.equal(parent.mode&0o777n,0o700n);
const fd=await open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
try {
  await fd.chmod(0o600);await fd.chown(uid,gid);
  const stat=await fd.stat({bigint:true}),linked=await lstat(filename,{bigint:true});
  assert.ok(stat.isFile()&&!linked.isSymbolicLink()&&stat.nlink===1n&&stat.size===0n);
  assert.equal(stat.dev,linked.dev);assert.equal(stat.ino,linked.ino);assert.equal(stat.uid,BigInt(uid));assert.equal(stat.gid,BigInt(gid));assert.equal(stat.mode&0o777n,0o600n);
  const header=headerValue(selected,filename,stat,parentPath,parent),bytes=Buffer.from(JSON.stringify(header)+"\n");assert.ok(bytes.length<=16384);
  const written=await fd.write(bytes,0,bytes.length,0);assert.equal(written.bytesWritten,bytes.length);await fd.sync();
  const after=await fd.stat({bigint:true}),current=await lstat(filename,{bigint:true}),finalParent=await lstat(parentPath,{bigint:true});
  assert.deepEqual(identity(after),identity(stat));assert.deepEqual(identity(current),identity(stat));assert.deepEqual(identity(finalParent),identity(parent));assert.equal(after.size,BigInt(bytes.length));assert.deepEqual(await readdir(parentPath),["capture-registry.jsonl"]);
  process.stdout.write(JSON.stringify({path:filename,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),registryId:header.registryId})+"\n");
} finally {await fd.close();}
`;
