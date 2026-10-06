import { spawnSync } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  cp,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  rubyToolsInvocationSchema,
  rubyToolsLock,
  rubyToolsRepository,
  rubyToolsProtectedEnvironment,
} from "./ruby-tools.js";
import { rubyToolsNativeSource } from "./ruby-tools-native.js";
import { mavenHash, mavenLocal, verifyMavenTree } from "./maven.js";

async function regular(file: string, bound = 4 * 1024 * 1024) {
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > bound ||
    (await realpath(file)) !== file
  )
    throw Error("Ruby regular input bound");
  const bytes = await readFile(file);
  if (bytes.length > bound) throw Error("Ruby regular input changed size");
  return bytes;
}
async function installation(directory: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  let total = 0,
    entries = 0;
  const walk = async (prefix: string): Promise<void> => {
    for (const entry of await readdir(path.join(directory, prefix), {
      withFileTypes: true,
    })) {
      if (++entries > 20000 || entry.isSymbolicLink())
        throw Error("Ruby installed artifact bound or link");
      const relative = path.posix.join(prefix, entry.name),
        file = path.join(directory, relative);
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      const bytes = await regular(file, 32 * 1024 * 1024);
      total += bytes.length;
      if (total > 256 * 1024 * 1024)
        throw Error("Ruby installed artifact byte bound");
      files.push({
        path: relative,
        bytes: bytes.length,
        sha256: mavenHash(bytes),
      });
    }
  };
  await walk("");
  if (!files.length) throw Error("Ruby installed artifacts are empty");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: files.length,
    bytes: total,
    sha256: mavenHash(JSON.stringify(files)),
    entries: files,
  };
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd());
  const invocation = rubyToolsInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    ),
    mode = process.argv[4];
  if (!["rubocop", "rspec", "minitest"].includes(mode!))
    throw Error("Ruby native mode");
  const config = invocation.config;
  if (
    new Set(invocation.inputs.map((f) => f.path)).size !==
    invocation.inputs.length
  )
    throw Error("Duplicate Ruby inputs");
  for (const pin of invocation.inputs)
    if (
      mavenHash(await regular(await mavenLocal(root, project, pin.path))) !==
      pin.sha256
    )
      throw Error("Ruby source changed before native execution");
  const lock = rubyToolsLock(
    (await regular(await mavenLocal(root, project, "Gemfile"))).toString(
      "utf8",
    ),
    (await regular(await mavenLocal(root, project, "Gemfile.lock"))).toString(
      "utf8",
    ),
  );
  const repository = await rubyToolsRepository(root, project, config, lock);
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "ruby-tools-"),
  );
  const workspace = path.join(temporary, "project"),
    install = path.join(temporary, "install"),
    observer = path.join(temporary, "observer.rb"),
    request = path.join(temporary, "request.json"),
    output = path.join(temporary, "native.json"),
    options = path.join(temporary, "native-options");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (
      rubyToolsProtectedEnvironment.includes(key) ||
      /^(?:BUNDLE_|GEM_|RUBY)/.test(key)
    )
      delete env[key];
  Object.assign(env, {
    HOME: path.join(temporary, "home"),
    TMPDIR: path.join(temporary, "tmp"),
    BUNDLE_IGNORE_CONFIG: "true",
    BUNDLE_PLUGINS: "false",
    BUNDLE_FROZEN: "true",
    BUNDLE_GEMFILE: path.join(workspace, "Gemfile"),
    BUNDLE_PATH: install,
    BUNDLE_APP_CONFIG: path.join(temporary, "config"),
    BUNDLE_USER_HOME: path.join(temporary, "bundle-home"),
    BUNDLE_FORCE_RUBY_PLATFORM: "true",
    BUNDLE_DISABLE_CHECKSUM_VALIDATION: "false",
    BUNDLE_DISABLE_SHARED_GEMS: "true",
    MT_NO_PLUGINS: "1",
  });
  const receipts: {
    phase: string;
    exitCode: number;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutSha256: string;
    stderrSha256: string;
    durationMs: number;
  }[] = [];
  let total = 0;
  const invoke = (phase: string, args: string[]) => {
    const started = performance.now();
    const result = spawnSync("ruby", args, {
      cwd: workspace,
      env,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.signal || result.status === null)
      throw Error("Ruby native invocation incomplete");
    const stdoutBytes = Buffer.byteLength(result.stdout),
      stderrBytes = Buffer.byteLength(result.stderr);
    total += stdoutBytes + stderrBytes;
    if (total > 8 * 1024 * 1024 || receipts.length >= 4)
      throw Error("Ruby native output bound");
    receipts.push({
      phase,
      exitCode: result.status,
      stdoutBytes,
      stderrBytes,
      stdoutSha256: mavenHash(result.stdout),
      stderrSha256: mavenHash(result.stderr),
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  };
  try {
    await mkdir(workspace, { recursive: true });
    for (const directory of [
      env.HOME!,
      env.TMPDIR!,
      env.BUNDLE_APP_CONFIG!,
      env.BUNDLE_USER_HOME!,
    ])
      await mkdir(directory, { recursive: true });
    for (const pin of invocation.inputs) {
      const target = path.join(workspace, pin.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(await mavenLocal(root, project, pin.path), target, {
        errorOnExist: true,
        force: false,
      });
    }
    const cache = path.join(workspace, "vendor/cache");
    await mkdir(path.dirname(cache), { recursive: true });
    await cp(repository.repository, cache, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await verifyMavenTree(cache, repository.pins.files);
    await writeFile(observer, rubyToolsNativeSource, { flag: "wx" });
    await writeFile(request, JSON.stringify(invocation), { flag: "wx" });
    const optionText =
      mode === "rubocop"
        ? "AllCops:\n  TargetRubyVersion: 4.0\n  NewCops: disable\n  EnabledByDefault: false\n" +
          config.cops.map((cop) => cop + ":\n  Enabled: true\n").join("")
        : "";
    await writeFile(options, optionText, { flag: "wx" });
    const restore = invoke("restore", [
      "-S",
      "bundle",
      "_4.0.20_",
      "install",
      "--local",
    ]);
    if (restore.status !== 0) throw Error("Fresh offline Ruby restore failed");
    const installedArtifacts = await installation(install);
    const native = invoke(mode!, [
      "--disable-gems",
      observer,
      request,
      output,
      mode!,
      options,
    ]);
    if (native.stderr.trim() || ![0, 1].includes(native.status!))
      throw Error("Ruby native tool errors or interruption");
    const data =
      mode === "rubocop"
        ? native.stdout
        : (await regular(output, 2 * 1024 * 1024)).toString("utf8");
    const metadata = (
      await regular(output + ".metadata", 1024 * 1024)
    ).toString("utf8");
    if (
      mavenHash(await regular(observer)) !== mavenHash(rubyToolsNativeSource) ||
      (await regular(options)).toString("utf8") !== optionText ||
      (await regular(request)).toString("utf8") !== JSON.stringify(invocation)
    )
      throw Error("Ruby observer or native settings changed");
    for (const pin of invocation.inputs)
      if (
        mavenHash(await regular(await mavenLocal(root, project, pin.path))) !==
          pin.sha256 ||
        mavenHash(await regular(path.join(workspace, pin.path))) !== pin.sha256
      )
        throw Error("Ruby source changed after native execution");
    await verifyMavenTree(cache, repository.pins.files);
    const installedArtifactsAfter = await installation(install);
    if (
      JSON.stringify(installedArtifactsAfter) !==
      JSON.stringify(installedArtifacts)
    )
      throw Error("Ruby installed artifacts changed during native execution");
    await rubyToolsRepository(root, project, config, lock);
    process.stdout.write(
      JSON.stringify({
        version: 1,
        mode,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        observerSha256: mavenHash(rubyToolsNativeSource),
        optionsSha256: mavenHash(optionText),
        repositoryManifest: repository.manifestText,
        workspace,
        install,
        installedArtifacts,
        installedArtifactsAfter: {
          files: installedArtifactsAfter.files,
          bytes: installedArtifactsAfter.bytes,
          sha256: installedArtifactsAfter.sha256,
        },
        metadata,
        data,
        dataSha256: mavenHash(data),
        metadataSha256: mavenHash(metadata),
        receipts,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write("Ruby native evidence collection could not complete\n");
  process.exitCode = 2;
});
