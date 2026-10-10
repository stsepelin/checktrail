import console from "node:console";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { verifyJvmFile } from "../dist/src/jvm-extensions.js";
import {
  jvmWrapperPins,
  jvmWrapperArchives,
  jvmWrapperProperties,
} from "../dist/src/jvm-wrapper-pins.js";
import { gradleJvmArguments } from "../dist/src/gradle-native.js";
import { gradleDistributionFiles } from "../dist/src/gradle-distribution.js";
import { verifyMavenTree } from "../dist/src/maven.js";
import { requestGradleDistribution } from "./request-gradle-distribution.mjs";
const { values } = parseArgs({
  options: { source: { type: "string" }, output: { type: "string" } },
});
const repository = await realpath(
    fileURLToPath(new URL("../", import.meta.url)),
  ),
  parent = path.join(repository, ".checktrail");
await mkdir(parent, { recursive: true });
assert.equal(await realpath(parent), parent);
const target = path.resolve(
  values.output ?? path.join(parent, "jvm-wrapper-tools"),
);
assert.equal(
  path.dirname(target),
  parent,
  "Prepared cache must be a direct engine-cache child",
);
const spec = JSON.parse(
  await readFile(
    new URL("./jvm-wrapper-artifacts.json", import.meta.url),
    "utf8",
  ),
);
const archives = [
  ...spec.maven.map((p) => ({ ...p, file: p.name })),
  { ...jvmWrapperArchives.gradle },
];
const source = values.source
  ? await realpath(path.resolve(values.source))
  : null;
const selectedImage = process.env.CHECKTRAIL_JVM_WRAPPERS_IMAGE;
const task = process.env.CHECKTRAIL_TEST_TASK ?? "jvm-wrapper-preparation";
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
async function regular(file, pin) {
  assert.equal(await realpath(file), file, "Prepared artifact link or alias");
  await verifyJvmFile(file, pin);
}
async function verifySignatures(base) {
  await regular(path.join(base, "KEYS"), spec.publicKeys);
  for (const p of spec.maven) {
    await regular(path.join(base, p.name + ".asc"), p.signature);
    if (p.publishedSha512)
      assert.equal(
        createHash("sha512")
          .update(await readFile(path.join(base, p.name)))
          .digest("hex"),
        p.publishedSha512,
      );
  }
  const ring = await mkdtemp(path.join(parent, ".jvm-keyring-"));
  try {
    const publicKeys = path.join(ring, "publickeys.gpg");
    execFileSync(
      "gpg",
      [
        "--no-options",
        "--homedir",
        ring,
        "--batch",
        "--no-autostart",
        "--dearmor",
        "--output",
        publicKeys,
        path.join(base, "KEYS"),
      ],
      { stdio: "pipe", timeout: 30000, maxBuffer: 1048576 },
    );
    for (const pin of spec.maven) {
      const status = execFileSync(
        "gpgv",
        [
          "--homedir",
          ring,
          "--keyring",
          publicKeys,
          "--status-fd",
          "1",
          path.join(base, pin.name + ".asc"),
          path.join(base, pin.name),
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30000,
          maxBuffer: 1048576,
        },
      );
      const valid = status
        .split("\n")
        .filter((s) => s.startsWith("[GNUPG:] VALIDSIG "));
      assert.equal(valid.length, 1);
      assert.equal(valid[0].split(" ")[2], pin.signature.signerFingerprint);
    }
  } finally {
    await rm(ring, { recursive: true, force: true });
  }
}
async function download(url, destination, pin, gradle = false) {
  const response = gradle
    ? (
        await requestGradleDistribution({
          signal: globalThis.AbortSignal.timeout(600000),
        })
      ).response
    : await globalThis.fetch(url, {
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(60000),
      });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const file = await open(destination, "wx");
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      assert.ok(total <= pin.bytes);
      await file.writeFile(chunk);
    }
  } finally {
    await file.close();
  }
  await regular(destination, pin);
}
async function verifyCache(base) {
  for (const pin of archives) await regular(path.join(base, pin.file), pin);
  await verifySignatures(base);
  for (const pin of jvmWrapperPins)
    await regular(path.join(base, "wrapper-artifacts", pin.path), pin);
}
const exists = await lstat(target).then(
  () => true,
  (e) => {
    if (e.code !== "ENOENT") throw e;
    return false;
  },
);
if (exists) {
  await verifyCache(target);
  console.log(
    JSON.stringify({
      cacheHit: true,
      archivesVerified: archives.length,
      wrapperArtifactsVerified: jvmWrapperPins.length,
      cryptographicMavenSignaturesVerified: true,
      keyOwnerTrustEstablished: false,
      wholeLicenseClosureVerified: false,
    }),
  );
} else {
  const stage = await mkdtemp(path.join(parent, ".jvm-wrappers-"));
  try {
    // Validate all source artifacts before copying any or executing a native setup tool.
    const all = [
      ...archives.map((p) => ({ ...p, name: p.file })),
      spec.publicKeys,
      ...spec.maven.map((p) => ({
        ...p.signature,
        name: p.name + ".asc",
        url: p.url + ".asc",
      })),
    ];
    if (source) {
      for (const pin of all) await regular(path.join(source, pin.name), pin);
      for (const pin of all)
        await cp(path.join(source, pin.name), path.join(stage, pin.name));
    } else
      for (const pin of all)
        await download(
          pin.url,
          path.join(stage, pin.name),
          pin,
          pin.name === jvmWrapperArchives.gradle.file,
        );
    await verifySignatures(stage);
    const distribution = path.join(parent, "gradle-review-tools/gradle-9.8.0");
    await verifyMavenTree(distribution, gradleDistributionFiles);
    assert.ok(
      selectedImage,
      "Select the operator-prepared Linux ARM64 JVM image for native wrapper generation",
    );
    const image = execFileSync(
      "docker",
      ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
      { encoding: "utf8" },
    ).trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const templates = path.join(stage, "wrapper-artifacts");
    await mkdir(templates);
    await writeFile(
      path.join(templates, "settings.gradle"),
      "rootProject.name='original-wrapper-seed'\n",
      { flag: "wx" },
    );
    await writeFile(path.join(templates, "build.gradle"), "\n", { flag: "wx" });
    assert.ok(
      typeof process.getuid === "function" &&
        typeof process.getgid === "function",
      "Native wrapper preparation requires POSIX ownership",
    );
    const nativeUser = `${process.getuid()}:${process.getgid()}`;
    const nativeBase = [
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "--read-only",
      "--user",
      nativeUser,
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--pids-limit",
      "256",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,exec,size=512m",
      "--label",
      "checktrail.task=" + task,
      "--mount",
      `type=bind,src=${repository},target=/workspace,readonly`,
      "--mount",
      `type=bind,src=${distribution},target=/opt/gradle,readonly`,
      "--mount",
      `type=bind,src=${templates},target=/seed`,
      "--workdir",
      "/seed",
      image,
    ];
    execFileSync(
      "docker",
      [
        ...nativeBase,
        "node",
        "--input-type=module",
        "-e",
        'import{verifyJvmToolchain}from "/workspace/dist/src/jvm-extensions.js";await verifyJvmToolchain();',
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
    );
    const native = execFileSync(
      "docker",
      [
        ...nativeBase,
        "java",
        ...gradleJvmArguments,
        "-javaagent:/opt/gradle/lib/agents/gradle-instrumentation-agent-9.8.0.jar",
        "-Dorg.gradle.jvmargs=" + gradleJvmArguments.join(" "),
        "-jar",
        "/opt/gradle/lib/gradle-gradle-cli-main-9.8.0.jar",
        "--offline",
        "--no-daemon",
        "--gradle-user-home",
        "/tmp/home",
        "--console=plain",
        "wrapper",
        "--gradle-version=9.8.0",
        "--distribution-type=bin",
        "--gradle-distribution-sha256-sum=" + jvmWrapperArchives.gradle.sha256,
        "--no-validate-url",
      ],
      { encoding: "utf8", timeout: 180000, maxBuffer: 1048576 },
    );
    assert.match(native, /BUILD SUCCESSFUL/);
    const table = path.join(stage, "maven-members.json");
    await writeFile(
      table,
      JSON.stringify(
        jvmWrapperPins.filter(
          (p) => p.kind === "maven" && !p.path.endsWith(".properties"),
        ),
      ),
    );
    execFileSync(
      "python3",
      [
        "-I",
        fileURLToPath(
          new URL("./extract-jvm-wrapper-template.py", import.meta.url),
        ),
        path.join(stage, "maven-wrapper-distribution-3.3.4-bin.zip"),
        templates,
        table,
      ],
      { stdio: "pipe", timeout: 30000, maxBuffer: 1048576 },
    );
    await writeFile(
      path.join(templates, ".mvn/wrapper/maven-wrapper.properties"),
      jvmWrapperProperties.maven,
      { flag: "wx" },
    );
    for (const pin of jvmWrapperPins)
      await regular(path.join(templates, pin.path), pin);
    for (const name of ["settings.gradle", "build.gradle", ".gradle", "build"])
      await rm(path.join(templates, name), { recursive: true, force: true });
    await rm(table);
    await verifyCache(stage);
    await writeFile(
      path.join(stage, "prepared.json"),
      JSON.stringify({
        schemaVersion: 1,
        nativeGradleGenerationExecuted: true,
        nativeUser,
        image,
        archivePins: archives.map(({ file, bytes, sha256 }) => ({
          file,
          bytes,
          sha256,
        })),
        wrapperPins: jvmWrapperPins,
        cryptographicMavenSignaturesVerified: true,
        keyOwnerTrustEstablished: false,
        wholeLicenseClosureVerified: false,
      }) + "\n",
      { flag: "wx" },
    );
    await rename(stage, target);
    console.log(
      JSON.stringify({
        cacheHit: false,
        archivesVerified: archives.length,
        wrapperArtifactsVerified: jvmWrapperPins.length,
        nativeGradleGenerationExecuted: true,
        cryptographicMavenSignaturesVerified: true,
        keyOwnerTrustEstablished: false,
        wholeLicenseClosureVerified: false,
      }),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
