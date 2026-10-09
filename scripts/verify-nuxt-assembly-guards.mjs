import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const repository = fileURLToPath(new URL("../", import.meta.url));
const main = new URL(
    "../dist/test/gate-assembly-nuxt.test.js",
    import.meta.url,
  ),
  guards = new URL(
    "../dist/test/review-nuxt-assembly-guards.test.js",
    import.meta.url,
  ),
  fixture = new URL(
    "../dist/test/review-nuxt-assembly-fixture.js",
    import.meta.url,
  );
const callbackFor = (name) =>
  name.endsWith("guard acceptance") ? guards : main;
const pins = new Map(
  await Promise.all(
    [main, guards, fixture].map(async (file) => [
      file.href,
      await readFile(file),
    ]),
  ),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const controls = [
  {
    id: "native-api-query-collision",
    file: "nuxt-assembly-native.js",
    name: "assembly-nuxt native query collision guard acceptance",
    before: "if (queryCollision)",
    after: "if (false)",
  },
  {
    id: "receipt-source",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "result.runtime.sourceFingerprint !== check.commands[0].args[4] ||",
    after: "false ||",
  },
  {
    id: "receipt-producer-name",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: 'result.runtime.producer.name !== "checktrail.nuxt" ||',
    after: "false ||",
  },
  {
    id: "receipt-producer-version",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: 'result.runtime.producer.version !== "2.0.0" ||',
    after: "false ||",
  },
  {
    id: "receipt-assembly",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "result.runtime.assembly.name !== config.assembly ||",
    after: "false ||",
  },
  {
    id: "receipt-environment",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "result.runtime.assembly.environment !== config.environment ||",
    after: "false ||",
  },
  {
    id: "receipt-supported-types",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "!result.types.supported ||",
    after: "false ||",
  },
  {
    id: "receipt-ordered-collection",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "!collection.ordered ||",
    after: "false ||",
  },
  {
    id: "receipt-versions-keys",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before:
      "Object.keys(result.versions).length !==\n                Object.keys(expectedVersions).length ||",
    after: "false ||",
  },
  {
    id: "receipt-versions-values",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before:
      "Object.entries(expectedVersions).some(([name, value]) => result.versions[name] !== value) ||",
    after: "false ||",
  },
  {
    id: "receipt-consumers",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before:
      "JSON.stringify(result.types.consumers) !==\n                JSON.stringify(config.consumers) ||",
    after: "false ||",
  },
  {
    id: "receipt-collection-kind",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "collection.kind !== kinds[i] ||",
    after: "false ||",
  },
  {
    id: "receipt-collection-complete",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "!collection.complete)",
    after: "false)",
  },
  {
    id: "receipt-derived-middleware",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before:
      "JSON.stringify(result.runtime.collections[1].entries) !==\n                JSON.stringify(expectedMiddleware) ||",
    after: "false ||",
  },
  {
    id: "receipt-derived-bindings",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before:
      "JSON.stringify(result.runtime.collections[2].entries) !==\n                JSON.stringify(expectedBindings))",
    after: "false)",
  },
  {
    id: "receipt-counts",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before:
      "JSON.stringify(result.counts) !==\n                JSON.stringify([\n                    pages.length,\n                    result.handlers.length,\n                    h3.length,\n                    appMiddleware.length,\n                    result.runtimeConfig.length,\n                    result.types.apis.length,\n                ]) ||",
    after: "false ||",
  },
  {
    id: "receipt-request-identity",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before: "request.path !== input.path || request.method !== input.method",
    after: "false",
  },
  {
    id: "receipt-event-membership",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt stale acceptance",
    before:
      "!result.middleware.some((m) => m.phase === event.phase && m.position === event.position)",
    after: "false",
  },
  {
    id: "generated-consumer-diagnostics",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt broken acceptance",
    before: "if (result.types.diagnostics.length)",
    after: "if (false)",
  },
  {
    id: "declared-type-contract",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt broken acceptance",
    before: '["api-types", result.types.apis, config.expectedApis],',
    after: '["api-types", result.types.apis, result.types.apis],',
  },
  {
    id: "declared-request-contract",
    file: "nuxt-assembly-evidence.js",
    name: "assembly-nuxt broken acceptance",
    before: 'finding("nuxt/assembly-request-mismatch",',
    after: 'void ("nuxt/assembly-request-mismatch",',
  },
  {
    id: "each-consumer-participates",
    file: "nuxt-assembly-native.js",
    name: "assembly-nuxt generated consumer participation guard acceptance",
    before: "if (!reached)",
    after: "if (false)",
  },
  {
    id: "all-selected-apis-participate",
    file: "nuxt-assembly-native.js",
    name: "assembly-nuxt generated API participation guard acceptance",
    before: "if (consumed.size !== selected.size)",
    after: "if (false)",
  },
  {
    id: "native-version-bootstrap",
    file: "nuxt-assembly-runner.js",
    name: "assembly-nuxt prerequisite acceptance",
    before: "if (versions[name] !== expected)",
    after: "if (false)",
  },
  {
    id: "native-byte-digest",
    file: "nuxt-assembly-runner.js",
    name: "assembly-nuxt prerequisite acceptance",
    before: 'createHash("sha256").update(bytes).digest("hex") !== pin.sha256',
    after: "false",
  },
  {
    id: "native-response-byte-bound",
    file: "nuxt-assembly-runner.js",
    name: "assembly-nuxt response byte budget guard acceptance",
    before: "bytes + result.value.byteLength > 64 * 1024",
    after: "false",
  },
  {
    id: "reserved-config-boundaries",
    file: "nuxt-assembly-observer.js",
    name: "assembly-nuxt reserved config boundary guard acceptance",
    before:
      'if (!config.app ||\n        typeof config.app !== "object" ||\n        Array.isArray(config.app) ||\n        JSON.stringify(Object.keys(config.app).sort()) !==\n            JSON.stringify(["baseURL", "buildAssetsDir", "buildId", "cdnURL"]) ||\n        Object.values(config.app).some((v) => typeof v !== "string"))',
    after: "if (false)",
  },
  {
    id: "native-middleware-handler-identity",
    file: "nuxt-assembly-observer.js",
    name: "assembly-nuxt middleware identity guard acceptance",
    before: "layer.handler !== wrappedLayers[i] ||",
    after: "false ||",
  },
  {
    id: "native-registration-lifetime",
    file: "nuxt-assembly-observer.js",
    name: "assembly-nuxt router registration guard acceptance",
    before: "registrationChanged ||",
    after: "false ||",
  },
  {
    id: "native-page-getter-identity",
    file: "nuxt-assembly-observer.js",
    name: "assembly-nuxt page identity guard acceptance",
    before: "router.getRoutes !== capture.method ||",
    after: "false ||",
  },
  {
    id: "dynamic-app-middleware-boundary",
    file: "nuxt-assembly-observer.js",
    name: "assembly-nuxt dynamic middleware guard acceptance",
    before:
      "capture.app._middleware.global.length ||\n                    Object.keys(capture.app._middleware.named).length",
    after: "false",
  },
];
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
function run(name) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      pattern,
      fileURLToPath(callbackFor(name)),
    ],
    {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return result;
}

const selected = new Set(process.argv.slice(2));
assert.ok(
  [...selected].every((id) => controls.some((c) => c.id === id)),
  "Unknown guard control",
);
const prepared = [];
// Resolve and compile every selected mutation before changing any target.
for (const c of controls.filter((c) => !selected.size || selected.has(c.id))) {
  const file = new URL("../dist/src/" + c.file, import.meta.url),
    original = await readFile(file, "utf8");
  assert.equal(
    original.split(c.before).length,
    2,
    "Exact mutation address: " + c.id,
  );
  const mutant = original.replace(c.before, c.after);
  const parsed = ts.createSourceFile(
    c.file,
    mutant,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    parsed.parseDiagnostics.length,
    0,
    "Compiling mutation preflight: " + c.id,
  );
  prepared.push({ ...c, file, original, mutant });
}
const baselines = new Set(),
  evidence = [];
async function verifyPins() {
  for (const [url, bytes] of pins)
    assert.deepEqual(
      await readFile(new URL(url)),
      bytes,
      "Original callback/fixture changed",
    );
}
for (const c of prepared) {
  await verifyPins();
  assert.equal(
    await readFile(c.file, "utf8"),
    c.original,
    "Source changed before mutation",
  );
  if (!baselines.has(c.name)) {
    const baseline = run(c.name);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    baselines.add(c.name);
  }
  try {
    await writeFile(c.file, c.mutant);
    const syntax = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(c.file)],
      { encoding: "utf8" },
    );
    assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr);
    const killed = run(c.name);
    assert.equal(
      killed.status,
      1,
      "Original assertion must kill " +
        c.id +
        "\n" +
        killed.stdout +
        killed.stderr,
    );
    assert.match(killed.stdout, /ERR_ASSERTION/, c.id);
    assert.doesNotMatch(
      killed.stdout + killed.stderr,
      /SyntaxError|TypeError|ReferenceError/,
    );
    assert.ok(killed.stdout.includes("not ok 1 - " + c.name));
    await verifyPins();
    evidence.push({
      id: c.id,
      callback: c.name,
      callbackSha256: digest(pins.get(callbackFor(c.name).href)),
      fixtureSha256: digest(pins.get(fixture.href)),
      sourceSha256: digest(c.original),
      mutantSha256: digest(c.mutant),
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
    });
  } finally {
    await writeFile(c.file, c.original);
  }
  assert.equal(
    await readFile(c.file, "utf8"),
    c.original,
    "Mutation source restoration",
  );
}
for (const name of baselines) {
  const restored = run(name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  for (const c of evidence.filter((c) => c.callback === name))
    c.restoredPassed = true;
}
await verifyPins();
for (const c of prepared)
  assert.equal(
    await readFile(c.file, "utf8"),
    c.original,
    "Final source restoration",
  );
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic Nuxt assembly controls; selected byte-pinned native runtime; no inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
