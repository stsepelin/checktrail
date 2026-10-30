// Explicit developer preparation. Imported planning is data only; the CLI grants no MCP trust.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  link,
  unlink,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { boundedProcess } from "./web-runtime-worker.mjs";
import {
  identify,
  relativeInput,
  completeProcessObservation,
  validateNativeHost,
  hostObservation,
  prepare,
} from "./web-runtime-controller.mjs";
import {
  baseIdentity,
  assemblyDockerfile,
  assemblyCommand,
} from "./web-runtime-image.mjs";
import { validateObservedImage } from "./binutils-image-identity.mjs";
const directory = path.dirname(fileURLToPath(import.meta.url));
export const catalog = JSON.parse(
  await readFile(
    new URL("./web-runtime-acquisition.v1.json", import.meta.url),
    "utf8",
  ),
);
const frozen = JSON.parse(
  await readFile(new URL("./web-runtime.v1.json", import.meta.url), "utf8"),
);
const hash = (body) => createHash("sha256").update(body).digest("hex");
export const preparationLimits = Object.freeze({
  downloadBytes: 2 * 1024 ** 3,
  downloadConcurrency: 4,
  requestMs: 240000,
  phaseMs: 1200000,
  layerGrowthBytes: 2 * 1024 ** 3,
});
export function acquisitionPlan() {
  const rows = [
    ...frozen.artifacts.map((row) => ({
      ...row,
      file: "original/" + row.id + ".archive",
    })),
    ...catalog.components,
    ...catalog.authentication,
    ...catalog.npm.map((row) => ({
      ...row,
      file: "npm/" + row.sha256 + ".tgz",
    })),
    ...catalog.cargo.map((row) => ({
      ...row,
      file: "cargo/" + row.name + "-" + row.version + ".crate",
    })),
  ];
  const files = new Map();
  for (const row of rows) {
    relativeInput(row.file);
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes > 0 &&
        row.bytes <= 512 * 1024 ** 2,
    );
    assert.match(row.sha256, /^[a-f0-9]{64}$/u);
    const url = new URL(row.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.ok(!url.port || url.port === "443");
    const existing = files.get(row.file);
    if (existing)
      assert.deepEqual(
        [row.url, row.bytes, row.sha256],
        [existing.url, existing.bytes, existing.sha256],
      );
    else
      files.set(row.file, {
        url: row.url,
        file: row.file,
        bytes: row.bytes,
        sha256: row.sha256,
      });
  }
  const downloads = [...files.values()];
  assert.ok(
    downloads.reduce((sum, row) => sum + row.bytes, 0) <=
      preparationLimits.downloadBytes,
  );
  assert.equal(catalog.sourceCommit, frozen.sourceCommit);
  assert.equal(
    catalog.selectedCompatibleToolsAreHistoricalPublisherObservations,
    false,
  );
  return {
    downloads,
    downloadBytes: downloads.reduce((sum, row) => sum + row.bytes, 0),
    limits: preparationLimits,
    projectCodeExecuted: false,
    compilerExecuted: false,
    gateAComplete: false,
  };
}
const redirectHosts = new Set([
  "release-assets.githubusercontent.com",
  "storage.googleapis.com",
]);
export async function fetchOriginal(
  row,
  target,
  signal,
  fetcher = globalThis.fetch,
) {
  let current = row.url,
    response;
  const redirects = [];
  for (let index = 0; index < 4; index++) {
    response = await fetcher(current, {
      redirect: "manual",
      signal,
      headers: {
        "accept-encoding": "identity",
        "user-agent": "Checktrail-pinned-runtime-preparation",
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get("location"), current);
    assert.equal(next.protocol, "https:");
    assert.equal(next.username, "");
    assert.equal(next.password, "");
    assert.ok(
      (!next.port || next.port === "443") && redirectHosts.has(next.hostname),
      "Unexpected original artifact redirect",
    );
    redirects.push({ from: new URL(current).origin, to: next.origin });
    await response.body?.cancel();
    current = next.href;
  }
  assert.equal(response.status, 200);
  assert.ok(response.body && !response.redirected);
  const length = response.headers.get("content-length"),
    encoding = response.headers.get("content-encoding");
  if (length !== null) assert.equal(length, String(row.bytes));
  assert.ok(encoding === null || encoding === "identity");
  const partial = target + ".part";
  const out = await open(
    partial,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let count = 0;
  const digest = createHash("sha256");
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      count += chunk.length;
      assert.ok(count <= row.bytes, "Frozen byte ceiling exceeded");
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await out.write(chunk, offset, chunk.length - offset);
        assert.ok(result.bytesWritten > 0);
        offset += result.bytesWritten;
      }
    }
    signal.throwIfAborted();
    assert.equal(count, row.bytes);
    assert.equal(digest.digest("hex"), row.sha256);
    await out.sync();
  } finally {
    await out.close();
  }
  assert.deepEqual(await identify(partial), {
    bytes: row.bytes,
    sha256: row.sha256,
  });
  await link(partial, target);
  await unlink(partial);
  return { file: row.file, bytes: count, sha256: row.sha256, redirects };
}
const env = () =>
  Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WINDIR", "DOCKER_HOST"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
async function observe(
  root,
  id,
  executable,
  args,
  deadline,
  environment = env(),
) {
  const result = await boundedProcess(executable, args, {
    cwd: root,
    env: environment,
    deadline,
    prefix: path.join(root, id),
  });
  assert.equal(
    completeProcessObservation(result),
    true,
    JSON.stringify(result),
  );
  return result;
}
async function pin(file, maximum = 536870912) {
  return { file, ...(await identify(file, maximum)) };
}
export async function inventory(root) {
  assert.equal(await realpath(root), root);
  const rows = [];
  async function visit(base) {
    for (const name of (await readdir(base)).sort()) {
      const file = path.join(base, name),
        stat = await lstat(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await visit(file);
      else {
        assert.ok(stat.isFile());
        rows.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          ...(await identify(file, 134217728)),
        });
      }
    }
  }
  await visit(root);
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    directory: root,
    files: rows,
    manifestSha256: hash(JSON.stringify(rows)),
  };
}
async function authenticate(root, deadline) {
  const auth = (name) => path.join(root, "downloads/authentication", name);
  const proofs = [];
  for (const name of ["node", "rust"]) {
    const home = path.join(root, "gpg-" + name);
    await mkdir(home, { mode: 0o700 });
    const base = [
      "--batch",
      "--no-options",
      "--no-autostart",
      "--no-auto-key-retrieve",
      "--homedir",
      home,
    ];
    if (name === "node")
      await writeFile(
        path.join(home, "pubring.kbx"),
        await readFile(auth("node-release-keys-pinned.kbx")),
        { flag: "wx", mode: 0o600 },
      );
    else
      await observe(
        root,
        "rust-key-import",
        "gpg",
        [...base, "--import", auth("rust-release-public-key.asc")],
        deadline,
      );
    const signature = auth(
      name === "node"
        ? "node24-official-shasums.sig"
        : "rust-1.98.1-manifest.toml.asc",
    );
    const message = auth(
      name === "node"
        ? "node24-official-shasums.txt"
        : "rust-1.98.1-manifest.toml",
    );
    const attempt = await observe(
      root,
      name + "-signature",
      "gpg",
      [...base, "--status-fd", "1", "--verify", signature, message],
      deadline,
    );
    const status = await readFile(attempt.stdout.file, "utf8");
    assert.ok(
      !/\[GNUPG:\] (?:BADSIG|ERRSIG|REVKEYSIG|EXPKEYSIG|EXPSIG|NO_PUBKEY)\b/u.test(
        status,
      ),
    );
    const signatures = status
      .split("\n")
      .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
      .map((line) => line.split(" ")[2]);
    assert.deepEqual(signatures, [catalog.signers[name]]);
    proofs.push({
      name,
      signer: signatures[0],
      signatureVerified: true,
      attempt,
    });
  }
  const sums = await readFile(auth("node24-official-shasums.txt"), "utf8");
  const node = catalog.components.find((row) => row.name === "outer-node24");
  assert.ok(
    sums.split("\n").includes(node.sha256 + "  " + path.basename(node.file)),
  );
  // Component URL+digest membership in the signed Rust manifest is independently inspected.
  const manifest = await readFile(auth("rust-1.98.1-manifest.toml"), "utf8");
  for (const row of catalog.components.filter(
    (row) => row.name !== "outer-node24",
  )) {
    const escaped = row.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(
      manifest,
      new RegExp(
        'xz_url = "' + escaped + '"\\s+xz_hash = "' + row.sha256 + '"',
        "u",
      ),
    );
  }
  await writeFile(
    path.join(root, "authentication.json"),
    JSON.stringify({
      schemaVersion: 1,
      proofs,
      buildAncestryVerified: false,
      historicalPublisherConsumptionVerified: false,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
export async function acquire(root) {
  assert.ok(path.isAbsolute(root));
  await mkdir(root, { mode: 0o700 });
  assert.equal(await realpath(root), root);
  const start = performance.now(),
    deadline = start + preparationLimits.phaseMs;
  const python = await observe(
    root,
    "python-preflight",
    "python3",
    [
      "-c",
      "import sys,tomllib; assert sys.version_info >= (3,11); print(sys.version)",
    ],
    deadline,
  );
  assert.ok(python.started);
  const plan = acquisitionPlan(),
    downloads = path.join(root, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  for (const row of plan.downloads)
    await mkdir(path.dirname(path.join(downloads, row.file)), {
      recursive: true,
      mode: 0o700,
    });
  const observations = [];
  let next = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: preparationLimits.downloadConcurrency }, async () => {
      while (next < plan.downloads.length && failures.length === 0) {
        const row = plan.downloads[next++],
          abort = new globalThis.AbortController();
        const timer = setTimeout(
          () => abort.abort(new Error("Frozen acquisition deadline")),
          Math.max(
            1,
            Math.min(preparationLimits.requestMs, deadline - performance.now()),
          ),
        );
        try {
          observations.push(
            await fetchOriginal(
              row,
              path.join(downloads, row.file),
              abort.signal,
            ),
          );
        } catch (error) {
          failures.push(String(error));
        } finally {
          clearTimeout(timer);
        }
      }
    }),
  );
  await writeFile(
    path.join(root, "acquisition.json"),
    JSON.stringify({
      schemaVersion: 1,
      plan,
      observations,
      failures,
      durationMs: performance.now() - start,
      projectCodeExecuted: false,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  assert.deepEqual(failures, []);
  assert.equal(observations.length, plan.downloads.length);
  await authenticate(root, deadline);
  await observe(
    root,
    "archive-preparation",
    "python3",
    [
      path.join(directory, "web-runtime-prepare.py"),
      root,
      path.join(directory, "web-runtime-acquisition.v1.json"),
      path.join(directory, "web-runtime.v1.json"),
    ],
    deadline,
  );
  await mkdir(path.join(root, "npm-cache"), { mode: 0o700 });
  await observe(
    root,
    "npm-cache-preparation",
    process.execPath,
    [
      "--permission",
      "--allow-fs-read=" + root,
      "--allow-fs-read=" + directory,
      "--allow-fs-write=" + path.join(root, "npm-cache"),
      "--allow-fs-write=" + path.join(root, "npm-cache-proof.json"),
      path.join(directory, "web-runtime-npm-cache.mjs"),
      root,
      path.join(directory, "web-runtime-acquisition.v1.json"),
    ],
    deadline,
  );
  for (const row of plan.downloads)
    assert.deepEqual(await identify(path.join(downloads, row.file)), {
      bytes: row.bytes,
      sha256: row.sha256,
    });
  return {
    inputsAcquired: true,
    projectCodeExecuted: false,
    compilerExecuted: false,
    gateAComplete: false,
  };
}
export const toolObserverProgram = String.raw`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';const out=[];for(const [id,name] of Object.entries({node:process.execPath,npm:'npm',cargo:'cargo',rustc:'rustc',python:'python3',git:'git',tar:'tar'})){let selected;for(const file of path.isAbsolute(name)?[name]:process.env.PATH.split(':').map(dir=>path.join(dir,name))){try{fs.accessSync(file,fs.constants.X_OK);selected=fs.realpathSync(file);break;}catch(error){if(!['ENOENT','EACCES','ENOTDIR'].includes(error.code))throw error;}}if(!selected)throw Error('Missing actual tool '+id);const body=fs.readFileSync(selected);if(body.length>536870912)throw Error('Tool exceeds bound');out.push({id,file:selected,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')});}console.log(JSON.stringify(out));`;
export async function assemble(root, recipe) {
  validateNativeHost(hostObservation());
  assert.ok(recipe === "github" || recipe === "npm");
  assert.equal(await realpath(root), root);
  const deadline = performance.now() + preparationLimits.phaseMs;
  const space = await statfs(root);
  assert.ok(
    space.bavail * space.bsize >= 12 * 1024 ** 3,
    "Need12GiB free for fixed image/work retention",
  );
  for (const row of acquisitionPlan().downloads)
    assert.deepEqual(await identify(path.join(root, "downloads", row.file)), {
      bytes: row.bytes,
      sha256: row.sha256,
    });
  const dockerEnvironment = {
    ...env(),
    DOCKER_CONFIG: path.join(root, "docker-client"),
    DOCKER_BUILDKIT: "0",
  };
  await mkdir(dockerEnvironment.DOCKER_CONFIG, { mode: 0o700 });
  await writeFile(
    path.join(dockerEnvironment.DOCKER_CONFIG, "config.json"),
    "{}\n",
    { flag: "wx", mode: 0o600 },
  );
  const inspect = async (id, name) => {
    const attempt = await observe(
      root,
      name,
      "docker",
      ["image", "inspect", id],
      deadline,
      dockerEnvironment,
    );
    const value = JSON.parse(await readFile(attempt.stdout.file, "utf8"));
    assert.equal(value.length, 1);
    return value[0];
  };
  const base = await inspect(baseIdentity.selectedImage, "base-inspection");
  validateObservedImage(base, baseIdentity);
  assert.ok(!base.Config.OnBuild?.length);
  const context = path.join(root, "context"),
    dockerfile = path.join(context, "Dockerfile"),
    iid = path.join(root, "local-runtime.iid");
  await writeFile(dockerfile, assemblyDockerfile, { flag: "wx", mode: 0o600 });
  const command = assemblyCommand(iid, context);
  const attempt = await observe(
    root,
    "copy-image-build",
    "docker",
    command,
    deadline,
    dockerEnvironment,
  );
  const imageId = (await readFile(iid, "utf8")).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  const result = await inspect(imageId, "result-inspection");
  assert.equal(result.Id, imageId);
  assert.equal(result.Os, "linux");
  assert.equal(result.Architecture, "amd64");
  assert.deepEqual(
    result.RootFS.Layers.slice(0, base.RootFS.Layers.length),
    base.RootFS.Layers,
  );
  const addedLayerBytes = result.Size - base.Size;
  assert.ok(
    addedLayerBytes > 0 &&
      addedLayerBytes <= preparationLimits.layerGrowthBytes,
  );
  await writeFile(
    path.join(root, "assembly-base-inspect.json"),
    JSON.stringify(base) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(root, "assembly-result-inspect.json"),
    JSON.stringify(result) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const receipt = {
    schemaVersion: 1,
    assemblyKind: "docker-build-copy-only-v1",
    attempt,
    command,
    context,
    imageId,
    baseRef: baseIdentity.selectedImage,
    baseImageId: base.Id,
    rootfsDiffIds: result.RootFS.Layers,
    baseRootfsDiffIds: base.RootFS.Layers,
    addedLayerBytes,
    host: hostObservation(),
    rawManifestConfigVerified: false,
    registryPublished: false,
    compilerExecuted: false,
    projectHooksExecuted: false,
    historicalPublisherConsumptionVerified: false,
    sdkProducerBuildClosureVerified: false,
    gateAComplete: false,
  };
  await writeFile(
    path.join(root, "image-assembly.json"),
    JSON.stringify(receipt) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const toolName = "checktrail-runtime-tool-" + randomUUID();
  let toolAttempt;
  try {
    toolAttempt = await observe(
      root,
      "tool-observation",
      "docker",
      [
        "run",
        "--pull=never",
        "--rm",
        "--name",
        toolName,
        "--platform=linux/amd64",
        "--cpus=2",
        "--memory=4g",
        "--memory-swap=4g",
        "--pids-limit=256",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        imageId,
        "node",
        "--input-type=module",
        "-e",
        toolObserverProgram,
      ],
      deadline - 20000,
      dockerEnvironment,
    );
  } finally {
    await boundedProcess("docker", ["rm", "--force", toolName], {
      cwd: root,
      env: dockerEnvironment,
      deadline,
      prefix: path.join(root, "tool-cleanup"),
    });
    const remaining = await observe(
      root,
      "tool-cleanup-observation",
      "docker",
      ["ps", "--all", "--quiet", "--filter", "name=^/" + toolName + "$"],
      deadline,
      dockerEnvironment,
    );
    assert.equal((await readFile(remaining.stdout.file, "utf8")).trim(), "");
  }
  const tools = JSON.parse(await readFile(toolAttempt.stdout.file, "utf8"));
  const local = {};
  for (const [name, file] of Object.entries({
    buildReceipt: "image-assembly.json",
    iidFile: "local-runtime.iid",
    baseInspection: "assembly-base-inspect.json",
    resultInspection: "assembly-result-inspect.json",
    dockerfile: "context/Dockerfile",
    assemblyControl: null,
    copyManifest: "assembly-copy-manifest.json",
    authenticationReceipt: "authentication.json",
  }))
    local[name] = await pin(
      file === null ? fileURLToPath(import.meta.url) : path.join(root, file),
      name === "copyManifest" ? 2097152 : 1048576,
    );
  Object.assign(local, {
    inputs: await Promise.all(
      catalog.components.map(async (row) => ({
        id: row.name,
        ...(await pin(path.join(root, "downloads", row.file))),
      })),
    ),
    authentication: await Promise.all(
      catalog.authentication.map(async (row) => ({
        id: row.file,
        ...(await pin(path.join(root, "downloads", row.file))),
      })),
    ),
    baseRef: baseIdentity.selectedImage,
    baseImageId: base.Id,
    rootfsDiffIds: result.RootFS.Layers,
    baseRootfsDiffIds: base.RootFS.Layers,
    rawManifestConfigVerified: false,
  });
  const config = {
    schemaVersion: 1,
    task: "checktrail-runtime-controller-native",
    recipe,
    artifacts: frozen.artifacts.map((row) => ({
      ...row,
      file: path.join(root, "downloads/original/" + row.id + ".archive"),
    })),
    runtime: {
      kind: "local-derived",
      imageId,
      platform: "linux/amd64",
      ...catalog.versions,
      tools,
      local,
    },
    offlineInputs: {
      npm: await inventory(path.join(root, "npm-cache")),
      cargo: await inventory(path.join(root, "cargo-cache")),
    },
  };
  const plan = await prepare(config);
  assert.equal(plan.readyForOperatorExecution, true);
  await writeFile(
    path.join(root, "ready-inputs.json"),
    JSON.stringify(config) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(root, "ready-plan.json"),
    JSON.stringify(plan) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return {
    imageId,
    planSha256: plan.planSha256,
    nativeInvoked: false,
    compilerExecuted: false,
    gateAComplete: false,
  };
}
export async function cleanupImage(root) {
  assert.ok(path.isAbsolute(root));
  let imageId;
  try {
    imageId = (
      await readFile(path.join(root, "local-runtime.iid"), "utf8")
    ).trim();
  } catch (error) {
    if (error.code === "ENOENT")
      return { imageCreated: false, imageRemoved: false };
    throw error;
  }
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(
    ![baseIdentity.configDigest, baseIdentity.manifestDigest].includes(imageId),
  );
  const deadline = performance.now() + 20000;
  const inspected = await observe(
    root,
    "cleanup-image-inspection",
    "docker",
    ["image", "inspect", imageId],
    deadline,
  );
  const rows = JSON.parse(await readFile(inspected.stdout.file, "utf8"));
  assert.equal(rows.length, 1);
  const value = rows[0];
  assert.equal(value.Id, imageId);
  assert.equal(value.Config.Labels["checktrail.producer"], "web-runtime-v1");
  assert.deepEqual(
    value.RootFS.Layers.slice(0, baseIdentity.rootfsDiffIds.length),
    baseIdentity.rootfsDiffIds,
  );
  assert.ok(value.RootFS.Layers.length > baseIdentity.rootfsDiffIds.length);
  const users = await observe(
    root,
    "cleanup-image-references",
    "docker",
    ["ps", "--all", "--quiet", "--filter", "ancestor=" + imageId],
    deadline,
  );
  assert.equal(
    (await readFile(users.stdout.file, "utf8")).trim(),
    "",
    "Derived image is still used; retain it",
  );
  assert.equal(
    (value.RepoTags ?? []).length,
    0,
    "Retain an image with another tag reference",
  );
  await observe(
    root,
    "cleanup-image-removal",
    "docker",
    ["image", "rm", imageId],
    deadline,
  );
  const after = await boundedProcess("docker", ["image", "inspect", imageId], {
    cwd: root,
    env: env(),
    deadline,
    prefix: path.join(root, "cleanup-image-absence"),
  });
  assert.equal(after.started, true);
  assert.equal(after.terminalObserved, true);
  assert.equal(after.exitCode, 1);
  assert.equal(after.timedOut, false);
  assert.equal(after.truncated, false);
  assert.equal(after.signal, null);
  assert.equal(after.spawnError, null);
  assert.equal(after.storageFailure, null);
  assert.match(await readFile(after.stderr.file, "utf8"), /No such image/u);
  const receipt = {
    imageCreated: true,
    imageId,
    imageRemoved: true,
    sharedBaseRetained: true,
    globalPrune: false,
  };
  await writeFile(
    path.join(root, "image-cleanup.json"),
    JSON.stringify(receipt) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, root, recipe, ...flags] = process.argv.slice(2);
  if (mode === "acquire") {
    assert.equal(recipe, undefined);
    assert.deepEqual(flags, []);
    console.log(JSON.stringify(await acquire(root)));
  } else if (mode === "cleanup") {
    assert.equal(recipe, "--operator-trust-execution");
    assert.deepEqual(flags, []);
    console.log(JSON.stringify(await cleanupImage(root)));
  } else {
    assert.equal(mode, "assemble");
    assert.deepEqual(flags, [
      "--operator-trust-execution",
      "--coordinated-heavy-slot",
    ]);
    console.log(JSON.stringify(await assemble(root, recipe)));
  }
}
