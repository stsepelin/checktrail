import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { kotlinRead } from "../dist/src/kotlin-io.js";
import { scala2Artifacts } from "../dist/src/scala2-artifacts.js";
import {
  scala2ReleaseArchiveFilename,
  scala2ReleaseSignature,
  scala2ReleaseSignatureReference,
  scala2ReleaseSignatureReferenceSchema,
} from "../dist/src/scala2-release-signature.js";
import {
  readScala2SignatureCases,
  validateScala2SignatureNativeReceipt,
  validateScala2SignatureInstalledReceipt,
} from "./verify-scala2-signature-installed.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const invoke = promisify(execFile);
const preparationSchema = z.strictObject({
  archive: z.string().min(1),
  proofSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reference: scala2ReleaseSignatureReferenceSchema,
  operatorProofPinSelectionRequired: z.literal(true),
  distributionSignatureVerified: z.literal(false),
  completeArtifactAndNoticeClosureVerified: z.literal(false),
});
export function validateScala2SignaturePreparationManifest(value, root) {
  assert.ok(path.isAbsolute(root));
  const manifest = preparationSchema.parse(value);
  const qualified = path.join(
    root,
    ".checktrail/scala-signed-tools",
    manifest.proofSha256,
  );
  assert.equal(
    manifest.archive,
    path.join(qualified, scala2ReleaseArchiveFilename),
  );
  assert.deepEqual(
    manifest.reference,
    scala2ReleaseSignatureReference(manifest.proofSha256),
  );
  return { manifest, qualified };
}
export async function readScala2SignaturePreparation(
  file,
  source = repository,
) {
  assert.ok(path.isAbsolute(file));
  assert.equal(await realpath(file), file);
  const root = await realpath(source),
    body = await kotlinRead(file, 64 * 1024),
    text = body.toString("utf8");
  const documents = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  assert.ok(
    documents.length === 1 &&
      !documents[0].errors.length &&
      !documents[0].warnings.length,
    "Preparation manifest JSON is ambiguous",
  );
  const { manifest, qualified } = validateScala2SignaturePreparationManifest(
    JSON.parse(text),
    root,
  );
  const reference = scala2ReleaseSignature(
    manifest.archive,
    await kotlinRead(manifest.archive, scala2Artifacts.archiveBytes),
    manifest.proofSha256,
  );
  assert.deepEqual(
    manifest.reference,
    reference,
    "Preparation manifest differs from the physical compiled-policy cohort",
  );
  return {
    manifest,
    qualified,
    manifestSha256: createHash("sha256").update(body).digest("hex"),
  };
}
export async function verifyScala2SignatureContainer(manifestFile) {
  const prepared = await readScala2SignaturePreparation(manifestFile),
    cases = await readScala2SignatureCases();
  const selected = process.env.CHECKTRAIL_SCALA_EXTENSIONS_IMAGE;
  assert.ok(
    selected,
    "Select the existing operator-prepared pinned Scala extension image",
  );
  const image = execFileSync(
    "docker",
    ["image", "inspect", selected, "--format", "{{.Id}}"],
    { encoding: "utf8" },
  ).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const task =
    process.env.CHECKTRAIL_TEST_TASK ?? "scala2-signature-acceptance";
  assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
  const cache = execFileSync("npm", ["config", "get", "cache"], {
    encoding: "utf8",
  }).trim();
  assert.ok(path.isAbsolute(cache));
  assert.equal(await realpath(cache), cache);
  const sourceRoot = await realpath(repository),
    qualified =
      "/workspace/" +
      path.relative(sourceRoot, prepared.qualified).split(path.sep).join("/"),
    pin = prepared.manifest.proofSha256;
  const abort = new globalThis.AbortController(),
    interrupted = () => abort.abort();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  const cleanup = [];
  async function removeOwned(name) {
    const ids = execFileSync(
      "docker",
      ["container", "ls", "-aq", "--filter", "name=^/" + name + "$"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const id of ids) {
      const value = JSON.parse(
        execFileSync("docker", ["container", "inspect", id], {
          encoding: "utf8",
        }),
      )[0];
      assert.equal(value.Name, "/" + name);
      assert.equal(value.Config.Labels["checktrail.task"], task);
      assert.equal(value.Image, image);
      execFileSync("docker", ["container", "rm", "-f", id], { stdio: "pipe" });
    }
    assert.equal(
      execFileSync(
        "docker",
        ["container", "ls", "-aq", "--filter", "name=^/" + name + "$"],
        { encoding: "utf8" },
      ).trim(),
      "",
      "Owned signature container remains",
    );
    cleanup.push({
      role: name.endsWith("-source") ? "source" : "installed",
      containerAbsent: true,
    });
  }
  async function run(role, args) {
    const name =
      "checktrail-scala2-signature-" +
      randomUUID().replaceAll("-", "") +
      "-" +
      role;
    try {
      const result = await invoke(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--name",
          name,
          "--label",
          "checktrail.task=" + task,
          "--network",
          "none",
          "--read-only",
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--pids-limit",
          "256",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,exec,size=1024m",
          "--mount",
          `type=bind,src=${sourceRoot},target=/workspace,readonly`,
          "--mount",
          `type=bind,src=${cache},target=/prepared-cache,readonly`,
          "--env",
          "npm_config_cache=/tmp/npm-cache",
          "--workdir",
          "/workspace",
          image,
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 1200000,
          maxBuffer: 4 * 1024 * 1024,
          signal: abort.signal,
        },
      );
      process.stderr.write(result.stderr);
      return JSON.parse(result.stdout);
    } finally {
      await removeOwned(name);
    }
  }
  try {
    const source = validateScala2SignatureNativeReceipt(
      await run("source", [
        "node",
        "scripts/verify-scala2-signature-native.mjs",
        "/workspace",
        qualified,
        pin,
      ]),
      "/workspace",
      cases,
    );
    const installed = validateScala2SignatureInstalledReceipt(
      await run("installed", [
        "/bin/sh",
        "-c",
        'node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache > /tmp/scala2-signature-cache.json && node scripts/verify-scala2-signature-installed.mjs "$1" "$2"',
        "scala2-signature-installed",
        qualified,
        pin,
      ]),
      cases,
    );
    assert.deepEqual(
      await readScala2SignaturePreparation(manifestFile),
      prepared,
      "Physical preparation changed during acceptance",
    );
    return {
      schemaVersion: 1,
      profile: "scala2-operator-pinned-selected-jar-signatures",
      preparation: {
        manifestSha256: prepared.manifestSha256,
        reference: prepared.manifest.reference,
        keyOwnerTrustEstablished: false,
        keyValidityAssessed: false,
      },
      caseManifestSha256: cases.sha256,
      requiredCaseIds: cases.requiredCaseIds,
      runtime: {
        image,
        maxConcurrentContainers: 1,
        cpus: 2,
        memoryMiB: 2048,
        pids: 256,
        temporaryFilesystemMiB: 1024,
        network: "none",
        rootFilesystemReadonly: true,
        sourceMountReadonly: true,
        preparedCacheReadonly: true,
      },
      source,
      installed,
      cleanup,
      complete: true,
      fullArtifactClosureClaimed: false,
      gateAComplete: false,
    };
  } finally {
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(
    process.argv.length,
    3,
    "Pass the absolute native-preparation manifest path",
  );
  process.stdout.write(
    JSON.stringify(await verifyScala2SignatureContainer(process.argv[2])) +
      "\n",
  );
}
