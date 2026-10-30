import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import {
  observeConsumerWitnessDirectory,
  observeConsumerWitnessManagedSeed,
} from "./consumer-witness-fixture.js";
const {
  inspectManagedInputs,
  inspectManagedAttempt,
  requireManagedAttemptBinding,
  inspectManagedWitness,
  managedCommandBindings,
} = await import(
  new URL("../../scripts/consumer-witness-managed.mjs", import.meta.url).href
);
const { consumerWitnessSourceSha256 } = await import(
  new URL("../../scripts/consumer-witness-attempts.mjs", import.meta.url).href
);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sha = (value: string) => value.repeat(64);
type Family = "csharp" | "fsharp" | "vb";
const compiler = (family: Family) =>
  ({ csharp: "csc", fsharp: "fsc", vb: "vbc" })[family];
const directory = (names: string[], id: string) => {
  const files = names
    .sort()
    .map((path) => ({ path, bytes: 32, sha256: sha("a") }));
  return {
    profile: "bounded-consumer-directory-v1",
    directorySha256: sha(id),
    files,
    bytes: files.length * 32,
    manifestSha256: hash(JSON.stringify(files)),
  };
};
const config = JSON.stringify({
  runtimeOptions: {
    tfm: "net10.0",
    framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
  },
});
/** Every object in this factory is synthetic; no compiler/runtime was invoked. */
function sample(family: Family) {
  const inputs = {
    profile: "consumer-managed-inputs-v1",
    family,
    dotnet: { bytes: 32, sha256: sha("2") },
    runtimeVersions: ["10.0.12"],
    hostFxrVersions: ["10.0.12"],
    compilerDirectory: directory(
      [
        compiler(family) + ".dll",
        compiler(family) + ".deps.json",
        compiler(family) + ".runtimeconfig.json",
        ...(family === "fsharp" ? ["FSharp.Core.dll"] : []),
      ],
      "c",
    ),
    references: directory(
      [
        "Microsoft.VisualBasic.Core.dll",
        "System.Runtime.dll",
        "System.Console.dll",
      ],
      "b",
    ),
    runtime: directory(
      ["System.Private.CoreLib.dll", "libcoreclr.so", "libclrjit.so"],
      "a",
    ),
    hostFxr: directory(["10.0.12/libhostfxr.so"], "f"),
    fsharpCore: family === "fsharp" ? { bytes: 32, sha256: sha("a") } : null,
  };
  const seed = directory(
    [
      "Witness.runtimeconfig.json",
      ...(family === "fsharp" ? ["FSharp.Core.dll"] : []),
    ],
    "d",
  );
  const runtimeConfig = seed.files.find(
    (file) => file.path === "Witness.runtimeconfig.json",
  )!;
  runtimeConfig.bytes = Buffer.byteLength(config);
  runtimeConfig.sha256 = hash(config);
  seed.bytes = seed.files.reduce((n, file) => n + file.bytes, 0);
  seed.manifestSha256 = hash(JSON.stringify(seed.files));
  const generated = structuredClone(seed);
  generated.files.push({ path: "Witness.dll", bytes: 64, sha256: sha("e") });
  generated.files.sort((a, b) => a.path.localeCompare(b.path));
  generated.bytes += 64;
  generated.manifestSha256 = hash(JSON.stringify(generated.files));
  const managed = {
    inputs,
    inputsAfterSha256: hash(JSON.stringify(inputs)),
    seed,
    generated,
    runtimeConfig: {
      text: config,
      bytes: Buffer.byteLength(config),
      sha256: hash(config),
    },
  };
  const row = {
    family,
    tool: { sha256: sha("2") },
    invocation: { executableSha256: sha("2") },
    managed,
  };
  const references = inputs.references.files.map((file) => ({
    kind: "reference",
    directorySha256: inputs.references.directorySha256,
    file: file.path,
  }));
  if (family === "vb")
    references.unshift({
      kind: "runtime-reference",
      directorySha256: inputs.references.directorySha256,
      file: "Microsoft.VisualBasic.Core.dll",
    });
  if (family === "fsharp")
    references.push({
      kind: "reference",
      directorySha256: inputs.compilerDirectory.directorySha256,
      file: "FSharp.Core.dll",
    });
  const compile = {
    family,
    stage: "compiler",
    managed: {
      inputsBefore: structuredClone(inputs),
      inputsAfterSha256: managed.inputsAfterSha256,
      generatedBefore: structuredClone(seed),
      generatedAfter: structuredClone(generated),
      command: {
        entry: {
          directorySha256: inputs.compilerDirectory.directorySha256,
          file: compiler(family) + ".dll",
        },
        output: {
          directorySha256: generated.directorySha256,
          file: "Witness.dll",
        },
        references,
      },
    },
  };
  const runtime = {
    family,
    stage: "consumer",
    managed: {
      inputsBefore: structuredClone(inputs),
      inputsAfterSha256: managed.inputsAfterSha256,
      generatedBefore: structuredClone(generated),
      generatedAfter: structuredClone(generated),
      command: {
        entry: {
          directorySha256: generated.directorySha256,
          file: "Witness.dll",
        },
        output: null,
        references: [] as typeof references,
      },
    },
  };
  return { row, compile, runtime };
}
test("synthetic managed witnesses require observed SDK runtime references seeded configuration and copied FSharp dependency", () => {
  for (const family of ["csharp", "fsharp", "vb"] as const) {
    const { row, compile, runtime } = sample(family);
    inspectManagedWitness(row);
    inspectManagedAttempt(compile);
    inspectManagedAttempt(runtime);
    requireManagedAttemptBinding(row, compile);
    requireManagedAttemptBinding(row, runtime);
    const extraRuntime = structuredClone(row.managed.inputs);
    extraRuntime.runtimeVersions.push("10.0.13");
    assert.throws(
      () => inspectManagedInputs(extraRuntime, family),
      /roll-forward/,
    );
    const extraHost = structuredClone(row.managed.inputs);
    extraHost.hostFxrVersions.push("10.0.13");
    assert.throws(() => inspectManagedInputs(extraHost, family), /hostfxr/);
    const wrongConfigBytes = structuredClone(row);
    wrongConfigBytes.managed.seed.files.find(
      (file) => file.path === "Witness.runtimeconfig.json",
    )!.bytes++;
    wrongConfigBytes.managed.seed.bytes++;
    wrongConfigBytes.managed.seed.manifestSha256 = hash(
      JSON.stringify(wrongConfigBytes.managed.seed.files),
    );
    wrongConfigBytes.managed.generated.files.find(
      (file) => file.path === "Witness.runtimeconfig.json",
    )!.bytes++;
    wrongConfigBytes.managed.generated.bytes++;
    wrongConfigBytes.managed.generated.manifestSha256 = hash(
      JSON.stringify(wrongConfigBytes.managed.generated.files),
    );
    assert.throws(
      () => inspectManagedWitness(wrongConfigBytes),
      /configuration byte count differs/,
    );
    const absent = structuredClone(row.managed.inputs);
    absent.hostFxr.files = [];
    absent.hostFxr.bytes = 0;
    absent.hostFxr.manifestSha256 = hash("[]");
    assert.throws(() => inspectManagedInputs(absent, family));
    const missingRef = structuredClone(compile);
    missingRef.managed.command.references.pop();
    assert.throws(
      () => requireManagedAttemptBinding(row, missingRef),
      /references include/,
    );
    const foreign = structuredClone(compile);
    foreign.managed.command.references[0]!.directorySha256 = sha("f");
    assert.throws(
      () => requireManagedAttemptBinding(row, foreign),
      /references include/,
    );
    const changed = structuredClone(runtime);
    changed.managed.inputsAfterSha256 = sha("f");
    assert.throws(
      () => requireManagedAttemptBinding(row, changed),
      /dependency bytes changed/,
    );
    const changedDll = structuredClone(runtime);
    changedDll.managed.generatedAfter.files.find(
      (file) => file.path === "Witness.dll",
    )!.sha256 = sha("f");
    assert.throws(
      () => requireManagedAttemptBinding(row, changedDll),
      /artifacts changed/,
    );
    const oldOutput = structuredClone(row);
    oldOutput.managed.seed.files.push({
      path: "Witness.dll",
      bytes: 64,
      sha256: sha("e"),
    });
    oldOutput.managed.seed.bytes += 64;
    oldOutput.managed.seed.files.sort((a, b) => a.path.localeCompare(b.path));
    oldOutput.managed.seed.manifestSha256 = hash(
      JSON.stringify(oldOutput.managed.seed.files),
    );
    assert.throws(() => inspectManagedWitness(oldOutput));
    const changedConfig = structuredClone(row);
    changedConfig.managed.runtimeConfig.text = config.replace(
      "10.0.12",
      "10.0.13",
    );
    changedConfig.managed.runtimeConfig.bytes = Buffer.byteLength(
      changedConfig.managed.runtimeConfig.text,
    );
    changedConfig.managed.runtimeConfig.sha256 = hash(
      changedConfig.managed.runtimeConfig.text,
    );
    assert.throws(() => inspectManagedWitness(changedConfig));
    if (family === "fsharp") {
      const wrongCore = structuredClone(row);
      wrongCore.managed.seed.files.find(
        (file) => file.path === "FSharp.Core.dll",
      )!.sha256 = sha("f");
      wrongCore.managed.seed.manifestSha256 = hash(
        JSON.stringify(wrongCore.managed.seed.files),
      );
      wrongCore.managed.generated.files.find(
        (file) => file.path === "FSharp.Core.dll",
      )!.sha256 = sha("f");
      wrongCore.managed.generated.manifestSha256 = hash(
        JSON.stringify(wrongCore.managed.generated.files),
      );
      assert.throws(() => inspectManagedWitness(wrongCore));
    }
  }
});
test("managed actual command observation retains selected compiler output and all reference spellings without adjacent flag matches", () => {
  const args = [
    "exec",
    "/sdk/Roslyn/bincore/csc.dll",
    "-out:/original/out/Witness.dll",
    "-r:/refs/System.Runtime.dll",
    "/reference:/refs/System.Console.dll",
    "--reference:/sdk/FSharp.Core.dll",
    "-vbruntime:/refs/Microsoft.VisualBasic.Core.dll",
    "-r-adjacent:/foreign.dll",
  ];
  const value = managedCommandBindings(args, "/original");
  assert.deepEqual(value.entry, {
    directorySha256: hash("/sdk/Roslyn/bincore"),
    file: "csc.dll",
  });
  assert.deepEqual(value.output, {
    directorySha256: hash("/original/out"),
    file: "Witness.dll",
  });
  assert.deepEqual(value.references, [
    {
      kind: "reference",
      directorySha256: hash("/refs"),
      file: "System.Runtime.dll",
    },
    {
      kind: "reference",
      directorySha256: hash("/refs"),
      file: "System.Console.dll",
    },
    {
      kind: "reference",
      directorySha256: hash("/sdk"),
      file: "FSharp.Core.dll",
    },
    {
      kind: "runtime-reference",
      directorySha256: hash("/refs"),
      file: "Microsoft.VisualBasic.Core.dll",
    },
  ]);
  assert.equal(
    managedCommandBindings(
      ["/sdk/fsc.dll", "--out:/out/Witness.dll", "--out:/foreign/Witness.dll"],
      "/original",
    ).output,
    null,
  );
});
test("managed seeded output observation retains configuration and copied library bytes while reference inventory ignores unrelated files", async (t) => {
  const root = await realpath(
    await fixture(t, {
      "Witness.runtimeconfig.json": config,
      "FSharp.Core.dll": "Original synthetic copied core",
    }),
  );
  const observed = await observeConsumerWitnessManagedSeed(root);
  assert.equal(observed.runtimeConfig.text, config);
  assert.deepEqual(
    observed.seed.files.map((file) => file.path),
    ["FSharp.Core.dll", "Witness.runtimeconfig.json"],
  );
  assert.equal(
    observed.seed.files[0]!.sha256,
    hash("Original synthetic copied core"),
  );
  const refs = await realpath(
    await fixture(t, {
      "A.dll": "Original A",
      "B.dll": "Original B",
      "Notes.xml": "Not a reference",
      "nested/Ignored.dll": "Not selected recursively",
    }),
  );
  assert.deepEqual(
    (await observeConsumerWitnessDirectory(refs, "dlls")).files.map(
      (file) => file.path,
    ),
    ["A.dll", "B.dll"],
  );
  await writeFile(
    path.join(root, "Witness.runtimeconfig.json"),
    "x".repeat(8193),
  );
  await assert.rejects(() => observeConsumerWitnessManagedSeed(root));
});

test("native source echo decoding covers every prepared and managed collector format with exact byte counts", () => {
  const bytes = [...Buffer.from("Original synthetic producer/caller source")];
  const expected = hash("Original synthetic producer/caller source");
  for (const family of [
    "rust",
    "ruby",
    "c",
    "cpp",
    "java",
    "kotlin",
    "scala",
    "csharp",
    "fsharp",
    "vb",
  ]) {
    assert.equal(
      consumerWitnessSourceSha256(family, bytes, bytes.length),
      expected,
    );
    assert.throws(
      () => consumerWitnessSourceSha256(family, bytes, bytes.length + 1),
      /byte count differs/,
    );
    assert.throws(() =>
      consumerWitnessSourceSha256(family, [...bytes, 256], bytes.length + 1),
    );
    assert.throws(() =>
      consumerWitnessSourceSha256(family, expected, bytes.length),
    );
  }
  for (const family of ["go", "python", "php"]) {
    assert.equal(
      consumerWitnessSourceSha256(family, expected, bytes.length),
      expected,
    );
    assert.throws(() =>
      consumerWitnessSourceSha256(family, bytes, bytes.length),
    );
  }
  assert.throws(() =>
    consumerWitnessSourceSha256("unobserved", expected, bytes.length),
  );
});
