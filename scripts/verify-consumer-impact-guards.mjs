import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const broken =
  "captured imports expose an undeclared consumer and full validation retains its native failure";
const bridges =
  "captured file edges follow reexports and unowned bridges without treating a project prefix as ownership";
const bounded =
  "stale, excluded, empty, unsupported and exhausted import observations stay unknown";
const controls = [
  {
    id: "commonjs-module-loader",
    file: "consumer-imports.js",
    from: '"module",',
    to: "",
    name: "CommonJS module loaders retain full validation and its actual consumer assertion failure",
  },
  {
    id: "engine-fallback",
    file: "engine.js",
    from: 'imports.status !== "resolved"',
    to: "false",
    name: broken,
  },
  {
    id: "declared-edge",
    file: "consumer-imports.js",
    from: "if (!seen.has(edge.producer))",
    to: "if (false)",
    name: broken,
  },
  {
    id: "shared-bridge",
    file: "consumer-imports.js",
    from: "pending.push(...(graph.get(target) ?? []));",
    to: "pending.push();",
    name: bridges,
  },
  {
    id: "resource-edge",
    file: "consumer-imports.js",
    from: "add(file, resolve(file, url.arguments[0].text, true));",
    to: "void file;",
    name: "literal shared JSON reads reconcile the physical producer for named synchronous and asynchronous readers",
  },
  {
    id: "current-source",
    file: "consumer-imports.js",
    from: "(await inventory(source.root)).fingerprint !== source.fingerprint",
    to: "false",
    name: bounded,
  },
  {
    id: "file-bound",
    file: "consumer-imports.js",
    from: "++parsedFiles > 512",
    to: "++parsedFiles > 20000",
    name: bounded,
  },
  {
    id: "byte-bound",
    file: "consumer-imports.js",
    from: "Math.min(4 * 1048576, 16 * 1048576 - bytes)",
    to: "Math.min(8 * 1048576, 16 * 1048576 - bytes)",
    name: bounded,
  },
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originals = new Map();
for (const d of controls) {
  if (!originals.has(d.file))
    originals.set(
      d.file,
      await readFile(path.join(repository, "dist/src", d.file), "utf8"),
    );
  assert.equal(originals.get(d.file).split(d.from).length, 2, d.id);
}
const testFiles = ["consumer-imports.test.js", "helpers.js", "git-fixture.js"];
const harness = await Promise.all(
  testFiles.map(async (file) => ({
    file,
    bytes: await readFile(path.join(repository, "dist/test", file)),
  })),
);
const harnessSha256 = hash(
  JSON.stringify(harness.map((x) => [x.file, hash(x.bytes)])),
);
const mirror = await mkdtemp(
  path.join(tmpdir(), "checktrail-consumer-guards-"),
);
const observed = [];
try {
  await mkdir(path.join(mirror, "dist/test"), { recursive: true });
  await cp(path.join(repository, "dist/src"), path.join(mirror, "dist/src"), {
    recursive: true,
  });
  await cp(
    path.join(repository, "package.json"),
    path.join(mirror, "package.json"),
  );
  await symlink(
    path.join(repository, "node_modules"),
    path.join(mirror, "node_modules"),
  );
  for (const { file, bytes } of harness)
    await writeFile(path.join(mirror, "dist/test", file), bytes, {
      flag: "wx",
    });
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const invoke = (args) =>
    spawnSync(process.execPath, args, {
      cwd: mirror,
      env: environment,
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 2 * 1048576,
    });
  const run = (name) =>
    invoke([
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      path.join(mirror, "dist/test/consumer-imports.test.js"),
    ]);
  function check(result, passed) {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(
      result.status,
      passed ? 0 : 1,
      result.stdout.slice(-2200) + result.stderr.slice(-1000),
    );
    for (const line of [
      "tests 1",
      "pass " + Number(passed),
      "fail " + Number(!passed),
      "skipped 0",
      "cancelled 0",
      "todo 0",
    ])
      assert.match(result.stdout, new RegExp("^# " + line + "$", "m"));
    if (!passed) assert.match(result.stdout, /code: 'ERR_ASSERTION'/);
  }
  const baselines = new Set();
  for (const d of controls) {
    const target = path.join(mirror, "dist/src", d.file),
      original = originals.get(d.file);
    if (!baselines.has(d.name)) {
      check(run(d.name), true);
      baselines.add(d.name);
    }
    try {
      await writeFile(target, original.replace(d.from, d.to));
      const syntax = invoke(["--check", target]);
      assert.equal(syntax.status, 0, syntax.stderr);
      check(run(d.name), false);
      observed.push({
        id: d.id,
        file: d.file,
        sourceSha256: hash(original),
        mutantSha256: hash(await readFile(target)),
        assertionTest: d.name,
        baselinePassed: true,
        guardRemovalFailed: true,
      });
    } finally {
      await writeFile(target, original);
    }
    check(run(d.name), true);
  }
  for (const [file, original] of originals)
    assert.equal(
      hash(await readFile(path.join(repository, "dist/src", file))),
      hash(original),
    );
  assert.equal(
    hash(
      JSON.stringify(
        await Promise.all(
          testFiles.map(async (file) => [
            file,
            hash(await readFile(path.join(repository, "dist/test", file))),
          ]),
        ),
      ),
    ),
    harnessSha256,
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "captured-node-consumer-impact-foundation",
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      harnessSha256,
      controls: observed,
      complete: observed.length === controls.length,
    }) + "\n",
  );
} finally {
  await rm(mirror, { recursive: true, force: true });
}
