// Offline metadata joins only. These modules perform no file/network reads,
// invoke no project or Git code, and never resolve or fetch a declared URL.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  bindGitmoduleUrls,
  gitmodulesLimits,
} from "./emsdk-metadata-gitmodules.mjs";
import {
  digest,
  gitilesJson,
  objectId,
  relativePath,
  treeMetadata,
} from "./emsdk-metadata-values.mjs";

export const nestedGitmoduleLimits = Object.freeze({
  treeResponses: 64,
  treeWireBytes: 1048576,
  totalTreeWireBytes: 16777216,
  treeEntries: 2048,
  totalTreeEntries: 8192,
  pathDepth: 16,
  ancestorPaths: 256,
  jsonDepth: 64,
  jsonNodes: 32768,
});

function treeBuffer(bytes) {
  assert.ok(
    Buffer.isBuffer(bytes) &&
      bytes.length <= nestedGitmoduleLimits.treeWireBytes,
    "Nested metadata tree response byte bound exceeded",
  );
  return Buffer.from(bytes);
}

function directoryEntry(parent, name) {
  const entry = parent.entries.get(name);
  assert.ok(
    entry,
    "Declared directory entry is absent from its admitted parent tree",
  );
  assert.ok(
    entry.type === "tree" && entry.mode === 16384,
    "Declared ancestor is not an exact directory tree entry",
  );
  return entry;
}

export function bindNestedGitmoduleUrls(input) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  assert.deepEqual(Object.keys(input).sort(), [
    "gitmodulesBytes",
    "rootTreeBytes",
    "rootTreeId",
    "treeResponses",
  ]);
  const { gitmodulesBytes, rootTreeBytes, rootTreeId, treeResponses } = input;
  objectId(rootTreeId);
  assert.ok(
    Buffer.isBuffer(gitmodulesBytes) &&
      gitmodulesBytes.length <= gitmodulesLimits.bytes,
    "Nested metadata gitmodules byte bound exceeded",
  );
  assert.ok(
    Array.isArray(treeResponses) &&
      treeResponses.length <= nestedGitmoduleLimits.treeResponses,
    "Nested metadata tree response count bound exceeded",
  );
  const source = Buffer.from(gitmodulesBytes);
  const rootBytes = treeBuffer(rootTreeBytes);
  const rootEntries = treeMetadata(
    gitilesJson(rootBytes, nestedGitmoduleLimits),
    rootTreeId,
    nestedGitmoduleLimits.treeEntries,
  );
  const original = bindGitmoduleUrls(source, rootEntries);
  const ancestors = new Set();
  for (const module of original.moduleUrlBindings.declarations) {
    const parts = module.path.split("/");
    assert.ok(
      parts.length <= nestedGitmoduleLimits.pathDepth,
      "Nested module path depth bound exceeded",
    );
    for (let end = 1; end < parts.length; end++) {
      ancestors.add(parts.slice(0, end).join("/"));
      assert.ok(
        ancestors.size <= nestedGitmoduleLimits.ancestorPaths,
        "Nested module ancestor path bound exceeded",
      );
    }
  }

  let totalWireBytes = rootBytes.length;
  const paths = new Set();
  const supplied = treeResponses
    .map((response) => {
      assert.ok(
        response && typeof response === "object" && !Array.isArray(response),
      );
      assert.deepEqual(Object.keys(response).sort(), ["bytes", "path"]);
      const path = relativePath(response.path);
      assert.ok(
        ancestors.has(path),
        "Foreign or unused tree response is not a proper declared module ancestor",
      );
      assert.ok(!paths.has(path), "Duplicate nested tree response path");
      paths.add(path);
      const bytes = treeBuffer(response.bytes);
      totalWireBytes += bytes.length;
      assert.ok(
        totalWireBytes <= nestedGitmoduleLimits.totalTreeWireBytes,
        "Nested metadata aggregate wire byte bound exceeded",
      );
      return { path, parts: path.split("/"), bytes };
    })
    .sort(
      (a, b) =>
        a.parts.length - b.parts.length ||
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    );

  const admitted = new Map([["", { id: rootTreeId, entries: rootEntries }]]);
  const rootTree = {
    path: "",
    gitTree: rootTreeId,
    wireBytes: rootBytes.length,
    wireSha256: digest(rootBytes),
    entries: rootEntries.size,
    treeBytesVerified: true,
  };
  const trees = [];
  let totalEntries = rootEntries.size;
  for (const response of supplied) {
    const parentPath = response.parts.slice(0, -1).join("/");
    const parent = admitted.get(parentPath);
    assert.ok(
      parent,
      "Disconnected nested tree response has no admitted parent tree",
    );
    const entry = directoryEntry(parent, response.parts.at(-1));
    const entries = treeMetadata(
      gitilesJson(response.bytes, nestedGitmoduleLimits),
      entry.id,
      nestedGitmoduleLimits.treeEntries,
    );
    totalEntries += entries.size;
    assert.ok(
      totalEntries <= nestedGitmoduleLimits.totalTreeEntries,
      "Nested metadata aggregate tree entry bound exceeded",
    );
    admitted.set(response.path, { id: entry.id, entries });
    trees.push({
      path: response.path,
      gitTree: entry.id,
      parentPath,
      parentTree: parent.id,
      wireBytes: response.bytes.length,
      wireSha256: digest(response.bytes),
      entries: entries.size,
      treeBytesVerified: true,
    });
  }

  const used = new Set();
  const declarations = original.moduleUrlBindings.declarations.map((module) => {
    const parts = module.path.split("/");
    let parentPath = "",
      parent = admitted.get("");
    const ancestry = [];
    for (let index = 0; index < parts.length - 1; index++) {
      const entry = directoryEntry(parent, parts[index]);
      const nextPath = parts.slice(0, index + 1).join("/");
      const next = admitted.get(nextPath);
      if (!next)
        return {
          ...module,
          state: "unverified-nested-tree-not-admitted",
          commit: null,
          moduleUrlBindingVerified: false,
          missingTreePath: nextPath,
          expectedTreeId: entry.id,
          ancestry,
        };
      used.add(nextPath);
      ancestry.push({ path: nextPath, gitTree: next.id });
      parentPath = nextPath;
      parent = next;
    }
    const entryName = parts.at(-1);
    const leaf = parent.entries.get(entryName);
    assert.ok(
      leaf,
      "Declared Gitlink leaf is absent from its admitted parent tree",
    );
    assert.ok(
      leaf.type === "commit" && leaf.mode === 57344,
      "Declared leaf is not an exact Gitlink entry",
    );
    return {
      ...module,
      state:
        parts.length === 1
          ? "exact-root-gitlink-bound"
          : "exact-nested-gitlink-bound",
      commit: objectId(leaf.id),
      moduleUrlBindingVerified: true,
      binding: { treePath: parentPath, gitTree: parent.id, entryName },
      ancestry,
    };
  });
  assert.equal(
    used.size,
    supplied.length,
    "Unused admitted nested tree response",
  );
  return {
    schemaVersion: 1,
    scope:
      "Selected .gitmodules declarations joined through recomputed supplied tree chains only; no nested source, notice, raw commit authentication or producer-build qualification.",
    gitmodules: {
      bytes: source.length,
      gitBlob: original.moduleUrlBindings.gitBlob,
      sha256: original.moduleUrlBindings.sha256,
    },
    rootTree,
    trees,
    declarations,
    moduleUrlBindingsComplete:
      declarations.length > 0 &&
      declarations.every((module) => module.moduleUrlBindingVerified),
    totalTreeWireBytes: totalWireBytes,
    totalTreeEntries: totalEntries,
    sourceBodyRetained: false,
    originalNoticesVerified: false,
    rawCommitObjectVerified: false,
    nestedSourceClosureVerified: false,
    networkAcquisitionPerformed: false,
    upstreamCodeExecuted: false,
    producerBuildReproduced: false,
    gateAComplete: false,
  };
}
