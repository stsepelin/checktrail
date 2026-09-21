import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import {
  access,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchPolicyPack } from "../src/fetch-pack.js";
import { createPlan } from "../src/engine.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

const installed = process.env.REPO_VERIFIER_TEST_PACKAGE;
const cli = installed
  ? path.join(installed, "dist/src/cli.js")
  : fileURLToPath(new URL("../src/cli.js", import.meta.url));
const index = installed
  ? pathToFileURL(path.join(installed, "dist/src/index.js")).href
  : new URL("../src/index.js", import.meta.url).href;
const pack = {
  schemaVersion: 1,
  id: "synthetic.remote",
  version: "1.0.0",
  description: "Original remote policy fixture",
  requiredChecks: ["javascript.node-test"],
};
const bytes = Buffer.from(JSON.stringify(pack));
const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
const invalidUTF8 = Buffer.from(bytes);
invalidUTF8[bytes.indexOf("Original")] = 0xff;
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

async function endpoint(t: TestContext) {
  const root = await fixture(t, {
    "certificate.conf":
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n",
  });
  const certificate = path.join(root, "cert.pem");
  const key = path.join(root, "key.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      path.join(root, "certificate.conf"),
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const requests: {
    url: string;
    method: string;
    authorization: string | undefined;
  }[] = [];
  const pending: ServerResponse[] = [];
  const server = createServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (req, res) => {
      requests.push({
        url: req.url!,
        method: req.method!,
        authorization: req.headers.authorization,
      });
      const pathname = new URL(req.url!, "https://localhost").pathname;
      if (pathname === "/race") {
        pending.push(res);
        if (pending.length === 2)
          for (const response of pending) response.end(bytes);
      } else if (pathname === "/redirect") {
        res.writeHead(302, { Location: "/ok" });
        res.end();
      } else if (pathname === "/status") {
        res.writeHead(500);
        res.end("private upstream error");
      } else if (pathname === "/encoded") {
        res.writeHead(200, { "Content-Encoding": "gzip" });
        res.end(bytes);
      } else if (pathname === "/large") {
        res.writeHead(200, { "Transfer-Encoding": "chunked" });
        res.end(Buffer.alloc(65537, 32));
      } else if (pathname === "/declared-large") {
        res.writeHead(200, { "Content-Length": "65537" });
        res.end();
      } else if (pathname === "/truncated") {
        res.writeHead(200, { "Content-Length": bytes.length + 1 });
        res.write(bytes);
        res.destroy();
      } else if (pathname === "/slow") {
        res.writeHead(200);
        res.flushHeaders();
      } else if (pathname === "/bom") res.end(bom);
      else if (pathname === "/invalid-utf8") res.end(invalidUTF8);
      else if (pathname === "/invalid") res.end("invalid JSON");
      else if (pathname === "/duplicate")
        res.end(
          JSON.stringify({
            ...pack,
            requiredChecks: [...pack.requiredChecks, ...pack.requiredChecks],
          }),
        );
      else res.end(bytes);
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `https://127.0.0.1:${address.port}`;
  function run(
    args: string[],
    trusted = true,
    onStart?: (child: ReturnType<typeof execFile>) => void,
  ) {
    return new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        const env = { ...process.env };
        delete env.NODE_EXTRA_CA_CERTS;
        if (trusted) env.NODE_EXTRA_CA_CERTS = certificate;
        const child = execFile(
          process.execPath,
          args,
          { env, timeout: 10_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            resolve({
              code: error ? Number(error.code) || 2 : 0,
              stdout,
              stderr,
            });
          },
        );
        onStart?.(child);
      },
    );
  }
  return { base, requests, run, server };
}
function args(
  root: string,
  url: string,
  sha256 = hash(bytes),
  output = "policy.json",
  timeout = 5000,
) {
  return [
    cli,
    "fetch-pack",
    "--root",
    root,
    "--url",
    url,
    "--sha256",
    sha256,
    "--output",
    output,
    "--timeout-ms",
    String(timeout),
  ];
}

test("remote policy downloads pin exact bytes, compose offline and publish without replacing concurrent files", async (t) => {
  const remote = await endpoint(t);
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "test.test.js": passingTest,
  });
  const result = await remote.run(
    args(root, `${remote.base}/ok?signature=synthetic-secret`),
  );
  assert.equal(result.code, 0, result.stderr);
  const downloaded = JSON.parse(result.stdout);
  assert.deepEqual(downloaded.reference, {
    path: "policy.json",
    sha256: hash(bytes),
  });
  assert.equal(downloaded.id, pack.id);
  assert.equal(downloaded.bytes, bytes.length);
  assert.ok(!result.stdout.includes(remote.base));
  assert.ok(!result.stdout.includes("synthetic-secret"));
  assert.deepEqual(await readFile(path.join(root, "policy.json")), bytes);
  assert.equal(
    (await stat(path.join(root, "policy.json"))).mode & 0o777,
    0o600,
  );
  await writeFile(
    path.join(root, "repo-verifier.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: [], packs: [downloaded.reference] }],
    }),
  );
  assert.deepEqual(
    (await createPlan(root)).plan.checks.map((check) => check.id),
    ["javascript.node-test"],
  );
  const refused = await remote.run(args(root, `${remote.base}/ok`));
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /already exists/);
  assert.equal(remote.requests.length, 1);
  const raced = await Promise.all([
    remote.run(args(root, `${remote.base}/race`, hash(bytes), "race.json")),
    remote.run(args(root, `${remote.base}/race`, hash(bytes), "race.json")),
  ]);
  assert.deepEqual(raced.map((item) => item.code).sort(), [0, 2]);
  assert.deepEqual(await readFile(path.join(root, "race.json")), bytes);
  assert.ok(
    !(await readdir(root)).some((name) =>
      name.startsWith(".repo-verifier-pack-"),
    ),
  );
  assert.ok(
    remote.requests.every(
      (request) =>
        request.method === "GET" && request.authorization === undefined,
    ),
  );
  const library = await remote.run([
    "--input-type=module",
    "-e",
    `import {fetchPolicyPack} from ${JSON.stringify(index)}; console.log(JSON.stringify(await fetchPolicyPack(process.argv[1], JSON.parse(process.argv[2]))));`,
    root,
    JSON.stringify({
      url: `${remote.base}/ok`,
      sha256: hash(bytes),
      output: "library.json",
    }),
  ]);
  assert.equal(library.code, 0, library.stderr);
  assert.deepEqual(JSON.parse(library.stdout).reference, {
    path: "library.json",
    sha256: hash(bytes),
  });
});

test("remote policy transport and content failures leave no files or private endpoint diagnostics", async (t) => {
  const remote = await endpoint(t);
  const root = await fixture(t, {});
  const cases: [string, string, RegExp][] = [
    ["ok", "0".repeat(64), /integrity mismatch/],
    ["redirect", hash(bytes), /redirects are not followed/],
    ["status", hash(bytes), /HTTP 200/],
    ["encoded", hash(bytes), /content encoding/],
    ["large", hash(bytes), /64 KiB/],
    ["declared-large", hash(bytes), /exceeds limits/],
    ["truncated", hash(bytes), /failed|incomplete/],
    ["invalid", hash("invalid JSON"), /not valid/],
    ["bom", hash(bom), /not valid/],
    ["invalid-utf8", hash(invalidUTF8), /not valid/],
    [
      "duplicate",
      hash(
        JSON.stringify({
          ...pack,
          requiredChecks: [...pack.requiredChecks, ...pack.requiredChecks],
        }),
      ),
      /not valid/,
    ],
    ["slow", hash(bytes), /timed out/],
  ];
  for (const [route, digest, expected] of cases) {
    const result = await remote.run(
      args(
        root,
        `${remote.base}/${route}?token=synthetic-secret`,
        digest,
        "policy.json",
        route === "slow" ? 100 : 5000,
      ),
    );
    assert.equal(result.code, 2, route);
    assert.match(result.stderr, expected);
    assert.ok(!result.stderr.includes("synthetic-secret"));
    assert.ok(!result.stderr.includes(remote.base));
    assert.equal(result.stdout, "");
    assert.deepEqual(await readdir(root), []);
  }
  assert.equal(
    remote.requests.filter((request) => request.url.startsWith("/ok")).length,
    1,
  );
  const untrusted = await remote.run(args(root, `${remote.base}/ok`), false);
  assert.equal(untrusted.code, 2);
  assert.match(untrusted.stderr, /HTTPS connection failed/);
  assert.deepEqual(await readdir(root), []);
});

test("remote pack cancellation after connection and invalid output boundaries never publish content", async (t) => {
  const remote = await endpoint(t);
  const root = await fixture(t, {});
  let child: ReturnType<typeof execFile> | undefined;
  const observed = once(remote.server, "request");
  const execution = remote.run(
    args(root, `${remote.base}/slow`),
    true,
    (value) => {
      child = value;
    },
  );
  try {
    await observed;
    assert.ok(child);
    child.kill("SIGINT");
    const result = await execution;
    assert.equal(result.code, 2);
    assert.match(result.stderr, /cancelled/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    child?.kill("SIGKILL");
  }
  const outside = await fixture(t, {});
  await symlink(outside, path.join(root, "linked"));
  const base = {
    url: `${remote.base}/ok`,
    sha256: hash(bytes),
    output: "policy.json",
  };
  for (const output of [
    "../escape.json",
    "/absolute.json",
    "linked/escape.json",
    "nested/../bad.json",
    "not-json",
    "a\\b.json",
  ]) {
    await assert.rejects(fetchPolicyPack(root, { ...base, output }));
  }
  for (const url of [
    "http://localhost/pack",
    "https://user:password@localhost/pack",
    "https://localhost/pack#fragment",
    "not-a-url",
  ]) {
    await assert.rejects(fetchPolicyPack(root, { ...base, url }));
  }
  await assert.rejects(
    fetchPolicyPack(root, { ...base, signal: AbortSignal.abort() }),
    /cancelled/,
  );
  await assert.rejects(access(path.join(root, "policy.json")));
  assert.deepEqual(await readdir(outside), []);
  assert.equal(remote.requests.length, 1);
});
