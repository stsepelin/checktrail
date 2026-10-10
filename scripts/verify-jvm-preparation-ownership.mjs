import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, chown, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  verifyJvmToolchain,
  verifyJvmFile,
} from "../dist/src/jvm-extensions.js";
import {
  jvmWrapperPins,
  jvmWrapperArchives,
} from "../dist/src/jvm-wrapper-pins.js";
import { gradleJvmArguments } from "../dist/src/gradle-native.js";
import { gradleDistributionFiles } from "../dist/src/gradle-distribution.js";
import { verifyMavenTree } from "../dist/src/maven.js";
assert.equal(process.platform, "linux");
assert.equal(
  process.getuid(),
  0,
  "Run this ownership control in its disposable root-started native container",
);
const home = await verifyJvmToolchain(),
  distribution = path.resolve(
    process.env.CHECKTRAIL_JVM_WRAPPERS_CACHE ?? ".checktrail",
    "gradle-review-tools/gradle-9.8.0",
  );
await verifyMavenTree(distribution, gradleDistributionFiles);
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-wrapper-ownership-"),
);
const receipts = [];
try {
  await chown(temporary, 1001, 1001);
  for (const nativeUid of [0, 1001]) {
    const seed = path.join(temporary, "seed-" + nativeUid);
    await mkdir(seed);
    await chown(seed, 1001, 1001);
    for (const [name, text] of [
      ["settings.gradle", "rootProject.name='original-wrapper-seed'\n"],
      ["build.gradle", "\n"],
    ]) {
      const file = path.join(seed, name);
      await writeFile(file, text);
      await chown(file, 1001, 1001);
    }
    const args = [
      path.join(home, "bin/java"),
      ...gradleJvmArguments,
      "-javaagent:" +
        path.join(
          distribution,
          "lib/agents/gradle-instrumentation-agent-9.8.0.jar",
        ),
      "-Dorg.gradle.jvmargs=" + gradleJvmArguments.join(" "),
      "-jar",
      path.join(distribution, "lib/gradle-gradle-cli-main-9.8.0.jar"),
      "--offline",
      "--no-daemon",
      "--gradle-user-home",
      path.join(temporary, "home-" + nativeUid),
      "--console=plain",
      "wrapper",
      "--gradle-version=9.8.0",
      "--distribution-type=bin",
      "--gradle-distribution-sha256-sum=" + jvmWrapperArchives.gradle.sha256,
      "--no-validate-url",
    ];
    const generated = spawnSync(args[0], args.slice(1), {
      cwd: seed,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 1048576,
      uid: nativeUid,
      gid: nativeUid,
    });
    assert.equal(generated.error, undefined);
    assert.equal(generated.signal, null);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    assert.match(generated.stdout, /BUILD SUCCESSFUL/);
    const wrapperPins = jvmWrapperPins.filter((p) => p.kind === "gradle");
    for (const pin of wrapperPins)
      await verifyJvmFile(path.join(seed, pin.path), pin);
    const cache = path.join(seed, ".gradle/9.8.0");
    const owner = await stat(cache);
    assert.equal(owner.uid, nativeUid);
    const cleanup = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import{rm}from"node:fs/promises";try{await rm(process.argv[1],{recursive:true,force:true});console.log(JSON.stringify({removed:true}));}catch(error){console.log(JSON.stringify({removed:false,code:error.code}));process.exitCode=1;}',
        cache,
      ],
      { encoding: "utf8", timeout: 30000, uid: 1001, gid: 1001 },
    );
    assert.equal(cleanup.error, undefined);
    assert.equal(cleanup.signal, null);
    const result = JSON.parse(cleanup.stdout);
    assert.equal(cleanup.status, nativeUid === 0 ? 1 : 0);
    assert.equal(result.removed, nativeUid === 1001);
    if (nativeUid === 0) assert.equal(result.code, "EACCES");
    receipts.push({
      parentUid: 1001,
      nativeUid,
      nativeGradleWrapperGenerationExecuted: true,
      wrapperArtifactsByteVerified: wrapperPins.length,
      gradleCacheOwnerUid: owner.uid,
      parentCleanupSucceeded: result.removed,
      ...(result.code ? { cleanupError: result.code } : {}),
    });
  }
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      controls: receipts,
      positiveComplete: true,
      rootOwnedNegativeReproduced: true,
      applicationSourceExecuted: false,
      syntheticGradleConfigurationExecuted: true,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
