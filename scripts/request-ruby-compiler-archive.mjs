import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";

// Operator setup only. Signature verification remains in the offline APK build.
export async function requestRubyCompilerArchive(
  { root, architecture, pin, repository, local },
  { fetchImpl = globalThis.fetch, ...options } = {},
) {
  assert.ok(["aarch64", "x86_64"].includes(architecture));
  assert.match(pin.path, /^[A-Za-z0-9_+.-]+\.apk$/);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(pin.bytes) &&
      pin.bytes > 0 &&
      pin.bytes <= 64 * 1024 * 1024,
  );
  assert.equal(
    repository,
    `https://dl-cdn.alpinelinux.org/alpine/v3.24/main/${architecture}/`,
  );
  let bytes;
  if (local || pin.path === "zlib-1.3.2-r0.apk") {
    const directory =
      local ??
      path.join(root, "assets/native-tool-archives/alpine-v3.24", architecture);
    const file = path.resolve(directory, pin.path),
      before = await lstat(file);
    assert.equal(
      await realpath(file),
      file,
      "Compiler archive must not follow symlinks",
    );
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1 &&
        before.size === pin.bytes,
      "Compiler archive must be a bounded regular file",
    );
    bytes = await readFile(file);
    const after = await lstat(file);
    assert.ok(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      "Compiler archive changed during capture",
    );
  } else {
    bytes = await requestPinnedArtifactBytes(
      {
        asset: repository + encodeURIComponent(pin.path),
        fallbackAssets: [
          "https://dl-4.alpinelinux.org/",
          "https://dl-5.alpinelinux.org/",
        ].map(
          (origin) =>
            repository.replace("https://dl-cdn.alpinelinux.org/", origin) +
            encodeURIComponent(pin.path),
        ),
        bytes: pin.bytes,
      },
      {
        ...options,
        retryNotFound: true,
        fetchImpl: (asset, request) =>
          fetchImpl(asset, { ...request, redirect: "error" }),
      },
    );
  }
  assert.equal(bytes.length, pin.bytes, "Compiler archive byte count differs");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    pin.sha256,
    "Compiler archive digest differs",
  );
  return bytes;
}
