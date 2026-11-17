import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  callbackIdentities,
  prepareBaselineHarness,
  selectBaselineCohort,
} from "./preserved-baseline-evidence.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
assert.equal(
  process.argv.length,
  3,
  "Pass exactly one finite preserved baseline cohort",
);
const name = process.argv[2];
const selected = await selectBaselineCohort(repository, name);
const { cohort, profiles, selection, identities } = selected;
const git = (args) =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    timeout: 15000,
  });
assert.equal(
  git(["status", "--porcelain"]).trim(),
  "",
  "Baseline qualification requires a clean recorded source tree",
);
const source = {
  commit: git(["rev-parse", "HEAD"]).trim(),
  gitTree: git(["rev-parse", "HEAD^{tree}"]).trim(),
};
const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "checktrail-preserved-baseline-")),
);
const containers = [];
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
const imageIdentity = (image) => {
  const rows = JSON.parse(docker(["image", "inspect", image]));
  assert.equal(rows.length, 1, "Exactly one existing image is required");
  const row = rows[0];
  assert.match(row.Id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(
    ["linux", "windows"].includes(row.Os) &&
      typeof row.Architecture === "string",
  );
  return {
    id: row.Id,
    os: row.Os,
    architecture: row.Architecture,
    repoDigests: [...(row.RepoDigests ?? [])].sort(),
  };
};
const cleanup = async () => {
  const failures = [];
  for (const container of containers) {
    // Docker CLI termination alone does not stop an owned container.
    try {
      docker(["rm", "--force", container]);
    } catch (error) {
      if (!String(error.stderr ?? "").includes("No such container"))
        failures.push(container);
    }
  }
  await rm(temp, { recursive: true, force: true });
  assert.equal(failures.length, 0, "Owned baseline container cleanup failed");
};
let image;
try {
  if (cohort.backend === "container") {
    const reference = process.env[cohort.imageEnvironment] || cohort.image;
    image = imageIdentity(reference);
    assert.equal(
      image.os,
      cohort.platform,
      "Existing container platform differs",
    );
    image = {
      ...image,
      reference,
      recipeSha256: createHash("sha256")
        .update(await readFile(path.join(repository, cohort.dockerfile)))
        .digest("hex"),
    };
  }
  const expectedEngine = await captureCompiledEngine(
    path.join(repository, "dist/src"),
  );
  const expectedCallbacks = await callbackIdentities(
    repository,
    profiles,
    selection,
  );
  const packed = JSON.parse(
    runAcceptanceNpm(
      [
        "pack",
        "--offline",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temp,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
  );
  assert.equal(packed.length, 1);
  assert.equal(path.basename(packed[0].filename), packed[0].filename);
  const tarball = path.join(temp, packed[0].filename);
  const packageInputs = {};
  for (const file of ["package.json", "package-lock.json"]) {
    const bytes = await readFile(path.join(repository, file));
    packageInputs[file] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const packedBytes = await readFile(tarball);
  packageInputs.tarball = {
    bytes: packedBytes.length,
    sha256: createHash("sha256").update(packedBytes).digest("hex"),
  };
  const consumer = path.join(temp, "consumer"),
    harness = path.join(temp, "harness");
  const installed = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installedPackage = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail",
  );
  await prepareBaselineHarness({
    repository,
    harness,
    installedPackage,
    preparedDirectories: cohort.preparedDirectories,
  });
  const binding = {
    platform: cohort.platform,
    nodeMajor: cohort.nodeMajor,
    ...(cohort.nodeVersion ? { nodeVersion: cohort.nodeVersion } : {}),
    ...(cohort.gitVersion ? { gitVersion: cohort.gitVersion } : {}),
    ...(cohort.selectors ? { selectors: cohort.selectors } : {}),
    tools: cohort.tools,
    toolVersionAssertions: cohort.toolVersionAssertions ?? {},
  };
  const phases = {};
  for (const phase of ["source", "fresh-installed"]) {
    const root = phase === "source" ? repository : harness;
    const input = {
      root,
      profiles,
      selection,
      expectedCallbacks,
      expectedEngine,
      binding,
      ...(phase === "fresh-installed"
        ? {
            installedPackage,
            sourceEngine: path.join(repository, "dist/src"),
          }
        : {}),
    };
    const inputFile = path.join(temp, phase + ".json");
    await writeFile(inputFile, JSON.stringify(input), {
      flag: "wx",
      mode: 0o600,
    });
    const worker = path.join(root, "scripts/preserved-baseline-worker.mjs");
    let output;
    if (image) {
      const container = "checktrail-preserved-" + randomUUID();
      containers.push(container);
      output = docker(
        [
          "run",
          "--rm",
          "--init",
          "--name",
          container,
          "--network",
          "none",
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--pids-limit",
          "512",
          "--mount",
          "type=bind,src=" + repository + ",target=" + repository + ",readonly",
          "--mount",
          "type=bind,src=" + temp + ",target=" + temp + ",readonly",
          "--workdir",
          root,
          image.id,
          "node",
          worker,
          inputFile,
        ],
        { timeout: 660000 },
      );
    } else {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      output = execFileSync(process.execPath, [worker, inputFile], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 660000,
        maxBuffer: 32 * 1024 * 1024,
      });
    }
    phases[phase] = JSON.parse(output);
    assert.equal(phases[phase].complete, true, "Baseline phase is incomplete");
  }
  assert.deepEqual(
    phases.source.runtime,
    phases["fresh-installed"].runtime,
    "Independent phases used different runtime or tool bytes",
  );
  assert.deepEqual(
    phases.source.callbacks,
    phases["fresh-installed"].callbacks,
  );
  requireUnchangedCompiledEngine(
    expectedEngine,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  assert.deepEqual(
    await callbackIdentities(repository, profiles, selection),
    expectedCallbacks,
  );
  assert.equal(
    git(["status", "--porcelain"]).trim(),
    "",
    "Source changed during collection",
  );
  if (image) {
    const after = imageIdentity(image.reference);
    assert.equal(
      after.id,
      image.id,
      "Container image tag changed during collection",
    );
    assert.deepEqual(
      {
        id: image.id,
        os: image.os,
        architecture: image.architecture,
        repoDigests: image.repoDigests,
      },
      after,
    );
  }
  const membership = selection.map((profile) => ({
    profile,
    required: profiles[profile].length,
  }));
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "preserved-baseline-source-fresh-v1",
      cohort: name,
      scope:
        "Original selected callback union in independent source and physically fresh installed-engine processes; external fixture dev dependencies reused. Configured engine root is bound; arbitrary module loads are not traced.",
      source,
      identities,
      packageInputs,
      binding: cohort,
      image: image ?? null,
      membership,
      ...installed,
      phases,
      callbacksUnmodified: true,
      sourceCommandReplaced: false,
      sourceAndFreshCohortComplete: true,
      wholeMatrixQualification: false,
      nativeLicenseClosureClaimed: false,
      gateAComplete: false,
      modelCalls: 0,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
} finally {
  await cleanup();
}
