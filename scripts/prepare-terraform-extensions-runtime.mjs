import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { terraformExtensionsProvider as provider } from "../dist/src/terraform-extensions-contract.js";
import { mavenHash } from "../dist/src/maven.js";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const destination = path.join(root, ".checktrail/terraform-extensions-tools");
await mkdir(path.dirname(destination), { recursive: true });
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "terraform-extensions-preparation-"),
);
let complete = false;
try {
  const asset =
    "https://releases.hashicorp.com/terraform-provider-random/3.9.1/" +
    provider.archive;
  const local = process.env.CHECKTRAIL_TERRAFORM_RANDOM_ARCHIVE;
  let bytes;
  if (local !== undefined) {
    const file = path.resolve(local),
      stat = await lstat(file);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === provider.archiveBytes,
    );
    assert.equal(await realpath(file), file);
    bytes = await readFile(file);
  } else
    bytes = await requestPinnedArtifactBytes({
      asset,
      bytes: provider.archiveBytes,
      sha256: provider.archiveSha256,
    });
  assert.equal(bytes.length, provider.archiveBytes);
  assert.equal(mavenHash(bytes), provider.archiveSha256);
  const archive = path.join(temporary, provider.archive);
  await writeFile(archive, bytes, { flag: "wx", mode: 0o644 });
  const listed = execFileSync("unzip", ["-Z", "-1", archive], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4096,
  })
    .trim()
    .split("\n");
  assert.deepEqual(
    listed.toSorted(),
    provider.members.map((member) => member.path).toSorted(),
  );
  for (const member of provider.members) {
    const content = execFileSync("unzip", ["-p", archive, member.path], {
      timeout: 30000,
      maxBuffer: member.bytes + 4096,
    });
    assert.equal(content.length, member.bytes);
    assert.equal(mavenHash(content), member.sha256);
    await writeFile(path.join(temporary, member.path), content, {
      flag: "wx",
      mode: member.path.startsWith("terraform-provider-") ? 0o755 : 0o644,
    });
  }
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        provider,
        archiveSource:
          local === undefined ? asset : "operator-prepared-artifact",
        completeMembersObserved: true,
        releaseSignatureVerified: false,
        publisherAndLicenseClosureVerified: false,
        nativeExecutionReached: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o644 },
  );
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  complete = true;
  process.stdout.write(
    JSON.stringify({
      preparedProvider: provider.address,
      version: provider.version,
      archiveSha256: provider.archiveSha256,
      memberCount: provider.members.length,
      releaseSignatureVerified: false,
    }) + "\n",
  );
} finally {
  if (!complete) await rm(temporary, { recursive: true, force: true });
}
