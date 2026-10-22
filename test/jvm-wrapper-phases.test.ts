import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { fixture } from "./helpers.js";
const {
  jvmWrapperPhases,
  jvmWrapperPhaseSummary,
  jvmWrapperSourceIdentity,
  requireJvmWrapperPhaseOutputs,
  selectJvmWrapperPhases,
} = await import(
  new URL("../../scripts/jvm-wrapper-phase-evidence.mjs", import.meta.url).href
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const controller = path.join(root, "scripts/verify-jvm-wrappers-container.mjs");
const fakeImage = "sha256:" + "a".repeat(64);

interface RoutingReport {
  phase: string;
  phaseComplete: boolean;
  allPhasesComplete: boolean;
  baseline?: { required: number };
  source?: { passed: number };
  installed?: { profile: { passed: number } };
  guards?: { controls: unknown[] };
  regressions?: { passed: number };
  summary?: { phase: string };
}
interface PhaseSummary {
  phase: string;
  complete: boolean;
  bindings: Record<string, string>;
  obligations: Record<string, string | number | boolean>;
  ci: { run: string; attempt: number; sha: string };
}
interface RoutingTrace {
  file: string;
  args: string[];
  options: { timeout?: number; maxBuffer?: number };
}

// These are process-routing controls. Only the real pinned native runs can
// establish the acceptance results represented by these synthetic responses.
const preload = `const fs=require('node:fs');const cp=require('node:child_process');const original=cp.execFileSync;const image='sha256:'+'a'.repeat(64);const failure=process.env.JVM_FAKE_FAILURE;
cp.execFileSync=(file,args,options={})=>{
 fs.appendFileSync(process.env.JVM_FAKE_TRACE,JSON.stringify({file,args,options})+'\\n');
 if(file==='git')return original(file,args,options);
 if(file==='npm'&&JSON.stringify(args)===JSON.stringify(['config','get','cache']))return process.env.JVM_FAKE_CACHE+'\\n';
 if(file!=='docker')throw Error('Unexpected executable '+file);
 if(JSON.stringify(args)===JSON.stringify(['image','inspect',process.env.CHECKTRAIL_JVM_WRAPPERS_IMAGE,'--format','{{.Id}}']))return image+'\\n';
 if(args[0]!=='run')throw Error('Unexpected Docker query');
 const child=args.slice(args.indexOf(image)+1);let result;
 if(child[0]==='node'&&child[1]==='--input-type=module')result={node:{version:failure==='runtime'?'v24.0.0':'v22.23.2',platform:'linux',arch:'arm64',bytes:42,sha256:'b'.repeat(64)},java:'Temurin-25.0.4+7',selectedNativeArtifacts:Array(4).fill({byteVerified:true}),wrapperArtifacts:Array(8).fill({byteVerified:true}),archiveArtifacts:Array(2).fill({byteVerified:true}),os:'synthetic runtime'};
 else if(JSON.stringify(child)===JSON.stringify(['node','scripts/verify-jvm-preparation-ownership.mjs']))result={positiveComplete:true,rootOwnedNegativeReproduced:failure!=='ownership'};
 else if(JSON.stringify(child)===JSON.stringify(['node','scripts/verify-required-native-tests.mjs','java','maven','gradle']))result={required:29,passed:29,complete:failure!=='baseline'};
 else if(child[0]==='/bin/sh'&&child[1]==='-c'&&child[2].includes('CHECKTRAIL_JVM_INSTALL_RECEIPT=/tmp/installed-receipt.json'))return [JSON.stringify({prepared:true}),JSON.stringify({required:9,passed:failure==='source'?8:9,complete:true}),JSON.stringify({profile:{required:9,passed:9,complete:true},offlineProductionInstall:failure!=='offline',harnessOutsideInstalledPackage:failure!=='harness'})].join('\\n')+'\\n';
 else if(child[0]==='/bin/sh'&&child[1]==='-c'&&child[2].includes('capture-jvm-wrapper-guards.mjs'))return [JSON.stringify({nativeReceipts:2}),JSON.stringify({controls:Array.from({length:21},(_,i)=>({id:'guard-'+i,originalPassed:true,mutantCompiled:true,mutantFailedAssertion:!(failure==='guard'&&i===20),restoredPassed:true}))})].join('\\n')+'\\n';
 else if(JSON.stringify(child)===JSON.stringify(['node','--test','--test-reporter=tap','--test-concurrency=1','dist/test/jvm-wrappers.test.js','dist/test/schemas.test.js']))return '# tests 13\\n# pass 13\\n# fail 0\\n# skipped '+(failure==='regressions'?1:0)+'\\n';
 else throw Error('Unexpected native command '+JSON.stringify(child));
 return JSON.stringify(result)+'\\n';};require('node:module').syncBuiltinESMExports();`;

async function invoke(
  t: TestContext,
  args: string[],
  { failure = "", hosted = false }: { failure?: string; hosted?: boolean } = {},
) {
  const temporary = await fixture(t, {
    "preload.cjs": preload,
    "trace.jsonl": "",
    "outputs.txt": "",
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    GITHUB_ACTIONS: hosted ? "true" : "false",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_JOB: "jvm-wrappers-arm64",
    GITHUB_OUTPUT: path.join(temporary, "outputs.txt"),
    CHECKTRAIL_JVM_WRAPPERS_IMAGE: "synthetic-jvm-image",
    CHECKTRAIL_TEST_TASK: "jvm-phase-routing-fixture",
    JVM_FAKE_TRACE: path.join(temporary, "trace.jsonl"),
    JVM_FAKE_CACHE: temporary,
    JVM_FAKE_FAILURE: failure,
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--require", path.join(temporary, "preload.cjs"), controller, ...args],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1048576,
    },
  );
  const trace = (await readFile(path.join(temporary, "trace.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RoutingTrace);
  const outputs = Object.fromEntries(
    (await readFile(path.join(temporary, "outputs.txt"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const equals = line.indexOf("=");
        return [line.slice(0, equals), line.slice(equals + 1)];
      }),
  );
  return { result, trace, outputs };
}

test("JVM phase arguments select the complete default or one exact bounded phase", () => {
  assert.deepEqual(selectJvmWrapperPhases([]), [
    "baseline",
    "acceptance",
    "guards-regressions",
  ]);
  assert.deepEqual(selectJvmWrapperPhases(["all"]), [
    "baseline",
    "acceptance",
    "guards-regressions",
  ]);
  for (const phase of ["baseline", "acceptance", "guards-regressions"])
    assert.deepEqual(selectJvmWrapperPhases([phase]), [phase]);
  for (const args of [
    ["Baseline"],
    ["baseline "],
    ["--phase=baseline"],
    ["guard-regressions"],
    ["all", "baseline"],
  ])
    assert.throws(() => selectJvmWrapperPhases(args));
});

test("actual JVM entrypoint rejects unknown or extra phase arguments before any child query", async (t) => {
  for (const args of [["unknown"], ["baseline", "extra"]]) {
    const { result, trace, outputs } = await invoke(t, args);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Unknown JVM wrapper phase|at most one JVM phase/,
    );
    assert.deepEqual(trace, []);
    assert.deepEqual(outputs, {});
  }
});

test("actual JVM phase routing preserves every default command and all native resource limits", async (t) => {
  const observed = new Map<
    string,
    { report: RoutingReport; children: string[][] }
  >();
  for (const args of [
    [],
    ["baseline"],
    ["acceptance"],
    ["guards-regressions"],
  ]) {
    const { result, trace } = await invoke(t, args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as RoutingReport;
    const runs = trace.filter(
      (entry) => entry.file === "docker" && entry.args[0] === "run",
    );
    for (const run of runs) {
      for (const [flag, value] of [
        ["--network", "none"],
        ["--cpus", "2"],
        ["--memory", "4g"],
        ["--pids-limit", "256"],
        ["--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=2048m"],
      ])
        assert.equal(run.args[run.args.indexOf(flag!) + 1], value);
      assert.ok(run.args.includes("--read-only"));
      assert.equal(run.options.timeout, 1200000);
      assert.equal(run.options.maxBuffer, 4 * 1048576);
      const mounts = run.args.filter(
        (_: string, index: number) => run.args[index - 1] === "--mount",
      );
      assert.equal(mounts.length, 2);
      assert.ok(mounts.every((mount: string) => mount.endsWith(",readonly")));
    }
    observed.set(args[0] ?? "all", {
      report,
      children: runs.map((run) =>
        run.args.slice(run.args.indexOf(fakeImage) + 1),
      ),
    });
  }
  const all = observed.get("all")!;
  assert.equal(all.report.phase, "all");
  assert.equal(all.report.allPhasesComplete, true);
  assert.equal(all.report.baseline!.required, 29);
  assert.equal(all.report.source!.passed, 9);
  assert.equal(all.report.installed!.profile.passed, 9);
  assert.equal(all.report.guards!.controls.length, 21);
  assert.equal(all.report.regressions!.passed, 13);
  const union: string[][] = [all.children[0]!];
  for (const phase of ["baseline", "acceptance", "guards-regressions"]) {
    const entry = observed.get(phase)!;
    assert.equal(entry.report.phaseComplete, true);
    assert.equal(entry.report.allPhasesComplete, false);
    assert.equal(entry.report.summary!.phase, phase);
    assert.deepEqual(entry.children[0], all.children[0]);
    union.push(...entry.children.slice(1));
  }
  assert.deepEqual(union, all.children);
  assert.equal(observed.get("baseline")!.report.source, undefined);
  assert.equal(observed.get("acceptance")!.report.guards, undefined);
  assert.equal(observed.get("guards-regressions")!.report.installed, undefined);
});

test("JVM phase failures cannot publish a successful phase or combined CI output", async (t) => {
  for (const [phase, failure] of [
    ["baseline", "ownership"],
    ["baseline", "baseline"],
    ["acceptance", "source"],
    ["acceptance", "offline"],
    ["acceptance", "harness"],
    ["guards-regressions", "guard"],
    ["guards-regressions", "regressions"],
    ["all", "runtime"],
    ["all", "offline"],
  ]) {
    const { result, outputs } = await invoke(t, [phase!], {
      failure: failure!,
      hosted: true,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, phase + ":" + failure);
    assert.equal(result.stdout, "");
    assert.deepEqual(outputs, {});
    assert.match(result.stderr, /AssertionError/);
  }
});

test("CI JVM completion requires all source-bound phase outputs and permits retained successful attempts only within the same run", async (t) => {
  let outputs: Record<string, string> = {};
  for (const phase of jvmWrapperPhases) {
    const observed = await invoke(t, [phase], { hosted: true });
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(Object.keys(observed.outputs).length, 1);
    outputs = { ...outputs, ...observed.outputs };
  }
  const source = (await jvmWrapperSourceIdentity(root)).sha256;
  const expected = {
    source,
    ci: { run: "12345", attempt: 2, sha: "a".repeat(40) },
  };
  assert.equal(requireJvmWrapperPhaseOutputs(outputs, expected).complete, true);
  const plan = {
    mode: "full",
    selected: { "jvm-wrappers-arm64": true },
    notSelected: [],
  };
  const needs = Object.fromEntries(
    ["ci-plan", "checks", "host-validation", "jvm-wrappers-arm64"].map((id) => [
      id,
      {
        result: "success",
        ...(id === "jvm-wrappers-arm64" ? { outputs } : {}),
      },
    ]),
  );
  const completion = (selectedOutputs: Record<string, string>) => {
    const env = {
      ...process.env,
      NODE_OPTIONS: "",
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: expected.ci.run,
      GITHUB_RUN_ATTEMPT: String(expected.ci.attempt),
      GITHUB_SHA: expected.ci.sha,
      GITHUB_JOB: "ci-complete",
      CHECKTRAIL_CI_PLAN: JSON.stringify(plan),
      CHECKTRAIL_CI_NEEDS: JSON.stringify({
        ...needs,
        "jvm-wrappers-arm64": { result: "success", outputs: selectedOutputs },
      }),
    };
    return spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-ci-completion.mjs")],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30000,
      },
    );
  };
  const complete = completion(outputs);
  assert.equal(complete.error, undefined);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).jvmWrapperPhases.complete, true);
  const incomplete = { ...outputs };
  delete incomplete.jvm_acceptance;
  const rejected = completion(incomplete);
  assert.equal(rejected.error, undefined);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /AssertionError/);
  assert.equal(
    rejected.stdout,
    "",
    "An aggregate cannot publish completion before checking all phase receipts",
  );
  for (const key of Object.keys(outputs)) {
    const missing = { ...outputs };
    delete missing[key];
    assert.throws(() => requireJvmWrapperPhaseOutputs(missing, expected));
  }
  for (const [key, change] of [
    [
      "jvm_baseline",
      (value: PhaseSummary) => {
        value.complete = false;
      },
    ],
    [
      "jvm_acceptance",
      (value: PhaseSummary) => {
        value.phase = "baseline";
      },
    ],
    [
      "jvm_acceptance",
      (value: PhaseSummary) => {
        value.bindings.source = "b".repeat(64);
      },
    ],
    [
      "jvm_acceptance",
      (value: PhaseSummary) => {
        value.bindings.compiledHarness = "b".repeat(64);
      },
    ],
    [
      "jvm_acceptance",
      (value: PhaseSummary) => {
        value.obligations.installed = 8;
      },
    ],
    [
      "jvm_guards_regressions",
      (value: PhaseSummary) => {
        value.obligations.guards = 20;
      },
    ],
    [
      "jvm_guards_regressions",
      (value: PhaseSummary) => {
        value.ci.run = "12346";
      },
    ],
    [
      "jvm_guards_regressions",
      (value: PhaseSummary) => {
        value.ci.attempt = 3;
      },
    ],
    [
      "jvm_guards_regressions",
      (value: PhaseSummary) => {
        value.ci.sha = "b".repeat(40);
      },
    ],
  ] as const) {
    const changed = JSON.parse(outputs[key]!) as PhaseSummary;
    change(changed);
    assert.throws(() =>
      requireJvmWrapperPhaseOutputs(
        { ...outputs, [key]: JSON.stringify(changed) },
        expected,
      ),
    );
  }
});

test("JVM phase summaries reject a missing final guard restoration and incomplete installed profiles", () => {
  const common = {
    scope: "jvm-wrapper-native-phase",
    phaseComplete: true,
    allPhasesComplete: false,
    bindings: {
      source: "a".repeat(64),
      compiledCode: "b".repeat(64),
      compiledHarness: "c".repeat(64),
      runtime: "d".repeat(64),
    },
    ci: null,
  };
  assert.throws(() =>
    jvmWrapperPhaseSummary({
      ...common,
      phase: "acceptance",
      source: { required: 9, passed: 9, complete: true },
      installed: {
        profile: { required: 9, passed: 8, complete: true },
        offlineProductionInstall: true,
        harnessOutsideInstalledPackage: true,
      },
    }),
  );
  assert.throws(() =>
    jvmWrapperPhaseSummary({
      ...common,
      phase: "guards-regressions",
      guardCapture: { nativeReceipts: 2 },
      guards: {
        controls: Array.from({ length: 21 }, (_, index) => ({
          id: "guard-" + index,
          originalPassed: true,
          mutantCompiled: true,
          mutantFailedAssertion: true,
          restoredPassed: index !== 20,
        })),
      },
      regressions: { passed: 13, failed: 0, skipped: 0 },
    }),
  );
});

test("JVM source bindings include changed and new unignored source", async (t) => {
  const repository = await fixture(t, {
    "source.txt": "first",
    ".gitignore": "ignored/\n",
  });
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const before = await jvmWrapperSourceIdentity(repository);
  await writeFile(path.join(repository, "source.txt"), "second");
  const changed = await jvmWrapperSourceIdentity(repository);
  assert.notEqual(changed.sha256, before.sha256);
  await writeFile(path.join(repository, "source.txt"), "first");
  assert.deepEqual(await jvmWrapperSourceIdentity(repository), before);
  await appendFile(path.join(repository, "new.txt"), "new");
  assert.notEqual(
    (await jvmWrapperSourceIdentity(repository)).sha256,
    before.sha256,
  );
});

test(
  "POSIX JVM source bindings include executable modes and refuse file links",
  {
    skip:
      process.platform === "win32"
        ? "POSIX executable modes and file links unavailable"
        : false,
  },
  async (t) => {
    const repository = await fixture(t, { "source.txt": "synthetic source" });
    execFileSync("git", ["init", "-q"], { cwd: repository });
    await chmod(path.join(repository, "source.txt"), 0o644);
    const before = await jvmWrapperSourceIdentity(repository);
    await chmod(path.join(repository, "source.txt"), 0o755);
    assert.notEqual(
      (await jvmWrapperSourceIdentity(repository)).sha256,
      before.sha256,
    );
    await chmod(path.join(repository, "source.txt"), 0o644);
    assert.deepEqual(await jvmWrapperSourceIdentity(repository), before);
    await symlink(
      path.join(repository, "source.txt"),
      path.join(repository, "linked.txt"),
    );
    await assert.rejects(
      jvmWrapperSourceIdentity(repository),
      /JVM input cannot cross a file link/,
    );
    await rm(path.join(repository, "linked.txt"));
    assert.deepEqual(await jvmWrapperSourceIdentity(repository), before);
  },
);

test("workflow declares every JVM phase and forwards its distinct output to final completion", async () => {
  const workflow = parse(
    await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"),
  );
  const job = workflow.jobs["jvm-wrappers-arm64"];
  assert.deepEqual(job.strategy.matrix.phase, [
    "baseline",
    "acceptance",
    "guards-regressions",
  ]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["timeout-minutes"], 40);
  assert.deepEqual(Object.keys(job.outputs).sort(), [
    "jvm_acceptance",
    "jvm_baseline",
    "jvm_guards_regressions",
  ]);
  assert.equal(
    job.steps.find(
      (step: { id?: string; run?: string }) => step.id === "native",
    ).run,
    'node scripts/verify-jvm-wrappers-container.mjs "${{ matrix.phase }}"',
  );
  assert.ok(workflow.jobs["ci-complete"].needs.includes("jvm-wrappers-arm64"));
});
