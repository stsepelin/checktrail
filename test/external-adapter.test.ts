import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { externalEvidence } from "../src/external-evidence.js";
import {
  externalManifestSchema,
  type ExternalReference,
} from "../src/external-adapter.js";
import { reportSummarySchema } from "../src/schemas.js";
import { projectPlan, projectReport } from "../src/output.js";
import { fixture } from "./helpers.js";
import { runProcess } from "../src/runner.js";

const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const sample = await readFile(
  new URL(
    "../../examples/external-adapter/bundle/adapter.mjs",
    import.meta.url,
  ),
  "utf8",
);
const manifest = {
  schemaVersion: 1,
  id: "external.fixture",
  version: "1.0.0",
  description: "Synthetic protocol fixture",
  runtime: "node",
  entry: "adapter.mjs",
  files: [{ path: "adapter.mjs", sha256: hash(sample) }],
  markers: ["lines.project"],
  checks: [
    {
      id: "whitespace",
      kind: "format",
      description: "Check text whitespace",
      failOn: "error",
      scope: { extensions: [".txt"], names: [] },
    },
  ],
};
async function bundle(
  t: TestContext,
  program = sample,
  override: Record<string, unknown> = {},
): Promise<ExternalReference> {
  const declaration = {
    ...manifest,
    files: [{ path: "adapter.mjs", sha256: hash(program) }],
    ...override,
  };
  const text = JSON.stringify(declaration);
  const root = await fixture(t, {
    "adapter.mjs": program,
    "adapter.json": text,
  });
  return { path: path.join(root, "adapter.json"), sha256: hash(text) };
}
const input = {
  "lines.project": "example",
  "value with spaces.txt": "North\nSouth\n",
};
const generic = `import {readFile} from 'node:fs/promises';
import process from 'node:process';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const result = { protocolVersion: 1, identity: request.identity, checkId: request.checkId,
  sourceFingerprint: request.sourceFingerprint, files: request.scope.map(path => ({path, status: 'checked'})),
  findings: [], findingsComplete: true, tools: [{name: 'fixture', version: '1.0.0'}] };
`;

test("external empty scopes and unavailable runtimes never become passing checks", async (t) => {
  const reference = await bundle(t);
  const emptyRoot = await fixture(t, { "lines.project": "example" });
  const empty = await validate(emptyRoot, {
    trusted: true,
    externalAdapters: [reference],
  });
  assert.equal(empty.outcome, "incomplete");
  assert.equal(empty.checks[0]!.status, "unavailable");

  const python = await bundle(t, "raise RuntimeError('must not execute')", {
    runtime: "python3",
  });
  const root = await fixture(t, input);
  const { plan } = await createPlan(root, { externalAdapters: [python] });
  const check = plan.checks[0]!;
  const command = check.commands[0]!;
  const result = await runProcess(
    root,
    { ...command, env: { ...command.env, PATH: "" } },
    { timeoutMs: 10_000 },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    unavailable: "external-runtime",
  });
  const evidence = externalEvidence(check, [result]);
  assert.equal(evidence.status, "unavailable");
  assert.equal(evidence.findingsComplete, false);
});

test("external planning verifies pinned metadata without executing code or granting repository trust", async (t) => {
  const root = await fixture(t, input);
  const reference = await bundle(
    t,
    "import {writeFile} from 'node:fs/promises'; await writeFile('executed', 'yes');\n" +
      sample,
  );
  const { plan } = await createPlan(root, { externalAdapters: [reference] });
  assert.equal(plan.checks[0]!.id, "external.fixture.whitespace");
  assert.deepEqual(plan.checks[0]!.scope, ["value with spaces.txt"]);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  assert.equal(plan.checks[0]!.commands[0]!.temporaryDirectory, true);
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(
    validate(root, { trusted: false, externalAdapters: [reference] }),
    /trust/,
  );
  assert.equal((await createPlan(root)).plan.checks.length, 0);
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      externalAdapters: [reference],
      projects: [{ path: ".", checks: ["external.fixture.whitespace"] }],
    }),
  );
  await assert.rejects(createPlan(root), /externalAdapters/);
  await rm(path.join(root, "checktrail.json"));
  const changed = await bundle(t, sample, { version: "1.0.1" });
  assert.notEqual(
    (await createPlan(root, { externalAdapters: [changed] })).plan
      .policyFingerprint,
    plan.policyFingerprint,
  );
  assert.ok(
    !JSON.stringify(projectPlan(plan, false)).includes(
      path.dirname(reference.path),
    ),
  );
});

test("external bundle integrity rejects altered files, unpinned entries, duplicates, escapes and symbolic links", async (t) => {
  const root = await fixture(t, input);
  const reference = await bundle(t);
  const plan = (ref = reference) =>
    createPlan(root, { externalAdapters: [ref] });
  await assert.rejects(
    plan({ ...reference, sha256: "0".repeat(64) }),
    /integrity/,
  );
  await writeFile(
    path.join(path.dirname(reference.path), "adapter.mjs"),
    sample + "\n",
  );
  await assert.rejects(plan(), /integrity/);
  for (const change of [
    { entry: "other.mjs" },
    { id: "javascript" },
    { files: [{ path: "../escape.mjs", sha256: hash(sample) }] },
    { files: [manifest.files[0], manifest.files[0]] },
    { markers: ["lines.project", "lines.project"] },
    { checks: [manifest.checks[0], manifest.checks[0]] },
    {
      checks: [{ ...manifest.checks[0], scope: { extensions: [], names: [] } }],
    },
    { command: "echo passed" },
  ])
    await assert.rejects(
      createPlan(root, { externalAdapters: [await bundle(t, sample, change)] }),
    );
  const link = await bundle(t);
  const directory = path.dirname(link.path);
  await writeFile(path.join(directory, "actual.mjs"), sample);
  await rm(path.join(directory, "adapter.mjs"));
  await symlink(
    path.join(directory, "actual.mjs"),
    path.join(directory, "adapter.mjs"),
  );
  await assert.rejects(plan(link), /symbolic/);
  await assert.rejects(
    createPlan(root, { externalAdapters: [await bundle(t), await bundle(t)] }),
    /Duplicate external adapter/,
  );
});

test("external Node checks execute verified copies, report broken/fixed text and preserve nested project scope", async (t) => {
  const root = await fixture(t, {
    ...input,
    "nested/lines.project": "nested",
    "nested/other.txt": "East\n",
  });
  const reference = await bundle(t);
  const options = { trusted: true, externalAdapters: [reference] };
  const good = await validate(root, options);
  assert.equal(good.outcome, "passed", JSON.stringify(good));
  assert.deepEqual(
    good.checks.map((check) => check.scope),
    [["value with spaces.txt"], ["other.txt"]],
  );
  assert.ok(
    good.checks.every(
      (check) => check.external?.tools?.[0]?.source === "adapter-reported",
    ),
  );
  await writeFile(path.join(root, "nested/other.txt"), "East \n");
  const bad = await validate(root, options);
  assert.equal(bad.outcome, "failed");
  assert.deepEqual(bad.checks[1]!.findings, [
    {
      ruleId: "external.fixture.whitespace/trailing-whitespace",
      level: "error",
      message: "Remove trailing spaces or tabs",
      file: "nested/other.txt",
      line: 1,
    },
  ]);
  await writeFile(path.join(root, "nested/other.txt"), "East\tbound\n");
  assert.equal((await validate(root, options)).outcome, "passed");
  const leaking = await bundle(t, "import './unlisted.mjs';\n" + sample);
  await writeFile(
    path.join(path.dirname(leaking.path), "unlisted.mjs"),
    "export const marker = 1;",
  );
  assert.notEqual(
    (await validate(root, { trusted: true, externalAdapters: [leaking] }))
      .outcome,
    "passed",
  );
  const changed = await bundle(
    t,
    generic +
      "process.stdout.write(JSON.stringify({...result, entry: import.meta.url}));",
  );
  assert.equal(
    (await validate(root, { trusted: true, externalAdapters: [changed] }))
      .outcome,
    "incomplete",
  );
  assert.ok(
    !JSON.stringify(projectReport(good, false)).includes(reference.path),
  );
});

test("external result accounting rejects omitted files, forged identity, malformed payloads and inconsistent exits", async (t) => {
  const root = await fixture(t, { ...input, "other.txt": "Other\n" });
  const reference = await bundle(t);
  const options = { trusted: true, externalAdapters: [reference] };
  const { plan } = await createPlan(root, options);
  const report = await validate(root, options);
  assert.equal(report.outcome, "passed");
  const process = report.checks[0]!.processes[0]!;
  type Payload = {
    identity: { sha256: string };
    sourceFingerprint: string;
    files: { path: string; status: string }[];
    findingsComplete: boolean;
    findings: unknown[];
    tools: unknown[];
  };
  for (const mutate of [
    (value: Payload) => {
      value.files.pop();
    },
    (value: Payload) => {
      value.files[1] = value.files[0]!;
    },
    (value: Payload) => {
      value.files[0]!.path = "unknown.txt";
    },
    (value: Payload) => {
      value.files[0]!.status = "skipped";
    },
    (value: Payload) => {
      value.identity.sha256 = "0".repeat(64);
    },
    (value: Payload) => {
      value.sourceFingerprint = "0".repeat(64);
    },
    (value: Payload) => {
      value.findingsComplete = false;
    },
    (value: Payload) => {
      value.tools = [];
    },
    (value: Payload) => {
      value.findings = [
        {
          ruleId: "outside",
          level: "error",
          message: "wrong",
          file: "../outside.txt",
        },
      ];
    },
  ]) {
    const envelope = JSON.parse(process.stdout) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    const value = JSON.parse(envelope.stdout) as Payload;
    mutate(value);
    envelope.stdout = JSON.stringify(value);
    assert.equal(
      externalEvidence(plan.checks[0]!, [
        { ...process, stdout: JSON.stringify(envelope) },
      ]).status,
      "inconclusive",
      String(mutate),
    );
  }
  const envelope = JSON.parse(process.stdout) as {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  envelope.exitCode = 1;
  assert.equal(
    externalEvidence(plan.checks[0]!, [
      { ...process, stdout: JSON.stringify(envelope) },
    ]).status,
    "inconclusive",
  );
  envelope.exitCode = 0;
  envelope.stdout = "extra output\n" + envelope.stdout;
  assert.equal(
    externalEvidence(plan.checks[0]!, [
      { ...process, stdout: JSON.stringify(envelope) },
    ]).status,
    "inconclusive",
  );
});

test("external test adapters require non-skipped tests per file and reconcile failure counts", async (t) => {
  const root = await fixture(t, input);
  const declaration = { checks: [{ ...manifest.checks[0], kind: "test" }] };
  for (const [counts, status, exit] of [
    [{ total: 1, passed: 1, failed: 0, skipped: 0 }, "passed", 0],
    [{ total: 0, passed: 0, failed: 0, skipped: 0 }, "inconclusive", 0],
    [{ total: 1, passed: 0, failed: 0, skipped: 1 }, "inconclusive", 0],
    [{ total: 1, passed: 0, failed: 1, skipped: 0 }, "failed", 1],
    [{ total: 2, passed: 1, failed: 0, skipped: 0 }, "inconclusive", 0],
  ] as const) {
    const reference = await bundle(
      t,
      generic +
        `result.files.forEach(file => file.tests = ${JSON.stringify(counts)}); process.stdout.write(JSON.stringify(result)); process.exitCode = ${exit};`,
      declaration,
    );
    const report = await validate(root, {
      trusted: true,
      externalAdapters: [reference],
    });
    assert.equal(report.checks[0]!.status, status, JSON.stringify(report));
  }
});

test(
  "external Python adapters use the same protocol without importing project startup modules",
  { skip: spawnSync("python3", ["--version"]).status !== 0 },
  async (t) => {
    const root = await fixture(t, {
      ...input,
      "json.py": "raise RuntimeError('project shadow must not load')",
    });
    const program = `import json,sys,platform,os,re
request=json.load(open(sys.argv[1]))
findings=[]
files=[]
for file in request['scope']:
    with open(os.path.join(request['root'], request['project'], file)) as source:
        for index,line in enumerate(source):
            if re.search(r'[ \t]+$', line.rstrip('\\r\\n')):
                findings.append(dict(ruleId='trailing-whitespace',level='error',message='Remove trailing spaces or tabs',file=file,line=index+1))
    files.append(dict(path=file,status='checked'))
print(json.dumps(dict(protocolVersion=1,identity=request['identity'],checkId=request['checkId'],sourceFingerprint=request['sourceFingerprint'],files=files,findings=findings,findingsComplete=True,tools=[dict(name='python',version=platform.python_version())])))
sys.exit(1 if findings else 0)
`;
    const reference = await bundle(t, program, { runtime: "python3" });
    const report = await validate(root, {
      trusted: true,
      externalAdapters: [reference],
    });
    assert.equal(report.outcome, "passed", JSON.stringify(report));
    assert.equal(
      report.checks[0]!.tools?.find((tool) => tool.name === "python")?.status,
      "identified",
    );
    await writeFile(path.join(root, "value with spaces.txt"), "North \n");
    const broken = await validate(root, {
      trusted: true,
      externalAdapters: [reference],
    });
    assert.equal(broken.outcome, "failed");
    assert.equal(
      broken.checks[0]!.findings?.[0]?.ruleId,
      "external.fixture.whitespace/trailing-whitespace",
    );
  },
);

test("external artifact changes during execution invalidate findings even outside the project inventory", async (t) => {
  const root = await fixture(t, input);
  const reference = await bundle(t);
  const entry = path.join(path.dirname(reference.path), "adapter.mjs");
  const program =
    generic +
    `await (await import('node:fs/promises')).appendFile(${JSON.stringify(entry)}, '\\n'); process.stdout.write(JSON.stringify(result));`;
  const text = JSON.stringify({
    ...manifest,
    files: [{ path: "adapter.mjs", sha256: hash(program) }],
  });
  await writeFile(entry, program);
  await writeFile(reference.path, text);
  reference.sha256 = hash(text);
  const report = await validate(root, {
    trusted: true,
    externalAdapters: [reference],
  });
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.sourceError, true);
  assert.notEqual(report.checks[0]!.status, "passed");
});

test("external cancellation kills a running adapter child and cleans its verified temporary bundle", async (t) => {
  const root = await fixture(t, input);
  await mkdir(path.join(root, ".checktrail"));
  const ready = path.join(root, ".checktrail/ready.json");
  const marker = path.join(root, ".checktrail/child-ran");
  const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1200);`;
  const program = `import {spawn} from 'node:child_process'; import {writeFile} from 'node:fs/promises'; import process from 'node:process'; const child=spawn(process.execPath,['-e',${JSON.stringify(child)}]); await writeFile(${JSON.stringify(ready)},JSON.stringify({pid:child.pid,temporary:process.env.CHECKTRAIL_TEMP})); setInterval(()=>{},1000);`;
  const reference = await bundle(t, program);
  const controller = new AbortController();
  const running = validate(root, {
    trusted: true,
    externalAdapters: [reference],
    signal: controller.signal,
    timeoutMs: 8000,
  });
  let state: { pid: number; temporary: string } | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        state = JSON.parse(await readFile(ready, "utf8")) as typeof state;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(state, "Adapter must start its child before cancellation");
    process.kill(state.pid, 0);
    controller.abort();
    const report = await running;
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.processes[0]!.cancelled, true);
    await assert.rejects(access(state.temporary));
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await assert.rejects(access(marker));
  } finally {
    controller.abort();
    await running;
    if (state) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
  }
});

test("external CLI references and public example remain pinned and do not grant execution implicitly", async () => {
  const root = fileURLToPath(
    new URL("../../examples/external-adapter/project", import.meta.url),
  );
  const file = fileURLToPath(
    new URL(
      "../../examples/external-adapter/bundle/adapter.json",
      import.meta.url,
    ),
  );
  externalManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const reference = `${file}#sha256=${hash(await readFile(file))}`;
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const invoke = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
  const planned = invoke(["plan", "--root", root, "--adapter", reference]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.ok(!planned.stdout.includes(file));
  assert.equal(
    invoke(["run", "--root", root, "--adapter", reference]).status,
    2,
  );
  const run = invoke([
    "run",
    "--root",
    root,
    "--adapter",
    reference,
    "--trust-project",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).outcome, "passed");
  assert.ok(!run.stdout.includes(file));
  assert.equal(invoke(["plan", "--root", root, "--adapter", file]).status, 2);
});

test("external MCP adapters are startup-only and summary reports omit bundle paths and delegated tool metadata", async (t) => {
  const root = await fixture(t, input);
  const reference = await bundle(t);
  const connect = async (allow: boolean, detailed = false) => {
    const client = new Client(
      { name: "external-fixture-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/cli.js", import.meta.url)),
          "serve",
          "--root",
          root,
          "--adapter",
          `${reference.path}#sha256=${reference.sha256}`,
          ...(allow ? ["--allow-execution"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        stderr: "pipe",
      }),
    );
    return client;
  };
  const readOnly = await connect(false);
  assert.equal(
    (await readOnly.callTool({ name: "validation_plan", arguments: {} }))
      .isError,
    undefined,
  );
  assert.equal(
    (await readOnly.callTool({ name: "validation_run", arguments: {} }))
      .isError,
    true,
  );
  for (const name of ["validation_plan", "validation_run"]) {
    assert.equal(
      (
        await readOnly.callTool({
          name,
          arguments: { externalAdapters: [reference], trusted: true },
        })
      ).isError,
      true,
    );
  }
  const client = await connect(true);
  const result = await client.callTool({
    name: "validation_run",
    arguments: {},
  });
  assert.equal(result.isError, undefined);
  assert.equal(
    reportSummarySchema.parse(result.structuredContent).outcome,
    "passed",
  );
  assert.ok(!JSON.stringify(result).includes(reference.path));
  assert.ok(!JSON.stringify(result).includes("adapter-reported"));
  const detailed = await connect(true, true);
  const report = await detailed.callTool({
    name: "validation_run",
    arguments: {},
  });
  assert.equal(report.isError, undefined);
  assert.ok(JSON.stringify(report).includes("adapter-reported"));
  assert.equal(
    (
      await client.callTool({
        name: "mutation_experiment",
        arguments: { input: "missing.json" },
      })
    ).isError,
    true,
  );
  await writeFile(path.join(root, "value with spaces.txt"), "North \n");
  assert.equal(
    reportSummarySchema.parse(
      (await client.callTool({ name: "validation_run", arguments: {} }))
        .structuredContent,
    ).outcome,
    "failed",
  );
});

test(
  "external PHP adapters report real source findings through the same protocol",
  { skip: spawnSync("php", ["-n", "--version"]).status !== 0 },
  async (t) => {
    const root = await fixture(t, input);
    const program = `<?php
declare(strict_types=1);
$request = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$files = [];
$findings = [];
foreach ($request['scope'] as $file) {
    $text = file_get_contents($request['root'].'/'.$request['project'].'/'.$file);
    if ($text === false) { throw new RuntimeException('Could not read scoped input'); }
    foreach (explode("\\n", $text) as $index => $line) {
        if (preg_match('/[ \\t]+$/', rtrim($line, "\\r"))) {
            $findings[] = ['ruleId' => 'trailing-whitespace', 'level' => 'error', 'message' => 'Remove trailing spaces or tabs', 'file' => $file, 'line' => $index + 1];
        }
    }
    $files[] = ['path' => $file, 'status' => 'checked'];
}
echo json_encode(['protocolVersion' => 1, 'identity' => $request['identity'], 'checkId' => $request['checkId'], 'sourceFingerprint' => $request['sourceFingerprint'], 'files' => $files, 'findings' => $findings, 'findingsComplete' => true, 'tools' => [['name' => 'php', 'version' => PHP_VERSION]]], JSON_THROW_ON_ERROR);
exit(count($findings) ? 1 : 0);
`;
    const reference = await bundle(t, program, { runtime: "php" });
    const options = { trusted: true, externalAdapters: [reference] };
    assert.equal((await validate(root, options)).outcome, "passed");
    await writeFile(path.join(root, "value with spaces.txt"), "North \r\n");
    const broken = await validate(root, options);
    assert.equal(broken.outcome, "failed");
    assert.equal(
      broken.checks[0]!.findings?.[0]?.ruleId,
      "external.fixture.whitespace/trailing-whitespace",
    );
    await writeFile(
      path.join(root, "value with spaces.txt"),
      "North\tbound\r\n",
    );
    assert.equal((await validate(root, options)).outcome, "passed");
  },
);

test("external warnings respect declared failure levels and protected environment values cannot be overwritten", async (t) => {
  const root = await fixture(t, input);
  for (const [failOn, exitCode, status] of [
    ["error", 0, "passed"],
    ["warning", 1, "failed"],
    ["warning", 0, "inconclusive"],
  ] as const) {
    const reference = await bundle(
      t,
      generic +
        `result.findings.push({ruleId:'example',level:'warning',message:'example warning'}); process.stdout.write(JSON.stringify(result)); process.exitCode=${exitCode};`,
      { checks: [{ ...manifest.checks[0], failOn }] },
    );
    assert.equal(
      (await validate(root, { trusted: true, externalAdapters: [reference] }))
        .checks[0]!.status,
      status,
    );
  }
  const reference = await bundle(t);
  for (const name of ["PATH", "NODE_OPTIONS", "CHECKTRAIL_TEMP"]) {
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["external.fixture.whitespace"],
            environment: [name],
          },
        ],
      }),
    );
    await assert.rejects(
      createPlan(root, {
        externalAdapters: [reference],
        environment: { [name]: "override" },
      }),
      /protected/,
    );
  }
});

test(
  "compiled native adapters report real broken and fixed source through the same protocol",
  { skip: spawnSync("go", ["version"]).status !== 0, timeout: 60000 },
  async (t) => {
    const root = await fixture(t, input);
    const directory = await fixture(t, {});
    const binary = path.join(directory, "adapter");
    const source = fileURLToPath(
      new URL(
        "../../examples/external-adapter/native/adapter.go",
        import.meta.url,
      ),
    );
    const build = spawnSync(
      "go",
      ["build", "-trimpath", "-buildvcs=false", "-o", binary, source],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 45000,
        env: {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOPROXY: "off",
          GOSUMDB: "off",
          GOENV: "off",
          GOFLAGS: "",
          GOWORK: "off",
          CGO_ENABLED: "0",
        },
      },
    );
    assert.equal(build.status, 0, build.stderr);
    const text = JSON.stringify({
      ...manifest,
      runtime: "native",
      entry: "adapter",
      files: [{ path: "adapter", sha256: hash(await readFile(binary)) }],
    });
    const reference = {
      path: path.join(directory, "adapter.json"),
      sha256: hash(text),
    };
    await writeFile(reference.path, text);
    const options = { trusted: true, externalAdapters: [reference] };
    const good = await validate(root, options);
    assert.equal(good.outcome, "passed", JSON.stringify(good));
    assert.match(good.checks[0]!.external!.tools![0]!.version, /^go/);
    await writeFile(path.join(root, "value with spaces.txt"), "North \r\n");
    const broken = await validate(root, options);
    assert.equal(broken.outcome, "failed");
    assert.equal(
      broken.checks[0]!.findings?.[0]?.ruleId,
      "external.fixture.whitespace/trailing-whitespace",
    );
    await writeFile(
      path.join(root, "value with spaces.txt"),
      "North\tbound\r\n",
    );
    assert.equal((await validate(root, options)).outcome, "passed");
  },
);
