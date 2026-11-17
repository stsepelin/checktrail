import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const descriptorFile = "scripts/python-ubuntu26-arm64.json";
const installerFile = "scripts/install-python-host-sdk.py";
const manifest = JSON.parse(
  await readFile(path.join(repository, descriptorFile), "utf8"),
);
assert.equal(process.platform, "linux");
assert.equal(process.arch, "arm64");
const release = await readFile("/etc/os-release", "utf8");
assert.match(release, /^ID=(?:ubuntu|"ubuntu")$/m);
assert.match(release, /^VERSION_ID=(?:26\.04|"26\.04")$/m);
const agentCache = process.env.AGENT_TOOLSDIRECTORY;
assert.equal(
  agentCache?.trim() ? agentCache : process.env.RUNNER_TOOL_CACHE,
  manifest.toolCacheRoot,
);
const archive = path.join(
  process.env.RUNNER_TEMP,
  "checktrail-python-3.13.5-ubuntu24-arm64.tar.gz",
);
const body = await requestPinnedArtifactBytes(manifest);
assert.equal(createHash("sha256").update(body).digest("hex"), manifest.sha256);
await writeFile(archive, body, { flag: "wx", mode: 0o400 });
process.stdout.write(
  execFileSync(
    "python3",
    [
      "-I",
      "-B",
      path.join(repository, installerFile),
      archive,
      manifest.toolCacheRoot,
    ],
    { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
  ),
);
