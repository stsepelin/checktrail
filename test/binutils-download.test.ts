import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  retainDownload,
  parallelDownloads,
  retainedTreeBytes,
  verifyExactBundle,
} = await import(
  pathToFileURL(path.join(repository, "scripts/acquire-binutils-inputs.mjs"))
    .href
);
const pin = (value: string) => ({
  bytes: Buffer.byteLength(value),
  sha256: createHash("sha256").update(value).digest("hex"),
});
const row = (index: number) => ({
  id: `data/${index}`,
  url:
    "https://snapshot.debian.org/file/" + index.toString(16).padStart(40, "0"),
  ...pin(`data-${index}`),
});
const context = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "checktrail-binutils-download-")),
  );
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("download publication requires exact bytes and leaves existing destinations unchanged", async () =>
  context(async (root) => {
    const target = path.join(root, "exact"),
      raw = "synthetic original data";
    assert.deepEqual(
      await retainDownload(
        new Response(raw),
        target,
        pin(raw),
        new AbortController().signal,
      ),
      pin(raw),
    );
    assert.equal(await readFile(target, "utf8"), raw);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(
      retainDownload(
        new Response("replacement"),
        target,
        pin("replacement"),
        new AbortController().signal,
      ),
    );
    assert.equal(await readFile(target, "utf8"), raw);
  }));

test("wrong status encoding length hashes and short or oversized bodies never publish a file", async () =>
  context(async (root) => {
    const cases: [Response, { bytes: number; sha256: string }, RegExp][] = [
      [new Response("abc", { status: 404 }), pin("abc"), /HTTP200/],
      [
        new Response("abc", { headers: { "content-encoding": "gzip" } }),
        pin("abc"),
        /Encoded/,
      ],
      [
        new Response("abc", { headers: { "content-length": "04" } }),
        pin("abc"),
        /Content-Length/,
      ],
      [new Response("abc"), pin("abd"), /SHA256/],
      [new Response("ab"), pin("abc"), /ended before/],
      [new Response("abcd"), pin("abc"), /exceeds frozen/],
      [new Response(null), pin("abc"), /Missing or redirected/],
    ];
    for (const [index, [response, expected, message]] of cases.entries()) {
      const target = path.join(root, String(index));
      await assert.rejects(
        retainDownload(
          response,
          target,
          expected,
          new AbortController().signal,
        ),
        message,
      );
      await assert.rejects(stat(target), { code: "ENOENT" });
    }
  }));

test("partial-file admission collision preserves the prior bytes", async () =>
  context(async (root) => {
    const target = path.join(root, "candidate");
    await writeFile(target + ".part", "prior attempt");
    await assert.rejects(
      retainDownload(
        new Response("abc"),
        target,
        pin("abc"),
        new AbortController().signal,
      ),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(target + ".part", "utf8"), "prior attempt");
    await assert.rejects(stat(target), { code: "ENOENT" });
  }));

test("four concurrent workers retain exact ordered results for a larger batch", async () =>
  context(async (root) => {
    let running = 0,
      peak = 0;
    const rows = Array.from({ length: 9 }, (_, index) => row(index));
    const request = async (
      selected: ReturnType<typeof row>,
      target: string,
      signal: AbortSignal,
    ) => {
      running++;
      peak = Math.max(peak, running);
      try {
        await setTimeout(15);
        return await retainDownload(
          new Response(`data-${Number.parseInt(selected.id.slice(5))}`),
          target,
          selected,
          signal,
        );
      } finally {
        running--;
      }
    };
    const result = await parallelDownloads(
      rows,
      root,
      { workers: 4, perFileMs: 1000 },
      new AbortController().signal,
      request,
    );
    assert.equal(result.complete, true);
    assert.equal(peak, 4);
    assert.equal(running, 0);
    assert.deepEqual(
      result.results.map((r: { id: string; state: string }) => [r.id, r.state]),
      rows.map((r) => [r.id, "matched"]),
    );
    for (const [index, selected] of rows.entries())
      assert.equal(
        await readFile(path.join(root, selected.id), "utf8"),
        `data-${index}`,
      );
  }));

test("every target is admitted before any request and a late collision starts none", async () =>
  context(async (root) => {
    const rows = [row(1), row(2), row(3)] as const;
    // Create the directory with an actual successful sibling file first.
    await parallelDownloads(
      [rows[0]],
      root,
      { workers: 1, perFileMs: 1000 },
      new AbortController().signal,
      async (_row: unknown, target: string, signal: AbortSignal) =>
        retainDownload(new Response("data-1"), target, pin("data-1"), signal),
    );
    let requests = 0;
    await assert.rejects(
      parallelDownloads(
        [rows[1], rows[2], rows[0]],
        root,
        { workers: 4, perFileMs: 1000 },
        new AbortController().signal,
        async () => {
          requests++;
        },
      ),
    );
    assert.equal(requests, 0);
    assert.equal(await readFile(path.join(root, rows[0].id), "utf8"), "data-1");
  }));

test("failed multi-worker batch waits for active requests and marks later work unrun", async () =>
  context(async (root) => {
    let active = 0;
    const rows = Array.from({ length: 9 }, (_, index) => row(index));
    const result = await parallelDownloads(
      rows,
      root,
      { workers: 2, perFileMs: 1000 },
      new AbortController().signal,
      async (
        selected: ReturnType<typeof row>,
        target: string,
        signal: AbortSignal,
      ) => {
        active++;
        try {
          if (selected.id === "data/0")
            return await retainDownload(
              new Response("wrong!"),
              target,
              selected,
              signal,
            );
          await setTimeout(20);
          signal.throwIfAborted();
          return await retainDownload(
            new Response("data-1"),
            target,
            selected,
            signal,
          );
        } finally {
          active--;
        }
      },
    );
    assert.equal(result.complete, false);
    assert.equal(active, 0);
    assert.equal(result.results.length, rows.length);
    assert.equal(result.results[0].state, "failed");
    assert.match(result.results[0].error, /SHA256/);
    assert.ok(
      result.results
        .slice(2)
        .every((r: { state: string }) => r.state === "unrun"),
    );
  }));

test("expired per-file deadline prevents publication and cannot count as a completed batch", async () =>
  context(async (root) => {
    const result = await parallelDownloads(
      [row(1), row(2)],
      root,
      { workers: 2, perFileMs: 5 },
      new AbortController().signal,
      async (
        selected: ReturnType<typeof row>,
        target: string,
        signal: AbortSignal,
      ) => {
        await setTimeout(20);
        return retainDownload(new Response("data-1"), target, selected, signal);
      },
    );
    assert.equal(result.complete, false);
    assert.ok(
      result.results.every(
        (r: { state: string; error: string }) =>
          r.state === "failed" && /TimeoutError/.test(r.error),
      ),
    );
  }));

test("invalid batch origins duplicate paths and unsafe worker limits fail before requests", async () =>
  context(async (root) => {
    for (const rows of [
      [row(1), row(1)],
      [{ ...row(1), id: "../escape" }],
      [{ ...row(1), url: row(1).url + ".evil" }],
    ]) {
      let requests = 0;
      await assert.rejects(
        parallelDownloads(
          rows,
          root,
          { workers: 4, perFileMs: 1000 },
          new AbortController().signal,
          async () => {
            requests++;
          },
        ),
      );
      assert.equal(requests, 0);
    }
    for (const workers of [0, 5, 1.5])
      await assert.rejects(
        parallelDownloads(
          [row(1)],
          root,
          { workers, perFileMs: 1000 },
          new AbortController().signal,
        ),
      );
  }));

test("retention inventory counts the complete tree and rejects byte growth", async () =>
  context(async (root) => {
    await writeFile(path.join(root, "a"), "abc");
    await writeFile(path.join(root, "b"), "de");
    assert.equal(await retainedTreeBytes(root, 5), 5);
    await assert.rejects(retainedTreeBytes(root, 4), /exceeded bound/);
  }));
test(
  "retention inventory refuses linked paths",
  {
    skip:
      process.platform === "win32"
        ? "POSIX symlink control requires symbolic-link privileges"
        : false,
  },
  async () =>
    context(async (root) => {
      await writeFile(path.join(root, "a"), "abc");
      await symlink(path.join(root, "a"), path.join(root, "linked"));
      await assert.rejects(retainedTreeBytes(root, 10), /linked path/);
    }),
);

test("bundle publication requires all frozen files and rejects additional files or directories", async () =>
  context(async (root) => {
    await mkdir(path.join(root, "source"));
    await writeFile(path.join(root, "source/a"), "first");
    await writeFile(path.join(root, "source/b"), "second");
    const rows = [
      { file: "source/a", ...pin("first") },
      { file: "source/b", ...pin("second") },
    ];
    assert.deepEqual(await verifyExactBundle(root, rows), {
      files: 2,
      bytes: 11,
    });
    await writeFile(path.join(root, "source/b"), "corrupt");
    await assert.rejects(verifyExactBundle(root, rows));
    await writeFile(path.join(root, "source/b"), "second");
    await writeFile(path.join(root, "extra"), "not selected");
    await assert.rejects(
      verifyExactBundle(root, rows),
      /Physical bundle files differ/,
    );
    await rm(path.join(root, "extra"));
    await mkdir(path.join(root, "empty-extra"));
    await assert.rejects(
      verifyExactBundle(root, rows),
      /Physical bundle directories differ/,
    );
    await rm(path.join(root, "empty-extra"), { recursive: true });
    assert.deepEqual(await verifyExactBundle(root, rows), {
      files: 2,
      bytes: 11,
    });
  }));

test("missing or contradictory downloader results cannot complete a batch", async () => {
  for (const bad of [
    undefined,
    { bytes: 0, sha256: row(1).sha256 },
    { bytes: row(1).bytes, sha256: "0".repeat(64) },
  ]) {
    await context(async (root) => {
      let requests = 0;
      const rows = [row(1), row(2), row(3)];
      const result = await parallelDownloads(
        rows,
        root,
        { workers: 1, perFileMs: 1000 },
        new AbortController().signal,
        async () => {
          requests++;
          return bad;
        },
      );
      assert.equal(result.complete, false);
      assert.equal(requests, 1);
      assert.equal(result.results[0].state, "failed");
      assert.match(result.results[0].error, /Downloader result differs/);
      assert.deepEqual(
        result.results.slice(1).map((value: { state: string }) => value.state),
        ["unrun", "unrun"],
      );
    });
  }
});
