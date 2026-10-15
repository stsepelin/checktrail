import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { test } from "node:test";
const { requestScalaArchive } = await import(
  new URL("../../scripts/request-scala-archive.mjs", import.meta.url).href
);
const { requestPinnedArtifactBytes } = await import(
  new URL("../../scripts/request-pinned-artifact.mjs", import.meta.url).href
);
const urls = [
  "https://github.com/scala/scala3/releases/download/3.9.0/scala3-3.9.0.zip",
  "https://github.com/scala/scala/releases/download/v2.13.18/scala-2.13.18.zip",
];
const body = Buffer.from("original synthetic Scala archive"),
  pin = {
    url: urls[0],
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
test("Scala archive setup retries HTTP 500 and restarts signed redirects at the exact pinned release with one deadline", async () => {
  for (const url of urls) {
    const calls: { url: string; request: RequestInit }[] = [],
      waits: number[] = [];
    const signal = AbortSignal.timeout(1000);
    const bytes = await requestScalaArchive(
      { ...pin, url },
      {
        signal,
        delayImpl: async (ms: number) => {
          waits.push(ms);
        },
        fetchImpl: async (address: URL, request: RequestInit) => {
          calls.push({ url: String(address), request });
          if (String(address) === url)
            return new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://release-assets.githubusercontent.com/original.zip?generation=" +
                  calls.length,
              },
            });
          return calls.length === 2
            ? new Response(null, { status: 500 })
            : new Response(body);
        },
      },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        url,
        "https://release-assets.githubusercontent.com/original.zip?generation=1",
        url,
        "https://release-assets.githubusercontent.com/original.zip?generation=3",
      ],
    );
    assert.deepEqual(waits, [1000]);
    assert.deepEqual(bytes, body);
    assert.ok(
      calls.every(
        (c) => c.request.signal === signal && c.request.redirect === "manual",
      ),
    );
  }
});
test("Scala archive setup rejects foreign redirect identities permanent failures and malformed bytes without retries", async () => {
  for (const variant of [
    "foreign",
    "credentials",
    "port",
    "http",
    "fragment",
    "missing-location",
    "404",
    "403",
    "short",
    "long",
    "hash",
  ]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      const redirects: Record<string, string> = {
        foreign: "https://release-assets.githubusercontent.com.evil.invalid/a",
        credentials: "https://user@github.com/a",
        port: "https://github.com:8443/a",
        http: "http://github.com/a",
        fragment: "https://github.com/a#token",
      };
      if (variant in redirects)
        return new Response(null, {
          status: 302,
          headers: { location: redirects[variant]! },
        });
      if (variant === "missing-location")
        return new Response(null, { status: 302 });
      if (["404", "403"].includes(variant))
        return new Response(null, { status: Number(variant) });
      return new Response(
        variant === "short"
          ? body.subarray(1)
          : variant === "long"
            ? Buffer.concat([body, Buffer.from("x")])
            : Buffer.alloc(body.length),
      );
    };
    await assert.rejects(
      requestScalaArchive(pin, { delayImpl: async () => {}, fetchImpl }),
    );
    assert.equal(calls, 1, variant);
  }
  let calls = 0;
  for (const url of [
    urls[0] + "?latest=1",
    urls[0]!.replace("3.9.0", "3.9.1"),
    urls[0]!.replace("github.com", "github.com.evil.invalid"),
  ])
    await assert.rejects(
      requestScalaArchive(
        { ...pin, url },
        {
          fetchImpl: async () => {
            calls++;
            return new Response(body);
          },
        },
      ),
    );
  assert.equal(calls, 0);
});
test("Scala archive setup bounds exhausted response and redirect retries and preserves cancellation", async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    requestScalaArchive(pin, {
      delayImpl: async (ms: number) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 500 });
      },
    }),
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 3000]);
  calls = 0;
  await assert.rejects(
    requestScalaArchive(pin, {
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://github.com/original" },
        });
      },
    }),
    /redirect limit/,
  );
  assert.equal(calls, 4);
  for (const where of ["before", "redirect", "retry"]) {
    const controller = new AbortController();
    calls = 0;
    if (where === "before") controller.abort();
    await assert.rejects(
      requestScalaArchive(pin, {
        signal: controller.signal,
        delayImpl: async () => {
          controller.abort();
        },
        fetchImpl: async () => {
          calls++;
          if (where === "redirect") {
            controller.abort();
            return new Response(null, {
              status: 302,
              headers: { location: "https://github.com/original" },
            });
          }
          return new Response(null, { status: 500 });
        },
      }),
    );
    assert.equal(calls, where === "before" ? 0 : 1, where);
  }
});
test("Pinned artifact setup keeps its default admission ceiling and permits a bounded explicit Scala archive ceiling", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, { status: 403 });
  };
  const large = { asset: urls[0], bytes: 128 * 1024 * 1024 + 1 };
  await assert.rejects(requestPinnedArtifactBytes(large, { fetchImpl }));
  assert.equal(calls, 0);
  await assert.rejects(
    requestPinnedArtifactBytes(large, {
      fetchImpl,
      maxArtifactBytes: 256 * 1024 * 1024,
    }),
  );
  assert.equal(calls, 1);
  for (const maxArtifactBytes of [0, -1, 256 * 1024 * 1024 + 1, NaN])
    await assert.rejects(
      requestPinnedArtifactBytes(
        { asset: urls[0], bytes: 1 },
        { fetchImpl, maxArtifactBytes },
      ),
    );
  assert.equal(calls, 1);
});
