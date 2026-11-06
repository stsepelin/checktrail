import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const moduleUrl = new URL(
  "../../scripts/review-runtime-evidence.mjs",
  import.meta.url,
);
type Scope = {
  runtimeProfiles: Array<{
    id: string;
    platform: string;
    architecture: string;
    node: string;
  }>;
  extensionProfiles: Array<{
    id: string;
    runtime: string;
    acceptanceFile: string;
    acceptanceCases: Array<{ id: string; name: string }>;
  }>;
};
async function data() {
  return {
    scope: JSON.parse(
      await readFile(
        new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
        "utf8",
      ),
    ) as Scope,
    profiles: JSON.parse(
      await readFile(
        new URL("../../scripts/required-native-tests.json", import.meta.url),
        "utf8",
      ),
    ),
  };
}
test("review workflow runtime binds every frozen case without admitting omitted extra foreign or adjacent controls", async () => {
  const { selectReviewRuntimeRequirements: select } = await import(
    moduleUrl.href
  );
  const { scope, profiles } = await data();
  const original = structuredClone(profiles);
  const rows = select(profiles, scope);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows, profiles["multi-candidate-workflow"]);
  rows[0].name = "OriginalReturnedCopyMutation";
  assert.deepEqual(profiles, original);
  for (const mode of ["missing", "extra", "foreign", "renamed", "duplicate"]) {
    const changed = structuredClone(profiles);
    const p = changed["multi-candidate-workflow"];
    if (mode === "missing") p.pop();
    else if (mode === "extra")
      p.push({ file: p[0].file, name: "OriginalUnplannedCase" });
    else if (mode === "foreign") p[0].file = "dist/test/foreign.test.js";
    else if (mode === "renamed") p[0].name += "-extra";
    else p[0] = p[1];
    assert.throws(() => select(changed, scope));
  }
  const adjacent = structuredClone(profiles);
  adjacent["multi-candidate-workflow-extra"] =
    adjacent["multi-candidate-workflow"];
  assert.deepEqual(
    select(adjacent, scope),
    original["multi-candidate-workflow"],
  );
  const wrongScope = structuredClone(scope);
  wrongScope.extensionProfiles.find(
    (p) => p.id === "multi-candidate-workflow",
  )!.acceptanceCases[0]!.id = "wrong";
  assert.throws(() => select(profiles, wrongScope));
});
test("review workflow runtime refuses wrong Node architecture OS image and unselected local qualification", async () => {
  const { checkReviewRuntimeSelection: check } = await import(moduleUrl.href);
  const { scope } = await data();
  const observed = (id: string) => {
    const p = scope.runtimeProfiles.find((p) => p.id === id)!;
    return {
      platform: p.platform,
      architecture: p.architecture,
      node: p.node,
      osRelease: p.platform === "darwin" ? "25.6.0" : "10.0.26100",
      osVersion:
        p.platform === "win32" ? "Windows Server 2025 Datacenter" : "observed",
      imageOS:
        p.platform === "linux"
          ? "ubuntu24"
          : p.platform === "darwin"
            ? "macos26"
            : "win25-vs2026",
      imageVersion: "20261013.0424.1",
      distributionId: "ubuntu",
      distributionVersion: "24.04",
      containerImageId: "sha256:" + "a".repeat(64),
    };
  };
  for (const p of scope.runtimeProfiles) {
    const value = observed(p.id);
    assert.equal(
      check(scope, p.id, value, p.id.startsWith("native-") ? false : true).id,
      p.id,
    );
    for (const key of ["node", "architecture", "platform"]) {
      assert.throws(() => check(scope, p.id, { ...value, [key]: "wrong" }));
    }
  }
  const mac = observed("ci-macos-node26");
  assert.throws(
    () =>
      check(scope, "ci-macos-node26", { ...mac, osRelease: "26.0.0" }, true),
    /macOS 26 kernel/,
  );
  assert.throws(
    () => check(scope, "ci-macos-node26", { ...mac, imageOS: "macos27" }, true),
    /image family/,
  );
  const linux = observed("ci-linux-node22");
  for (const change of [
    { distributionId: "debian" },
    { distributionVersion: "26.04" },
    { imageOS: "ubuntu24-extra" },
    { imageVersion: "latest" },
  ])
    assert.throws(() =>
      check(scope, "ci-linux-node22", { ...linux, ...change }, true),
    );
  assert.throws(() =>
    check(scope, "ci-linux-node22", { ...linux, imageVersion: null }, false),
  );
  assert.throws(() =>
    check(scope, "ci-linux-node22", { ...linux, imageOS: null }, false),
  );
  const win = observed("windows-node22");
  for (const change of [
    { osVersion: "Windows 11 Enterprise" },
    { osRelease: "10.0.26200" },
    { imageOS: "win25-vs2026-extra" },
  ])
    assert.throws(() =>
      check(scope, "windows-node22", { ...win, ...change }, true),
    );
  const arm = observed("native-linux-arm64-node22");
  assert.throws(() =>
    check(scope, "native-linux-arm64-node22", {
      ...arm,
      containerImageId: null,
    }),
  );
  assert.equal(check(scope, null, mac, false), null);
  assert.throws(() => check(scope, null, mac, true));
  assert.throws(() => check(scope, "UnknownOriginalSlot", mac));
});
test("review workflow runtime CLI refuses unknown slots before running workflow callbacks", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/verify-review-runtime.mjs", import.meta.url),
      ),
      "OriginalUnknownSlot",
    ],
    { env, encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
  );
  assert.equal(r.error, undefined);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown selected runtime slot/);
  assert.equal(r.stdout, "");
  for (const [args, hosted, message] of [
    [
      ["--local", "confidence-provenance"],
      "true",
      /Hosted workflow requires a selected runtime slot/,
    ],
    [
      ["--local"],
      "false",
      /Explicit local evidence requires the confidence profile/,
    ],
    [
      ["OriginalUnknownSlot", "confidence-provenance"],
      "false",
      /Unknown selected runtime slot/,
    ],
    [
      ["OriginalUnknownSlot", "confidence-provenance-extra"],
      "false",
      /Unknown selected review runtime profile/,
    ],
  ] as const) {
    const refused = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/verify-review-runtime.mjs", import.meta.url),
        ),
        ...args,
      ],
      {
        env: { ...env, GITHUB_ACTIONS: hosted },
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16384,
      },
    );
    assert.equal(refused.error, undefined);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, message);
    assert.equal(refused.stdout, "");
  }
});

test("review workflow runtime rejects coherently shaped foreign installation evidence and incomplete execution", async () => {
  const { requireReviewRuntimeInstallation: check } = await import(
    moduleUrl.href
  );
  const engine = { treeSha256: "a".repeat(64), manifestSha256: "b".repeat(64) };
  const runtime = {
    slot: "ci-linux-node22",
    node: "22.23.3",
    platform: "linux",
    architecture: "x64",
    imageOS: "ubuntu24",
    imageVersion: "20261013.0424.1",
  };
  const expected = {
    engine,
    runtime,
    harnessSha256: "c".repeat(64),
    requirementsSha256: "d".repeat(64),
    packageSha256: "e".repeat(64),
  };
  const receipt = {
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    profile: {
      complete: true,
      required: 9,
      passed: 9,
      compiledEngine: { ...engine, beforeAfterByteIdentitiesMatch: true },
      runtime,
      runtimeArtifactsSha256: engine.treeSha256,
      harnessSha256: expected.harnessSha256,
      requirementsSha256: expected.requirementsSha256,
      packageSha256: expected.packageSha256,
    },
  };
  assert.deepEqual(check(receipt, expected), receipt);
  const mutations: Array<(r: typeof receipt) => void> = [
    (r) => {
      r.offlineProductionInstall = false;
    },
    (r) => {
      r.lifecycleScriptsExecuted = true;
    },
    (r) => {
      r.harnessOutsideInstalledPackage = false;
    },
    (r) => {
      r.profile.complete = false;
    },
    (r) => {
      r.profile.required = 8;
    },
    (r) => {
      r.profile.passed = 8;
    },
    (r) => {
      r.profile.compiledEngine.beforeAfterByteIdentitiesMatch = false;
    },
    (r) => {
      r.profile.compiledEngine.treeSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.compiledEngine.manifestSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.runtime = { ...runtime, node: "24.21.0" };
    },
    (r) => {
      r.profile.runtime = { ...runtime, imageVersion: "20261014.0424.1" };
    },
    (r) => {
      r.profile.harnessSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.requirementsSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.packageSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.runtimeArtifactsSha256 = "f".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.throws(() => check(changed, expected));
  }
  const local = { ...expected, runtime: { ...runtime, slot: null } };
  assert.deepEqual(check(receipt, local), receipt);
  const foreign = structuredClone(receipt);
  foreign.profile.compiledEngine.treeSha256 = "f".repeat(64);
  assert.throws(() => check(foreign, local));
});

test("review runtime verification isolates callbacks and bounds Windows installed aggregation without hiding failed child status", async (t) => {
  const { fixture } = await import("./helpers.js");
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const root = await fixture(t, {
    "controller.mjs": `import assert from'node:assert/strict';import{registerHooks}from'node:module';const target=process.argv[2];let observed;globalThis.originalRequiredSelection=(requirements,options)=>{observed={names:requirements.map(x=>x.name),timeoutMs:options.timeoutMs,isolatedCaseWorkers:options.isolatedCaseWorkers,progressCallback:typeof options.onCaseProgress};throw Error('Original isolated selector observed');};registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&specifier==='./required-test-evidence.mjs')return{url:'data:text/javascript,'+encodeURIComponent('export const runRequiredTests=(...args)=>globalThis.originalRequiredSelection(...args);'),shortCircuit:true};return next(specifier,context);}});const {verifyReviewRuntime}=await import(target);await assert.rejects(verifyReviewRuntime({requireHostedIdentity:false}),/Original isolated selector observed/);console.log(JSON.stringify(observed));`,
    "installed.mjs": `import{registerHooks}from'node:module';const target=process.argv[2],platform=process.argv[3],calls=[];globalThis.originalInstalledOutcomes=[];globalThis.originalInstalledCalls=calls;
const tests="export function test(name,options,callback){if(name==='multi-candidate-workflow installed acceptance'){globalThis.originalInstalledCalls.push({kind:'callback',timeout:options.timeout});globalThis.originalInstalledOutcomes.push(Promise.resolve().then(callback).then(()=>({outcome:'passed'}),error=>({outcome:'failed',message:error.message})));}}";
const child="export function spawnSync(executable,args,options){globalThis.originalInstalledCalls.push({kind:'child',timeout:options.timeout});return{status:7,stdout:'',stderr:'Original installed refusal'};}";
const unused="export const options={},recipe={},source='original';export function unexpected(){throw Error('Unexpected application execution');}export const setup=unexpected,complete=unexpected,channel=unexpected,pin=unexpected,response=unexpected;export class ReviewWorkflowEngine{};export const reviewWorkflowAssignmentSchema={},reviewWorkflowAllSummarySchema={},reviewWorkflowFindingsResultSchema={};";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const stub=specifier==='node:test'?tests:specifier==='node:child_process'?child:specifier.startsWith('.')?unused:null;if(stub)return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};}return next(specifier,context);}});Object.defineProperty(process,'platform',{value:platform});await import(target);console.log(JSON.stringify({calls,outcomes:await Promise.all(globalThis.originalInstalledOutcomes)}));`,
    "package.mjs": `import assert from'node:assert/strict';import{registerHooks}from'node:module';import{readFile}from'node:fs/promises';import path from'node:path';const target=process.argv[2],platform=process.argv[3],calls=[];const scope=JSON.parse(await readFile(new URL('../docs/gate-a-profiles.v1.json',target),'utf8'));const selected=scope.runtimeProfiles.find(p=>p.platform===platform);assert.ok(selected);process.argv=[process.execPath,target,selected.id];globalThis.originalPackageCalls=calls;
const fs="export * from 'node:fs/promises';import{readFile as actualRead}from'node:fs/promises';export async function readFile(file,...args){return String(file).endsWith('original-packet.tgz')?Buffer.from('Original package metadata'):actualRead(file,...args);}export async function symlink(){}";
const packing="export function runAcceptanceNpm(){return JSON.stringify([{filename:'original-packet.tgz'}]);}export async function installAcceptancePackage(){return{offlineProductionInstall:true,lifecycleScriptsExecuted:false};}";
const child="export function spawnSync(executable,args,options){globalThis.originalPackageCalls.push({timeout:options.timeout,installed:options.env.CHECKTRAIL_MULTI_WORKFLOW_INSTALLED,args});return{status:7,signal:null,stdout:'',stderr:'Original package refusal'};}";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const stub=specifier==='node:fs/promises'?fs:specifier==='node:child_process'?child:specifier==='./install-acceptance-package.mjs'?packing:specifier==='../dist/test/tool-fixture.js'?'export async function copyInstalledPackages(){}':null;if(stub)return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};}return next(specifier,context);}});Object.defineProperty(process,'platform',{value:platform});Object.defineProperty(process,'arch',{value:selected.architecture});Object.defineProperty(process.versions,'node',{value:selected.node});await assert.rejects(import(target),/Original package refusal/);console.log(JSON.stringify({calls,slot:selected.id}));`,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTIONS: "false",
    TMPDIR: root,
    TMP: root,
    TEMP: root,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.CHECKTRAIL_MULTI_WORKFLOW_INSTALLED;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "controller.mjs"),
      new URL("../../scripts/review-runtime-evidence.mjs", import.meta.url)
        .href,
    ],
    { env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const selected = JSON.parse(result.stdout);
  assert.deepEqual(
    selected.names,
    [
      "broken",
      "fixed",
      "near-miss",
      "prerequisite",
      "stale",
      "empty",
      "privacy",
      "lifecycle",
      "installed",
    ].map((k) => "multi-candidate-workflow " + k + " acceptance"),
  );
  assert.equal(
    selected.timeoutMs,
    process.platform === "win32" ? 600000 : 300000,
  );
  assert.equal(selected.isolatedCaseWorkers, 1);
  assert.equal(selected.progressCallback, "function");
  for (const platform of ["win32", "darwin", "linux"]) {
    const observed = spawnSync(
      process.execPath,
      [
        path.join(root, "installed.mjs"),
        new URL("./gate-multi-candidate-workflow.test.js", import.meta.url)
          .href,
        platform,
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(observed.error, undefined);
    assert.equal(observed.status, 0, observed.stderr);
    const value = JSON.parse(observed.stdout);
    assert.deepEqual(value.calls, [
      { kind: "callback", timeout: platform === "win32" ? 580000 : 180000 },
      { kind: "child", timeout: platform === "win32" ? 570000 : 175000 },
    ]);
    assert.equal(value.outcomes.length, 1);
    assert.equal(value.outcomes[0].outcome, "failed");
    assert.match(value.outcomes[0].message, /Original installed refusal/);
    const packaged = spawnSync(
      process.execPath,
      [
        path.join(root, "package.mjs"),
        new URL(
          "../../scripts/verify-review-runtime-package.mjs",
          import.meta.url,
        ).href,
        platform,
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(packaged.error, undefined);
    assert.equal(packaged.status, 0, packaged.stderr);
    const packet = JSON.parse(packaged.stdout);
    assert.deepEqual(packet.calls, [
      {
        timeout: platform === "win32" ? 550000 : 170000,
        installed: "1",
        args: ["scripts/verify-review-runtime.mjs", packet.slot],
      },
    ]);
  }
});

test("confidence runtime preserves its exact frozen cohort and rejects adjacent profiles and forged terminal accounting", async () => {
  const {
    selectReviewRuntimeRequirements: select,
    requireReviewRuntimeCases: check,
  } = await import(moduleUrl.href);
  const { scope, profiles } = await data();
  const rows = select(profiles, scope, "confidence-provenance");
  assert.deepEqual(rows, profiles["confidence-provenance"]);
  assert.throws(() => select(profiles, scope, "confidence-provenance-extra"));
  for (const mode of ["missing", "duplicate", "renamed", "foreign"]) {
    const changed = structuredClone(profiles);
    const cohort = changed["confidence-provenance"];
    if (mode === "missing") cohort.pop();
    else if (mode === "duplicate") cohort[1] = cohort[0];
    else if (mode === "renamed") cohort[0].name += "-extra";
    else cohort[0].file = "dist/test/gate-multi-candidate-workflow.test.js";
    assert.throws(() => select(changed, scope, "confidence-provenance"));
  }
  const acceptance = "a".repeat(64);
  const proof = {
    complete: true,
    required: 9,
    passed: 9,
    problems: [],
    ledger: {
      truncated: false,
      terminalEventCount: 9,
      files: [
        {
          id: "file-1",
          stable: true,
          before: { state: "present", sha256: acceptance },
          after: { state: "present", sha256: acceptance },
        },
      ],
      events: rows.map((r: { name: string }, i: number) => ({
        fileId: "file-1",
        sequence: i + 1,
        name: r.name,
        kind: "test",
        outcome: "passed",
        required: true,
        nameTruncated: false,
      })),
      cases: rows.map((r: { name: string }, i: number) => ({
        fileId: "file-1",
        name: r.name,
        outcome: "passed",
        terminalSequences: [i + 1],
      })),
    },
  };
  check(proof, rows, acceptance);
  for (const mode of [
    "skip",
    "duplicate-event",
    "unrequired",
    "wrong-link",
    "renamed",
    "stale",
    "truncated",
    "empty",
  ]) {
    const changed = structuredClone(proof);
    if (mode === "skip") changed.ledger.events[0]!.outcome = "skipped";
    else if (mode === "duplicate-event") changed.ledger.events[1]!.sequence = 1;
    else if (mode === "unrequired") changed.ledger.events[0]!.required = false;
    else if (mode === "wrong-link")
      changed.ledger.cases[0]!.terminalSequences = [2];
    else if (mode === "renamed") {
      changed.ledger.cases[0]!.name += "-extra";
      changed.ledger.events[0]!.name = changed.ledger.cases[0]!.name;
    } else if (mode === "stale")
      changed.ledger.files[0]!.after.sha256 = "b".repeat(64);
    else if (mode === "truncated") changed.ledger.truncated = true;
    else changed.ledger.events = [];
    assert.throws(
      () => check(changed, rows, acceptance),
      { name: "AssertionError" },
      mode,
    );
  }
  const { requireReviewRuntimeInstallation: installation } = await import(
    moduleUrl.href
  );
  const runtime = {
    slot: null,
    node: "26.12.0",
    platform: "darwin",
    architecture: "arm64",
  };
  const engine = {
    treeSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    beforeAfterByteIdentitiesMatch: true,
  };
  const expected = {
    profileId: "confidence-provenance",
    selectedRuntime: null,
    runtime,
    engine,
    requirements: rows,
    acceptanceSha256: acceptance,
    harnessSha256: "d".repeat(64),
    requirementsSha256: "e".repeat(64),
    packageSha256: "f".repeat(64),
  };
  const installed = {
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    tarballSha256: "1".repeat(64),
    harnessSha256: "2".repeat(64),
    productionDependencyLockSha256: "3".repeat(64),
    profile: {
      ...structuredClone(proof),
      profile: "confidence-provenance-runtime-v1",
      selectedRuntime: null,
      installedEvidence: null,
      runtime,
      compiledEngine: engine,
      runtimeArtifactsSha256: engine.treeSha256,
      harnessSha256: expected.harnessSha256,
      requirementsSha256: expected.requirementsSha256,
      packageSha256: expected.packageSha256,
      gateAComplete: false,
      qualityAssessed: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    },
  };
  assert.deepEqual(installation(installed, expected), installed);
  for (const mode of [
    "profile",
    "recursion",
    "runtime",
    "selected",
    "harness",
    "flag",
    "lock",
    "cohort",
  ]) {
    const changed = JSON.parse(JSON.stringify(installed));
    if (mode === "profile") changed.profile.profile += "-extra";
    else if (mode === "recursion") changed.profile.installedEvidence = {};
    else if (mode === "runtime") changed.profile.runtime.node = "foreign";
    else if (mode === "selected")
      changed.profile.selectedRuntime = { id: "foreign" };
    else if (mode === "harness") changed.profile.harnessSha256 = "9".repeat(64);
    else if (mode === "flag") changed.profile.qualityAssessed = true;
    else if (mode === "lock") changed.productionDependencyLockSha256 = "";
    else {
      changed.profile.ledger.cases[0].name += "-extra";
      changed.profile.ledger.events[0].name =
        changed.profile.ledger.cases[0].name;
    }
    assert.throws(
      () => installation(changed, expected),
      { name: "AssertionError" },
      mode,
    );
  }
});

test("confidence installed callback retains qualified routing failed child status and exact platform package boundaries", async (t) => {
  const { fixture } = await import("./helpers.js");
  const path = await import("node:path");
  const root = await fixture(t, {
    "observe.mjs": `import assert from'node:assert/strict';import path from'node:path';import{registerHooks}from'node:module';import{spawnSync as realSpawnSync}from'node:child_process';
const target=process.argv[2],platform=process.argv[3],mode=process.argv[4];globalThis.failedQualifiedChild=mode==='qualified'?realSpawnSync(process.execPath,['-e',"process.getBuiltinModule('node:fs').writeSync(2,'Original qualified installed refusal');process.exit(7);"],{encoding:'utf8',timeout:5000,maxBuffer:65536}):null;if(mode==='qualified')assert.equal(globalThis.failedQualifiedChild.status,7);globalThis.observedCalls=[];globalThis.observedOutcomes=[];globalThis.selectedPath=platform==='win32'?path.win32:path.posix;
globalThis.installedPath=globalThis.selectedPath.join(platform==='win32'?'C:\\\\original':'/original','node_modules','@stsepelin',mode==='adjacent'?'checktrail-extra':'checktrail','dist','src','index.js');
const tests="export function test(name,options,callback){if(name==='confidence-provenance installed acceptance')globalThis.observedOutcomes.push(Promise.resolve().then(callback).then(()=>({outcome:'passed'}),error=>({outcome:'failed',message:error.message})));}";
const fs="export * from'node:fs/promises';export async function realpath(){return globalThis.installedPath;}";
const child="export function spawnSync(executable,args,options){const result=globalThis.failedQualifiedChild;globalThis.observedCalls.push({args,nodeTestContext:options.env.NODE_TEST_CONTEXT,actualChildStatus:result?.status,actualChildPid:result?.pid});if(!result)throw Error('Unexpected child outside qualified route');return result;}";
const unused="export const recipe={},source='original';function unexpected(){throw Error('Unexpected unselected callback dependency');}export{unexpected as provenanceFixture,unexpected as inspectReviewProvenance,unexpected as projectReviewProvenance,unexpected as runReviewProbe,unexpected as nativeProbeStartObserved,unexpected as createReviewContext};";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const stub=specifier==='node:test'?tests:specifier==='node:fs/promises'?fs:specifier==='node:child_process'?child:specifier==='node:path'?'export default globalThis.selectedPath;':specifier.startsWith('.')?unused:null;if(stub)return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};}return next(specifier,context);}});
Object.defineProperty(process,'platform',{value:platform});if(mode==='qualified'){delete process.env.CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALLED;process.env.CHECKTRAIL_CONFIDENCE_RUNTIME_SLOT='windows-node22';}else process.env.CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALLED='1';await import(target);console.log(JSON.stringify({calls:globalThis.observedCalls,outcomes:await Promise.all(globalThis.observedOutcomes)}));`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const platform of ["win32", "darwin", "linux"])
    for (const mode of ["installed", "adjacent", "qualified"]) {
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, "observe.mjs"),
          new URL("./gate-confidence-provenance.test.js", import.meta.url).href,
          platform,
          mode,
        ],
        { env, encoding: "utf8", timeout: 20000, maxBuffer: 65536 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.outcomes.length, 1);
      assert.equal(
        observed.outcomes[0].outcome,
        mode === "installed" ? "passed" : "failed",
      );
      if (mode === "qualified") {
        assert.match(
          observed.outcomes[0].message,
          /Original qualified installed refusal/,
        );
        assert.equal(observed.calls.length, 1);
        assert.equal(observed.calls[0].actualChildStatus, 7);
        assert.ok(
          Number.isSafeInteger(observed.calls[0].actualChildPid) &&
            observed.calls[0].actualChildPid > 0,
        );
        assert.ok(
          observed.calls[0].args[0].endsWith(
            "verify-review-runtime-package.mjs",
          ),
        );
        assert.deepEqual(observed.calls[0].args.slice(1), [
          "windows-node22",
          "confidence-provenance",
        ]);
        assert.equal(observed.calls[0].nodeTestContext, undefined);
      } else assert.deepEqual(observed.calls, []);
    }
});

test("default local review runtime preserves generic installed receipts while rejecting foreign engines and selected qualification", async () => {
  const { requireReviewRuntimeInstallation: check } = await import(
    moduleUrl.href
  );
  const { profiles } = await data();
  const requirements = profiles["multi-candidate-workflow"] as Array<{
    name: string;
  }>;
  const acceptanceSha256 = "a".repeat(64);
  const engine = {
    treeSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    beforeAfterByteIdentitiesMatch: true,
  };
  const runtime = {
    slot: null,
    node: "22.23.3",
    platform: "linux",
    architecture: "x64",
  };
  const expected = {
    profileId: "multi-candidate-workflow",
    selectedRuntime: null,
    runtime,
    engine,
    requirements,
    acceptanceSha256,
    harnessSha256: "d".repeat(64),
    requirementsSha256: "e".repeat(64),
    packageSha256: "f".repeat(64),
  };
  const receipt = {
    tarballSha256: "1".repeat(64),
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    profile: {
      profile: "multi-candidate-workflow",
      complete: true,
      passed: 9,
      required: 9,
      problems: [],
      compiledEngine: engine,
      ledger: {
        truncated: false,
        terminalEventCount: 9,
        files: [
          {
            id: "file-1",
            stable: true,
            before: { state: "present", sha256: acceptanceSha256 },
            after: { state: "present", sha256: acceptanceSha256 },
          },
        ],
        cases: requirements.map((r, i) => ({
          fileId: "file-1",
          name: r.name,
          outcome: "passed",
          terminalSequences: [i + 1],
        })),
        events: requirements.map((r, i) => ({
          fileId: "file-1",
          name: r.name,
          sequence: i + 1,
          outcome: "passed",
          kind: "test",
          required: true,
          nameTruncated: false,
        })),
      },
    },
  };
  assert.deepEqual(check(receipt, expected), receipt);
  const foreign = structuredClone(receipt);
  foreign.profile.compiledEngine.treeSha256 = "9".repeat(64);
  assert.throws(() => check(foreign, expected));
  assert.throws(() =>
    check(receipt, {
      ...expected,
      runtime: { ...runtime, slot: "ci-linux-node22" },
    }),
  );
  assert.throws(() =>
    check(receipt, { ...expected, profileId: "confidence-provenance" }),
  );
  const skipped = structuredClone(receipt);
  skipped.profile.ledger.events[0]!.outcome = "skipped";
  assert.throws(() => check(skipped, expected));
});
