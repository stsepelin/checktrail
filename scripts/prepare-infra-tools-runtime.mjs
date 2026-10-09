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
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { mavenHash } from "../dist/src/maven.js";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const task = process.env.CHECKTRAIL_TEST_TASK || `infra-tools-${process.pid}`;
assert.equal(process.arch, "arm64");
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const destination = path.join(root, ".checktrail/infra-tools-runtime"),
  tag = `checktrail-${task}:public`;
const manifest = JSON.parse(
  await readFile(path.join(root, "scripts/infra-tools-artifacts.json"), "utf8"),
);
assert.equal(manifest.schemaVersion, 1);
assert.match(
  manifest.base,
  /^public\.ecr\.aws\/docker\/library\/node@sha256:[a-f0-9]{64}$/,
);
const downloads = [
  ...manifest.tools.map((t) => ({
    path: "archives/" + t.archive,
    asset: t.asset,
    bytes: t.archiveBytes,
    sha256: t.archiveSha256,
  })),
  ...manifest.schemas.map((s) => ({ path: "schemas/" + s.file, ...s })),
];
const canonical = (v) =>
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(v);
const pin = (p) => {
  assert.ok(
    Number.isSafeInteger(p.bytes) &&
      p.bytes > 0 &&
      p.bytes <= 128 * 1024 * 1024,
  );
  assert.match(p.sha256, /^[a-f0-9]{64}$/);
};
assert.equal(new Set(downloads.map((p) => p.path)).size, downloads.length);
for (const item of downloads) {
  assert.ok(canonical(item.path));
  pin(item);
  const url = new URL(item.asset);
  assert.equal(url.protocol, "https:");
  assert.ok(
    [
      "get.helm.sh",
      "releases.hashicorp.com",
      "github.com",
      "raw.githubusercontent.com",
    ].includes(url.hostname),
  );
}
const outputs = manifest.tools.flatMap((t) => t.members.map((m) => m.output));
assert.equal(new Set(outputs).size, outputs.length);
for (const t of manifest.tools) {
  assert.ok(["helm", "kubeconform", "kustomize", "terraform"].includes(t.name));
  assert.ok(["zip", "tar"].includes(t.kind));
  assert.equal(new Set(t.members.map((m) => m.path)).size, t.members.length);
  for (const m of t.members) {
    assert.ok(
      canonical(m.path) &&
        canonical(m.output) &&
        (m.output === `bin/${t.name}` ||
          m.output.startsWith(`notices/${t.name}-`)),
    );
    pin(m);
  }
}
await mkdir(path.dirname(destination), { recursive: true });
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const docker = (args) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  docker(["image", "inspect", tag]);
  assert.fail("Owned tag already exists");
} catch (error) {
  assert.ok(
    error.status && /No such image/.test(error.stderr?.toString() || ""),
  );
}
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "infra-tools-preparation-"),
);
let built = false,
  complete = false;
try {
  const local = process.env.CHECKTRAIL_INFRA_ARTIFACT_DIRECTORY
      ? await realpath(process.env.CHECKTRAIL_INFRA_ARTIFACT_DIRECTORY)
      : undefined,
    observed = [];
  for (let offset = 0; offset < downloads.length; offset += 4) {
    const rows = await Promise.allSettled(
      downloads.slice(offset, offset + 4).map(async (item) => {
        let bytes, asset;
        if (local) {
          const file = path.join(local, item.path),
            stat = await lstat(file);
          assert.ok(
            stat.isFile() &&
              !stat.isSymbolicLink() &&
              stat.size === item.bytes &&
              (await realpath(file)) === file,
          );
          bytes = await readFile(file);
          asset = "operator-prepared-artifact";
        } else {
          bytes = await requestPinnedArtifactBytes(item, {
            onRetry: ({ attempt, waitMs }) =>
              process.stderr.write(
                `Retrying ${item.path} after transport failure (attempt ${attempt}/3; wait ${waitMs}ms)\n`,
              ),
          });
          asset = item.asset;
        }
        assert.equal(bytes.length, item.bytes);
        assert.equal(mavenHash(bytes), item.sha256);
        const file = path.join(temporary, "artifacts", item.path);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes, { flag: "wx" });
        return {
          path: item.path,
          bytes: item.bytes,
          sha256: item.sha256,
          asset,
        };
      }),
    );
    // Drain the batch before cleanup can remove its staging directory.
    const failures = rows.filter((row) => row.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((row) => row.reason),
        "Pinned artifact preparation failed",
      );
    observed.push(...rows.map((row) => row.value));
  }
  for (const tool of manifest.tools) {
    const archive = path.join(temporary, "artifacts/archives", tool.archive);
    const listed = execFileSync(
      tool.kind === "zip" ? "unzip" : "tar",
      tool.kind === "zip" ? ["-Z", "-1", archive] : ["-tzf", archive],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    )
      .trim()
      .split(/\r?\n/)
      .filter((name) => !name.endsWith("/"));
    assert.deepEqual(
      [...listed].sort(),
      tool.members.map((m) => m.path).sort(),
    );
    for (const member of tool.members) {
      const bytes = execFileSync(
        tool.kind === "zip" ? "unzip" : "tar",
        tool.kind === "zip"
          ? ["-p", archive, member.path]
          : ["-xOf", archive, member.path],
        { maxBuffer: 128 * 1024 * 1024 },
      );
      assert.equal(bytes.length, member.bytes);
      assert.equal(mavenHash(bytes), member.sha256);
      const file = path.join(temporary, "artifacts", member.output);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, {
        flag: "wx",
        mode: member.output.startsWith("bin/") ? 0o755 : 0o644,
      });
    }
  }
  if (process.env.CHECKTRAIL_INFRA_BASE_PREPARED !== "1")
    docker(["pull", manifest.base]);
  docker([
    "build",
    "--network",
    "none",
    "--label",
    `checktrail.task=${task}`,
    "--file",
    "scripts/infra-tools.Dockerfile",
    "--tag",
    tag,
    temporary,
  ]);
  built = true;
  const [image] = JSON.parse(docker(["image", "inspect", tag]));
  assert.equal(image.Config.Labels["checktrail.task"], task);
  assert.equal(image.Architecture, "arm64");
  const nativeVersions = [];
  for (const tool of [
    {
      name: "node",
      versionArgs: ["--version"],
      nativeVersionOutput: "v22.23.2\n",
    },
    ...manifest.tools,
  ]) {
    const output = docker([
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--label",
      `checktrail.task=${task}`,
      image.Id,
      tool.name,
      ...tool.versionArgs,
    ]);
    assert.equal(output, tool.nativeVersionOutput);
    nativeVersions.push({ name: tool.name, output });
  }
  const identity = {
    task,
    tag,
    image: image.Id,
    base: manifest.base,
    artifacts: observed,
    members: manifest.tools.flatMap((t) =>
      t.members.map((m) => ({ tool: t.name, ...m })),
    ),
    schemaRevision: manifest.schemaRevision,
    nativeVersions,
    buildNetwork: "none",
    releaseSignaturesVerified: false,
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
