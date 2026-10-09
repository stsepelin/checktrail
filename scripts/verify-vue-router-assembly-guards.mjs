import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const repository = fileURLToPath(new URL("../", import.meta.url));
const main = new URL(
    "../dist/test/gate-assembly-vue-router.test.js",
    import.meta.url,
  ),
  guards = new URL(
    "../dist/test/review-vue-router-assembly-guards.test.js",
    import.meta.url,
  ),
  fixture = new URL(
    "../dist/test/review-vue-router-assembly-fixture.js",
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
    id: "same-callback-identity",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router near-miss acceptance",
    before: "let wrapped = wrappers.get(callback);",
    after: "let wrapped = undefined;",
  },
  {
    id: "callback-arity",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router near-miss acceptance",
    before: "length: { value: callback.length },",
    after: "length: { value: callback.length + 3 },",
  },

  {
    id: "invocation-reached",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router fixed acceptance",
    before: "reached.reached = true;",
    after: "reached.reached = false;",
  },
  {
    id: "native-remover",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router native facade and repeated remover guard acceptance",
    before: "                remove();",
    after: "                void remove;",
  },
  {
    id: "first-match-removal",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router near-miss acceptance",
    before: "const removed = states.find((state) => state.active &&",
    after: "const removed = states.findLast((state) => state.active &&",
  },
  {
    id: "registration-observer",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router empty acceptance",
    before: "if (router[phase] !== method)",
    after: "if (false)",
  },
  {
    id: "unawaited-after-hook",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router unawaited after hook guard acceptance",
    before: "if (asynchronousAfterHook)",
    after: "if (false)",
  },
  {
    id: "inert-then-data",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router inert then metadata guard acceptance",
    before:
      'return !("value" in descriptor) || typeof descriptor.value === "function";',
    after: "return true;",
  },
  {
    id: "lifetime-registration-budget",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router registration and event budget guard acceptance",
    before: "states.length >= 256 ||",
    after: "states.length >= 257 ||",
  },
  {
    id: "invocation-event-budget",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router registration and event budget guard acceptance",
    before: "if (events.length >= 2048)",
    after: "if (events.length >= 2049)",
  },
  {
    id: "active-registration-identity",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router identical-name assembly drift guard acceptance",
    before: ".map((state) => states.indexOf(state));",
    after: ".map((state) => [state.phase,state.name]);",
  },
  {
    id: "native-push-capture",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router native facade and repeated remover guard acceptance",
    before: "push: router.push.bind(router),",
    after: "push: (...args)=>router.push(...args),",
  },
  {
    id: "native-ready-capture",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router native facade and repeated remover guard acceptance",
    before: "ready: router.isReady.bind(router),",
    after: "ready: (...args)=>router.isReady(...args),",
  },
  {
    id: "native-records-capture",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router identical-record assembly drift guard acceptance",
    before: "records: router.getRoutes.bind(router),",
    after: "records: ()=>router.getRoutes(),",
  },
  {
    id: "native-current-capture",
    file: "vue-router-assembly.js",
    name: "assembly-vue-router native facade and repeated remover guard acceptance",
    before: "current: router.currentRoute,",
    after: "get current(){return router.currentRoute;},",
  },
  {
    id: "native-resolve-capture",
    file: "vue-router-runner.js",
    name: "assembly-vue-router native facade and repeated remover guard acceptance",
    before: "const resolve = router.resolve.bind(router);",
    after: "const resolve = (...args)=>router.resolve(...args);",
  },
  {
    id: "native-final-record-capture",
    file: "vue-router-runner.js",
    name: "assembly-vue-router native facade and repeated remover guard acceptance",
    before: "const routes = router.getRoutes.bind(router);",
    after: "const routes = ()=>router.getRoutes();",
  },
  {
    id: "await-startup",
    file: "vue-router-runner.js",
    name: "assembly-vue-router fixed acceptance",
    before: "await configure(router);",
    after: "configure(router);",
  },
  {
    id: "runtime-byte-gate",
    file: "vue-router-runner.js",
    name: "assembly-vue-router changed runtime byte guard acceptance",
    before: "!(await vueRouterAssemblyRuntimeMatches(routerEntry))",
    after: "false",
  },
  {
    id: "runtime-byte-digest",
    file: "vue-router-runtime-pins.js",
    name: "assembly-vue-router changed runtime byte guard acceptance",
    before: 'createHash("sha256").update(bytes).digest("hex") !== pin.sha256',
    after: "false",
  },
  {
    id: "receipt-source",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: "result.runtime.sourceFingerprint !== check.commands[0].args[5] ||",
    after: "false ||",
  },
  {
    id: "receipt-producer-name",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: 'result.runtime.producer.name !== "checktrail.vue-router" ||',
    after: "false ||",
  },
  {
    id: "receipt-producer-version",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before:
      'result.runtime.producer.version !==\n                (config.schemaVersion === 2 ? "2.0.0" : "1.0.0") ||',
    after: "false ||",
  },
  {
    id: "receipt-assembly-name",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: "result.runtime.assembly.name !== config.assembly ||",
    after: "false ||",
  },
  {
    id: "receipt-assembly-environment",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: "result.runtime.assembly.environment !== config.environment ||",
    after: "false ||",
  },
  {
    id: "receipt-collection-kind",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: 'hooks.kind !== "middleware" ||',
    after: "false ||",
  },
  {
    id: "receipt-collection-order",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: "!hooks.ordered ||",
    after: "false ||",
  },
  {
    id: "receipt-collection-completeness",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router fixed acceptance",
    before: "hooks.complete !== result.hooks.every((hook) => hook.reached) ||",
    after: "hooks.complete === result.hooks.every((hook) => hook.reached) ||",
  },
  {
    id: "receipt-navigation-count",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: "result.navigation.length !== config.navigation.length ||",
    after: "false ||",
  },
  {
    id: "receipt-navigation-path",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router stale acceptance",
    before: "step.path !== config.navigation[index].path ||",
    after: "false ||",
  },
  {
    id: "record-contract",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router declared records guard acceptance",
    before: "config.expectedRecords,",
    after:
      "collection.entries.map((entry) => vueRouteAttributesSchema.parse(entry.attributes)),",
  },
  {
    id: "hook-contract",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router broken acceptance",
    before: "config.expectedHooks,",
    after: "result.hooks.map(({phase,name})=>({phase,name})),",
  },
  {
    id: "navigation-contract",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router broken acceptance",
    before: '["navigation", result.navigation, config.navigation],',
    after: '["navigation", result.navigation, result.navigation],',
  },
  {
    id: "hook-reach-completeness",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router unreachable hooks guard acceptance",
    before: "assemblyComplete = hooks.complete;",
    after: "assemblyComplete = true;",
  },
  {
    id: "route-probe-coverage",
    file: "vue-router-evidence.js",
    name: "assembly-vue-router empty acceptance",
    before: "result.coveredIndices.length === result.totalRoutes;",
    after: "true;",
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
      timeout: 90000,
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
      "Original synthetic Vue Router assembly controls; selected byte-pinned native runtime; no inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
