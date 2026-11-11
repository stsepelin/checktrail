import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const api = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-quiescent-sample.mjs",
    ),
  ).href
);
const directory = path.join(repository, "test/fixtures/c-controller-history");
const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
interface Pin {
  file: string;
  bytes: number;
  sha256: string;
}
interface Historical {
  commit: string;
  bytes: number;
  sha256: string;
  schemaVersion: number;
  stateSites: { line: number; source: string }[];
  atomicReceiptStateEmitSites: { line: number; source: string }[];
  workBoundSites: { line: number; condition: string }[];
}
interface Provenance {
  reviewedEpochs: Historical[];
  fixtures: {
    schemaVersion: number;
    file: string;
    bytes: number;
    sha256: string;
    license: { file: string; bytes: number; sha256: string };
  }[];
}
const provenance = JSON.parse(
  await readFile(path.join(directory, "provenance.json"), "utf8"),
) as Provenance;
const controllerPath = "scripts/qualify-c-producer.mjs";
const pin = (entry: { bytes: number; sha256: string }): Pin => ({
  file: controllerPath,
  bytes: entry.bytes,
  sha256: entry.sha256,
});
const legacyCollectorPin: Pin = {
  file: "scripts/producer-qualification/c-producer-test-reports.py",
  bytes: 18397,
  sha256: "9dee7066707382c33ba971fe63ded57c407454c81ed38ab30aa66b95b558691c",
};
const current = await readFile(path.join(repository, controllerPath));
const currentPin = {
  file: controllerPath,
  bytes: current.length,
  sha256: sha(current),
};

for (const entry of provenance.reviewedEpochs)
  test(
    "C trusted historical source " +
      entry.commit.slice(0, 8) +
      " binds exactly its emitted epoch",
    () => {
      assert.equal(entry.stateSites.length, 1);
      assert.equal(entry.atomicReceiptStateEmitSites.length, 3);
      assert.equal(entry.workBoundSites.length, 1);
      assert.equal(
        entry.workBoundSites[0]!.condition,
        "sample.bytes <= profile.limits.workByteLimit + allowance",
      );
      assert.equal(
        api.validateCControllerSourceEpoch(
          { schemaVersion: entry.schemaVersion },
          [pin(entry), legacyCollectorPin],
        ),
        entry.schemaVersion,
      );
      for (const schemaVersion of [1, 2, 3].filter(
        (value) => value !== entry.schemaVersion,
      ))
        assert.throws(
          () =>
            api.validateCControllerSourceEpoch({ schemaVersion }, [
              pin(entry),
              legacyCollectorPin,
            ]),
          /source identity requires receipt schema/u,
        );
    },
  );

test("C historical controllers refuse incompatible new collectors while current controllers preserve legacy compatibility", async () => {
  const raw = await readFile(path.join(repository, legacyCollectorPin.file));
  const currentCollector = {
    file: legacyCollectorPin.file,
    bytes: raw.length,
    sha256: sha(raw),
  };
  for (const entry of provenance.reviewedEpochs) {
    for (const collectors of [
      [],
      [currentCollector],
      [legacyCollectorPin, legacyCollectorPin],
      [{ ...legacyCollectorPin, bytes: legacyCollectorPin.bytes + 1 }],
      [{ ...legacyCollectorPin, file: "./" + legacyCollectorPin.file }],
    ])
      assert.throws(() =>
        api.validateCControllerSourceEpoch(
          { schemaVersion: entry.schemaVersion },
          [pin(entry), ...collectors],
        ),
      );
  }
  assert.equal(
    api.validateCControllerSourceEpoch({ schemaVersion: 3 }, [
      currentPin,
      legacyCollectorPin,
    ]),
    3,
  );
  assert.equal(
    api.validateCControllerSourceEpoch({ schemaVersion: 3 }, [
      currentPin,
      currentCollector,
    ]),
    3,
  );
});

test("C public historical implementation and original license assets remain exact inert bytes", async () => {
  assert.equal(provenance.reviewedEpochs.length, 12);
  assert.deepEqual(
    provenance.fixtures.map((value) => value.schemaVersion),
    [1, 2],
  );
  for (const entry of provenance.fixtures) {
    const raw = await readFile(path.join(directory, entry.file));
    assert.equal(raw.length, entry.bytes);
    assert.equal(sha(raw), entry.sha256);
    const known = provenance.reviewedEpochs.find(
      (value) => value.sha256 === sha(raw),
    );
    assert.ok(known);
    const lines = raw.toString("utf8").split("\n");
    for (const site of [
      ...known.stateSites,
      ...known.atomicReceiptStateEmitSites,
    ])
      assert.equal(lines[site.line - 1]!.trim(), site.source);
    const notice = await readFile(path.join(directory, entry.license.file));
    assert.equal(notice.length, entry.license.bytes);
    assert.equal(sha(notice), entry.license.sha256);
  }
});

test("C new-source epoch cannot be downgraded by stripping both policy and rows or supplying an archive index", () => {
  assert.equal(
    api.validateCControllerSourceEpoch({ schemaVersion: 3 }, [currentPin]),
    3,
  );
  for (const schemaVersion of [1, 2]) {
    const receipt = {
      schemaVersion,
      historicalCControllerEpochs: { [currentPin.sha256]: schemaVersion },
    };
    assert.throws(
      () => api.validateCControllerSourceEpoch(receipt, [currentPin]),
      /requires receipt schema3/u,
    );
  }
});

test("C source-epoch binding refuses missing duplicate noncanonical malformed and extra authority pins", () => {
  const candidates = [
    [],
    [currentPin, currentPin],
    [{ ...currentPin, file: "./" + controllerPath }],
    [{ ...currentPin, file: controllerPath + "-near" }],
    [{ ...currentPin, sha256: "z".repeat(64) }],
    [{ ...currentPin, sha256: currentPin.sha256 + "\n" }],
    [{ ...currentPin, bytes: 0 }],
    [{ ...currentPin, epoch: 2 }],
  ];
  for (const rows of candidates)
    assert.throws(() =>
      api.validateCControllerSourceEpoch({ schemaVersion: 3 }, rows),
    );
  const historical = pin(provenance.reviewedEpochs[0]!);
  assert.throws(() =>
    api.validateCControllerSourceEpoch({ schemaVersion: 2 }, [
      { ...historical, bytes: historical.bytes + 1 },
    ]),
  );
});

const python = ["python3", "python"].find((binary) => {
  const result = spawnSync(
    binary,
    ["-I", "-S", "-B", "-c", "import sys; print(sys.version_info.major)"],
    { encoding: "utf8", timeout: 3000 },
  );
  return !result.error && result.status === 0 && result.stdout.trim() === "3";
});
test(
  "C independent reader source epochs agree for every historical and stripped new-source frame",
  { skip: python ? false : "Verified Python3 reader unavailable" },
  () => {
    const cases = provenance.reviewedEpochs.flatMap((entry) =>
      [1, 2, 3].map((schemaVersion) => ({
        receipt: { schemaVersion },
        pins: [pin(entry), legacyCollectorPin],
        accepted: schemaVersion === entry.schemaVersion,
      })),
    );
    cases.push(
      ...[1, 2, 3].map((schemaVersion) => ({
        receipt: { schemaVersion },
        pins: [currentPin],
        accepted: schemaVersion === 3,
      })),
    );
    const program = String.raw`
import importlib.util,json,pathlib,sys
file=pathlib.Path(sys.argv[1])/'scripts/producer-qualification/c-producer-replay-evidence.py';spec=importlib.util.spec_from_file_location('trusted_c_reader',file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
results=[]
for case in json.load(sys.stdin):
 try:module.controller_source_epoch(case['receipt'],case['pins'])
 except ValueError:accepted=False
 else:accepted=True
 assert accepted is case['accepted']
 results.append(accepted)
print(json.dumps(results))
`;
    const result = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, repository],
      {
        input: JSON.stringify(cases),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      cases.map((value) => value.accepted),
    );
  },
);

function legacyCounters(epoch: number, middleBytes: number) {
  const entry = provenance.reviewedEpochs.find(
    (value) => value.schemaVersion === epoch,
  )!;
  const chunk = (stream: string, value: unknown) =>
    JSON.stringify({
      stream,
      base64: Buffer.from(JSON.stringify(value) + "\n").toString("base64"),
    }) + "\n";
  const samples = [9, middleBytes, 10].map((bytes, index) => ({
    schemaVersion: 1,
    kind: "sample",
    sequence: index + 1,
    bytes,
    files: 2,
    directories: 4,
  }));
  const raw = Buffer.from(
    chunk("stdout", {
      schemaVersion: 1,
      kind: "ready",
      roots: ["/observed/bundle", "/observed/controls", "/observed/work"],
    }) +
      samples
        .map(
          (sample) =>
            chunk("stdin", {
              schemaVersion: 1,
              kind: "sample",
              sequence: sample.sequence,
            }) + chunk("stdout", sample),
        )
        .join(""),
  );
  return {
    epoch,
    pins: [pin(entry), legacyCollectorPin],
    raw,
    observer: {
      retainedLogBytes: raw.length,
      samples: samples.length,
      lastSample: samples.at(-1)!,
      log: { bytes: raw.length, sha256: sha(raw) },
      ...(epoch === 2
        ? { workObjectPolicy: "c-build-links-and-specials-no-follow" }
        : {}),
    },
  };
}
for (const epoch of [1, 2])
  test(
    "C known historical epoch" +
      epoch +
      " checks coherent middle raw counter at the exact original allowance",
    () => {
      const exact = legacyCounters(epoch, 68),
        exceeded = legacyCounters(epoch, 69);
      for (const value of [exact, exceeded])
        assert.equal(
          api.validateCControllerSourceEpoch(
            { schemaVersion: epoch },
            value.pins,
          ),
          epoch,
        );
      assert.equal(
        api.validateCWorkSampleBounds(
          exact.raw,
          exact.observer,
          epoch === 2,
          68,
        ),
        3,
      );
      assert.throws(
        () =>
          api.validateCWorkSampleBounds(
            exceeded.raw,
            exceeded.observer,
            epoch === 2,
            68,
          ),
        /raw retention sample exceeded frozen work allowance/u,
      );
    },
  );

test(
  "C Python preserves known historical epochs while refusing matching oversized middle raw counter",
  { skip: python ? false : "Verified Python3 reader unavailable" },
  () => {
    const cases = [1, 2].flatMap((epoch) =>
      [68, 69].map((middle) => {
        const value = legacyCounters(epoch, middle);
        return {
          ...value,
          raw: value.raw.toString("base64"),
          accepted: middle === 68,
        };
      }),
    );
    const program = String.raw`
import base64,importlib.util,json,pathlib,sys
file=pathlib.Path(sys.argv[1])/'scripts/producer-qualification/c-producer-replay-evidence.py';spec=importlib.util.spec_from_file_location('trusted_c_bound_reader',file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
results=[]
for case in json.load(sys.stdin):
 assert module.controller_source_epoch({'schemaVersion':case['epoch']},case['pins'])==case['epoch']
 selected={'schemaVersion':case['epoch'],'observerLimit':(16 if case['epoch']==1 else 256)*1024**2,'samples':1000000 if case['epoch']==1 else 9000}
 try:module.retention(base64.b64decode(case['raw']),case['observer'],selected,maximum_bytes=68)
 except ValueError as error:
  assert str(error)=='C raw retention sample exceeded frozen work allowance'
  accepted=False
 else:accepted=True
 assert accepted is case['accepted']
 results.append(accepted)
print(json.dumps(results))
`;
    const result = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, repository],
      {
        input: JSON.stringify(cases),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [true, false, true, false]);
  },
);

test("C exact historical implementation bytes disable checkout conversion only in their fixture directory", () => {
  const files = [
    ...provenance.fixtures.flatMap((entry) => [
      "test/fixtures/c-controller-history/" + entry.file,
      "test/fixtures/c-controller-history/" + entry.license.file,
    ]),
    "test/fixtures/c-controller-history/schema2-report-collector.py.txt",
  ];
  const near = "test/fixtures/c-controller-history-near/source.txt";
  const output = execFileSync(
    "git",
    ["check-attr", "text", "--", ...files, near],
    { cwd: repository, encoding: "utf8" },
  );
  assert.deepEqual(output.trimEnd().split("\n"), [
    ...files.map((file) => file + ": text: unset"),
    near + ": text: auto",
  ]);
});

test(
  "C actual live reader routes verified source epochs before the next header delegate",
  {
    skip:
      process.platform === "win32"
        ? "POSIX caller-custody delegation control unavailable on this host"
        : false,
  },
  async (t) => {
    const root = await fixture(t, {});
    const result = spawnSync(
      process.execPath,
      [
        path.join(repository, "test/fixtures/c-producer-epoch-routing.mjs"),
        repository,
        root,
      ],
      { encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.liveReaderBodyUnchanged, true);
    assert.equal(observed.startupAndNextHeaderAreAuthoredDelegates, true);
    assert.equal(
      observed.sourceCapsuleOrHistoricalImplementationExecuted,
      false,
    );
    assert.equal(observed.nativeProducerExecuted, false);
    assert.deepEqual(observed.rows, [
      { label: "current3", reachedNextHeader: true },
      { label: "stripped-current1", reachedNextHeader: false },
      { label: "stripped-current2", reachedNextHeader: false },
      { label: "known1", reachedNextHeader: true },
      { label: "known2", reachedNextHeader: true },
      { label: "upgraded-old1", reachedNextHeader: false },
      { label: "upgraded-old2", reachedNextHeader: false },
      { label: "duplicate-controller", reachedNextHeader: false },
    ]);
  },
);
