import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { URL } from "node:url";
import { sha256 } from "./external-evaluation-extract.mjs";

assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/prepare-external-evaluation.mjs EXISTING_PARENT_DIRECTORY",
);
const parent = await realpath(process.argv[2]);
const plan = JSON.parse(
  await readFile(
    new URL("./external-evaluation-plan.json", import.meta.url),
    "utf8",
  ),
);
const inputs = JSON.parse(
  await readFile(
    new URL("./external-evaluation-inputs.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(sha256(JSON.stringify(plan, null, 2) + "\n"), inputs.planSha256);
assert.equal(plan.upstream.commit, "3f20a57c6293371b6193d3fb6746c2b7b2ac2689");
assert.deepEqual(
  inputs.files.map((item) => item.file),
  [
    "LICENSE",
    "tests/lib/rules/eqeqeq.js",
    "tests/lib/rules/no-dupe-args.js",
    "tests/lib/rules/no-unreachable.js",
  ],
);
const execute = promisify(execFile);
const downloaded = await Promise.all(
  inputs.files.map(async (item) => {
    const url = `https://raw.githubusercontent.com/eslint/eslint/${plan.upstream.commit}/${item.file}`;
    const { stdout } = await execute(
      "curl",
      [
        "--proto",
        "=https",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "30",
        url,
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 35000 },
    );
    assert.equal(stdout.length, item.bytes);
    assert.equal(sha256(stdout), item.sha256);
    return { filename: path.posix.basename(item.file), bytes: stdout };
  }),
);
const directory = await mkdtemp(path.join(parent, "external-eslint-"));
try {
  for (const item of downloaded)
    await writeFile(path.join(directory, item.filename), item.bytes, {
      flag: "wx",
      mode: 0o600,
    });
  process.stdout.write(
    JSON.stringify({
      directory,
      planSha256: inputs.planSha256,
      files: inputs.files,
    }) + "\n",
  );
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
