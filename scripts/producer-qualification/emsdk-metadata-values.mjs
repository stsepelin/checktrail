// Developer-only public-source metadata. Payloads remain inert data.
import assert from "node:assert/strict";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const gitObject = (kind, bytes) =>
  createHash("sha1")
    .update(kind + " " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
export function objectId(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^[0-9a-f]{40}$/u);
  return value;
}
export function relativePath(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.length > 0 && value.length <= 1024);
  assert.ok(
    value
      .split("/")
      .every(
        (part) =>
          part !== "." && part !== ".." && /^[A-Za-z0-9_.+-]+$/u.test(part),
      ),
  );
  return value;
}
export function strictJson(bytes, limits) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let position = 0,
    nodes = 0;
  const space = () => {
    while (/[ \r\n\t]/u.test(text[position] ?? "X")) position++;
  };
  function string() {
    const start = position++;
    while (position < text.length) {
      const ch = text[position++];
      if (ch === "\\") position++;
      else if (ch === '"') return JSON.parse(text.slice(start, position));
    }
    assert.fail("Unterminated JSON string");
  }
  function value(depth) {
    assert.ok(
      depth <= limits.jsonDepth && ++nodes <= limits.jsonNodes,
      "JSON structural limit exceeded",
    );
    space();
    const ch = text[position];
    if (ch === "{") {
      position++;
      space();
      const keys = new Set();
      if (text[position] === "}") {
        position++;
        return;
      }
      for (;;) {
        assert.equal(text[position], '"');
        const key = string();
        assert.ok(!keys.has(key), "Duplicate JSON key");
        keys.add(key);
        space();
        assert.equal(text[position++], ":");
        value(depth + 1);
        space();
        const next = text[position++];
        if (next === "}") return;
        assert.equal(next, ",");
        space();
      }
    }
    if (ch === "[") {
      position++;
      space();
      if (text[position] === "]") {
        position++;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        const next = text[position++];
        if (next === "]") return;
        assert.equal(next, ",");
      }
    }
    if (ch === '"') {
      string();
      return;
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
        text.slice(position),
      );
    assert.ok(token, "Invalid JSON token");
    position += token[0].length;
    const primitive = JSON.parse(token[0]);
    assert.ok(typeof primitive !== "number" || Number.isFinite(primitive));
  }
  value(0);
  space();
  assert.equal(position, text.length, "Trailing JSON data");
  return JSON.parse(text);
}
export function gitilesJson(bytes, limits) {
  const prefix = Buffer.from(")]}'\n");
  assert.ok(
    bytes.subarray(0, prefix.length).equals(prefix),
    "Missing Gitiles JSON prefix",
  );
  return strictJson(bytes.subarray(prefix.length), limits);
}
export function gitilesBlob(bytes, expected, maximum) {
  let encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (encoded.endsWith("\n")) encoded = encoded.slice(0, -1);
  assert.ok(
    encoded.length > 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded,
      ),
    "Invalid base64 body",
  );
  const decoded = Buffer.from(encoded, "base64");
  assert.equal(decoded.toString("base64"), encoded, "Noncanonical base64 body");
  assert.ok(
    decoded.length > 0 && decoded.length <= maximum,
    "Decoded blob bound exceeded",
  );
  assert.equal(
    gitObject("blob", decoded),
    objectId(expected),
    "Git blob mismatch",
  );
  return decoded;
}
export function commitMetadata(value, expected) {
  assert.equal(value.commit, objectId(expected), "Wrong upstream commit");
  objectId(value.tree);
  assert.ok(Array.isArray(value.parents) && value.parents.length <= 16);
  for (const parent of value.parents) objectId(parent);
  return {
    commit: value.commit,
    tree: value.tree,
    rawCommitObjectVerified: false,
  };
}
export function treeMetadata(value, expected, maximum) {
  assert.equal(value.id, objectId(expected), "Wrong Git tree");
  assert.ok(Array.isArray(value.entries) && value.entries.length <= maximum);
  const names = new Set();
  const kinds = new Map([
    [33188, "blob"],
    [33261, "blob"],
    [40960, "blob"],
    [16384, "tree"],
    [57344, "commit"],
  ]);
  for (const entry of value.entries) {
    relativePath(entry.name);
    assert.ok(!entry.name.includes("/"));
    assert.ok(!names.has(entry.name), "Duplicate Git name");
    names.add(entry.name);
    assert.ok(Number.isSafeInteger(entry.mode) && kinds.has(entry.mode));
    assert.equal(entry.type, kinds.get(entry.mode), "Git mode/type mismatch");
    objectId(entry.id);
  }
  const entries = [...value.entries].sort((a, b) =>
    Buffer.compare(
      Buffer.from(a.name + (a.type === "tree" ? "/" : "")),
      Buffer.from(b.name + (b.type === "tree" ? "/" : "")),
    ),
  );
  const raw = Buffer.concat(
    entries.map((e) =>
      Buffer.concat([
        Buffer.from(e.mode.toString(8) + " " + e.name + "\0"),
        Buffer.from(e.id, "hex"),
      ]),
    ),
  );
  assert.equal(gitObject("tree", raw), expected, "Git tree bytes mismatch");
  return new Map(value.entries.map((entry) => [entry.name, entry]));
}
export function selectedBlob(entries, role) {
  relativePath(role.path);
  assert.ok(!role.path.includes("/"));
  const entry = entries.get(role.path);
  if (!entry) {
    assert.equal(
      role.requiredTreeEntry,
      false,
      "Required source entry missing",
    );
    return null;
  }
  assert.equal(entry.type, "blob");
  assert.ok(
    [33188, 33261].includes(entry.mode),
    "Selected source cannot follow a symlink",
  );
  return entry.id;
}
export function metadataUrl(address, role) {
  assert.equal(address, role.url, "Metadata URL differs from frozen role");
  const u = new URL(address);
  assert.equal(u.protocol, "https:");
  assert.equal(u.hostname, "chromium.googlesource.com");
  assert.equal(u.username, "");
  assert.equal(u.password, "");
  assert.equal(u.hash, "");
  assert.ok(u.port === "" || u.port === "443");
  assert.equal(u.href, address, "Noncanonical metadata URL");
  assert.equal(
    u.search,
    role.kind === "blob" ? "?format=TEXT" : "?format=JSON",
  );
  return u;
}
