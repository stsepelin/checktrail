import assert from "node:assert/strict";
export const consumerNativeProfiles = Object.freeze(
  [
    "go",
    "python",
    "php",
    "rust",
    "ruby",
    "c",
    "cpp",
    "java",
    "kotlin",
    "scala",
    "csharp",
    "fsharp",
    "vb",
    "hcl",
    "yaml",
    "swift",
  ]
    .map((family) => "context-" + family)
    .concat(["consumer-impact", "javascript-extensions", "selected-clang"]),
);
const nativeSlot = "native-linux-arm64-node22";
/** Closed data mapping shared by fixed execution selection and CI input enumeration; invokes no controller. */
export function consumerNativeEntrypoint(profile, slot) {
  assert.ok(
    consumerNativeProfiles.includes(profile),
    "Unknown fixed native consumer profile",
  );
  assert.match(slot, /^[a-z0-9-]{1,128}$/);
  if (profile === "consumer-impact")
    return slot === nativeSlot
      ? ["scripts/verify-consumer-runtime-arm64.mjs"]
      : ["scripts/verify-consumer-runtime.mjs", slot];
  assert.equal(
    slot,
    nativeSlot,
    "Selected native context/tool requires its frozen ARM runtime",
  );
  if (profile === "javascript-extensions")
    return ["scripts/verify-javascript-extensions-container.mjs"];
  if (profile === "selected-clang")
    return ["scripts/verify-cpp-extensions-container.mjs", "acceptance"];
  if (profile === "context-go" || profile === "context-python")
    return ["scripts/verify-consumer-witness-profile.mjs", profile];
  return [
    "scripts/verify-" +
      profile.slice("context-".length) +
      "-context-container.mjs",
  ];
}
