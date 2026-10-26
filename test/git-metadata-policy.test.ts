import assert from "node:assert/strict";
import { access, chmod, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  gitMetadataEnvironment,
  gitMetadataPrefix,
  isGitMetadataCommand,
} from "../src/git-metadata-policy.js";
import { runHostGitMetadata } from "../src/posix-target.js";
import { gitReader } from "../src/git-selection.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import type { Command } from "../src/types.js";
const hash = "a".repeat(40),
  platform = ["darwin", "linux"].includes(process.platform);
const command = (args: string[]): Command => ({
  executable: "/original/operator/git",
  args: [...gitMetadataPrefix, ...args],
  cwd: ".",
  env: { ...gitMetadataEnvironment },
});
test("Git metadata admission permits exact read-only forms and literal leading-option filenames while rejecting neighboring commands and execution flags", () => {
  for (const args of [
    ["--version"],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--verify", "HEAD^{commit}"],
    ["rev-parse", "--verify", "--end-of-options", "original-branch^{commit}"],
    ["ls-files", "--stage", "-z"],
    ["ls-tree", "-rz", "--full-tree", hash],
    [
      "--literal-pathspecs",
      "ls-tree",
      "-rz",
      "--full-tree",
      hash,
      "--",
      "--filters;literal.ts",
    ],
    ["cat-file", "-s", hash],
    ["cat-file", "blob", "b".repeat(64)],
  ])
    assert.equal(isGitMetadataCommand(command(args)), true, args.join(" "));
  for (const args of [
    ["--exec-path"],
    ["rev-parse-other", "--show-toplevel"],
    ["ls-files-extra", "--stage", "-z"],
    ["cat-file", "--filters", hash],
    ["cat-file", "--textconv", hash],
    ["cat-files", "blob", hash],
    ["ls-tree", "-rz", "--full-tree", "--original-option"],
    ["ls-files", "--stage", "-z", "--debug"],
    ["-c", "core.sshCommand=original", "rev-parse", "HEAD"],
    ["fetch", "original"],
    ["checkout", "original"],
    ["--literal-pathspecs", "cat-file", "blob", hash],
  ])
    assert.equal(isGitMetadataCommand(command(args)), false, args.join(" "));
  for (const key of Object.keys(gitMetadataEnvironment)) {
    const removed = command(["--version"]);
    delete removed.env![key];
    assert.equal(isGitMetadataCommand(removed), false, key);
    const changed = command(["--version"]);
    changed.env![key] += "original";
    assert.equal(isGitMetadataCommand(changed), false, key);
  }
  for (let index = 0; index < gitMetadataPrefix.length; index++) {
    const changed = command(["--version"]);
    changed.args[index] += "original";
    assert.equal(isGitMetadataCommand(changed), false, String(index));
  }
  const extra = command(["--version"]);
  extra.env!.ORIGINAL_METADATA_EXTRA = "value";
  assert.equal(isGitMetadataCommand(extra), false);
});
test(
  "Git metadata rejects project-local executables and arbitrary commands before any native source marker",
  { skip: !platform },
  async (t) => {
    const root = await realpath(await fixture(t, {})),
      outside = await realpath(await fixture(t, {})),
      marker = path.join(outside, "executed"),
      program = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'Original operator probe.');process.stdout.write('git version original');\n`;
    const executable = path.join(outside, "git");
    await writeFile(executable, program);
    await chmod(executable, 0o700);
    const local = path.join(root, "git");
    await writeFile(local, program);
    await chmod(local, 0o700);
    await assert.rejects(
      runHostGitMetadata(
        root,
        { ...command(["--version"]), executable: local },
        { timeoutMs: 1000 },
      ),
    );
    await assert.rejects(
      runHostGitMetadata(
        root,
        { ...command(["fetch", "original"]), executable },
        { timeoutMs: 1000 },
      ),
    );
    await assert.rejects(
      runHostGitMetadata(
        root,
        { ...command(["--version"]), executable },
        { timeoutMs: 5001 },
      ),
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
    const result = await runHostGitMetadata(
      root,
      { ...command(["--version"]), executable },
      { timeoutMs: 1000 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "git version original");
    assert.equal(await readFile(marker, "utf8"), "Original operator probe.");
  },
);
test(
  "Git metadata retains its five-second aggregate budget for both size and original byte reads across the selected 64-file boundary",
  { skip: !platform, timeout: 30000 },
  async (t) => {
    const files = Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [
          "source-" + i + ".ts",
          "export const original=" + i + ";\n",
        ]),
      ),
      root = await fixture(t, files);
    fixtureGit(root, ["init", "--quiet"]);
    const base = await syntheticCommit(root, files),
      read = gitReader(root);
    const tree = await read(["ls-tree", "-rz", "--full-tree", base]);
    const entries = tree
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^100644 blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(
          line,
        );
        assert.ok(match);
        return { oid: match[1]!, file: match[2]! };
      });
    assert.equal(entries.length, Object.keys(files).length);
    for (const entry of entries) {
      const bytes = await read(["cat-file", "blob", entry.oid]);
      assert.equal(bytes, files[entry.file]);
      assert.equal(
        Number((await read(["cat-file", "-s", entry.oid])).trim()),
        Buffer.byteLength(bytes),
      );
    }
  },
);

test(
  "native Git metadata passes the complete independent safety configuration to the operator executable without inheriting a project override",
  { skip: !platform },
  async (t) => {
    const root = await realpath(await fixture(t, {})),
      operator = await realpath(await fixture(t, {})),
      executable = path.join(operator, "git");
    const names = [
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
      "GIT_NO_LAZY_FETCH",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_ATTR_NOSYSTEM",
      "GIT_ALLOW_PROTOCOL",
    ];
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,process.env[name]??null]))}));\n`,
    );
    await chmod(executable, 0o700);
    const result = await runHostGitMetadata(
      root,
      { ...command(["--version"]), executable },
      { timeoutMs: 1000 },
    );
    assert.equal(result.exitCode, 0);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.args, [
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "--version",
    ]);
    assert.deepEqual(observed.env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "",
    });
  },
);
