import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parse } from "yaml";

if (process.argv.length !== 3)
  throw new Error("Provide the installed skills@1.7.0 bin/cli.mjs path");
const cli = path.resolve(process.argv[2]);
const root = fileURLToPath(new URL("../", import.meta.url));
const names = ["checktrail-review", "checktrail-setup", "checktrail-validate"];
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-skills-"));
const consumer = path.join(temporary, "consumer");
const source = path.join(temporary, "source");
const env = {
  ...process.env,
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  XDG_STATE_HOME: path.join(temporary, "state"),
};
const run = (args) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: consumer,
    env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const readInstalled = (base, name) =>
  readFile(path.join(consumer, base, name, "SKILL.md"), "utf8");
try {
  await mkdir(consumer);
  assert.equal(run(["--version"]).trim(), "1.7.0");
  assert.deepEqual((await readdir(path.join(root, "skills"))).sort(), names);
  const contents = new Map();
  for (const name of names) {
    const content = await readFile(
      path.join(root, "skills", name, "SKILL.md"),
      "utf8",
    );
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${name}: missing frontmatter`);
    const metadata = parse(frontmatter[1]);
    assert.equal(metadata.name, name);
    assert.ok(
      metadata.description.length > 0 && metadata.description.length <= 1024,
    );
    assert.equal(metadata.license, "MIT");
    for (const value of Object.values(metadata.metadata))
      assert.equal(typeof value, "string");
    for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(
        target.startsWith("https://"),
        `${name}: must survive installation without repository-relative resources`,
      );
    }
    contents.set(name, content);
  }
  const listing = run(["add", root, "--list"]);
  for (const name of names) assert.ok(listing.includes(name));
  await cp(path.join(root, "skills"), path.join(source, "skills"), {
    recursive: true,
  });

  const selection = "checktrail-validate";
  run([
    "add",
    source,
    "--skill",
    selection,
    "--agent",
    "codex",
    "--copy",
    "--yes",
  ]);
  assert.deepEqual(await readdir(path.join(consumer, ".agents/skills")), [
    selection,
  ]);
  assert.equal(
    await readInstalled(".agents/skills", selection),
    contents.get(selection),
  );

  run([
    "add",
    source,
    "--skill",
    ...names,
    "--agent",
    "codex",
    "claude-code",
    "cursor",
    "--copy",
    "--yes",
  ]);
  for (const base of [".agents/skills", ".claude/skills"]) {
    for (const name of names) {
      assert.equal(await readInstalled(base, name), contents.get(name));
      assert.equal(
        (await lstat(path.join(consumer, base, name))).isSymbolicLink(),
        false,
      );
    }
  }

  const changed = `${contents.get(selection)}\nSynthetic installation refresh marker.\n`;
  await writeFile(path.join(source, "skills", selection, "SKILL.md"), changed);
  run([
    "add",
    source,
    "--skill",
    selection,
    "--agent",
    "codex",
    "claude-code",
    "cursor",
    "--copy",
    "--yes",
  ]);
  for (const base of [".agents/skills", ".claude/skills"]) {
    assert.equal(await readInstalled(base, selection), changed);
    assert.equal(
      await readInstalled(base, "checktrail-review"),
      contents.get("checktrail-review"),
    );
  }
  await writeFile(
    path.join(source, "skills", selection, "SKILL.md"),
    contents.get(selection),
  );
  run([
    "add",
    source,
    "--skill",
    selection,
    "--agent",
    "codex",
    "claude-code",
    "cursor",
    "--yes",
  ]);
  assert.equal(
    (
      await lstat(path.join(consumer, ".claude/skills", selection))
    ).isSymbolicLink(),
    true,
  );
  assert.equal(
    await readInstalled(".claude/skills", selection),
    contents.get(selection),
  );

  const unrelated = path.join(consumer, ".agents/skills/synthetic-unrelated");
  await mkdir(unrelated);
  const sentinel =
    "---\nname: synthetic-unrelated\ndescription: Unrelated fixture\n---\nPreserve me.\n";
  await writeFile(path.join(unrelated, "SKILL.md"), sentinel);
  run(["remove", ...names, "--yes"]);
  assert.deepEqual(await readdir(path.join(consumer, ".agents/skills")), [
    "synthetic-unrelated",
  ]);
  assert.equal(
    await readFile(path.join(unrelated, "SKILL.md"), "utf8"),
    sentinel,
  );
  for (const name of names)
    await assert.rejects(lstat(path.join(consumer, ".claude/skills", name)), {
      code: "ENOENT",
    });
  const lock = JSON.parse(
    await readFile(path.join(consumer, "skills-lock.json"), "utf8"),
  );
  for (const name of names) assert.equal(lock.skills[name], undefined);
  process.stdout.write(
    `${JSON.stringify({
      installer: "skills@1.7.0",
      skills: names,
      passed: [
        "discovery",
        "selective-copy",
        "codex-claude-cursor-layouts",
        "local-refresh",
        "local-rollback",
        "symlink",
        "removal-preserves-unrelated",
      ],
      remoteInstallation: "not exercised",
      modelBehavior: "not exercised",
    })}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
