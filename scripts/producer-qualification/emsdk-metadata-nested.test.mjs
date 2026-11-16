import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import {
  bindNestedGitmoduleUrls,
  nestedGitmoduleLimits,
} from "./emsdk-metadata-nested.mjs";
import { digest, gitObject } from "./emsdk-metadata-values.mjs";

const wire = (value) => Buffer.from(")]}'\n" + JSON.stringify(value));
const blob = (name, id = "b".repeat(40)) => ({
  name,
  id,
  type: "blob",
  mode: 33188,
});
const link = (name, id) => ({ name, id, type: "commit", mode: 57344 });
const directory = (name, id) => ({ name, id, type: "tree", mode: 16384 });
function tree(entries) {
  const ordered = [...entries].sort((a, b) =>
    Buffer.compare(
      Buffer.from(a.name + (a.type === "tree" ? "/" : "")),
      Buffer.from(b.name + (b.type === "tree" ? "/" : "")),
    ),
  );
  const raw = Buffer.concat(
    ordered.map((entry) =>
      Buffer.concat([
        Buffer.from(entry.mode.toString(8) + " " + entry.name + "\0"),
        Buffer.from(entry.id, "hex"),
      ]),
    ),
  );
  const id = gitObject("tree", raw);
  return { id, entries, bytes: wire({ id, entries }) };
}
const declaration = (path, name = path) =>
  `[submodule "${name}"]\npath = ${path}\nurl = https://sdk.example.test/${path}.git\n`;
const settings = 'branch = "$(must-stay-inert)"\nupdate = !never-run\n';
function forest({ mixed = false, mutate = (_path, entries) => entries } = {}) {
  const source = Buffer.from(
    declaration("deps/alpha", "Custom Alpha") +
      settings +
      declaration("deps/beta") +
      declaration("deps/gamma") +
      declaration("checks/native/suite") +
      (mixed ? declaration("direct") : ""),
  );
  const native = tree(
    mutate("checks/native", [
      link("suite", "4".repeat(40)),
      blob("suite-more"),
    ]),
  );
  const checks = tree(
    mutate("checks", [directory("native", native.id), blob("native-more")]),
  );
  const deps = tree(
    mutate("deps", [
      link("alpha", "1".repeat(40)),
      link("beta", "2".repeat(40)),
      link("gamma", "3".repeat(40)),
      blob("alpha-more"),
    ]),
  );
  const root = tree(
    mutate("", [
      blob(".gitmodules", gitObject("blob", source)),
      directory("deps", deps.id),
      directory("checks", checks.id),
      ...(mixed ? [link("direct", "5".repeat(40))] : []),
    ]),
  );
  return {
    source,
    root,
    deps,
    checks,
    native,
    input: {
      gitmodulesBytes: source,
      rootTreeBytes: root.bytes,
      rootTreeId: root.id,
      // Deliberately supply the deepest tree first. Evidence order is irrelevant.
      treeResponses: [
        { path: "checks/native", bytes: native.bytes },
        { path: "deps", bytes: deps.bytes },
        { path: "checks", bytes: checks.bytes },
      ],
    },
  };
}
function rootInput(source, entries, treeResponses = []) {
  const root = tree([
    blob(".gitmodules", gitObject("blob", source)),
    ...entries,
  ]);
  return {
    gitmodulesBytes: source,
    rootTreeBytes: root.bytes,
    rootTreeId: root.id,
    treeResponses,
  };
}
const noClosure = (receipt) => {
  for (const key of [
    "sourceBodyRetained",
    "originalNoticesVerified",
    "rawCommitObjectVerified",
    "nestedSourceClosureVerified",
    "networkAcquisitionPerformed",
    "upstreamCodeExecuted",
    "producerBuildReproduced",
    "gateAComplete",
  ])
    assert.equal(receipt[key], false, key);
  for (const module of receipt.declarations)
    assert.equal(module.sourceBodyRetained, false);
};

test("SDK nested metadata binds a synthetic three-tree forest to exact leaf commits with original metadata hashes", () => {
  const original = forest();
  const result = bindNestedGitmoduleUrls(original.input);
  assert.equal(result.moduleUrlBindingsComplete, true);
  assert.deepEqual(
    result.declarations.map((module) => [
      module.path,
      module.commit,
      module.state,
    ]),
    [
      ["deps/alpha", "1".repeat(40), "exact-nested-gitlink-bound"],
      ["deps/beta", "2".repeat(40), "exact-nested-gitlink-bound"],
      ["deps/gamma", "3".repeat(40), "exact-nested-gitlink-bound"],
      ["checks/native/suite", "4".repeat(40), "exact-nested-gitlink-bound"],
    ],
  );
  assert.equal(result.declarations[0].name, "Custom Alpha");
  assert.equal(
    result.declarations[0].url,
    "https://sdk.example.test/deps/alpha.git",
  );
  assert.deepEqual(result.declarations[0].uninterpretedSettings, [
    { key: "branch", value: "$(must-stay-inert)" },
    { key: "update", value: "!never-run" },
  ]);
  assert.deepEqual(result.gitmodules, {
    bytes: original.source.length,
    sha256: digest(original.source),
    gitBlob: gitObject("blob", original.source),
  });
  assert.deepEqual(result.rootTree, {
    path: "",
    gitTree: original.root.id,
    wireBytes: original.root.bytes.length,
    wireSha256: digest(original.root.bytes),
    entries: original.root.entries.length,
    treeBytesVerified: true,
  });
  assert.deepEqual(
    result.trees,
    [
      ["checks", original.checks, "", original.root.id],
      ["deps", original.deps, "", original.root.id],
      ["checks/native", original.native, "checks", original.checks.id],
    ].map(([path, record, parentPath, parentTree]) => ({
      path,
      gitTree: record.id,
      parentPath,
      parentTree,
      wireBytes: record.bytes.length,
      wireSha256: digest(record.bytes),
      entries: record.entries.length,
      treeBytesVerified: true,
    })),
  );
  assert.deepEqual(result.declarations[3].binding, {
    treePath: "checks/native",
    gitTree: original.native.id,
    entryName: "suite",
  });
  assert.deepEqual(result.declarations[3].ancestry, [
    { path: "checks", gitTree: original.checks.id },
    { path: "checks/native", gitTree: original.native.id },
  ]);
  assert.equal(
    result.totalTreeEntries,
    original.root.entries.length +
      original.checks.entries.length +
      original.deps.entries.length +
      original.native.entries.length,
  );
  assert.equal(
    result.totalTreeWireBytes,
    original.root.bytes.length +
      original.checks.bytes.length +
      original.deps.bytes.length +
      original.native.bytes.length,
  );
  noClosure(result);
});

test("SDK nested metadata accepts unordered responses mixed root links and exact prefix near misses", () => {
  const { input } = forest({ mixed: true });
  const expected = bindNestedGitmoduleUrls(input);
  for (const treeResponses of [
    [...input.treeResponses].reverse(),
    [input.treeResponses[1], input.treeResponses[0], input.treeResponses[2]],
  ])
    assert.deepEqual(
      bindNestedGitmoduleUrls({ ...input, treeResponses }),
      expected,
    );
  const direct = expected.declarations.at(-1);
  assert.equal(direct.state, "exact-root-gitlink-bound");
  assert.equal(direct.commit, "5".repeat(40));
  assert.deepEqual(direct.binding, {
    treePath: "",
    gitTree: input.rootTreeId,
    entryName: "direct",
  });
  assert.deepEqual(direct.ancestry, []);
  assert.equal(expected.declarations[0].binding.entryName, "alpha");
  assert.equal(expected.declarations[3].binding.entryName, "suite");
  assert.equal(expected.moduleUrlBindingsComplete, true);
  noClosure(expected);
});

test("SDK missing ancestor responses retain known exact bindings and explicit unknown commits without borrowing tree IDs", () => {
  const original = forest({ mixed: true });
  for (const reached of [[], ["deps"], ["deps", "checks"]]) {
    const result = bindNestedGitmoduleUrls({
      ...original.input,
      treeResponses: original.input.treeResponses.filter((response) =>
        reached.includes(response.path),
      ),
    });
    assert.equal(result.moduleUrlBindingsComplete, false);
    const pending = result.declarations[3];
    assert.equal(pending.commit, null);
    assert.equal(pending.moduleUrlBindingVerified, false);
    assert.equal(pending.state, "unverified-nested-tree-not-admitted");
    assert.equal(
      pending.missingTreePath,
      reached.includes("checks") ? "checks/native" : "checks",
    );
    assert.equal(
      pending.expectedTreeId,
      reached.includes("checks") ? original.native.id : original.checks.id,
    );
    assert.notEqual(pending.commit, pending.expectedTreeId);
    assert.deepEqual(
      pending.ancestry,
      reached.includes("checks")
        ? [{ path: "checks", gitTree: original.checks.id }]
        : [],
    );
    assert.equal(
      result.declarations[0].moduleUrlBindingVerified,
      reached.includes("deps"),
    );
    assert.equal(result.declarations.at(-1).commit, "5".repeat(40));
    noClosure(result);
  }
});

test("SDK empty declarations cannot qualify and root-only metadata stays scoped to URL bindings", () => {
  const empty = bindNestedGitmoduleUrls(
    rootInput(Buffer.from("# deliberately empty declarations\n"), []),
  );
  assert.deepEqual(empty.declarations, []);
  assert.deepEqual(empty.trees, []);
  assert.equal(empty.moduleUrlBindingsComplete, false);
  noClosure(empty);
  const source = Buffer.from(declaration("single"));
  const single = bindNestedGitmoduleUrls(
    rootInput(source, [link("single", "a".repeat(40))]),
  );
  assert.equal(single.moduleUrlBindingsComplete, true);
  assert.equal(single.declarations[0].commit, "a".repeat(40));
  assert.deepEqual(single.trees, []);
  noClosure(single);
});

test("SDK nested metadata refuses duplicate foreign unused disconnected and noncanonical response paths", () => {
  const { input, deps } = forest();
  assert.throws(
    () =>
      bindNestedGitmoduleUrls({
        ...input,
        treeResponses: [...input.treeResponses, input.treeResponses[0]],
      }),
    /Duplicate nested tree response path/u,
  );
  assert.throws(
    () =>
      bindNestedGitmoduleUrls({
        ...input,
        treeResponses: input.treeResponses.filter(
          (response) => response.path !== "checks",
        ),
      }),
    /Disconnected nested tree response/u,
  );
  for (const path of [
    "deps-more",
    "dep",
    "Deps",
    "deps/alpha",
    "checks/native/suite",
    "checks/native/suite/foreign",
    "checks/nativ",
    "unrelated",
  ]) {
    assert.throws(
      () =>
        bindNestedGitmoduleUrls({
          ...input,
          treeResponses: [{ path, bytes: deps.bytes }],
        }),
      /Foreign or unused tree response/u,
      path,
    );
  }
  for (const path of [
    "",
    ".",
    "../deps",
    "/deps",
    "deps/",
    "deps//inner",
    "deps/../checks",
    "checks/./native",
    "deps\\inner",
    "deps%2finner",
    "$(command)",
  ])
    assert.throws(
      () =>
        bindNestedGitmoduleUrls({
          ...input,
          treeResponses: [{ path, bytes: deps.bytes }],
        }),
      path,
    );
  assert.throws(() => bindNestedGitmoduleUrls({ ...input, extra: true }));
  assert.throws(() =>
    bindNestedGitmoduleUrls({
      ...input,
      treeResponses: [{ path: "deps", bytes: deps.bytes, unused: true }],
    }),
  );
});

test("SDK nested metadata independently recomputes root and child Git object IDs and rejects stale or swapped trees", () => {
  const { input, deps, checks } = forest();
  assert.throws(
    () => bindNestedGitmoduleUrls({ ...input, rootTreeId: "f".repeat(40) }),
    /Wrong Git tree/u,
  );
  const rootValue = JSON.parse(
    input.rootTreeBytes.subarray(5).toString("utf8"),
  );
  rootValue.entries.find((entry) => entry.name === "deps").id = "f".repeat(40);
  assert.throws(
    () => bindNestedGitmoduleUrls({ ...input, rootTreeBytes: wire(rootValue) }),
    /Git tree bytes mismatch/u,
  );
  const changedChild = JSON.parse(deps.bytes.subarray(5).toString("utf8"));
  changedChild.entries[0].id = "f".repeat(40);
  assert.throws(
    () =>
      bindNestedGitmoduleUrls({
        ...input,
        treeResponses: input.treeResponses.map((response) =>
          response.path === "deps"
            ? { ...response, bytes: wire(changedChild) }
            : response,
        ),
      }),
    /Git tree bytes mismatch/u,
  );
  assert.throws(
    () =>
      bindNestedGitmoduleUrls({
        ...input,
        treeResponses: input.treeResponses.map((response) =>
          response.path === "deps"
            ? { ...response, bytes: checks.bytes }
            : response,
        ),
      }),
    /Wrong Git tree/u,
  );
  assert.throws(
    () =>
      bindNestedGitmoduleUrls({
        ...input,
        gitmodulesBytes: Buffer.from(
          input.gitmodulesBytes
            .toString()
            .replace("Custom Alpha", "Changed Alpha"),
        ),
      }),
    /Git blob mismatch/u,
  );
});

test("SDK admitted nested parents reject absent and wrong-type leaves instead of reporting unknown metadata", () => {
  for (const type of ["blob", "tree", "symlink", "missing"]) {
    const original = forest({
      mutate: (path, entries) =>
        path !== "checks/native"
          ? entries
          : entries.flatMap((entry) =>
              entry.name !== "suite"
                ? [entry]
                : type === "missing"
                  ? []
                  : [
                      {
                        ...entry,
                        type: type === "tree" ? "tree" : "blob",
                        mode:
                          type === "tree"
                            ? 16384
                            : type === "symlink"
                              ? 40960
                              : 33188,
                      },
                    ],
            ),
    });
    assert.throws(
      () => bindNestedGitmoduleUrls(original.input),
      type === "missing"
        ? /Gitlink leaf is absent/u
        : /not an exact Gitlink entry/u,
      type,
    );
  }
  const renamed = forest({
    mutate: (path, entries) =>
      path === "checks/native"
        ? entries.map((entry) =>
            entry.name === "suite" ? { ...entry, name: "suite-extra" } : entry,
          )
        : entries,
  });
  assert.throws(
    () => bindNestedGitmoduleUrls(renamed.input),
    /Gitlink leaf is absent/u,
  );
});

test("SDK known directory mismatches reject while genuinely absent intermediate responses remain unverified", () => {
  for (const kind of ["missing", "blob", "symlink", "gitlink"]) {
    const original = forest({
      mutate: (path, entries) =>
        path !== "checks"
          ? entries
          : entries.flatMap((entry) =>
              entry.name !== "native"
                ? [entry]
                : kind === "missing"
                  ? []
                  : [
                      {
                        ...entry,
                        type: kind === "gitlink" ? "commit" : "blob",
                        mode:
                          kind === "gitlink"
                            ? 57344
                            : kind === "symlink"
                              ? 40960
                              : 33188,
                      },
                    ],
            ),
    });
    const partial = {
      ...original.input,
      treeResponses: original.input.treeResponses.filter(
        (response) => response.path !== "checks/native",
      ),
    };
    assert.throws(
      () => bindNestedGitmoduleUrls(partial),
      kind === "missing"
        ? /directory entry is absent/u
        : /not an exact directory tree entry/u,
      kind,
    );
  }
  const valid = forest();
  const partial = bindNestedGitmoduleUrls({
    ...valid.input,
    treeResponses: valid.input.treeResponses.filter(
      (response) => response.path !== "checks/native",
    ),
  });
  assert.equal(partial.declarations[3].missingTreePath, "checks/native");
  assert.equal(partial.declarations[3].commit, null);
});

test("SDK nested metadata retains strict prefixed JSON UTF-8 duplicate-key node depth and mode validation", () => {
  const { input } = forest();
  const prefix = ")]}'\n";
  for (const bytes of [
    Buffer.from("{}"),
    Buffer.from(prefix + '{"id":"a","id":"b"}'),
    Buffer.from([...Buffer.from(prefix), 0xff]),
    Buffer.from(
      prefix +
        "[".repeat(nestedGitmoduleLimits.jsonDepth + 1) +
        "0" +
        "]".repeat(nestedGitmoduleLimits.jsonDepth + 1),
    ),
    Buffer.from(
      prefix +
        "[" +
        Array(nestedGitmoduleLimits.jsonNodes).fill("0").join(",") +
        "]",
    ),
  ]) {
    assert.throws(() =>
      bindNestedGitmoduleUrls({ ...input, rootTreeBytes: bytes }),
    );
    assert.throws(() =>
      bindNestedGitmoduleUrls({
        ...input,
        treeResponses: input.treeResponses.map((response) =>
          response.path === "deps" ? { ...response, bytes } : response,
        ),
      }),
    );
  }
  const invalid = JSON.parse(input.rootTreeBytes.subarray(5).toString());
  invalid.entries.find((entry) => entry.name === "deps").mode = 57344;
  assert.throws(
    () => bindNestedGitmoduleUrls({ ...input, rootTreeBytes: wire(invalid) }),
    /Git mode\/type mismatch/u,
  );
});

function wide(count, entriesPerTree = 1) {
  const source = Buffer.from(
    Array.from({ length: count }, (_, index) =>
      declaration("d" + index + "/leaf"),
    ).join(""),
  );
  const child = tree([
    link("leaf", "a".repeat(40)),
    ...Array.from({ length: entriesPerTree - 1 }, (_, index) =>
      blob("padding" + index),
    ),
  ]);
  const children = Array.from({ length: count }, (_, index) => ({
    path: "d" + index,
    bytes: child.bytes,
  }));
  return rootInput(
    source,
    children.map(({ path }) => directory(path, child.id)),
    children,
  );
}

test("SDK nested metadata bounds response count byte size path depth and ancestor growth with valid boundary near misses", () => {
  assert.throws(
    () =>
      bindNestedGitmoduleUrls(wide(nestedGitmoduleLimits.treeResponses + 1)),
    /tree response count bound/u,
  );
  const accepted = bindNestedGitmoduleUrls(
    wide(nestedGitmoduleLimits.treeResponses),
  );
  assert.equal(accepted.moduleUrlBindingsComplete, true);
  assert.equal(accepted.trees.length, nestedGitmoduleLimits.treeResponses);
  const { input } = forest();
  assert.throws(
    () =>
      bindNestedGitmoduleUrls({
        ...input,
        rootTreeBytes: Buffer.alloc(nestedGitmoduleLimits.treeWireBytes + 1),
      }),
    /tree response byte bound/u,
  );
  assert.throws(
    () =>
      bindNestedGitmoduleUrls({
        ...input,
        treeResponses: [
          {
            path: "deps",
            bytes: Buffer.alloc(nestedGitmoduleLimits.treeWireBytes + 1),
          },
        ],
      }),
    /tree response byte bound/u,
  );
  for (const depth of [
    nestedGitmoduleLimits.pathDepth,
    nestedGitmoduleLimits.pathDepth + 1,
  ]) {
    const path = Array(depth).fill("a").join("/");
    const deep = rootInput(Buffer.from(declaration(path)), [
      directory("a", "a".repeat(40)),
    ]);
    if (depth > nestedGitmoduleLimits.pathDepth)
      assert.throws(() => bindNestedGitmoduleUrls(deep), /path depth bound/u);
    else
      assert.equal(bindNestedGitmoduleUrls(deep).declarations[0].commit, null);
  }
  for (const count of [
    nestedGitmoduleLimits.ancestorPaths,
    nestedGitmoduleLimits.ancestorPaths + 1,
  ]) {
    const input = wide(count);
    input.treeResponses = [];
    if (count > nestedGitmoduleLimits.ancestorPaths)
      assert.throws(
        () => bindNestedGitmoduleUrls(input),
        /ancestor path bound/u,
      );
    else
      assert.equal(
        bindNestedGitmoduleUrls(input).declarations.length,
        nestedGitmoduleLimits.ancestorPaths,
      );
  }
});

test("SDK nested metadata bounds aggregate wire bytes including root evidence", () => {
  const padded = (bytes) =>
    Buffer.concat([
      bytes,
      Buffer.alloc(nestedGitmoduleLimits.treeWireBytes - bytes.length, 32),
    ]);
  for (const count of [15, 16]) {
    const input = wide(count);
    input.rootTreeBytes = padded(input.rootTreeBytes);
    input.treeResponses = input.treeResponses.map((response) => ({
      ...response,
      bytes: padded(response.bytes),
    }));
    if (count === 16)
      assert.throws(
        () => bindNestedGitmoduleUrls(input),
        /aggregate wire byte bound/u,
      );
    else {
      const result = bindNestedGitmoduleUrls(input);
      assert.equal(
        result.totalTreeWireBytes,
        nestedGitmoduleLimits.totalTreeWireBytes,
      );
      assert.equal(result.moduleUrlBindingsComplete, true);
    }
  }
});

test("SDK nested metadata bounds every physical tree and aggregate admitted entries", () => {
  assert.throws(
    () =>
      bindNestedGitmoduleUrls(wide(1, nestedGitmoduleLimits.treeEntries + 1)),
    /value.entries.length/u,
  );
  const source = Buffer.from(
    Array.from({ length: 4 }, (_, index) =>
      declaration("d" + index + "/leaf"),
    ).join(""),
  );
  for (const lastCount of [2043, 2044]) {
    const children = Array.from({ length: 4 }, (_, index) =>
      tree([
        link("leaf", "a".repeat(40)),
        ...Array.from(
          {
            length:
              (index === 3 ? lastCount : nestedGitmoduleLimits.treeEntries) - 1,
          },
          (_, index) => blob("padding" + index),
        ),
      ]),
    );
    const responses = children.map((child, index) => ({
      path: "d" + index,
      bytes: child.bytes,
    }));
    const input = rootInput(
      source,
      children.map((child, index) => directory("d" + index, child.id)),
      responses,
    );
    if (lastCount === 2044)
      assert.throws(
        () => bindNestedGitmoduleUrls(input),
        /aggregate tree entry bound/u,
      );
    else {
      const result = bindNestedGitmoduleUrls(input);
      assert.equal(
        result.totalTreeEntries,
        nestedGitmoduleLimits.totalTreeEntries,
      );
      assert.equal(result.moduleUrlBindingsComplete, true);
    }
  }
});
