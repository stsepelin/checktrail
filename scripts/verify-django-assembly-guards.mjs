import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const repository = fileURLToPath(new URL("../", import.meta.url));
const main = new URL(
    "../dist/test/gate-assembly-django.test.js",
    import.meta.url,
  ),
  guards = new URL(
    "../dist/test/review-django-assembly-guards.test.js",
    import.meta.url,
  ),
  fixture = new URL(
    "../dist/test/review-django-assembly-fixture.js",
    import.meta.url,
  );
import { djangoAssemblyRuntimePins } from "../dist/src/django-assembly-runtime-pins.js";
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
    id: "fingerprint",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "result.runtime.sourceFingerprint !== check.commands[0].args[4]",
    after: "false",
    occurrences: 1,
  },
  {
    id: "producer",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: 'result.runtime.producer.name !== "checktrail.django-routes"',
    after: "false",
    occurrences: 1,
  },
  {
    id: "producer-version",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: 'result.runtime.producer.version !== "2.0.0"',
    after: "false",
    occurrences: 1,
  },
  {
    id: "assembly",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "result.runtime.assembly.name !== config.assembly",
    after: "false",
    occurrences: 1,
  },
  {
    id: "environment",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "result.runtime.assembly.environment !== config.environment",
    after: "false",
    occurrences: 1,
  },
  {
    id: "collection-total",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before:
      'result.runtime.collections.length !== 4 ||\n            result.requests.length !== config.requests.length)\n            return incomplete;\n        const kinds = ["routes", "middleware", "listeners", "bindings"], parsers = [\n            djangoAssemblyRouteSchema,\n            djangoAssemblyMiddlewareSchema,\n            djangoAssemblySignalSchema,\n            djangoAssemblyAppSchema,\n        ];\n        for (const [i, collection] of result.runtime.collections.entries()',
    after:
      'false ||\n            result.requests.length !== config.requests.length)\n            return incomplete;\n        const kinds = ["routes", "middleware", "listeners", "bindings"], parsers = [\n            djangoAssemblyRouteSchema,\n            djangoAssemblyMiddlewareSchema,\n            djangoAssemblySignalSchema,\n            djangoAssemblyAppSchema,\n        ];\n        for (const [i, collection] of result.runtime.collections.slice(0,4).entries()',
    occurrences: 1,
  },

  {
    id: "request-total",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "result.requests.length !== config.requests.length",
    after: "false",
    occurrences: 1,
  },
  {
    id: "collection-kind",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "collection.kind !== kinds[i]",
    after: "false",
    occurrences: 1,
  },
  {
    id: "collection-order",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "!collection.ordered",
    after: "false",
    occurrences: 1,
  },
  {
    id: "collection-completeness",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "!collection.complete",
    after: "false",
    occurrences: 1,
  },
  {
    id: "collection-counts",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "collection.entries.length !== result.counts[i]",
    after: "false",
    occurrences: 1,
  },
  {
    id: "entry-key",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "entry.key !== canonical(attrs)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "visited-count",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "result.visitedNodes !== routes.length + result.resolverNodes",
    after: "false",
    occurrences: 1,
  },
  {
    id: "request-input",
    file: "django-assembly-evidence.js",
    name: "assembly-django stale acceptance",
    before: "canonical(input) !== canonical(actual)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "route-contract",
    file: "django-assembly-evidence.js",
    name: "assembly-django broken acceptance",
    before: "canonical(actual) !== canonical(expected)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "response-contract",
    file: "django-assembly-evidence.js",
    name: "assembly-django broken acceptance",
    before:
      "canonical({ status, body: responseBody, events }) !==\n                canonical(expected)",
    after: "false",
    occurrences: 1,
  },
  {
    id: "native-namespace-identity",
    file: "django-assembly-evidence.js",
    name: "assembly-django namespace guard acceptance",
    before: "canonical([route.patterns, route.namespaces])",
    after: "canonical([route.patterns])",
    occurrences: 1,
  },
  {
    id: "isolated-command",
    file: "django.js",
    name: "assembly-django isolated bootstrap guard acceptance",
    before: '"-I",',
    after: '"-B",',
    occurrences: 1,
  },
  {
    id: "exclude-unchecked-pyc",
    file: "django-assembly-runner.js",
    name: "assembly-django isolated bootstrap guard acceptance",
    before: "sys.pycache_prefix=owned",
    after: "sys.pycache_prefix=None",
    occurrences: 1,
  },
  {
    id: "preload-asgiref",
    file: "django-assembly-runner.js",
    name: "assembly-django isolated bootstrap guard acceptance",
    before: "import django, asgiref.sync",
    after: "import django",
    occurrences: 1,
  },
  {
    id: "native-app-defaults",
    file: "django-assembly-runner.js",
    name: "assembly-django fixed acceptance",
    before: "'defaultAutoField':app.default_auto_field",
    after: "'defaultAutoField':'django.db.models.AutoField'",
    occurrences: 1,
  },
  {
    id: "inherited-route-defaults",
    file: "django-assembly-runner.js",
    name: "assembly-django fixed acceptance",
    before:
      "values={**defaults,**(route.default_kwargs if type(route) is URLResolver else route.default_args)}",
    after:
      "values={**(route.default_kwargs if type(route) is URLResolver else route.default_args)}",
    occurrences: 1,
  },
  {
    id: "omitted-middleware",
    file: "django-assembly-runner.js",
    name: "assembly-django fixed acceptance",
    before: "'constructed':False",
    after: "'constructed':True",
    occurrences: 1,
  },
  {
    id: "native-hook-orders",
    file: "django-assembly-runner.js",
    name: "assembly-django fixed acceptance",
    before: "enumerate(getattr(handler,field))",
    after: "enumerate(reversed(getattr(handler,field)))",
    occurrences: 1,
  },
  {
    id: "native-async-dispatch",
    file: "django-assembly-runner.js",
    name: "assembly-django native asynchronous dispatch guard acceptance",
    before: "'receivers':[identity(receiver)for receiver,_ in result]",
    after: "'receivers':sorted([identity(receiver)for receiver,_ in result])",
    occurrences: 1,
  },
  {
    id: "receiver-error-accounting",
    file: "django-assembly-runner.js",
    name: "assembly-django native asynchronous dispatch guard acceptance",
    before: "isinstance(value,Exception)",
    after: "False ",
    occurrences: 1,
  },
  {
    id: "weak-receiver-metadata",
    file: "django-assembly-runner.js",
    name: "assembly-django weak bound receiver guard acceptance",
    before: "'weak':isinstance(row[1],weakref.ReferenceType)",
    after: "'weak':False",
    occurrences: 1,
  },
  {
    id: "receiver-multiplicity",
    file: "django-assembly-runner.js",
    name: "assembly-django broken acceptance",
    before: "active=list(signal.receivers)",
    after: "active=list(signal.receivers)[:1]",
    occurrences: 1,
  },
  {
    id: "registration-drift",
    file: "django-assembly-runner.js",
    name: "assembly-django registration drift guard acceptance",
    before: "if initial!=current:",
    after: "if False:",
    occurrences: 1,
  },
  {
    id: "signal-observer-identity",
    file: "django-assembly-runner.js",
    name: "assembly-django native observer replacement guard acceptance",
    before:
      "if any(getattr(Signal,k) is not v for k,v in {**wrappers,**signal_helpers}.items()) or ModelSignal.connect is not model_connect or ModelSignal.disconnect is not model_disconnect:",
    after: "if False:",
    occurrences: 1,
  },
  {
    id: "whole-url-budget",
    file: "django-assembly-runner.js",
    name: "assembly-django limits and opaque metadata guard acceptance",
    before: "if visited>2048:",
    after: "if False:",
    occurrences: 1,
  },
  {
    id: "signal-operation-budget",
    file: "django-assembly-runner.js",
    name: "assembly-django limits and opaque metadata guard acceptance",
    before: "if operations>4096:",
    after: "if False:",
    occurrences: 2,
  },
  {
    id: "server-port",
    file: "django-assembly-runner.js",
    name: "assembly-django WSGI request boundary guard acceptance",
    before: "'SERVER_PORT':port if separator else '80'",
    after: "'SERVER_PORT':'80'",
    occurrences: 1,
  },

  {
    id: "model-signal-sender",
    file: "django-assembly-runner.js",
    name: "assembly-django native model signal guard acceptance",
    before: "'sender':None if sender is None else identity(sender)",
    after: "'sender':None",
    occurrences: 2,
  },
  {
    id: "response-byte-and-chunk-budget",
    file: "django-assembly-runner.js",
    name: "assembly-django native response limits guard acceptance",
    before: "chunks>64 or len(output)+len(part)>65536",
    after: "False",
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
  if (c.file === "django-assembly-runner.js") {
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
            "JSON.stringify(djangoAssemblyRuntimePins)",
          );
          collector +=
            JSON.stringify(djangoAssemblyRuntimePins) + span.literal.rawText;
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
      "Original synthetic Django assembly controls; selected byte-pinned native runtime; no inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
