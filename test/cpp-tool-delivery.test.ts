import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
const { requestCppToolArchive } = await import(
  fileURLToPath(
    new URL("../../scripts/request-cpp-tool-archive.mjs", import.meta.url),
  )
);
const repositories = [
  "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/",
  "https://dl-cdn.alpinelinux.org/alpine/v3.24/community/aarch64/",
];
const body = Buffer.from("original synthetic signed-archive stand-in"),
  pin = {
    path: "original-cpp-fixture-1.0-r0.apk",
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };

test("C++ archive acquisition recovers an exact primary 404 through bounded pinned mirrors and preserves bytes and request limits", async () => {
  const calls: { url: string; request: RequestInit }[] = [],
    waits: number[] = [],
    signal = AbortSignal.timeout(1000);
  const result = await requestCppToolArchive(pin, repositories, {
    signal,
    delayImpl: async (ms: number) => {
      waits.push(ms);
    },
    fetchImpl: async (url: string, request: RequestInit) => {
      calls.push({ url, request });
      return new Response(calls.length < 3 ? null : body, {
        status: calls.length < 3 ? 404 : 200,
      });
    },
  });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      repositories[0] + pin.path,
      repositories[0]!.replace("dl-cdn", "dl-4") + pin.path,
      repositories[0]!.replace(
        "https://dl-cdn.alpinelinux.org/",
        "https://mirrors.huaweicloud.com/",
      ) + pin.path,
    ],
  );
  assert.deepEqual(waits, [1000, 3000]);
  assert.deepEqual(result.bytes, body);
  assert.equal(result.asset, calls[2]!.url);
  assert.ok(
    calls.every(
      (c) => c.request.signal === signal && c.request.redirect === "error",
    ),
  );
});

test("C++ archive acquisition tries community only after all three exact main repository 404 responses and keeps a shared deadline", async () => {
  const calls: string[] = [],
    waits: number[] = [],
    signal = AbortSignal.timeout(1000);
  const result = await requestCppToolArchive(pin, repositories, {
    signal,
    delayImpl: async (ms: number) => {
      waits.push(ms);
    },
    fetchImpl: async (url: string, request: RequestInit) => {
      assert.equal(request.signal, signal);
      calls.push(url);
      return new Response(calls.length < 4 ? null : body, {
        status: calls.length < 4 ? 404 : 200,
      });
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(result.asset, repositories[1] + pin.path);
  assert.deepEqual(waits, [1000, 3000]);
  assert.deepEqual(result.bytes, body);
  const missing: string[] = [];
  await assert.rejects(
    requestCppToolArchive(pin, repositories, {
      delayImpl: async () => {},
      fetchImpl: async (url: string) => {
        missing.push(url);
        return new Response(null, { status: 404 });
      },
    }),
    /Pinned archive unavailable/,
  );
  assert.equal(missing.length, 9);
  assert.equal(new Set(missing).size, 6);
});

test("C++ archive acquisition refuses incorrect complete short overlong redirected and permanent responses without repository fallback", async () => {
  for (const variant of [
    "hash",
    "short",
    "overlong",
    "redirect",
    "unauthorized",
    "forbidden",
    "not-found-message",
  ] as const) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (variant === "not-found-message")
        throw new Error("Pinned artifact HTTP 404");
      if (variant === "redirect") return new Response(null, { status: 302 });
      if (variant === "unauthorized")
        return new Response(null, { status: 401 });
      if (variant === "forbidden") return new Response(null, { status: 403 });
      return new Response(
        variant === "hash"
          ? Buffer.alloc(body.length)
          : variant === "short"
            ? body.subarray(1)
            : Buffer.concat([body, Buffer.from("x")]),
      );
    };
    await assert.rejects(
      requestCppToolArchive(pin, repositories, {
        delayImpl: async () => {},
        fetchImpl,
      }),
    );
    assert.equal(calls, 1, variant);
  }
});

test("C++ archive acquisition preserves cancellation across retries and rejects adjacent repository identities and unsafe basenames before network", async () => {
  const controller = new AbortController(),
    calls: string[] = [];
  await assert.rejects(
    requestCppToolArchive(pin, repositories, {
      signal: controller.signal,
      delayImpl: async () => {
        controller.abort();
      },
      fetchImpl: async (url: string) => {
        calls.push(url);
        return new Response(null, { status: 404 });
      },
    }),
  );
  assert.equal(calls.length, 1);
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return new Response(body);
  };
  for (const wrong of [
    [...repositories].reverse(),
    [repositories[0] + "backup", repositories[1]],
    repositories.map((r) => r.replace("v3.24", "v3.25")),
    repositories.map((r) => r.replace("aarch64", "x86_64")),
  ])
    await assert.rejects(requestCppToolArchive(pin, wrong, { fetchImpl }));
  for (const name of [
    "../original.apk",
    "original.apk?token=x",
    "original.apk#fragment",
    "original.apk.backup",
  ])
    await assert.rejects(
      requestCppToolArchive({ ...pin, path: name }, repositories, {
        fetchImpl,
      }),
    );
  assert.equal(count, 0);
});

test("C++ archive acquisition rechecks only the original main URL after six terminal mirror 404s and retains exact integrity", async () => {
  const calls: string[] = [],
    waits: number[] = [];
  const result = await requestCppToolArchive(pin, repositories, {
    delayImpl: async (ms: number) => {
      waits.push(ms);
    },
    fetchImpl: async (url: string) => {
      calls.push(url);
      return new Response(calls.length < 7 ? null : body, {
        status: calls.length < 7 ? 404 : 200,
      });
    },
  });
  assert.equal(calls.length, 7);
  assert.equal(calls[6], calls[0]);
  assert.deepEqual(waits, [1000, 3000, 1000, 3000]);
  assert.deepEqual(result.bytes, body);
  assert.equal(result.asset, repositories[0] + pin.path);
  for (const variant of ["hash", "short", "redirect", "forbidden"]) {
    let count = 0;
    await assert.rejects(
      requestCppToolArchive(pin, repositories, {
        delayImpl: async () => {},
        fetchImpl: async () => {
          count++;
          return count <= 6
            ? new Response(null, { status: 404 })
            : variant === "redirect"
              ? new Response(null, { status: 302 })
              : variant === "forbidden"
                ? new Response(null, { status: 403 })
                : new Response(
                    variant === "short"
                      ? body.subarray(1)
                      : Buffer.alloc(body.length),
                  );
        },
      }),
    );
    assert.equal(count, 7, variant);
  }
});

const retiredZlib = {
  path: "zlib-1.3.2-r0.apk",
  bytes: 54312,
  sha256: "a535991af7c9e8369ebbf33c1e388c1bc63c87ead5142eddaee71f65836c33e3",
};
const retainedExpat = {
  path: "libexpat-2.8.5-r0.apk",
  bytes: 60926,
  sha256: "568a12a4889a00711d1c80c197a5540ee1cdec26c1c59da38f8342ad69e7eff9",
};
for (const retired of [retiredZlib, retainedExpat]) {
  test(`C++ acquisition preserves exact signed ${retired.path} after bounded terminal 404s`, async () => {
    let calls = 0;
    const result = await requestCppToolArchive(retired, repositories, {
      delayImpl: async () => {},
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
    });
    assert.equal(calls, 9);
    assert.equal(result.asset, "repository-pinned-archive");
    assert.equal(result.bytes.length, retired.bytes);
    assert.equal(
      createHash("sha256").update(result.bytes).digest("hex"),
      retired.sha256,
    );
  });
  test(`C++ ${retired.path} fallback rejects corrupt bytes and adjacent pin identities`, async () => {
    for (const bytes of [
      Buffer.alloc(retired.bytes),
      Buffer.alloc(retired.bytes - 1),
      Buffer.alloc(retired.bytes + 1),
    ]) {
      let reads = 0;
      await assert.rejects(
        requestCppToolArchive(retired, repositories, {
          delayImpl: async () => {},
          fetchImpl: async () => new Response(null, { status: 404 }),
          readFallbackImpl: async (url: URL) => {
            reads++;
            assert.ok(
              url.pathname.endsWith("/cpp-archive-fallbacks/" + retired.path),
            );
            return bytes;
          },
        }),
        /C\+\+ fallback archive (digest|size) differs/,
      );
      assert.equal(reads, 1);
    }
    let reads = 0;
    for (const adjacent of [
      { ...retired, path: retired.path.replace("-r0.apk", "-r1.apk") },
      { ...retired, bytes: retired.bytes + 1 },
      { ...retired, sha256: "0".repeat(64) },
    ]) {
      await assert.rejects(
        requestCppToolArchive(adjacent, repositories, {
          delayImpl: async () => {},
          fetchImpl: async () => new Response(null, { status: 404 }),
          readFallbackImpl: async () => {
            reads++;
            return Buffer.alloc(retired.bytes);
          },
        }),
        /Pinned archive unavailable/,
      );
    }
    assert.equal(reads, 0);
  });
  test(`C++ ${retired.path} fallback cannot hide permanent errors integrity failures or cancellation`, async () => {
    for (const variant of ["forbidden", "redirect", "corrupt", "cancelled"]) {
      const abort = new AbortController();
      let calls = 0,
        reads = 0;
      await assert.rejects(
        requestCppToolArchive(retired, repositories, {
          signal: abort.signal,
          delayImpl: async () => {},
          fetchImpl: async () => {
            calls++;
            if (calls <= 6) return new Response(null, { status: 404 });
            if (variant === "cancelled") abort.abort();
            return variant === "forbidden"
              ? new Response(null, { status: 403 })
              : variant === "redirect"
                ? new Response(null, { status: 302 })
                : variant === "corrupt"
                  ? new Response(Buffer.alloc(retired.bytes))
                  : new Response(null, { status: 404 });
          },
          readFallbackImpl: async () => {
            reads++;
            return Buffer.alloc(retired.bytes);
          },
        }),
      );
      assert.equal(calls, 7, variant);
      assert.equal(reads, 0, variant);
    }
  });
}

test("C++ archive acquisition retains the exact retired musl development bytes and refuses invalid final mirror responses before community", async () => {
  const retired = { ...pin, path: "musl-dev-1.2.6-r2.apk" };
  const expected = [
    repositories[0] + retired.path,
    repositories[0]!.replace("dl-cdn", "dl-4") + retired.path,
    "https://mirrors.huaweicloud.com/alpine/v3.24/main/aarch64/" + retired.path,
  ];
  for (const kind of [
    "valid",
    "digest",
    "short",
    "overlong",
    "redirect",
    "forbidden",
  ]) {
    const calls: string[] = [];
    const operation = requestCppToolArchive(retired, repositories, {
      delayImpl: async () => {},
      fetchImpl: async (url: string, request: RequestInit) => {
        calls.push(url);
        assert.equal(request.redirect, "error");
        assert.equal(url, expected[calls.length - 1]);
        if (calls.length < 3) return new Response(null, { status: 404 });
        if (kind === "redirect") return new Response(null, { status: 302 });
        if (kind === "forbidden") return new Response(null, { status: 403 });
        return new Response(
          kind === "valid"
            ? body
            : kind === "digest"
              ? Buffer.alloc(body.length)
              : kind === "short"
                ? body.subarray(1)
                : Buffer.concat([body, Buffer.from("x")]),
        );
      },
    });
    if (kind === "valid") {
      const result = await operation;
      assert.deepEqual(result.bytes, body);
      assert.equal(result.asset, expected[2]);
    } else await assert.rejects(operation);
    assert.deepEqual(calls, expected, kind);
  }
});
