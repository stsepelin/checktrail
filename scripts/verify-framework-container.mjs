import { execFileSync } from "node:child_process";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const packages = fileURLToPath(
  new URL("../.repo-verifier/framework-tools", import.meta.url),
);
await access(path.join(packages, "fastapi"));
const image = execFileSync(
  "docker",
  ["image", "inspect", "python:3.12-alpine", "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image))
  throw new Error("Expected an installed Python image digest");
const temporary = await mkdtemp(path.join(tmpdir(), "repo-verifier-python-"));
try {
  const shim = path.join(temporary, "python3");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const cwd = process.cwd();
const result = spawnSync('docker', ['run','--rm','--network','none','--mount','type=bind,src='+cwd+',target='+cwd+',readonly','--mount','type=bind,src='+${JSON.stringify(packages)}+',target=/tools,readonly','--workdir',cwd,...Object.entries(process.env).filter(([key])=>['DJANGO_SETTINGS_MODULE'].includes(key)).flatMap(([key,value])=>['--env',key+'='+value]),'--env','PYTHONPATH=/tools','--env','PYTHONDONTWRITEBYTECODE=1',${JSON.stringify(image)},'python3',...process.argv.slice(2)], {stdio:'inherit'});
process.exitCode = result.status ?? 2;
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${temporary}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const version = execFileSync(
    shim,
    [
      "-c",
      "import sys, fastapi, starlette, django; print(sys.version.split()[0], fastapi.__version__, starlette.__version__, django.get_version())",
    ],
    { cwd: temporary, env, encoding: "utf8" },
  ).trim();
  process.stdout.write(
    `${JSON.stringify({ image, version, network: "none", mount: "read-only" })}\n`,
  );
  execFileSync(
    process.execPath,
    ["scripts/verify-required-native-tests.mjs", "frameworks"],
    {
      env,
      stdio: "inherit",
    },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
