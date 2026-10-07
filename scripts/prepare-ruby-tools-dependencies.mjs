import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import {
  rubyToolsLock,
  rubyToolsProtectedEnvironment,
} from "../dist/src/ruby-tools.js";
import { mavenHash, verifyMavenTree } from "../dist/src/maven.js";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const destination = path.join(root, ".checktrail/ruby-tools-cache");
const gemfile = await readFile(path.join(root, "examples/ruby-tools/Gemfile")),
  lockfile = await readFile(
    path.join(root, "examples/ruby-tools/Gemfile.lock"),
  );
const lock = rubyToolsLock(gemfile.toString("utf8"), lockfile.toString("utf8"));
await mkdir(path.dirname(destination), { recursive: true });
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
  "Preparation cannot traverse links",
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "ruby-tools-dependency-preparation-"),
);
const project = path.join(temporary, "project"),
  prepared = path.join(temporary, "prepared");
const env = { ...process.env };
for (const key of Object.keys(env))
  if (
    rubyToolsProtectedEnvironment.includes(key) ||
    /^(?:BUNDLE_|GEM_|RUBY)/.test(key)
  )
    delete env[key];
Object.assign(env, {
  HOME: path.join(temporary, "home"),
  BUNDLE_IGNORE_CONFIG: "true",
  BUNDLE_PLUGINS: "false",
  BUNDLE_FROZEN: "true",
  BUNDLE_FORCE_RUBY_PLATFORM: "true",
  BUNDLE_DISABLE_CHECKSUM_VALIDATION: "false",
  BUNDLE_APP_CONFIG: path.join(temporary, "config"),
  BUNDLE_USER_HOME: path.join(temporary, "bundle-home"),
  BUNDLE_GEMFILE: path.join(project, "Gemfile"),
  BUNDLE_PATH: path.join(temporary, "unused-install"),
});
try {
  await mkdir(project);
  await mkdir(prepared);
  for (const directory of [
    env.HOME,
    env.BUNDLE_APP_CONFIG,
    env.BUNDLE_USER_HOME,
  ])
    await mkdir(directory);
  await writeFile(path.join(project, "Gemfile"), gemfile, { flag: "wx" });
  await writeFile(path.join(project, "Gemfile.lock"), lockfile, { flag: "wx" });
  const runtime = execFileSync("ruby", ["--disable-gems", "--version"], {
    cwd: project,
    env,
    encoding: "utf8",
  });
  assert.match(runtime, /^ruby 4\.0\.7 /);
  const bundler = execFileSync(
    "ruby",
    ["-S", "bundle", "_4.0.20_", "--version"],
    { cwd: project, env, encoding: "utf8" },
  );
  assert.equal(bundler.trim(), "4.0.20");
  // This operator preparation command fetches raw gems; the engine never invokes it.
  execFileSync(
    "ruby",
    ["-S", "bundle", "_4.0.20_", "cache", "--no-install", "--all-platforms"],
    {
      cwd: project,
      env,
      stdio: "pipe",
      maxBuffer: 1024 * 1024,
      timeout: 120000,
    },
  );
  assert.deepEqual(await readFile(path.join(project, "Gemfile")), gemfile);
  assert.deepEqual(
    await readFile(path.join(project, "Gemfile.lock")),
    lockfile,
  );
  const files = [];
  for (const pin of lock.files) {
    const file = path.join(project, "vendor/cache", pin.path),
      stat = await lstat(file);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size <= 32 * 1024 * 1024,
    );
    const bytes = await readFile(file);
    assert.equal(mavenHash(bytes), pin.sha256);
    files.push({ ...pin, bytes: bytes.length });
  }
  await verifyMavenTree(path.join(project, "vendor/cache"), files);
  await cp(
    path.join(project, "vendor/cache"),
    path.join(prepared, "artifacts"),
    { recursive: true },
  );
  await writeFile(
    path.join(prepared, "repository.json"),
    JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n",
    { flag: "wx" },
  );
  await verifyMavenTree(path.join(prepared, "artifacts"), files);
  await rename(prepared, destination);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      archives: files.length,
      archiveBytes: files.reduce((n, p) => n + p.bytes, 0),
      gemfileSha256: mavenHash(gemfile),
      lockSha256: mavenHash(lockfile),
      allArchiveDigestsMatchLock: true,
      dependenciesInstalled: false,
      publisherAndLicenseClosureVerified: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
