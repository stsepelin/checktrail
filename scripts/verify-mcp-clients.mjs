import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const mode = process.argv[2];
assert.ok(["claude", "codex"].includes(mode), "Select claude or codex");
assert.equal(process.argv.length, 3);
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "repo-verifier-client-")),
);
const environment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const expectedTools = [
  "architecture_validation",
  "contract_validation",
  "finding_comparison",
  "mutation_experiment",
  "project_context",
  "review_context",
  "review_guidance",
  "review_receipt",
  "runtime_comparison",
  "validation_plan",
  "validation_report",
  "validation_run",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function treeDigest(directory) {
  const hash = createHash("sha256");
  async function visit(relative = "") {
    const entries = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        assert.ok(entry.isFile());
        hash
          .update(file.split(path.sep).join("/"))
          .update("\0")
          .update(digest(await readFile(path.join(directory, file))))
          .update("\0");
      }
    }
  }
  await visit();
  return hash.digest("hex");
}
let child;
let endpoint;
let pending = new Map();
let lines;
function run(command, args, cwd, env = environment) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* The process may have exited between the checks. */
      }
    }, 3000);
    const force = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* The process may have exited between the checks. */
      }
    }, 6000);
    child.once("exit", () => {
      clearTimeout(timer);
      clearTimeout(force);
      resolve();
    });
    child.stdin.end();
  });
}
try {
  const fixture = path.join(temporary, "fixture");
  const consumer = path.join(temporary, "consumer");
  await mkdir(fixture);
  await mkdir(consumer);
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "synthetic-client-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }),
  );
  const testFile = path.join(fixture, "sum.test.js");
  const source = (expected) =>
    `import {test} from 'node:test';import assert from 'node:assert/strict';test('adds',()=>assert.equal(2+3,${expected}));\n`;
  await writeFile(testFile, source(5));
  await writeFile(path.join(consumer, "package.json"), '{"private":true}');
  const [packed] = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      repository,
    ),
  );
  const tarball = path.join(temporary, packed.filename);
  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    consumer,
  );
  const cli = path.join(
    consumer,
    "node_modules/@stsepelin/repo-verifier/dist/src/cli.js",
  );
  const trace = path.join(temporary, "wire.jsonl");
  const proxy = path.join(temporary, "observe.mjs");
  await writeFile(
    proxy,
    `import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const label=process.argv[2]; const record=value=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({label,...value})+'\\n');
const child=spawn(process.execPath,[${JSON.stringify(cli)},'serve','--root',${JSON.stringify(fixture)},...(label==='trusted'?['--allow-execution']:[])],{stdio:['pipe','pipe','pipe']});
record({event:'start',observerPid:process.pid,serverPid:child.pid});
for(const [direction,input] of [['client',process.stdin],['server',child.stdout]]){createInterface({input}).on('line',line=>{const value=JSON.parse(line);const protocol=value.params?.protocolVersion??value.result?.protocolVersion;const tools=value.result?.tools?.map(tool=>tool.name).sort();record({event:'message',direction,...(value.method?{method:value.method}:{}),...(protocol?{protocol}:{}),...(tools?{tools}:{})});});}
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>{record({event:'exit',code,signal});process.exit(code??1);});
`,
  );
  const observations = [];
  const result = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    profile:
      mode === "claude"
        ? "claude-code-health-discovery"
        : "codex-app-server-direct-tools",
    clientVersion: run(mode, ["--version"], fixture).trim(),
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    package: {
      name: packed.name,
      version: packed.version,
      tarballSha256: digest(await readFile(tarball)),
      runtimeArtifactsSha256: await treeDigest(path.dirname(cli)),
    },
    harnessSha256: digest(await readFile(fileURLToPath(import.meta.url))),
    observations,
  };
  if (mode === "claude") {
    const configDirectory = path.join(temporary, "claude-config");
    await mkdir(configDirectory);
    const env = {
      ...environment,
      CLAUDE_CONFIG_DIR: configDirectory,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      NO_COLOR: "1",
    };
    const args = ["--bare", "--setting-sources", "user", "mcp"];
    run(
      "claude",
      [
        ...args,
        "add-json",
        "--scope",
        "user",
        "repo-verifier",
        JSON.stringify({
          command: process.execPath,
          args: [proxy, "readonly"],
        }),
      ],
      fixture,
      env,
    );
    const settings = JSON.parse(
      await readFile(path.join(configDirectory, ".claude.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(settings.mcpServers), ["repo-verifier"]);
    const { spawnSync } = await import("node:child_process");
    const health = spawnSync("claude", [...args, "list"], {
      cwd: fixture,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(health.status, 0);
    assert.equal(health.error, undefined);
    assert.match(health.stdout, /repo-verifier:.*✔ Connected/);
    assert.equal(
      health.stdout.trim().split(/\n+/).length,
      2,
      "Unexpected additional MCP health entries",
    );
    assert.equal(
      health.stderr.trim(),
      "",
      "Client emitted a schema or startup warning",
    );
    observations.push({
      check: "health-and-discovery",
      outcome: "passed",
      warnings: [],
    });
  } else {
    const providerRequests = [];
    endpoint = createServer((request, response) => {
      providerRequests.push({ method: request.method, path: request.url });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: [] }));
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const provider = "repo-verifier-unused";
    const overrides = [
      "analytics.enabled=false",
      "feedback.enabled=false",
      "features.apps=false",
      "features.plugins=false",
      "features.remote_plugin=false",
      "features.hooks=false",
      `model_provider=${JSON.stringify(provider)}`,
      'model="synthetic-unused"',
      `model_providers.${provider}={name="Unused local endpoint",base_url="http://127.0.0.1:${endpoint.address().port}",wire_api="responses",requires_openai_auth=false}`,
      `log_dir=${JSON.stringify(path.join(temporary, "codex-logs"))}`,
      `sqlite_home=${JSON.stringify(path.join(temporary, "codex-state"))}`,
    ];
    const args = overrides.flatMap((value) => ["-c", value]);
    const servers = JSON.parse(
      run("codex", ["mcp", "list", ...args, "--json"], fixture),
    );
    for (const server of servers) {
      assert.ok(
        /^[a-zA-Z0-9_-]+$/.test(server.name),
        "Existing MCP name cannot be safely overridden",
      );
      args.push("-c", `mcp_servers.${server.name}.enabled=false`);
    }
    const names = [
      "repo-verifier-probe-readonly",
      "repo-verifier-probe-trusted",
    ];
    for (const [index, name] of names.entries()) {
      assert.ok(
        !servers.some((server) => server.name === name),
        "Probe name already configured",
      );
      args.push(
        "-c",
        `mcp_servers.${name}={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(proxy)},${JSON.stringify(index === 0 ? "readonly" : "trusted")}],enabled=true}`,
      );
    }
    const configured = JSON.parse(
      run("codex", ["mcp", "list", ...args, "--json"], fixture),
    );
    assert.deepEqual(
      configured
        .filter((server) => server.enabled)
        .map((server) => server.name)
        .sort(),
      names,
    );
    child = spawn("codex", ["app-server", "--stdio", ...args], {
      cwd: fixture,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stderrBytes = 0;
    child.stderr.on("data", (value) => {
      stderrBytes += value.length;
    });
    lines = createInterface({ input: child.stdout });
    let nextId = 0;
    lines.on("line", (line) => {
      const response = JSON.parse(line);
      const handler = pending.get(response.id);
      if (handler) {
        pending.delete(response.id);
        clearTimeout(handler.timer);
        if (response.error)
          handler.reject(
            new Error(`App-server request failed (${response.error.code})`),
          );
        else handler.resolve(response.result);
      }
    });
    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`App-server timeout: ${method}`));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    }
    await request("initialize", {
      clientInfo: { name: "repo-verifier-client-probe", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const started = await request("thread/start", {
      cwd: fixture,
      ephemeral: true,
      model: "synthetic-unused",
      modelProvider: provider,
      baseInstructions: "Synthetic MCP check; no model turn.",
      developerInstructions: "No model turn.",
      approvalPolicy: "never",
    });
    const threadId = started.thread.id;
    const inventory = await request("mcpServerStatus/list", { threadId });
    for (const server of inventory.data)
      if (!names.includes(server.name))
        assert.equal(Object.keys(server.tools).length, 0);
    for (const name of names) {
      const server = inventory.data.find((item) => item.name === name);
      assert.ok(server);
      assert.deepEqual(
        Object.values(server.tools)
          .map((tool) => tool.name)
          .sort(),
        expectedTools,
      );
    }
    async function call(server, tool, arguments_ = {}) {
      const response = await request("mcpServer/tool/call", {
        threadId,
        server,
        tool,
        arguments: arguments_,
      });
      assert.ok(
        !JSON.stringify(response).includes(temporary),
        "Summary disclosed the temporary root",
      );
      return response;
    }
    for (const tool of ["project_context", "validation_plan"]) {
      const value = await call(names[0], tool);
      assert.equal(value.isError, undefined);
      assert.deepEqual(value.structuredContent.checks, [
        { id: "javascript.node-test", kind: "test", ready: true },
      ]);
      observations.push({
        check: tool,
        outcome: "passed",
        checks: value.structuredContent.checks,
      });
    }
    const guidance = await call(names[0], "review_guidance", { topics: [] });
    assert.equal(guidance.isError, undefined);
    assert.equal(guidance.structuredContent.channel, "advisory");
    assert.equal(guidance.structuredContent.automatedCoverage, false);
    assert.equal(Object.hasOwn(guidance.structuredContent, "outcome"), false);
    assert.deepEqual(
      guidance.structuredContent.items.map((item) => item.id),
      ["review.test-lifecycle"],
    );
    const references = guidance.structuredContent.items.flatMap((item) =>
      item.references.map((reference) => reference.url),
    );
    assert.deepEqual(references, ["https://nodejs.org/api/test.html"]);
    observations.push({
      check: "guidance-https-result",
      outcome: "passed",
      references,
    });
    const denied = await call(names[0], "validation_run");
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Execution is disabled/);
    observations.push({ check: "default-execution-denied", outcome: "passed" });
    const injected = await call(names[0], "validation_run", { trusted: true });
    assert.equal(injected.isError, true);
    observations.push({ check: "tool-cannot-grant-trust", outcome: "passed" });
    for (const [expected, outcome] of [
      [5, "passed"],
      [6, "failed"],
    ]) {
      await writeFile(testFile, source(expected));
      const validation = await call(names[1], "validation_run");
      assert.equal(validation.isError, undefined);
      assert.equal(validation.structuredContent.outcome, outcome);
      assert.equal(validation.structuredContent.sourceChanged, false);
      assert.deepEqual(validation.structuredContent.checks, [
        {
          id: "javascript.node-test",
          status: outcome,
          tests: {
            total: 1,
            passed: expected === 5 ? 1 : 0,
            failed: expected === 5 ? 0 : 1,
            skipped: 0,
          },
        },
      ]);
      const retained = await call(names[1], "validation_report", {
        runId: validation.structuredContent.runId,
      });
      assert.deepEqual(
        retained.structuredContent,
        validation.structuredContent,
      );
      observations.push({
        check: `native-${outcome}-and-report`,
        outcome: "passed",
        validationOutcome: validation.structuredContent.outcome,
        sourceChanged: validation.structuredContent.sourceChanged,
        checks: validation.structuredContent.checks,
        retainedReportEqual: true,
      });
    }
    await writeFile(
      testFile,
      "import {test} from 'node:test';test.skip('not-executed',()=>{});\n",
    );
    const incomplete = await call(names[1], "validation_run");
    assert.equal(incomplete.isError, undefined);
    assert.equal(incomplete.structuredContent.outcome, "incomplete");
    assert.equal(incomplete.structuredContent.checks.length, 1);
    assert.deepEqual(incomplete.structuredContent.checks[0].tests, {
      total: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
    });
    observations.push({
      check: "all-skipped-is-incomplete",
      outcome: "passed",
      validationOutcome: incomplete.structuredContent.outcome,
      checks: incomplete.structuredContent.checks,
    });
    await stop();
    assert.ok(
      providerRequests.every(
        (request) =>
          request.method === "GET" &&
          /^\/models(?:\?client_version=[0-9]+\.[0-9]+\.[0-9]+)?$/.test(
            request.path,
          ),
      ),
      "Unexpected inference request to the unused local provider",
    );
    assert.equal(stderrBytes, 0);
    result.providerRequests = providerRequests;
    result.inferenceRequests = 0;
  }
  async function readWire() {
    return (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  function running(pid) {
    assert.ok(Number.isInteger(pid) && pid > 0);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }
  let wire = await readWire();
  for (
    let attempt = 0;
    attempt < 50 &&
    wire.some(
      (item) =>
        item.event === "start" &&
        (running(item.observerPid) || running(item.serverPid)),
    );
    attempt++
  ) {
    await delay(100);
    wire = await readWire();
  }
  assert.ok(
    wire
      .filter((item) => item.event === "start")
      .every((item) => !running(item.observerPid) && !running(item.serverPid)),
    "Client left an observed MCP process running",
  );
  const labels = mode === "claude" ? ["readonly"] : ["readonly", "trusted"];
  result.connections = labels.map((label) => {
    const events = wire.filter((item) => item.label === label);
    const starts = events.filter((item) => item.event === "start").length;
    const exits = events.filter((item) => item.event === "exit");
    assert.ok(starts > 0);
    assert.ok(exits.length <= starts);
    const requested = [
      ...new Set(
        events
          .filter((item) => item.direction === "client" && item.protocol)
          .map((item) => item.protocol),
      ),
    ];
    const negotiated = [
      ...new Set(
        events
          .filter((item) => item.direction === "server" && item.protocol)
          .map((item) => item.protocol),
      ),
    ];
    assert.equal(requested.length, 1);
    assert.deepEqual(negotiated, requested);
    const lists = events.filter((item) => item.tools);
    assert.ok(lists.length > 0);
    for (const item of lists) assert.deepEqual(item.tools, expectedTools);
    return {
      label,
      starts,
      observedExits: exits.length,
      processesStopped: true,
      exits: exits.map(({ code, signal }) => ({ code, signal })),
      requestedProtocol: requested[0],
      negotiatedProtocol: negotiated[0],
      tools: expectedTools,
    };
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  await stop();
  lines?.close();
  for (const handler of pending.values()) clearTimeout(handler.timer);
  pending = new Map();
  if (endpoint) await new Promise((resolve) => endpoint.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
