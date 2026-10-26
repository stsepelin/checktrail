import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const testFiles = [
  "windows-contract.test.js",
  "windows-process.test.js",
  "process-output.test.js",
  "helpers.js",
];
const harnessFiles = [
  ...testFiles.map((file) => "dist/test/" + file),
  "dist/test/tool-fixture.js",
  "package.json",
  "package-lock.json",
  "scripts/required-native-tests.json",
  "scripts/verify-windows-package.mjs",
  "scripts/verify-required-native-tests.mjs",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/install-acceptance-package.mjs",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const captureHarness = () =>
  Promise.all(
    harnessFiles.map(async (file) => [
      file,
      hash(await readFile(path.join(repository, file))),
    ]),
  );
const inputSources = await captureHarness();
const harnessSha256 = hash(JSON.stringify(inputSources));
const sourceEngine = await captureCompiledEngine(
  path.join(repository, "dist/src"),
);
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-windows-package-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    consumer = path.join(temporary, "consumer");
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  const installedBefore = await captureCompiledEngine(installed);
  requireUnchangedCompiledEngine(sourceEngine, installedBefore);
  await mkdir(path.join(consumer, "dist/test"), { recursive: true });
  await symlink(
    process.platform === "win32"
      ? installed
      : path.relative(path.join(consumer, "dist"), installed),
    path.join(consumer, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const file of testFiles)
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const dependencies = {};
  await copyInstalledPackages(
    consumer,
    ["@modelcontextprotocol/client"],
    path.join(repository, "node_modules"),
    async ({ relative, version }) => {
      const location = relative.split(path.sep).join("/");
      assert.equal(typeof version, "string");
      assert.equal(version, lock.packages["node_modules/" + location].version);
      const existing = await readFile(
        path.join(consumer, "node_modules", relative, "package.json"),
        "utf8",
      )
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
      if (existing) assert.equal(existing.version, version);
      dependencies[location] = version;
    },
  );
  await mkdir(path.join(consumer, "scripts"));
  for (const file of [
    "verify-required-native-tests.mjs",
    "required-test-evidence.mjs",
    "compiled-engine-evidence.mjs",
  ])
    await cp(
      path.join(repository, "scripts", file),
      path.join(consumer, "scripts", file),
    );
  const profiles = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  await writeFile(
    path.join(consumer, "scripts/required-native-tests.json"),
    JSON.stringify({
      "windows-contract": profiles["windows-contract"],
      "windows-process": profiles["windows-process"],
      "physical-process-output": profiles["physical-process-output"],
    }),
  );
  const selectedImage = process.env.CHECKTRAIL_WINDOWS_CONTRACT_IMAGE;
  const image = selectedImage
    ? execFileSync(
        "docker",
        ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
        { encoding: "utf8" },
      ).trim()
    : undefined;
  if (image) assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const selection = [
    process.platform === "win32" && !image
      ? "windows-process"
      : "windows-contract",
    "physical-process-output",
  ];
  const output = image
    ? execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--network",
          "none",
          "--read-only",
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=256m",
          ...(process.env.CHECKTRAIL_TEST_TASK
            ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
            : []),
          "--mount",
          `type=bind,src=${consumer},target=/consumer,readonly`,
          "--workdir",
          "/consumer",
          image,
          "node",
          "scripts/verify-required-native-tests.mjs",
          ...selection,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000 },
      )
    : execFileSync(
        process.execPath,
        ["scripts/verify-required-native-tests.mjs", ...selection],
        {
          cwd: consumer,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: process.platform === "win32" ? 600000 : 120000,
        },
      );
  const acceptance = JSON.parse(output);
  assert.equal(acceptance.complete, true);
  assert.deepEqual(
    acceptance.profiles,
    selection.map((profile) => ({
      profile,
      required: profiles[profile].length,
    })),
  );
  const required = selection.reduce(
    (total, profile) => total + profiles[profile].length,
    0,
  );
  assert.equal(acceptance.required, required);
  assert.equal(acceptance.passed, required);
  assert.equal(acceptance.ledger.truncated, false);
  assert.equal(acceptance.ledger.cases.length, required);
  assert.ok(acceptance.ledger.cases.every((item) => item.outcome === "passed"));
  requireUnchangedCompiledEngine(installedBefore, acceptance.compiledEngine);
  requireUnchangedCompiledEngine(
    installedBefore,
    await captureCompiledEngine(installed),
  );
  const compiledEngine = requireUnchangedCompiledEngine(
    sourceEngine,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  assert.deepEqual(
    await captureHarness(),
    inputSources,
    "Windows acceptance harness bytes changed",
  );
  process.stdout.write(
    JSON.stringify({
      tarballSha256,
      ...installation,
      compiledEngine,
      inputSources,
      harnessSha256,
      harnessInputsUnchanged: true,
      installedCliEvaluated: process.platform === "win32" && !image,
      installedNativeWindowsEvaluated: process.platform === "win32" && !image,
      installedRuntimeEvaluated: true,
      harnessOutsideInstalledPackage: true,
      acceptanceClientDependencies: dependencies,
      profile: acceptance,
      environment: image
        ? {
            image,
            network: "none",
            consumerMount: "readonly",
            rootFilesystemReadonly: true,
            temporaryFilesystemMiB: 256,
          }
        : {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      qualityGate: "not-assessed",
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
