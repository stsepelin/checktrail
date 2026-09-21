import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

assert.equal(
  process.argv.length,
  4,
  "Usage: node scripts/prepare-public-adoption.mjs NEW_DIRECTORY REVIEWED_TARBALL",
);
const plan = JSON.parse(
  readFileSync(new URL("./public-adoption-plan.json", import.meta.url)),
);
const artifact = realpathSync(process.argv[3]);
assert.equal(
  createHash("sha256").update(readFileSync(artifact)).digest("hex"),
  plan.engine.tarballSha256,
);
const base = path.resolve(process.argv[2]);
mkdirSync(base);
const run = (command, args, cwd = base) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
for (const project of plan.projects) {
  assert.match(
    project.repository,
    /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.git$/,
  );
  assert.match(project.commit, /^[a-f0-9]{40}$/);
  run("git", [
    "clone",
    "--quiet",
    "--no-checkout",
    project.repository,
    project.id,
  ]);
  run(
    "git",
    ["checkout", "--quiet", "--detach", project.commit],
    path.join(base, project.id),
  );
}
for (const [directory, packages] of [
  ["installation", [artifact]],
  [
    "typescript-tools",
    [
      "typescript@4.9.5",
      "@types/chai@4.3.20",
      "@types/mocha@7.0.2",
      "@types/sinon@9.0.11",
      "@types/sinon-chai@3.2.12",
    ],
  ],
]) {
  const target = path.join(base, directory);
  mkdirSync(target);
  writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ private: true }) + "\n",
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      ...packages,
    ],
    target,
  );
}
process.stdout.write(
  JSON.stringify(
    {
      directory: base,
      engine: plan.engine,
      projects: plan.projects.length,
      execution:
        "No upstream project scripts executed; language tools still require preparation.",
    },
    null,
    2,
  ) + "\n",
);
