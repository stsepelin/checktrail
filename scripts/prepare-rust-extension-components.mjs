import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  readFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parse } from "smol-toml";
const root = fileURLToPath(new URL("../", import.meta.url));
const pins = JSON.parse(
  await readFile(
    new URL("rust-extension-components.json", import.meta.url),
    "utf8",
  ),
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const prepared = process.env.CHECKTRAIL_RUST_COMPONENTS_DIRECTORY;
if (prepared) assert.ok(path.isAbsolute(prepared));
async function load(file, url, expected, max) {
  const bytes = prepared
    ? await readFile(path.join(prepared, file))
    : await (async () => {
        const response = await globalThis.fetch(url, {
          signal: globalThis.AbortSignal.timeout(120000),
        });
        assert.ok(response.ok, "Native archive HTTP status " + response.status);
        const declared = response.headers.get("content-length");
        if (declared !== null)
          assert.ok(
            Number.isSafeInteger(Number(declared)) &&
              Number(declared) >= 0 &&
              Number(declared) <= max,
            "Native archive declared byte bound",
          );
        assert.ok(response.body, "Native archive body unavailable");
        const chunks = [];
        let total = 0;
        for await (const chunk of response.body) {
          total += chunk.length;
          assert.ok(total <= max, "Native archive streaming byte bound");
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks, total);
      })();
  assert.ok(bytes.length <= max, "Native archive byte bound");
  assert.equal(hash(bytes), expected, "Native archive SHA256 " + file);
  return bytes;
}
const manifest = await load(
  "channel-rust-1.98.1.toml",
  pins.manifestUrl,
  pins.manifestSha256,
  1048576,
);
const parsed = parse(manifest.toString("utf8"));
assert.equal(parsed.date, "2026-09-03");
const artifacts = [];
for (const row of pins.records) {
  assert.match(row.file, /^[a-z0-9.-]+\.tar\.xz$/);
  assert.ok(row.bytes > 0 && row.bytes < 128 * 1048576);
  const declared = parsed.pkg[row.name].target[row.target];
  assert.equal(declared.xz_url, row.url);
  assert.equal(declared.xz_hash, row.sha256);
  const bytes = await load(row.file, row.url, row.sha256, 128 * 1048576);
  assert.equal(bytes.length, row.bytes);
  artifacts.push({ file: row.file, bytes });
}
const parent = path.join(root, ".checktrail");
await mkdir(parent, { recursive: true });
const target = path.join(parent, "rust-extension-components");
const old = await readFile(path.join(target, "SHA256SUMS"), "utf8").catch(
  (e) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  },
);
const sums =
  pins.records.map((r) => r.sha256 + "  " + r.file).join("\n") + "\n";
if (old !== null) {
  assert.equal(old, sums);
  for (const row of pins.records)
    assert.equal(hash(await readFile(path.join(target, row.file))), row.sha256);
} else {
  const stage = await mkdtemp(path.join(parent, "rust-extension-stage-"));
  try {
    for (const artifact of artifacts)
      await writeFile(path.join(stage, artifact.file), artifact.bytes, {
        flag: "wx",
      });
    await writeFile(path.join(stage, "SHA256SUMS"), sums, { flag: "wx" });
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
process.stdout.write(
  JSON.stringify({
    version: pins.version,
    manifestSha256: pins.manifestSha256,
    archives: pins.records.length,
    bytes: artifacts.reduce((sum, a) => sum + a.bytes.length, 0),
    allArchivesMatch: true,
    signatureVerified: false,
    extractionPerformed: false,
    wholeDependencyClosureVerified: false,
    publisherLicenseClosureVerified: false,
  }) + "\n",
);
