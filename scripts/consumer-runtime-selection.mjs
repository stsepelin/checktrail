import assert from "node:assert/strict";
export const consumerRuntimeBaseImages = Object.freeze({
  node: "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
  system:
    "docker.io/library/golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6",
});
/** Match observed metadata; neither environment variables nor this comparison attest a host. */
export function checkConsumerRuntimeSelection(
  scope,
  slot,
  observed,
  hosted = false,
) {
  assert.equal(typeof hosted, "boolean");
  if (slot === null) {
    assert.equal(hosted, false, "Hosted runtime requires a selected slot");
    return null;
  }
  const choices = scope.runtimeProfiles.filter((p) => p.id === slot);
  assert.equal(choices.length, 1, "Unknown selected runtime slot");
  const selected = choices[0];
  for (const key of ["node", "platform", "architecture"])
    assert.equal(
      observed[key],
      selected[key],
      "Selected runtime " + key + " differs",
    );
  if (selected.platform === "win32") {
    assert.match(
      observed.osVersion,
      /^Windows Server 2025 (?:Datacenter|Standard)$/,
    );
    assert.equal(observed.osRelease, "10.0.26100");
    assert.match(observed.imageOS ?? "", /^win25(?:-vs2026)?$/);
    assert.match(observed.systemPowerShellSha256 ?? "", /^[a-f0-9]{64}$/);
  } else if (selected.platform === "darwin") {
    assert.match(observed.osRelease, /^25\./);
    assert.equal(observed.imageOS, "macos26");
  } else if (selected.architecture === "x64") {
    assert.equal(observed.distributionId, "ubuntu");
    assert.equal(observed.distributionVersion, "24.04");
    assert.equal(observed.imageOS, "ubuntu24");
  } else {
    assert.equal(slot, "native-linux-arm64-node22");
    assert.equal(observed.containerReference, observed.containerImageId);
    assert.equal(observed.baseNodeReference, consumerRuntimeBaseImages.node);
    assert.equal(
      observed.baseSystemReference,
      consumerRuntimeBaseImages.system,
    );
    assert.match(observed.containerDefinitionSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(observed.containerImageId ?? "", /^sha256:[a-f0-9]{64}$/);
  }
  if (slot !== "native-linux-arm64-node22" || hosted)
    assert.match(observed.imageVersion ?? "", /^20\d{6}\.\d+\.\d+$/);
  assert.match(observed.gitExecutableSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(observed.gitVersion ?? "", /^git version [^\r\n]{1,128}$/);
  return selected;
}
