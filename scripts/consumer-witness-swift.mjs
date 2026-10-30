import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectJvmDirectory } from "./consumer-witness-jvm.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function inspectSwiftInputs(value) {
  assert.equal(value?.profile, "consumer-swift-inputs-v1");
  assert.equal(value.scope, "observed-driver-and-frontend");
  assert.equal(value.otherDependenciesAttested, false);
  for (const input of [value.driver, value.frontend])
    assert.ok(
      input &&
        Number.isSafeInteger(input.bytes) &&
        input.bytes > 0 &&
        input.bytes <= 268435456 &&
        sha(input.sha256),
    );
}
const member = (directory, name) => {
  const value = directory.files.find((file) => file.path === name);
  assert.ok(value, "Required produced Swift artifact is missing: " + name);
  return value;
};
export function swiftCommandBindings(args, root, env = {}) {
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? null : (args[index + 1] ?? null);
  };
  const file = (arg) =>
    arg === null
      ? null
      : {
          directorySha256: hash(path.resolve(root, path.dirname(arg))),
          file: path.basename(arg),
        };
  return {
    output: file(value("-o")),
    module: file(value("-emit-module-path")),
    imports:
      value("-I") === null ? null : hash(path.resolve(root, value("-I"))),
    libraries:
      value("-L") === null ? null : hash(path.resolve(root, value("-L"))),
    policyLibrary: args.includes("-lPolicy"),
    runtimeLibraryPath:
      typeof env.LD_LIBRARY_PATH === "string"
        ? hash(path.resolve(root, env.LD_LIBRARY_PATH))
        : null,
    sources: args
      .filter((arg) => arg.endsWith(".swift"))
      .map((arg) =>
        path.relative(root, path.resolve(root, arg)).split(path.sep).join("/"),
      ),
  };
}
export function inspectSwiftAttempt(value) {
  if (value.family !== "swift") {
    assert.ok(value.swift === undefined || value.swift === null);
    return;
  }
  const body = value.swift;
  assert.ok(body);
  inspectSwiftInputs(body.inputsBefore);
  assert.ok(body.inputsAfterSha256 === null || sha(body.inputsAfterSha256));
  if (body.generatedBefore !== null)
    inspectJvmDirectory(body.generatedBefore, true);
  if (body.generatedAfter !== null)
    inspectJvmDirectory(body.generatedAfter, true);
  if (body.main !== null)
    assert.ok(
      body.main &&
        Number.isSafeInteger(body.main.bytes) &&
        body.main.bytes > 0 &&
        body.main.bytes <= 1048576 &&
        sha(body.main.sha256),
    );
  assert.ok(body.command);
}
export function requireSwiftAttemptBinding(row, value) {
  if (row.family !== "swift") return;
  const body = value.swift,
    swift = row.swift;
  assert.deepEqual(body.inputsBefore, swift.inputs);
  assert.equal(
    body.inputsAfterSha256,
    hash(JSON.stringify(swift.inputs)),
    "Observed Swift compiler inputs changed during command",
  );
  const directory = swift.generated.directorySha256;
  if (value.stage === "compiler") {
    assert.deepEqual(body.generatedBefore, swift.seed);
    assert.deepEqual(body.generatedAfter, swift.produced);
    assert.equal(body.main, null);
    assert.deepEqual(body.command.sources, ["src/policy/Policy.swift"]);
    assert.deepEqual(body.command.output, {
      directorySha256: directory,
      file: "libPolicy.so",
    });
    assert.deepEqual(body.command.module, {
      directorySha256: directory,
      file: "Policy.swiftmodule",
    });
    assert.equal(body.command.imports, null);
    assert.equal(body.command.libraries, null);
    assert.equal(body.command.policyLibrary, false);
    assert.equal(body.command.runtimeLibraryPath, null);
  } else if (value.stage === "compiler-link") {
    assert.deepEqual(body.generatedBefore, swift.produced);
    assert.deepEqual(body.generatedAfter, swift.generated);
    assert.deepEqual(body.main, swift.main);
    assert.deepEqual(body.command.sources, [
      "src/consumer/Consumer.swift",
      "main.swift",
    ]);
    assert.deepEqual(body.command.output, {
      directorySha256: directory,
      file: "Witness",
    });
    assert.equal(body.command.module, null);
    assert.equal(body.command.imports, directory);
    assert.equal(body.command.libraries, directory);
    assert.equal(body.command.policyLibrary, true);
    assert.equal(body.command.runtimeLibraryPath, null);
  } else {
    assert.equal(value.stage, "consumer");
    assert.deepEqual(body.main, swift.main);
    assert.deepEqual(body.generatedBefore, swift.generated);
    assert.deepEqual(
      body.generatedAfter,
      swift.generated,
      "Produced Swift library/module/executable changed during consumer",
    );
    assert.equal(body.command.runtimeLibraryPath, directory);
    assert.deepEqual(body.command.sources, []);
    assert.equal(body.command.output, null);
    assert.equal(body.command.module, null);
    assert.equal(body.command.imports, null);
    assert.equal(body.command.libraries, null);
    assert.equal(body.command.policyLibrary, false);
  }
}
export function inspectSwiftWitness(row) {
  const value = row.swift;
  assert.ok(value);
  inspectSwiftInputs(value.inputs);
  assert.equal(value.inputsAfterSha256, hash(JSON.stringify(value.inputs)));
  assert.equal(value.inputs.driver.sha256, row.tool.sha256);
  for (const key of ["seed", "produced", "generated"])
    inspectJvmDirectory(value[key], key === "seed");
  assert.equal(
    value.seed.files.length,
    0,
    "Swift output directory was not empty before producer",
  );
  assert.equal(value.seed.directorySha256, value.produced.directorySha256);
  assert.equal(value.produced.directorySha256, value.generated.directorySha256);
  member(value.produced, "libPolicy.so");
  member(value.produced, "Policy.swiftmodule");
  assert.equal(
    value.produced.files.some((file) => file.path === "Witness"),
    false,
  );
  for (const file of value.produced.files)
    assert.deepEqual(
      member(value.generated, file.path),
      file,
      "Produced Swift module/library changed during link",
    );
  const executable = member(value.generated, "Witness");
  assert.equal(executable.sha256, row.invocation.executableSha256);
  assert.ok(
    value.main &&
      Number.isSafeInteger(value.main.bytes) &&
      value.main.bytes > 0 &&
      value.main.bytes <= 1048576 &&
      sha(value.main.sha256),
  );
  const linked = row.compilerLink;
  assert.ok(linked, "Swift consumer link compiler was not retained");
  assert.equal(linked.executableSha256, row.tool.sha256);
  assert.equal(linked.executableAfterSha256, row.tool.sha256);
  for (const field of ["commandSha256", "argvSha256"])
    assert.ok(sha(linked[field]));
  assert.equal(linked.exitCode, 0);
  assert.equal(linked.signal, null);
  assert.equal(linked.errorCode, null);
  assert.equal(linked.timedOut, false);
  assert.equal(linked.cancelled, false);
  assert.equal(linked.truncated, false);
  assert.equal(linked.cleanupComplete, true);
}
