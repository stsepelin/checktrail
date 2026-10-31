import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const api = await import(
  pathToFileURL(
    path.join(repository, "scripts/producer-qualification/glibc-seccomp.mjs"),
  ).href
);
const controller = await import(
  pathToFileURL(path.join(repository, "scripts/qualify-c-producer.mjs")).href
);
const profileApi = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-profile.mjs",
    ),
  ).href
);
const sentinel = 0xdefaced;
const probe = (mode: "baseline" | "derived") => ({
  schemaVersion: 1,
  mode,
  machine: "x86_64",
  capabilities: {
    effective: "00000000a80425fb",
    permitted: "00000000a80425fb",
    bounding: "00000000a80425fb",
  },
  personality: {
    saved: { result: 0, errno: sentinel },
    negativeSet: {
      result: mode === "baseline" ? -1 : 0,
      errno: mode === "baseline" ? 1 : sentinel,
    },
    negativeQuery: { result: mode === "baseline" ? 0 : -22, errno: sentinel },
    linuxSet: { result: mode === "baseline" ? 0 : -22, errno: sentinel },
    linuxQuery: { result: 0, errno: sentinel },
    near: { result: -1, errno: 1 },
  },
  clock: {
    monotonicRead: 0,
    monotonicSet: { result: -1, errno: mode === "baseline" ? 1 : 22 },
    realtimeInvalidSet: { result: -1, errno: 1 },
  },
  restored: true,
  projectOrCompilerExecuted: false,
  clockChangeAttemptedWithValidRealtimeArgument: false,
});
const runtime = () => ({
  version: {
    Server: {
      Version: "28.0.4",
      GitCommit: "6430e49",
      Os: "linux",
      Arch: "amd64",
      Components: [
        {
          Name: "Engine",
          Version: "28.0.4",
          Details: { GitCommit: "6430e49" },
        },
      ],
    },
  },
  info: {
    ServerVersion: "28.0.4",
    OSType: "linux",
    Architecture: "x86_64",
    SecurityOptions: [
      "name=apparmor",
      "name=seccomp,profile=builtin",
      "name=cgroupns",
    ],
  },
});

test("GLIBC policy authenticates original defaults and notices and changes exactly two argument predicates", async () => {
  const selected = await api.loadGlibcSeccomp();
  const base = JSON.parse(
    await readFile(
      path.join(
        repository,
        "scripts/producer-qualification/moby-28.0.4/default.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(selected.policy, {
    ...base,
    syscalls: [...base.syscalls, ...api.glibcSeccompAdditions()],
  });
  assert.equal(selected.metadata.inputs.length, 4);
  assert.deepEqual(selected.metadata.originalNoticesRetained, [
    "moby-28.0.4/LICENSE",
    "moby-28.0.4/NOTICE",
    "moby-28.0.4/AUTHORS",
  ]);
  assert.equal(selected.metadata.nativeCompatibilityVerified, false);
  for (const change of [
    (v: typeof selected.policy) => {
      v.defaultAction = "SCMP_ACT_ALLOW";
    },
    (v: typeof selected.policy) => {
      v.syscalls.at(-1).args[0].value = 4294967275;
    },
    (v: typeof selected.policy) => {
      v.syscalls.at(-2).args = [];
    },
    (v: typeof selected.policy) => {
      v.syscalls[0].action = "SCMP_ACT_ERRNO";
    },
  ]) {
    const value = structuredClone(selected.policy);
    change(value);
    assert.throws(
      () => api.validateGlibcSeccompDelta(base, value),
      /exact predicates|exact.*predicates|default rule/u,
    );
  }
  assert.deepEqual(selected.policy.syscalls.slice(0, -2), base.syscalls);
});

test("GLIBC carrier refuses unknown Docker versions, builds and default profiles before original execution", () => {
  const good = runtime();
  assert.equal(
    api.validateGlibcDockerMetadata(good.version, good.info)
      .defaultProfileBytesIndependentlyAttestedFromDaemon,
    false,
  );
  good.version.Server.GitCommit = "6430e49a55babd9b8f4d08e70ecb2b68900770fe";
  good.info.Architecture = "amd64";
  api.validateGlibcDockerMetadata(good.version, good.info);
  for (const change of [
    (v: ReturnType<typeof runtime>) => {
      v.version.Server.Version = "28.0.5";
    },
    (v: ReturnType<typeof runtime>) => {
      v.version.Server.GitCommit = "b8034c0";
    },
    (v: ReturnType<typeof runtime>) => {
      v.version.Server.Components[0]!.Details.GitCommit = "foreign";
    },
    (v: ReturnType<typeof runtime>) => {
      v.version.Server.Components.push(v.version.Server.Components[0]!);
    },
    (v: ReturnType<typeof runtime>) => {
      v.info.SecurityOptions = ["name=seccomp,profile=unconfined"];
    },
    (v: ReturnType<typeof runtime>) => {
      v.info.SecurityOptions.push("name=seccomp,profile=unknown");
    },
    (v: ReturnType<typeof runtime>) => {
      v.info.Architecture = "aarch64";
    },
  ]) {
    const bad = runtime();
    change(bad);
    assert.throws(() => api.validateGlibcDockerMetadata(bad.version, bad.info));
  }
});

test("GLIBC synthetic probe schema preserves BZ19408 negative returns and the errno sentinel without claiming native success", () => {
  for (const mode of ["baseline", "derived"] as const) {
    assert.deepEqual(api.validateGlibcSyscallProbe(probe(mode), mode), {
      mode,
      exactPredicatesObserved: true,
      originalBodyInvoked: false,
    });
    for (const change of [
      (v: ReturnType<typeof probe>) => {
        v.personality.negativeQuery.errno = 22;
      },
      (v: ReturnType<typeof probe>) => {
        v.personality.near.result = 0;
      },
      (v: ReturnType<typeof probe>) => {
        v.clock.realtimeInvalidSet.errno = 22;
      },
      (v: ReturnType<typeof probe>) => {
        v.capabilities.bounding = "00000000aa0425fb";
      },
      (v: ReturnType<typeof probe>) => {
        v.capabilities.effective = "00000000a82425fb";
      },
      (v: ReturnType<typeof probe>) => {
        v.restored = false;
      },
    ]) {
      const bad = probe(mode);
      change(bad);
      assert.throws(() => api.validateGlibcSyscallProbe(bad, mode));
    }
    for (const field of ["effective", "permitted", "bounding"] as const)
      for (const bit of [21n, 25n]) {
        const bad = probe(mode);
        bad.capabilities[field] = (
          BigInt("0x" + bad.capabilities[field]) |
          (1n << bit)
        )
          .toString(16)
          .padStart(16, "0");
        assert.throws(() => api.validateGlibcSyscallProbe(bad, mode));
      }
  }
  assert.throws(() =>
    api.validateGlibcSyscallProbe(probe("baseline"), "derived"),
  );
  const wrong = probe("derived");
  wrong.clock.monotonicSet.errno = 1;
  assert.throws(() => api.validateGlibcSyscallProbe(wrong, "derived"));
});

test("GLIBC-only compiler and fixed probe vectors keep capabilities, budgets and the GCC carrier unchanged", async () => {
  const destination = path.resolve("synthetic-glibc-policy");
  const attempt = "12345678-1234-4234-8234-123456789012";
  for (const name of ["gcc-12", "glibc"]) {
    const { catalog, profile } = await profileApi.loadCProducerProfile(name);
    const argv: string[] = controller.cProducerArguments(
      catalog,
      profile,
      destination,
      attempt,
      { uid: 1001, gid: 1002 },
    );
    assert.equal(argv.includes("--security-opt"), name === "glibc");
    if (name === "glibc")
      assert.equal(
        argv[argv.indexOf("--security-opt") + 1],
        "seccomp=" +
          path.join(destination, "controls/glibc-native-seccomp.json"),
      );
    assert.equal(argv[argv.indexOf("--cpus") + 1], "4");
    assert.equal(argv[argv.indexOf("--memory") + 1], "6g");
    assert.ok(!argv.some((v) => /privileged|cap-add|unconfined/u.test(v)));
    assert.equal(
      controller.cProducerSourceFiles(profile).length,
      name === "glibc" ? 15 : 9,
    );
    for (const mode of ["baseline", "derived"]) {
      const args: string[] = controller.cProducerSyscallPreflightArguments(
        catalog,
        destination,
        attempt,
        mode,
      );
      assert.equal(args.includes("--security-opt"), mode === "derived");
      assert.equal(args[args.indexOf("--cpus") + 1], "1");
      assert.equal(args[args.indexOf("--memory") + 1], "256m");
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.deepEqual(args.slice(-5), [
        "-I",
        "-S",
        "-B",
        "/controller/glibc-seccomp-probe.py",
        mode,
      ]);
      assert.ok(!args.some((v) => /privileged|cap-add|unconfined/u.test(v)));
    }
  }
});

test("GLIBC probe receipt requires complete terminals, same image and capability frames and cleanup", async () => {
  const selected = await api.loadGlibcSeccomp();
  const make = () => {
    const modes = Object.fromEntries(
      ["baseline", "derived"].map((mode) => {
        const record = probe(mode as "baseline" | "derived");
        return [
          mode,
          {
            record,
            predicates: api.validateGlibcSyscallProbe(record, mode),
            imageId: "sha256:" + "1".repeat(64),
            log: { bytes: 100, sha256: "2".repeat(64) },
            observer: {
              exitCode: 0,
              signal: null,
              error: null,
              reason: null,
              stopError: null,
              retainedBytes: 100,
            },
            cleanup: { state: "removed" },
          },
        ];
      }),
    );
    const r = runtime();
    return {
      image: { id: "sha256:" + "1".repeat(64) },
      syscallRuntime: api.validateGlibcDockerMetadata(r.version, r.info),
      generatedControlPins: [selected.generated],
      syscallPreflight: {
        schemaVersion: 1,
        state: "exact-kernel-predicates-observed-original-body-not-invoked",
        policy: selected.generated,
        modes,
        originalBodyInvoked: false,
        fullCompilerSdkBootstrapClosureVerified: false,
        historicalPublisherConsumptionVerified: false,
        gateAComplete: false,
      },
    };
  };
  api.validateGlibcSyscallPreflight(
    make(),
    selected,
    controller.observedCProducerTerminal,
  );
  for (const field of [
    "exitCode",
    "signal",
    "error",
    "reason",
    "stopError",
    "retainedBytes",
  ]) {
    const bad = make();
    Object.assign(bad.syscallPreflight.modes.derived!.observer, {
      [field]: null,
    });
    if (!["signal", "error", "reason", "stopError"].includes(field))
      assert.throws(() =>
        api.validateGlibcSyscallPreflight(
          bad,
          selected,
          controller.observedCProducerTerminal,
        ),
      );
    else {
      Object.assign(bad.syscallPreflight.modes.derived!.observer, {
        [field]: "synthetic failure",
      });
      assert.throws(() =>
        api.validateGlibcSyscallPreflight(
          bad,
          selected,
          controller.observedCProducerTerminal,
        ),
      );
    }
  }
  const wrongImage = make();
  wrongImage.syscallPreflight.modes.derived!.imageId = "foreign";
  assert.throws(() =>
    api.validateGlibcSyscallPreflight(
      wrongImage,
      selected,
      controller.observedCProducerTerminal,
    ),
  );
  const badCleanup = make();
  badCleanup.syscallPreflight.modes.derived!.cleanup.state = "unknown";
  assert.throws(() =>
    api.validateGlibcSyscallPreflight(
      badCleanup,
      selected,
      controller.observedCProducerTerminal,
    ),
  );
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
const unavailable: string[] = [];
const python = ["python3", "python"].find((name) => {
  const r = spawnSync(
    name,
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
  unavailable.push(name + ": " + diagnostic(r));
  return false;
});
test(
  "GLIBC independent Python replay refuses synthetic policy, raw-log, kernel-predicate, image and terminal mutations",
  {
    skip: python
      ? false
      : "Verified Python3 pure replay unavailable: " + unavailable.join("; "),
  },
  () => {
    const program = String.raw`
import ast,copy,importlib.util,json,pathlib,sys
repo=pathlib.Path(sys.argv[1]);directory=repo/'scripts/producer-qualification'
ast.parse((directory/'glibc-seccomp-probe.py').read_bytes())
spec=importlib.util.spec_from_file_location('synthetic_replay',directory/'c-producer-replay-evidence.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
sentinel=0xdefaced
def record(mode):
 return {'schemaVersion':1,'mode':mode,'machine':'x86_64','capabilities':dict.fromkeys(['effective','permitted','bounding'],'00000000a80425fb'),'personality':{'saved':{'result':0,'errno':sentinel},'negativeSet':{'result':-1 if mode=='baseline' else 0,'errno':1 if mode=='baseline' else sentinel},'negativeQuery':{'result':0 if mode=='baseline' else -22,'errno':sentinel},'linuxSet':{'result':0 if mode=='baseline' else -22,'errno':sentinel},'linuxQuery':{'result':0,'errno':sentinel},'near':{'result':-1,'errno':1}},'clock':{'monotonicRead':0,'monotonicSet':{'result':-1,'errno':1 if mode=='baseline' else 22},'realtimeInvalidSet':{'result':-1,'errno':1}},'restored':True,'projectOrCompilerExecuted':False,'clockChangeAttemptedWithValidRealtimeArgument':False}
originals={'source/scripts/producer-qualification/'+row['file']:(directory/row['file']).read_bytes() for row in json.loads((directory/'glibc-seccomp.v1.json').read_bytes())['inputs']}
originals['source/scripts/producer-qualification/glibc-seccomp.v1.json']=(directory/'glibc-seccomp.v1.json').read_bytes()
base=json.loads(originals['source/scripts/producer-qualification/moby-28.0.4/default.json']);metadata=json.loads(originals['source/scripts/producer-qualification/glibc-seccomp.v1.json'])
derived={**base,'syscalls':base['syscalls']+metadata['additions']}
class Data:
 def __init__(self,files):self.files=files
 def read(self,name,maximum):
  raw=self.files[name];assert len(raw)<=maximum;return raw
 def json(self,name,maximum):return r.strict_json(self.read(name,maximum))
def frame():
 files=dict(originals);raw=(json.dumps(derived,indent=2)+'\n').encode();files['result/controls/glibc-native-seccomp.json']=raw
 policy={'file':'glibc-native-seccomp.json',**r.pin(raw)};image='sha256:'+'1'*64
 modes={}
 for mode in ['baseline','derived']:
  value=record(mode);log=(json.dumps(value)+'\n').encode();files['result/seccomp-'+mode+'.log']=log
  modes[mode]={'record':value,'log':r.pin(log),'observer':{'exitCode':0,'signal':None,'error':None,'reason':None,'stopError':None,'retainedBytes':len(log)},'imageId':image,'predicates':{'mode':mode,'exactPredicatesObserved':True,'originalBodyInvoked':False},'cleanup':{'state':'removed'}}
 receipt={'image':{'id':image},'generatedControlPins':[policy],'syscallRuntime':{'serverVersion':'28.0.4','serverGitCommit':'6430e49','sourceCommit':'6430e49a55babd9b8f4d08e70ecb2b68900770fe','platform':'linux/amd64','defaultProfile':'builtin','reportedMetadataOnly':True,'defaultProfileBytesIndependentlyAttestedFromDaemon':False,'historicalPublisherConsumptionVerified':False},'syscallPreflight':{'schemaVersion':1,'state':'exact-kernel-predicates-observed-original-body-not-invoked','policy':policy,'modes':modes,'originalBodyInvoked':False,'fullCompilerSdkBootstrapClosureVerified':False,'historicalPublisherConsumptionVerified':False,'gateAComplete':False}}
 return files,receipt
files,receipt=frame();r.syscall_preflight(Data(files),receipt)
def reject(change):
 files,receipt=frame();change(files,receipt)
 try:r.syscall_preflight(Data(files),receipt)
 except (ValueError,KeyError,TypeError):return
 raise AssertionError('Synthetic invalid syscall receipt accepted')
def broad(files,receipt):
 value=copy.deepcopy(derived);value['syscalls'][-2]['args']=[];raw=json.dumps(value).encode();files['result/controls/glibc-native-seccomp.json']=raw;policy={'file':'glibc-native-seccomp.json',**r.pin(raw)};receipt['generatedControlPins']=[policy];receipt['syscallPreflight']['policy']=policy
reject(broad)
reject(lambda f,v:f.update({'result/seccomp-derived.log':b'changed raw data\n'}))
for key,value in [('exitCode',None),('signal','SIGTERM'),('reason','deadline'),('error','synthetic'),('stopError','cleanup'),('retainedBytes',-1)]:
 reject(lambda f,v:v['syscallPreflight']['modes']['derived']['observer'].update({key:value}))
reject(lambda f,v:v['syscallPreflight']['modes']['derived'].update({'imageId':'foreign'}))
reject(lambda f,v:v['syscallPreflight']['modes']['derived']['cleanup'].update({'state':'unavailable'}))
reject(lambda f,v:v['syscallRuntime'].update({'serverGitCommit':'foreign'}))
# Every numeric/boolean leaf in the new finite policy/probe/proof family is
# checked with a coherent raw log or generated-policy rehash where applicable.
def leaves(value,path=()):
 if type(value) is dict:
  for key,child in value.items():yield from leaves(child,path+(key,))
 elif type(value) is list:
  for key,child in enumerate(value):yield from leaves(child,path+(key,))
 elif type(value) in [int,bool]:yield path,value
def substitute(value):
 if type(value) is bool:return int(value)
 return bool(value) if value in [0,1] else float(value)
def assign(value,path,replacement):
 for key in path[:-1]:value=value[key]
 value[path[-1]]=replacement
def policy_type(files,receipt,path,replacement):
 value=copy.deepcopy(derived);assign(value,path,replacement);raw=json.dumps(value).encode();files['result/controls/glibc-native-seccomp.json']=raw;policy={'file':'glibc-native-seccomp.json',**r.pin(raw)};receipt['generatedControlPins']=[policy];receipt['syscallPreflight']['policy']=policy
policy_types=0
for field,value in leaves(derived):
 reject(lambda f,v:policy_type(f,v,field,substitute(value)));policy_types+=1
def probe_type(files,receipt,mode,path,replacement):
 row=receipt['syscallPreflight']['modes'][mode];assign(row['record'],path,replacement);raw=json.dumps(row['record']).encode();files['result/seccomp-'+mode+'.log']=raw;row['log']=r.pin(raw);row['observer']['retainedBytes']=len(raw)
probe_types=0
for mode in ['baseline','derived']:
 for field,value in leaves(record(mode)):
  reject(lambda f,v:probe_type(f,v,mode,field,substitute(value)));probe_types+=1
for key in ['reportedMetadataOnly','defaultProfileBytesIndependentlyAttestedFromDaemon','historicalPublisherConsumptionVerified']:
 reject(lambda f,v:v['syscallRuntime'].update({key:int(v['syscallRuntime'][key])}))
for key in ['originalBodyInvoked','fullCompilerSdkBootstrapClosureVerified','historicalPublisherConsumptionVerified','gateAComplete']:
 reject(lambda f,v:v['syscallPreflight'].update({key:0}))
for mode in ['baseline','derived']:
 for key in ['exactPredicatesObserved','originalBodyInvoked']:
  reject(lambda f,v:v['syscallPreflight']['modes'][mode]['predicates'].update({key:int(v['syscallPreflight']['modes'][mode]['predicates'][key])}))
 for field,value in [('exitCode',False),('retainedBytes',True),('retainedBytes',1.0)]:
  reject(lambda f,v:v['syscallPreflight']['modes'][mode]['observer'].update({field:value}))
 reject(lambda f,v:v['syscallPreflight']['modes'][mode]['log'].update({'bytes':float(v['syscallPreflight']['modes'][mode]['log']['bytes'])}))
reject(lambda f,v:v['generatedControlPins'][0].update({'bytes':float(v['generatedControlPins'][0]['bytes'])}))
reject(lambda f,v:v['syscallPreflight'].update({'schemaVersion':True}))
reject(lambda f,v:v['image'].update({'id':1}))
assert policy_types>0 and probe_types>0
assert r.exact_json({'a':[True,False,1,0,None]}, {'a':[True,False,1,0,None]})
for left,right in [(True,1),(False,0),(1.0,1),({'a':[False]},{'a':[0]}),(float('nan'),float('nan'))]:
 assert not r.exact_json(left,right),'Typed JSON coercion was accepted'
for mode in ['baseline','derived']:
 r.syscall_probe(record(mode),mode)
 for field in ['effective','permitted','bounding']:
  for bits in [1<<25,1<<21]:
   value=record(mode);value['capabilities'][field]=format(int(value['capabilities'][field],16)|bits,'016x')
   try:r.syscall_probe(value,mode)
   except ValueError:pass
   else:raise AssertionError('Clock/admin capability accepted')
 value=record(mode);value['personality']['near']={'result':0,'errno':sentinel}
 try:r.syscall_probe(value,mode)
 except ValueError:pass
 else:raise AssertionError('Near personality allowance accepted')
 value=record(mode);value['personality']['negativeQuery']['errno']=22
 try:r.syscall_probe(value,mode)
 except ValueError:pass
 else:raise AssertionError('Negative personality errno changed')
 value=record(mode);value['clock']['realtimeInvalidSet']['errno']=22
 try:r.syscall_probe(value,mode)
 except ValueError:pass
 else:raise AssertionError('Realtime near predicate changed')
print(json.dumps({'syntheticPureReplayControls':True,'probeSyntaxParsedWithoutExecution':True,'nativeKernelAcceptancePerformed':False,'gateAComplete':False}))
`;
    const result = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, repository],
      { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    assert.deepEqual(JSON.parse(result.stdout), {
      syntheticPureReplayControls: true,
      probeSyntaxParsedWithoutExecution: true,
      nativeKernelAcceptancePerformed: false,
      gateAComplete: false,
    });
  },
);

test("GLIBC Docker inspection requires the exact client-loaded policy and rejects neighboring security options", async () => {
  const { policy } = await api.loadGlibcSeccomp();
  const exact = "seccomp=" + JSON.stringify(policy);
  assert.equal(
    api.validateGlibcDockerSecurityOptions([], "baseline", policy),
    true,
  );
  assert.equal(
    api.validateGlibcDockerSecurityOptions(null, "baseline", policy),
    true,
  );
  assert.equal(
    api.validateGlibcDockerSecurityOptions([exact], "derived", policy),
    true,
  );
  for (const value of [
    [],
    null,
    ["seccomp=/synthetic/glibc-native-seccomp.json"],
    ["seccomp=unconfined"],
    ["x" + exact],
    [exact + " "],
    [exact, exact],
    [exact, "no-new-privileges"],
    ["no-new-privileges"],
  ])
    assert.throws(() =>
      api.validateGlibcDockerSecurityOptions(value, "derived", policy),
    );
  assert.throws(() =>
    api.validateGlibcDockerSecurityOptions([exact], "baseline", policy),
  );
  assert.throws(() =>
    api.validateGlibcDockerSecurityOptions([], "derived-near", policy),
  );
  for (const change of [
    (value: typeof policy) => {
      value.defaultAction = "SCMP_ACT_ALLOW";
    },
    (value: typeof policy) => {
      value.syscalls.at(-2).args = [];
    },
    (value: typeof policy) => {
      value.syscalls.at(-2).args[0].value = 0;
    },
    (value: typeof policy) => {
      value.syscalls.at(-1).args[0].value = 4294967275;
    },
  ]) {
    const changed = structuredClone(policy);
    change(changed);
    assert.throws(() =>
      api.validateGlibcDockerSecurityOptions(
        ["seccomp=" + JSON.stringify(changed)],
        "derived",
        policy,
      ),
    );
  }
});

test(
  "GLIBC probe uses the raw invalid-realtime syscall and refuses foreign ABIs or capabilities with synthetic C calls",
  {
    skip: python
      ? false
      : "Verified Python3 pure probe model unavailable: " +
        unavailable.join("; "),
  },
  () => {
    const program = String.raw`"""Synthetic libc calls only. No actual clock/personality/syscall function is loaded."""
import builtins,contextlib,ctypes,io,json,pathlib,sys,types
source=pathlib.Path(sys.argv[1]).read_bytes()
original_open,original_cdll,original_uname,original_sizeof=builtins.open,ctypes.CDLL,__import__('os').uname,ctypes.sizeof
original_argv=sys.argv[:];original_platform=sys.platform;original_long=ctypes.c_long;original_ulong=ctypes.c_ulong
results=[]
def run(mode,machine='x86_64',bad_size=False,bad_pointer=False,bad_timespec=False,platform='linux',capfield=None,capbit=None):
 ctypes.c_long=ctypes.c_int64;ctypes.c_ulong=ctypes.c_uint64
 state={'current':0,'cdll':0,'raw':[],'realtimeWrapper':0,'monotonicWrapper':0,'functions':[]}
 caps=dict.fromkeys(['CapEff','CapPrm','CapBnd'],'00000000a80425fb')
 if capfield:caps[capfield]=format(int(caps[capfield],16)|(1<<capbit),'016x')
 status=''.join(k+':\t'+v+'\n' for k,v in caps.items())
 def scalar(value):return value.value if hasattr(value,'value') else value
 class Function:
  def __init__(self,name):self.name=name;self.argtypes=None;self.restype=None
  def __call__(self,*args):
   state['functions'].append(self.name)
   if self.name=='personality':
    value=scalar(args[0])
    if value==0xffffffff:return state['current']
    if value==0xffffffeb or (value==0xffffffea and mode=='baseline'):ctypes.set_errno(1);return -1
    old=state['current'];state['current']=-22 if value==0xffffffea else value;return old
   if self.name=='clock_gettime':
    assert scalar(args[0])==1;args[1]._obj.tv_sec=100;args[1]._obj.tv_nsec=1;return 0
   if self.name=='clock_settime':
    clock=scalar(args[0]);ts=args[1]._obj
    if clock==0:
     state['realtimeWrapper']+=1;assert (ts.tv_sec,ts.tv_nsec)==(0,-1);ctypes.set_errno(22);return -1
    assert clock==1 and (ts.tv_sec,ts.tv_nsec)==(100,1);state['monotonicWrapper']+=1;ctypes.set_errno(1 if mode=='baseline' else 22);return -1
   assert self.name=='syscall'
   assert self.restype is ctypes.c_long and self.argtypes[0] is ctypes.c_long and self.argtypes[1] is ctypes.c_long
   number,clock=map(scalar,args[:2]);ts=args[2]._obj
   assert number==227 and clock==0 and (ts.tv_sec,ts.tv_nsec)==(0,-1),'Raw ABI or invalid realtime near miss changed'
   state['raw'].append({'number':number,'clock':clock,'seconds':ts.tv_sec,'nanoseconds':ts.tv_nsec});ctypes.set_errno(1);return -1
 class Libc:
  personality=Function('personality');clock_gettime=Function('clock_gettime');clock_settime=Function('clock_settime');syscall=Function('syscall')
 def cdll(*args,**kwargs):state['cdll']+=1;assert args==(None,) and kwargs=={'use_errno':True};return Libc()
 def opened(name,*args,**kwargs):
  if name=='/proc/self/status':return io.StringIO(status)
  return original_open(name,*args,**kwargs)
 import os
 def sized(kind):
  if bad_size and kind is ctypes.c_long:return 4
  if bad_pointer and kind is ctypes.c_void_p:return 4
  if bad_timespec and isinstance(kind,type) and issubclass(kind,ctypes.Structure):return 8
  return original_sizeof(kind)
 builtins.open=opened;ctypes.CDLL=cdll;os.uname=lambda:types.SimpleNamespace(machine=machine);ctypes.sizeof=sized;sys.argv=['synthetic-probe.py',mode];sys.platform=platform
 rejected=machine!='x86_64' or platform!='linux' or bad_size or bad_pointer or bad_timespec or capfield is not None
 try:
  captured=io.StringIO();refused=False
  try:
   with contextlib.redirect_stdout(captured):exec(compile(source,'synthetic-probe.py','exec'),{'__name__':'__main__'})
  except AssertionError:
   if not rejected:raise
   refused=True
  if rejected:
   assert refused and state['functions']==[] and state['raw']==[],'Admission guard failed before native-function access'
   if not bad_timespec:assert state['cdll']==0
   return {'refusedBeforeNativeFunction':True,'machine':machine,'platform':platform,'badLongSize':bad_size,'badPointerSize':bad_pointer,'badTimespecSize':bad_timespec,'capabilityField':capfield,'capabilityBit':capbit}
  record=json.loads(captured.getvalue());assert state['raw']==[{'number':227,'clock':0,'seconds':0,'nanoseconds':-1}],f"Expected one raw invalid realtime syscall; raw={state['raw']}, libc realtime calls={state['realtimeWrapper']}"
  assert state['realtimeWrapper']==0 and state['monotonicWrapper']==1
  assert record['clock']['realtimeInvalidSet']=={'result':-1,'errno':1};assert record['restored'] is True
  return {'mode':mode,'rawRealtimeCalls':1,'libcRealtimeCalls':0,'record':record,'nativeKernelInvoked':False}
 finally:
  builtins.open=original_open;ctypes.CDLL=original_cdll;os.uname=original_uname;ctypes.sizeof=original_sizeof;sys.argv=original_argv[:];sys.platform=original_platform;ctypes.c_long=original_long;ctypes.c_ulong=original_ulong
for mode in ['baseline','derived']:results.append(run(mode))
refusals=[run('baseline',machine='aarch64'),run('baseline',platform='darwin'),run('baseline',bad_size=True),run('baseline',bad_pointer=True),run('baseline',bad_timespec=True)]
for field in ['CapEff','CapPrm','CapBnd']:
 for bit in [21,25]:refusals.append(run('derived',capfield=field,capbit=bit))
print(json.dumps({'profiles':results,'refusals':refusals,'allCFunctionsSynthetic':True,'nativeKernelInvoked':False,'originalBodyInvoked':False}))
`;
    const result = spawnSync(
      python!,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        program,
        path.join(
          repository,
          "scripts/producer-qualification/glibc-seccomp-probe.py",
        ),
      ],
      { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    assert.equal(result.signal, null, diagnostic(result));
    const report = JSON.parse(result.stdout) as {
      profiles: Array<{
        mode: "baseline" | "derived";
        rawRealtimeCalls: number;
        libcRealtimeCalls: number;
        record: unknown;
        nativeKernelInvoked: boolean;
      }>;
      refusals: Array<{ refusedBeforeNativeFunction: boolean }>;
      allCFunctionsSynthetic: boolean;
      nativeKernelInvoked: boolean;
      originalBodyInvoked: boolean;
    };
    assert.deepEqual(
      report.profiles.map((row) => ({
        mode: row.mode,
        raw: row.rawRealtimeCalls,
        wrapper: row.libcRealtimeCalls,
      })),
      [
        { mode: "baseline", raw: 1, wrapper: 0 },
        { mode: "derived", raw: 1, wrapper: 0 },
      ],
    );
    for (const row of report.profiles) {
      assert.equal(row.nativeKernelInvoked, false);
      assert.deepEqual(api.validateGlibcSyscallProbe(row.record, row.mode), {
        mode: row.mode,
        exactPredicatesObserved: true,
        originalBodyInvoked: false,
      });
    }
    assert.equal(report.refusals.length, 11);
    assert.ok(
      report.refusals.every((row) => row.refusedBeforeNativeFunction === true),
    );
    assert.equal(report.allCFunctionsSynthetic, true);
    assert.equal(report.nativeKernelInvoked, false);
    assert.equal(report.originalBodyInvoked, false);
  },
);
