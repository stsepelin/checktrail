import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  captureNativeContainerSource,
  completeNativeContainerFresh,
} from "./preserved-native-baseline-controller.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const image = execFileSync(
  "docker",
  [
    "image",
    "inspect",
    "checktrail-executable-bundle-test:1",
    "--format",
    "{{.Id}}",
  ],
  { encoding: "utf8", timeout: 30000 },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const containerArgs = [
  "run",
  "--rm",
  "--init",
  "--network",
  "none",
  "--cpus",
  "2",
  "--memory",
  "2g",
  "--mount",
  "type=bind,src=" + repository + ",target=/workspace,readonly",
  "--workdir",
  "/workspace",
  image,
];
// These remain two separate original source commands and receipts.
const protocol = await captureNativeContainerSource({
  repository,
  cohortName: "external-adapters",
  selection: ["external-protocol"],
  containerArgs,
});
const policy = await captureNativeContainerSource({
  repository,
  cohortName: "external-adapters",
  selection: ["policy-distribution"],
  containerArgs,
});
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-external-baseline-")),
);
try {
  const packed = JSON.parse(
    runAcceptanceNpm(
      [
        "pack",
        "--offline",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporary,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
  );
  assert.equal(packed.length, 1);
  assert.equal(path.basename(packed[0].filename), packed[0].filename);
  const consumer = path.join(temporary, "consumer");
  await installAcceptancePackage(
    repository,
    path.join(temporary, packed[0].filename),
    consumer,
  );
  const installedPackage = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail",
  );
  await completeNativeContainerFresh({
    repository,
    baseline: protocol,
    installedPackage,
    harness: path.join(temporary, "protocol-harness"),
  });
  await completeNativeContainerFresh({
    repository,
    baseline: policy,
    installedPackage,
    harness: path.join(temporary, "policy-harness"),
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
