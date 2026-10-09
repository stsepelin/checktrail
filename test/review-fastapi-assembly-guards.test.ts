import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { validate, createPlan } from "../src/engine.js";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-fastapi-assembly-fixture.js";
const skip = available
  ? false
  : "Selected native FastAPI assembly runtime unavailable";
test(
  "assembly-fastapi protocol method guard acceptance",
  { skip },
  async (t) => {
    const program =
      source +
      "\nasync def http_socket():return {'http':True}\napp.add_api_route('/v1/catalog/socket',http_socket,methods=['WEBSOCKET'])\n";
    const next = structuredClone(profile),
      base = next.expectedRoutes.find((r) => r.path === "/state")!;
    next.expectedRoutes.push({
      ...base,
      ordinal: "9",
      path: "/v1/catalog/socket",
      handler: "app.http_socket",
      name: "http_socket",
      method: "WEBSOCKET",
    });
    next.requests.push({
      ...next.requests[3]!,
      protocol: "http",
      method: "WEBSOCKET",
      expected: { status: 200, body: '{"http":true}', messages: [] },
    });
    const report = await run(t, program, next);
    assert.equal(report.outcome, "passed");
    assert.deepEqual(
      report.checks[0]!.runtime!.collections[0]!.entries.filter(
        (e) => e.attributes.path === "/v1/catalog/socket",
      ).map((e) => [e.attributes.protocol, e.attributes.method]),
      [
        ["websocket", "WEBSOCKET"],
        ["http", "WEBSOCKET"],
      ],
    );
  },
);
test(
  "assembly-fastapi declared registration guard acceptance",
  { skip },
  async (t) => {
    for (const program of [
      source.replace("'Read catalog'", "'Different scope description'"),
      source.replace("enabled:bool=True", "enabled:bool=False"),
      source + "\napp.dependency_overrides.clear()\n",
    ]) {
      const report = await run(t, program);
      assert.notEqual(report.outcome, "passed");
      if (!program.includes("clear()"))
        assert.ok(
          report.checks[0]!.findings!.some(
            (f) => f.ruleId === "fastapi/assembly-routes-mismatch",
          ),
        );
    }
    const next = structuredClone(profile);
    next.expectedLifespan.reverse();
    assert.equal((await run(t, source, next)).outcome, "failed");
    const binding = structuredClone(profile);
    binding.expectedBindings = [];
    assert.equal((await run(t, source, binding)).outcome, "failed");
  },
);
test(
  "assembly-fastapi isolated bootstrap guard acceptance",
  { skip },
  async (t) => {
    const root = await project(t);
    for (const name of [
      "asyncio",
      "json",
      "importlib",
      "fastapi",
      "pydantic",
    ]) {
      await writeFile(
        path.join(root, name + ".py"),
        "from pathlib import Path\nPath('shadow.executed').write_text('bad')\nraise RuntimeError('Shadow executed')\n",
      );
    }
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await assert.rejects(access(path.join(root, "shadow.executed")));
    const cached = await project(t);
    await mkdir(path.join(cached, "__pycache__"));
    const original = await readFile(path.join(cached, "app.py"), "utf8");
    try {
      await writeFile(
        path.join(cached, "app.py"),
        "raise RuntimeError('Unchecked cached project code ran')\n",
      );
      const compiled = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          "import py_compile;py_compile.compile('app.py',cfile='__pycache__/app.cpython-312.pyc',doraise=True,invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)",
        ],
        { cwd: cached, encoding: "utf8" },
      );
      assert.equal(compiled.status, 0, compiled.stderr);
    } finally {
      await writeFile(path.join(cached, "app.py"), original);
    }
    assert.equal((await validate(cached, { trusted: true })).outcome, "passed");
  },
);
test(
  "assembly-fastapi hierarchy budget guard acceptance",
  { skip },
  async (t) => {
    const program =
      source +
      "\nempty=APIRouter()\nfor index in range(1100):app.include_router(empty)\n";
    const report = await run(t, program);
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.processes[0]!.exitCode, 4);
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Total hierarchy inventory limit",
    );
  },
);
test(
  "assembly-fastapi route identity drift guard acceptance",
  { skip },
  async (t) => {
    const drift = String.raw`        if scope['type']=='http':
            original=app.routes[1].endpoint
            async def replacement(*args,**kwargs): return await original(*args,**kwargs)
            replacement.__module__=original.__module__;replacement.__qualname__=original.__qualname__
            app.routes[1].endpoint=replacement
`;
    const report = await run(
      t,
      source.replace(
        "        await self.app(scope,receive,send)",
        drift + "        await self.app(scope,receive,send)",
      ),
    );
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Assembly registrations changed during controlled requests",
    );
  },
);
test(
  "assembly-fastapi middleware identity drift guard acceptance",
  { skip },
  async (t) => {
    const drift = String.raw`        if scope['type']=='http':
            original=app.user_middleware[0].cls
            class Replacement(original):pass
            Replacement.__module__=original.__module__;Replacement.__qualname__=original.__qualname__
            app.user_middleware[0].cls=Replacement
`;
    const report = await run(
      t,
      source.replace(
        "        await self.app(scope,receive,send)",
        drift + "        await self.app(scope,receive,send)",
      ),
    );
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Assembly registrations changed during controlled requests",
    );
  },
);
test(
  "assembly-fastapi incomplete native response guard acceptance",
  { skip },
  async (t) => {
    for (const program of [
      source.replace(
        "        await self.app(scope,receive,send)",
        String.raw`        if scope['type']=='websocket' and scope['path']=='/v1/catalog/socket':
            await send({'type':'websocket.accept','subprotocol':None,'headers':[]})
            await send({'type':'websocket.accept','subprotocol':None,'headers':[]})
            await send({'type':'websocket.close','code':1000,'reason':''})
            return
        await self.app(scope,receive,send)`,
      ),
      source.replace("await websocket.close()", "return"),
      source.replace(
        "await websocket.send_json({'ready':ready})",
        "await websocket.send_bytes(b'original')",
      ),
    ]) {
      const report = await run(t, program);
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks[0]!.findingsComplete, false);
      assert.equal(report.checks[0]!.processes[0]!.exitCode, 4);
    }
  },
);
test(
  "assembly-fastapi explicit request boundary guard acceptance",
  { skip },
  async (t) => {
    for (const change of [
      (p: typeof profile) => {
        p.requests[0]!.headers.push(["HOST", "foreign.test"]);
      },
      (p: typeof profile) => {
        p.requests[0]!.method = "GET";
      },
      (p: typeof profile) => {
        p.requests[0]!.body = "body";
      },
      (p: typeof profile) => {
        p.requests[0]!.path = "/items?x=1";
      },
    ]) {
      const next = structuredClone(profile);
      change(next);
      await assert.rejects(createPlan(await project(t, source, next)));
    }
  },
);
test(
  "assembly-fastapi typed metadata near-miss guard acceptance",
  { skip },
  async (t) => {
    const next = structuredClone(profile);
    const mounted = next.expectedRoutes.find(
      (r) => r.scope.includes("mount") && r.path === "/items",
    )!;
    const options = JSON.parse(mounted.responseOptions);
    options.include = [
      "set",
      [
        ["string", "enabled"],
        ["string", "id"],
      ],
    ];
    const canonical = (input: unknown): string => {
      if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
      if (input !== null && typeof input === "object")
        return `{${Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
          .join(",")}}`;
      return JSON.stringify(input);
    };
    mounted.responseOptions = canonical(options);
    const initializer = next.expectedMiddleware.find(
      (m) =>
        m.scope === "[]" && m.kind === "user" && m.name === "app.Initialize",
    )!;
    initializer.options = canonical([
      "object",
      [
        ["label", ["string", "root"]],
        [
          "options",
          [
            "object",
            [
              ["type", ["string", "callable"]],
              ["value", ["string", "app.spoof"]],
            ],
          ],
        ],
      ],
    ]);
    const program = source
      .replace(
        "@child.get('/items',response_model=Item)",
        "@child.get('/items',response_model=Item,response_model_include={'id','enabled'})",
      )
      .replace(
        "def __init__(self,app,label='init'):",
        "def __init__(self,app,label='init',options=None):",
      )
      .replace(
        "app.add_middleware(Initialize,label='root')",
        "app.add_middleware(Initialize,label='root',options={'type':'callable','value':'app.spoof'})",
      );
    const report = await run(t, program, next);
    assert.equal(report.outcome, "passed");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).requests[4]
        .responseBody,
      '{"id":3,"enabled":true}',
    );
    assert.deepEqual(
      JSON.parse(
        report.checks[0]!.runtime!.collections[1]!.entries.find(
          (e) =>
            e.attributes.kind === "user" &&
            e.attributes.name === "app.Initialize",
        )!.attributes.options as string,
      ),
      JSON.parse(initializer.options!),
    );
  },
);
test(
  "assembly-fastapi request server port guard acceptance",
  { skip },
  async (t) => {
    const next = structuredClone(profile),
      base = next.expectedRoutes.find((r) => r.path === "/state")!;
    next.expectedRoutes.push({
      ...base,
      ordinal: "9",
      path: "/server",
      handler: "app.server",
      name: "server",
    });
    next.requests.push({
      ...next.requests[6]!,
      path: "/server",
      host: "root.example.test:8042",
      expected: {
        status: 200,
        body: '["root.example.test",8042]',
        messages: [],
      },
    });
    const report = await run(
      t,
      source +
        "\n@app.get('/server')\nasync def server(request:Request):return request.scope['server']\n",
      next,
    );

    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).requests.at(-1)
        .responseBody,
      '["root.example.test",8042]',
    );
    assert.equal(report.outcome, "passed");
  },
);
