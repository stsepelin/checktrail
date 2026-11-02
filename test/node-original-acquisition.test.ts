import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  acquireNodeOriginalInputs,
  describeNodeInputFailure,
  directNodeInputTransport,
  downloadNodeOriginalInput,
  nodeOriginalAcquisitionLimits,
  nodeOriginalDocManifest,
  publishNodeOriginalInput,
  retainNodeOriginalResponse,
  validateNodeOriginalInputUrl,
  verifyNodeOriginalInput,
  writeNodeInputBytes,
} = await import(
  pathToFileURL(
    path.join(repository, "scripts/acquire-node-original-inputs.mjs"),
  ).href
);
const { nodeOriginalInputRows, inspectNodeDocArchiveManifest } = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/node-original-profile.mjs",
    ),
  ).href
);
const digest = (raw: Buffer | string, algorithm = "sha256") =>
  createHash(algorithm).update(raw).digest("hex");
const pin = (raw: Buffer | string) => ({
  file: "docs/synthetic.tgz",
  url: "https://example.invalid/inert.tgz",
  bytes: Buffer.byteLength(raw),
  sha256: digest(raw),
  sha512Hex: digest(raw, "sha512"),
  integrity: "sha512-" + createHash("sha512").update(raw).digest("base64"),
});
const ledger = () => ({
  requestsStarted: 0,
  bodyBytesObserved: 0,
  bodyBytesWritten: 0,
  verificationBytesRead: 0,
  metadataBytesWritten: 0,
});
const response = (chunks: Buffer[], status = 200, close = () => {}) => ({
  status,
  headers: {},
  rawHeaders: [],
  body: (async function* () {
    for (const chunk of chunks) yield chunk;
  })(),
  close,
});
interface Failure extends Error {
  primary: Error & { status?: number };
  secondary: {
    stage: string;
    message: string;
    errors?: { message: string }[];
  }[];
  observation: {
    bytesObserved: number;
    bytesWritten: number;
    writtenPrefixSha256: string;
    fileClosed: boolean;
    validated: boolean;
    rawHeaders?: string[];
    bodyComplete?: boolean;
  };
}
function writer(
  options: {
    short?: number;
    failAfter?: number;
    closeError?: Error;
    syncError?: Error;
    onClose?: () => void;
  } = {},
) {
  const pieces: Buffer[] = [];
  let bytes = 0,
    closes = 0,
    syncs = 0;
  return {
    file: {
      async write(raw: Buffer, offset: number, length: number) {
        if (options.failAfter !== undefined && bytes >= options.failAfter)
          throw Object.assign(new Error("synthetic write EIO"), {
            code: "EIO",
          });
        const count = Math.min(length, options.short ?? length);
        pieces.push(Buffer.from(raw.subarray(offset, offset + count)));
        bytes += count;
        return { bytesWritten: count };
      },
      async sync() {
        syncs++;
        if (options.syncError) throw options.syncError;
      },
      async close() {
        closes++;
        options.onClose?.();
        if (options.closeError) throw options.closeError;
      },
    },
    bytes: () => Buffer.concat(pieces),
    closes: () => closes,
    syncs: () => syncs,
  };
}
const context = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "checktrail-node-original-data-")),
  );
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const posix = {
  skip:
    process.platform === "win32"
      ? "Selected Linux producer uses POSIX private input-file custody"
      : false,
};

test("the closed acquisition interface binds one source and144 exact document URLs/manifests", () => {
  const rows = nodeOriginalInputRows();
  assert.equal(rows.length, 145);
  assert.equal(new Set(rows.map((r: { file: string }) => r.file)).size, 145);
  assert.equal(
    rows.reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0),
    50918581,
  );
  const manifest = nodeOriginalDocManifest();
  assert.equal(manifest.artifacts.length, 144);
  assert.deepEqual(inspectNodeDocArchiveManifest(manifest), manifest);
  for (const row of rows)
    assert.equal(validateNodeOriginalInputUrl(row.url).href, row.url);
  for (const bad of [
    rows[0].url + ".foreign",
    rows[0].url + "?mirror=1",
    "https://user:secret@nodejs.org/dist/v22.16.0/node-v22.16.0.tar.xz",
    "http://nodejs.org/dist/v22.16.0/node-v22.16.0.tar.xz",
  ])
    assert.throws(
      () => validateNodeOriginalInputUrl(bad),
      /exact public input URLs/,
    );
});

test("multiple chunks and actual short writes preserve complete SHA256/SHA512/SRI before close", async () => {
  const out = writer({ short: 2 }),
    counters = ledger(),
    raw = Buffer.from("abcdefg");
  const retained = await retainNodeOriginalResponse(
    response([raw.subarray(0, 3), raw.subarray(3)]),
    "synthetic.partial",
    pin(raw),
    counters,
    () => {},
    async () => out.file,
  );
  assert.deepEqual(out.bytes(), raw);
  assert.equal(out.closes(), 1);
  assert.equal(out.syncs(), 1);
  assert.equal(retained.validated, true);
  assert.equal(retained.fileClosed, true);
  assert.equal(retained.writtenPrefixSha256, digest(raw));
  assert.equal(counters.bodyBytesObserved, 7);
  assert.equal(counters.bodyBytesWritten, 7);
});

test("zero progress refuses and a partial EIO keeps its first cause, close secondary and real prefix", async () => {
  await assert.rejects(
    writeNodeInputBytes(
      { write: async () => ({ bytesWritten: 0 }) },
      Buffer.from("abc"),
      () => {},
    ),
    /invalid progress/,
  );
  const closeError = new Error("synthetic close after write failed"),
    out = writer({ short: 2, failAfter: 2, closeError }),
    counters = ledger();
  await assert.rejects(
    retainNodeOriginalResponse(
      response([Buffer.from("abcdef")]),
      "synthetic.partial",
      pin("abcdef"),
      counters,
      () => {},
      async () => out.file,
    ),
    (value: unknown) => {
      const error = value as Failure;
      assert.equal(error.primary.message, "synthetic write EIO");
      assert.equal(error.secondary[0]?.stage, "input-file-close");
      assert.equal(error.secondary[0]?.message, closeError.message);
      assert.equal(error.observation.bytesObserved, 6);
      assert.equal(error.observation.bytesWritten, 2);
      assert.equal(error.observation.writtenPrefixSha256, digest("ab"));
      assert.equal(error.observation.validated, false);
      return true;
    },
  );
  assert.equal(out.closes(), 1);
  assert.equal(counters.bodyBytesWritten, 2);
  assert.deepEqual(out.bytes(), Buffer.from("ab"));
});

test("HTTP failure remains primary with ordered headers, a finite prefix, read and close failures", async () => {
  const out = writer({ closeError: new Error("close refused") }),
    counters = ledger(),
    raw = Buffer.alloc(65543, 97);
  const incoming = {
    ...response([raw], 403),
    headers: { "content-length": String(raw.length) },
    rawHeaders: ["X-Synthetic", "one", "X-Synthetic", "two"],
  };
  await assert.rejects(
    retainNodeOriginalResponse(
      incoming,
      "synthetic.partial",
      { ...pin("abc"), bytes: 70000 },
      counters,
      () => {},
      async () => out.file,
    ),
    (value: unknown) => {
      const error = value as Failure;
      assert.equal(error.primary.name, "NodeInputHttpError");
      assert.equal(error.primary.status, 403);
      assert.equal(error.secondary[0]?.stage, "input-file-close");
      assert.deepEqual(error.observation.rawHeaders, incoming.rawHeaders);
      assert.equal(error.observation.bytesObserved, 65543);
      assert.equal(error.observation.bytesWritten, 65536);
      assert.equal(error.observation.bodyComplete, false);
      return true;
    },
  );
  assert.equal(
    out.bytes().length,
    nodeOriginalAcquisitionLimits.failedPrefixBytes,
  );
  assert.equal(counters.bodyBytesObserved, 65543);
  const broken = {
    ...response([], 404),
    body: (async function* () {
      yield Buffer.from("abc");
      throw new Error("synthetic failed-body read");
    })(),
  };
  await assert.rejects(
    retainNodeOriginalResponse(
      broken,
      "other.partial",
      { ...pin("abc"), bytes: 10 },
      ledger(),
      () => {},
      async () => writer().file,
    ),
    (value: unknown) => {
      const error = value as Failure;
      assert.equal(error.primary.status, 404);
      assert.equal(error.secondary[0]?.message, "synthetic failed-body read");
      assert.equal(error.observation.bytesWritten, 3);
      return true;
    },
  );
});

test("encoding length bytes SHA256 SHA512 and SRI refusals retain known prefixes without validation", async () => {
  const base = pin("abc");
  const cases = [
    {
      incoming: {
        ...response([Buffer.from("abc")]),
        headers: { "content-encoding": "gzip" },
      },
      row: base,
      why: /Encoded/,
    },
    {
      incoming: {
        ...response([Buffer.from("abc")]),
        headers: { "content-length": "03" },
      },
      row: base,
      why: /Content-Length/,
    },
    { incoming: response([Buffer.from("abd")]), row: base, why: /SHA256/ },
    {
      incoming: response([Buffer.from("abc")]),
      row: { ...base, sha512Hex: "0".repeat(128) },
      why: /SHA512/,
    },
    {
      incoming: response([Buffer.from("abc")]),
      row: { ...base, integrity: "sha512-foreign" },
      why: /SRI/,
    },
    { incoming: response([Buffer.from("ab")]), row: base, why: /ended before/ },
    {
      incoming: response([Buffer.from("abcd")]),
      row: base,
      why: /exceeds exact/,
    },
  ];
  for (const selected of cases) {
    const out = writer();
    await assert.rejects(
      retainNodeOriginalResponse(
        selected.incoming,
        "synthetic.partial",
        selected.row,
        ledger(),
        () => {},
        async () => out.file,
      ),
      (value: unknown) => {
        const error = value as Failure;
        assert.match(error.primary.message, selected.why);
        assert.equal(error.observation.validated, false);
        return true;
      },
    );
  }
});

test("valid returned buffers are charged before late-return or aggregate-limit refusals", async () => {
  const late = writer(),
    counters = ledger();
  await assert.rejects(
    retainNodeOriginalResponse(
      response([Buffer.from("abc")]),
      "synthetic.partial",
      pin("abc"),
      counters,
      () => {
        throw new Error("synthetic deadline");
      },
      async () => late.file,
    ),
    (value: unknown) => {
      const error = value as Failure;
      assert.equal(error.primary.message, "synthetic deadline");
      assert.equal(error.observation.bytesObserved, 3);
      assert.equal(error.observation.bytesWritten, 0);
      return true;
    },
  );
  assert.equal(counters.bodyBytesObserved, 3);
  assert.equal(late.closes(), 1);
  const near = writer();
  assert.equal(
    (
      await retainNodeOriginalResponse(
        response([Buffer.from("abc")]),
        "near.partial",
        pin("abc"),
        ledger(),
        () => {},
        async () => near.file,
      )
    ).validated,
    true,
  );
  const capped = ledger();
  capped.bodyBytesObserved = nodeOriginalAcquisitionLimits.bodyBytes - 1;
  await assert.rejects(
    retainNodeOriginalResponse(
      response([Buffer.from("abc")]),
      "cap.partial",
      pin("abc"),
      capped,
      () => {},
      async () => writer().file,
    ),
    /Aggregate observed/,
  );
  assert.equal(
    capped.bodyBytesObserved,
    nodeOriginalAcquisitionLimits.bodyBytes + 2,
  );
});

test("a successful-looking file close tail still refuses after the same deadline", async () => {
  let expired = false;
  const out = writer({
    onClose: () => {
      expired = true;
    },
  });
  await assert.rejects(
    retainNodeOriginalResponse(
      response([Buffer.from("abc")]),
      "synthetic.partial",
      pin("abc"),
      ledger(),
      () => {
        if (expired) throw new Error("close tail crossed deadline");
      },
      async () => out.file,
    ),
    (value: unknown) => {
      const error = value as Failure;
      assert.match(error.primary.message, /close tail/);
      assert.equal(error.observation.bytesWritten, 3);
      assert.equal(error.observation.fileClosed, true);
      assert.equal(error.observation.validated, false);
      return true;
    },
  );
});

test(
  "exclusive publication preserves a racing target and final rehash rejects changed or linked bodies",
  posix,
  async () =>
    context(async (root) => {
      const partial = path.join(root, "input.partial"),
        target = path.join(root, "input");
      await writeFile(partial, "abc", { mode: 0o600 });
      await writeFile(target, "prior", { mode: 0o600 });
      await assert.rejects(
        publishNodeOriginalInput(partial, target, pin("abc")),
        { code: "EEXIST" },
      );
      assert.equal(await readFile(target, "utf8"), "prior");
      assert.equal(await readFile(partial, "utf8"), "abc");
      await rm(target);
      await publishNodeOriginalInput(partial, target, pin("abc"));
      assert.equal((await stat(target)).nlink, 1);
      assert.equal((await stat(target)).mode & 0o777, 0o600);
      const counters = ledger();
      await verifyNodeOriginalInput(target, pin("abc"), counters);
      assert.equal(counters.verificationBytesRead, 3);
      await writeFile(target, "abd");
      await assert.rejects(
        verifyNodeOriginalInput(target, pin("abc"), ledger()),
        /SHA256 changed/,
      );
      await writeFile(target, "abc");
      const alias = path.join(root, "alias");
      await link(target, alias);
      await assert.rejects(
        verifyNodeOriginalInput(target, pin("abc"), ledger()),
        /private regular leaf/,
      );
    }),
);

test("response cleanup causes and a late cleanup tail cannot yield a successful request", async () =>
  context(async (root) => {
    const controller = new AbortController();
    let now = 0;
    await assert.rejects(
      downloadNodeOriginalInput(
        pin("abc"),
        path.join(root, "late.partial"),
        ledger(),
        controller.signal,
        () => {},
        async () =>
          response([Buffer.from("abc")], 200, () => {
            now = 30001;
          }),
        () => now,
      ),
      (value: unknown) => {
        const error = value as Failure;
        assert.match(error.primary.message, /request deadline/);
        assert.equal(error.observation.bytesWritten, 3);
        return true;
      },
    );
    await assert.rejects(
      downloadNodeOriginalInput(
        { ...pin("abc"), bytes: 10 },
        path.join(root, "http.partial"),
        ledger(),
        controller.signal,
        () => {},
        async () =>
          response([Buffer.from("abc")], 403, () => {
            throw new AggregateError(
              [new Error("response destroy"), new Error("agent destroy")],
              "cleanup",
            );
          }),
      ),
      (value: unknown) => {
        const error = value as Failure;
        assert.equal(error.primary.status, 403);
        assert.equal(error.secondary[0]?.stage, "https-response-close");
        assert.deepEqual(
          error.secondary[0]?.errors?.map((row) => row.message),
          ["response destroy", "agent destroy"],
        );
        return true;
      },
    );
  }));

test("direct HTTPS open failure preserves request primary when agent destruction also fails", async () => {
  const requestError = new Error("synthetic original request error"),
    cleanupError = new Error("synthetic agent cleanup error");
  const destroy = mock.method(https.Agent.prototype, "destroy", () => {
    throw cleanupError;
  });
  const request = mock.method(https, "request", () => {
    throw requestError;
  });
  try {
    await assert.rejects(
      directNodeInputTransport(
        nodeOriginalInputRows()[0].url,
        new AbortController().signal,
      ),
      (value: unknown) => {
        const error = value as Failure;
        assert.equal(error.primary, requestError);
        assert.equal(error.secondary[0]?.stage, "https-open-cleanup");
        assert.equal(
          error.secondary[0]?.errors?.[0]?.message,
          cleanupError.message,
        );
        return true;
      },
    );
    assert.equal(destroy.mock.callCount(), 1);
    assert.equal(request.mock.callCount(), 1);
  } finally {
    request.mock.restore();
    destroy.mock.restore();
  }
});

test(
  "the first failed HTTP row leaves original bytes and typed metadata and runs none of144 later rows",
  posix,
  async () =>
    context(async (root) => {
      const before = [
          process.listenerCount("SIGINT"),
          process.listenerCount("SIGTERM"),
        ],
        destination = path.join(root, "new-inputs");
      let requests = 0,
        closes = 0;
      await assert.rejects(
        acquireNodeOriginalInputs(destination, async () => {
          requests++;
          return response([Buffer.from("synthetic 403 body")], 403, () => {
            closes++;
          });
        }),
        (value: unknown) => {
          const error = value as Failure;
          assert.equal(error.primary.status, 403);
          return true;
        },
      );
      assert.equal(requests, 1);
      assert.equal(closes, 1);
      assert.deepEqual(
        [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
        before,
      );
      const terminal = JSON.parse(
        await readFile(path.join(destination, "inputs.json"), "utf8"),
      );
      assert.equal(terminal.completeInputBundle, false);
      assert.equal(terminal.acquired.length, 0);
      assert.equal(terminal.failed.status, 403);
      assert.equal(terminal.ledger.requestsStarted, 1);
      assert.equal(terminal.ledger.bodyBytesWritten, 18);
      assert.equal(
        await readFile(
          path.join(destination, "source/node-v22.16.0.tar.xz.partial"),
          "utf8",
        ),
        "synthetic 403 body",
      );
      await assert.rejects(stat(path.join(destination, "doc-archives.json")), {
        code: "ENOENT",
      });
      const journal = JSON.parse(
        await readFile(path.join(destination, "responses.jsonl"), "utf8"),
      );
      assert.equal(journal.state, "failed");
      assert.equal(journal.primary.status, 403);
    }),
);

test("already aborted requests start no transport and structured errors retain bounded known causes", async () => {
  const controller = new AbortController();
  controller.abort(new Error("operator stop"));
  let requests = 0;
  await assert.rejects(
    downloadNodeOriginalInput(
      pin("abc"),
      "never-created",
      ledger(),
      controller.signal,
      () => {},
      async () => {
        requests++;
        return response([]);
      },
    ),
    /operator stop/,
  );
  assert.equal(requests, 0);
  const described = describeNodeInputFailure(
    new AggregateError(
      [new Error("first"), new Error("second")],
      "close family",
    ),
  );
  assert.deepEqual(
    described.errors.map((row: { message: string }) => row.message),
    ["first", "second"],
  );
});

test("known input-failure primary and cleanup siblings survive both final projections with explicit bounds", async () =>
  context(async (root) => {
    const requestPrimary = new Error("synthetic original request primary");
    const agentClose = new Error("synthetic original agent destroy sibling");
    let requestFailure: Failure | undefined;
    const destroy = mock.method(https.Agent.prototype, "destroy", () => {
      throw agentClose;
    });
    const request = mock.method(https, "request", () => {
      throw requestPrimary;
    });
    try {
      try {
        await directNodeInputTransport(
          nodeOriginalInputRows()[0].url,
          new AbortController().signal,
        );
      } catch (error) {
        requestFailure = error as Failure;
      }
    } finally {
      request.mock.restore();
      destroy.mock.restore();
    }
    assert.ok(requestFailure);
    assert.equal(requestFailure.primary, requestPrimary);
    const readPrimary = new Error("synthetic nested body read primary");
    const fileClose = new Error("synthetic nested file close sibling");
    let bodyFailure: Failure | undefined;
    try {
      await retainNodeOriginalResponse(
        {
          ...response([]),
          body: (async function* () {
            yield Buffer.from("abc");
            throw readPrimary;
          })(),
        },
        "never-materialized.partial",
        pin("abc"),
        ledger(),
        () => {},
        async () => writer({ closeError: fileClose }).file,
      );
    } catch (error) {
      bodyFailure = error as Failure;
    }
    assert.ok(bodyFailure);
    assert.equal(bodyFailure.primary, readPrimary);
    for (const status of [403, 200]) {
      const partial = path.join(root, "known-" + status + ".partial");
      const incoming = {
        ...response([], status, () => {
          throw new AggregateError(
            [
              new Error("synthetic response destroy sibling"),
              new Error("synthetic request destroy sibling"),
            ],
            "HTTPS close siblings",
          );
        }),
        failure: requestFailure,
        body: (async function* () {
          yield Buffer.from("abc");
          throw bodyFailure;
        })(),
      };
      await assert.rejects(
        downloadNodeOriginalInput(
          { ...pin("abc"), bytes: 10 },
          partial,
          ledger(),
          new AbortController().signal,
          () => {},
          async () => incoming,
        ),
        (value: unknown) => {
          const error = value as Failure;
          if (status === 403) assert.equal(error.primary.status, 403);
          else assert.equal(error.primary, requestPrimary);
          const actualFinalProjection = JSON.stringify({
            primary: describeNodeInputFailure(error.primary),
            secondary: error.secondary,
          });
          for (const marker of [
            requestPrimary.message,
            agentClose.message,
            readPrimary.message,
            fileClose.message,
            "synthetic response destroy sibling",
            "synthetic request destroy sibling",
          ])
            assert.ok(
              actualFinalProjection.includes(marker),
              "Missing known original cause: " + marker,
            );
          return true;
        },
      );
      assert.equal(await readFile(partial, "utf8"), "abc");
    }
    assert.deepEqual(
      describeNodeInputFailure(new Error("ordinary near miss")),
      { type: "Error", message: "ordinary near miss" },
    );
    const many = describeNodeInputFailure(
      new AggregateError(
        Array.from({ length: 10 }, (_, index) => new Error("bounded-" + index)),
        "bounded errors",
      ),
    );
    assert.equal(many.errors.length, 8);
    assert.equal(many.additionalErrors, 2);
    const deep = describeNodeInputFailure(
      new Error("outer", {
        cause: new Error("middle", {
          cause: new Error("inner", { cause: new Error("omitted leaf") }),
        }),
      }),
    );
    assert.equal(deep.cause.cause.causeOmitted, true);
    const knownTypedRow = describeNodeInputFailure({
      type: "NodeInputAcquisitionFailure",
      message: "stored known failure",
      primary: new Error("stored primary"),
      secondary: Array.from({ length: 10 }, () => ({
        stage: "stored-close",
        type: "Error",
        message: "stored close",
      })),
    });
    assert.equal(knownTypedRow.secondary.length, 8);
    assert.equal(knownTypedRow.additionalSecondaryCount, 2);
    assert.equal(knownTypedRow.secondary[0].stage, "stored-close");
  }));
