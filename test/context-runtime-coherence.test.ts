import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
const { checkContextRuntimeCoherence } = await import(
  new URL("../../scripts/check-context-runtime-coherence.mjs", import.meta.url)
    .href
);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const runtimeFiles = {
  "web-tree-sitter.js": 'throw new Error("synthetic runtime execution");',
  "web-tree-sitter.wasm": "synthetic invalid WASM bytes",
  LICENSE: "synthetic original runtime notice",
};
async function prepared(
  t: TestContext,
  version = "0.27.1",
  assets: Record<string, string> = runtimeFiles,
) {
  const files = Object.fromEntries(
    Object.entries(assets).map(([name, value]) => [
      name,
      { bytes: Buffer.byteLength(value), sha256: digest(value) },
    ]),
  );
  const grammar = JSON.stringify({
    schemaVersion: 1,
    scope: "synthetic original grammar build",
  });
  const runtime = JSON.stringify({
    schemaVersion: 1,
    package: "web-tree-sitter",
    version,
    grammarBuildManifestSHA256: digest(grammar),
    files,
  });
  return await realpath(
    await fixture(t, {
      "package.json": JSON.stringify({
        dependencies: { "web-tree-sitter": version },
      }),
      "package-lock.json": JSON.stringify({
        packages: {
          "": { dependencies: { "web-tree-sitter": version } },
          "node_modules/web-tree-sitter": { version },
        },
      }),
      "src/review-grammar-assets.ts":
        `export const grammarManifestDigest = ${JSON.stringify(digest(grammar))};\n` +
        `export const grammarRuntimeVersion = ${JSON.stringify(version)};\n` +
        `export const grammarRuntimeManifestDigest = ${JSON.stringify(digest(runtime))};\n` +
        `export const grammarRuntimeAssets = ${JSON.stringify(files)} as const;\n` +
        'throw new Error("synthetic project source execution");\n',
      "assets/context-grammars/manifest.json": grammar,
      "assets/context-grammars/runtime-manifest.json": runtime,
      "node_modules/web-tree-sitter/package.json": JSON.stringify({
        name: "web-tree-sitter",
        version,
      }),
      ...Object.fromEntries(
        Object.entries(assets).map(([name, value]) => [
          "node_modules/web-tree-sitter/" + name,
          value,
        ]),
      ),
    }),
  );
}
const sourceFile = (root: string) =>
  path.join(root, "src/review-grammar-assets.ts");
async function editJson(
  root: string,
  file: string,
  change: (value: Record<string, unknown>) => void,
) {
  const target = path.join(root, file);
  const value = JSON.parse(await readFile(target, "utf8"));
  change(value);
  await writeFile(target, JSON.stringify(value));
}

test("runtime coherence accepts coordinated current and future tuples without executing source runtime JavaScript or invalid WASM", async (t) => {
  for (const version of ["0.27.1", "0.27.2"]) {
    const root = await prepared(t, version);
    assert.deepEqual(await checkContextRuntimeCoherence(root), {
      package: "web-tree-sitter",
      version,
      sourcePinsMatchInstalledBytes: true,
      runtimeCodeExecuted: false,
      wasmCompiled: false,
    });
  }
});

test("runtime coherence rejects a coherent dependency-only bump until selected runtime pins also change", async (t) => {
  const root = await prepared(t);
  await editJson(root, "package.json", (value) => {
    value.dependencies = { "web-tree-sitter": "0.27.2" };
  });
  await editJson(root, "package-lock.json", (value) => {
    value.packages = {
      "": { dependencies: { "web-tree-sitter": "0.27.2" } },
      "node_modules/web-tree-sitter": { version: "0.27.2" },
    };
  });
  await editJson(root, "node_modules/web-tree-sitter/package.json", (value) => {
    value.version = "0.27.2";
  });
  await assert.rejects(
    () => checkContextRuntimeCoherence(root),
    /Package runtime declaration differs from selected source pin/u,
  );
});

for (const variant of [
  "lock",
  "installed-name",
  "installed-version",
  "manifest",
  "hash",
  "missing",
  "missing-pin",
  "dynamic-pin",
] as const)
  test(
    "runtime coherence refuses " + variant + " drift before execution",
    async (t) => {
      const root = await prepared(t);
      if (variant === "lock")
        await editJson(root, "package-lock.json", (value) => {
          value.packages = {
            "": { dependencies: { "web-tree-sitter": "0.27.1" } },
            "node_modules/web-tree-sitter": { version: "0.27.2" },
          };
        });
      if (variant === "installed-name")
        await editJson(
          root,
          "node_modules/web-tree-sitter/package.json",
          (value) => {
            value.name = "synthetic-other-package";
          },
        );
      if (variant === "installed-version")
        await editJson(
          root,
          "node_modules/web-tree-sitter/package.json",
          (value) => {
            value.version = "0.27.2";
          },
        );
      if (variant === "manifest")
        await editJson(
          root,
          "assets/context-grammars/runtime-manifest.json",
          (value) => {
            value.version = "0.27.2";
          },
        );
      if (variant === "hash")
        await writeFile(
          path.join(root, "node_modules/web-tree-sitter/web-tree-sitter.js"),
          runtimeFiles["web-tree-sitter.js"].replace("synthetic", "different"),
        );
      if (variant === "missing")
        await rm(
          path.join(root, "node_modules/web-tree-sitter/web-tree-sitter.wasm"),
        );
      if (variant === "missing-pin" || variant === "dynamic-pin") {
        const source = await readFile(sourceFile(root), "utf8");
        await writeFile(
          sourceFile(root),
          source.replace(
            'export const grammarRuntimeVersion = "0.27.1";',
            variant === "missing-pin"
              ? '// export const grammarRuntimeVersion = "0.27.1";'
              : 'export const grammarRuntimeVersion = (() => "0.27.1")();',
          ),
        );
      }
      await assert.rejects(() => checkContextRuntimeCoherence(root), {
        code: "ERR_ASSERTION",
      });
    },
  );

test("runtime coherence rejects additional runtime paths even when their hashes and source manifests agree", async (t) => {
  const root = await prepared(t, "0.27.1", {
    ...runtimeFiles,
    "../outside": "synthetic outside bytes",
  });
  await assert.rejects(() => checkContextRuntimeCoherence(root), {
    code: "ERR_ASSERTION",
  });
});

for (const kind of ["file", "directory"] as const)
  test(
    "runtime coherence refuses " + kind + " symlinks to matching bytes",
    { skip: process.platform === "win32" ? "POSIX symlink fixture" : false },
    async (t) => {
      const root = await prepared(t);
      const outside = await realpath(
        await fixture(t, { placeholder: "synthetic" }),
      );
      const relative =
        kind === "file"
          ? "node_modules/web-tree-sitter/web-tree-sitter.js"
          : "node_modules/web-tree-sitter";
      const current = path.join(root, relative);
      const target = path.join(outside, kind);
      await cp(current, target, { recursive: kind === "directory" });
      await rm(current, { recursive: kind === "directory" });
      await symlink(target, current);
      await assert.rejects(
        () => checkContextRuntimeCoherence(root),
        /cannot use symbolic links/u,
      );
    },
  );

test("runtime coherence CLI rejects version drift with a coordinated-upgrade instruction before emitting success", async (t) => {
  const root = await prepared(t);
  await mkdir(path.join(root, "scripts"));
  const command = path.join(
    root,
    "scripts/check-context-runtime-coherence.mjs",
  );
  await cp(
    new URL(
      "../../scripts/check-context-runtime-coherence.mjs",
      import.meta.url,
    ),
    command,
  );
  await symlink(
    await realpath(
      fileURLToPath(new URL("../../node_modules/typescript", import.meta.url)),
    ),
    path.join(root, "node_modules/typescript"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await editJson(root, "package.json", (value) => {
    value.dependencies = { "web-tree-sitter": "0.27.2" };
  });
  const result = spawnSync(process.execPath, [command], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Context runtime coherence failed: Package runtime declaration differs from selected source pin/u,
  );
  assert.match(
    result.stderr,
    /Upgrade web-tree-sitter through a coordinated change/u,
  );
  assert.match(
    result.stderr,
    /a version-only dependency bump cannot qualify this runtime/u,
  );
});

test("runtime coherence rejects an oversized sparse input before parsing or hashing it", async (t) => {
  const root = await prepared(t);
  await truncate(path.join(root, "package-lock.json"), 8 * 1024 * 1024 + 1);
  await assert.rejects(
    () => checkContextRuntimeCoherence(root),
    /Coherence input exceeds 8388608-byte limit: package-lock\.json/u,
  );
});
