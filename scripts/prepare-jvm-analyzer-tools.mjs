import process from "node:process";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { detektArtifacts } from "../dist/src/detekt-artifacts.js";
import { kotlinArtifacts } from "../dist/src/kotlin-artifacts.js";
import { spotbugsArtifacts } from "../dist/src/spotbugs-artifacts.js";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url))),
  parent = path.join(root, ".checktrail"),
  directory = path.join(parent, "jvm-analyzer-tools");
const declarations = [
  {
    source: "detekt-tools",
    file: "detekt-cli-2.0.0-alpha.6-all.jar",
    bytes: detektArtifacts.jarBytes,
    sha256: detektArtifacts.jarSha256,
  },
  {
    source: "spotbugs-tools",
    file: "spotbugs-4.10.4.tgz",
    bytes: 15831983,
    sha256: spotbugsArtifacts.archiveSha256,
  },
  {
    source: "kotlin-tools",
    file: "kotlin-compiler-2.4.10.zip",
    bytes: kotlinArtifacts.archiveBytes,
    sha256: kotlinArtifacts.archiveSha256,
  },
];
const verify = async (file, d) => {
  assert.equal(await realpath(file), file);
  const bytes = await readFile(file);
  assert.equal(bytes.length, d.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), d.sha256);
  return bytes;
};
await mkdir(parent, { recursive: true });
assert.equal(await realpath(parent), parent);
const cached = await access(directory).then(
  () => true,
  (error) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  },
);
if (cached) {
  assert.equal(await realpath(directory), directory);
  for (const d of declarations) await verify(path.join(directory, d.file), d);
} else {
  // Resolve and verify every input before publishing any target artifact.
  const inputs = await Promise.all(
      declarations.map((d) => verify(path.join(parent, d.source, d.file), d)),
    ),
    temporary = path.join(parent, ".jvm-analyzer-" + randomUUID());
  await mkdir(temporary);
  try {
    for (const [i, d] of declarations.entries())
      await writeFile(path.join(temporary, d.file), inputs[i], {
        flag: "wx",
        mode: 0o600,
      });
    await rename(temporary, directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
process.stdout.write(
  JSON.stringify({
    cached,
    artifacts: declarations.map(({ source, ...d }) => {
      void source;
      return d;
    }),
    publisherSignaturesVerified: false,
  }) + "\n",
);
