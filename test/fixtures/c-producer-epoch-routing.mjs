// Trusted-reader orchestration control. Historical implementations stay inert.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { createHash } from "node:crypto";
import { readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const repository = await realpath(process.argv[2]);
const root = await realpath(process.argv[3]);
const target = pathToFileURL(
  path.join(repository, "scripts/verify-c-producer-observation.mjs"),
).href;
const key = "__checktrailAuthoredEpochRouting";
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
const current = await readFile(
  path.join(repository, "scripts/qualify-c-producer.mjs"),
);
const pin = {
  file: "scripts/qualify-c-producer.mjs",
  bytes: current.length,
  sha256: sha(current),
};
const provenance = JSON.parse(
  await readFile(
    path.join(repository, "test/fixtures/c-controller-history/provenance.json"),
    "utf8",
  ),
);
const historical = provenance.fixtures.map((row) => ({
  epoch: row.schemaVersion,
  pin: { file: pin.file, bytes: row.bytes, sha256: row.sha256 },
}));
const legacyCollectorPin = {
  file: "scripts/producer-qualification/c-producer-test-reports.py",
  bytes: 18397,
  sha256: "9dee7066707382c33ba971fe63ded57c407454c81ed38ab30aa66b95b558691c",
};
const state = { startup: { sourcePins: [pin] }, headerCalls: 0 };
globalThis[key] = state;
let bodyUnchanged = false;
const hooks = registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    const raw =
      typeof loaded.source === "string"
        ? loaded.source
        : Buffer.from(loaded.source).toString("utf8");
    const before = ts.createSourceFile(
      "reader.mjs",
      raw,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const bodies = [];
    for (const name of [
      "verifyCObservationStartup",
      "validateCObservationHeader",
    ]) {
      const declarations = before.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      assert.equal(declarations.length, 1);
      const body = declarations[0].body;
      const replacement =
        name === "verifyCObservationStartup"
          ? `{return {startupRaw:Buffer.from("authored startup delegation"),startup:globalThis[${JSON.stringify(key)}].startup};}`
          : `{globalThis[${JSON.stringify(key)}].headerCalls++;throw Error("Authored next-header checkpoint");}`;
      bodies.push({ start: body.pos, end: body.end, replacement });
    }
    let source = raw;
    for (const edit of bodies.sort((left, right) => right.start - left.start))
      source =
        source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
    const after = ts.createSourceFile(
      "reader.mjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const live = (tree) =>
      tree.statements
        .find(
          (node) =>
            ts.isFunctionDeclaration(node) &&
            node.name?.text === "verifyCLiveObservation",
        )
        .getText(tree);
    assert.equal(live(before), live(after));
    bodyUnchanged = true;
    return { ...loaded, source };
  },
});
try {
  const api = await import(target);
  const result = path.join(root, "synthetic-epoch-result");
  await mkdir(result, { mode: 0o700 });
  const cases = [
    {
      label: "current3",
      schemaVersion: 3,
      pins: [pin],
      expected: "Authored next-header checkpoint",
      header: true,
    },
    ...[1, 2].map((schemaVersion) => ({
      label: "stripped-current" + schemaVersion,
      schemaVersion,
      pins: [pin],
      expected: "requires receipt schema3",
      header: false,
    })),
    ...historical.map((row) => ({
      label: "known" + row.epoch,
      schemaVersion: row.epoch,
      pins: [row.pin, legacyCollectorPin],
      expected: "Authored next-header checkpoint",
      header: true,
    })),
    ...historical.map((row) => ({
      label: "upgraded-old" + row.epoch,
      schemaVersion: 3,
      pins: [row.pin, legacyCollectorPin],
      expected: "requires receipt schema" + row.epoch,
      header: false,
    })),
    {
      label: "duplicate-controller",
      schemaVersion: 3,
      pins: [pin, pin],
      expected: "Exactly one canonical",
      header: false,
    },
  ];
  const rows = [];
  for (const entry of cases) {
    state.startup = { sourcePins: entry.pins };
    const before = state.headerCalls;
    await writeFile(
      path.join(result, "receipt.json"),
      JSON.stringify({
        schemaVersion: entry.schemaVersion,
        historicalCControllerEpochs: { [pin.sha256]: 2 },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      api.verifyCLiveObservation("gcc-12", result, "authored-startup", 2),
      (error) => {
        assert.ok(String(error).includes(entry.expected), String(error));
        return true;
      },
    );
    assert.equal(state.headerCalls - before, entry.header ? 1 : 0);
    rows.push({ label: entry.label, reachedNextHeader: entry.header });
  }
  console.log(
    JSON.stringify({
      rows,
      liveReaderBodyUnchanged: bodyUnchanged,
      startupAndNextHeaderAreAuthoredDelegates: true,
      sourceCapsuleOrHistoricalImplementationExecuted: false,
      nativeProducerExecuted: false,
    }),
  );
} finally {
  hooks.deregister();
  delete globalThis[key];
}
