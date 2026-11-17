import assert from "node:assert/strict";
const node = { platform: "linux", nodeMajor: 22, nodeVersion: "22.23.2" };
const dotnet = "/usr/share/dotnet/dotnet";
export const nativeBaselineBindings = Object.freeze({
  ruby: { ...node, tools: { ruby: ["--disable-gems", "--version"] } },
  clang: {
    ...node,
    tools: {
      clang: ["--no-default-config", "--version"],
      "clang++": ["--no-default-config", "--version"],
    },
    toolVersionAssertions: {
      clang: { tokens: ["22.1.3"] },
      "clang++": { tokens: ["22.1.3"] },
    },
  },
  java: {
    ...node,
    tools: { java: ["--version"], javac: ["--version"] },
    toolVersionAssertions: { javac: { equals: "javac 25.0.4" } },
  },
  dotnet: {
    ...node,
    tools: {
      dotnet: ["--list-sdks"],
      [dotnet]: [
        "exec",
        "/usr/share/dotnet/sdk/10.0.401/Roslyn/bincore/csc.dll",
        "-version",
      ],
    },
    toolVersionAssertions: {
      dotnet: { equals: "10.0.401 [/usr/share/dotnet/sdk]" },
      [dotnet]: {
        equals: "5.9.0-1.26423.113 (e34a38d2ae1fc26406a317517196e55c68ff83ab)",
      },
    },
  },
  actionlint: {
    ...node,
    tools: { actionlint: ["-version"] },
    toolVersionAssertions: { actionlint: { tokens: ["1.7.12"] } },
  },
  "vue-router": { ...node, tools: {} },
  nuxt: { ...node, tools: {} },
  "external-adapters": {
    ...node,
    tools: {
      go: ["version"],
      php: ["-n", "--version"],
      python3: ["--version"],
      openssl: ["version"],
    },
  },
  swift: {
    platform: "darwin",
    nodeMajor: 22,
    tools: { swiftc: ["--version"] },
  },
  "gradle-preparation": {
    platform: "linux",
    nodeMajor: 22,
    tools: { git: ["--version"], tar: ["--version"] },
  },
  "maven-preparation": {
    platform: "linux",
    nodeMajor: 22,
    tools: { git: ["--version"], tar: ["--version"] },
  },
});
export const originalReviewSourceProfiles = Object.freeze([
  "review",
  "review-git",
  "review-provider",
  "review-probe",
  "review-refutation",
  "review-scoring",
  "review-verification",
  "mcp-tasks-routing",
  "mcp-tasks",
  "mcp-task-dispatch",
  "review-budget",
  "review-workflow",
  "review-workflow-audit",
  "review-benchmark",
  "review-benchmark-judging",
  "review-native-budget",
]);
export function requireControllerSelection(cohortName, selection, cohort) {
  assert.ok(Array.isArray(selection) && selection.length > 0);
  assert.equal(new Set(selection).size, selection.length);
  if (cohortName === "packaged-review") {
    assert.deepEqual(
      selection,
      originalReviewSourceProfiles,
      "Original review source selection changed",
    );
  } else if (cohortName === "external-adapters") {
    assert.ok(
      selection.length === 1 && cohort.profiles.includes(selection[0]),
      "Protocol and policy original source commands must stay separate",
    );
  } else {
    assert.ok(
      Object.hasOwn(nativeBaselineBindings, cohortName),
      "Unknown native baseline source cohort",
    );
    assert.deepEqual(
      selection,
      cohort.profiles,
      "Original native source selection changed",
    );
  }
}
