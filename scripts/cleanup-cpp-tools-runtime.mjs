import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
const root = fileURLToPath(new URL("../", import.meta.url));
let prepared;
try {
  prepared = JSON.parse(
    await readFile(
      path.join(root, ".checktrail/cpp-tools-runtime/identity.json"),
      "utf8",
    ),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  process.stdout.write(JSON.stringify({ preparedRuntimeAbsent: true }) + "\n");
  process.exit(0);
}
assert.match(prepared.image, /^sha256:[a-f0-9]{64}$/);
assert.match(prepared.task, /^[a-z][a-z0-9-]{0,80}$/);
assert.equal(prepared.tag, `checktrail-${prepared.task}:public`);
const containers = execFileSync(
  "docker",
  [
    "ps",
    "--all",
    "--filter",
    `label=checktrail.task=${prepared.task}`,
    "--format",
    "{{.ID}}",
  ],
  { encoding: "utf8" },
).trim();
assert.equal(containers, "", "Stop owned foreground work before image cleanup");
const [image] = JSON.parse(
  execFileSync("docker", ["image", "inspect", prepared.tag], {
    encoding: "utf8",
  }),
);
assert.equal(image.Id, prepared.image);
assert.equal(image.Config.Labels["checktrail.task"], prepared.task);
execFileSync("docker", ["image", "rm", prepared.tag], { stdio: "pipe" });
process.stdout.write(
  JSON.stringify({
    ownedImageTagRemoved: true,
    codeAndPreparationArtifactsPreserved: true,
  }) + "\n",
);
