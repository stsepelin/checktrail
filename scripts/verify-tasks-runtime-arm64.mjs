import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as provenance from "./native-provenance-runtime-evidence.mjs";
import { requireProvenanceSourceBuild } from "./native-provenance-source-build.mjs";
import { captureCompiledEngine } from "./compiled-engine-evidence.mjs";
import { execFileSync } from "node:child_process";
import {
  realpath,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runAcceptanceNpm } from "./install-acceptance-package.mjs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { pullPinnedImage } from "./pull-pinned-image.mjs";
import { consumerRuntimeBaseImages } from "./consumer-runtime-selection.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
export const arm64ProvenanceSlot = "native-linux-arm64-node22";
export const arm64RuntimeReference =
  "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const reference = arm64RuntimeReference;

export async function captureArm64ProvenanceImageDefinition(repository) {
  const file = "scripts/consumer-runtime-tools.Dockerfile";
  const bytes = await readFile(path.join(repository, file));
  const text = bytes.toString("utf8");
  assert.ok(
    text.startsWith(
      `FROM ${consumerRuntimeBaseImages.node} AS node\nFROM ${consumerRuntimeBaseImages.system}\n`,
    ),
  );
  assert.equal(
    text.split("\n").filter((line) => line.startsWith("FROM ")).length,
    2,
  );
  assert.equal(consumerRuntimeBaseImages.node, arm64RuntimeReference);
  return { file, sha256: provenance.provenanceRuntimeHash(bytes) };
}

export function bindArm64ProvenanceImage(definition, baseImages, image) {
  assert.equal(definition.file, "scripts/consumer-runtime-tools.Dockerfile");
  assert.match(definition.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(baseImages).sort(), ["node", "system"]);
  const bases = {};
  for (const [key, reference] of Object.entries(consumerRuntimeBaseImages)) {
    const base = baseImages[key];
    assert.equal(base.reference, reference);
    assert.match(base.image.Id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(base.image.Os, "linux");
    assert.equal(base.image.Architecture, "arm64");
    bases[key] = { reference, imageId: base.image.Id };
  }
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "arm64");
  assert.notEqual(image.Id, bases.node.imageId);
  return {
    definition,
    baseImages: bases,
    imageId: image.Id,
    platform: image.Os,
    architecture: image.Architecture,
  };
}

export function arm64RuntimeRunArguments({
  name,
  task,
  preparedCache,
  imageId,
  imageReference,
  command,
}) {
  return [
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
    "--user",
    "65532:65532",
    "--cpus",
    "2",
    "--memory",
    "3g",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=2048m,mode=1777",
    "--mount",
    "type=bind,src=" + root + ",target=/workspace,readonly",
    "--mount",
    "type=bind,src=" + preparedCache + ",target=/prepared-cache,readonly",
    "--workdir",
    "/workspace",
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "CHECKTRAIL_EVAL_RUNTIME_IMAGE_REFERENCE=" + imageReference,
    "--env",
    "CHECKTRAIL_EVAL_RUNTIME_IMAGE_ID=" + imageId,
    "--env",
    "CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID=" + imageId,
    imageId,
    "sh",
    "-c",
    command,
  ];
}

export function splitArm64RuntimePackets(output) {
  assert.equal(typeof output, "string");
  const lines = [];
  let start = 0;
  while (start < output.length) {
    const newline = output.indexOf("\n", start);
    const end = newline === -1 ? output.length : newline + 1;
    const raw = output.slice(start, end);
    assert.ok(raw.trim().length > 0, "Empty ARM runtime packet");
    lines.push({ raw, packet: JSON.parse(raw) });
    start = end;
  }
  assert.ok(lines.length <= 9, "Unexpected ARM runtime packet count");
  return lines;
}

export async function captureArm64ProvenanceBindings(repository) {
  const inventory = JSON.parse(
    await readFile(path.join(repository, "docs/gate-a-profiles.v1.json")),
  );
  const definitions = JSON.parse(
    await readFile(path.join(repository, "scripts/required-native-tests.json")),
  );
  const requirements = provenance.selectProvenanceRuntimeRequirements(
    definitions,
    inventory,
  );
  const inputSources = await provenance.captureProvenanceHarness(repository);
  return {
    sourceBinding: await provenance.captureProvenanceSource(repository),
    compiledEngine: await captureCompiledEngine(
      path.join(repository, "dist/src"),
    ),
    inputSources,
    harnessSha256: provenance.provenanceRuntimeHash(
      JSON.stringify(inputSources),
    ),
    requirements,
    requirementsSha256: provenance.provenanceRuntimeHash(
      JSON.stringify(requirements),
    ),
    selectedRuntime: inventory.runtimeProfiles.find(
      (row) => row.id === arm64ProvenanceSlot,
    ),
  };
}

export function requireArm64ProvenanceStartup(packet, bindings, imageId) {
  assert.equal(packet.profile, "native-provenance-arm64-startup-v1");
  const expected = packet.expected;
  assert.equal(expected.installed, false);
  assert.deepEqual(expected.sourceBinding, bindings.sourceBinding);
  assert.equal(expected.sourceBinding.worktreeClean, true);
  assert.deepEqual(expected.inputSources, bindings.inputSources);
  assert.equal(expected.harnessSha256, bindings.harnessSha256);
  assert.deepEqual(expected.requirements, bindings.requirements);
  assert.equal(expected.requirementsSha256, bindings.requirementsSha256);
  for (const key of [
    "schemaVersion",
    "fileCount",
    "bytes",
    "treeSha256",
    "manifestSha256",
  ])
    assert.equal(expected.compiledEngine[key], bindings.compiledEngine[key]);
  assert.equal(expected.runtime.slot, arm64ProvenanceSlot);
  assert.equal(expected.runtime.node, "22.23.2");
  assert.equal(expected.runtime.platform, "linux");
  assert.equal(expected.runtime.architecture, "arm64");
  assert.equal(expected.runtime.containerImageId, imageId);
  assert.deepEqual(expected.runtime.selectedRuntime, bindings.selectedRuntime);
  requireProvenanceSourceBuild(expected.sourceBuild, expected);
  return expected;
}

export function requireArm64ProvenanceCompletion(packet, expected) {
  provenance.requireProvenanceRuntimeEvidence(
    { ...packet, installedEvidence: null },
    expected,
  );
  provenance.requireProvenanceRuntimeInstallation(
    packet.installedEvidence,
    packet,
    expected.requirements,
  );
  assert.equal(packet.complete, true);
  assert.equal(packet.selectedSlotQualified, true);
  return packet;
}

export async function publishArm64ProvenanceReceipt(
  raw,
  destination,
  expected,
  publish = provenance.publishProvenanceRuntimeReceipt,
) {
  if (destination === undefined) return null;
  assert.equal(
    typeof publish,
    "function",
    "Shared provenance receipt publisher is required",
  );
  return publish(Buffer.from(raw, "utf8"), destination, expected);
}

export async function captureArm64ProvenanceOutput(
  output,
  bindings,
  imageId,
  destination,
  containerFailure,
  publish,
) {
  let lines,
    receipt = null;
  try {
    lines = splitArm64RuntimePackets(output);
    if (lines.length === 9) {
      const expected = requireArm64ProvenanceStartup(
        lines[7].packet,
        bindings,
        imageId,
      );
      // A positive packet is not publication authority. Keep only explicitly
      // incomplete diagnostics here; main qualifies all profiles and freshness
      // after the container has completed naturally before publishing success.
      if (lines[8].packet.complete === false)
        receipt = await publishArm64ProvenanceReceipt(
          lines[8].raw,
          destination,
          expected,
          publish,
        );
    }
  } catch (captureFailure) {
    if (containerFailure) {
      containerFailure.provenanceCaptureFailure = captureFailure;
      throw containerFailure;
    }
    throw captureFailure;
  }
  if (containerFailure) throw containerFailure;
  assert.equal(lines.length, 9);
  return { lines, receipt };
}

export async function publishQualifiedArm64ProvenanceReceipt(
  raw,
  destination,
  expected,
  qualify,
  publish,
) {
  assert.equal(JSON.parse(raw).complete, true);
  assert.equal(typeof qualify, "function");
  await qualify();
  return publishArm64ProvenanceReceipt(raw, destination, expected, publish);
}

export function arm64TasksRuntimeCommand() {
  return `set -eu
node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache
node scripts/verify-tasks-runtime.mjs native-linux-arm64-node22
node scripts/verify-review-runtime.mjs native-linux-arm64-node22
node scripts/verify-review-runtime.mjs native-linux-arm64-node22 confidence-provenance
node scripts/verify-required-native-tests.mjs lifecycle-runtime-bindings
node scripts/verify-lifecycle-platforms.mjs native-linux-arm64-node22
node scripts/verify-evaluation-runtime.mjs native-linux-arm64-node22`;
}

export function arm64ProvenanceRuntimeCommand() {
  return `set -eu
node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache >/dev/null
# The source checkout remains readonly. Trust only this exact worktree for Git
# metadata, using an owned temporary wrapper because capture strips Git env.
mkdir /tmp/checktrail-provenance-git
printf '%s\n' '#!/bin/sh' 'exec /usr/bin/git -c safe.directory=/workspace "$@"' > /tmp/checktrail-provenance-git/git
chmod 555 /tmp/checktrail-provenance-git/git
export PATH=/tmp/checktrail-provenance-git:$PATH
git rev-parse --is-inside-work-tree >/dev/null
node --input-type=module <<'CHECKTRAIL_PROVENANCE_STARTUP'
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {captureCompiledEngine} from './scripts/compiled-engine-evidence.mjs';
import {observeProvenanceSourceBuild,requireProvenanceSourceBuild} from './scripts/native-provenance-source-build.mjs';
import {captureProvenanceRuntime,captureProvenanceSource,captureProvenanceHarness,provenanceRuntimeHash,selectProvenanceRuntimeRequirements} from './scripts/native-provenance-runtime-evidence.mjs';
const inventory=JSON.parse(await readFile('docs/gate-a-profiles.v1.json'));
const definitions=JSON.parse(await readFile('scripts/required-native-tests.json'));
const runtime=await captureProvenanceRuntime(inventory,'native-linux-arm64-node22');
const sourceBinding=await captureProvenanceSource('/workspace');
assert.equal(sourceBinding.worktreeClean,true);
const inputSources=await captureProvenanceHarness('/workspace');
const requirements=selectProvenanceRuntimeRequirements(definitions,inventory);
const compiledEngine=await captureCompiledEngine('/workspace/dist/src');
const sourceBuild=await observeProvenanceSourceBuild('/workspace',sourceBinding);
const expected={runtime,sourceBinding,sourceBuild,inputSources,harnessSha256:provenanceRuntimeHash(JSON.stringify(inputSources)),requirementsSha256:provenanceRuntimeHash(JSON.stringify(requirements)),compiledEngine,requirements,installed:false};
requireProvenanceSourceBuild(sourceBuild,expected);
process.stdout.write(JSON.stringify({profile:'native-provenance-arm64-startup-v1',expected})+String.fromCharCode(10));
CHECKTRAIL_PROVENANCE_STARTUP
node scripts/verify-native-provenance-runtime.mjs native-linux-arm64-node22`;
}

export async function mainArm64TasksRuntime() {
  assert.ok(["linux", "darwin"].includes(process.platform));
  assert.equal(process.arch, "arm64");
  const name = "checktrail-tasks-runtime-" + process.pid,
    provenanceName = name + "-provenance",
    provenanceTag = name + "-provenance-" + randomBytes(6).toString("hex"),
    task = process.env.CHECKTRAIL_TEST_TASK ?? "tasks-runtime-native-arm64";
  assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
  const cache = await realpath(
    runAcceptanceNpm(["config", "get", "cache"], { encoding: "utf8" }).trim(),
  );
  assert.equal((await lstat(cache)).isDirectory(), true);
  const run = (args, timeout = 1200000) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 8 * 1048576,
    });
  await pullPinnedImage(reference);
  const [image] = JSON.parse(run(["image", "inspect", reference]));
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "arm64");
  const temporary = await realpath(
    await mkdtemp(path.join(tmpdir(), "checktrail-tasks-public-cache-")),
  );
  const preparedCache = path.join(temporary, "cache");
  let provenanceImage;
  try {
    const prepared = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/prepare-acceptance-cache-subset.mjs", cache, preparedCache],
        { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 1048576 },
      ),
    );
    // Only the verified locked public tarballs are mounted. Make this owned tree
    // readable to the unprivileged container without exposing the host npm cache.
    async function publicPermissions(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await publicPermissions(file);
        else {
          assert.equal(entry.isFile(), true);
          await chmod(file, 0o444);
        }
      }
      await chmod(directory, 0o755);
    }
    await publicPermissions(temporary);
    const provenanceBindings = await captureArm64ProvenanceBindings(root);
    const definition = await captureArm64ProvenanceImageDefinition(root);
    const baseImages = {};
    for (const [key, reference] of Object.entries(consumerRuntimeBaseImages)) {
      await pullPinnedImage(reference);
      const [base] = JSON.parse(run(["image", "inspect", reference]));
      baseImages[key] = { reference, image: base };
    }
    const context = path.join(temporary, "empty-context");
    await mkdir(context);
    run([
      "build",
      "--network=none",
      "--pull=false",
      "--label",
      "checktrail.task=" + task,
      "--file",
      path.join(root, definition.file),
      "--tag",
      provenanceTag,
      context,
    ]);
    [provenanceImage] = JSON.parse(run(["image", "inspect", provenanceTag]));
    assert.equal(provenanceImage.Config.Labels["checktrail.task"], task);
    const nativeProvenanceRuntimeImage = bindArm64ProvenanceImage(
      definition,
      baseImages,
      provenanceImage,
    );
    let output, containerFailure;
    const runtimeDeadline = Date.now() + 1200000;
    try {
      output = run(
        arm64RuntimeRunArguments({
          name,
          task,
          preparedCache,
          imageId: image.Id,
          imageReference: reference,
          command: arm64TasksRuntimeCommand(),
        }),
        Math.max(1, runtimeDeadline - Date.now()),
      );
      assert.equal(
        splitArm64RuntimePackets(output).length,
        7,
        "Original bare-Node profiles incomplete",
      );
      output += run(
        arm64RuntimeRunArguments({
          name: provenanceName,
          task,
          preparedCache,
          imageId: provenanceImage.Id,
          imageReference: provenanceImage.Id,
          command: arm64ProvenanceRuntimeCommand(),
        }),
        Math.max(1, runtimeDeadline - Date.now()),
      );
    } catch (error) {
      output = (output ?? "") + (error.stdout?.toString() ?? "");
      containerFailure = error;
    }
    let { lines, receipt: nativeProvenanceReceipt } =
      await captureArm64ProvenanceOutput(
        output,
        provenanceBindings,
        provenanceImage.Id,
        process.env.CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_RECEIPT,
        containerFailure,
      );
    const packets = lines.map((line) => line.packet);
    const [
      ,
      source,
      reviewWorkflow,
      confidenceProvenance,
      lifecycleAdmission,
      lifecycleSource,
      evaluationRuntime,
      nativeProvenanceStartup,
      nativeProvenanceRuntime,
    ] = packets;
    const expectedProvenance = requireArm64ProvenanceStartup(
      nativeProvenanceStartup,
      provenanceBindings,
      provenanceImage.Id,
    );
    const installed = source.installedEvidence;
    const lifecycleInstalled = lifecycleSource.installedEvidence;
    assert.equal(source.profileEvidence.complete, true);
    assert.equal(installed.evidence.profileEvidence.complete, true);
    assert.equal(source.harnessSha256, installed.evidence.harnessSha256);
    assert.equal(
      source.runtimeArtifactsSha256,
      installed.evidence.runtimeArtifactsSha256,
    );
    assert.equal(evaluationRuntime.profileEvidence.complete, true);
    assert.equal(
      evaluationRuntime.installedEvidence.runtimeEvidence.profileEvidence
        .complete,
      true,
    );
    assert.equal(evaluationRuntime.runtime.containerImageId, image.Id);
    assert.equal(
      expectedProvenance.runtime.nodeExecutableSha256,
      evaluationRuntime.runtime.nodeExecutableSha256,
      "Derived provenance image must execute the original pinned Node bytes",
    );
    assert.equal(
      evaluationRuntime.installedEvidence.runtimeEvidence.runtime
        .containerImageId,
      image.Id,
    );
    assert.equal(reviewWorkflow.complete, true);
    assert.equal(reviewWorkflow.runtime.containerImageId, image.Id);
    assert.equal(
      reviewWorkflow.installedEvidence.profile.runtime.containerImageId,
      image.Id,
    );
    for (const evidence of [
      confidenceProvenance,
      confidenceProvenance.installedEvidence.profile,
    ]) {
      assert.equal(evidence.profile, "confidence-provenance-runtime-v1");
      assert.equal(evidence.complete, true);
      assert.equal(evidence.required, 9);
      assert.equal(evidence.passed, 9);
      assert.equal(evidence.runtime.slot, "native-linux-arm64-node22");
      assert.equal(evidence.runtime.containerImageId, image.Id);
      assert.equal(evidence.gateAComplete, false);
      assert.equal(evidence.qualityAssessed, false);
    }
    assert.equal(lifecycleAdmission.complete, true);
    const nativeDefinitions = JSON.parse(
      await readFile(
        new URL("./required-native-tests.json", import.meta.url),
        "utf8",
      ),
    );
    const foundationProfiles = ["posix-cleanup", "posix-owner"];
    const foundationRequired = foundationProfiles.reduce(
      (total, profile) => total + nativeDefinitions[profile].length,
      0,
    );
    for (const evidence of [lifecycleSource, lifecycleInstalled.evidence]) {
      assert.equal(evidence.complete, true);
      assert.equal(evidence.required, 9);
      assert.equal(evidence.passed, 9);
      assert.equal(
        evidence.completionScope,
        "whole-profile-and-selected-platform-foundation",
      );
      assert.equal(evidence.foundation.complete, true);
      assert.deepEqual(
        evidence.foundation.profiles,
        foundationProfiles.map((profile) => ({
          profile,
          required: nativeDefinitions[profile].length,
        })),
      );
      assert.equal(evidence.foundation.required, foundationRequired);
      assert.equal(evidence.foundation.passed, foundationRequired);
      assert.equal(evidence.foundation.ledger.truncated, false);
      assert.equal(evidence.foundation.ledger.cases.length, foundationRequired);
      assert.ok(
        evidence.foundation.ledger.cases.every(
          (row) => row.outcome === "passed",
        ),
      );
      assert.equal(evidence.runtime.slot, "native-linux-arm64-node22");
      assert.equal(evidence.selectedRuntime.id, "native-linux-arm64-node22");
      assert.equal(evidence.runtime.containerImageId, image.Id);
      assert.equal(
        evidence.compiledEngine.beforeAfterByteIdentitiesMatch,
        true,
      );
    }
    assert.equal(
      lifecycleSource.harnessSha256,
      lifecycleInstalled.harnessSha256,
    );
    assert.equal(
      lifecycleSource.compiledEngine.treeSha256,
      lifecycleInstalled.compiledEngine.treeSha256,
    );
    assert.equal(
      lifecycleSource.compiledEngine.treeSha256,
      lifecycleInstalled.evidence.compiledEngine.treeSha256,
    );
    nativeProvenanceReceipt = await publishQualifiedArm64ProvenanceReceipt(
      lines[8].raw,
      process.env.CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_RECEIPT,
      expectedProvenance,
      async () => {
        requireArm64ProvenanceCompletion(
          nativeProvenanceRuntime,
          expectedProvenance,
        );
        assert.deepEqual(
          await captureArm64ProvenanceImageDefinition(root),
          definition,
          "Provenance Docker definition changed during ARM qualification",
        );
        assert.deepEqual(
          await captureArm64ProvenanceBindings(root),
          provenanceBindings,
          "Outer source/harness/compiled bytes changed during ARM qualification",
        );
      },
    );
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        preparedPublicCache: prepared,
        profile: "tasks-runtime-arm64-foundation-v1",
        reference,
        imageId: image.Id,
        network: "none",
        sourceReadOnly: true,
        source,
        installed,
        reviewWorkflow,
        confidenceProvenance,
        evaluationRuntime,
        lifecycleAdmission,
        lifecycleSource,
        lifecycleInstalled,
        nativeProvenanceRuntime,
        nativeProvenanceRuntimeImage,
        nativeProvenanceReceipt: nativeProvenanceReceipt && {
          bytes: nativeProvenanceReceipt.bytes,
          sha256: nativeProvenanceReceipt.sha256,
          complete: nativeProvenanceReceipt.complete,
          selectedSlotQualified: nativeProvenanceReceipt.selectedSlotQualified,
        },
        gateATasksMatrixComplete: false,
        gateALifecycleComplete: false,
      }) + "\n",
    );
  } finally {
    for (const ownedName of [name, provenanceName]) {
      let owned;
      try {
        owned = run(
          [
            "container",
            "inspect",
            ownedName,
            "--format",
            '{{index .Config.Labels "checktrail.task"}}',
          ],
          10000,
        ).trim();
      } catch (error) {
        assert.match(
          error.stderr?.toString() ?? "",
          /No such (?:container|object)/,
        );
      }
      if (owned !== undefined) {
        assert.equal(owned, task);
        run(["rm", "-f", ownedName], 10000);
      }
      assert.equal(
        run(
          ["ps", "-aq", "--filter", "name=^/" + ownedName + "$"],
          10000,
        ).trim(),
        "",
      );
    }
    let tagged;
    try {
      [tagged] = JSON.parse(run(["image", "inspect", provenanceTag], 10000));
    } catch (error) {
      assert.match(error.stderr?.toString() ?? "", /No such (?:image|object)/);
    }
    if (tagged) {
      assert.equal(tagged.Config.Labels["checktrail.task"], task);
      if (provenanceImage) assert.equal(tagged.Id, provenanceImage.Id);
      run(["image", "rm", provenanceTag], 10000);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await mainArm64TasksRuntime();
