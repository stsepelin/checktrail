import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { kubeSchemaPins } from "../dist/src/kubeconform.js";
import { kubernetesExtensionPins } from "../dist/src/kubernetes-extensions.js";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url))),
  task = process.env.CHECKTRAIL_TEST_TASK,
  parent = path.join(root, ".checktrail"),
  destination = path.join(parent, "kubernetes-extensions-runtime");
assert.match(task ?? "", /^[a-z][a-z0-9-]{0,80}$/);
const docker = (args) =>
    execFileSync("docker", args, { encoding: "utf8", maxBuffer: 2 * 1048576 }),
  base = JSON.parse(
    await readFile(
      path.join(parent, "infra-tools-runtime/identity.json"),
      "utf8",
    ),
  );
assert.equal(base.task, task);
assert.equal(base.tag, `checktrail-${task}:public`);
assert.equal(
  docker(["image", "inspect", base.tag, "--format", "{{.Id}}"]).trim(),
  base.image,
);
assert.match(base.image, /^sha256:[a-f0-9]{64}$/);
const [selected] = JSON.parse(docker(["image", "inspect", base.image]));
assert.equal(selected.Config.Labels["checktrail.task"], task);
const declarations = JSON.parse(
  await readFile(
    path.join(root, "scripts/kubernetes-extension-schemas.json"),
    "utf8",
  ),
);
assert.equal(declarations.schemaVersion, 1);
assert.equal(
  declarations.schemaRevision,
  "8df8a883b68a24a104b4a9e43c1288090ae60b3b",
);
assert.deepEqual(
  declarations.schemas.map(({ file, bytes, sha256 }) => ({
    file,
    bytes,
    sha256,
  })),
  kubernetesExtensionPins.map(({ file, bytes, sha256 }) => ({
    file,
    bytes,
    sha256,
  })),
);
for (const pin of declarations.schemas)
  assert.equal(
    pin.asset,
    `https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${declarations.schemaRevision}/v1.36.0-standalone-strict/${pin.file}`,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  checked = (bytes, pin) => {
    assert.equal(bytes.length, pin.bytes);
    assert.equal(hash(bytes), pin.sha256);
    return bytes;
  },
  regular = async (file, pin) => {
    assert.equal(await realpath(file), file);
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.size, pin.bytes);
    return checked(await readFile(file), pin);
  },
  local = process.env.CHECKTRAIL_KUBERNETES_SCHEMA_ARTIFACT_DIRECTORY
    ? await realpath(
        process.env.CHECKTRAIL_KUBERNETES_SCHEMA_ARTIFACT_DIRECTORY,
      )
    : undefined;
// Verify all selected inputs before writing or publishing a combined context.
const pins = [...kubeSchemaPins, ...declarations.schemas],
  inputs = [];
for (const pin of kubeSchemaPins)
  inputs.push(
    await regular(
      path.join(parent, "infra-tools-runtime/artifacts/schemas", pin.file),
      pin,
    ),
  );
for (const pin of declarations.schemas)
  inputs.push(
    local
      ? await regular(path.join(local, pin.file), pin)
      : checked(await requestPinnedArtifactBytes(pin), pin),
  );
assert.equal(pins.length, 13);
assert.equal(new Set(pins.map((p) => p.file)).size, 13);
await mkdir(parent, { recursive: true });
assert.equal(await realpath(parent), parent);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const temporary = path.join(parent, ".kubernetes-extensions-" + randomUUID()),
  tag = `checktrail-${task}-kubernetes:public`;
let built = false,
  published = false;
try {
  await mkdir(path.join(temporary, "schemas"), { recursive: true });
  for (const [i, pin] of pins.entries())
    await writeFile(path.join(temporary, "schemas", pin.file), inputs[i], {
      flag: "wx",
      mode: 0o600,
    });
  await writeFile(
    path.join(temporary, "Dockerfile"),
    `FROM ${base.tag}\nCOPY --chmod=0644 schemas/ /opt/checktrail-extended-schemas/\nRUN chmod 0555 /opt/checktrail-extended-schemas\n`,
    { flag: "wx" },
  );
  try {
    docker(["image", "inspect", tag]);
    assert.fail("Owned image tag already exists");
  } catch (error) {
    assert.ok(
      error.status && /No such image/.test(error.stderr?.toString() ?? ""),
    );
  }
  docker([
    "build",
    "--network",
    "none",
    "--label",
    `checktrail.task=${task}`,
    "--tag",
    tag,
    temporary,
  ]);
  built = true;
  const image = docker(["image", "inspect", tag, "--format", "{{.Id}}"]).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const [extended] = JSON.parse(docker(["image", "inspect", image]));
  assert.deepEqual(
    extended.RootFS.Layers.slice(0, selected.RootFS.Layers.length),
    selected.RootFS.Layers,
  );
  assert.deepEqual(extended.Config.Env, selected.Config.Env);
  assert.equal(
    docker(["image", "inspect", base.tag, "--format", "{{.Id}}"]).trim(),
    base.image,
  );
  const identity = {
    schemaVersion: 1,
    task,
    image,
    tag,
    baseImage: base.image,
    schemaRevision: declarations.schemaRevision,
    schemas: pins.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
    buildNetwork: "none",
    publisherSignaturesVerified: false,
  };
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx" },
  );
  await rename(temporary, destination);
  published = true;
  process.stdout.write(JSON.stringify(identity) + "\n");
} finally {
  if (!published) {
    await rm(temporary, { recursive: true, force: true });
    if (built) docker(["image", "rm", tag]);
  }
}
