import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  link,
  lstat,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture as sourceFixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const moduleAt = (file: string) =>
  import(pathToFileURL(path.join(repository, file)).href);
const profiles = await moduleAt(
  "scripts/producer-qualification/c-producer-profile.mjs",
);
const controller = await moduleAt("scripts/qualify-c-producer.mjs");
const acquisition = await moduleAt("scripts/acquire-c-producer-inputs.mjs");
const observation = await moduleAt(
  "scripts/producer-qualification/c-carrier-observation.mjs",
);
const { catalog, profile: u13 } =
  await profiles.loadCProducerProfile("glibc-u13");
const u14 = catalog.profiles.glibc;
const fixture = async (
  t: Parameters<typeof sourceFixture>[0],
  files: Record<string, string>,
) => realpath(await sourceFixture(t, files));

test("u13 is a separate exact public key with 159 unchanged inputs and fresh signer scope", async () => {
  assert.equal(profiles.cProducerProfileKey(u13), "glibc-u13");
  assert.equal(u13.sourcePackage, "glibc");
  assert.equal(profiles.cProducerProfileKey(u14), "glibc");
  assert.equal(u13.sourceVersion, "2.36-9+deb12u13");
  assert.equal(u14.sourceVersion, "2.36-9+deb12u14");
  assert.equal(u13.files.length, 161);
  const selected = (row: { file: string }) =>
    row.file === "source/glibc/glibc_2.36-9+deb12u13.dsc" ||
    row.file === "source/glibc/glibc_2.36-9+deb12u13.debian.tar.xz";
  const oldSelected = (row: { file: string }) =>
    row.file === "source/glibc/glibc_2.36-9+deb12u14.dsc" ||
    row.file === "source/glibc/glibc_2.36-9+deb12u14.debian.tar.xz";
  assert.equal(u13.files.filter(selected).length, 2);
  assert.equal(
    u13.files.filter((row: { file: string }) => !selected(row)).length,
    159,
  );
  assert.deepEqual(
    u13.files.filter((row: { file: string }) => !selected(row)),
    u14.files.filter((row: { file: string }) => !oldSelected(row)),
  );
  assert.equal(u13.sourceDescriptorSigner, null);
  assert.equal(u13.freshSourceDescriptorSignatureVerified, false);
  assert.equal(u13.historicalPrivateInputReplayVerified, false);
  assert.equal(u13.originalProducerRules.length, 48);
  assert.equal(u13.capturedOriginalNotices.length, 5);
  assert.equal(u13.gateAComplete, false);
  for (const key of [
    "glibc-u130",
    "glibc-u13-extra",
    "GLIBC-u13",
    "glibc-2.36",
    "",
  ]) {
    await assert.rejects(
      profiles.loadCProducerProfile(key),
      /Unknown closed producer/,
    );
    assert.throws(
      () => observation.requireCObservationProfile(key),
      /Unknown C observation/,
    );
  }
});

test("u13 source/version/descriptor tuple cannot cross the u14 startup or select an arbitrary DSC", () => {
  const startup = {
    selectedProfile: {
      name: "glibc-u13",
      profile: u13.profile,
      sourceVersion: u13.sourceVersion,
      catalogSha256: profiles.cProducerCatalogSha256,
    },
  };
  observation.validateCStartupProfile(
    startup,
    "glibc-u13",
    u13,
    profiles.cProducerCatalogSha256,
  );
  assert.throws(
    () =>
      observation.validateCStartupProfile(
        startup,
        "glibc",
        u13,
        profiles.cProducerCatalogSha256,
      ),
    /key\/source tuple/,
  );
  for (const mutate of [
    (value: typeof u13) => {
      value.sourcePackage = "glibc-u13";
    },
    (value: typeof u13) => {
      value.sourceVersion = "2.36-9+deb12u14";
    },
    (value: typeof u13) => {
      value.descriptor = "source/glibc/foreign.dsc";
    },
    (value: typeof u13) => {
      value.profile += "-extra";
    },
  ]) {
    const value = structuredClone(u13);
    mutate(value);
    assert.throws(
      () => profiles.cProducerProfileKey(value),
      /exact C producer key\/source/,
    );
  }
});

test("u13 catalog refuses wrong source pins, inherited signer claims and limit increases", () => {
  for (const [mutate, reason] of [
    [
      (value: typeof catalog) => {
        value.profiles["glibc-u13"].files.find(
          (row: { file: string }) => row.file === u13.descriptor,
        ).sha256 = "0".repeat(64);
      },
      /Exact u13 source descriptor\/archive pins/,
    ],
    [
      (value: typeof catalog) => {
        value.profiles["glibc-u13"].files.find(
          (row: { kind?: string }) =>
            row.kind === "authenticated-package-archive",
        ).sha256 = "0".repeat(64);
      },
      /159 unchanged u13 bootstrap/,
    ],

    [
      (value: typeof catalog) => {
        value.profiles["glibc-u13"].sourceDescriptorSigner =
          u14.sourceDescriptorSigner;
      },
      /signer identity is not yet observed/,
    ],
    [
      (value: typeof catalog) => {
        value.profiles["glibc-u13"].freshSourceDescriptorSignatureVerified =
          true;
      },
      /Expected values to be strictly equal/,
    ],
    [
      (value: typeof catalog) => {
        value.profiles["glibc-u13"].limits.deadlineSeconds++;
      },
      /Expected values to be strictly deep-equal/,
    ],
  ] as const) {
    const value = structuredClone(catalog);
    mutate(value);
    assert.throws(() => profiles.validateCProducerCatalog(value), reason);
  }
  const value = structuredClone(catalog);
  const index = value.profiles.glibc.files.findIndex(
    (row: { kind?: string; file: string }) =>
      row.kind === "authenticated-package-archive" &&
      !catalog.commonInputs.some(
        (common: { file: string }) => common.file === row.file,
      ),
  );
  assert.ok(index >= 0);
  for (const key of ["glibc", "glibc-u13"])
    value.profiles[key].files[index].bytes = 128 * 1024 ** 2;
  profiles.validateCProducerCatalog(value);
  for (const key of ["glibc", "glibc-u13"])
    value.profiles[key].files[index].bytes++;
  assert.throws(() => profiles.validateCProducerCatalog(value), /finite bound/);
});

test("u13 native vector selects its key while preserving glibc source and APT layout", async () => {
  for (const key of ["gcc-12", "glibc", "glibc-u13"]) {
    const { catalog: selectedCatalog, profile } =
      await profiles.loadCProducerProfile(key);
    const argv: string[] = controller.cProducerArguments(
      selectedCatalog,
      profile,
      path.resolve("synthetic-u13-producer"),
      "12345678-1234-4234-8234-123456789012",
      { uid: 1001, gid: 1002 },
    );
    assert.deepEqual(argv.slice(-4), [
      "/controller/c-producer-build.sh",
      key,
      "1001",
      "1002",
    ]);
    assert.ok(argv.includes("none") && argv.includes("--pull=never"));
    assert.ok(argv.includes(String(profile.limits.deadlineSeconds)));
    assert.ok(!argv.some((arg) => /nocheck|disable-tests/u.test(arg)));
    if (profile.sourcePackage === "glibc")
      assert.ok(argv.some((arg) => arg.endsWith("glibc-native-seccomp.json")));
  }
});

test("retained u13 preflight and copies preserve three inputs and refuse aliases, changed bytes and foreign names", async (t) => {
  const text = "synthetic data only\r\n";
  const sourceRows = u13.files
    .filter(
      (row: { kind?: string }) =>
        row.kind === "signed-source-descriptor" ||
        row.kind === "original-source-archive",
    )
    .map((row: { file: string; kind: string }) => ({
      ...row,
      bytes: Buffer.byteLength(text),
      sha256: profiles.sha256(text),
    }));
  const source = await fixture(
    t,
    Object.fromEntries(
      sourceRows.map((row: { file: string }) => [
        path.basename(row.file),
        text,
      ]),
    ),
  );
  const outputParent = await fixture(t, {});
  const output = path.join(outputParent, "new-output");
  const synthetic = { ...u13, files: sourceRows };
  const result = await acquisition.validateRetainedU13SourceInputs(
    synthetic,
    source,
    output,
  );
  assert.equal(result.retainedSource, source);
  assert.equal(result.sourceRows.length, 3);
  const copies = await fixture(t, {});
  for (const row of result.sourceRows) {
    const target = path.join(copies, path.basename(row.file));
    assert.deepEqual(
      await acquisition.copyRetainedU13SourceInput(result, row, target),
      { kind: "exact-retained-u13-source-copy" },
    );
    assert.equal(await readFile(target, "utf8"), text);
  }
  const first = result.sourceRows[0];
  const sourceFile = path.join(source, path.basename(first.file));
  const existingAlias = path.join(copies, "existing-alias");
  await link(sourceFile, existingAlias);
  await assert.rejects(
    acquisition.copyRetainedU13SourceInput(result, first, existingAlias),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(sourceFile, "utf8"), text);
  assert.equal(await readFile(existingAlias, "utf8"), text);
  assert.equal((await lstat(sourceFile)).ino, (await lstat(existingAlias)).ino);
  const foreignCopy = path.join(copies, "foreign-copy");
  await assert.rejects(
    acquisition.copyRetainedU13SourceInput(
      result,
      { ...first, file: "source/glibc/foreign.dsc" },
      foreignCopy,
    ),
    /Only a preflight-admitted u13 source row/,
  );
  await assert.rejects(lstat(foreignCopy), { code: "ENOENT" });
  const wrongTarget = path.join(copies, "changed-after-preflight");
  await writeFile(sourceFile, text.replace("synthetic", "SYNTHETIC"));
  await assert.rejects(
    acquisition.copyRetainedU13SourceInput(result, first, wrongTarget),
    /Pinned input changed before copy/,
  );
  await assert.rejects(lstat(wrongTarget), { code: "ENOENT" });
  await writeFile(sourceFile, text);

  assert.deepEqual(
    result.retainedRows.map((row: { file: string }) => row.file).sort(),
    sourceRows.map((row: { file: string }) => path.basename(row.file)).sort(),
  );
  await assert.rejects(lstat(output), { code: "ENOENT" });
  const changed = structuredClone(synthetic);
  changed.files[0].sha256 = "0".repeat(64);
  await assert.rejects(
    acquisition.validateRetainedU13SourceInputs(changed, source, output),
    /Pinned input mismatch/,
  );
  const foreign = structuredClone(synthetic);
  foreign.files[0].file += ".old";
  await assert.rejects(
    acquisition.validateRetainedU13SourceInputs(foreign, source, output),
    /Exactly three closed u13 source input names/,
  );
  await assert.rejects(
    acquisition.validateRetainedU13SourceInputs(
      synthetic,
      source,
      path.join(source, "nested-output"),
    ),
    /roots overlap/,
  );
  await assert.rejects(
    acquisition.validateRetainedU13SourceInputs(u14, source, output),
    /only for the exact u13 tuple/,
  );
  await acquisition.validateRetainedU13SourceInputs(synthetic, source, output);
});

test(
  "retained u13 preflight refuses linked source directory before output",
  {
    skip:
      process.platform === "win32"
        ? "POSIX symlink control unavailable"
        : false,
  },
  async (t) => {
    const parent = await fixture(t, {});
    const target = await fixture(t, {});
    const linked = path.join(parent, "linked");
    await symlink(target, linked);
    await assert.rejects(
      acquisition.validateRetainedU13SourceInputs(
        u13,
        linked,
        path.join(parent, "new-output"),
      ),
      /Linked path refused/,
    );
    await assert.rejects(lstat(path.join(parent, "new-output")), {
      code: "ENOENT",
    });
  },
);

test(
  "u13 real export packets select GLIBC proofs, retain missing evidence and preserve failed report outcomes",
  {
    skip:
      process.platform === "win32"
        ? "POSIX Python report custody control unavailable"
        : false,
  },
  async (t) => {
    const root = await fixture(t, {});
    const program = String.raw`
import importlib.util,json,os,pathlib,sys
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2])
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,repo/'scripts/producer-qualification'/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
collector=load('u13_synthetic_collector','c-producer-test-reports.py')
exporter=load('u13_synthetic_exporter','c-producer-export-evidence.py')
reader=load('u13_synthetic_reader','c-producer-replay-evidence.py')
source=root/'source'
for name,raw in [('one',b'PASS: first\nXPASS: preserved unexpected pass\n'),('two',b'FAIL: second\nUNSUPPORTED: preserved unavailable\n')]:
 target=source/'build-tree'/name;target.mkdir(parents=True);(target/'tests.sum').write_bytes(raw)
result=root/'result';(result/'work').mkdir(parents=True)
caller={'uid':os.getuid(),'gid':os.getgid()}
collector.collect('glibc-u13',source,result/'work/test-reports.json',caller)
report=json.loads((result/'work/test-reports.json').read_bytes())
assert report['profile']=='glibc-u13' and len(report['reports'])==2 and report['generatedBuildRoots']==['build-tree']
assert sum(row['counts']['XPASS']for row in report['reports'])==1 and sum(row['counts']['FAIL']for row in report['reports'])==1
startup=root/'startup.json';startup.write_text(json.dumps({'caller':caller}));startup.chmod(0o600)
(root/'inputs').mkdir();(root/'common').mkdir()
policy_bytes={'seccomp-baseline.log':b'{"synthetic":"baseline"}\n','seccomp-derived.log':b'{"synthetic":"derived"}\n','controls/glibc-native-seccomp.json':b'{"synthetic":"policy"}\n'}
for name,raw in policy_bytes.items():
 target=result/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw);target.chmod(0o600)
carrier=root/'result-carrier';carrier.mkdir()
carrier_bytes={'receipt.json':b'{"synthetic":"gcc receipt"}\n','controller.log':b'synthetic GCC controller\n','owner-frame.json':b'{"synthetic":"gcc owner"}\n'}
for name,raw in carrier_bytes.items():(carrier/name).write_bytes(raw)
for family in ['glibc','glibc-u13']:
 family_archive=root/(family+'-family.zip')
 exporter.export(repo,root/'inputs',root/'common',result,startup,family_archive,profile_name=family)
 family_packet=reader.Packet(family_archive)
 try:
  for name,raw in policy_bytes.items():assert family_packet.read('result/'+name,65536)==raw,'GLIBC family lost actual raw proof: '+family+'/'+name
  assert not any(name.startswith('carrier/')for name in family_packet.files),'GLIBC family included adjacent GCC carrier bytes'
  assert not any(row['file'].startswith('carrier/')for row in family_packet.manifest['unavailable']),'GLIBC family required nonexistent GCC evidence'
 finally:family_packet.close()
gcc_archive=root/'gcc-family.zip';exporter.export(repo,root/'inputs',root/'common',result,startup,gcc_archive,profile_name='gcc-12',carrier=carrier)
gcc_packet=reader.Packet(gcc_archive)
try:
 for name,raw in carrier_bytes.items():assert gcc_packet.read('carrier/'+name,65536)==raw
 assert not any('result/'+name in gcc_packet.files for name in policy_bytes),'GCC family included GLIBC-only policy bytes'
finally:gcc_packet.close()
missing=result/'seccomp-derived.log';missing.unlink()
try:
 missing_archive=root/'u13-missing-proof.zip';exporter.export(repo,root/'inputs',root/'common',result,startup,missing_archive,profile_name='glibc-u13')
 missing_packet=reader.Packet(missing_archive)
 try:
  assert any(row['file']=='result/seccomp-derived.log'for row in missing_packet.manifest['unavailable']),'Missing real GLIBC proof was silently dropped'
  assert not any(row['file'].startswith('carrier/')for row in missing_packet.manifest['unavailable'])
 finally:missing_packet.close()
finally:missing.write_bytes(policy_bytes['seccomp-derived.log']);missing.chmod(0o600)
for foreign in ['glibc-u130','glibc-u13-extra','GLIBC-u13']:
 foreign_archive=root/(foreign+'.zip')
 try:exporter.export(repo,root/'inputs',root/'common',result,startup,foreign_archive,profile_name=foreign)
 except RuntimeError as error:assert str(error)=='Unknown selected original C profile'
 else:raise AssertionError('Adjacent profile identifier accepted')
 assert not foreign_archive.exists()
archive=root/'synthetic-u13.zip'
exporter.export(repo,root/'inputs',root/'common',result,startup,archive,profile_name='glibc-u13')
packet=reader.Packet(archive)
try:
 assert packet.manifest['selectedProfile']=='glibc-u13'
 observed=reader.reports(packet,'result/work/original-test-reports',report,caller,os.geteuid(),'glibc-u13')
 assert observed['observedOutcomeLines']==4 and observed['testEvidenceState']=='failed'
 assert observed['originalOutcomesPreserved']and observed['reportsPooledAsIndependentEvidence']is False
 for wrong in ['glibc-u130','glibc-u13-extra','glibc']:
  try:reader.reports(packet,'result/work/original-test-reports',report,caller,os.geteuid(),wrong)
  except ValueError:pass
  else:raise AssertionError('cross-profile reports accepted')
finally:packet.close()
try:reader.replay(archive,repo,'glibc-u13')
except ValueError as error:assert 'Incomplete raw C export'in str(error)
else:raise AssertionError('synthetic metadata qualified an original build')
print(json.dumps({'reports':2,'preservedXPASS':1,'buildQualified':False,'profileFamilies':3,'glibcProofMembers':3,'missingProofPreserved':True}))
`;
    const result = spawnSync(
      "python3",
      ["-I", "-S", "-B", "-c", program, repository, root],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 128 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      reports: 2,
      preservedXPASS: 1,
      buildQualified: false,
      profileFamilies: 3,
      glibcProofMembers: 3,
      missingProofPreserved: true,
    });
  },
);

// Original u13 signature and offline build-dependency admission still require
// separate actual native evidence; these tests use synthetic data only.

test("u13 default acquisition reaches ordinary input admission without requiring an offline source flag", async (t) => {
  const root = await fixture(t, {});
  const output = path.join(root, "new-output");
  await assert.rejects(
    acquisition.acquireCProducerInputs(
      "glibc-u13",
      path.join(root, "absent-common"),
      output,
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("u13 hosted path fixes every selector and preserves the original u14 command and retention budgets", async () => {
  const oldWorkflow = parse(
    await readFile(
      path.join(repository, ".github/workflows/upstream-glibc.yml"),
      "utf8",
    ),
  );
  const workflow = parse(
    await readFile(
      path.join(repository, ".github/workflows/upstream-glibc-u13.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(oldWorkflow.on.push.branches, [
    "pr/upstream-producer/glibc-*",
    "!pr/upstream-producer/glibc-u13-*",
  ]);
  assert.deepEqual(workflow.on.push.branches, [
    "pr/upstream-producer/glibc-u13-*",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(
    workflow.concurrency.group,
    "original-glibc-u13-${{ github.ref }}",
  );
  assert.deepEqual(Object.keys(workflow.jobs), [
    "original-glibc-u13-observation",
  ]);
  const job = workflow.jobs["original-glibc-u13-observation"];
  const original = oldWorkflow.jobs["original-glibc-observation"];
  const expected = structuredClone(original);
  for (const step of expected.steps) {
    if (step.run)
      step.run = step.run
        .replaceAll("--profile glibc", "--profile glibc-u13")
        .replaceAll(".profiles.glibc;", '.profiles["glibc-u13"];')
        .replaceAll("$RUNNER_TEMP/glibc-", "$RUNNER_TEMP/glibc-u13-");
    if (step.with?.name)
      step.with.name = step.with.name.replace(
        "original-glibc-",
        "original-glibc-u13-",
      );
    if (step.with?.path)
      step.with.path = step.with.path.replace("/glibc-", "/glibc-u13-");
  }
  assert.deepEqual(job, expected);
  assert.equal(job["timeout-minutes"], 360);
  assert.ok(
    job.steps.reduce(
      (sum: number, step: { "timeout-minutes": number }) =>
        sum + step["timeout-minutes"],
      0,
    ) <= 360,
  );
  const commands = job.steps
    .map((step: { run?: string }) => step.run ?? "")
    .join("\n");
  assert.equal(
    (commands.match(/--profile glibc-u13(?=\s|$)/g) ?? []).length,
    7,
  );
  assert.ok(!/--profile glibc(?=\s|$)/.test(commands));
  assert.ok(commands.includes('.profiles["glibc-u13"]'));
  const { cObservationSources } = await moduleAt(
    "scripts/verify-c-producer-observation.mjs",
  );
  assert.ok(
    cObservationSources.includes(".github/workflows/upstream-glibc-u13.yml"),
  );
  for (const file of [
    "c-producer-export-evidence.py",
    "c-producer-replay-evidence.py",
  ]) {
    assert.ok(
      (
        await readFile(
          path.join(repository, "scripts/producer-qualification", file),
          "utf8",
        )
      ).includes("'.github/workflows/upstream-glibc-u13.yml'"),
    );
  }
});
