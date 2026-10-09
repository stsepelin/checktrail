import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  task = process.env.CHECKTRAIL_TEST_TASK ?? `hcl-context-${process.pid}`,
  destination = path.join(repository, ".checktrail/hcl-context-runtime"),
  tag = `checktrail-${task}:public`;
assert.equal(process.arch, "arm64");
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const spec = JSON.parse(
  await readFile(
    path.join(repository, "scripts/infra-tools-artifacts.json"),
    "utf8",
  ),
).tools.find((tool) => tool.name === "terraform");
assert.equal(spec.archive, "terraform_1.16.5_linux_arm64.zip");
assert.equal(spec.members.length, 2);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  docker = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1048576,
    });
assert.equal(
  spawnSync("docker", ["image", "inspect", tag]).status,
  1,
  "Owned image tag already exists",
);
await assert.rejects(lstat(destination), (error) => error.code === "ENOENT");
let bytes;
if (process.env.CHECKTRAIL_HCL_ARTIFACT_DIRECTORY) {
  const directory = await realpath(
      process.env.CHECKTRAIL_HCL_ARTIFACT_DIRECTORY,
    ),
    file = path.join(directory, spec.archive),
    stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(await realpath(file), file);
  assert.equal(stat.size, spec.archiveBytes);
  bytes = await readFile(file);
} else
  bytes = await requestPinnedArtifactBytes({
    asset: spec.asset,
    bytes: spec.archiveBytes,
    sha256: spec.archiveSha256,
  });
assert.equal(bytes.length, spec.archiveBytes);
assert.equal(hash(bytes), spec.archiveSha256);
await mkdir(path.dirname(destination), { recursive: true });
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "hcl-preparation-"),
);
let built = false,
  complete = false;
try {
  const archive = path.join(temporary, spec.archive);
  await writeFile(archive, bytes, { flag: "wx" });
  const listed = execFileSync("unzip", ["-Z", "-1", archive], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  assert.deepEqual([...listed].sort(), spec.members.map((m) => m.path).sort());
  const members = spec.members.map((member) => {
    assert.match(member.path, /^[A-Za-z0-9_.-]+$/);
    const bytes = execFileSync("unzip", ["-p", archive, member.path], {
      maxBuffer: 128 * 1048576,
    });
    assert.equal(bytes.length, member.bytes);
    assert.equal(hash(bytes), member.sha256);
    return { member, bytes };
  });
  for (const { member, bytes } of members) {
    const file = path.join(temporary, "artifacts", member.output);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, {
      flag: "wx",
      mode: member.path === "terraform" ? 0o755 : 0o644,
    });
  }
  await cp(
    path.join(repository, "scripts/hcl-context-tools.Dockerfile"),
    path.join(temporary, "Dockerfile"),
  );
  docker([
    "build",
    "--network",
    "none",
    "--label",
    `checktrail.task=${task}`,
    "--file",
    path.join(temporary, "Dockerfile"),
    "--tag",
    tag,
    temporary,
  ]);
  built = true;
  const [image] = JSON.parse(docker(["image", "inspect", tag]));
  assert.equal(image.Architecture, "arm64");
  assert.equal(image.Config.Labels["checktrail.task"], task);
  const version = docker([
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--label",
    `checktrail.task=${task}`,
    image.Id,
    "terraform",
    "version",
    "-json",
  ]);
  assert.equal(JSON.parse(version).terraform_version, "1.16.5");
  const identity = {
    task,
    tag,
    image: image.Id,
    nodeBase:
      "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
    gitBase:
      "golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6",
    archive: { file: spec.archive, bytes: bytes.length, sha256: hash(bytes) },
    members: spec.members,
    nativeVersion: JSON.parse(version),
    buildNetwork: "none",
    publisherAndLicenseClosureVerified: false,
  };
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx" },
  );
  await rename(temporary, destination);
  complete = true;
  process.stdout.write(JSON.stringify(identity) + "\n");
} finally {
  if (!complete) {
    if (built) docker(["image", "rm", tag]);
    await rm(temporary, { recursive: true, force: true });
  }
}
