import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as library from "../src/index.js";
import {
  inspectReviewEvaluationConfiguration as inspect,
  projectReviewEvaluationConfiguration as project,
} from "../src/review-evaluation-configuration.js";
import { inspectReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
import { evaluationPrivateArtifacts } from "../src/review-evaluation-artifacts.js";
import { configurationFixture } from "./review-evaluation-configuration-fixture.js";
import { setPrivateFixtureAccess } from "./windows-private-fixture.js";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

test("configuration bytes bind all ten roles without promoting declaration or evaluation claims", async (t) => {
  const f = await configurationFixture(t),
    result = f.inspectFiles();
  assert.equal(result.configurationBytesVerified, true);
  assert.equal(result.artifacts.length, 10);
  assert.ok(result.artifacts.every((row) => row.issues.length === 0));
  assert.deepEqual(
    library.inspectReviewEvaluationConfiguration(
      f.repository,
      f.root,
      f.declaration,
      f.files,
      f.digest(),
    ),
    result,
  );
  assert.equal(
    inspectReviewEvaluationProtocol(f.declaration).configurationBytesVerified,
    false,
  );
  for (const flag of [
    "configurationSemanticsVerified",
    "sourceContentInspected",
    "labelsInspected",
    "chronologyVerified",
    "licenseGrantVerified",
    "hostIndependenceVerified",
    "gateAClosed",
    "qualityAssessed",
    "inferenceExecuted",
    "fieldEvaluationExecuted",
  ] as const)
    assert.equal(result[flag], false, flag);
  const summary = project(result);
  assert.deepEqual(summary.counts, {
    selected: 10,
    verified: 10,
    incomplete: 0,
  });
  for (const canary of [
    f.root,
    ...f.bodies.keys(),
    ...f.bodies.values(),
    f.declaration.protocol.reference.id,
  ])
    assert.equal(JSON.stringify(summary).includes(canary), false, canary);
});
test("every digest mismatch and missing file retains all ten selected roles", async (t) => {
  const f = await configurationFixture(t);
  for (const [file, body] of f.bodies) {
    const full = path.join(f.root, file),
      role = file.slice(0, -5);
    writeFileSync(full, "x".repeat(Buffer.byteLength(body)));
    const wrong = f.inspectFiles();
    assert.equal(wrong.configurationBytesVerified, false);
    assert.deepEqual(
      wrong.artifacts
        .filter((row) => row.issues.length)
        .map((row) => [row.role, row.issues]),
      [[role, ["digest"]]],
    );
    assert.deepEqual(project(wrong).counts, {
      selected: 10,
      verified: 9,
      incomplete: 1,
    });
    unlinkSync(full);
    const missing = f.inspectFiles();
    assert.equal(missing.configurationBytesVerified, false);
    assert.equal(missing.artifacts.length, 10);
    assert.deepEqual(
      missing.artifacts.find((row) => row.role === role)?.issues,
      ["unavailable-or-unsafe-file"],
    );
    writeFileSync(full, body, { mode: 0o600 });
    await setPrivateFixtureAccess(full, "file");
  }
  assert.equal(f.inspectFiles().configurationBytesVerified, true);
});
test("configuration selection refuses traversal, aliased files, missing/foreign roles and foreign protocol identity", async (t) => {
  const f = await configurationFixture(t);
  for (const file of [
    "../outside",
    "/absolute",
    "nested/file",
    "nested\\file",
    ".",
    "file\nname",
    f.files.configurations.verifier.file.toUpperCase(),
  ]) {
    const changed = structuredClone(f.files);
    changed.configurations.reference.file = file;
    assert.throws(() =>
      inspect(f.repository, f.root, f.declaration, changed, f.digest()),
    );
  }
  const missing = structuredClone(f.files) as Partial<typeof f.files>;
  delete missing.procedures;
  assert.throws(() =>
    inspect(f.repository, f.root, f.declaration, missing, f.digest()),
  );
  assert.throws(() =>
    inspect(
      f.repository,
      f.root,
      f.declaration,
      { ...f.files, foreign: "private-canary" },
      f.digest(),
    ),
  );
  assert.throws(
    () => inspect(f.repository, f.root, f.declaration, f.files, "0".repeat(64)),
    /identity/,
  );
  assert.throws(
    () =>
      inspect(f.repository, f.repository, f.declaration, f.files, f.digest()),
    /outside/,
  );
  writeFileSync(path.join(f.root, "labels-canary"), "unrelated", {
    mode: 0o600,
  });
  assert.throws(f.inspectFiles, /only selected/);
});
test("empty configuration bytes and exact byte lengths do not establish semantics", async (t) => {
  const f = await configurationFixture(t),
    pin = f.files.configurations.reference;
  writeFileSync(path.join(f.root, pin.file), "");
  pin.bytes = 0;
  f.declaration.protocol.reference.configurationSha256 = sha("");
  assert.equal(f.inspectFiles().configurationBytesVerified, true);
  pin.bytes = 1;
  const shorter = f.inspectFiles();
  assert.equal(shorter.configurationBytesVerified, false);
  assert.deepEqual(shorter.artifacts[0]?.issues, ["byte-length"]);
  pin.bytes = 1048577;
  assert.throws(f.inspectFiles);
});
test("configuration inspection rejects links, directories and public files", async (t) => {
  const f = await configurationFixture(t),
    full = path.join(f.root, f.files.configurations.reference.file),
    saved = path.join(path.dirname(f.root), "original");
  const refused = () => {
    try {
      return !f.inspectFiles().configurationBytesVerified;
    } catch {
      return true;
    }
  };
  renameSync(full, saved);
  linkSync(saved, full);
  assert.equal(refused(), true);
  unlinkSync(full);
  if (process.platform !== "win32") {
    symlinkSync(saved, full);
    assert.equal(refused(), true);
    unlinkSync(full);
  }
  mkdirSync(full);
  assert.equal(refused(), true);
  rmdirSync(full);
  renameSync(saved, full);
  assert.equal(f.inspectFiles().configurationBytesVerified, true);
  await setPrivateFixtureAccess(full, "file", false);
  assert.equal(refused(), true);
  await setPrivateFixtureAccess(full, "file");
  assert.equal(f.inspectFiles().configurationBytesVerified, true);
});
test("a later read cannot hide replacement of an earlier configuration with identical bytes", async (t) => {
  const f = await configurationFixture(t),
    original = evaluationPrivateArtifacts.readPrivate;
  let calls = 0;
  evaluationPrivateArtifacts.readPrivate = (filename, limit) => {
    const bytes = original(filename, limit);
    if (++calls === 10) {
      const full = path.join(f.root, f.files.configurations.reference.file),
        body = readFileSync(full);
      unlinkSync(full);
      writeFileSync(full, body, { mode: 0o600 });
    }
    return bytes;
  };
  try {
    const result = f.inspectFiles();
    assert.equal(calls, 10);
    assert.equal(result.configurationBytesVerified, false);
    assert.ok(
      result.artifacts[0]?.issues.includes("changed-during-inspection"),
    );
  } finally {
    evaluationPrivateArtifacts.readPrivate = original;
  }
});
test("operator command prints only summary and generic private errors", async (t) => {
  const f = await configurationFixture(t),
    script = fileURLToPath(
      new URL(
        "../../scripts/check-evaluation-configuration.mjs",
        import.meta.url,
      ),
    );
  const args = [
    script,
    "--project",
    f.repository,
    "--configuration-root",
    f.root,
    "--expected-protocol-sha256",
    f.digest(),
  ];
  const input = JSON.stringify({ declaration: f.declaration, files: f.files });
  const result = spawnSync(process.execPath, args, {
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), project(f.inspectFiles()));
  unlinkSync(path.join(f.root, f.files.configurations.reference.file));
  const missing = spawnSync(process.execPath, args, {
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).counts.incomplete, 1);
  const invalid = spawnSync(process.execPath, args, {
    input: "private-canary-not-json",
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(
    invalid.stderr,
    "Evaluation configuration invalid or unavailable\n",
  );
});

test("project file arguments cannot substitute for the actual project boundary", async (t) => {
  const f = await configurationFixture(t),
    anchor = path.join(f.repository, "marker");
  writeFileSync(anchor, "synthetic marker");
  assert.throws(
    () => inspect(anchor, f.root, f.declaration, f.files, f.digest()),
    /project directory/,
  );
});
test("foreign namespace enumeration stops at the first unexpected or eleventh entry", async (t) => {
  const f = await configurationFixture(t);
  for (let i = 0; i < 50; i++)
    writeFileSync(path.join(f.root, "foreign-" + i), "not read");
  const original = fs.opendirSync;
  let reads = 0;
  fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
    const directory = original(...args);
    return new Proxy(directory, {
      get(target, key) {
        if (key === "readSync")
          return () => {
            reads++;
            return target.readSync();
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof fs.opendirSync;
  syncBuiltinESMExports();
  try {
    assert.throws(f.inspectFiles, /only selected/);
    assert.ok(reads > 0 && reads <= 11, String(reads));
  } finally {
    fs.opendirSync = original;
    syncBuiltinESMExports();
  }
});
test("summary projection allows only named fields even when a caller decorates a report", async (t) => {
  const f = await configurationFixture(t),
    report = f.inspectFiles();
  const decorated = {
    ...report,
    privatePath: f.root,
    secret: "private-canary",
    schedule: f.declaration.protocol.caseClusters,
  };
  assert.deepEqual(project(decorated), project(report));
});
