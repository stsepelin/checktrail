import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
import { parse } from "yaml";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const phaseModule = () =>
  import(
    new URL("../../scripts/scala-native-ci-phases.mjs", import.meta.url).href
  );
const profiles = async () =>
  JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
const childEnvironment = () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

test("Scala extension phase selection rejects extra and unknown arguments before Docker or npm probing", async () => {
  const { selectScalaNativeCiPhase, scalaNativeCiPhases } = await phaseModule();
  assert.equal(selectScalaNativeCiPhase([]), undefined);
  assert.deepEqual(scalaNativeCiPhases, [
    "baseline",
    "source",
    "installed",
    "guards",
  ]);
  for (const phase of scalaNativeCiPhases)
    assert.equal(selectScalaNativeCiPhase(["--phase", phase]), phase);
  for (const args of [
    ["source"],
    ["--phase"],
    ["--phase", "all"],
    ["--phase", "Source"],
    ["--phase", "source-control"],
    ["--phase", "source", "guards"],
    ["--phase", "source", "--phase", "source"],
    ["--unknown"],
  ]) {
    assert.throws(
      () => selectScalaNativeCiPhase(args),
      /Unknown Scala extension CI phase/,
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(repository, "scripts/verify-scala-extensions-container.mjs"),
        ...args,
      ],
      {
        env: { ...childEnvironment(), CHECKTRAIL_SCALA_EXTENSIONS_IMAGE: "" },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown Scala extension CI phase selection/);
    assert.doesNotMatch(
      result.stderr,
      /Select the operator|spawnSync docker|spawnSync npm/,
    );
  }
});

test("Scala source fragments retain the exact original eight callbacks and reject changed nine-case metadata", async () => {
  const { selectScalaExtensionSourceRequirements } = await phaseModule();
  const required = (await profiles())["scala-extensions"];
  const selected = selectScalaExtensionSourceRequirements(required);
  assert.deepEqual(selected, required.slice(0, 8));
  assert.equal(required[8].name, "scala-extensions installed acceptance");
  for (const changed of [
    required.slice(1),
    [...required, required[0]],
    [required[0], ...required.slice(0, 8)],
    required.map((item: { file: string; name: string }, index: number) =>
      index === 0 ? { ...item, file: "dist/test/stale-scala.test.js" } : item,
    ),
    required.map((item: { file: string; name: string }, index: number) =>
      index === 3 ? { ...item, name: item.name + "-extra" } : item,
    ),
    [...required.slice(0, 7), required[8], required[7]],
  ])
    assert.throws(
      () => selectScalaExtensionSourceRequirements(changed),
      /all nine original callbacks/,
    );
});

async function sourceFixture(
  t: Parameters<typeof fixture>[0],
  scenario: string,
) {
  const required = (await profiles())["scala-extensions"];
  const callbacks = required.map((item: { name: string }, index: number) => {
    if (index === 8)
      return `test(${JSON.stringify(item.name)},()=>{throw Error('The nested installed callback must never run in a source fragment')});`;
    if (index === 0 && scenario === "missing") return "";
    const body =
      index === 0 && scenario === "failed"
        ? "throw Error('Original synthetic failure');"
        : index === 0 && scenario === "source-changed"
          ? "await appendFile(new URL(import.meta.url),'\\n// changed source\\n');"
          : index === 0 && scenario === "engine-changed"
            ? "await writeFile(new URL('../src/entry.js',import.meta.url),'export const changed = true;\\n');"
            : "";
    const options =
      index === 0 && scenario === "skipped"
        ? "{skip:'unavailable'},"
        : index === 0 && scenario === "todo"
          ? "{todo:true},"
          : "";
    const callback = `test(${JSON.stringify(item.name)},${options}async()=>{await appendFile(new URL('../../workers.jsonl',import.meta.url),JSON.stringify({pid:process.pid,name:${JSON.stringify(item.name)}})+'\\n');${body}});`;
    return index === 0 && scenario === "duplicate"
      ? callback + callback
      : callback;
  });
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "scripts/required-native-tests.json": JSON.stringify({
      "scala-extensions": required,
    }),
    "dist/src/entry.js": "export const original = true;\n",
    "dist/test/gate-scala-extensions.test.js":
      "import{test}from'node:test';import{appendFile,writeFile}from'node:fs/promises';" +
      callbacks.join("\n"),
  });
  for (const name of [
    "scala-native-ci-phases.mjs",
    "required-test-evidence.mjs",
    "compiled-engine-evidence.mjs",
  ])
    await cp(
      path.join(repository, "scripts", name),
      path.join(root, "scripts", name),
    );
  const result = spawnSync(
    process.execPath,
    ["scripts/scala-native-ci-phases.mjs", "--source"],
    {
      cwd: root,
      env: childEnvironment(),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1048576,
    },
  );
  assert.equal(result.error, undefined);
  return { root, result, required };
}

test("Scala source fragment runs eight fresh serial named processes with terminal source and compiled engine evidence", async (t) => {
  const { root, result, required } = await sourceFixture(t, "valid");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.required, 8);
  assert.equal(report.passed, 8);
  assert.equal(report.requiredCaseWorkerLimit, 1);
  assert.equal(report.timeoutMs, 600000);
  assert.equal(
    report.timeoutScope,
    "one fresh process per required named case",
  );
  assert.equal(report.selectedCohortComplete, true);
  assert.equal(report.phaseComplete, true);
  assert.equal(report.complete, false);
  assert.equal(report.wholeProfileComplete, false);
  assert.equal(report.fullProfileRequired, 9);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ledger.truncated, false);
  assert.equal(report.ledger.files.length, 1);
  assert.equal(report.ledger.files[0].stable, true);
  assert.equal(
    report.ledger.files[0].before.sha256,
    report.ledger.files[0].after.sha256,
  );
  assert.deepEqual(
    report.ledger.cases.map((item: { name: string; outcome: string }) => [
      item.name,
      item.outcome,
    ]),
    required.slice(0, 8).map((item: { name: string }) => [item.name, "passed"]),
  );
  assert.ok(
    report.ledger.cases.every(
      (item: { terminalSequences: number[] }) =>
        item.terminalSequences.length === 1,
    ),
  );
  assert.equal(report.compiledEngine.beforeAfterByteIdentitiesMatch, true);
  assert.equal(
    report.compiledEngine.treeSha256,
    report.compiledEngine.afterTreeSha256,
  );
  const workers = (await readFile(path.join(root, "workers.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(new Set(workers.map((worker) => worker.pid)).size, 8);
  assert.deepEqual(
    workers.map((worker) => worker.name),
    required.slice(0, 8).map((item: { name: string }) => item.name),
  );
});

test("Scala source fragments refuse absent duplicate failed skipped todo and stale source or engine evidence", async (t) => {
  for (const scenario of [
    "missing",
    "duplicate",
    "failed",
    "skipped",
    "todo",
    "source-changed",
    "engine-changed",
  ]) {
    const { result } = await sourceFixture(t, scenario);
    assert.equal(result.status, 1, scenario + result.stdout + result.stderr);
    assert.equal(result.stdout, "", scenario);
    assert.match(
      result.stderr,
      /AssertionError|Compiled engine bytes changed/,
      scenario,
    );
  }
});

test("Scala native phase admission retains baseline regressions Java warning guards and installed obligations without whole qualification", async () => {
  const { runScalaNativeCiPhase, scalaNativeCiPhases } = await phaseModule();
  const requirements = await profiles();
  const matchingEngine = { beforeAfterByteIdentitiesMatch: true };
  const receipts = {
    baseline: {
      baseline: {
        complete: true,
        required: requirements.scala.length + requirements.java.length,
      },
      regressions: { tests: 4, passed: 4, failed: 0, skipped: 0 },
      installedJavaWarningPolicy: { acceptance: { complete: true, passed: 1 } },
    },
    source: {
      source: {
        required: 8,
        passed: 8,
        selectedCohortComplete: true,
        phaseComplete: true,
        complete: false,
        wholeProfileComplete: false,
        compiledEngine: matchingEngine,
      },
    },
    installed: {
      installed: {
        profile: {
          required: 9,
          passed: 9,
          complete: true,
          compiledEngine: matchingEngine,
        },
        offlineProductionInstall: true,
        lifecycleScriptsExecuted: false,
        harnessOutsideInstalledPackage: true,
      },
    },
    guards: {
      guards: {
        controls: Array.from({ length: 13 }, () => ({
          originalPassed: true,
          mutantCompiled: true,
          mutantFailedAssertion: true,
          restoredPassed: true,
        })),
        allComplete: true,
      },
    },
  };
  for (const phase of scalaNativeCiPhases) {
    const reached: string[] = [];
    const handlers = Object.fromEntries(
      Object.entries(receipts).map(([name, receipt]) => [
        name,
        () => {
          reached.push(name);
          return receipt;
        },
      ]),
    );
    const result = await runScalaNativeCiPhase(phase, handlers, requirements);
    assert.deepEqual(reached, [phase]);
    assert.equal(result.phase, phase);
    assert.equal(result.phaseComplete, true);
    assert.equal(result.complete, false);
    assert.equal(result.wholeProfileComplete, false);
  }
  const invalid: Array<[string, unknown]> = [
    [
      "baseline",
      {
        ...receipts.baseline,
        regressions: { tests: 4, passed: 3, failed: 0, skipped: 1 },
      },
    ],
    [
      "baseline",
      {
        ...receipts.baseline,
        installedJavaWarningPolicy: {
          acceptance: { complete: false, passed: 1 },
        },
      },
    ],
    ["source", { source: { ...receipts.source.source, phaseComplete: false } }],
    ["source", { source: { ...receipts.source.source, complete: true } }],
    [
      "installed",
      {
        installed: {
          ...receipts.installed.installed,
          offlineProductionInstall: false,
        },
      },
    ],
    [
      "installed",
      {
        installed: {
          ...receipts.installed.installed,
          harnessOutsideInstalledPackage: false,
        },
      },
    ],
    [
      "installed",
      {
        installed: {
          ...receipts.installed.installed,
          profile: { ...receipts.installed.installed.profile, passed: 8 },
        },
      },
    ],
    ["guards", { guards: { ...receipts.guards.guards, controls: [] } }],
    ...[
      "originalPassed",
      "mutantCompiled",
      "mutantFailedAssertion",
      "restoredPassed",
    ].map((key): [string, unknown] => [
      "guards",
      {
        guards: {
          ...receipts.guards.guards,
          controls: receipts.guards.guards.controls.map((item, index) =>
            index === 12 ? { ...item, [key]: false } : item,
          ),
        },
      },
    ]),
  ];
  for (const [phase, receipt] of invalid)
    await assert.rejects(
      runScalaNativeCiPhase(phase, { [phase]: () => receipt }, requirements),
    );
  let reached = false;
  await assert.rejects(
    runScalaNativeCiPhase(
      "unknown",
      {
        unknown: () => {
          reached = true;
        },
      },
      requirements,
    ),
  );
  assert.equal(reached, false);
});

test("Scala wrapper dispatches each independent container phase and preserves the full default cohort and limits", async (t) => {
  const required = await profiles();
  const engine = { beforeAfterByteIdentitiesMatch: true };
  const source = {
    required: 8,
    passed: 8,
    selectedCohortComplete: true,
    phaseComplete: true,
    complete: false,
    wholeProfileComplete: false,
    compiledEngine: engine,
  };
  const installed = {
    profile: { required: 9, passed: 9, complete: true, compiledEngine: engine },
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
  };
  const responses = {
    runtime: {
      node: { version: "v22.23.2", platform: "linux", arch: "arm64" },
      selectedNativeArtifacts: Array(4).fill({}),
      selectedLibraries: Array(14).fill({ byteVerified: true }),
    },
    baseline: {
      required: required.scala.length + required.java.length,
      complete: true,
    },
    source,
    legacySource: { required: 9, passed: 9, complete: true },
    installed,
    warning: { acceptance: { complete: true, passed: 1 } },
    guards: {
      controls: Array.from({ length: 13 }, () => ({
        originalPassed: true,
        mutantCompiled: true,
        mutantFailedAssertion: true,
        restoredPassed: true,
      })),
      allComplete: true,
    },
  };
  const shim = `import{appendFileSync}from'node:fs';import process from'node:process';
const responses=${JSON.stringify(responses)};
const badPath=process.env.CHECKTRAIL_SYNTHETIC_BAD_PATH;
if(badPath){const keys=badPath.split('.'),last=keys.pop(),target=keys.reduce((value,key)=>value[key],responses);target[last]=typeof target[last]==='boolean'?false:target[last]-1;}
function answer(command,args){appendFileSync(process.env.CHECKTRAIL_SYNTHETIC_CALLS,JSON.stringify({command,args})+'\\n');
if(command==='npm')return '/tmp/synthetic-prepared-cache\\n';
if(command!=='docker')throw Error('Unexpected synthetic executable');
if(args[0]==='image')return 'sha256:'+'a'.repeat(64)+'\\n';
const text=args.join(' ');let value;
if(args.includes('--input-type=module'))value=responses.runtime;
else if(text.includes('CHECKTRAIL_SCALA_INSTALL_RECEIPT='))return JSON.stringify({prepared:true})+'\\n'+JSON.stringify(responses.legacySource)+'\\n'+JSON.stringify(responses.installed)+'\\n';
else if(text.includes('verify-jvm-java-warning-package.mjs'))value=responses.warning;
else if(text.includes('verify-scala-extensions-guards.mjs'))value=responses.guards;
else if(text.includes('verify-import-context-package.mjs'))return JSON.stringify({prepared:true})+'\\n'+JSON.stringify(responses.installed)+'\\n';
else if(text.includes('scripts/scala-native-ci-phases.mjs --source'))value=responses.source;
else if(text.includes('scripts/verify-required-native-tests.mjs scala java'))value=responses.baseline;
else if(text.includes('dist/test/scala-extension-regressions.test.js')){let tap='# tests 4\\n# pass 4\\n# fail 0\\n# skipped 0\\n';const bad=process.env.CHECKTRAIL_SYNTHETIC_BAD_TAP;if(bad)tap=tap.replace(new RegExp('# '+bad+' [0-9]+'),'# '+bad+' 99');return tap;}
else throw Error('Unexpected synthetic Docker invocation: '+text);
return JSON.stringify(value)+'\\n';}
export const execFileSync=answer;
export function execFile(){}
execFile[Symbol.for('nodejs.util.promisify.custom')]=async(command,args)=>({stdout:answer(command,args)});`;
  const root = await fixture(t, {
    "scripts/required-native-tests.json": JSON.stringify(required),
    "observe.mjs": `import{registerHooks}from'node:module';const shim=${JSON.stringify("data:text/javascript," + encodeURIComponent(shim))};registerHooks({resolve(specifier,context,next){return specifier==='node:child_process'?{url:shim,shortCircuit:true}:next(specifier,context)}});`,
  });
  for (const name of [
    "verify-scala-extensions-container.mjs",
    "scala-native-ci-phases.mjs",
    "required-test-evidence.mjs",
    "compiled-engine-evidence.mjs",
  ])
    await cp(
      path.join(repository, "scripts", name),
      path.join(root, "scripts", name),
    );
  for (const phase of [
    undefined,
    "baseline",
    "source",
    "installed",
    "guards",
  ]) {
    const callsFile = path.join(root, `calls-${phase ?? "default"}.jsonl`);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./observe.mjs",
        "scripts/verify-scala-extensions-container.mjs",
        ...(phase ? ["--phase", phase] : []),
      ],
      {
        cwd: root,
        env: {
          ...childEnvironment(),
          CHECKTRAIL_SCALA_EXTENSIONS_IMAGE: "synthetic-pinned-image",
          CHECKTRAIL_SYNTHETIC_CALLS: callsFile,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.complete, phase === undefined);
    assert.equal(report.maxConcurrentContainers, phase === undefined ? 2 : 1);
    assert.equal(report.environment.cpus, phase === undefined ? 2 : 4);
    assert.equal(
      report.aggregateLimits.memoryMiB,
      phase === undefined ? 4096 : 2048,
    );
    if (phase) {
      assert.equal(report.phase, phase);
      assert.equal(report.phaseComplete, true);
      assert.equal(report.wholeProfileComplete, false);
    }
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as { command: string; args: string[] }[];
    assert.equal(calls.filter((call) => call.command === "npm").length, 1);
    const containers = calls.filter(
      (call) => call.command === "docker" && call.args[0] === "run",
    );
    assert.equal(
      containers.length,
      phase === undefined ? 6 : phase === "baseline" ? 4 : 2,
    );
    for (const { args } of containers) {
      assert.equal(
        args[args.indexOf("--cpus") + 1],
        phase === undefined ? "2" : "4",
      );
      assert.equal(args[args.indexOf("--memory") + 1], "2g");
      assert.equal(args[args.indexOf("--pids-limit") + 1], "256");
      assert.equal(
        args[args.indexOf("--tmpfs") + 1],
        "/tmp:rw,nosuid,nodev,exec,size=1024m",
      );
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.ok(args.includes("--read-only"));
      assert.equal(args.filter((arg) => arg.endsWith(",readonly")).length, 2);
    }
    const commands = containers.slice(1).map((call) => call.args.join(" "));
    assert.equal(
      commands.filter((command) =>
        command.includes("verify-required-native-tests.mjs scala java"),
      ).length,
      !phase || phase === "baseline" ? 1 : 0,
    );
    assert.equal(
      commands.filter((command) =>
        command.includes("scala-extension-regressions.test.js"),
      ).length,
      !phase || phase === "baseline" ? 1 : 0,
    );
    assert.equal(
      commands.filter((command) =>
        command.includes("verify-jvm-java-warning-package.mjs scala"),
      ).length,
      !phase || phase === "baseline" ? 1 : 0,
    );
    assert.equal(
      commands.filter((command) =>
        command.includes("verify-scala-extensions-guards.mjs"),
      ).length,
      !phase || phase === "guards" ? 1 : 0,
    );
    assert.equal(
      commands.filter((command) =>
        command.includes("scala-native-ci-phases.mjs --source"),
      ).length,
      phase === "source" ? 1 : 0,
    );
    assert.equal(
      commands.filter((command) =>
        command.includes(
          "CHECKTRAIL_IMPORT_CONTEXT_PROFILE=scala-extensions node scripts/verify-import-context-package.mjs",
        ),
      ).length,
      phase === "installed" ? 1 : 0,
    );
    assert.equal(
      commands.filter((command) =>
        command.includes("CHECKTRAIL_SCALA_INSTALL_RECEIPT="),
      ).length,
      phase === undefined ? 1 : 0,
    );
  }
  // Exercise the original full-mode assertions as well as the new dispatcher.
  // Each damaged field must fail before the wrapper emits a complete receipt.
  for (const badPath of [
    "baseline.required",
    "baseline.complete",
    "legacySource.required",
    "legacySource.passed",
    "legacySource.complete",
    "installed.profile.required",
    "installed.profile.passed",
    "installed.profile.complete",
    "warning.acceptance.complete",
    "warning.acceptance.passed",
    "guards.controls.length",
    "guards.allComplete",
    "guards.controls.12.originalPassed",
    "guards.controls.12.mutantCompiled",
    "guards.controls.12.mutantFailedAssertion",
    "guards.controls.12.restoredPassed",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./observe.mjs",
        "scripts/verify-scala-extensions-container.mjs",
      ],
      {
        cwd: root,
        env: {
          ...childEnvironment(),
          CHECKTRAIL_SCALA_EXTENSIONS_IMAGE: "synthetic-pinned-image",
          CHECKTRAIL_SYNTHETIC_CALLS: path.join(root, "failed-calls.jsonl"),
          CHECKTRAIL_SYNTHETIC_BAD_PATH: badPath,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, badPath + result.stdout + result.stderr);
    assert.equal(result.stdout, "", badPath);
    assert.match(result.stderr, /Required Scala native stages failed/, badPath);
  }
  for (const badTap of ["tests", "pass", "fail", "skipped"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./observe.mjs",
        "scripts/verify-scala-extensions-container.mjs",
        "--phase",
        "baseline",
      ],
      {
        cwd: root,
        env: {
          ...childEnvironment(),
          CHECKTRAIL_SCALA_EXTENSIONS_IMAGE: "synthetic-pinned-image",
          CHECKTRAIL_SYNTHETIC_CALLS: path.join(root, "failed-calls.jsonl"),
          CHECKTRAIL_SYNTHETIC_BAD_TAP: badTap,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, badTap + result.stdout + result.stderr);
    assert.equal(result.stdout, "", badTap);
    assert.match(result.stderr, /AssertionError/, badTap);
  }
});

test("Scala extension CI requires every native phase and keeps fresh installed verification independent", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const job = workflow.jobs["scala-extensions-arm64"];
  assert.deepEqual(job.strategy.matrix, {
    phase: ["baseline", "source", "installed", "guards"],
  });
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.strategy["max-parallel"], 4);
  assert.deepEqual(job.needs, ["ci-plan", "actionlint"]);
  assert.match(job.if, /selected\['scala-extensions-arm64'\]/);
  assert.equal(job["runs-on"], "ubuntu-24.04-arm");
  assert.ok(
    workflow.jobs["ci-complete"].needs.includes("scala-extensions-arm64"),
  );
  const native = job.steps.filter((step: { run?: string }) =>
    step.run?.includes("scripts/verify-scala-extensions-container.mjs"),
  );
  assert.equal(native.length, 1);
  assert.equal(
    native[0].run,
    'node scripts/verify-scala-extensions-container.mjs --phase "${{ matrix.phase }}"',
  );
  assert.equal(native[0].if, undefined);
  assert.equal(native[0]["continue-on-error"], undefined);
});
