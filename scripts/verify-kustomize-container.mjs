import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
const root = fileURLToPath(new URL("../", import.meta.url));
const prepared = JSON.parse(
  await readFile(
    path.join(root, ".checktrail/infra-tools-runtime/identity.json"),
    "utf8",
  ),
);
assert.match(prepared.image, /^sha256:[a-f0-9]{64}$/);
assert.match(prepared.task, /^[a-z][a-z0-9-]{0,80}$/);
const [image] = JSON.parse(
  execFileSync("docker", ["image", "inspect", prepared.image], {
    encoding: "utf8",
  }),
);
assert.equal(image.Config.Labels["checktrail.task"], prepared.task);
const base = [
  "run",
  "--rm",
  "--init",
  "--network",
  "none",
  "--cpus",
  "2",
  "--memory",
  "4g",
  "--label",
  `checktrail.task=${prepared.task}`,
  "--mount",
  `type=bind,src=${root},target=/workspace,readonly`,
  "--workdir",
  "/workspace",
  "--env",
  "CHECKTRAIL_INFRA_TOOLS_NATIVE=1",
  prepared.image,
];
const output = execFileSync(
  "docker",
  [...base, "node", "scripts/verify-required-native-tests.mjs", "kustomize"],
  { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
);
const source = JSON.parse(output);
assert.equal(source.complete, true);
const installed = JSON.parse(
  execFileSync(process.execPath, ["scripts/verify-kustomize-package.mjs"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      CHECKTRAIL_INFRA_TOOLS_IMAGE: prepared.image,
      CHECKTRAIL_TEST_TASK: prepared.task,
    },
  }),
);
assert.equal(installed.profile.complete, true);
process.stdout.write(
  JSON.stringify({
    image: prepared.image,
    source,
    installed,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
