// Trusted signed-distribution cache APIs only. Run with Node child-process permissions denied.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
const [root, catalogFile] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.ok(path.isAbsolute(root) && path.isAbsolute(catalogFile));
const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
const require = createRequire(path.join(root, "npm-tool/package.json"));
const cacache = require("cacache"),
  pacote = require("pacote");
assert.equal(require("./package.json").version, catalog.versions.npmVersion);
assert.equal(require("cacache/package.json").version, "20.0.4");
assert.equal(require("pacote/package.json").version, "21.5.1");
const cache = path.join(root, "npm-cache/_cacache");
await mkdir(cache, { recursive: true });
const sri = (body) =>
  "sha512-" + createHash("sha512").update(body).digest("base64");
const options = (row) => ({
  cache,
  tufCache: path.join(root, "npm-cache/_tuf"),
  integrity: row.integrity,
  resolved: row.url,
  offline: true,
  preferOnline: false,
  preferOffline: true,
  ignoreScripts: true,
  registry: "https://registry.npmjs.org/",
  npmBin: path.join(root, "NO_PROJECT_HOOK_EXECUTABLE"),
});
for (const row of catalog.npm) {
  const url = new URL(row.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "registry.npmjs.org");
  const body = await readFile(
    path.join(root, "downloads/npm/" + row.sha256 + ".tgz"),
  );
  assert.equal(sri(body), row.integrity);
  await cacache.put(cache, "pacote:tarball:" + row.url, body, {
    integrity: row.integrity,
    algorithms: ["sha512"],
  });
}
const verify = async () => {
  for (const row of catalog.npm) {
    const body = await pacote.tarball(row.url, options(row));
    assert.equal(body.length, row.bytes);
    assert.equal(sri(body), row.integrity);
  }
};
await verify();
const row = catalog.npm[0],
  info = await cacache.get.info(cache, "pacote:tarball:" + row.url);
assert.ok(info?.path.startsWith(cache + path.sep));
const before = await readFile(info.path),
  changed = Buffer.from(before);
changed[changed.length - 1] ^= 1;
await writeFile(info.path, changed);
try {
  await assert.rejects(pacote.tarball(row.url, options(row)), (error) =>
    ["ENOTCACHED", "EINTEGRITY", "Z_DATA_ERROR"].includes(error.code),
  );
} finally {
  await cacache.put(cache, "pacote:tarball:" + row.url, before, {
    integrity: row.integrity,
    algorithms: ["sha512"],
  });
}
await verify();
await writeFile(
  path.join(root, "npm-cache-proof.json"),
  JSON.stringify({
    schemaVersion: 1,
    lockedPaths: catalog.npm.length,
    offlineReads: catalog.npm.length,
    corruptPayloadRejected: true,
    restoredReads: catalog.npm.length,
    projectHooksExecuted: false,
    compilerExecuted: false,
    originalNpmCiExecuted: false,
  }) + "\n",
  { flag: "wx", mode: 0o600 },
);
