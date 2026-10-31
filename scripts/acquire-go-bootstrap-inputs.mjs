// Data-only official archive acquisition. It never runs Go or project code.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const { AbortSignal } = globalThis;
import { physicalPath } from "./qualify-binutils-producer.mjs";
import { loadGoBootstrapCatalog } from "./producer-qualification/go-bootstrap-profile.mjs";
export function goArchiveRows(catalog) {
  return catalog.profiles.map((row) => ({
    file: row.sourceArchive.url.split("/").at(-1),
    url: row.sourceArchive.url,
    bytes: row.sourceArchive.bytes,
    sha256: row.sourceArchive.sha256,
  }));
}
function closedArchiveUrl(url, filename) {
  const parsed = new URL(url);
  assert.ok(
    parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      !parsed.search &&
      !parsed.hash,
  );
  assert.ok(
    (parsed.hostname === "go.dev" && parsed.pathname === "/dl/" + filename) ||
      (parsed.hostname === "dl.google.com" &&
        parsed.pathname === "/go/" + filename),
    "Unapproved Go source archive redirect",
  );
  return parsed.href;
}
export async function downloadGoArchive(
  row,
  directory,
  fetcher = globalThis.fetch,
) {
  assert.match(
    row.file,
    /^go(?:1\.[0-9]+\.[0-9]+\.src|1\.4-bootstrap-20171003)\.tar\.gz$/u,
  );
  assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    Number.isSafeInteger(row.bytes) &&
      row.bytes > 0 &&
      row.bytes <= 64 * 1024 ** 2,
  );
  let url = closedArchiveUrl(row.url, row.file),
    response;
  const signal = AbortSignal.timeout(120000),
    redirects = [];
  for (let i = 0; i <= 4; i++) {
    response = await fetcher(url, {
      redirect: "manual",
      signal,
      headers: { "accept-encoding": "identity" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    assert.ok(i < 4, "Go source redirect bound exceeded");
    const next = response.headers.get("location");
    assert.ok(next);
    await response.body?.cancel();
    url = closedArchiveUrl(new URL(next, url).href, row.file);
    redirects.push(url);
  }
  assert.equal(response.status, 200, "Official Go source archive unavailable");
  assert.ok(response.body, "Official Go archive body missing");
  const encoding = response.headers.get("content-encoding");
  assert.ok(
    !encoding || encoding === "identity",
    "Encoded transport changes original archive bytes",
  );
  const length = response.headers.get("content-length");
  if (length !== null)
    assert.equal(
      length,
      String(row.bytes),
      "Go archive Content-Length differs from pin",
    );
  const partial = path.join(directory, row.file + ".partial"),
    target = path.join(directory, row.file);
  const handle = await open(
    partial,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    for await (const chunk of response.body) {
      assert.ok(!signal.aborted, "Go source acquisition deadline");
      bytes += chunk.length;
      assert.ok(bytes <= row.bytes, "Go source body exceeds pinned byte bound");
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(
          chunk,
          written,
          chunk.length - written,
        );
        assert.ok(result.bytesWritten > 0);
        written += result.bytesWritten;
      }
    }
    assert.equal(bytes, row.bytes, "Go source archive is incomplete");
    assert.equal(
      hash.digest("hex"),
      row.sha256,
      "Go source archive byte digest differs",
    );
    await handle.sync();
  } finally {
    await handle.close();
    await response.body.cancel?.().catch(() => {});
  }
  await assert.rejects(
    lstat(target),
    (error) => error.code === "ENOENT",
    "Existing archive destination refused",
  );
  await rename(partial, target);
  return {
    file: row.file,
    bytes,
    sha256: row.sha256,
    source: row.url,
    finalUrl: url,
    redirects,
  };
}
export async function acquireGoBootstrapInputs(
  output,
  fetcher = globalThis.fetch,
) {
  const catalog = await loadGoBootstrapCatalog(),
    destination = path.resolve(output);
  await physicalPath(path.dirname(destination), true);
  await assert.rejects(
    lstat(destination),
    (error) => error.code === "ENOENT",
    "Go acquisition destination must be new",
  );
  await mkdir(destination, { mode: 0o700 });
  const directory = path.join(destination, "archives");
  await mkdir(directory, { mode: 0o700 });
  const result = {
    schemaVersion: 1,
    state: "acquiring",
    archives: [],
    buildExecuted: false,
    projectCodeExecuted: false,
    inferenceInvoked: false,
    gateAComplete: false,
  };
  const save = async () => {
    const temporary = path.join(destination, "acquisition.next.json");
    await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path.join(destination, "acquisition.json"));
  };
  await save();
  try {
    for (const row of goArchiveRows(catalog)) {
      result.archives.push(await downloadGoArchive(row, directory, fetcher));
      await save();
    }
    result.state = "acquired";
    await save();
    return result;
  } catch (error) {
    result.state = "failed";
    result.failure = String(error);
    await save();
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(process.argv.length, 3, "Pass one new archive destination");
    const report = await acquireGoBootstrapInputs(process.argv[2]);
    process.stdout.write(JSON.stringify(report) + "\n");
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
