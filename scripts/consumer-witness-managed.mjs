import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectJvmDirectory } from "./consumer-witness-jvm.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const managedConsumerFamilies = Object.freeze([
  "csharp",
  "fsharp",
  "vb",
]);
export const managedCompilerName = (family) =>
  ({ csharp: "csc", fsharp: "fsc", vb: "vbc" })[family];
const identity = (value) =>
  assert.ok(
    value &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= 134217728 &&
      sha(value.sha256),
  );
export function inspectManagedInputs(value, family) {
  assert.equal(value?.profile, "consumer-managed-inputs-v1");
  assert.equal(value.family, family);
  assert.ok(managedConsumerFamilies.includes(family));
  identity(value.dotnet);
  assert.deepEqual(
    value.runtimeVersions,
    ["10.0.12"],
    "Additional managed runtime versions make roll-forward selection unqualified",
  );
  assert.deepEqual(
    value.hostFxrVersions,
    ["10.0.12"],
    "Managed hostfxr selection is not the frozen version",
  );
  for (const field of ["compilerDirectory", "references", "runtime", "hostFxr"])
    inspectJvmDirectory(value[field]);
  for (const name of [".dll", ".deps.json", ".runtimeconfig.json"].map(
    (suffix) => managedCompilerName(family) + suffix,
  ))
    assert.ok(
      value.compilerDirectory.files.some((file) => file.path === name),
      "Selected managed compiler input is missing",
    );
  assert.ok(
    value.references.files.every(
      (file) => file.path.endsWith(".dll") && !file.path.includes("/"),
    ),
  );
  for (const name of ["System.Runtime.dll", "System.Console.dll"])
    assert.ok(value.references.files.some((file) => file.path === name));
  for (const name of [
    "System.Private.CoreLib.dll",
    "libcoreclr.so",
    "libclrjit.so",
  ])
    assert.ok(
      value.runtime.files.some((file) => file.path === name),
      "Selected managed runtime payload is missing",
    );
  assert.ok(
    value.hostFxr.files.some((file) => file.path === "10.0.12/libhostfxr.so"),
  );
  if (family === "fsharp") {
    identity(value.fsharpCore);
    const original = value.compilerDirectory.files.find(
      (file) => file.path === "FSharp.Core.dll",
    );
    assert.ok(original);
    assert.deepEqual(value.fsharpCore, {
      bytes: original.bytes,
      sha256: original.sha256,
    });
  } else assert.equal(value.fsharpCore, null);
  return value;
}
export function managedCommandBindings(args, root) {
  const describe = (filename) => {
    const resolved = path.posix.resolve(root, filename);
    return {
      directorySha256: hash(path.posix.dirname(resolved)),
      file: path.posix.basename(resolved),
    };
  };
  const compiler = args[0] === "exec" ? args[1] : args[0];
  const output = args.filter(
    (argument) =>
      argument.startsWith("-out:") ||
      argument.startsWith("--out:") ||
      argument.startsWith("/out:"),
  );
  const references = [];
  for (const argument of args) {
    const reference = [
      "-r:",
      "/r:",
      "-reference:",
      "/reference:",
      "--reference:",
    ].find((prefix) => argument.startsWith(prefix));
    const vb = ["-vbruntime:", "/vbruntime:"].find((prefix) =>
      argument.startsWith(prefix),
    );
    if (reference || vb)
      references.push({
        kind: vb ? "runtime-reference" : "reference",
        ...describe(argument.slice((reference ?? vb).length)),
      });
  }
  return {
    entry: compiler ? describe(compiler) : null,
    output:
      output.length === 1
        ? describe(output[0].slice(output[0].indexOf(":") + 1))
        : null,
    references,
  };
}
export function inspectManagedAttempt(value) {
  if (!managedConsumerFamilies.includes(value.family)) {
    assert.ok(value.managed === undefined || value.managed === null);
    return;
  }
  const row = value.managed;
  assert.ok(row);
  inspectManagedInputs(row.inputsBefore, value.family);
  assert.ok(row.inputsAfterSha256 === null || sha(row.inputsAfterSha256));
  for (const field of ["generatedBefore", "generatedAfter"])
    if (row[field] !== null) inspectJvmDirectory(row[field], true);
  assert.ok(
    row.command &&
      Array.isArray(row.command.references) &&
      row.command.references.length <= 256,
  );
  for (const entry of [
    row.command.entry,
    row.command.output,
    ...row.command.references,
  ].filter(Boolean)) {
    assert.ok(sha(entry.directorySha256));
    assert.ok(
      typeof entry.file === "string" &&
        entry.file.length <= 512 &&
        !/[\\/\0:]/.test(entry.file),
    );
  }
}
export function inspectManagedSeed(row) {
  inspectJvmDirectory(row.seed);
  const names = row.seed.files.map((file) => file.path);
  assert.deepEqual(
    names,
    row.inputs.family === "fsharp"
      ? ["FSharp.Core.dll", "Witness.runtimeconfig.json"]
      : ["Witness.runtimeconfig.json"],
  );
  const config = row.runtimeConfig;
  assert.ok(
    typeof config.text === "string" && Buffer.byteLength(config.text) <= 8192,
  );
  assert.equal(config.bytes, Buffer.byteLength(config.text));
  assert.equal(config.sha256, hash(config.text));
  assert.deepEqual(JSON.parse(config.text), {
    runtimeOptions: {
      tfm: "net10.0",
      framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
    },
  });
  const configFile = row.seed.files.find(
    (file) => file.path === "Witness.runtimeconfig.json",
  );
  assert.equal(configFile.sha256, config.sha256);
  assert.equal(
    configFile.bytes,
    config.bytes,
    "Managed runtime configuration byte count differs",
  );
  if (row.inputs.family === "fsharp") {
    const core = row.seed.files.find((file) => file.path === "FSharp.Core.dll");
    assert.deepEqual(
      { bytes: core.bytes, sha256: core.sha256 },
      row.inputs.fsharpCore,
    );
  }
}
export function requireManagedAttemptBinding(witness, value) {
  if (!managedConsumerFamilies.includes(witness.family)) return;
  const row = value.managed,
    expected = witness.managed,
    compiler = managedCompilerName(witness.family);
  assert.deepEqual(row.inputsBefore, expected.inputs);
  assert.equal(
    row.inputsAfterSha256,
    hash(JSON.stringify(expected.inputs)),
    "Managed SDK/runtime dependency bytes changed",
  );
  assert.deepEqual(
    row.generatedAfter,
    expected.generated,
    "Produced managed artifacts changed",
  );
  if (value.stage === "compiler") {
    assert.deepEqual(row.generatedBefore, expected.seed);
    assert.deepEqual(row.command.entry, {
      directorySha256: expected.inputs.compilerDirectory.directorySha256,
      file: compiler + ".dll",
    });
    assert.deepEqual(row.command.output, {
      directorySha256: expected.generated.directorySha256,
      file: "Witness.dll",
    });
    const references = expected.inputs.references.files.map((file) => ({
      kind: "reference",
      directorySha256: expected.inputs.references.directorySha256,
      file: file.path,
    }));
    if (witness.family === "vb")
      references.unshift({
        kind: "runtime-reference",
        directorySha256: expected.inputs.references.directorySha256,
        file: "Microsoft.VisualBasic.Core.dll",
      });
    if (witness.family === "fsharp")
      references.push({
        kind: "reference",
        directorySha256: expected.inputs.compilerDirectory.directorySha256,
        file: "FSharp.Core.dll",
      });
    assert.deepEqual(
      row.command.references,
      references,
      "Actual managed compiler references include missing or unobserved DLLs",
    );
  } else {
    assert.deepEqual(row.generatedBefore, expected.generated);
    assert.deepEqual(row.command.entry, {
      directorySha256: expected.generated.directorySha256,
      file: "Witness.dll",
    });
    assert.equal(row.command.output, null);
    assert.deepEqual(row.command.references, []);
  }
}
export function inspectManagedWitness(row) {
  const value = row.managed;
  assert.ok(value);
  inspectManagedInputs(value.inputs, row.family);
  inspectManagedSeed(value);
  inspectJvmDirectory(value.generated);
  assert.equal(value.inputsAfterSha256, hash(JSON.stringify(value.inputs)));
  assert.equal(value.seed.directorySha256, value.generated.directorySha256);
  assert.ok(value.generated.files.some((file) => file.path === "Witness.dll"));
  for (const seed of value.seed.files)
    assert.deepEqual(
      value.generated.files.find((file) => file.path === seed.path),
      seed,
      "Managed runtime configuration or copied dependency changed",
    );
  assert.equal(row.tool.sha256, value.inputs.dotnet.sha256);
  assert.equal(row.invocation.executableSha256, value.inputs.dotnet.sha256);
}
