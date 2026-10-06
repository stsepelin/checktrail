import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  access,
  readdir,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { loadExternalAdapter } from "../src/external-adapter.js";
import { parseExecutableBundle } from "../src/executable-bundle.js";
import { projectReport } from "../src/output.js";
import { fixture } from "./helpers.js";
import {
  executableFixture,
  bundleHash,
  bundleSample,
  bundleEndpoint,
  fetchBundleChild,
} from "./executable-bundle-fixture.js";

test("packed adapter registration verifies every artifact without executing code or granting project trust and preserves native broken fixed near-miss results", async (t) => {
  const program =
    'import {writeFile} from "node:fs/promises"; await writeFile("target/executed","yes");\n' +
    bundleSample;
  const packed = executableFixture(program);
  const root = await fixture(t, {
    "lines.project": "synthetic",
    "value.txt": "broken  \n",
    "target/preserve": "keep",
  });
  const store = await fixture(t, {
    "adapter.bundle.json": packed.bytes.toString(),
  });
  const reference = {
    path: path.join(store, "adapter.bundle.json"),
    sha256: bundleHash(packed.bytes),
  };
  const loaded = await loadExternalAdapter(reference, true);
  assert.equal(loaded.contents.size, 2);
  assert.equal(loaded.identity.sha256, reference.sha256);
  assert.equal(loaded.contents.get("adapter.mjs")!.toString(), program);
  const plan = (await createPlan(root, { externalAdapters: [reference] })).plan;
  assert.equal(plan.checks[0]!.id, "external.packed.whitespace");
  assert.deepEqual(plan.checks[0]!.scope, ["value.txt"]);
  await assert.rejects(access(path.join(root, "target/executed")), {
    code: "ENOENT",
  });
  await assert.rejects(
    validate(root, { trusted: false, externalAdapters: [reference] }),
    /trust/,
  );
  assert.equal((await createPlan(root)).plan.checks.length, 0);
  let report = await validate(root, {
    trusted: true,
    externalAdapters: [reference],
  });
  assert.equal(report.outcome, "failed");
  assert.equal(report.checks[0]!.findings?.[0]?.file, "value.txt");
  assert.equal(report.checks[0]!.findingsComplete, true);
  assert.equal(
    await readFile(path.join(root, "target/executed"), "utf8"),
    "yes",
  );
  assert.equal(
    await readFile(path.join(root, "target/preserve"), "utf8"),
    "keep",
  );
  await writeFile(path.join(root, "value.txt"), "fixed\n");
  assert.equal(
    (await validate(root, { trusted: true, externalAdapters: [reference] }))
      .outcome,
    "passed",
  );
  await writeFile(path.join(root, "value.txt"), "near miss\r\n");
  report = await validate(root, {
    trusted: true,
    externalAdapters: [reference],
  });
  assert.equal(report.outcome, "passed");
  assert.equal(report.sourceChanged, false);
  assert.ok(!JSON.stringify(projectReport(report, false)).includes(store));
  // Changing encoded content needs a complete outer digest recheck, rather than trusting the former registration.
  await writeFile(
    reference.path,
    Buffer.concat([packed.bytes, Buffer.from(" ")]),
  );
  await assert.rejects(loadExternalAdapter(reference), /integrity/);
});

test("packed adapters reject missing duplicate unpinned colliding escaping corrupt and noncanonical artifact content without leaking malformed manifest text", async () => {
  const packed = executableFixture();
  assert.equal(
    parseExecutableBundle(packed.bytes).decodedBytes,
    Buffer.byteLength(bundleSample) +
      Buffer.byteLength("Original synthetic adapter material\n"),
  );
  const mutateManifest = (change: (value: typeof packed.manifest) => void) => {
    const manifest = structuredClone(packed.manifest);
    change(manifest);
    return {
      ...packed.value,
      manifestBase64: Buffer.from(JSON.stringify(manifest)).toString("base64"),
    };
  };
  for (const value of [
    { ...packed.value, files: packed.value.files.slice(0, 1) },
    { ...packed.value, files: [packed.value.files[0], packed.value.files[0]] },
    {
      ...packed.value,
      files: [...packed.value.files, { path: "unlisted.mjs", base64: "" }],
    },
    {
      ...packed.value,
      files: packed.value.files.map((f, i) =>
        i === 1
          ? { ...f, base64: Buffer.from("corrupt").toString("base64") }
          : f,
      ),
    },
    {
      ...packed.value,
      files: packed.value.files.map((f, i) =>
        i === 1 ? { ...f, base64: f.base64 + "\n" } : f,
      ),
    },
    mutateManifest((m) => {
      m.entry = "unlisted.mjs";
    }),
    mutateManifest((m) => {
      m.files[1]!.path = "../escape";
    }),
    mutateManifest((m) => {
      m.checks[0]!.scope = { extensions: [], names: [] };
    }),
    {
      ...mutateManifest((m) => {
        m.files[0]!.path = "lib";
        m.files[1]!.path = "lib/data";
        m.entry = "lib";
      }),
      files: packed.value.files.map((f, i) => ({
        ...f,
        path: i === 0 ? "lib" : "lib/data",
      })),
    },
    {
      ...packed.value,
      manifestBase64: Buffer.from("NEVER_PRINT_MANIFEST_TEXT").toString(
        "base64",
      ),
    },
  ])
    assert.throws(
      () => parseExecutableBundle(Buffer.from(JSON.stringify(value))),
      /Executable bundle has invalid/,
    );
  for (const bytes of [
    Buffer.from("NEVER_PRINT_MALFORMED_JSON"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), packed.bytes]),
    Buffer.from([0xff]),
  ]) {
    try {
      parseExecutableBundle(bytes);
      assert.fail("Malformed bundle passed");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Executable bundle has invalid/);
      assert.ok(!error.message.includes("NEVER_PRINT"));
    }
  }
});

test("executable bundle HTTPS installation publishes exact verified private bytes with no implicit activation or code execution", async (t) => {
  const packed = executableFixture(
    'throw Error("MUST_NOT_EXECUTE_DURING_INSTALL");\n' + bundleSample,
  );
  const server = await bundleEndpoint(t, packed.bytes);
  const root = await fixture(t, {});
  const result = await fetchBundleChild(
    root,
    server.url + "/ok?token=SYNTHETIC_ENDPOINT_SECRET",
    bundleHash(packed.bytes),
    server.certificate,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.codeExecuted, false);
  assert.equal(metadata.activated, false);
  assert.equal(metadata.files, 2);
  assert.equal(metadata.reference.sha256, bundleHash(packed.bytes));
  const file = path.join(root, "adapter.bundle.json");
  assert.deepEqual(await readFile(file), packed.bytes);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ["adapter.bundle.json"]);
  const loaded = await loadExternalAdapter(metadata.reference, true);
  assert.equal(loaded.contents.size, 2);
  assert.equal(loaded.manifest.id, "external.packed");
  assert.equal((await createPlan(root)).plan.checks.length, 0);
  assert.ok(
    !result.stdout.includes("SYNTHETIC_ENDPOINT_SECRET") &&
      !result.stdout.includes("MUST_NOT_EXECUTE_DURING_INSTALL"),
  );
  assert.deepEqual(
    server.requests.map((r) => [r.method, r.authorization]),
    [["GET", undefined]],
  );
});

test("executable bundle download validates every artifact before publication and hides endpoint and body text on transport or content failures", async (t) => {
  const packed = executableFixture();
  const server = await bundleEndpoint(t, packed.bytes);
  for (const pathname of [
    "ok",
    "redirect",
    "status",
    "encoded",
    "oversized",
    "truncated",
  ]) {
    const root = await fixture(t, {});
    const result = await fetchBundleChild(
      root,
      server.url + "/" + pathname + "?token=SYNTHETIC_ENDPOINT_SECRET",
      pathname === "ok" ? "0".repeat(64) : bundleHash(packed.bytes),
      server.certificate,
    );
    assert.equal(result.exitCode, 2);
    assert.deepEqual(await readdir(root), []);
    assert.ok(
      !result.stderr.includes("SYNTHETIC_ENDPOINT_SECRET") &&
        !result.stderr.includes("NEVER_PRINT_UPSTREAM_BODY") &&
        !result.stderr.includes(server.url),
    );
  }
  const corrupt = structuredClone(packed.value);
  corrupt.files[1]!.base64 = Buffer.from("bad second artifact").toString(
    "base64",
  );
  for (const body of [
    Buffer.from(JSON.stringify(corrupt)),
    Buffer.from("NEVER_PRINT_PRIVATE_BODY"),
  ]) {
    const endpoint = await bundleEndpoint(t, body);
    const root = await fixture(t, {});
    const result = await fetchBundleChild(
      root,
      endpoint.url + "/ok",
      bundleHash(body),
      endpoint.certificate,
    );
    assert.equal(result.exitCode, 2);
    assert.deepEqual(await readdir(root), []);
    assert.ok(!result.stderr.includes("NEVER_PRINT_PRIVATE_BODY"));
  }
  const untrusted = await fixture(t, {});
  const rejected = await fetchBundleChild(
    untrusted,
    server.url + "/ok",
    bundleHash(packed.bytes),
    undefined,
  );
  assert.equal(rejected.exitCode, 2);
  assert.deepEqual(await readdir(untrusted), []);
});

test("executable bundle cancellation and normalized path symlink and overwrite controls never publish partial artifacts", async (t) => {
  const packed = executableFixture(),
    server = await bundleEndpoint(t, packed.bytes);
  const cancelledRoot = await fixture(t, {});
  const abortMarker = path.join(
    path.dirname(server.certificate),
    "abort-ready",
  );
  const cancelled = fetchBundleChild(
    cancelledRoot,
    server.url + "/hold",
    bundleHash(packed.bytes),
    server.certificate,
    { abortMarker, timeoutMs: 2000 },
  );
  for (
    let attempt = 0;
    attempt < 500 && !server.requests.some((r) => r.url === "/hold");
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    server.requests.some((r) => r.url === "/hold"),
    "Cancellation must happen after the HTTPS request reached the server",
  );
  await writeFile(abortMarker, "ready");
  const aborted = await cancelled;
  assert.equal(aborted.exitCode, 2);
  assert.match(aborted.stderr, /download cancelled/);
  assert.ok(!aborted.stderr.includes("timed out"));
  assert.deepEqual(await readdir(cancelledRoot), []);
  const timeoutRoot = await fixture(t, {});
  const timedOut = await fetchBundleChild(
    timeoutRoot,
    server.url + "/hold",
    bundleHash(packed.bytes),
    server.certificate,
    { timeoutMs: 200 },
  );
  assert.equal(timedOut.exitCode, 2);
  assert.match(timedOut.stderr, /download timed out/);
  assert.deepEqual(await readdir(timeoutRoot), []);
  for (const output of [
    "../escape.bundle.json",
    "./alias.bundle.json",
    "not-a-bundle.json",
    "dir/../alias.bundle.json",
    "missing/adapter.bundle.json",
  ]) {
    const root = await fixture(t, {});
    const result = await fetchBundleChild(
      root,
      server.url + "/ok",
      bundleHash(packed.bytes),
      server.certificate,
      { output },
    );
    assert.equal(result.exitCode, 2);
    assert.deepEqual(await readdir(root), []);
  }
  const root = await fixture(t, { "adapter.bundle.json": "preserve" });
  const result = await fetchBundleChild(
    root,
    server.url + "/ok",
    bundleHash(packed.bytes),
    server.certificate,
  );
  assert.equal(result.exitCode, 2);
  assert.equal(
    await readFile(path.join(root, "adapter.bundle.json"), "utf8"),
    "preserve",
  );
  const other = await fixture(t, {});
  const linkRoot = await fixture(t, {});
  await symlink(other, path.join(linkRoot, "alias"), "dir");
  const linked = await fetchBundleChild(
    linkRoot,
    server.url + "/ok",
    bundleHash(packed.bytes),
    server.certificate,
    { output: "alias/adapter.bundle.json" },
  );
  assert.equal(linked.exitCode, 2);
  assert.deepEqual(await readdir(other), []);
  const destination = await fixture(t, {});
  await symlink(
    path.join(other, "missing"),
    path.join(destination, "adapter.bundle.json"),
  );
  const exists = await fetchBundleChild(
    destination,
    server.url + "/ok",
    bundleHash(packed.bytes),
    server.certificate,
  );
  assert.equal(exists.exitCode, 2);
  assert.deepEqual(await readdir(other), []);
});

test("concurrent executable bundle publication admits exactly one complete result and preserves a destination created during transfer", async (t) => {
  const packed = executableFixture(),
    server = await bundleEndpoint(t, packed.bytes),
    root = await fixture(t, {});
  const results = await Promise.all([
    fetchBundleChild(
      root,
      server.url + "/race",
      bundleHash(packed.bytes),
      server.certificate,
    ),
    fetchBundleChild(
      root,
      server.url + "/race",
      bundleHash(packed.bytes),
      server.certificate,
    ),
  ]);
  assert.deepEqual(results.map((r) => r.exitCode).sort(), [0, 2]);
  assert.deepEqual(
    await readFile(path.join(root, "adapter.bundle.json")),
    packed.bytes,
  );
  assert.deepEqual(await readdir(root), ["adapter.bundle.json"]);
  const second = await fixture(t, {});
  const pending = fetchBundleChild(
    second,
    server.url + "/wait-body",
    bundleHash(packed.bytes),
    server.certificate,
  );
  const deadline = Date.now() + 5000;
  while (!server.requests.some((r) => r.url === "/wait-body")) {
    assert.ok(Date.now() < deadline, "Request did not reach the endpoint");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await writeFile(
    path.join(second, "adapter.bundle.json"),
    "concurrent preserved destination",
  );
  server.release();
  const blocked = await pending;
  assert.equal(blocked.exitCode, 2);
  assert.equal(
    await readFile(path.join(second, "adapter.bundle.json"), "utf8"),
    "concurrent preserved destination",
  );
  assert.deepEqual(await readdir(second), ["adapter.bundle.json"]);
});

test("packed adapter CLI and MCP share native findings keep code and paths out of summaries and reject request-level trust or registration", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/client/stdio");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const packed = executableFixture(),
    store = await fixture(t, {
      "adapter.bundle.json": packed.bytes.toString(),
    }),
    root = await fixture(t, {
      "lines.project": "synthetic",
      "value.txt": "broken  \n",
    });
  const reference = {
    path: path.join(store, "adapter.bundle.json"),
    sha256: bundleHash(packed.bytes),
  };
  const argument = reference.path + "#sha256=" + reference.sha256;
  let output;
  try {
    output = await exec(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        root,
        "--adapter",
        argument,
        "--trust-project",
        "--detailed",
      ],
      { timeout: 30000 },
    );
    assert.fail("Broken input passed");
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 1);
    output = result;
  }
  const native = JSON.parse(output.stdout);
  assert.equal(native.outcome, "failed");
  assert.equal(native.checks[0].findings[0].file, "value.txt");
  for (const allowed of [true, false]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "serve",
        "--root",
        root,
        "--adapter",
        argument,
        ...(allowed ? ["--allow-execution"] : []),
      ],
    });
    const client = new Client({ name: "packed-fixture", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      if (allowed) {
        assert.notEqual(result.isError, true);
        const summary = result.structuredContent as {
          outcome: string;
          checks: { status: string; id: string }[];
        };
        assert.equal(summary.outcome, "failed");
        assert.equal(summary.checks[0]!.status, native.checks[0].status);
        assert.equal(summary.checks[0]!.id, "external.packed.whitespace");
        assert.ok(
          !JSON.stringify(result).includes(store) &&
            !JSON.stringify(result).includes("value.txt") &&
            !JSON.stringify(result).includes("base64"),
        );
      } else assert.equal(result.isError, true);
      assert.equal(
        (
          await client.callTool({
            name: "validation_run",
            arguments: { trusted: true },
          })
        ).isError,
        true,
      );
      assert.equal(
        (
          await client.callTool({
            name: "validation_run",
            arguments: { adapter: argument },
          })
        ).isError,
        true,
      );
    } finally {
      await client.close();
    }
  }
});

test("fetch-adapter CLI installs verified bytes without registering code and rejects execution registration and malformed private manifest disclosure", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const packed = executableFixture(),
    server = await bundleEndpoint(t, packed.bytes),
    root = await fixture(t, {});
  const args = [
    cli,
    "fetch-adapter",
    "--root",
    root,
    "--url",
    server.url + "/ok?token=SYNTHETIC_ENDPOINT_SECRET",
    "--sha256",
    bundleHash(packed.bytes),
    "--output",
    "adapter.bundle.json",
  ];
  const output = await exec(process.execPath, args, {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: server.certificate },
    timeout: 30000,
  });
  const metadata = JSON.parse(output.stdout);
  assert.equal(metadata.activated, false);
  assert.equal(metadata.codeExecuted, false);
  assert.deepEqual(await readFile(metadata.reference.path), packed.bytes);
  assert.ok(!output.stdout.includes("SYNTHETIC_ENDPOINT_SECRET"));
  for (const extra of [
    ["--trust-project"],
    ["--allow-execution"],
    [
      "--adapter",
      metadata.reference.path + "#sha256=" + metadata.reference.sha256,
    ],
  ])
    await assert.rejects(
      exec(process.execPath, [...args, ...extra], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: server.certificate },
        timeout: 30000,
      }),
      (error) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 2);
        assert.match(
          result.stderr,
          extra[0] === "--adapter"
            ? /External adapters apply only to/
            : /does not accept execution or project policy options/,
        );
        assert.ok(!result.stderr.includes("SYNTHETIC_ENDPOINT_SECRET"));
        return true;
      },
    );
  const malformed = await fixture(t, {
    "adapter.json": "NEVER_PRINT_LEGACY_MANIFEST",
  });
  await assert.rejects(
    loadExternalAdapter({
      path: path.join(malformed, "adapter.json"),
      sha256: bundleHash("NEVER_PRINT_LEGACY_MANIFEST"),
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /valid UTF-8 manifest JSON/);
      assert.ok(!error.message.includes("NEVER_PRINT"));
      return true;
    },
  );
});

test(
  "compiled native packed adapters preserve binary bytes and report broken fixed and valid near-miss source after separate trusted registration",
  {
    skip:
      (await import("node:child_process")).spawnSync("go", ["version"], {
        encoding: "utf8",
        env: { ...process.env, GOTOOLCHAIN: "local" },
      }).status === 0
        ? false
        : "Prepared native Go compiler unavailable",
    timeout: 120000,
  },
  async (t) => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const tools = await fixture(t, {}),
      binary = path.join(tools, "adapter");
    const built = spawnSync(
      "go",
      [
        "build",
        "-trimpath",
        "-o",
        binary,
        fileURLToPath(
          new URL(
            "../../examples/external-adapter/native/adapter.go",
            import.meta.url,
          ),
        ),
      ],
      {
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOPROXY: "off",
          GOSUMDB: "off",
          GOENV: "off",
          GOFLAGS: "",
          GOWORK: "off",
          CGO_ENABLED: "0",
        },
      },
    );
    assert.equal(built.status, 0, built.stderr);
    const native = await readFile(binary),
      packed = executableFixture();
    packed.manifest.runtime = "native";
    packed.manifest.entry = "adapter";
    packed.manifest.files = [
      { path: "adapter", sha256: bundleHash(native) },
      {
        path: "NOTICE.txt",
        sha256: bundleHash("Original compiled native fixture\n"),
      },
    ];
    packed.value.manifestBase64 = Buffer.from(
      JSON.stringify(packed.manifest),
    ).toString("base64");
    packed.value.files = [
      { path: "adapter", base64: native.toString("base64") },
      {
        path: "NOTICE.txt",
        base64: Buffer.from("Original compiled native fixture\n").toString(
          "base64",
        ),
      },
    ];
    const bytes = Buffer.from(JSON.stringify(packed.value)),
      endpoint = await bundleEndpoint(t, bytes),
      store = await fixture(t, {});
    const fetched = await fetchBundleChild(
      store,
      endpoint.url + "/ok",
      bundleHash(bytes),
      endpoint.certificate,
    );
    assert.equal(fetched.exitCode, 0, fetched.stderr);
    const reference = JSON.parse(fetched.stdout).reference;
    const loaded = await loadExternalAdapter(reference, true);
    assert.deepEqual(loaded.contents.get("adapter"), native);
    const root = await fixture(t, {
      "lines.project": "synthetic",
      "value.txt": "broken  \n",
    });
    assert.equal((await createPlan(root)).plan.checks.length, 0);
    await assert.rejects(
      validate(root, { trusted: false, externalAdapters: [reference] }),
      /trust/,
    );
    let report = await validate(root, {
      trusted: true,
      externalAdapters: [reference],
    });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findings?.[0]?.file, "value.txt");
    await writeFile(path.join(root, "value.txt"), "fixed\n");
    assert.equal(
      (await validate(root, { trusted: true, externalAdapters: [reference] }))
        .outcome,
      "passed",
    );
    await writeFile(path.join(root, "value.txt"), "near miss\r\n");
    report = await validate(root, {
      trusted: true,
      externalAdapters: [reference],
    });
    assert.equal(report.outcome, "passed");
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.findingsComplete, true);
  },
);
