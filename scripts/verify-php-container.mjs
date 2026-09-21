import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const image = execFileSync(
  "docker",
  ["image", "inspect", "php:8.4-cli", "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image))
  throw new Error("Expected an installed PHP image digest");
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-php-"));
try {
  const shim = path.join(temporary, "php");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const result = spawnSync('docker', ['run','--rm','--network','none','--mount','type=bind,src='+process.cwd()+',target=/workspace,readonly','--workdir','/workspace',${JSON.stringify(image)},'php',...process.argv.slice(2)], {stdio:'inherit'});
process.exitCode = result.status ?? 2;
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${temporary}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const version = execFileSync(shim, ["--version"], {
    cwd: temporary,
    env,
    encoding: "utf8",
  }).split("\n")[0];
  process.stdout.write(
    JSON.stringify({ image, version, network: "none", mount: "read-only" }) +
      "\n",
  );
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=native PHP",
      "dist/test/engine.test.js",
    ],
    { env, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const required =
    "native PHP syntax accepts valid code and rejects malformed code";
  assert.equal(
    output
      .split("\n")
      .filter(
        (line) =>
          /^ok [0-9]+ - /.test(line) &&
          line.slice(line.indexOf(" - ") + 3) === required,
      ).length,
    1,
    "Required native PHP regression did not pass exactly once",
  );
  process.stdout.write(output);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
