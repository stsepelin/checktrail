import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { fixture } from "./helpers.js";
import { fileURLToPath } from "node:url";

test("formatter preparation publishes all verified synthetic payloads with cross-user permissions despite a private umask", async (t) => {
  const payloads = [
    "FSharp.Core.dll",
    "Fantomas.Core.dll",
    "Fantomas.FCS.dll",
  ].map((file) => ({
    file,
    bytes: Buffer.from("Original synthetic " + file + "\n"),
  }));
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const item of payloads) {
    const name = Buffer.from("tools/net10.0/any/" + item.file),
      header = Buffer.alloc(30),
      entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(item.bytes.length, 18);
    header.writeUInt32LE(item.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt32LE(item.bytes.length, 20);
    entry.writeUInt32LE(item.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, item.bytes);
    central.push(entry, name);
    offset += header.length + name.length + item.bytes.length;
  }
  const end = Buffer.alloc(22),
    directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(payloads.length, 8);
  end.writeUInt16LE(payloads.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...local, directory, end]),
    hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"),
    source = await readFile(
      new URL("../../scripts/prepare-fsharp-format-tools.mjs", import.meta.url),
      "utf8",
    ),
    root = await fixture(t, { "package.json": '{"type":"module"}' });
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "dist/src"), { recursive: true });
  await mkdir(path.join(root, ".checktrail"), { mode: 0o755 });
  await writeFile(
    path.join(root, "scripts/prepare-fsharp-format-tools.mjs"),
    source,
  );
  await writeFile(path.join(root, "archive.zip"), archive);
  // Synthetic pins isolate publication behavior; they do not attest real formatter assemblies.
  await writeFile(
    path.join(root, "dist/src/fsharp-format-pins.js"),
    "export const fantomasPackagePin=" +
      JSON.stringify({ bytes: archive.length, sha256: hash(archive) }) +
      ";\nexport const fsharpFormatterPins=" +
      JSON.stringify(
        payloads.map((p) => ({
          file: p.file,
          bytes: p.bytes.length,
          sha256: hash(p.bytes),
        })),
      ) +
      ";\n",
  );
  await writeFile(
    path.join(root, "dist/src/maven.js"),
    "import {createHash} from 'node:crypto';export const mavenHash=(bytes)=>createHash('sha256').update(bytes).digest('hex');\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "process.umask(0o077);process.argv=[process.execPath,'preparer','--archive','archive.zip'];await import('./scripts/prepare-fsharp-format-tools.mjs');",
    ],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(root, ".checktrail/fsharp-format-tools");
  assert.equal((await stat(output)).mode & 0o777, 0o755);
  for (const payload of payloads) {
    const file = path.join(output, payload.file);
    assert.equal((await stat(file)).mode & 0o777, 0o644, payload.file);
    assert.deepEqual(await readFile(file), payload.bytes);
  }
});

test("F# mutation admission binds the current proof-aware inventory and refuses missing duplicate or identifier-near selectors", async (t) => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const guard = await readFile(
    path.join(repository, "scripts/verify-fsharp-format-guards.mjs"),
    "utf8",
  );
  const root = await fixture(t, { "package.json": '{"type":"module"}' });
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "dist/src"), { recursive: true });
  await mkdir(path.join(root, "dist/test"));
  await writeFile(
    path.join(root, "scripts/verify-fsharp-format-guards.mjs"),
    guard,
  );
  const callback = path.join(
    root,
    "dist/test/gate-dotnet-fsharp-format.test.js",
  );
  await writeFile(
    callback,
    'throw new Error("admission must not execute callbacks");\n',
  );
  const files = [
    "fsharp-format-evidence.js",
    "fsharp-format.js",
    "fsharp-format-native.js",
  ];
  for (const file of files)
    await writeFile(
      path.join(root, "dist/src", file),
      await readFile(path.join(repository, "dist/src", file)),
    );
  const file = path.join(root, "dist/src/fsharp-format-evidence.js"),
    original = await readFile(file, "utf8");
  const target =
    "isDeepStrictEqual(readdirSync(tools).sort(), fsharpPreparedFileNames(proofPin))";
  assert.equal(original.split(target).length, 2);
  const invoke = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["scripts/verify-fsharp-format-guards.mjs", ...args],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
  const baseline = invoke("--validate-controls");
  assert.equal(baseline.error, undefined);
  assert.equal(baseline.status, 0, baseline.stderr);
  const admitted = JSON.parse(baseline.stdout);
  assert.equal(admitted.requiredControls, 19);
  assert.equal(admitted.controls.length, 19);
  assert.equal(new Set(admitted.controls).size, 19);
  assert.ok(admitted.controls.includes("exact-formatter-assembly-inventory"));
  assert.equal(admitted.nativeFormatterExecuted, false);
  assert.equal(admitted.mutationControlsExecuted, false);
  assert.equal(admitted.qualification, false);
  const near = original.replace(
    target,
    "isDeepStrictEqual(\n  readdirSync(tools).sort(),\n  fsharpPreparedFileNames(proofPin)\n)",
  );
  await writeFile(file, near);
  const syntax = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(invoke("--validate-controls").status, 0);
  for (const replacement of [
    "true",
    target + " && " + target,
    target.replace("isDeepStrictEqual", "prefixisDeepStrictEqual"),
    target.replace("isDeepStrictEqual", "custom.isDeepStrictEqual"),
    target.replace("(proofPin)", "(proofPinSuffix)"),
  ]) {
    await writeFile(file, original.replace(target, replacement));
    const refused = invoke("--validate-controls");
    assert.equal(refused.status, 1, replacement);
    assert.match(refused.stderr, /exact-formatter-assembly-inventory/u);
    assert.equal(refused.stdout, "");
  }
  await writeFile(file, original);
  const unknown = invoke(
    "--control",
    "exact-formatter-assembly-inventory-suffix",
  );
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown exact F# mutation control/u);
  assert.equal(unknown.stdout, "");
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(
    await readFile(callback, "utf8"),
    'throw new Error("admission must not execute callbacks");\n',
  );
});
