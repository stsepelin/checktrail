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
import type { ProcessResult } from "../src/types.js";
import { nativeOuterCommandSha256 } from "../src/native-journal-engine.js";
export type ConsumerVariant = "broken" | "fixed" | "near-miss";
export type ConsumerPhase =
  "canonical" | "caller-change" | "restored" | "repeat";
export type ConsumerFamily = "go" | "python" | "php" | "rust" | "ruby";
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const filesByFamily = {
  go: ["policy/policy.go", "consumer/consumer.go"],
  python: ["pkg/policy.py", "pkg/consumer.py"],
  php: ["policy/policy.php", "consumer/consumer.php"],
  rust: ["src/policy.rs", "src/consumer.rs", "src/lib.rs"],
  ruby: ["src/policy/Policy.rb", "src/consumer/Consumer.rb"],
} as const;
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
async function privateDirectory(filename: string, root: string) {
  assert.ok(path.isAbsolute(filename));
  assert.equal(await realpath(filename), filename);
  const stat = await lstat(filename);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o700,
    "Witness capture requires existing private operator storage",
  );
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
    process.platform !== "win32",
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
    fileURLToPath(
      new URL("gate-context-" + family + ".test.js", import.meta.url),
    ),
    path.join(harnessRoot, "scripts/required-native-tests.json"),
    path.join(harnessRoot, "scripts/compiled-engine-evidence.mjs"),
    path.join(harnessRoot, "scripts/consumer-witness-attempts.mjs"),
  ];
  const identities = await Promise.all(
    inputs.map((filename) => bytesIdentity(filename)),
  );
  const requirements = JSON.parse(await readFile(inputs[2]!, "utf8"))[
    "context-" + family
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
    { go: "go", python: "python3", php: "php", rust: "rustc", ruby: "ruby" }[
      family
    ],
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
    { go: "go", python: "python3", php: "php", rust: "rustc", ruby: "ruby" }[
      family
    ],
  );
  return {
    root: canonical,
    destination,
    storageIdentity,
    witnessId: randomUUID(),
    storageFailure: null as string | null,
    attempts: [] as {
      stage: "compiler" | "consumer";
      attemptId: string;
      file: string;
      bytes: number;
      sha256: string;
    }[],
    resultRecords: new WeakMap<
      ProcessResult,
      {
        stage: "compiler" | "consumer";
        reference: {
          stage: "compiler" | "consumer";
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
    runtimeExecutable: selected,
    compiler: null as ProcessResult | null,
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
) {
  if (capture) capture.compiler = result;
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
  assert.ok(bytes.length <= 262144, "Consumer capture byte bound exceeded");
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
  stage: "compiler" | "consumer" = "consumer",
) {
  if (!capture) return null;
  const previous = capture.resultRecords.get(result);
  if (previous) {
    assert.equal(previous.stage, stage);
    return previous;
  }
  assert.ok(stage === "consumer" || capture.family === "rust");
  try {
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
    const executable =
      stage === "compiler" ? capture.tool : capture.runtimeExecutable;
    try {
      after = await snapshot(capture.root, capture.family);
      executableAfterSha256 = (
        await bytesIdentity(executable.launch, 256 * 1048576)
      ).sha256;
    } catch (error) {
      identityError ??= String(error).slice(0, 1024);
    }
    const value = {
      schemaVersion: 1,
      profile: "consumer-process-result-observation-v1",
      attemptId: randomUUID(),
      witnessId: capture.witnessId,
      family: capture.family,
      variant: capture.variant,
      origin:
        process.env[
          "CHECKTRAIL_CONTEXT_" + capture.family.toUpperCase() + "_INSTALLED"
        ] === "1"
          ? "installed"
          : "source",
      phase: capture.phase,
      stage,
      before: capture.before,
      after,
      commandSha256: nativeOuterCommandSha256(result.command),
      argvSha256: hash(JSON.stringify(result.command.args)),
      executableSha256: executable.sha256,
      executableAfterSha256,
      identityError,
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
  assert.equal(
    capture.storageFailure,
    null,
    "Earlier consumer capture storage failure leaves the witness incomplete",
  );
  await recordConsumerWitnessAttempt(capture, result);
  assert.deepEqual(
    capture.attempts.map((item) => item.stage),
    capture.family === "rust" ? ["compiler", "consumer"] : ["consumer"],
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
      : capture.family === "ruby"
        ? capture.variant === "broken"
          ? [true, true, true]
          : capture.variant === "near-miss"
            ? [false, false, false]
            : [false, true, false]
        : capture.variant === "broken"
          ? [true, true]
          : capture.family === "rust" && capture.variant === "near-miss"
            ? [false, false]
            : [false, true];
  assert.deepEqual(consumers, expected);
  const sources: Record<string, string> = {};
  for (const file of capture.before) {
    const raw =
      native.sources[
        capture.family === "python" ? path.basename(file.path) : file.path
      ];
    const observed: string =
      capture.family === "rust" || capture.family === "ruby"
        ? hash(Buffer.from(raw))
        : raw;
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
  if (capture.family === "rust")
    assert.ok(
      compiler,
      "Compiled Rust witness requires its reached compiler invocation",
    );
  const row = {
    schemaVersion: 1,
    profile: "original-consumer-witness-observation-v1",
    witnessId: capture.witnessId,
    attempts: capture.attempts,
    family: capture.family,
    variant: capture.variant,
    phase: capture.phase,
    origin:
      process.env[
        "CHECKTRAIL_CONTEXT_" + capture.family.toUpperCase() + "_INSTALLED"
      ] === "1"
        ? "installed"
        : "source",
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
