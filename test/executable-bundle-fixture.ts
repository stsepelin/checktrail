import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
export const bundleHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const bundleSample = await readFile(
  new URL(
    "../../examples/external-adapter/bundle/adapter.mjs",
    import.meta.url,
  ),
  "utf8",
);
export function executableFixture(
  program = bundleSample,
  extra: Record<string, Buffer | string> = {
    "NOTICE.txt": "Original synthetic adapter material\n",
  },
) {
  const files = { "adapter.mjs": program, ...extra };
  const manifest = {
    schemaVersion: 1,
    id: "external.packed",
    version: "1.0.0",
    description: "Original synthetic packed adapter",
    runtime: "node",
    entry: "adapter.mjs",
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      sha256: bundleHash(bytes),
    })),
    markers: ["lines.project"],
    checks: [
      {
        id: "whitespace",
        kind: "format",
        description: "Synthetic whitespace control",
        failOn: "error",
        scope: { extensions: [".txt"], names: [] },
      },
    ],
  };
  const value = {
    schemaVersion: 1,
    kind: "checktrail-executable-bundle",
    manifestBase64: Buffer.from(JSON.stringify(manifest)).toString("base64"),
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      base64: Buffer.from(bytes).toString("base64"),
    })),
  };
  return { manifest, value, bytes: Buffer.from(JSON.stringify(value)) };
}
export async function bundleEndpoint(t: TestContext, body: Buffer) {
  const root = await fixture(t, {
    "certificate.conf":
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n",
  });
  const certificate = path.join(root, "cert.pem"),
    key = path.join(root, "key.pem");
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
  const waiting: import("node:http").ServerResponse[] = [];
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
        waiting.push(res);
        if (waiting.length === 2)
          for (const response of waiting) response.end(body);
      } else if (pathname === "/wait-body") {
        waiting.push(res);
        res.writeHead(200);
        res.flushHeaders();
      } else if (pathname === "/redirect") {
        res.writeHead(302, { Location: "/ok" });
        res.end();
      } else if (pathname === "/status") {
        res.writeHead(503);
        res.end("NEVER_PRINT_UPSTREAM_BODY");
      } else if (pathname === "/encoded") {
        res.writeHead(200, { "Content-Encoding": "gzip" });
        res.end(body);
      } else if (pathname === "/oversized") {
        res.writeHead(200, { "Content-Length": String(192 * 1024 * 1024 + 1) });
        res.flushHeaders();
      } else if (pathname === "/truncated") {
        res.writeHead(200, { "Content-Length": String(body.length + 100) });
        res.end(body);
      } else if (pathname === "/hold") {
        res.writeHead(200);
        res.flushHeaders();
      } else res.end(body);
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    url: `https://127.0.0.1:${address.port}`,
    certificate,
    requests,
    release() {
      for (const response of waiting)
        if (!response.writableEnded) response.end(body);
    },
  };
}
const exec = promisify(execFile);
export async function fetchBundleChild(
  root: string,
  url: string,
  sha256: string,
  certificate: string | undefined,
  extra: Record<string, unknown> = {},
) {
  const index = new URL("../src/index.js", import.meta.url).href;
  const script = `import {fetchExternalAdapter} from ${JSON.stringify(index)};import {existsSync} from "node:fs";const [root,url,sha256,extra]=process.argv.slice(1);const options=JSON.parse(extra);const controller=new AbortController();let poll;if(options.abortMarker!==undefined){const marker=options.abortMarker;delete options.abortMarker;poll=setInterval(()=>{if(existsSync(marker))controller.abort();},10);}try{console.log(JSON.stringify(await fetchExternalAdapter(root,{url,sha256,output:"adapter.bundle.json",...options,signal:controller.signal})));}catch(error){console.error(error.message);process.exitCode=2;}finally{clearInterval(poll);}`;
  try {
    const result = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        root,
        url,
        sha256,
        JSON.stringify(extra),
      ],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate ?? "" },
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { exitCode: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
