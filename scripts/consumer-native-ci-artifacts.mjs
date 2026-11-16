import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  consumerNativeScopeJob,
  consumerNativeCapsuleFilename,
} from "./consumer-native-acceptance-capsule.mjs";
import { consumerNativeArtifactName } from "./consumer-native-job-claims.mjs";
import {
  requireNativeCIArtifactDirectory as directory,
  readNativeCIArtifact as artifact,
} from "./native-ci-artifact-storage.mjs";
/** Convert only Windows separator spelling; physical/link/ACL admission stays strict. */
export function consumerNativeCIDirectory(value, paths = path) {
  assert.ok(
    typeof value === "string" && paths.isAbsolute(value),
    "Native CI directory must be absolute",
  );
  return paths.sep === "\\" ? value.replaceAll("/", "\\") : value;
}
/** Downloaded sanitized capsules are bounded transport data, not native inode or host attestation. Keep per-artifact directories to expose duplicate scope uploads. */
export async function readConsumerNativeCapsuleArtifacts(
  root,
  selected,
  producerBindings,
) {
  assert.ok(path.isAbsolute(root));
  assert.ok(
    Array.isArray(producerBindings) &&
      producerBindings.length > 0 &&
      producerBindings.length <= selected.length,
  );
  assert.ok(
    Array.isArray(selected) && selected.length > 0 && selected.length <= 26,
  );
  await directory(root);
  const names = await readdir(root),
    capsules = [],
    containers = [];
  for (const binding of producerBindings)
    assert.equal(
      binding.finish.artifact.name,
      consumerNativeArtifactName(
        binding.job,
        binding.lane,
        binding.start.runAttempt,
      ),
    );
  // Pinned download-artifact v8 writes one matched artifact directly to root, even with merge-multiple:false; multiple matches use named directories. Require that exact known layout, never guess a fallback.
  if (producerBindings.length === 1)
    containers.push({ parent: root, binding: producerBindings[0] });
  else {
    assert.deepEqual(
      names.sort(),
      producerBindings.map((row) => row.finish.artifact.name).sort(),
      "Selected immutable native artifact is missing or foreign",
    );
    for (const name of names) {
      assert.match(name, /^native-consumer-[a-z0-9-]+$/);
      const binding = producerBindings.find(
        (row) => row.finish.artifact.name === name,
      );
      assert.ok(binding);
      const parent = path.join(root, name);
      await directory(parent);
      containers.push({ parent, binding });
    }
  }
  for (const { parent, binding } of containers) {
    const files = await readdir(parent);
    assert.equal(files.length, binding.finish.capsules.length);
    for (const filename of files) {
      assert.match(filename, /^[a-z-]+--[a-z0-9-]+\.json$/);
      const capsule = await artifact(path.join(parent, filename)),
        scope = selected.find((scope) => scope.id === capsule.scope?.id);
      assert.ok(scope, "Foreign native capsule artifact");
      assert.equal(filename, consumerNativeCapsuleFilename(scope));
      assert.equal(consumerNativeScopeJob(scope), binding.job);
      const expected = binding.finish.capsules.find(
        (row) => row.scopeId === scope.id,
      );
      assert.ok(
        expected,
        "Foreign scope in selected immutable native artifact",
      );
      assert.equal(capsule.capsuleSha256, expected.sha256);
      assert.equal(capsule.attemptId, expected.attemptId);
      assert.equal(capsule.ci.runId, binding.start.runId);
      assert.equal(capsule.ci.runAttempt, binding.start.runAttempt);

      capsules.push(capsule);
      assert.ok(capsules.length <= selected.length);
    }
  }
  return capsules;
}

// Preserve the shared reader exports while keeping consumer-specific imports out
// of the low-level built-ins-only transport boundary.
export {
  requireNativeCIArtifactDirectory,
  readNativeCIArtifact,
} from "./native-ci-artifact-storage.mjs";
