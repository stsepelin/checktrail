import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const repository = fileURLToPath(new URL("../", import.meta.url));
const main = new URL(
    "../dist/test/gate-assembly-fastapi.test.js",
    import.meta.url,
  ),
  guards = new URL(
    "../dist/test/review-fastapi-assembly-guards.test.js",
    import.meta.url,
  ),
  fixture = new URL(
    "../dist/test/review-fastapi-assembly-fixture.js",
    import.meta.url,
  );
import { fastapiAssemblyRuntimePins } from "../dist/src/fastapi-assembly-runtime-pins.js";
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
    id: "request-server-port",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi request server port guard acceptance",
    before: "'server':(target_host,int(target_port) if separator else 80)",
    after: "'server':(spec['host'],80)",
    occurrences: 1,
  },
  {
    id: "receipt-fingerprint",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "result.runtime.sourceFingerprint !== check.commands[0].args[4] ||",
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "receipt-producer-name",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: 'result.runtime.producer.name !== "checktrail.fastapi-routes" ||',
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "receipt-producer-version",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: 'result.runtime.producer.version !== "2.0.0" ||',
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "receipt-assembly-name",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "result.runtime.assembly.name !== config.assembly ||",
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "receipt-assembly-environment",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "result.runtime.assembly.environment !== config.environment ||",
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "receipt-request-count",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "result.requests.length !== config.requests.length ||",
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "collection-order",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "!collection.ordered ||",
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "collection-kind",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "collection.kind !== kinds[index] ||",
    after: "false ||",
    occurrences: 1,
  },
  {
    id: "collection-counters",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "collection.entries.length !== counts[index]",
    after: "false",
    occurrences: 1,
  },
  {
    id: "entry-key",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "entry.key !== canonical(attrs)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "application-count",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "scopes.size !== result.applicationCount",
    after: "false",
    occurrences: 1,
  },
  {
    id: "route-counters",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before:
      "registrations.size !== result.routeCount ||\n            applications !== result.applicationRoutes",
    after: "false",
    occurrences: 1,
  },
  {
    id: "collection-completeness",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "result.runtime.collections.some((c) => c.complete !== complete)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "request-input-identity",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi stale acceptance",
    before: "canonical(actual) !== canonical(input)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "routes-contract",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi declared registration guard acceptance",
    before: '["routes", routes, config.expectedRoutes],',
    after: '["routes", routes, routes],',
    occurrences: 1,
  },
  {
    id: "middleware-contract",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi broken acceptance",
    before: '["middleware", middleware, config.expectedMiddleware],',
    after: '["middleware", middleware, middleware],',
    occurrences: 1,
  },
  {
    id: "lifespan-contract",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi declared registration guard acceptance",
    before: '["lifespan", lifespan, config.expectedLifespan],',
    after: '["lifespan", lifespan, lifespan],',
    occurrences: 1,
  },
  {
    id: "bindings-contract",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi declared registration guard acceptance",
    before: '["bindings", bindings, config.expectedBindings],',
    after: '["bindings", bindings, bindings],',
    occurrences: 1,
  },
  {
    id: "request-contract",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi broken acceptance",
    before:
      "canonical({ status, body: responseBody, messages }) !==\n                canonical(expected)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "http-websocket-boundary",
    file: "fastapi-assembly-evidence.js",
    name: "assembly-fastapi protocol method guard acceptance",
    before: 'route.protocol === "websocket" && route.method !== "WEBSOCKET"',
    after:
      '(route.protocol === "websocket") !== (route.method === "WEBSOCKET")',
    occurrences: 1,
  },
  {
    id: "version-before-project",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi prerequisite acceptance",
    before:
      "if versions!={'python':'3.12.13','fastapi':'0.141.1','starlette':'1.6.0','pydantic':'2.13.5'}:",
    after: "if False:",
    occurrences: 1,
  },
  {
    id: "bytes-before-project",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi prerequisite acceptance",
    before:
      "if len(content)!=pin['bytes'] or hashlib.sha256(content).hexdigest()!=pin['sha256']:",
    after: "if False:",
    occurrences: 1,
  },
  {
    id: "bytecode-cache-prefix",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi isolated bootstrap guard acceptance",
    before: "sys.pycache_prefix=owned;",
    after: "sys.pycache_prefix=None;",
    occurrences: 1,
  },
  {
    id: "isolated-tool-probes",
    file: "tool-versions.js",
    name: "assembly-fastapi isolated bootstrap guard acceptance",
    before: '...(check.commands[0]?.args[0] === "-I" ? ["-I"] : []),',
    after: "...[],",
    occurrences: 1,
  },
  {
    id: "route-object-identity",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi route identity drift guard acceptance",
    before:
      "id(original),id(original.endpoint) if hasattr(original,'endpoint') else None",
    after:
      "identity(original),identity(original.endpoint) if hasattr(original,'endpoint') else None",
    occurrences: 1,
  },
  {
    id: "middleware-object-identity",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi middleware identity drift guard acceptance",
    before: "id(middleware),id(middleware.cls)",
    after: "identity(middleware.cls),identity(middleware.cls)",
    occurrences: 1,
  },
  {
    id: "merged-lifespan",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi fixed acceptance",
    before:
      "lifespan(values['nested_context'],scope,branch+'1',ancestry+(id(context),))",
    after: "pass",
    occurrences: 1,
  },
  {
    id: "security-scope-projection",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi fixed acceptance",
    before: "'effectiveScopes':_get_oauth_scopes(dependant=node)",
    after: "'effectiveScopes':[]",
    occurrences: 1,
  },
  {
    id: "dependency-caching-projection",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi fixed acceptance",
    before: "'useCache':node.use_cache",
    after: "'useCache':False",
    occurrences: 1,
  },
  {
    id: "model-projection",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi fixed acceptance",
    before:
      "'responseModel':canonical(TypeAdapter(model).json_schema(mode='serialization')) if model is not None else None",
    after: "'responseModel':None",
    occurrences: 1,
  },
  {
    id: "override-projection",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi fixed acceptance",
    before:
      "for index,(original,replacement) in enumerate(getattr(owner,'dependency_overrides',{}).items()):",
    after: "for index,(original,replacement) in enumerate([]):",
    occurrences: 1,
  },
  {
    id: "middleware-options-projection",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi fixed acceptance",
    before: "'options':canonical(data(middleware.kwargs))",
    after: "'options':canonical(data({}))",
    occurrences: 1,
  },
  {
    id: "lifespan-state",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi fixed acceptance",
    before: "'state':dict(state)",
    after: "'state':{}",
    occurrences: 1,
  },
  {
    id: "complete-websocket-response",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi incomplete native response guard acceptance",
    before: "if not ended: raise Unsupported('ASGI response did not complete')",
    after: "if False: raise Unsupported('ASGI response did not complete')",
    occurrences: 1,
  },
  {
    id: "duplicate-websocket-accept",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi incomplete native response guard acceptance",
    before: "if accepted: raise Unsupported('Duplicate WebSocket accept')",
    after: "if False: raise Unsupported('Duplicate WebSocket accept')",
    occurrences: 1,
  },
  {
    id: "whole-hierarchy-preflight",
    file: "fastapi-assembly-runner.js",
    name: "assembly-fastapi hierarchy budget guard acceptance",
    before: "    preflight(app)\n    async with",
    after: "    # no preflight\n    async with",
    occurrences: 1,
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
    c.occurrences + 1,
    "Exact mutation address: " + c.id,
  );
  const mutant = original.replaceAll(c.before, c.after);
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
  if (c.file === "fastapi-assembly-runner.js") {
    let collector;
    const visit = (node) => {
      if (
        ts.isTaggedTemplateExpression(node) &&
        node.tag.getText(parsed) === "String.raw"
      ) {
        const template = node.template;
        assert.ok(ts.isTemplateExpression(template));
        collector = template.head.rawText;
        for (const span of template.templateSpans) {
          assert.equal(
            span.expression.getText(parsed),
            "JSON.stringify(fastapiAssemblyRuntimePins)",
          );
          collector +=
            JSON.stringify(fastapiAssemblyRuntimePins) + span.literal.rawText;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.equal(typeof collector, "string");
    const syntax = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys;compile(sys.argv[1],'<collector>','exec')",
        collector,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      syntax.status,
      0,
      "Python compiling mutation preflight: " + c.id + "\n" + syntax.stderr,
    );
  }
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
      "Original synthetic FastAPI assembly controls; selected byte-pinned native runtime; no inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
