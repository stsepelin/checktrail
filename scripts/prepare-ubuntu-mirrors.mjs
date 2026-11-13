import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

// apt-transport-mirror: URI<TAB>metadata; lower priorities precede unset ones.
// https://manpages.debian.org/trixie/apt/apt-transport-mirror.1.en.html
export const ubuntuMirrorCandidate =
  "https://mirror.math.princeton.edu/pub/ubuntu/\tpriority:0";
export const ubuntuMirrorSource = "/etc/apt/sources.list.d/ubuntu.sources";
export const ubuntuMirrorTargets = Object.freeze(["/etc/apt/apt-mirrors.txt"]);
const maximumBytes = 65536;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b, keys) => keys.every((key) => a[key] === b[key]);
const ownership = ["dev", "ino", "mode", "uid", "gid", "nlink", "size"];
const identity = [...ownership, "mtimeNs", "ctimeNs"];
const refusal = (reason) =>
  Object.assign(Error("Ubuntu mirror preparation refused"), {
    mirrorReason: reason,
  });
function physical(stat, directory = false) {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== 0n ||
    (stat.mode & 0o022n) !== 0n ||
    (stat.mode & 0o7000n) !== 0n ||
    (!directory &&
      ((stat.mode & 0o111n) !== 0n ||
        stat.nlink !== 1n ||
        stat.size < 1n ||
        stat.size > BigInt(maximumBytes))) ||
    (stat.mode & 0o400n) === 0n
  )
    throw refusal("unsafe-metadata");
}
async function readBounded(handle, size) {
  const bytes = Buffer.alloc(Number(size) + 1);
  let offset = 0;
  for (let reads = 0; offset < bytes.length; reads++) {
    if (reads >= 64) throw refusal("read-bound");
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead < 0 ||
      bytesRead > bytes.length - offset
    )
      throw refusal("read-bound");
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== Number(size)) throw refusal("target-changed");
  return bytes.subarray(0, offset);
}
async function capture(io, target) {
  const handle = await io.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    physical(stat);
    const bytes = await readBounded(handle, stat.size);
    if (
      !same(stat, await handle.stat({ bigint: true }), identity) ||
      !same(stat, await io.lstat(target, { bigint: true }), identity)
    )
      throw refusal("target-changed");
    return { target, handle, stat, bytes };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function unchanged(io, snapshot) {
  if (
    !same(
      snapshot.stat,
      await snapshot.handle.stat({ bigint: true }),
      identity,
    ) ||
    !same(
      snapshot.stat,
      await io.lstat(snapshot.target, { bigint: true }),
      identity,
    ) ||
    !(await readBounded(snapshot.handle, snapshot.stat.size)).equals(
      snapshot.bytes,
    )
  )
    throw refusal("target-changed");
}
function text(bytes) {
  const value = bytes.toString("utf8");
  if (
    !Buffer.from(value).equals(bytes) ||
    /\p{Cc}/u.test(value.replace(/[\t\r\n]/gu, "")) ||
    /\r(?!\n)/u.test(value)
  )
    throw refusal("unsupported-layout");
  return value;
}
function sourceTargets(bytes, catalog) {
  const selected = new Set();
  for (const stanza of text(bytes).split(/\r?\n[\t ]*\r?\n/u)) {
    const fields = new Map();
    let field;
    for (const line of stanza.split(/\r?\n/u)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      if (/^[\t ]/u.test(line)) {
        if (!field) throw refusal("unsupported-layout");
        fields.set(field, fields.get(field) + " " + line.trim());
        continue;
      }
      const pair = /^([A-Za-z][A-Za-z-]*):[\t ]*(.*)$/u.exec(line);
      if (!pair) throw refusal("unsupported-layout");
      field = pair[1].toLowerCase();
      if (fields.has(field)) throw refusal("unsupported-layout");
      fields.set(field, pair[2]);
    }
    if (!fields.size || fields.get("enabled") === "no") continue;
    for (const [key, expected] of [
      ["trusted", "no"],
      ["allow-insecure", "no"],
      ["allow-weak", "no"],
      ["allow-downgrade-to-insecure", "no"],
      ["check-valid-until", "yes"],
    ])
      if (fields.has(key) && fields.get(key) !== expected)
        throw refusal("unsafe-authentication");
    if (
      fields.get("signed-by") !==
      "/usr/share/keyrings/ubuntu-archive-keyring.gpg"
    )
      throw refusal("unsupported-layout");
    if (
      !fields
        .get("types")
        ?.trim()
        .split(/\s+/u)
        .every((type) => ["deb", "deb-src"].includes(type))
    )
      throw refusal("unsupported-layout");
    const uris = fields.get("uris")?.trim().split(/\s+/u);
    if (!uris?.length) throw refusal("unsupported-layout");
    for (const uri of uris) {
      const target = catalog.find(
        (candidate) => uri === "mirror+file:" + candidate,
      );
      if (!target) throw refusal("unsupported-layout");
      selected.add(target);
    }
  }
  if (!selected.size) throw refusal("unsupported-layout");
  return [...selected].sort();
}
function prependMirror(bytes) {
  const value = text(bytes);
  let originals = 0,
    candidate = 0;
  for (const line of value.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line === ubuntuMirrorCandidate) {
      candidate++;
      continue;
    }
    const [address, ...parts] = line.split("\t");
    let url;
    try {
      url = new URL(address);
    } catch {
      throw refusal("unsupported-layout");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      ![
        "azure.archive.ubuntu.com",
        "archive.ubuntu.com",
        "security.ubuntu.com",
      ].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !["/ubuntu", "/ubuntu/"].includes(url.pathname) ||
      address.trim() !== address
    )
      throw refusal("unsupported-layout");
    let priority = false;
    for (const item of parts
      .join("\t")
      .split(/[\t ]+/u)
      .filter(Boolean)) {
      const tag =
        /^(priority|arch|codename|component|lang|suite|type):([A-Za-z0-9,+.-]+)$/u.exec(
          item,
        );
      if (!tag) throw refusal("unsupported-layout");
      if (tag[1] === "priority") {
        if (
          priority ||
          !/^[1-9]\d*$/u.test(tag[2]) ||
          Number(tag[2]) > 2147483647
        )
          throw refusal("unsupported-layout");
        priority = true;
      }
    }
    originals++;
  }
  if (!originals || candidate > 1) throw refusal("unsupported-layout");
  const result = candidate
    ? bytes
    : Buffer.concat([
        Buffer.from(
          ubuntuMirrorCandidate + (value.includes("\r\n") ? "\r\n" : "\n"),
        ),
        bytes,
      ]);
  if (result.length > maximumBytes) throw refusal("size-bound");
  return result;
}
async function stage(io, original, bytes, temporaries) {
  const target = path.join(
    path.dirname(original.target),
    ".checktrail-mirrors-" + randomUUID(),
  );
  const handle = await io.open(
    target,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const result = { target, handle, bytes, stat: null };
  temporaries.push(result);
  let offset = 0;
  for (let writes = 0; offset < bytes.length; writes++) {
    if (writes >= 64) throw refusal("write-bound");
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > bytes.length - offset
    )
      throw refusal("write-bound");
    offset += bytesWritten;
  }
  await handle.chown(Number(original.stat.uid), Number(original.stat.gid));
  await handle.chmod(Number(original.stat.mode & 0o777n));
  await handle.sync();
  result.stat = await handle.stat({ bigint: true });
  physical(result.stat);
  return result;
}
async function owned(io, staged, target = staged.target) {
  const stat = await staged.handle.stat({ bigint: true });
  const named = await io.lstat(target, { bigint: true });
  physical(stat);
  if (
    !same(staged.stat, stat, identity) ||
    !same(stat, named, identity) ||
    !(await readBounded(staged.handle, stat.size)).equals(staged.bytes)
  )
    throw refusal("target-changed");
}

async function publishedIdentity(io, staged, target) {
  const current = await staged.handle.stat({ bigint: true });
  if (
    !same(staged.stat, current, [...ownership, "mtimeNs"]) ||
    !same(current, await io.lstat(target, { bigint: true }), identity) ||
    !(await readBounded(staged.handle, current.size)).equals(staged.bytes)
  )
    throw refusal("target-changed");
  staged.stat = current;
  await owned(io, staged, target);
}

// The production entry point supplies actual ownership and a fixed native IO
// adapter. Tests supply a synthetic filesystem; context is not a CLI trust flag.
export async function prepareUbuntuMirrorsWithIo(
  io,
  context,
  catalog = ubuntuMirrorTargets,
) {
  const empty = (state, reason) => ({
    schemaVersion: 1,
    state,
    reason,
    sourceCount: 0,
    targetCount: 0,
    changedCount: 0,
    restoredCount: 0,
    hashes: [],
  });
  const inactive = (metadata) => ({
    metadata,
    restore: async () => metadata,
    abandon: async () => ({
      ...metadata,
      state: "failed",
      reason: "quiescence-unverified",
    }),
  });
  if (
    context.platform !== "linux" ||
    context.githubActions !== "true" ||
    context.runnerEnvironment !== "github-hosted"
  )
    return inactive(empty("not-applicable", "outside-supported-ci"));
  if (context.uid !== 0 || context.effectiveUid !== 0)
    return inactive(empty("failed", "root-owner-required"));
  // Only the synthetic IO kernel accepts a test catalog. The production entry
  // always supplies the sealed, observed one-file catalog with native IO.
  if (
    (io === fs && catalog !== ubuntuMirrorTargets) ||
    !Array.isArray(catalog) ||
    catalog.length < 1 ||
    catalog.length > 2 ||
    new Set(catalog).size !== catalog.length ||
    catalog.some(
      (value) =>
        typeof value !== "string" ||
        path.posix.dirname(value) !== "/etc/apt" ||
        !value.endsWith(".txt"),
    )
  )
    return inactive(empty("failed", "unsupported-layout"));
  const snapshots = [],
    temporaries = [],
    changes = [],
    published = [];
  let source,
    metadata,
    finished = false,
    validated = false;
  const close = async () => {
    let failed = 0;
    for (const entry of temporaries) {
      try {
        const present = await io
          .lstat(entry.target, { bigint: true })
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        if (present) {
          const stat = await entry.handle.stat({ bigint: true });
          if (present.dev !== stat.dev || present.ino !== stat.ino)
            throw refusal("target-changed");
          await io.unlink(entry.target);
        }
      } catch {
        failed++;
      }
    }
    for (const entry of [...snapshots, ...temporaries])
      try {
        await entry.handle.close();
      } catch {
        failed++;
      }
    return failed;
  };
  const abandon = async () => {
    if (finished) return metadata;
    finished = true;
    const cleanupFailureCount = await close();
    metadata = {
      ...metadata,
      state: "failed",
      reason: "quiescence-unverified",
      restoredCount: 0,
      cleanupFailureCount,
    };
    return metadata;
  };
  const restore = async () => {
    if (finished) return metadata;
    finished = true;
    let failures = 0,
      restored = 0;
    try {
      if (source) await unchanged(io, source);
    } catch {
      failures++;
    }
    for (const change of [...published].reverse()) {
      try {
        await owned(io, change.replacement, change.original.target);
        await owned(io, change.rollback);
        await io.rename(change.rollback.target, change.original.target);
        await publishedIdentity(io, change.rollback, change.original.target);
        restored++;
      } catch {
        failures++;
      }
    }
    for (const entry of snapshots.filter(
      (entry) =>
        entry !== source &&
        !published.some((change) => change.original === entry),
    ))
      try {
        await unchanged(io, entry);
      } catch {
        failures++;
      }
    failures += await close();
    metadata = {
      ...metadata,
      state: failures
        ? "failed"
        : metadata.state === "prepared"
          ? "restored"
          : metadata.state,
      reason: failures ? "restoration-incomplete" : metadata.reason,
      restoredCount: restored,
    };
    return metadata;
  };
  try {
    for (const directory of ["/etc", "/etc/apt", "/etc/apt/sources.list.d"]) {
      const stat = await io.lstat(directory, { bigint: true });
      physical(stat, true);
      if ((await io.realpath(directory)) !== directory)
        throw refusal("unsafe-metadata");
    }
    source = await capture(io, ubuntuMirrorSource);
    snapshots.push(source);
    for (const target of sourceTargets(source.bytes, catalog)) {
      const original = await capture(io, target);
      snapshots.push(original);
      const bytes = prependMirror(original.bytes);
      if (!bytes.equals(original.bytes)) changes.push({ original, bytes });
    }
    validated = true;
    // Every intended target and payload is validated before staging any writes.
    for (const change of changes) {
      change.replacement = await stage(
        io,
        change.original,
        change.bytes,
        temporaries,
      );
      change.rollback = await stage(
        io,
        change.original,
        change.original.bytes,
        temporaries,
      );
    }
    metadata = {
      schemaVersion: 1,
      state: changes.length ? "prepared" : "unchanged",
      reason: null,
      sourceCount: 1,
      targetCount: snapshots.length - 1,
      changedCount: changes.length,
      restoredCount: 0,
      sourceSha256: hash(source.bytes),
      hashes: snapshots.slice(1).map((entry) => ({
        original: hash(entry.bytes),
        prepared: hash(
          changes.find((change) => change.original === entry)?.bytes ??
            entry.bytes,
        ),
      })),
    };
    for (const change of changes) {
      for (const entry of snapshots.filter(
        (entry) => !published.some((done) => done.original === entry),
      ))
        await unchanged(io, entry);
      await owned(io, change.replacement);
      await owned(io, change.rollback);
      await io.rename(change.replacement.target, change.original.target);
      published.push(change);
      await publishedIdentity(io, change.replacement, change.original.target);
    }
    return {
      get metadata() {
        return metadata;
      },
      restore,
      abandon,
    };
  } catch (error) {
    // Reconcile a rename which completed before an IO failure was reported.
    for (const change of changes.filter(
      (entry) => entry.replacement?.stat && !published.includes(entry),
    )) {
      try {
        await publishedIdentity(io, change.replacement, change.original.target);
        published.push(change);
      } catch {
        /* An unchanged or foreign target is not ours to restore. */
      }
    }
    const unsupported =
      !validated &&
      (error.code === "ENOENT" || error.mirrorReason === "unsupported-layout");
    const reasons = new Set([
      "unsafe-metadata",
      "unsafe-authentication",
      "read-bound",
      "write-bound",
      "target-changed",
      "size-bound",
    ]);
    metadata = {
      ...(metadata ?? empty("failed", null)),
      state: unsupported && published.length === 0 ? "unsupported" : "failed",
      changedCount: published.length,
      reason: unsupported
        ? "unsupported-layout"
        : reasons.has(error.mirrorReason)
          ? error.mirrorReason
          : "io-failure",
    };
    const result = await restore();
    return inactive(result);
  }
}

export function prepareUbuntuMirrors() {
  assert.equal(
    arguments.length,
    0,
    "Ubuntu mirror preparation accepts no arguments",
  );
  return prepareUbuntuMirrorsWithIo(fs, {
    platform: process.platform,
    uid: process.getuid?.(),
    effectiveUid: process.geteuid?.(),
    githubActions: process.env.GITHUB_ACTIONS,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
  });
}
