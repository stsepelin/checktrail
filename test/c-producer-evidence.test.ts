import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const { validateCObservationHeader } = await import(
  pathToFileURL(
    path.join(repository, "scripts/verify-c-producer-observation.mjs"),
  ).href
);
const catalog = JSON.parse(
  await readFile(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-profiles.v1.json",
    ),
    "utf8",
  ),
);
const profile = catalog.profiles.glibc;
const terminal = {
  exitCode: 0,
  signal: null,
  error: null,
  reason: null,
  stopError: null,
  retainedBytes: 27,
};
const startup = {
  schemaVersion: 1,
  state: "operator-source-and-caller-frame",
  caller: { uid: 1001, gid: 1001 },
  host: { platform: "linux", architecture: "x64", kernelMachine: "x86_64" },
  sourceOrCompilerExecuted: false,
  hardwareHostAttestationPerformed: false,
  gateAComplete: false,
};
const syntheticHeader = () => ({
  state: "original-command-completed-qualification-incomplete",
  profile: profile.profile,
  sourceVersion: profile.sourceVersion,
  limits: profile.limits,
  buildExecuted: true,
  originalExecutionInvoked: true,
  executionObserver: { ...terminal },
  originalBuild: {
    schemaVersion: 1,
    command: profile.command,
    invoked: true,
    exitCode: 0,
    wrapperExitCode: 0,
  },
  host: { ...startup.host, capturedCaller: startup.caller },
  custodyPreflight: {
    state: "selected-nonroot-caller-export-verified",
    capturedCaller: startup.caller,
    nativeLinuxCrossUidAcceptanceVerified: true,
    sourceOrCompilerInvoked: false,
    observer: { ...terminal },
    cleanup: { state: "absent" },
  },
  cleanup: { state: "removed" },
  retentionObserverCleanup: { state: "absent" },
  retentionObserver: {
    state: "completed",
    terminal: { exitCode: 0, signal: null },
    readOnly: true,
    network: "none",
    capability: "DAC_READ_SEARCH",
    nativeFilesystemQuotaEnforced: false,
  },
  outputs: [{ file: "synthetic_0_amd64.deb", bytes: 1 }],
  nativeFilesystemQuotaEnforced: false,
  fullCompilerSdkBootstrapClosureVerified: false,
  completeOriginalNoticeClosureVerified: false,
  historicalPublisherConsumptionVerified: false,
  gateAComplete: false,
  originalBuildChecksDisabled: false,
  originalDefaultTargetsDisabled: false,
  inputAuthenticationAndFreshnessDisabled: false,
});

test("C observation header schema keeps synthetic protocol controls separate from actual upstream qualification", () => {
  const result = validateCObservationHeader(
    syntheticHeader(),
    profile,
    startup,
    2,
  );
  assert.equal(result.originalCommandExitCode, 0);
  assert.equal(result.originalTestOutcomesPreserved, true);
  assert.equal(result.fullCompilerSdkBootstrapClosureVerified, false);
  assert.equal(result.gateAComplete, false);
  for (const controllerExit of [0, 1, 137, null])
    assert.throws(
      () =>
        validateCObservationHeader(
          syntheticHeader(),
          profile,
          startup,
          controllerExit,
        ),
      /Unexpected original controller exit/,
    );
});
test("C observation refuses incomplete terminal, stale profile, wrong caller and empty physical output declarations", () => {
  const changes: ((value: ReturnType<typeof syntheticHeader>) => void)[] = [
    (r) => {
      r.executionObserver.exitCode = 1;
    },
    (r) => {
      Object.assign(r.executionObserver, { signal: "SIGTERM" });
    },
    (r) => {
      Object.assign(r.executionObserver, { error: "synthetic spawn failure" });
    },
    (r) => {
      Object.assign(r.executionObserver, { reason: "deadline" });
    },
    (r) => {
      Object.assign(r.executionObserver, {
        stopError: "synthetic cleanup failure",
      });
    },
    (r) => {
      Object.assign(r.executionObserver, { truncated: true });
    },
    (r) => {
      r.originalBuild.invoked = false;
    },
    (r) => {
      r.originalBuild.exitCode = 2;
    },
    (r) => {
      r.profile = "stale-profile";
    },
    (r) => {
      r.sourceVersion = "2.36-9+deb12u13";
    },
    (r) => {
      r.custodyPreflight.nativeLinuxCrossUidAcceptanceVerified = false;
    },
    (r) => {
      r.custodyPreflight.capturedCaller = { uid: 1002, gid: 1001 };
    },
    (r) => {
      r.outputs = [];
    },
    (r) => {
      r.outputs[0]!.bytes = 0;
    },
    (r) => {
      r.gateAComplete = true;
    },
  ];
  for (const change of changes) {
    const value = structuredClone(syntheticHeader());
    change(value);
    assert.throws(() => validateCObservationHeader(value, profile, startup, 2));
  }
});
test("GLIBC hosted carrier keeps its original budget, bounded export and a branch namespace separate from Binutils and GCC", async () => {
  const workflow = parse(
    await readFile(
      path.join(repository, ".github/workflows/upstream-glibc.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on.push.branches, ["pr/upstream-producer/glibc-*"]);
  const job = workflow.jobs["original-glibc-observation"];
  assert.ok(job["timeout-minutes"] <= 360);
  assert.equal(profile.limits.deadlineSeconds, 14400);
  assert.equal(catalog.profiles["gcc-12"].limits.deadlineSeconds, 28800);
  const steps = job.steps as {
    name?: string;
    run?: string;
    if?: string;
    "timeout-minutes": number;
  }[];
  assert.ok(
    steps.reduce((sum, step) => sum + step["timeout-minutes"], 0) <=
      job["timeout-minutes"],
  );
  const run = steps.find((step) => step.name?.includes("four-hour"));
  assert.ok(run && typeof run.run === "string");
  assert.ok(
    run?.run?.includes("--profile glibc") &&
      run.run.includes("--operator-trust-execution --coordinated-heavy-slot"),
  );
  assert.ok(run["timeout-minutes"] > profile.limits.deadlineSeconds / 60);
  const exporter = steps.find((step) => step.name?.includes("full bounded"));
  assert.equal(exporter?.if, "always()");
  assert.ok(exporter?.run?.includes("c-producer-export-evidence.py"));
  assert.ok(!steps.some((step) => step.run?.includes("--profile gcc-12")));
});

const diagnostic = (r: SpawnSyncReturns<string>) =>
  [
    r.error?.message,
    `status=${String(r.status)} signal=${String(r.signal)}`,
    r.stdout,
    r.stderr,
  ]
    .filter(Boolean)
    .join("\n");
const failures: string[] = [];
const python = ["python3", "python"].find((executable) => {
  const r = spawnSync(
    executable,
    ["-I", "-S", "-B", "-c", "import sys; print(sys.version_info.major)"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  if (
    !r.error &&
    r.status === 0 &&
    r.signal === null &&
    r.stdout.trim() === "3"
  )
    return true;
  failures.push(executable + ": " + diagnostic(r));
  return false;
});
test(
  "C evidence exports large original logs and independently refuses corrupt bytes, counts, owners, source and incomplete transport",
  {
    skip:
      process.platform === "win32"
        ? "POSIX sameUID export component unavailable on this host"
        : python
          ? false
          : "Verified Python3 data evidence components unavailable: " +
            failures.join("; "),
  },
  async (t) => {
    const root = await fixture(t, {});
    const program = String.raw`
import base64,hashlib,importlib.util,json,os,pathlib,shutil,subprocess,sys,zipfile
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]).resolve()
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
exporter=module('synthetic_export',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
replayer=module('synthetic_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
collector=module('synthetic_copies',repo/'scripts/producer-qualification/c-producer-test-reports.py')
source=root/'synthetic-source';(source/'build-tree/amd64-libc').mkdir(parents=True)
raw=b'PASS: synthetic data line\n'*80000+b'FAIL: preserved failure\nFAILURE: valid near miss\n'
(source/'build-tree/amd64-libc/tests.sum').write_bytes(raw)
log=b'synthetic original log\n'*450000
assert len(raw)>1024**2 and len(log)>8*1024**2
(source/'build-tree/amd64-libc/tests.log').write_bytes(log)
result=root/'result';(result/'work').mkdir(parents=True)
caller={'uid':os.getuid(),'gid':os.getgid()}
collector.collect('glibc',source,result/'work/test-reports.json',caller)
report=json.loads((result/'work/test-reports.json').read_bytes())
reviewed=root/'reviewed-operator-source';reviewed.mkdir()
for name in exporter.SOURCE_FILES:
 p=reviewed/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(repo/name,p)
env=dict(os.environ);env.update(SKIP_CODEX_REVIEW='1',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
git=['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false','-c','commit.gpgsign=false']
for args in [['init','--quiet'],['add','--',*exporter.SOURCE_FILES],['-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','Synthetic evidence source frame']]:
 p=subprocess.run(git+args,cwd=reviewed,env=env,capture_output=True,timeout=10);assert p.returncode==0,p.stderr
head=subprocess.check_output(git+['rev-parse','HEAD'],cwd=reviewed,env=env).decode().strip()
startup={'schemaVersion':1,'state':'synthetic-data-export-not-native-observation','caller':caller,'gitHead':head,'sourcePins':[{'file':n,**replayer.pin((reviewed/n).read_bytes())} for n in exporter.SOURCE_FILES]}
startup_file=root/'startup.json';startup_file.write_text(json.dumps(startup));startup_file.chmod(0o600)
(root/'inputs').mkdir();(root/'common').mkdir()
(result/'work/output').mkdir();(result/'work/output/synthetic.deb').write_bytes(b'not an actual package')
actual_output=result/'work/output/synthetic.deb'
actual_output_observation={'file':actual_output.name,**replayer.pin(actual_output.read_bytes())}
assert replayer.nonempty_package_outputs([actual_output_observation],32*1024**3)
for name,size in [('empty.deb',0),('near.deb.old',1),('near.udeb.log',1),('../outside.deb',1)]:
 assert not replayer.nonempty_package_outputs([{'file':name,'bytes':size,'sha256':'0'*64}],32*1024**3),'Invalid package output observation accepted: '+repr((name,size))
(result/'work/native-build-worktree.tar').write_bytes(b'excluded synthetic archive')
archive=root/'evidence.zip'
summary=exporter.export(reviewed,root/'inputs',root/'common',result,startup_file,archive)
packet=replayer.Packet(archive)
try:
 assert packet.read('result/work/original-test-reports/build-tree/amd64-libc/tests.log',64*1024**2)==log
 assert not any(name.endswith(('.deb','.tar')) for name in packet.files)
 parsed=replayer.reports(packet,'result/work/original-test-reports',report,caller,os.geteuid())
 assert parsed['observedOutcomeLines']==80001 and parsed['originalOutcomesPreserved'] and not parsed['reportsPooledAsIndependentEvidence']
 assert parsed['resolvedTestOutcomesObserved'] and parsed['testEvidenceState']=='failed'
 assert replayer.source_frame(packet,reviewed,startup)['exactOriginalGitSourcePins']==len(exporter.SOURCE_FILES)
finally:packet.close()
try:replayer.replay(archive,reviewed)
except ValueError as error:assert 'Incomplete raw C export' in str(error)
else:raise AssertionError('Synthetic failed/raw fixture qualified as original native observation')
def mutated(label,change):
 with zipfile.ZipFile(archive) as z:members={n:z.read(n) for n in z.namelist()}
 manifest=json.loads(members['manifest.json']);change(members,manifest)
 for row in manifest['rawFiles']:
  row.update(replayer.pin(members[row['file']]))
 manifest['uncompressedBytes']=sum(row['bytes'] for row in manifest['rawFiles'])
 manifest['originalReportLogBytes']=sum(row['bytes'] for row in manifest['rawFiles'] if row['file'].startswith('result/work/original-test-reports/'))
 members['manifest.json']=(json.dumps(manifest)+'\n').encode()
 target=root/(label+'.zip')
 with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as z:
  for name,value in members.items():z.writestr(name,value)
 return target
def wrong_owner(members,manifest):
 next(r for r in manifest['rawFiles'] if r['file'].endswith('/tests.sum'))['nativeUid']+=1
owner_packet=replayer.Packet(mutated('wrong-owner',wrong_owner))
try:
 try:replayer.reports(owner_packet,'result/work/original-test-reports',report,caller,os.geteuid())
 except ValueError as error:assert 'owner/group/mode' in str(error)
 else:raise AssertionError('Wrong native owner was accepted')
finally:owner_packet.close()
report_path='result/work/original-test-reports/build-tree/amd64-libc/tests.sum'
def wrong_counts(members,manifest):
 members[report_path]=members[report_path].replace(b'FAIL: preserved failure',b'PASS: preserved failure')
 value=json.loads(members['result/work/test-reports.json']);value['reports'][0].update(replayer.pin(members[report_path]));members['result/work/test-reports.json']=json.dumps(value).encode()
count_packet=replayer.Packet(mutated('wrong-counts',wrong_counts))
try:
 try:replayer.reports(count_packet,'result/work/original-test-reports',count_packet.json('result/work/test-reports.json'),caller,os.geteuid())
 except ValueError as error:assert 'outcome counts differ' in str(error)
 else:raise AssertionError('Coherently rehashed wrong counts were accepted')
finally:count_packet.close()
def stale_source(members,manifest):members['source/scripts/qualify-c-producer.mjs']+=b'\n// synthetic stale source\n'
stale=replayer.Packet(mutated('stale-source',stale_source))
try:
 try:replayer.source_frame(stale,reviewed,startup)
 except ValueError as error:assert 'Stale or changed' in str(error)
 else:raise AssertionError('Stale harness was accepted')
finally:stale.close()
with zipfile.ZipFile(archive) as z:members={n:z.read(n) for n in z.namelist()}
members[report_path]=b'corrupt original data'
corrupt=root/'corrupt.zip'
with zipfile.ZipFile(corrupt,'w') as z:
 for name,value in members.items():z.writestr(name,value)
try:replayer.Packet(corrupt)
except ValueError as error:assert 'length differs' in str(error) or 'Corrupt exported' in str(error)
else:raise AssertionError('Corrupt raw report accepted')
process=subprocess.run([sys.executable,'-I','-S','-B','-c','print("synthetic foreground data")'],capture_output=True,timeout=3)
actual={'exitCode':process.returncode,'signal':None,'error':None,'reason':None,'retainedBytes':len(process.stdout)+len(process.stderr),'stopError':None}
replayer.terminal(actual)
for family in ['SKIP','UNSUPPORTED','UNTESTED','UNRESOLVED','ERROR']:
 unavailable=replayer.outcome_availability([{'counts':{family:1}}]);assert not unavailable['resolvedTestOutcomesObserved'] and unavailable['testEvidenceState']=='unavailable','Unavailable-only outcome was relabeled resolved: '+family
for family,state in [('PASS','reported'),('FAIL','failed'),('XFAIL','reported'),('XPASS','failed')]:
 resolved=replayer.outcome_availability([{'counts':{family:1}}]);assert resolved['resolvedTestOutcomesObserved'] and resolved['testEvidenceState']==state,'Resolved outcome state differed: '+family
for field,value in [('exitCode',None),('signal','SIGTERM'),('error','synthetic'),('reason','deadline'),('stopError','cleanup'),('retainedBytes',-1),('truncated',True)]:
 bad=dict(actual);bad[field]=value
 try:replayer.terminal(bad)
 except ValueError:pass
 else:raise AssertionError('Incomplete foreground dimension accepted')
ready={'schemaVersion':1,'kind':'ready','roots':['/observed/bundle','/observed/controls','/observed/work']}
sample={'schemaVersion':1,'kind':'sample','sequence':1,'bytes':123,'files':2,'directories':3}
def chunk(stream,value):return json.dumps({'stream':stream,'base64':base64.b64encode((json.dumps(value,separators=(',',':'))+'\n').encode()).decode()}).encode()+b'\n'
transport=chunk('stdout',ready)+chunk('stdin',{'schemaVersion':1,'kind':'sample','sequence':1})+chunk('stdout',sample)
transport_receipt={'retainedLogBytes':len(transport),'log':replayer.pin(transport),'samples':1,'lastSample':sample}
assert replayer.retention(transport,transport_receipt)==sample
incomplete=chunk('stdout',ready)+chunk('stdin',{'schemaVersion':1,'kind':'sample','sequence':1})
bad=dict(transport_receipt);bad.update(retainedLogBytes=len(incomplete),log=replayer.pin(incomplete))
try:replayer.retention(incomplete,bad)
except ValueError as error:assert 'Incomplete observer' in str(error)
else:raise AssertionError('Incomplete observer request/response accepted')
print(json.dumps({'sameUidPhysicalExport':True,'largeOriginalLogBytes':len(log),'largeOriginalReportBytes':len(raw),'countsCorruptionOwnerSourceAndTerminalControls':True,'actualNativeCompilerOrRootContainerQualification':False,'gateAComplete':False}))
`;
    const result = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, repository, root],
      { encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.sameUidPhysicalExport, true);
    assert.ok(observed.largeOriginalLogBytes > 8 * 1024 ** 2);
    assert.ok(observed.largeOriginalReportBytes > 1024 ** 2);
    assert.equal(observed.countsCorruptionOwnerSourceAndTerminalControls, true);
    assert.equal(
      observed.actualNativeCompilerOrRootContainerQualification,
      false,
    );
    assert.equal(observed.gateAComplete, false);
  },
);
