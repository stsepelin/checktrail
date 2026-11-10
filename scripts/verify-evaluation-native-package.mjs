import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import { attemptOutputCodeIdentity } from "./attempt-output-evidence.mjs";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--pair-settings"),
);
const pairSettings = args[0] === "--pair-settings";
const requirements = (
  pairSettings
    ? [
        "evaluation pair admits matched settings with only the declared treatment and never certifies effective hosts or trials",
        "evaluation pair checks every shared host context native and budget field even when altered bytes are repinned",
        "evaluation pair rejects baseline tool exposure role swaps resumed sessions and unrecognized configuration fields",
        "evaluation pair binds exact bytes and protocol while malformed empty oversized and foreign baseline inputs remain incomplete",
        "evaluation pair setup command reports matched mismatch and malformed input without exposing private settings",
      ].map((name) => ["review-evaluation-pair", name])
    : [
        [
          "agent-evaluation-gateway",
          "evaluation gateway runs PHP probes as literal arguments and preserves source evidence",
        ],
        [
          "agent-evaluation-gateway",
          "evaluation gateway prepares Go code without interpolation and binds vendor dependencies",
        ],
        [
          "agent-evaluation-gateway",
          "evaluation gateway retains legacy limits and rejects duplicate or unknown language profiles",
        ],
        [
          "evaluation-go-php",
          "Go evaluation native evidence requires complete real test event sequences and matching exits",
        ],
        [
          "evaluation-go-php",
          "PHP evaluation native evidence reconciles every source file for passing and failing PHPUnit runs",
        ],
        [
          "evaluation-go-php",
          "Pest native evidence uses stderr and preserves exact file boundaries when removing method suffixes",
        ],
      ]
).map(([file, name]) => ({ file: "dist/test/" + file + ".test.js", name }));
const harnessFiles = pairSettings
  ? [
      "scripts/check-evaluation-pair.mjs",
      "dist/test/review-evaluation-pair.test.js",
      "dist/test/review-evaluation-protocol-fixture.js",
    ]
  : [
      "scripts/agent-evaluation-gateway.mjs",
      "scripts/agent-evaluation-protocol.mjs",
      "scripts/agent-evaluation-session.mjs",
      "scripts/agent-evaluation-worker.mjs",
      "dist/test/agent-evaluation-gateway.test.js",
      "dist/test/agent-evaluation-protocol.test.js",
      "dist/test/evaluation-go-php.test.js",
    ];
const inputFiles = [
  ...harnessFiles,
  "scripts/verify-evaluation-native-package.mjs",
  "scripts/install-acceptance-package.mjs",
  "scripts/required-test-evidence.mjs",
  "scripts/attempt-output-evidence.mjs",
  "dist/test/tool-fixture.js",
  "package.json",
  "package-lock.json",
];
const identities = (root, files) =>
  Promise.all(
    files.map(async (file) => [
      file,
      hash(await readFile(path.join(root, file))),
    ]),
  );
const inputs = await identities(repository, inputFiles);
const sourceCode = await attemptOutputCodeIdentity(repository);
const executableSha256 = hash(await readFile(process.execPath));
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "checktrail-evaluation-native-installed-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      [
        "pack",
        "--json",
        "--offline",
        "--ignore-scripts",
        "--pack-destination",
        temporary,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 4 * 1048576,
      },
    ),
  );
  const tarball = path.join(temporary, packed.filename);
  const consumer = path.join(temporary, "consumer");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(consumer, "node_modules/@stsepelin/checktrail");
  const harness = path.join(consumer, "harness");
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await writeFile(path.join(harness, "package.json"), '{"type":"module"}\n', {
    flag: "wx",
  });
  await symlink(
    path.join(installed, "dist/src"),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const file of pairSettings
    ? ["index.js", "review-evaluation-pair.js"]
    : ["runner.js", "evidence.js", "junit.js"]) {
    assert.equal(
      await realpath(path.join(harness, "dist/src", file)),
      await realpath(path.join(installed, "dist/src", file)),
    );
  }
  for (const file of harnessFiles) {
    await mkdir(path.dirname(path.join(harness, file)), { recursive: true });
    await cp(path.join(repository, file), path.join(harness, file));
  }
  assert.deepEqual(
    await identities(harness, harnessFiles),
    inputs.slice(0, harnessFiles.length),
  );
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const externalSdkClientDependencies = {};
  if (!pairSettings)
    await copyInstalledPackages(
      harness,
      ["@modelcontextprotocol/client"],
      path.join(repository, "node_modules"),
      ({ relative, version }) => {
        const key = relative.split(path.sep).join("/");
        assert.equal(version, lock.packages["node_modules/" + key].version);
        externalSdkClientDependencies[key] = version;
      },
    );
  const installedCode = await attemptOutputCodeIdentity(installed);
  assert.equal(installedCode, sourceCode);
  delete process.env.NODE_TEST_CONTEXT;
  const profile = await runRequiredTests(
    requirements.map((row) => ({ ...row, file: path.join(harness, row.file) })),
    {
      timeoutMs: 120000,
      additionalFiles: pairSettings
        ? []
        : [path.join(harness, "dist/test/agent-evaluation-protocol.test.js")],
    },
  );
  assert.equal(profile.complete, true, JSON.stringify(profile.problems));
  assert.equal(profile.required, requirements.length);
  assert.ok(profile.passed >= requirements.length);
  assert.equal(profile.ledger.truncated, false);
  assert.equal(profile.ledger.cases.length, requirements.length);
  assert.ok(profile.ledger.cases.every((row) => row.outcome === "passed"));
  assert.ok(profile.ledger.events.length >= requirements.length);
  assert.ok(profile.ledger.events.every((row) => row.outcome === "passed"));
  assert.deepEqual(await identities(repository, inputFiles), inputs);
  assert.deepEqual(
    await identities(harness, harnessFiles),
    inputs.slice(0, harnessFiles.length),
  );
  assert.equal(await attemptOutputCodeIdentity(repository), sourceCode);
  assert.equal(await attemptOutputCodeIdentity(installed), installedCode);
  assert.equal(hash(await readFile(process.execPath)), executableSha256);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: pairSettings
        ? "evaluation-pair-settings-controls"
        : "evaluation-go-php-controls",
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: executableSha256,
      tarballSha256: hash(await readFile(tarball)),
      harnessSha256: hash(JSON.stringify(inputs)),
      compiledCodeSha256: installedCode,
      ...installation,
      harnessOutsideInstalledPackage: true,
      externalSdkClientDependencies,
      nativeToolchainsExecuted: false,
      independentEvaluationProfileComplete: false,
      gateAComplete: false,
      inferenceExecuted: false,
      fieldEvaluationExecuted: false,
      profileEvidence: profile,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
