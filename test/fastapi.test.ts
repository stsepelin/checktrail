import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { compareRuntimeInventories } from "../src/runtime-inventory.js";
import { fixture } from "./helpers.js";

const available =
  spawnSync(
    "python3",
    [
      "-c",
      "from importlib.metadata import version; assert version('fastapi') == '0.141.1'; assert version('starlette') == '1.6.0'",
    ],
    { timeout: 10_000 },
  ).status === 0;
const profile = JSON.stringify({
  schemaVersion: 1,
  module: "app",
  attribute: "app",
  assembly: "synthetic-api",
  environment: "isolated-test",
});
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["python.fastapi-routes"] }],
});
const good = `from fastapi import FastAPI
app = FastAPI()
@app.get('/items')
def items(): return []
@app.post('/items')
def create(): return {}
@app.get('/items-extra')
def extra(): return []
@app.websocket('/socket')
async def socket(websocket): pass
app.add_api_route('/socket', items, methods=['WEBSOCKET'])
`;
async function replace(file: string, text: string) {
  await writeFile(file + ".replacement", text, { flush: true });
  await rename(file + ".replacement", file);
}

test("FastAPI planning requires an explicit local import profile and never loads the application", async (t) => {
  const root = await fixture(t, {
    "pyproject.toml": "",
    "checktrail.json": policy,
    "checktrail.fastapi.json": profile,
    "app.py": "from pathlib import Path\nPath('imported').write_text('ran')\n",
  });
  const plan = (await createPlan(root)).plan;
  assert.deepEqual(plan.checks[0]!.scope, ["app.py"]);
  await assert.rejects(access(path.join(root, "imported")));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  for (const invalid of [
    { module: "../outside" },
    { attribute: "app;execute()" },
    { execute: true },
  ]) {
    await writeFile(
      path.join(root, "checktrail.fastapi.json"),
      JSON.stringify({ ...JSON.parse(profile), ...invalid }),
    );
    await assert.rejects(createPlan(root));
  }
  await writeFile(
    path.join(root, "checktrail.fastapi.json"),
    profile.replace('"app"', '"missing"'),
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /local Python/,
  );
});

test(
  "native FastAPI captures framework defaults, HTTP/WebSocket boundaries and exact duplicate registrations",
  {
    skip: available ? false : "Pinned FastAPI/Starlette unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await fixture(t, {
      "pyproject.toml": "",
      "checktrail.json": policy,
      "checktrail.fastapi.json": profile,
      "app.py": good,
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const runtime = report.checks[0]!.runtime!;
    assert.equal(runtime.sourceFingerprint, report.sourceFingerprint);
    assert.equal(runtime.collections[0]!.complete, true);
    const keys = runtime.collections[0]!.entries.map((entry) => entry.key);
    for (const key of [
      "HTTP GET /openapi.json",
      "HTTP GET /docs",
      "HTTP GET /items",
      "HTTP POST /items",
      "HTTP GET /items-extra",
      "WEBSOCKET /socket",
      "HTTP WEBSOCKET /socket",
    ])
      assert.ok(keys.includes(key), key);
    assert.ok(!JSON.stringify(projectReport(report, false)).includes("/items"));
    await replace(
      path.join(root, "app.py"),
      good + "app.add_api_route('/items', extra, methods=['GET'])\n",
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    const comparison = compareRuntimeInventories(
      runtime,
      broken.checks[0]!.runtime,
    );
    assert.equal(comparison.outcome, "failed");
    assert.equal(comparison.counts.added, 1);
    await replace(path.join(root, "app.py"), good);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);

test(
  "native FastAPI inventories after lifespan startup, completes cleanup and rejects unsupported assembly",
  {
    skip: available ? false : "Pinned FastAPI/Starlette unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const source = `from contextlib import asynccontextmanager
from fastapi import FastAPI
def handler(): return []
@asynccontextmanager
async def lifespan(app):
    app.add_api_route('/items', handler, methods=['GET'])
    print('synthetic startup')
    try:
        yield
    finally:
        print('synthetic shutdown')
app = FastAPI(lifespan=lifespan)
app.add_api_route('/items', handler, methods=['GET'])
`;
    const root = await fixture(t, {
      "pyproject.toml": "",
      "checktrail.json": policy,
      "checktrail.fastapi.json": profile,
      "app.py": source,
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.match(report.checks[0]!.processes[0]!.stderr, /synthetic startup/);
    assert.match(report.checks[0]!.processes[0]!.stderr, /synthetic shutdown/);
    await replace(
      path.join(root, "app.py"),
      source.replace(
        "app.add_api_route('/items', handler, methods=['GET'])\n",
        "app.add_api_route('/startup', handler, methods=['GET'])\n",
      ),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    for (const app of [
      "from fastapi import FastAPI\napp = FastAPI()\n",
      good +
        "from starlette.applications import Starlette\napp.mount('/other', Starlette())\n",
      source.replace(
        "print('synthetic shutdown')",
        "raise RuntimeError('synthetic shutdown failed')",
      ),
      "app = object()\n",
    ]) {
      await replace(path.join(root, "app.py"), app);
      const result = await validate(root, { trusted: true });
      assert.equal(result.outcome, "incomplete", JSON.stringify(result.checks));
    }
  },
);
