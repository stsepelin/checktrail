import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import {
  requestPinnedArtifactBytes,
  PinnedArtifactHttpError,
} from "./request-pinned-artifact.mjs";

const repositories = [
  "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/",
  "https://dl-cdn.alpinelinux.org/alpine/v3.24/community/aarch64/",
];
const retainedArchives = [
  {
    path: "zlib-1.3.2-r0.apk",
    url: new URL(
      "../scripts/cpp-archive-fallbacks/zlib-1.3.2-r0.apk",
      import.meta.url,
    ),
    bytes: 54312,
    sha256: "a535991af7c9e8369ebbf33c1e388c1bc63c87ead5142eddaee71f65836c33e3",
  },
  {
    path: "libexpat-2.8.5-r0.apk",
    url: new URL(
      "../scripts/cpp-archive-fallbacks/libexpat-2.8.5-r0.apk",
      import.meta.url,
    ),
    bytes: 60926,
    sha256: "568a12a4889a00711d1c80c197a5540ee1cdec26c1c59da38f8342ad69e7eff9",
  },
];

// Operator acquisition only. The offline image build still verifies APK signatures.
export async function requestCppToolArchive(
  pin,
  declaredRepositories,
  {
    fetchImpl = globalThis.fetch,
    readFallbackImpl = readFile,
    signal = globalThis.AbortSignal.timeout(120000),
    ...options
  } = {},
) {
  assert.deepEqual(declaredRepositories, repositories);
  assert.match(pin.path, /^[A-Za-z0-9_+.-]+\.apk$/);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(pin.bytes) &&
      pin.bytes > 0 &&
      pin.bytes <= 64 * 1024 * 1024,
  );
  for (const repository of repositories) {
    let lastStatus, asset;
    let bytes;
    try {
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
          signal,
          retryNotFound: true,
          fetchImpl: async (url, request) => {
            asset = url;
            lastStatus = undefined;
            const response = await fetchImpl(url, {
              ...request,
              redirect: "error",
            });
            lastStatus = response.status;
            return response;
          },
        },
      );
    } catch (error) {
      signal.throwIfAborted();
      // Only the helper's terminal HTTP 404 moves to the other declared repository.
      // Integrity, byte limits, cancellation and permanent failures never do.
      if (
        lastStatus === 404 &&
        error instanceof PinnedArtifactHttpError &&
        error.status === 404
      )
        continue;
      throw error;
    }
    assert.equal(bytes.length, pin.bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      pin.sha256,
      "C++ archive digest differs",
    );
    return { bytes, asset };
  }
  // A transient mirror/cache miss can affect all six delivery URLs. Recheck
  // the original main URL only after those terminal 404s; no version or pin
  // changes. The shared deadline bounds these three final primary attempts.
  try {
    const asset = repositories[0] + encodeURIComponent(pin.path);
    const bytes = await requestPinnedArtifactBytes(
      { asset, bytes: pin.bytes },
      {
        ...options,
        signal,
        retryNotFound: true,
        fetchImpl: (url, request) =>
          fetchImpl(url, { ...request, redirect: "error" }),
      },
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      pin.sha256,
      "C++ archive digest differs",
    );
    return { bytes, asset };
  } catch (error) {
    signal.throwIfAborted();
    const retained = retainedArchives.find(
      (candidate) =>
        pin.path === candidate.path &&
        pin.bytes === candidate.bytes &&
        pin.sha256 === candidate.sha256,
    );
    if (
      error instanceof PinnedArtifactHttpError &&
      error.status === 404 &&
      retained
    ) {
      // Only these exact signed archives can survive terminal mirror misses.
      const bytes = await readFallbackImpl(retained.url);
      signal.throwIfAborted();
      assert.equal(
        bytes.length,
        pin.bytes,
        "C++ fallback archive size differs",
      );
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        pin.sha256,
        "C++ fallback archive digest differs",
      );
      return { bytes, asset: "repository-pinned-archive" };
    }
    throw new Error("Pinned archive unavailable: " + pin.path, {
      cause: error,
    });
  }
}
