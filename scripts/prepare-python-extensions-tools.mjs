import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { pythonExtensionPins } from "../dist/src/python-extension-pins.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(repository, ".checktrail/python-extension-tools");
const records = JSON.parse(
  await readFile(
    new URL("./python-extensions-wheels.json", import.meta.url),
    "utf8",
  ),
);
assert.ok(Array.isArray(records) && records.length === 12);
assert.equal(new Set(records.map((r) => r.distribution)).size, records.length);
for (const r of records) {
  assert.match(r.distribution, /^[a-zA-Z0-9_-]+$/);
  assert.match(r.version, /^\d+(?:\.\d+){1,3}$/);
  assert.match(r.wheel, /^[a-zA-Z0-9_.-]+\.whl$/);
  assert.match(r.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(r.bytes) && r.bytes > 0 && r.bytes <= 32 * 1048576,
  );
  const url = new URL(r.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "files.pythonhosted.org");
  assert.equal(path.posix.basename(url.pathname), r.wheel);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
}
assert.ok(records.reduce((n, r) => n + r.bytes, 0) <= 64 * 1048576);
await assert.rejects(access(destination), { code: "ENOENT" });
await mkdir(path.dirname(destination), { recursive: true });
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "python-extension-prepare-"),
);
const wheels = path.join(temporary, "wheels"),
  tools = path.join(temporary, "tools");
await mkdir(wheels);
await mkdir(tools);
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `python-extension-prepare-${process.pid}`;
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const image =
  "public.ecr.aws/docker/library/python@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df";
let committed = false;
try {
  for (const r of records) {
    const response = await globalThis.fetch(r.url, {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(60000),
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      assert.ok(size <= r.bytes, "Wheel response exceeded its frozen size");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks, size);
    assert.equal(size, r.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), r.sha256);
    await writeFile(path.join(wheels, r.wheel), bytes, { flag: "wx" });
  }
  await writeFile(
    path.join(wheels, "requirements.txt"),
    records
      .map(
        (r) =>
          `${r.distribution} @ file:///wheels/${r.wheel} --hash=sha256:${r.sha256}`,
      )
      .join("\n") + "\n",
    { flag: "wx" },
  );
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "--read-only",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--pids-limit",
      "256",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=256m",
      "--label",
      "checktrail.task=" + task,
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,src=${wheels},target=/wheels,readonly`,
      "--mount",
      `type=bind,src=${tools},target=/prepared`,
      image,
      "python3",
      "-I",
      "-m",
      "pip",
      "--isolated",
      "install",
      "--disable-pip-version-check",
      "--no-cache-dir",
      "--no-compile",
      "--no-deps",
      "--require-hashes",
      "--target",
      "/prepared",
      "-r",
      "/wheels/requirements.txt",
    ],
    { encoding: "utf8", timeout: 180000, stdio: ["ignore", "ignore", "pipe"] },
  );
  for (const pin of pythonExtensionPins) {
    const bytes = await readFile(path.join(tools, pin.file));
    assert.equal(bytes.length, pin.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
  }
  await assert.rejects(access(destination), { code: "ENOENT" });
  await rename(tools, destination);
  committed = true;
  process.stdout.write(
    JSON.stringify({
      distributions: records.length,
      wheels: records.map((r) => ({
        distribution: r.distribution,
        version: r.version,
        wheel: r.wheel,
        bytes: r.bytes,
        sha256: r.sha256,
      })),
      nativePreparationImage: image,
      lifecycleSourceBuildsExecuted: false,
      dependencyRangeResolutionPerformed: false,
      wholePublisherLicenseClosureVerified: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
  if (!committed) await assert.rejects(access(destination), { code: "ENOENT" });
}
