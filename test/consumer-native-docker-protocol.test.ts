import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import ts from "typescript";
const {
  consumerCaptureLabels,
  requireOwnedConsumerCaptureResource,
  consumerDockerRunDescription,
  capturedConsumerDockerArguments,
  validateConsumerCaptureExport,
  consumerCaptureUIDProgram,
  consumerCaptureExportProgram,
} = await import(
  new URL("../../scripts/consumer-native-docker-protocol.mjs", import.meta.url)
    .href
);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const context = () => ({
  attemptId: randomUUID(),
  task: "original-synthetic-native-task",
});
test("native Docker capture preserves every original flag source mount user resource limit and command while retaining the actual owned container", () => {
  const value = context(),
    volume = "checktrail-consumer-capture-" + randomUUID(),
    container = volume + "-body";
  const original = [
    "run",
    "--rm",
    "--init",
    "--user",
    "1000:1000",
    "--network",
    "none",
    "--read-only",
    "--cpus",
    "2",
    "--memory",
    "3g",
    "--pids-limit",
    "256",
    "--mount",
    "type=bind,src=/original-synthetic,target=/workspace,readonly",
    "--label",
    "checktrail.task=original-sdk-task",
    "sha256:" + "a".repeat(64),
    "node",
    "--input-type=module",
    "-e",
    "console.log('original --rm command literal')",
  ];
  const description = consumerDockerRunDescription(original);
  assert.equal(description.user, "1000:1000");
  assert.equal(description.remove, true);
  const actual = capturedConsumerDockerArguments(
    original,
    description,
    volume,
    container,
    value,
  );
  assert.deepEqual(actual.slice(actual.indexOf("--init")), original.slice(2));
  assert.equal(actual.includes("--rm"), false);
  assert.ok(
    actual.includes(
      "CHECKTRAIL_CONSUMER_CAPTURE_ROOT=/operator-consumer-captures",
    ),
  );
  assert.ok(
    actual.includes(
      "CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY=/operator-consumer-captures/capture-registry.jsonl",
    ),
  );
  assert.ok(actual.includes("checktrail.task=original-sdk-task"));
  assert.ok(
    actual.includes("checktrail.consumer.capture-attempt=" + value.attemptId),
  );
  const literal = [
    "run",
    "--rm=true",
    "--label",
    "--rm",
    "--user=65532:65532",
    "sha256:" + "a".repeat(64),
    "node",
    "--rm",
  ];
  const parsed = consumerDockerRunDescription(literal),
    wrapped = capturedConsumerDockerArguments(
      literal,
      parsed,
      volume,
      container,
      value,
    );
  const named = [
    "run",
    "--rm",
    "--name",
    "original-synthetic-arm-native",
    imageForName(),
    "sh",
    "-c",
    "true",
  ];
  function imageForName() {
    return "sha256:" + "a".repeat(64);
  }
  const namedDescription = consumerDockerRunDescription(named);
  const wrappedNamed = capturedConsumerDockerArguments(
    named,
    namedDescription,
    volume,
    namedDescription.name,
    value,
  );
  assert.equal(
    wrappedNamed.filter((part: string) => part === "--name").length,
    1,
  );
  assert.equal(
    wrappedNamed[wrappedNamed.indexOf("--name") + 1],
    "original-synthetic-arm-native",
  );
  assert.deepEqual(
    wrappedNamed.slice(wrappedNamed.indexOf("--name")),
    named.slice(2),
  );
  assert.equal(parsed.user, "65532:65532");
  assert.equal(wrapped.filter((value: string) => value === "--rm").length, 2);
  assert.equal(wrapped.includes("--rm=true"), false);
  assert.throws(() =>
    capturedConsumerDockerArguments(
      original,
      description,
      volume,
      "checktrail-consumer-capture-" + randomUUID() + "-body",
      value,
    ),
  );
});
test("native Docker storage refuses unknown options nested storage duplicate users and foreign ownership without interpreting command arguments", () => {
  assert.equal(
    consumerDockerRunDescription(["image", "inspect", "original"]),
    null,
  );
  const image = "sha256:" + "b".repeat(64);
  for (const args of [
    ["run", "--privileged", image, "node"],
    ["run", "--rm=unknown", image, "node"],
    ["run", "--user", "1000", "--user", "65532", image, "node"],
    [
      "run",
      "--env",
      "CHECKTRAIL_CONSUMER_CAPTURE_ROOT=/foreign",
      image,
      "node",
    ],
    ["run", "--name", "first", "--name", "second", image, "node"],
    ["run", "--name", "invalid/name", image, "node"],
    ["run", image],
  ])
    assert.throws(() => consumerDockerRunDescription(args));
  for (const key of [
    "CHECKTRAIL_CONSUMER_CAPTURE_ROOT",
    "CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY",
    "CHECKTRAIL_CONSUMER_WITNESS_DIR",
  ]) {
    for (const operand of [key, key + "=/foreign"])
      assert.throws(() =>
        consumerDockerRunDescription(["run", "--env", operand, image, "node"]),
      );
    assert.equal(
      consumerDockerRunDescription([
        "run",
        "--env",
        key + "_SUPPORT=allowed",
        image,
        "node",
      ]).image,
      image,
    );
  }
  for (const key of [
    "checktrail.consumer.capture-owner",
    "checktrail.consumer.capture-attempt",
    "checktrail.consumer.capture-task",
  ]) {
    for (const operand of [key, key + "=foreign"])
      assert.throws(() =>
        consumerDockerRunDescription([
          "run",
          "--label",
          operand,
          image,
          "node",
        ]),
      );
    assert.equal(
      consumerDockerRunDescription([
        "run",
        "--label",
        key + "-support=allowed",
        image,
        "node",
      ]).image,
      image,
    );
  }
  const value = context(),
    name = "checktrail-consumer-capture-" + randomUUID(),
    labels = consumerCaptureLabels(value);
  assert.equal(
    requireOwnedConsumerCaptureResource(
      { Name: name, Labels: labels },
      value,
      name,
    ).Name,
    name,
  );
  assert.equal(
    requireOwnedConsumerCaptureResource(
      { Name: "/" + name, Config: { Labels: labels } },
      value,
      name,
    ).Name,
    "/" + name,
  );
  assert.throws(() =>
    requireOwnedConsumerCaptureResource(
      {
        Name: name,
        Labels: {
          ...labels,
          "checktrail.consumer.capture-attempt": randomUUID(),
        },
      },
      value,
      name,
    ),
  );
  assert.throws(() =>
    requireOwnedConsumerCaptureResource(
      { Name: "foreign", Labels: labels },
      value,
      name,
    ),
  );
});
function exportFixture() {
  const rootIdentity = { dev: "1", ino: "2", birthtimeNs: "3", uid: "1000" },
    directories = [
      {
        path: "checktrail-consumer-witness-original",
        uid: 1000,
        gid: 1000,
        mode: 0o700,
        dev: "1",
        ino: "4",
        birthtimeNs: "5",
      },
    ],
    files = [
      {
        path: "checktrail-consumer-witness-original/attempt-original.json",
        bytes: 2,
        sha256: hash("{}"),
        uid: 1000,
        gid: 1000,
        mode: 0o600,
        links: 1,
        dev: "1",
        ino: "6",
        birthtimeNs: "7",
        mtimeNs: "8",
        ctimeNs: "9",
      },
    ];
  return {
    schemaVersion: 1,
    profile: "bounded-owned-native-capture-export-v1",
    owner: { uid: 1000, gid: 1000, mode: 0o700 },
    rootIdentity,
    directories,
    files,
    bytes: 2,
    manifestSha256: hash(JSON.stringify({ rootIdentity, directories, files })),
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
}
test("bounded native capture export binds ownership physical identity every file and directory and complete byte totals before extraction", () => {
  const original = exportFixture(),
    expected = { uid: 1000, gid: 1000 };
  assert.deepEqual(validateConsumerCaptureExport(original, expected), original);
  for (const field of [
    "uid",
    "gid",
    "mode",
    "links",
    "bytes",
    "path",
    "sha256",
  ] as const) {
    const changed = structuredClone(original);
    switch (field) {
      case "uid":
        changed.files[0]!.uid = 65532;
        break;
      case "gid":
        changed.files[0]!.gid = 65532;
        break;
      case "mode":
        changed.files[0]!.mode = 0o644;
        break;
      case "links":
        changed.files[0]!.links = 2;
        break;
      case "bytes":
        changed.files[0]!.bytes = 32 * 1048576 + 1;
        break;
      case "path":
        changed.files[0]!.path = "../foreign.json";
        break;
      case "sha256":
        changed.files[0]!.sha256 = "unknown";
        break;
    }
    assert.throws(() => validateConsumerCaptureExport(changed, expected));
  }
  const duplicate = structuredClone(original);
  duplicate.files.push(duplicate.files[0]!);
  assert.throws(() => validateConsumerCaptureExport(duplicate, expected));
  const missing = structuredClone(original);
  missing.directories = [];
  assert.throws(() => validateConsumerCaptureExport(missing, expected));
  const wrongRoot = structuredClone(original);
  wrongRoot.rootIdentity.uid = "0";
  assert.throws(() => validateConsumerCaptureExport(wrongRoot, expected));
  const wrongTotal = structuredClone(original);
  wrongTotal.bytes++;
  assert.throws(() => validateConsumerCaptureExport(wrongTotal, expected));
  const forged = structuredClone(original);
  forged.files[0]!.sha256 = hash("different");
  assert.throws(() => validateConsumerCaptureExport(forged, expected));
});
test("fixed read-only volume observer and UID metadata programs parse with only built-in imports before any container body is launched", () => {
  for (const program of [
    consumerCaptureUIDProgram,
    consumerCaptureExportProgram,
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      { input: program, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const source = ts.createSourceFile(
      "observer.mjs",
      program,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const allowed = new Set(["node:fs", "node:assert/strict", "node:crypto"]);
    function inspect(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier));
        assert.equal(allowed.has(node.moduleSpecifier.text), true);
      }
      if (ts.isCallExpression(node))
        assert.ok(
          node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
            !(
              ts.isIdentifier(node.expression) &&
              node.expression.text === "require"
            ),
        );
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
});
