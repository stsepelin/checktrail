import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { readExactDescriptor, readPinnedFile } from "./emsdk-metadata-file.mjs";
import { performance } from "node:perf_hooks";
import {
  parseArchiveMetadata,
  readPinnedArchive,
} from "./emsdk-metadata-archive.mjs";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  gitObject,
  digest,
  strictJson,
  gitilesBlob,
  treeMetadata,
  relativePath,
  metadataUrl,
} from "./emsdk-metadata-values.mjs";
import {
  collectMetadata,
  validateCatalog,
} from "./emsdk-metadata-collector.mjs";
import { directMetadataTransport } from "./emsdk-metadata-https.mjs";
const { structuredClone } = globalThis;
const catalog = JSON.parse(
  fs.readFileSync(
    new URL("./emsdk-producer-metadata.v1.json", import.meta.url),
    "utf8",
  ),
);
const limits = catalog.limits;
const gitJson = (value) => Buffer.from(")]}'\n" + JSON.stringify(value));
const posix = {
  skip:
    typeof process.getuid !== "function"
      ? "POSIX owned-directory controls are unavailable"
      : false,
};
function fixture() {
  const responses = new Map(),
    trees = new Map();
  for (const root of catalog.roots) {
    const blobData = new Map([
      ["LICENSE", Buffer.from("Synthetic original notice\n")],
      [
        root.id === "v8" ? "DEPS" : ".gitmodules",
        Buffer.from("raise RuntimeError('UPSTREAM BYTES MUST STAY INERT')\n"),
      ],
    ]);
    const entries = [...blobData].map(([name, bytes]) => ({
      mode: 33188,
      type: "blob",
      name,
      id: gitObject("blob", bytes),
    }));
    if (root.id === "binaryen")
      entries.push({
        mode: 57344,
        type: "commit",
        name: "synthetic-submodule",
        id: "a".repeat(40),
      });
    const ordered = [...entries].sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
    );
    const raw = Buffer.concat(
      ordered.map((e) =>
        Buffer.concat([
          Buffer.from(e.mode.toString(8) + " " + e.name + "\0"),
          Buffer.from(e.id, "hex"),
        ]),
      ),
    );
    const tree = { id: gitObject("tree", raw), entries };
    trees.set(root.id, tree);
    responses.set(
      root.id + "-commit",
      gitJson({
        commit: root.commit,
        tree: tree.id,
        parents: ["b".repeat(40)],
      }),
    );
    responses.set(root.id + "-root", gitJson(tree));
    for (const role of catalog.roles.filter(
      (role) => role.root === root.id && role.kind === "blob",
    ))
      responses.set(
        role.id,
        Buffer.from(blobData.get(role.path).toString("base64") + "\n"),
      );
  }
  return { responses, trees };
}
function output(t) {
  const parent = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "checktrail-sdk-synthetic-"),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, "metadata");
}
function fake(responses, mutate = () => {}) {
  const calls = [],
    closed = [],
    signals = [];
  return {
    calls,
    closed,
    signals,
    transport: async (role, { signal }) => {
      calls.push(role.id);
      signals.push(signal);
      const state = {
        status: 200,
        headers: {},
        chunks: [responses.get(role.id)],
      };
      mutate(state, role);
      return {
        status: state.status,
        headers: state.headers,
        body:
          state.body ??
          (async function* () {
            for (const chunk of state.chunks) yield chunk;
          })(),
        close() {
          closed.push(role.id);
          if (state.onClose) state.onClose();
        },
      };
    },
  };
}
function failure(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "failure.json"), "utf8"));
}

test("SDK metadata catalog enumerates exactly the fixed eight roles and leaves build obligations open", () => {
  const valid = validateCatalog(catalog);
  assert.equal(valid.roles.length, 8);
  assert.equal(valid.reusedOriginalArtifacts.length, 12);
  assert.equal(typeof directMetadataTransport(valid), "function"); // Construct only; no transport call.
  for (const change of [
    (c) => c.roles.push(c.roles[0]),
    (c) => c.roles.pop(),
    (c) => (c.roots[0].commit = "c".repeat(40)),
    (c) => (c.roles[0].url += "&extra=1"),
    (c) => c.roles[0].maximumWireBytes++,
    (c) => (c.allowedRedirects = 1),
    (c) => c.limits.requestMs++,
    (c) => (c.gateAComplete = true),
    (c) => c.unresolvedRoles.pop(),
  ]) {
    const changed = structuredClone(catalog);
    change(changed);
    assert.throws(() => validateCatalog(changed));
  }
});
test("SDK metadata URLs reject credentials, host-prefix/suffix confusion, schemes and parameter extensions", () => {
  const role = catalog.roles[0];
  metadataUrl(role.url, role);
  for (const url of [
    role.url.replace("https:", "http:"),
    role.url.replace("//", "//credential@"),
    role.url.replace(
      "chromium.googlesource.com",
      "chromium.googlesource.com.attacker.test",
    ),
    role.url.replace(
      "chromium.googlesource.com",
      "prefixchromium.googlesource.com",
    ),
    role.url + "#fragment",
    role.url + "&format=TEXT",
    role.url.replace("/v8/v8/", "/v8/../v8/v8/"),
  ]) {
    assert.throws(() => metadataUrl(url, { ...role, url }));
  }
});
test("SDK strict JSON refuses duplicate escaped keys, malformed UTF-8, trailing bytes and structure limits", () => {
  assert.deepEqual(strictJson(Buffer.from('{"a":[1,true,null,"x"]}'), limits), {
    a: [1, true, null, "x"],
  });
  for (const value of [
    '{"a":1,"\\u0061":2}',
    '{"a":[}',
    '{"a":1} true',
    "1e9999",
    "[01]",
    '"unclosed',
  ])
    assert.throws(() => strictJson(Buffer.from(value), limits));
  assert.throws(() => strictJson(Buffer.from([0xff]), limits));
  assert.throws(() =>
    strictJson(Buffer.from("[[0]]"), { ...limits, jsonDepth: 1 }),
  );
  assert.throws(() =>
    strictJson(Buffer.from("[0,1]"), { ...limits, jsonNodes: 2 }),
  );
});
test("SDK base64 decoding binds canonical exact Git blob bytes and decoded limits", () => {
  const bytes = Buffer.from("synthetic inert source\n"),
    blob = gitObject("blob", bytes);
  assert.deepEqual(
    gitilesBlob(Buffer.from(bytes.toString("base64") + "\n"), blob, 1024),
    bytes,
  );
  for (const input of ["YQ=", "YR==", "YQ== ", "YQ==\n\n", "YQ==\r\n", ""])
    assert.throws(() => gitilesBlob(Buffer.from(input), blob, 1024));
  assert.throws(
    () =>
      gitilesBlob(Buffer.from(bytes.toString("base64")), "f".repeat(40), 1024),
    /Git blob mismatch/u,
  );
  assert.throws(
    () =>
      gitilesBlob(
        Buffer.from(bytes.toString("base64")),
        blob,
        bytes.length - 1,
      ),
    /bound/u,
  );
});
test("SDK Git tree reconstruction includes directory ordering, mode/type and exact submodule commits", () => {
  const entries = [
    { mode: 16384, type: "tree", name: "a", id: "1".repeat(40) },
    { mode: 33188, type: "blob", name: "a.c", id: "2".repeat(40) },
    { mode: 57344, type: "commit", name: "module", id: "3".repeat(40) },
  ];
  const sorted = [entries[1], entries[0], entries[2]];
  const raw = Buffer.concat(
    sorted.map((e) =>
      Buffer.concat([
        Buffer.from(e.mode.toString(8) + " " + e.name + "\0"),
        Buffer.from(e.id, "hex"),
      ]),
    ),
  );
  const value = { id: gitObject("tree", raw), entries };
  assert.equal(
    treeMetadata(value, value.id, 10).get("module").id,
    "3".repeat(40),
  );
  for (const change of [
    (v) => (v.entries[2].id = "4".repeat(40)),
    (v) => (v.entries[0].type = "blob"),
    (v) => v.entries.push(v.entries[0]),
    (v) => (v.entries[0].name = "../outside"),
    (v) => (v.entries[0].mode = 0),
  ]) {
    const bad = structuredClone(value);
    change(bad);
    assert.throws(() => treeMetadata(bad, value.id, 10));
  }
  assert.throws(() => treeMetadata(value, value.id, 2));
});
test("SDK source paths refuse traversal, empty components, control characters and shell expansions", () => {
  relativePath("tools/update.py");
  for (const p of [
    "../x",
    "/x",
    "a//b",
    "a/./b",
    "a/../b",
    "a\\b",
    "a\0b",
    "$(touch sentinel)",
    "a;b",
    "",
  ])
    assert.throws(() => relativePath(p));
});
test(
  "SDK synthetic collector retains original bytes and all notices, without executing payloads or closing producer gates",
  posix,
  async (t) => {
    const { responses } = fixture(),
      adapter = fake(responses),
      root = output(t);
    const result = await collectMetadata({
      catalog,
      outputRoot: root,
      transport: adapter.transport,
    });
    assert.deepEqual(
      adapter.calls,
      catalog.roles.map((role) => role.id),
    );
    assert.deepEqual(adapter.closed, adapter.calls);
    assert.ok(adapter.signals.every((signal) => signal.aborted));
    assert.equal(result.state, "first-stage-source-metadata-retained");
    assert.equal(result.roots[0].rawCommitObjectVerified, false);
    assert.equal(result.roots[1].gitlinks[0].moduleUrlBindingVerified, false);
    for (const key of [
      "upstreamCodeExecuted",
      "producerBuildReproduced",
      "gateAComplete",
      "realGitCheckoutIndexAndHistoryVerified",
      "originalDepsTransitionExecuted",
      "localArchiveMetadataCollected",
    ])
      assert.equal(result[key], false);
    assert.equal(
      fs.readFileSync(path.join(root, "v8-license.source"), "utf8"),
      "Synthetic original notice\n",
    );
    assert.equal(
      fs.readFileSync(path.join(root, "v8-deps.source"), "utf8"),
      "raise RuntimeError('UPSTREAM BYTES MUST STAY INERT')\n",
    );
    for (const receipt of result.receipts)
      assert.equal(receipt.semanticAdmission, true);
    for (const file of result.files)
      assert.equal(fs.statSync(path.join(root, file.file)).size, file.bytes);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, "metadata-manifest.json"), "utf8"),
    );
    assert.equal(persisted.receipts.length, 8);
    assert.equal(persisted.roots.length, 2);
  },
);
for (const status of [301, 302, 307, 308, 403, 404, 429, 500])
  test(
    "SDK collector retains status " +
      status +
      " as failure without following or retrying",
    posix,
    async (t) => {
      const adapter = fake(fixture().responses, (state) => {
          state.status = status;
        }),
        root = output(t);
      await assert.rejects(
        collectMetadata({
          catalog,
          outputRoot: root,
          transport: adapter.transport,
        }),
        /did not return 200/u,
      );
      assert.deepEqual(adapter.calls, ["v8-commit"]);
      assert.deepEqual(adapter.closed, adapter.calls);
      assert.equal(failure(root).receipts[0].status, status);
      assert.equal(failure(root).receipts[0].semanticAdmission, false);
      assert.ok(fs.existsSync(path.join(root, "v8-commit.response.partial")));
      assert.ok(!fs.existsSync(path.join(root, "metadata-manifest.json")));
    },
  );
for (const [name, mutate, pattern] of [
  [
    "wrong commit",
    (responses) =>
      responses.set(
        "v8-commit",
        gitJson({ commit: "f".repeat(40), tree: "a".repeat(40), parents: [] }),
      ),
    /Wrong upstream commit/u,
  ],
  [
    "malformed Git root",
    (responses) =>
      responses.set("v8-root", gitJson({ id: "a".repeat(40), entries: [] })),
    /Wrong Git tree/u,
  ],
  [
    "wrong submodule",
    (responses, trees) => {
      const v = structuredClone(trees.get("binaryen"));
      v.entries.at(-1).id = "f".repeat(40);
      responses.set("binaryen-root", gitJson(v));
    },
    /tree bytes mismatch/u,
  ],
  [
    "missing prefix",
    (responses) => responses.set("v8-commit", Buffer.from("{}")),
    /Missing Gitiles/u,
  ],
  [
    "malformed blob",
    (responses) => responses.set("v8-license", Buffer.from("not base64!?")),
    /Invalid base64/u,
  ],
  [
    "wrong blob",
    (responses) =>
      responses.set(
        "v8-license",
        Buffer.from(Buffer.from("different bytes").toString("base64")),
      ),
    /Git blob mismatch/u,
  ],
])
  test(
    "SDK collector refuses " + name + " and preserves original failed response",
    posix,
    async (t) => {
      const { responses, trees } = fixture();
      mutate(responses, trees);
      const adapter = fake(responses),
        root = output(t);
      await assert.rejects(
        collectMetadata({
          catalog,
          outputRoot: root,
          transport: adapter.transport,
        }),
        pattern,
      );
      const failed = failure(root);
      assert.equal(failed.state, "incomplete-failed-metadata-preparation");
      assert.ok(
        fs.existsSync(path.join(root, failed.stage + ".response.partial")),
      );
      assert.ok(!fs.existsSync(path.join(root, failed.stage + ".response")));
      assert.deepEqual(adapter.closed, adapter.calls);
    },
  );
test(
  "SDK optional module file absence is accepted only from the recomputed root inventory",
  posix,
  async (t) => {
    const { responses, trees } = fixture();
    const v = structuredClone(trees.get("binaryen"));
    v.entries = v.entries.filter((entry) => entry.name !== ".gitmodules");
    const raw = Buffer.concat(
      [...v.entries]
        .sort((a, b) =>
          Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
        )
        .map((e) =>
          Buffer.concat([
            Buffer.from(e.mode.toString(8) + " " + e.name + "\0"),
            Buffer.from(e.id, "hex"),
          ]),
        ),
    );
    v.id = gitObject("tree", raw);
    responses.set("binaryen-root", gitJson(v));
    responses.set(
      "binaryen-commit",
      gitJson({ commit: catalog.roots[1].commit, tree: v.id, parents: [] }),
    );
    const adapter = fake(responses),
      result = await collectMetadata({
        catalog,
        outputRoot: output(t),
        transport: adapter.transport,
      });
    assert.equal(adapter.calls.includes("binaryen-gitmodules"), false);
    assert.equal(
      result.roots[1].blobs.at(-1).state,
      "not-declared-by-bound-root-tree",
    );
  },
);
test(
  "SDK selected source symlinks are refused without fetching the target",
  posix,
  async (t) => {
    const { responses, trees } = fixture();
    const v = structuredClone(trees.get("v8"));
    v.entries.find((e) => e.name === "LICENSE").mode = 40960;
    const raw = Buffer.concat(
      [...v.entries]
        .sort((a, b) =>
          Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
        )
        .map((e) =>
          Buffer.concat([
            Buffer.from(e.mode.toString(8) + " " + e.name + "\0"),
            Buffer.from(e.id, "hex"),
          ]),
        ),
    );
    v.id = gitObject("tree", raw);
    responses.set("v8-root", gitJson(v));
    responses.set(
      "v8-commit",
      gitJson({ commit: catalog.roots[0].commit, tree: v.id, parents: [] }),
    );
    const adapter = fake(responses);
    await assert.rejects(
      collectMetadata({
        catalog,
        outputRoot: output(t),
        transport: adapter.transport,
      }),
      /symlink/u,
    );
    assert.deepEqual(adapter.calls, ["v8-commit", "v8-root"]);
  },
);
for (const [label, mutate, pattern] of [
  [
    "truncated content length",
    (state) =>
      (state.headers["content-length"] = String(state.chunks[0].length + 1)),
    /Truncated/u,
  ],
  [
    "excess content length",
    (state) => (state.headers["content-length"] = "1048577"),
    /Advertised/u,
  ],
  [
    "ambiguous content length",
    (state) => (state.headers["content-length"] = "001"),
    /match/u,
  ],
  [
    "encoded response",
    (state) => (state.headers["content-encoding"] = "gzip"),
    /Encoded/u,
  ],
  [
    "stream overflow",
    (state) => (state.chunks = [Buffer.from("first"), Buffer.alloc(1048576)]),
    /Streamed/u,
  ],
])
  test(
    "SDK collector refuses " + label + " and closes its response",
    posix,
    async (t) => {
      const adapter = fake(fixture().responses, mutate),
        root = output(t);
      await assert.rejects(
        collectMetadata({
          catalog,
          outputRoot: root,
          transport: adapter.transport,
        }),
        pattern,
      );
      assert.deepEqual(adapter.calls, ["v8-commit"]);
      assert.deepEqual(adapter.closed, adapter.calls);
      assert.equal(failure(root).receipts[0].complete, false);
      assert.equal(failure(root).receipts[0].cleanupComplete, true);
    },
  );
test(
  "SDK collector publication race preserves the preexisting manifest and rejects completion",
  posix,
  async (t) => {
    const root = output(t),
      adapter = fake(fixture().responses, (state, role) => {
        if (role.id === "binaryen-gitmodules")
          fs.writeFileSync(
            path.join(root, "metadata-manifest.json"),
            "synthetic race sentinel",
            { flag: "wx", mode: 0o600 },
          );
      });
    await assert.rejects(
      collectMetadata({
        catalog,
        outputRoot: root,
        transport: adapter.transport,
      }),
      /EEXIST/u,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "metadata-manifest.json"), "utf8"),
      "synthetic race sentinel",
    );
    assert.equal(failure(root).stage, "publish-manifest");
  },
);
test(
  "SDK collector refuses existing output roots before requesting and freezes catalog before awaits",
  posix,
  async (t) => {
    const root = output(t),
      adapter = fake(fixture().responses);
    fs.mkdirSync(root, { mode: 0o700 });
    await assert.rejects(
      collectMetadata({
        catalog,
        outputRoot: root,
        transport: adapter.transport,
      }),
      /EEXIST/u,
    );
    assert.deepEqual(adapter.calls, []);
    const supplied = structuredClone(catalog),
      other = fake(fixture().responses, (_, role) => {
        if (role.id === "v8-commit")
          supplied.roles[1].url = "https://attacker.test/";
      });
    await collectMetadata({
      catalog: supplied,
      outputRoot: output(t),
      transport: other.transport,
    });
    assert.equal(other.calls.length, 8);
  },
);
test(
  "SDK collector one monotonic phase reserves terminal time before starting another request",
  posix,
  async (t) => {
    let time = 0;
    const root = output(t),
      adapter = fake(fixture().responses, (state, role) => {
        if (role.id === "v8-commit")
          state.onClose = () => {
            time = 110001;
          };
      });
    await assert.rejects(
      collectMetadata({
        catalog,
        outputRoot: root,
        transport: adapter.transport,
        now: () => time,
      }),
      /reserve/u,
    );
    assert.deepEqual(adapter.calls, ["v8-commit"]);
    assert.deepEqual(adapter.closed, adapter.calls);
    assert.equal(failure(root).stage, "v8-root");
    assert.equal(
      fs.existsSync(path.join(root, "metadata-manifest.json")),
      false,
    );
  },
);
test(
  "SDK collector enforces an absolute request deadline despite a returned response",
  posix,
  async (t) => {
    let time = 0;
    const root = output(t),
      adapter = fake(fixture().responses, () => {
        time = 15001;
      });
    await assert.rejects(
      collectMetadata({
        catalog,
        outputRoot: root,
        transport: adapter.transport,
        now: () => time,
      }),
      /deadline/u,
    );
    assert.deepEqual(adapter.calls, ["v8-commit"]);
    assert.deepEqual(adapter.closed, adapter.calls);
    assert.equal(failure(root).receipts[0].complete, false);
    assert.equal(failure(root).receipts[0].cleanupComplete, true);
  },
);

test("SDK entire catalog pin covers retained-only original references and archive metadata", () => {
  for (const change of [
    (v) => (v.reusedOriginalArtifacts[0].sha256 = "0".repeat(64)),
    (v) => v.reusedOriginalArtifacts.pop(),
    (v) => v.localArchiveMetadata.selectedPaths.push("foreign"),
    (v) => (v.unknown = true),
  ]) {
    const value = structuredClone(catalog);
    change(value);
    assert.throws(() => validateCatalog(value), /Catalog value differs/u);
  }
});
test("SDK dormant HTTPS adapter uses an isolated direct verified TLS agent and never forwards ambient auth or proxies", async () => {
  const original = https.request;
  let captured,
    ended = false,
    destroyed = false,
    responseDestroyed = false;
  try {
    https.request = (url, options, callback) => {
      captured = { url, options };
      const request = new EventEmitter();
      request.end = () => {
        ended = true;
        const response = {
          statusCode: 200,
          headers: {
            "content-length": "2",
            "set-cookie": "SYNTHETIC_NOT_FOR_RETENTION",
          },
          destroy() {
            responseDestroyed = true;
          },
        };
        callback(response);
      };
      request.destroy = () => {
        destroyed = true;
      };
      return request;
    };
    const abort = new globalThis.AbortController();
    const response = await directMetadataTransport(catalog)(catalog.roles[0], {
      signal: abort.signal,
    });
    assert.equal(ended, true);
    assert.equal(captured.url.href, catalog.roles[0].url);
    assert.equal(captured.options.method, "GET");
    assert.equal(captured.options.rejectUnauthorized, true);
    assert.equal(captured.options.servername, "chromium.googlesource.com");
    assert.notEqual(captured.options.agent, https.globalAgent);
    assert.deepEqual(captured.options.agent.options.proxyEnv, {});
    assert.equal(captured.options.agent.options.rejectUnauthorized, true);
    assert.deepEqual(captured.options.agent.options.ca, tls.rootCertificates);
    assert.deepEqual(captured.options.headers, {
      Accept: "application/json",
      "Accept-Encoding": "identity",
    });
    assert.deepEqual(Object.keys(response.headers).sort(), [
      "content-encoding",
      "content-length",
    ]);
    response.close();
    assert.equal(destroyed, true);
    assert.equal(responseDestroyed, true);
    let calls = 0;
    https.request = () => {
      calls++;
      throw new Error("UNAUTHORIZED REQUEST");
    };
    await assert.rejects(
      directMetadataTransport(catalog)(
        { ...catalog.roles[0], url: "https://attacker.test/" },
        { signal: abort.signal },
      ),
    );
    assert.equal(calls, 0);
  } finally {
    https.request = original;
  }
});

const archiveCommit = "a".repeat(40),
  archiveRoot = "emscripten-" + archiveCommit;
function tarMember(name, body = Buffer.alloc(0), type = 48) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header[156] = type;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}
function paxRecord(key, value) {
  const rest = " " + key + "=" + value + "\n";
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length)
    length = String(length).length + rest.length;
  return Buffer.from(String(length) + rest);
}
const parseOptions = () => ({
  expectedRoot: archiveRoot,
  sourceCommit: archiveCommit,
  selectedPaths: ["LICENSE", "bootstrap.py"],
  maximumSelectedFileBytes: 4194304,
});
const archiveMembers = () => [
  tarMember("pax_global_header", paxRecord("comment", archiveCommit), 103),
  tarMember(archiveRoot + "/", Buffer.alloc(0), 53),
  tarMember(
    archiveRoot + "/LICENSE",
    Buffer.from("Synthetic full original notice\n"),
  ),
  tarMember(
    archiveRoot + "/bootstrap.py",
    Buffer.from("raise RuntimeError('DO NOT EXECUTE SOURCE')\n"),
  ),
];
const tarArchive = (members) =>
  gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]));
test("SDK local archive reader retains exact selected bytes and original notice without extracting or executing any member", async () => {
  const result = await parseArchiveMetadata(
    tarArchive(archiveMembers()),
    parseOptions(),
  );
  assert.equal(result.files.length, 2);
  assert.equal(result.upstreamCodeExecuted, false);
  assert.equal(
    result.files.find((v) => v.file === "LICENSE").bytes.toString(),
    "Synthetic full original notice\n",
  );
  assert.equal(
    result.files.find((v) => v.file === "bootstrap.py").bytes.toString(),
    "raise RuntimeError('DO NOT EXECUTE SOURCE')\n",
  );
});
for (const [label, make, pattern] of [
  [
    "wrong commit",
    () => [
      tarMember("pax_global_header", paxRecord("comment", "b".repeat(40)), 103),
      ...archiveMembers().slice(1),
    ],
    /commit comment/u,
  ],
  [
    "wrong root",
    () => [
      ...archiveMembers().slice(0, 1),
      tarMember("foreign/LICENSE", Buffer.from("x")),
    ],
    /Wrong source archive root/u,
  ],
  [
    "traversal",
    () => [tarMember(archiveRoot + "/../LICENSE", Buffer.from("x"))],
    /traversal/u,
  ],
  [
    "absolute path",
    () => [tarMember("/" + archiveRoot + "/LICENSE", Buffer.from("x"))],
    /Absolute/u,
  ],
  [
    "duplicate member",
    () => [...archiveMembers(), archiveMembers()[2]],
    /Duplicate source/u,
  ],
  [
    "selected symlink",
    () =>
      archiveMembers().map((member, index) =>
        index === 2
          ? tarMember(archiveRoot + "/LICENSE", Buffer.alloc(0), 50)
          : member,
      ),
    /cannot follow/u,
  ],
  ["missing metadata", () => archiveMembers().slice(0, -1), /missing/u],
  [
    "unsupported PAX override",
    () => [
      tarMember(archiveRoot + "/pax", paxRecord("size", "999999"), 120),
      ...archiveMembers().slice(1),
    ],
    /Unsupported local PAX/u,
  ],
])
  test("SDK local archive reader refuses " + label, async () => {
    await assert.rejects(
      parseArchiveMetadata(tarArchive(make()), parseOptions()),
      pattern,
    );
  });
test("SDK local archive reader binds local PAX paths, refuses path escape and never follows inert unselected links", async () => {
  const base = archiveMembers();
  const selected = [
    base[0],
    base[1],
    tarMember(
      archiveRoot + "/pax",
      paxRecord("path", archiveRoot + "/LICENSE"),
      120,
    ),
    tarMember(
      archiveRoot + "/placeholder",
      Buffer.from("Synthetic original notice"),
    ),
    base[3],
    tarMember(archiveRoot + "/inert-link", Buffer.alloc(0), 50),
  ];
  const good = await parseArchiveMetadata(tarArchive(selected), parseOptions());
  assert.equal(good.files.length, 2);
  selected[2] = tarMember(
    archiveRoot + "/pax",
    paxRecord("path", archiveRoot + "/../LICENSE"),
    120,
  );
  await assert.rejects(
    parseArchiveMetadata(tarArchive(selected), parseOptions()),
    /traversal/u,
  );
});
test("SDK local archive reader refuses malformed tar, padding, checksum, gzip and all bounded resource overflows", async () => {
  const members = archiveMembers();
  const checksum = Buffer.from(members[2]);
  checksum[1] ^= 1;
  await assert.rejects(
    parseArchiveMetadata(tarArchive([checksum]), parseOptions()),
    /checksum/u,
  );
  const padding = Buffer.from(members[2]);
  padding[padding.length - 1] = 1;
  await assert.rejects(
    parseArchiveMetadata(tarArchive([padding]), parseOptions()),
    /padding/u,
  );
  await assert.rejects(
    parseArchiveMetadata(Buffer.from("not gzip"), parseOptions()),
  );
  await assert.rejects(
    parseArchiveMetadata(gzipSync(Buffer.concat(members)), parseOptions()),
    /Truncated/u,
  );
  for (const extra of [
    { maximumEntries: 1 },
    { maximumInflatedBytes: 512 },
    { maximumSelectedFileBytes: 1 },
    { deadline: performance.now() - 1 },
  ])
    await assert.rejects(
      parseArchiveMetadata(tarArchive(members), {
        ...parseOptions(),
        ...extra,
      }),
      /limit|deadline/u,
    );
  for (const extra of [
    { maximumInflatedBytes: 268435457 },
    { maximumEntries: 65537 },
    { maximumSelectedFileBytes: 4194305 },
  ])
    await assert.rejects(
      parseArchiveMetadata(tarArchive(members), {
        ...parseOptions(),
        ...extra,
      }),
      /cannot increase/u,
    );
});
test("SDK pinned local archive refuses a caller-altered archive pin before reading any file", async () => {
  for (const change of [
    (v) => (v.sha256 = "0".repeat(64)),
    (v) => v.selectedPaths.push("foreign.py"),
    (v) => v.bytes++,
    (v) => (v.executeContents = true),
  ]) {
    const metadata = structuredClone(catalog.localArchiveMetadata);
    change(metadata);
    await assert.rejects(
      readPinnedArchive({ archive: "THIS_FILE_IS_NEVER_READ", metadata }),
    );
  }
});
test(
  "SDK pinned local archive checks actual physical byte hash rather than trusting a caller receipt",
  posix,
  async (t) => {
    const root = output(t),
      file = path.join(path.dirname(root), "synthetic-sparse.archive");
    const expected = catalog.localArchiveMetadata;
    const members = [
      tarMember(
        "pax_global_header",
        paxRecord("comment", expected.sourceCommit),
        103,
      ),
      ...expected.selectedPaths.map((name) =>
        tarMember(
          "emscripten-" + expected.sourceCommit + "/" + name,
          Buffer.from("SYNTHETIC INERT SOURCE " + name + "\n"),
        ),
      ),
    ];
    const data = tarArchive(members),
      fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.ftruncateSync(fd, expected.bytes);
    } finally {
      fs.closeSync(fd);
    }
    await assert.rejects(
      readPinnedArchive({
        archive: file,
        metadata: catalog.localArchiveMetadata,
      }),
      /archive hash mismatch/u,
    );
  },
);

test(
  "SDK collector preserves the body failure and close failure while finishing independent file cleanup",
  posix,
  async (t) => {
    const root = output(t),
      adapter = fake(fixture().responses, (state) => {
        state.body = (async function* () {
          yield Buffer.from("bounded partial");
          throw new Error("synthetic body failure");
        })();
        state.onClose = () => {
          throw new Error("synthetic close failure");
        };
      });
    await assert.rejects(
      collectMetadata({
        catalog,
        outputRoot: root,
        transport: adapter.transport,
      }),
      (error) => {
        assert.equal(error.name, "AggregateError");
        assert.ok(
          error.errors.some((e) => e.message === "synthetic body failure"),
        );
        assert.ok(
          error.errors.some((e) => e.message === "synthetic close failure"),
        );
        return true;
      },
    );
    assert.deepEqual(adapter.closed, ["v8-commit"]);
    assert.equal(failure(root).receipts[0].cleanupComplete, false);
    assert.equal(
      fs.readFileSync(path.join(root, "v8-commit.response.partial"), "utf8"),
      "bounded partial",
    );
  },
);

test("SDK HTTPS response cleanup always attempts the request and private agent after a stream close failure", async () => {
  const original = https.request;
  let requestClosed = false,
    agentClosed = false;
  try {
    https.request = (_, options, callback) => {
      const closeAgent = options.agent.destroy.bind(options.agent);
      options.agent.destroy = () => {
        agentClosed = true;
        closeAgent();
      };
      const request = new EventEmitter();
      request.destroy = () => {
        requestClosed = true;
      };
      request.end = () =>
        callback({
          statusCode: 200,
          headers: {},
          destroy() {
            throw new Error("synthetic response close failure");
          },
        });
      return request;
    };
    const response = await directMetadataTransport(catalog)(catalog.roles[0], {
      signal: new globalThis.AbortController().signal,
    });
    assert.throws(
      () => response.close(),
      (error) =>
        error.name === "AggregateError" &&
        error.errors[0].message === "synthetic response close failure",
    );
    assert.equal(requestClosed, true);
    assert.equal(agentClosed, true);
  } finally {
    https.request = original;
  }
});

function syntheticPinnedFile(t, length = 120000) {
  const root = output(t),
    file = path.join(path.dirname(root), "owned-pinned-input");
  const body = Buffer.alloc(length, 97);
  fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
  return {
    file,
    body,
    pin: {
      bytes: body.length,
      sha256: digest(body),
      deadline: performance.now() + 30000,
    },
  };
}
function observeOwnedReads(file, action, operation) {
  const inode = fs.statSync(file).ino,
    original = fs.readSync,
    reads = [];
  fs.readSync = (fd, buffer, offset, length, position) => {
    const target = fs.fstatSync(fd).ino === inode;
    const count = original(fd, buffer, offset, length, position);
    if (target) {
      reads.push({ requested: length, actual: count, position });
      action(reads, count);
    }
    return count;
  };
  try {
    return operation(reads);
  } finally {
    fs.readSync = original;
  }
}
test("SDK pinned-file reader bounds unchanged actual files, empty files, exact size and hash", (t) => {
  const selected = syntheticPinnedFile(t);
  assert.deepEqual(readPinnedFile(selected.file, selected.pin), selected.body);
  for (const change of [(v) => v.bytes++, (v) => v.bytes--]) {
    const pin = { ...selected.pin };
    change(pin);
    assert.throws(
      () => readPinnedFile(selected.file, pin),
      /initial size mismatch/u,
    );
  }
  assert.throws(
    () =>
      readPinnedFile(selected.file, {
        ...selected.pin,
        sha256: "0".repeat(64),
      }),
    /hash mismatch/u,
  );
  const empty = syntheticPinnedFile(t, 0);
  assert.deepEqual(readPinnedFile(empty.file, empty.pin), Buffer.alloc(0));
});
test("SDK pinned-file reader detects actual growth using at most expected bytes plus one sentinel", (t) => {
  const selected = syntheticPinnedFile(t);
  let appended = false;
  observeOwnedReads(
    selected.file,
    (reads, count) => {
      if (!appended && count > 0) {
        appended = true;
        fs.appendFileSync(selected.file, Buffer.alloc(70000, 98));
      }
    },
    (reads) => {
      assert.throws(
        () => readPinnedFile(selected.file, selected.pin),
        /exceeded expected byte bound/u,
      );
      assert.equal(appended, true);
      assert.equal(
        reads.reduce((sum, r) => sum + r.actual, 0),
        selected.pin.bytes + 1,
      );
      assert.ok(reads.every((r) => r.requested <= 65536));
    },
  );
  assert.equal(fs.statSync(selected.file).size, selected.pin.bytes + 70000);
});
test("SDK bounded descriptor detects actual growth after its EOF sentinel before accepting identity", (t) => {
  const selected = syntheticPinnedFile(t);
  let appended = false;
  const fd = fs.openSync(selected.file, "r");
  try {
    observeOwnedReads(
      selected.file,
      (_, count) => {
        if (count === 0 && !appended) {
          appended = true;
          fs.appendFileSync(selected.file, "G");
        }
      },
      () => {
        assert.throws(
          () => readExactDescriptor(fd, selected.pin),
          /identity changed/u,
        );
      },
    );
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(appended, true);
  assert.equal(fs.statSync(selected.file).size, selected.pin.bytes + 1);
});
test("SDK bounded descriptor detects actual truncation during reads", (t) => {
  const selected = syntheticPinnedFile(t);
  let truncated = false;
  observeOwnedReads(
    selected.file,
    (_, count) => {
      if (count > 0 && !truncated) {
        truncated = true;
        fs.truncateSync(selected.file, 65536);
      }
    },
    () => {
      assert.throws(
        () => readPinnedFile(selected.file, selected.pin),
        /truncated during bounded read/u,
      );
    },
  );
  assert.equal(truncated, true);
});
test("SDK bounded descriptor checks deadline during actual reads before requesting another chunk", (t) => {
  const selected = syntheticPinnedFile(t);
  let clock = 0;
  const fd = fs.openSync(selected.file, "r");
  try {
    observeOwnedReads(
      selected.file,
      () => {
        clock = 1001;
      },
      (reads) => {
        assert.throws(
          () =>
            readExactDescriptor(fd, {
              bytes: selected.pin.bytes,
              deadline: 1000,
              now: () => clock,
            }),
          /deadline/u,
        );
        assert.equal(reads.length, 1);
        assert.equal(reads[0].actual, 65536);
      },
    );
  } finally {
    fs.closeSync(fd);
  }
});
test("SDK bounded descriptor refuses increased size budgets and expired deadlines before any body read", (t) => {
  const selected = syntheticPinnedFile(t);
  const fd = fs.openSync(selected.file, "r");
  try {
    observeOwnedReads(
      selected.file,
      () => assert.fail("read cannot begin"),
      (reads) => {
        for (const bytes of [-1, 0.5, 67108865, Infinity])
          assert.throws(
            () =>
              readExactDescriptor(fd, {
                bytes,
                deadline: performance.now() + 1000,
              }),
            /bound/u,
          );
        assert.throws(
          () =>
            readExactDescriptor(fd, {
              bytes: selected.pin.bytes,
              deadline: performance.now() - 1,
            }),
          /deadline/u,
        );
        assert.deepEqual(reads, []);
      },
    );
  } finally {
    fs.closeSync(fd);
  }
});
test(
  "SDK collector refuses owned output growth during verification before metadata requests or publication",
  posix,
  async (t) => {
    const root = output(t),
      adapter = fake(fixture().responses),
      original = fs.readSync;
    let appended = false;
    fs.readSync = (fd, buffer, offset, length, position) => {
      const count = original(fd, buffer, offset, length, position);
      const file = path.join(root, "catalog.json");
      if (
        !appended &&
        count > 0 &&
        fs.existsSync(file) &&
        fs.statSync(file).ino === fs.fstatSync(fd).ino
      ) {
        appended = true;
        fs.appendFileSync(file, "G");
      }
      return count;
    };
    try {
      await assert.rejects(
        collectMetadata({
          catalog,
          outputRoot: root,
          transport: adapter.transport,
        }),
        /exceeded expected byte bound/u,
      );
    } finally {
      fs.readSync = original;
    }
    assert.equal(appended, true);
    assert.deepEqual(adapter.calls, []);
    assert.equal(failure(root).state, "incomplete-failed-metadata-preparation");
    assert.equal(
      fs.existsSync(path.join(root, "metadata-manifest.json")),
      false,
    );
  },
);
