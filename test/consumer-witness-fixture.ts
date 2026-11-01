import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  link,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseCapturedProcessOutput } from "../src/process-output.js";
import type { ProcessResult, Report } from "../src/types.js";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
import { nativeOuterCommandSha256 } from "../src/native-journal-engine.js";
import { withinRoot } from "../src/inventory.js";
export type ConsumerVariant = "broken" | "fixed" | "near-miss";
export type ConsumerPhase =
  "canonical" | "caller-change" | "restored" | "repeat";
export type ConsumerStage =
  | "compiler-link"
  | "compiler"
  | "consumer"
  | "hcl-init"
  | `hcl-plan-${0 | 1 | 2 | 3 | 4 | 5 | 6}`
  | `hcl-show-${0 | 1 | 2 | 3 | 4 | 5 | 6}`;
export type ConsumerFamily =
  | "go"
  | "python"
  | "php"
  | "rust"
  | "ruby"
  | "c"
  | "cpp"
  | "java"
  | "kotlin"
  | "scala"
  | "csharp"
  | "fsharp"
  | "vb"
  | "hcl"
  | "yaml"
  | "swift"
  | "javascript"
  | "typescript"
  | "shared-json";
const recordedConsumerResults = new WeakSet<ProcessResult>();
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const filesByFamily = {
  go: ["policy/policy.go", "consumer/consumer.go"],
  python: ["pkg/policy.py", "pkg/consumer.py"],
  php: ["policy/policy.php", "consumer/consumer.php"],
  rust: ["src/policy.rs", "src/consumer.rs", "src/lib.rs"],
  ruby: ["src/policy/Policy.rb", "src/consumer/Consumer.rb"],
  c: ["src/policy/rules.h", "src/consumer/use.c"],
  cpp: ["src/policy/rules.h", "src/consumer/use.cpp"],
  java: ["src/policy/Policy.java", "src/consumer/Consumer.java"],
  kotlin: ["src/policy/Policy.kt", "src/consumer/Consumer.kt"],
  scala: ["src/policy/Policy.scala", "src/consumer/Consumer.scala"],
  csharp: ["src/policy/Policy.cs", "src/consumer/Consumer.cs"],
  fsharp: ["src/policy/Policy.fs", "src/consumer/Consumer.fs"],
  vb: ["src/policy/Policy.vb", "src/consumer/Consumer.vb"],
  hcl: ["policy/rules.tf", "main.tf"],
  yaml: ["policy.yaml", "extra.yaml"],
  swift: ["src/policy/Policy.swift", "src/consumer/Consumer.swift"],
  javascript: [
    "checktrail.json",
    "lib/policy.json",
    "lib/value.js",
    "lib/value.test.js",
    "other/value.test.js",
    "app/value.test.js",
    "site/value.test.js",
    "app/package.json",
    "lib/package.json",
    "other/package.json",
    "site/package.json",
  ],
  "shared-json": [
    "checktrail.json",
    "lib/policy.json",
    "lib/value.js",
    "lib/value.test.js",
    "other/value.test.js",
    "app/value.test.js",
    "site/value.test.js",
    "app/package.json",
    "lib/package.json",
    "other/package.json",
    "site/package.json",
  ],
  typescript: [
    "package.json",
    "checktrail.json",
    "checktrail.javascript.json",
    "esm hook.mjs",
    "cjs hook.cjs",
    "esm.test.mts",
    "cjs.test.cts",
    "lib/index.ts",
    "lib/value.ts",
    "use.ts",
    "processed.js",
    "eslint.config.mjs",
  ],
} as const;
const isProjectConsumer = (family: ConsumerFamily) =>
  ["javascript", "typescript", "shared-json"].includes(family);
const consumerProfile = (family: ConsumerFamily) =>
  family === "typescript"
    ? "javascript-extensions"
    : family === "javascript" || family === "shared-json"
      ? "consumer-impact"
      : "context-" + family;
const consumerAcceptanceFile = (family: ConsumerFamily) =>
  family === "typescript"
    ? "gate-javascript-extensions.test.js"
    : family === "javascript" || family === "shared-json"
      ? "gate-consumer-impact.test.js"
      : "gate-context-" + family + ".test.js";
function consumerOrigin(family: ConsumerFamily) {
  return (
    family === "javascript" || family === "shared-json"
      ? process.env.CHECKTRAIL_CONSUMER_WHOLE_INSTALLED === "1"
      : family === "typescript"
        ? process.env.CHECKTRAIL_JAVASCRIPT_EXTENSIONS_INSTALLED === "1"
        : process.env[
            "CHECKTRAIL_CONTEXT_" + family.toUpperCase() + "_INSTALLED"
          ] === "1"
  )
    ? "installed"
    : "source";
}
async function bytesIdentity(
  filename: string,
  maximum = 1048576,
  requireUnlinked = false,
) {
  const canonical = await realpath(filename);
  if (requireUnlinked)
    assert.equal(canonical, filename, "Consumer source crosses a link");
  const fd = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.size >= 0n && before.size <= BigInt(maximum),
    );
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let count = 0;
    while (true) {
      const { bytesRead } = await fd.read(
        buffer,
        0,
        Math.min(buffer.length, maximum + 1 - count),
        null,
      );
      if (bytesRead === 0) break;
      count += bytesRead;
      assert.ok(
        count <= maximum,
        "Consumer identity input grew beyond its byte bound",
      );
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await fd.stat({ bigint: true });
    const linked = await lstat(canonical, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)
      assert.equal(before[key], after[key]);
    assert.equal(after.ino, linked.ino);
    assert.equal(after.dev, linked.dev);
    assert.equal(BigInt(count), before.size);
    return { bytes: count, sha256: digest.digest("hex") };
  } finally {
    await fd.close();
  }
}
async function snapshot(root: string, family: ConsumerFamily) {
  return Promise.all(
    filesByFamily[family].map(async (name) => ({
      path: name,
      ...(await bytesIdentity(path.join(root, name), 1048576, true)),
    })),
  );
}
function outside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(".." + path.sep)
  );
}
/** Private controller-maintenance storage only; this grants no project execution trust. */
export async function consumerWitnessCaptureParent(
  filename: string | undefined,
) {
  if (filename === undefined) return realpath(os.tmpdir());
  assert.notEqual(
    process.platform,
    "win32",
    "Operator POSIX capture parent is unsupported on Windows",
  );
  assert.ok(
    path.isAbsolute(filename),
    "Operator capture parent must be absolute",
  );
  assert.equal(
    await realpath(filename),
    filename,
    "Operator capture parent crosses a link",
  );
  const stat = await lstat(filename);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o700,
    "Operator capture parent must be a private directory",
  );
  // A mounted parent can have an operator UID; each namespace below is separately
  // created and checked against the actual native collector UID and mode0700.
  return filename;
}
async function privateDirectory(filename: string, root: string) {
  assert.ok(path.isAbsolute(filename));
  assert.equal(await realpath(filename), filename);
  const stat = await lstat(filename);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (process.platform === "win32" ||
        (stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700)),
    "Witness capture requires existing private operator storage",
  );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(filename, "directory", false);
  assert.ok(outside(root, filename));
  assert.ok(
    outside(
      await realpath(fileURLToPath(new URL("../../", import.meta.url))),
      filename,
    ),
    "Witness captures stay outside the source/package harness",
  );
  assert.ok(
    (await readdir(filename)).length < 512,
    "Consumer capture inventory exceeds bound",
  );
  return { dev: stat.dev, ino: stat.ino };
}
async function tool(executable: string) {
  assert.ok(
    process.platform !== "win32" || executable === process.execPath,
    "Selected native consumer collector requires a POSIX tool runtime",
  );
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((part) => path.isAbsolute(part))
        .map((part) => path.join(part, executable));
  for (const launch of candidates) {
    try {
      await access(launch, constants.X_OK);
      const identity = await bytesIdentity(launch, 256 * 1048576);
      return { launch, ...identity };
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  throw Error("Native consumer tool unavailable before invocation");
}
type ConsumerDirectory = {
  profile: "bounded-consumer-directory-v1";
  directorySha256: string;
  files: { path: string; bytes: number; sha256: string }[];
  bytes: number;
  manifestSha256: string;
};
export async function observeConsumerWitnessDirectory(
  directory: string,
  jarsOnly: boolean | "dlls" = false,
  maximumFiles = 256,
): Promise<ConsumerDirectory> {
  assert.equal(await realpath(directory), directory);
  const files: ConsumerDirectory["files"] = [];
  let bytes = 0;
  async function visit(current: string) {
    const before = await lstat(current, { bigint: true });
    assert.ok(before.isDirectory() && !before.isSymbolicLink());
    for (const name of (await readdir(current)).sort()) {
      const filename = path.join(current, name),
        stat = await lstat(filename);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) {
        if (jarsOnly === true)
          assert.ok(
            !name.endsWith(".jar") && !name.endsWith(".JAR"),
            "Unsupported directory selected by JVM classpath wildcard",
          );
        else if (jarsOnly !== "dlls") await visit(filename);
      } else {
        assert.ok(stat.isFile());
        if (
          jarsOnly === true &&
          !name.endsWith(".jar") &&
          !name.endsWith(".JAR")
        )
          continue;
        if (jarsOnly === "dlls" && !name.endsWith(".dll")) continue;
        const value = await bytesIdentity(filename, 128 * 1048576, true);
        bytes += value.bytes;
        assert.ok(files.length < maximumFiles && bytes <= 512 * 1048576);
        files.push({
          path: path.relative(directory, filename).split(path.sep).join("/"),
          ...value,
        });
      }
    }
    const after = await lstat(current, { bigint: true });
    for (const key of ["dev", "ino", "mtimeNs", "ctimeNs"] as const)
      assert.equal(after[key], before[key]);
  }
  await visit(directory);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    profile: "bounded-consumer-directory-v1",
    directorySha256: hash(directory),
    files,
    bytes,
    manifestSha256: hash(JSON.stringify(files)),
  };
}
export async function observeConsumerWitnessJvmInputs(family: ConsumerFamily) {
  assert.ok(["java", "kotlin", "scala"].includes(family));
  const compiler = await tool(family === "java" ? "javac" : "java"),
    runtime = await tool("java");
  const jdk = path.dirname(path.dirname(await realpath(runtime.launch)));
  return {
    profile: "consumer-jvm-inputs-v1",
    family,
    compiler: { bytes: compiler.bytes, sha256: compiler.sha256 },
    runtime: { bytes: runtime.bytes, sha256: runtime.sha256 },
    modules: await bytesIdentity(path.join(jdk, "lib/modules"), 1024 * 1048576),
    libraries:
      family === "java"
        ? null
        : await observeConsumerWitnessDirectory(
            family === "kotlin"
              ? "/opt/checktrail/kotlinc/lib"
              : "/opt/checktrail/scala/lib",
            true,
          ),
  };
}
export async function observeConsumerWitnessSwiftInputs() {
  const driver = await tool("swiftc"),
    frontend = await tool("swift-frontend");
  return {
    profile: "consumer-swift-inputs-v1",
    scope: "observed-driver-and-frontend",
    otherDependenciesAttested: false,
    driver: { bytes: driver.bytes, sha256: driver.sha256 },
    frontend: { bytes: frontend.bytes, sha256: frontend.sha256 },
  };
}
export async function bindConsumerWitnessSwiftDirectory(
  capture: ConsumerCapture | null,
  directory: string,
) {
  if (!capture) return;
  assert.ok(capture.swift);
  assert.equal(await realpath(directory), directory);
  assert.equal(outside(capture.root, directory), false);
  capture.swift.directory = directory;
  capture.swift.seed = await observeConsumerWitnessDirectory(directory);
  assert.equal(capture.swift.seed.files.length, 0);
  capture.swift.generated = capture.swift.seed;
}
export async function bindConsumerWitnessSwiftMain(
  capture: ConsumerCapture | null,
  filename: string,
) {
  if (!capture) return;
  assert.ok(capture.swift);
  assert.equal(filename, path.join(capture.root, "main.swift"));
  capture.swift.main = await bytesIdentity(filename, 1048576, true);
}
export async function observeConsumerWitnessDataInputs(family: ConsumerFamily) {
  assert.ok(["hcl", "yaml"].includes(family));
  const executable = await tool(
    family === "hcl" ? "terraform" : process.execPath,
  );
  const base = {
    profile: "consumer-data-inputs-v1",
    family,
    tool: { bytes: executable.bytes, sha256: executable.sha256 },
  };
  if (family === "hcl") return base;
  const url = import.meta.resolve("yaml"),
    entry = await realpath(fileURLToPath(url));
  let directory = path.dirname(entry),
    pkg: { name?: string; version?: string } | null = null;
  for (let level = 0; level < 5; level++) {
    try {
      const value = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      );
      if (value.name === "yaml") {
        pkg = value;
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  assert.ok(pkg);
  return {
    ...base,
    package: {
      name: pkg.name,
      version: pkg.version,
      entry: path.relative(directory, entry).split(path.sep).join("/"),
      importUrlSha256: hash(url),
      inventory: await observeConsumerWitnessDirectory(directory, false, 2048),
    },
  };
}
async function optionalConsumerFile(filename: string, maximum = 33554432) {
  try {
    return await bytesIdentity(filename, maximum, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function consumerModuleMap(root: string) {
  const filename = path.join(root, ".terraform/modules/modules.json");
  try {
    const before = await bytesIdentity(filename, 65536, true);
    const bytes = await readFile(filename);
    assert.ok(
      bytes.length <= 65536 &&
        bytes.length === before.bytes &&
        hash(bytes) === before.sha256,
    );
    assert.deepEqual(await bytesIdentity(filename, 65536, true), before);
    return { ...before, text: bytes.toString("utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function observeConsumerWitnessManagedInputs(
  family: ConsumerFamily,
) {
  assert.ok(["csharp", "fsharp", "vb"].includes(family));
  const host = await tool("dotnet"),
    root = path.dirname(await realpath(host.launch));
  const compiler = path.join(
    root,
    "sdk/10.0.401",
    family === "fsharp" ? "FSharp" : "Roslyn/bincore",
  );
  return {
    profile: "consumer-managed-inputs-v1",
    family,
    dotnet: { bytes: host.bytes, sha256: host.sha256 },
    runtimeVersions: (
      await readdir(path.join(root, "shared/Microsoft.NETCore.App"))
    ).sort(),
    hostFxrVersions: (await readdir(path.join(root, "host/fxr"))).sort(),
    compilerDirectory: await observeConsumerWitnessDirectory(compiler),
    references: await observeConsumerWitnessDirectory(
      path.join(root, "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0"),
      "dlls",
    ),
    runtime: await observeConsumerWitnessDirectory(
      path.join(root, "shared/Microsoft.NETCore.App/10.0.12"),
    ),
    hostFxr: await observeConsumerWitnessDirectory(path.join(root, "host/fxr")),
    fsharpCore:
      family === "fsharp"
        ? await bytesIdentity(
            path.join(compiler, "FSharp.Core.dll"),
            128 * 1048576,
            true,
          )
        : null,
  };
}
export async function observeConsumerWitnessManagedSeed(directory: string) {
  assert.equal(await realpath(directory), directory);
  const seed = await observeConsumerWitnessDirectory(directory);
  const filename = path.join(directory, "Witness.runtimeconfig.json");
  const identity = await bytesIdentity(filename, 8192, true);
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(8193);
  let count = 0;
  try {
    while (count < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        count,
        buffer.length - count,
        null,
      );
      if (bytesRead === 0) break;
      count += bytesRead;
      assert.ok(count <= 8192);
    }
  } finally {
    await fd.close();
  }
  assert.equal(count, identity.bytes);
  assert.equal(hash(buffer.subarray(0, count)), identity.sha256);
  assert.deepEqual(await bytesIdentity(filename, 8192, true), identity);
  const text = buffer.subarray(0, count).toString("utf8");
  return {
    seed,
    runtimeConfig: { text, bytes: Buffer.byteLength(text), sha256: hash(text) },
  };
}
export async function bindConsumerWitnessManagedDirectory(
  capture: ConsumerCapture | null,
  directory: string,
) {
  if (!capture) return;
  assert.ok(capture.managed);
  assert.equal(await realpath(directory), directory);
  assert.equal(outside(capture.root, directory), false);
  const observed = await observeConsumerWitnessManagedSeed(directory);
  capture.managed.directory = directory;
  capture.managed.seed = observed.seed;
  capture.managed.generated = observed.seed;
  capture.managed.runtimeConfig = observed.runtimeConfig;
}
export async function bindConsumerWitnessClassDirectory(
  capture: ConsumerCapture | null,
  directory: string,
) {
  if (!capture) return;
  assert.ok(capture.jvm);
  assert.equal(await realpath(directory), directory);
  assert.equal(outside(capture.root, directory), false);
  const before = await observeConsumerWitnessDirectory(directory);
  assert.deepEqual(before.files, []);
  capture.jvm.directory = directory;
  capture.jvm.generated = before;
}
async function codeMetadata(family: ConsumerFamily) {
  const enginePath = await realpath(
    fileURLToPath(new URL("../src/", import.meta.url)),
  );
  const { captureCompiledEngine } = await import(
    new URL("../../scripts/compiled-engine-evidence.mjs", import.meta.url).href
  );
  const engine = await captureCompiledEngine(enginePath);
  const harnessRoot = await realpath(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const packageRoot = path.dirname(path.dirname(enginePath));
  const inputs = [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL(consumerAcceptanceFile(family), import.meta.url)),
    path.join(harnessRoot, "scripts/required-native-tests.json"),
    path.join(harnessRoot, "scripts/compiled-engine-evidence.mjs"),
    path.join(harnessRoot, "scripts/consumer-witness-attempts.mjs"),
    path.join(harnessRoot, "scripts/consumer-witness-jvm.mjs"),
    path.join(harnessRoot, "scripts/consumer-witness-managed.mjs"),
    path.join(harnessRoot, "scripts/consumer-witness-data.mjs"),
    path.join(harnessRoot, "scripts/consumer-witness-swift.mjs"),
    path.join(harnessRoot, "scripts/consumer-witness-project.mjs"),
    path.join(harnessRoot, "scripts/consumer-runtime-selection.mjs"),
  ];
  const identities = await Promise.all(
    inputs.map((filename) => bytesIdentity(filename)),
  );
  const requirements = JSON.parse(await readFile(inputs[2]!, "utf8"))[
    consumerProfile(family)
  ];
  return {
    engine,
    enginePath,
    harnessRoot,
    packageRoot,
    inputs,
    identities,
    engineSha256: engine.treeSha256,
    harnessSha256: hash(
      JSON.stringify([
        identities[0],
        identities[1],
        identities[3],
        identities[4],
        identities[5],
        identities[6],
        identities[7],
        identities[8],
        identities[9],
        identities[10],
      ]),
    ),
    acceptanceSha256: identities[1]!.sha256,
    requirementsSha256: hash(JSON.stringify(requirements)),
    packageManifestSha256: hash(
      await readFile(path.join(packageRoot, "package.json")),
    ),
    installedOutsidePackage: outside(packageRoot, harnessRoot),
  };
}
export async function observeConsumerWitnessTool(family: ConsumerFamily) {
  assert.ok(Object.hasOwn(filesByFamily, family));
  const observed = await tool(
    {
      go: "go",
      python: "python3",
      php: "php",
      rust: "rustc",
      ruby: "ruby",
      c: "gcc",
      cpp: "g++",
      java: "javac",
      kotlin: "java",
      scala: "java",
      csharp: "dotnet",
      fsharp: "dotnet",
      vb: "dotnet",
      hcl: "terraform",
      yaml: process.execPath,
      swift: "swiftc",
      javascript: process.execPath,
      typescript: process.execPath,
      "shared-json": process.execPath,
    }[family],
  );
  return { bytes: observed.bytes, sha256: observed.sha256 };
}
export type ConsumerCapture = NonNullable<
  Awaited<ReturnType<typeof beginConsumerWitness>>
>;
/** Test-only optional operator capture. This grants no project execution permission. */
export async function beginConsumerWitness(
  root: string,
  family: ConsumerFamily,
  variant: ConsumerVariant,
  phase: ConsumerPhase = "canonical",
) {
  const destination = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
  if (!destination) return null;
  assert.ok(Object.hasOwn(filesByFamily, family));
  assert.ok(["broken", "fixed", "near-miss"].includes(variant));
  assert.ok(
    ["canonical", "caller-change", "restored", "repeat"].includes(phase),
  );
  const canonical = await realpath(root);
  const storageIdentity = await privateDirectory(destination, canonical);
  const selected = await tool(
    {
      go: "go",
      python: "python3",
      php: "php",
      rust: "rustc",
      ruby: "ruby",
      c: "gcc",
      cpp: "g++",
      java: "javac",
      kotlin: "java",
      scala: "java",
      csharp: "dotnet",
      fsharp: "dotnet",
      vb: "dotnet",
      hcl: "terraform",
      yaml: process.execPath,
      swift: "swiftc",
      javascript: process.execPath,
      typescript: process.execPath,
      "shared-json": process.execPath,
    }[family],
  );
  const jvm = ["java", "kotlin", "scala"].includes(family)
    ? {
        inputs: await observeConsumerWitnessJvmInputs(family),
        directory: null as string | null,
        generated: null as ConsumerDirectory | null,
        runtime: await tool("java"),
      }
    : null;
  const managed = ["csharp", "fsharp", "vb"].includes(family)
    ? {
        inputs: await observeConsumerWitnessManagedInputs(family),
        directory: null as string | null,
        seed: null as ConsumerDirectory | null,
        generated: null as ConsumerDirectory | null,
        runtimeConfig: null as {
          text: string;
          bytes: number;
          sha256: string;
        } | null,
      }
    : null;
  const swift =
    family === "swift"
      ? {
          inputs: await observeConsumerWitnessSwiftInputs(),
          directory: null as string | null,
          seed: null as ConsumerDirectory | null,
          produced: null as ConsumerDirectory | null,
          generated: null as ConsumerDirectory | null,
          main: null as { bytes: number; sha256: string } | null,
        }
      : null;
  const data = ["hcl", "yaml"].includes(family)
    ? {
        inputs: await observeConsumerWitnessDataInputs(family),
        plan: null as Awaited<ReturnType<typeof optionalConsumerFile>>,
        plans: [] as NonNullable<
          Awaited<ReturnType<typeof optionalConsumerFile>>
        >[],
        results: [] as boolean[],
      }
    : null;
  return {
    root: canonical,
    destination,
    storageIdentity,
    witnessId: randomUUID(),
    storageFailure: null as string | null,
    attempts: [] as {
      stage: ConsumerStage;
      attemptId: string;
      file: string;
      bytes: number;
      sha256: string;
    }[],
    resultRecords: new WeakMap<
      ProcessResult,
      {
        stage: ConsumerStage;
        reference: {
          stage: ConsumerStage;
          attemptId: string;
          file: string;
          bytes: number;
          sha256: string;
        };
        value: unknown;
      }
    >(),
    family,
    variant,
    phase,
    before: await snapshot(canonical, family),
    tool: selected,
    executable: selected.launch,
    runtimeExecutable: jvm?.runtime ?? selected,
    jvm,
    managed,
    swift,
    data,
    compiler: null as ProcessResult | null,
    compilerLink: null as ProcessResult | null,
    code: await codeMetadata(family),
  };
}
export async function bindConsumerWitnessExecutable(
  capture: ConsumerCapture | null,
  filename: string,
) {
  if (capture) capture.runtimeExecutable = await tool(filename);
}
export function bindConsumerWitnessCompiler(
  capture: ConsumerCapture | null,
  result: ProcessResult,
  stage: "compiler" | "compiler-link" = "compiler",
) {
  if (capture) {
    if (stage === "compiler-link") capture.compilerLink = result;
    else capture.compiler = result;
  }
}
async function publishConsumerCapture(
  capture: ConsumerCapture,
  row: unknown,
  name: string,
) {
  assert.equal(
    capture.storageFailure,
    null,
    "Earlier consumer capture storage failure leaves the witness incomplete",
  );
  const bytes = Buffer.from(JSON.stringify(row) + "\n");
  assert.ok(
    bytes.length <=
      (capture.family === "hcl" || isProjectConsumer(capture.family)
        ? 2097152
        : 262144),
    "Consumer capture byte bound exceeded",
  );
  assert.deepEqual(
    await privateDirectory(capture.destination, capture.root),
    capture.storageIdentity,
    "Consumer capture directory changed",
  );
  const pending = path.join(capture.destination, ".pending-" + randomUUID());
  const target = path.join(capture.destination, name);
  let fd;
  try {
    fd = await open(pending, "wx", 0o600);
    if (process.platform === "win32")
      ensureWindowsTaskAccess(pending, "file", true);
    await fd.writeFile(bytes);
    await fd.sync();
    await fd.close();
    fd = undefined;
    await link(pending, target);
  } finally {
    if (fd) await fd.close();
    await unlink(pending).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  assert.deepEqual(
    await privateDirectory(capture.destination, capture.root),
    capture.storageIdentity,
    "Consumer capture directory changed during publication",
  );
  return { file: name, bytes: bytes.length, sha256: hash(bytes) };
}
/** Persist the actual returned result before an assertion can discard a failed attempt. */
export async function recordConsumerWitnessAttempt(
  capture: ConsumerCapture | null,
  result: ProcessResult,
  stage: ConsumerStage = "consumer",
  project: {
    scenario: string;
    checkIndex: number;
    reportSha256: string;
  } | null = null,
) {
  if (!capture) return null;
  const previous = capture.resultRecords.get(result);
  if (previous) {
    assert.equal(previous.stage, stage);
    return previous;
  }
  assert.ok(
    (capture.family === "hcl" &&
      /^hcl-(?:init|(?:plan|show)-[0-6])$/.test(stage)) ||
      stage === "consumer" ||
      (capture.family === "swift" &&
        (stage === "compiler" || stage === "compiler-link")) ||
      [
        "rust",
        "c",
        "cpp",
        "java",
        "kotlin",
        "scala",
        "csharp",
        "fsharp",
        "vb",
      ].includes(capture.family),
  );
  try {
    assert.equal(
      recordedConsumerResults.has(result),
      false,
      "Actual ProcessResult cannot be reused across consumer witness captures",
    );
    const { consumerAttemptState } = await import(
      new URL("../../scripts/consumer-witness-attempts.mjs", import.meta.url)
        .href
    );
    let output: ReturnType<typeof parseCapturedProcessOutput> | null = null;
    let identityError: string | null = null;
    try {
      if (result.capturedOutput !== undefined)
        output = parseCapturedProcessOutput(result.capturedOutput);
    } catch (error) {
      identityError = String(error).slice(0, 1024);
    }
    let after: Awaited<ReturnType<typeof snapshot>> | null = null;
    let executableAfterSha256: string | null = null;
    let projectWorkingDirectorySha256: string | null = null;
    let executable =
      stage === "compiler" || stage === "compiler-link"
        ? capture.tool
        : capture.runtimeExecutable;
    if (isProjectConsumer(capture.family)) {
      try {
        assert.ok(path.isAbsolute(result.command.executable));
        executable = await tool(result.command.executable);
        if (capture.family === "typescript")
          projectWorkingDirectorySha256 = hash(
            await withinRoot(capture.root, result.command.cwd),
          );
      } catch (error) {
        identityError ??= String(error).slice(0, 1024);
      }
    }

    try {
      after = await snapshot(capture.root, capture.family);
      executableAfterSha256 = (
        await bytesIdentity(executable.launch, 256 * 1048576)
      ).sha256;
    } catch (error) {
      identityError ??= String(error).slice(0, 1024);
    }
    let jvm = null;
    if (capture.jvm) {
      let inputsAfter = null,
        generatedAfter = null;
      try {
        inputsAfter = await observeConsumerWitnessJvmInputs(capture.family);
        assert.ok(capture.jvm.directory);
        generatedAfter = await observeConsumerWitnessDirectory(
          capture.jvm.directory,
        );
      } catch (error) {
        identityError ??= String(error).slice(0, 1024);
      }
      const argument = stage === "compiler" ? "-d" : "-cp";
      const index = result.command.args.indexOf(argument);
      const selected = index < 0 ? null : result.command.args[index + 1];
      const directory = selected
        ? stage === "compiler"
          ? selected
          : selected.split(path.delimiter)[0]
        : null;
      const { consumerJvmClasspaths } = await import(
        new URL("../../scripts/consumer-witness-jvm.mjs", import.meta.url).href
      );
      const classpaths = consumerJvmClasspaths(
        result.command.args,
        capture.root,
      );

      jvm = {
        classpaths,
        inputsBefore: capture.jvm.inputs,
        inputsAfter,
        generatedBefore: capture.jvm.generated,
        generatedAfter,
        commandDirectorySha256:
          stage === "consumer"
            ? (classpaths[0]?.[0]?.directorySha256 ?? null)
            : directory
              ? hash(path.resolve(capture.root, directory))
              : null,
      };
      if (stage === "compiler") capture.jvm.generated = generatedAfter;
    }
    let managed = null;
    if (capture.managed) {
      let inputsAfterSha256 = null,
        generatedAfter = null;
      try {
        inputsAfterSha256 = hash(
          JSON.stringify(
            await observeConsumerWitnessManagedInputs(capture.family),
          ),
        );
        assert.ok(capture.managed.directory);
        generatedAfter = await observeConsumerWitnessDirectory(
          capture.managed.directory,
        );
      } catch (error) {
        identityError ??= String(error).slice(0, 1024);
      }
      const { managedCommandBindings } = await import(
        new URL("../../scripts/consumer-witness-managed.mjs", import.meta.url)
          .href
      );
      managed = {
        inputsBefore: capture.managed.inputs,
        inputsAfterSha256,
        generatedBefore: capture.managed.generated,
        generatedAfter,
        command: managedCommandBindings(result.command.args, capture.root),
      };
      if (stage === "compiler") capture.managed.generated = generatedAfter;
    }
    let swift = null;
    if (capture.swift) {
      let inputsAfterSha256 = null,
        generatedAfter = null,
        mainAfter = null;
      try {
        inputsAfterSha256 = hash(
          JSON.stringify(await observeConsumerWitnessSwiftInputs()),
        );
        assert.ok(capture.swift.directory);
        generatedAfter = await observeConsumerWitnessDirectory(
          capture.swift.directory,
        );
        if (stage !== "compiler")
          mainAfter = await bytesIdentity(
            path.join(capture.root, "main.swift"),
            1048576,
            true,
          );
      } catch (error) {
        identityError ??= String(error).slice(0, 1024);
      }
      const { swiftCommandBindings } = await import(
        new URL("../../scripts/consumer-witness-swift.mjs", import.meta.url)
          .href
      );
      swift = {
        inputsBefore: capture.swift.inputs,
        inputsAfterSha256,
        generatedBefore: capture.swift.generated,
        generatedAfter,
        main: mainAfter,
        command: swiftCommandBindings(
          result.command.args,
          capture.root,
          result.command.env,
        ),
      };
      if (stage === "compiler") capture.swift.produced = generatedAfter;
      if (stage === "compiler" || stage === "compiler-link")
        capture.swift.generated = generatedAfter;
    }
    let data = null;
    if (capture.data) {
      let inputsAfterSha256 = null,
        planAfter = null,
        moduleMap = null;
      try {
        inputsAfterSha256 = hash(
          JSON.stringify(
            await observeConsumerWitnessDataInputs(capture.family),
          ),
        );
        if (capture.family === "hcl") {
          planAfter = await optionalConsumerFile(
            path.join(capture.root, "original.plan"),
          );
          moduleMap = await consumerModuleMap(capture.root);
        }
      } catch (error) {
        identityError ??= String(error).slice(0, 1024);
      }
      data = {
        inputsBefore: capture.data.inputs,
        inputsAfterSha256,
        planBefore: capture.data.plan,
        planAfter,
        moduleMap,
        args: capture.family === "hcl" ? result.command.args : [],
        cwd: result.command.cwd,
      };
      if (capture.family === "hcl") {
        capture.data.plan = planAfter;
        if (/^hcl-plan-[0-6]$/.test(stage) && planAfter)
          capture.data.plans[Number(stage.at(-1))] = planAfter;
        if (/^hcl-show-[0-6]$/.test(stage) && result.exitCode === 0) {
          try {
            const parsed = JSON.parse(result.stdout);
            capture.data.results[Number(stage.at(-1))] =
              parsed.planned_values?.outputs?.result?.value;
          } catch (error) {
            identityError ??= String(error).slice(0, 1024);
          }
        }
      }
    }
    const value = {
      schemaVersion: 1,
      profile: "consumer-process-result-observation-v1",
      attemptId: randomUUID(),
      witnessId: capture.witnessId,
      family: capture.family,
      variant: capture.variant,
      origin: consumerOrigin(capture.family),
      phase: capture.phase,
      stage,
      before: capture.before,
      after,
      commandSha256: nativeOuterCommandSha256(result.command),
      argvSha256: hash(JSON.stringify(result.command.args)),
      executableSha256: executable.sha256,
      executableAfterSha256,
      identityError,
      jvm,
      managed,
      swift,
      data,
      project:
        capture.family === "typescript" && project !== null
          ? {
              ...project,
              workingDirectorySha256: projectWorkingDirectorySha256,
            }
          : project,
      output,
      outputState:
        output === null
          ? "unavailable"
          : output.completeForObservedStreams
            ? "complete"
            : "incomplete",
      decodedDiagnostics:
        output === null
          ? {
              stdout: result.stdout.slice(0, 1024),
              stderr: result.stderr.slice(0, 1024),
            }
          : null,
      result: {
        exitCode: result.exitCode,
        signal: result.signal,
        errorCode: result.errorCode ?? null,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        truncated: result.truncated,
      },
      processStartAcknowledgementRetained: false,
      nativeTerminalObserved:
        result.exitCode !== null || result.signal !== null,
      state: "unavailable",
      cleanupComplete: false,
      gateAComplete: false,
    };
    value.state = consumerAttemptState(value);
    value.cleanupComplete =
      result.errorCode === undefined &&
      (value.nativeTerminalObserved || value.state === "not-started");
    const stored = await publishConsumerCapture(
      capture,
      value,
      "attempt-" + value.attemptId + ".json",
    );
    const reference = { stage, attemptId: value.attemptId, ...stored };
    capture.attempts.push(reference);
    const observed = { stage, reference, value };
    capture.resultRecords.set(result, observed);
    recordedConsumerResults.add(result);
    return observed;
  } catch (error) {
    capture.storageFailure = String(error).slice(0, 1024);
    throw error;
  }
}
function completeInvocation(result: ProcessResult) {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  const output = parseCapturedProcessOutput(result.capturedOutput);
  assert.equal(output.completeForObservedStreams, true);
  assert.equal(hash(result.stdout), output.stdout.sha256);
  assert.equal(hash(result.stderr), output.stderr.sha256);
  return output;
}
/** Capture follows reached process cleanup; its required enclosing callback must also pass. */
export async function finishConsumerWitness(
  capture: ConsumerCapture | null,
  result: ProcessResult,
) {
  if (!capture) return;
  if (capture.data) return finishConsumerDataWitness(capture, result);
  assert.equal(
    capture.storageFailure,
    null,
    "Earlier consumer capture storage failure leaves the witness incomplete",
  );
  await recordConsumerWitnessAttempt(capture, result);
  assert.deepEqual(
    capture.attempts.map((item) => item.stage),
    capture.family === "swift"
      ? ["compiler", "compiler-link", "consumer"]
      : [
            "rust",
            "c",
            "cpp",
            "java",
            "kotlin",
            "scala",
            "csharp",
            "fsharp",
            "vb",
          ].includes(capture.family)
        ? ["compiler", "consumer"]
        : ["consumer"],
    "Consumer native attempt inventory differs",
  );
  const output = completeInvocation(result);
  assert.equal(output.stderr.bytes, 0);
  assert.ok(output.stdout.bytes <= 65536 && output.stderr.bytes <= 65536);
  const after = await snapshot(capture.root, capture.family);
  assert.deepEqual(
    after,
    capture.before,
    "Consumer source changed during native invocation",
  );
  const executableAfter = await bytesIdentity(
    capture.runtimeExecutable.launch,
    256 * 1048576,
  );
  assert.deepEqual(executableAfter, {
    bytes: capture.runtimeExecutable.bytes,
    sha256: capture.runtimeExecutable.sha256,
  });
  const compilerToolAfter = await bytesIdentity(
    capture.tool.launch,
    256 * 1048576,
  );
  assert.deepEqual(compilerToolAfter, {
    bytes: capture.tool.bytes,
    sha256: capture.tool.sha256,
  });
  const native = JSON.parse(
    Buffer.from(output.stdout.base64, "base64").toString("utf8"),
  );
  const consumers =
    capture.family === "go" ? native.answers.slice(-2) : native.consumers;
  const expected =
    capture.phase === "caller-change"
      ? [false, true]
      : ["ruby", "csharp", "fsharp", "vb", "swift"].includes(capture.family)
        ? capture.variant === "broken"
          ? [true, true, true]
          : capture.variant === "near-miss"
            ? [false, false, false]
            : [false, true, false]
        : capture.variant === "broken"
          ? [true, true]
          : ["rust", "java", "kotlin", "scala"].includes(capture.family) &&
              capture.variant === "near-miss"
            ? [false, false]
            : [false, true];
  assert.deepEqual(consumers, expected);
  const sources: Record<string, string> = {};
  for (const file of capture.before) {
    const raw =
      native.sources[
        capture.family === "python" ? path.basename(file.path) : file.path
      ];
    const { consumerWitnessSourceSha256 } = await import(
      new URL("../../scripts/consumer-witness-attempts.mjs", import.meta.url)
        .href
    );
    const observed: string = consumerWitnessSourceSha256(
      capture.family,
      raw,
      file.bytes,
    );
    assert.equal(observed, file.sha256);
    sources[file.path] = observed;
  }
  const currentCode = await codeMetadata(capture.family);
  assert.equal(
    currentCode.engineSha256,
    capture.code.engineSha256,
    "Consumer engine bytes changed during witness",
  );
  assert.equal(
    currentCode.harnessSha256,
    capture.code.harnessSha256,
    "Consumer harness bytes changed during witness",
  );
  assert.equal(currentCode.requirementsSha256, capture.code.requirementsSha256);
  assert.equal(
    currentCode.packageManifestSha256,
    capture.code.packageManifestSha256,
  );
  const compiler = capture.compiler
    ? {
        output: completeInvocation(capture.compiler),
        commandSha256: nativeOuterCommandSha256(capture.compiler.command),
        argvSha256: hash(JSON.stringify(capture.compiler.command.args)),
        executableSha256: capture.tool.sha256,
        executableAfterSha256: compilerToolAfter.sha256,
        exitCode: capture.compiler.exitCode,
        signal: capture.compiler.signal,
        errorCode: capture.compiler.errorCode ?? null,
        timedOut: capture.compiler.timedOut,
        cancelled: capture.compiler.cancelled,
        truncated: capture.compiler.truncated,
        cleanupComplete: true,
      }
    : null;
  const compilerLink = capture.compilerLink
    ? {
        output: completeInvocation(capture.compilerLink),
        commandSha256: nativeOuterCommandSha256(capture.compilerLink.command),
        argvSha256: hash(JSON.stringify(capture.compilerLink.command.args)),
        executableSha256: capture.tool.sha256,
        executableAfterSha256: compilerToolAfter.sha256,
        exitCode: capture.compilerLink.exitCode,
        signal: capture.compilerLink.signal,
        errorCode: capture.compilerLink.errorCode ?? null,
        timedOut: capture.compilerLink.timedOut,
        cancelled: capture.compilerLink.cancelled,
        truncated: capture.compilerLink.truncated,
        cleanupComplete: true,
      }
    : null;
  if (
    [
      "rust",
      "c",
      "cpp",
      "java",
      "kotlin",
      "scala",
      "csharp",
      "fsharp",
      "vb",
      "swift",
    ].includes(capture.family)
  )
    assert.ok(
      compiler,
      "Compiled consumer witness requires its reached compiler invocation",
    );
  const row = {
    schemaVersion: 1,
    profile: "original-consumer-witness-observation-v1",
    witnessId: capture.witnessId,
    attempts: capture.attempts,
    family: capture.family,
    variant: capture.variant,
    phase: capture.phase,
    origin: consumerOrigin(capture.family),
    before: capture.before,
    after,
    tool: {
      name: path.basename(capture.tool.launch),
      bytes: capture.tool.bytes,
      sha256: capture.tool.sha256,
      afterSha256: compilerToolAfter.sha256,
    },
    invocation: {
      commandSha256: nativeOuterCommandSha256(result.command),
      executableSha256: capture.runtimeExecutable.sha256,
      executableAfterSha256: executableAfter.sha256,
      argvSha256: hash(JSON.stringify(result.command.args)),
      exitCode: result.exitCode,
      errorCode: result.errorCode ?? null,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
      cleanupComplete: true,
    },
    output,
    compiler,
    compilerLink,
    swift: capture.swift
      ? {
          inputs: capture.swift.inputs,
          inputsAfterSha256: hash(
            JSON.stringify(await observeConsumerWitnessSwiftInputs()),
          ),
          seed: capture.swift.seed,
          produced: capture.swift.produced,
          generated: capture.swift.generated,
          main: capture.swift.main,
        }
      : null,
    jvm: capture.jvm
      ? {
          inputs: capture.jvm.inputs,
          afterInputs: await observeConsumerWitnessJvmInputs(capture.family),
          generated: capture.jvm.generated,
        }
      : null,
    managed: capture.managed
      ? {
          inputs: capture.managed.inputs,
          inputsAfterSha256: hash(
            JSON.stringify(
              await observeConsumerWitnessManagedInputs(capture.family),
            ),
          ),
          seed: capture.managed.seed,
          generated: capture.managed.generated,
          runtimeConfig: capture.managed.runtimeConfig,
        }
      : null,
    nativeResult: { consumers, sources },
    code: {
      engineSha256: capture.code.engineSha256,
      harnessSha256: capture.code.harnessSha256,
      acceptanceSha256: capture.code.acceptanceSha256,
      requirementsSha256: capture.code.requirementsSha256,
      packageManifestSha256: capture.code.packageManifestSha256,
      installedOutsidePackage: capture.code.installedOutsidePackage,
    },
    runtime: {
      osRelease: os.release(),
      distributionSha256:
        process.platform === "linux"
          ? hash(await readFile("/etc/os-release"))
          : null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      imageLabelsAttested: false,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: (
        await bytesIdentity(process.execPath, 256 * 1048576)
      ).sha256,
    },
    nativeInvoked: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
  if (capture.swift) {
    const { inspectSwiftWitness } = await import(
      new URL("../../scripts/consumer-witness-swift.mjs", import.meta.url).href
    );
    inspectSwiftWitness(row);
  }
  const id =
    capture.family +
    "-" +
    capture.variant +
    "-" +
    capture.phase +
    "-" +
    capture.witnessId;
  try {
    await publishConsumerCapture(capture, row, id + ".json");
  } catch (error) {
    capture.storageFailure = String(error).slice(0, 1024);
    throw error;
  }
}

async function finishConsumerDataWitness(
  capture: ConsumerCapture,
  result: ProcessResult,
) {
  assert.ok(capture.data);
  assert.equal(capture.storageFailure, null);
  const {
    dataConsumerRoles,
    dataConsumerStages,
    dataConsumerClass,
    inspectDataWitness,
  } = await import(
    new URL("../../scripts/consumer-witness-data.mjs", import.meta.url).href
  );
  assert.deepEqual(
    capture.attempts.map((item) => item.stage),
    dataConsumerStages(capture.family),
  );
  const terminal = capture.resultRecords.get(result);
  assert.ok(terminal);
  assert.equal(
    terminal.reference.attemptId,
    capture.attempts.at(-1)?.attemptId,
    "Final data result is not the retained terminal attempt",
  );
  const output = completeInvocation(result),
    after = await snapshot(capture.root, capture.family);
  assert.deepEqual(after, capture.before);
  const selected = await bytesIdentity(capture.tool.launch, 256 * 1048576);
  assert.deepEqual(selected, {
    bytes: capture.tool.bytes,
    sha256: capture.tool.sha256,
  });
  const current = await codeMetadata(capture.family);
  for (const field of [
    "engineSha256",
    "harnessSha256",
    "acceptanceSha256",
    "requirementsSha256",
    "packageManifestSha256",
  ] as const)
    assert.equal(current[field], capture.code[field]);
  const native = capture.family === "yaml" ? JSON.parse(result.stdout) : null;
  const row = {
    schemaVersion: 1,
    profile: "native-data-consumer-witness-observation-v1",
    witnessId: capture.witnessId,
    attempts: capture.attempts,
    family: capture.family,
    variant: capture.variant,
    phase: capture.phase,
    origin: consumerOrigin(capture.family),
    before: capture.before,
    after,
    tool: {
      name: path.basename(capture.tool.launch),
      bytes: capture.tool.bytes,
      sha256: capture.tool.sha256,
      afterSha256: selected.sha256,
    },
    invocation: {
      commandSha256: nativeOuterCommandSha256(result.command),
      executableSha256: capture.runtimeExecutable.sha256,
      executableAfterSha256: selected.sha256,
      argvSha256: hash(JSON.stringify(result.command.args)),
      exitCode: result.exitCode,
      errorCode: result.errorCode ?? null,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
      cleanupComplete: true,
    },
    output,
    compiler: null,
    jvm: null,
    managed: null,
    data: {
      inputs: capture.data.inputs,
      inputsAfterSha256: hash(
        JSON.stringify(await observeConsumerWitnessDataInputs(capture.family)),
      ),
      evidenceClass: dataConsumerClass(capture.family),
      roles: dataConsumerRoles,
      results: capture.family === "hcl" ? capture.data.results : native.roles,
      plans: capture.family === "hcl" ? capture.data.plans : [],
      moduleMap:
        capture.family === "hcl" ? await consumerModuleMap(capture.root) : null,
      sourceBinding:
        capture.family === "hcl"
          ? "controller-filesystem-and-native-plan"
          : "native-data-source-byte-echo",
      fullImpactFallback: true,
      applicationSemanticsVerified: false,
    },
    code: {
      engineSha256: capture.code.engineSha256,
      harnessSha256: capture.code.harnessSha256,
      acceptanceSha256: capture.code.acceptanceSha256,
      requirementsSha256: capture.code.requirementsSha256,
      packageManifestSha256: capture.code.packageManifestSha256,
      installedOutsidePackage: capture.code.installedOutsidePackage,
    },
    runtime: {
      osRelease: os.release(),
      distributionSha256:
        process.platform === "linux"
          ? hash(await readFile("/etc/os-release"))
          : null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      imageLabelsAttested: false,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: (
        await bytesIdentity(process.execPath, 256 * 1048576)
      ).sha256,
    },
    nativeInvoked: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
  inspectDataWitness(row);
  try {
    await publishConsumerCapture(
      capture,
      row,
      [capture.family, capture.variant, capture.phase, capture.witnessId].join(
        "-",
      ) + ".json",
    );
  } catch (error) {
    capture.storageFailure = String(error).slice(0, 1024);
    throw error;
  }
}

/** Retain every actual report process before the original callback can assert an outcome. */
export async function finishConsumerProjectWitness(
  capture: ConsumerCapture | null,
  report: Report,
  scenario: string,
) {
  if (!capture) return;
  assert.ok(isProjectConsumer(capture.family));
  assert.equal(capture.storageFailure, null);
  const project = {
    scenario,
    ...(capture.family === "typescript" ? { sourceRoot: capture.root } : {}),
    evidenceClass: "controller-source-bound-native-project-reports",
    applicationSemanticsVerified: false,
    nativeModuleLoadsTraced: false,
    sourceBinding: "actual-controller-files-and-native-report",
    sourceFingerprint: report.sourceFingerprint,
    finalSourceFingerprint: report.finalSourceFingerprint,
    sourceChanged: report.sourceChanged,
    sourceError: report.sourceError,
    outcome: report.outcome,
    selectionMode: report.selection?.mode ?? null,
    checks: report.checks.map((check) => ({
      project: check.project,
      id: check.id,
      status: check.status,
      scope: check.scope,
      tests: check.tests ?? null,
    })),
  };
  const retained = [];
  let terminal: ProcessResult | null = null;
  for (const [index, check] of report.checks.entries())
    for (const result of check.processes) {
      const observed = await recordConsumerWitnessAttempt(
        capture,
        result,
        "consumer",
        {
          scenario,
          checkIndex: index,
          reportSha256: hash(JSON.stringify(project)),
        },
      );
      assert.ok(observed);
      retained.push(observed.value);
      terminal = result;
    }
  assert.ok(
    terminal,
    "Native project validation returned no physical process results",
  );
  const output = parseCapturedProcessOutput(terminal.capturedOutput);
  assert.equal(hash(terminal.stdout), output.stdout.sha256);
  assert.equal(hash(terminal.stderr), output.stderr.sha256);
  const after = await snapshot(capture.root, capture.family);
  assert.deepEqual(after, capture.before);
  const selected = await bytesIdentity(capture.tool.launch, 256 * 1048576);
  assert.deepEqual(selected, {
    bytes: capture.tool.bytes,
    sha256: capture.tool.sha256,
  });
  const current = await codeMetadata(capture.family);
  for (const field of [
    "engineSha256",
    "harnessSha256",
    "acceptanceSha256",
    "requirementsSha256",
    "packageManifestSha256",
  ] as const)
    assert.equal(current[field], capture.code[field]);
  const scope = JSON.parse(
    await readFile(
      path.join(current.harnessRoot, "docs/gate-a-profiles.v1.json"),
      "utf8",
    ),
  );
  const slots = scope.runtimeProfiles.filter(
    (value: { node: string; platform: string; architecture: string }) =>
      value.node === process.versions.node &&
      value.platform === process.platform &&
      value.architecture === process.arch,
  );
  assert.ok(slots.length <= 1);
  const selectedSlot =
    capture.family === "typescript"
      ? (slots[0]?.id ?? null)
      : process.env.CHECKTRAIL_CONSUMER_RUNTIME_SLOT || null;
  if (selectedSlot !== null)
    assert.equal(
      slots[0]?.id,
      selectedSlot,
      "Selected project runtime differs from actual process",
    );

  const row = {
    schemaVersion: 1,
    profile: "native-project-consumer-witness-observation-v1",
    witnessId: capture.witnessId,
    attempts: capture.attempts,
    family: capture.family,
    variant: capture.variant,
    phase: capture.phase,
    origin: consumerOrigin(capture.family),
    before: capture.before,
    after,
    tool: {
      name: path.basename(capture.tool.launch),
      bytes: capture.tool.bytes,
      sha256: capture.tool.sha256,
      afterSha256: selected.sha256,
    },
    invocation: {
      commandSha256: nativeOuterCommandSha256(terminal.command),
      executableSha256: capture.tool.sha256,
      executableAfterSha256: selected.sha256,
      argvSha256: hash(JSON.stringify(terminal.command.args)),
      exitCode: terminal.exitCode,
      errorCode: terminal.errorCode ?? null,
      signal: terminal.signal,
      timedOut: terminal.timedOut,
      cancelled: terminal.cancelled,
      truncated: terminal.truncated,
      cleanupComplete:
        terminal.errorCode === undefined &&
        (terminal.exitCode !== null || terminal.signal !== null),
    },
    output,
    compiler: null,
    compilerLink: null,
    jvm: null,
    managed: null,
    swift: null,
    project,
    code: {
      engineSha256: capture.code.engineSha256,
      harnessSha256: capture.code.harnessSha256,
      acceptanceSha256: capture.code.acceptanceSha256,
      requirementsSha256: capture.code.requirementsSha256,
      packageManifestSha256: capture.code.packageManifestSha256,
      installedOutsidePackage: capture.code.installedOutsidePackage,
    },
    runtime: {
      slot: selectedSlot,
      osRelease: os.release(),
      distributionSha256:
        process.platform === "linux"
          ? hash(await readFile("/etc/os-release"))
          : null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      imageLabelsAttested: false,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: (
        await bytesIdentity(process.execPath, 256 * 1048576)
      ).sha256,
    },
    nativeInvoked: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
  const { inspectProjectWitness } = await import(
    new URL("../../scripts/consumer-witness-project.mjs", import.meta.url).href
  );
  inspectProjectWitness(row, retained);
  try {
    await publishConsumerCapture(
      capture,
      row,
      [capture.family, capture.variant, capture.phase, capture.witnessId].join(
        "-",
      ) + ".json",
    );
  } catch (error) {
    capture.storageFailure = String(error).slice(0, 1024);
    throw error;
  }
}
