import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const script = new URL(
  "../../scripts/verify-binutils-retention-observer.mjs",
  import.meta.url,
);
const { checkObserverInputs } = await import(script.href);
const recipe = JSON.parse(
  await readFile(
    new URL(
      "../../scripts/producer-qualification/binutils.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("every committed producer controller pin matches its actual file before native admission", async () => {
  const checked = await checkObserverInputs();
  assert.deepEqual(checked.controllerFiles, recipe.controllerFiles);
  assert.ok(recipe.controllerFiles.length > 1);
  for (const file of [
    "binutils-retention-observer.py",
    "binutils-retention-observer.mjs",
  ])
    assert.ok(
      recipe.controllerFiles.some((row: { file: string }) => row.file === file),
    );
});

test("controller admission accepts both unchanged observers and rejects larger smaller and same-size drift in either", async (t) => {
  const originals = {
    "binutils-retention-observer.py": "synthetic observer one\n",
    "binutils-retention-observer.mjs": "synthetic observer two\n",
  };
  const rows = Object.entries(originals).map(([file, body]) => ({
    file,
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  }));
  for (const file of Object.keys(originals) as (keyof typeof originals)[]) {
    for (const changed of [
      originals[file] + "x",
      originals[file].slice(1),
      originals[file].replace("synthetic", "different"),
    ]) {
      const root = await realpath(
        await fixture(t, {
          ...originals,
          "binutils.v1.json": JSON.stringify({ controllerFiles: rows }),
        }),
      );
      assert.equal((await checkObserverInputs(root)).controllerFiles.length, 2);
      await writeFile(path.join(root, file), changed);
      await assert.rejects(
        checkObserverInputs(root),
        /Input exceeds byte bound|Pinned input mismatch/,
      );
    }
  }
});

test("metadata-only observer CLI requires neither Docker nor native host permissions and cannot claim native proof", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(script), "--check-inputs"],
    {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, PATH: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    controllerInputsVerified: recipe.controllerFiles.length,
    nativeLinuxPermissionProof: false,
    sourceOrCompilerInvoked: false,
    gateAComplete: false,
  });
  const invalid = spawnSync(
    process.execPath,
    [fileURLToPath(script), "--check-inputs", "--output", "unused"],
    {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, PATH: "" },
    },
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
});

test("all upstream observer workflows check pinned inputs before any Docker call or native permission proof", async () => {
  for (const name of [
    "upstream-binutils.yml",
    "upstream-gcc.yml",
    "upstream-glibc.yml",
    "upstream-glibc-u13.yml",
  ]) {
    const workflow = parse(
      await readFile(
        new URL("../../.github/workflows/" + name, import.meta.url),
        "utf8",
      ),
    );
    const jobs = Object.values(workflow.jobs) as {
      steps: { run?: string }[];
    }[];
    assert.equal(jobs.length, 1);
    const commands = jobs[0]!.steps.map((step) => step.run ?? "");
    const check = commands.indexOf(
      "node scripts/verify-binutils-retention-observer.mjs --check-inputs",
    );
    assert.ok(check >= 0, name);
    assert.equal(
      commands.filter((value) => value === commands[check]).length,
      1,
      name,
    );
    for (let index = 0; index < commands.length; index++) {
      if (
        /docker|verify-binutils-retention-observer\.mjs[\s\S]*--output/.test(
          commands[index]!,
        )
      )
        assert.ok(check < index, name + ": " + commands[index]);
    }
  }
});
