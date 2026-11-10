import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  sampleQuiescentCProducer,
  cProducerRetentionSamplingPolicy,
  validateCQuiescentResourceSamples,
} = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-quiescent-sample.mjs",
    ),
  ).href
);
const attempt = "12345678-1234-4234-8234-123456789abc";
const image = "docker.io/coqorg/coq@sha256:" + "a".repeat(64);
const id = "b".repeat(64);
const nofollowPython = ["python3", "python"].find((executable) => {
  const result = spawnSync(
    executable,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import os,sys; assert sys.version_info.major == 3 and hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY') and os.scandir in os.supports_fd; print('nofollow-fd-walk')",
    ],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  return (
    !result.error &&
    result.status === 0 &&
    result.signal === null &&
    result.stdout.trim() === "nofollow-fd-walk"
  );
});
const nofollowSkip = nofollowPython
  ? false
  : "Verified POSIX Python3 no-follow walker unavailable";
const sampleValue = {
  schemaVersion: 1,
  kind: "sample",
  sequence: 1,
  bytes: 17,
  files: 2,
  directories: 4,
};
interface QuiescentRow {
  schemaVersion: number;
  name: string;
  image: string;
  id: string | null;
  nativeStarted: boolean;
  nativeTerminalObservedBeforeSample: boolean;
  nativeTerminalObservedAtCompletion: boolean;
  sample: typeof sampleValue;
  actions: string[];
  elapsedMilliseconds: number;
  complete: boolean;
  errors: string[];
}
function fixture() {
  const state = {
    Running: true,
    Paused: false,
    Restarting: false,
    Dead: false,
  };
  const row = {
    Id: id,
    Name: "/checktrail-producer-" + attempt,
    Config: {
      Image: image,
      Labels: { "io.checktrail.producer-attempt": attempt },
    },
    State: state,
  };
  const calls: string[][] = [];
  const observations: { complete: boolean; actions: string[] }[] = [];
  let sampleCalls = 0;
  const f = {
    row,
    state,
    calls,
    observations,
    present: true,
    nativeStarted: true,
    finished: false,
    pauseAcknowledged: true,
    pauseError: undefined as Error | undefined,
    resumeError: undefined as Error | undefined,
    sampleError: undefined as Error | undefined,
    recordError: undefined as Error | undefined,
    onSample: undefined as (() => Promise<typeof sampleValue>) | undefined,
    onPause: undefined as (() => void) | undefined,
    onUnpause: undefined as (() => void) | undefined,
    listCount: 0,
    onList: undefined as (() => void) | undefined,
    rebound: false,
    async docker(argv: string[]) {
      calls.push(argv);
      if (argv[0] === "ps") {
        f.listCount++;
        f.onList?.();
        return {
          stdout: !f.present
            ? ""
            : f.rebound && f.listCount > 1
              ? "c".repeat(64) + "\n"
              : id + "\n",
        };
      }
      if (argv[0] === "inspect") {
        assert.deepEqual(argv, ["inspect", id]);
        if (!f.present) throw missingContainer();
        return { stdout: JSON.stringify([row]) };
      }
      if (argv[0] === "pause") {
        assert.deepEqual(argv, ["pause", id]);
        f.onPause?.();
        state.Paused = f.pauseAcknowledged;
        if (f.pauseError) throw f.pauseError;
        return { stdout: id + "\n" };
      }
      if (argv[0] === "unpause") {
        assert.deepEqual(argv, ["unpause", id]);
        if (f.resumeError) throw f.resumeError;
        state.Paused = false;
        f.onUnpause?.();
        return { stdout: id + "\n" };
      }
      throw Error("Unexpected Docker operation " + argv.join(" "));
    },
    async run() {
      return sampleQuiescentCProducer({
        attempt,
        image,
        docker: f.docker,
        nativeStarted: f.nativeStarted,
        nativeFinished: () => f.finished,
        record: (r: { complete: boolean; actions: string[] }) => {
          observations.push(r);
          if (f.recordError) throw f.recordError;
        },
        sample: async () => {
          sampleCalls++;
          calls.push(["actual-sample"]);
          if (f.nativeStarted && f.present && state.Running)
            assert.equal(
              state.Paused,
              true,
              "A running writer must be frozen before its resource scan",
            );
          if (f.sampleError) throw f.sampleError;
          return f.onSample
            ? f.onSample()
            : { ...sampleValue, sequence: sampleCalls };
        },
      });
    },
    observation: () => {
      assert.equal(observations.length, 1);
      const row = observations[0];
      assert.ok(row);
      return row;
    },
    sampleCalls: () => sampleCalls,
  };
  return f;
}
test("local GCC resource scan freezes the exact owned container before sampling and resumes it afterward", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), sampleValue);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    [
      "ps",
      "inspect",
      "pause",
      "inspect",
      "actual-sample",
      "ps",
      "inspect",
      "unpause",
      "inspect",
    ],
  );
  assert.equal(f.sampleCalls(), 1);
  assert.equal(f.state.Paused, false);
  assert.deepEqual(f.observation().actions, [
    "pause-requested",
    "paused-acknowledged",
    "sample-completed",
    "unpause-requested",
    "unpaused-acknowledged",
  ]);
  assert.equal(f.observation().complete, true);
});
test("local GCC failed strict resource sample still resumes its writer and preserves the actual error", async () => {
  const f = fixture();
  const error = Error("Authored strict filesystem failure");
  f.sampleError = error;
  await assert.rejects(f.run(), (e) => e === error);
  assert.equal(f.state.Paused, false);
  assert.equal(f.sampleCalls(), 1);
  assert.equal(f.observation().complete, false);
  assert.ok(f.calls.some((a) => a[0] === "unpause"));
});
test("local GCC resume failure cannot turn a successful sample into passing measurement", async () => {
  const f = fixture();
  const error = Error("Authored resume failure");
  f.resumeError = error;
  await assert.rejects(f.run(), (e) => e === error);
  assert.equal(f.sampleCalls(), 1);
  assert.equal(f.observation().complete, false);
});
test("local GCC simultaneous scan and resume failures preserve both actual errors", async () => {
  const f = fixture();
  const scan = Error("Authored scan failure");
  const resume = Error("Authored resume failure");
  f.sampleError = scan;
  f.resumeError = resume;
  await assert.rejects(f.run(), (e) => {
    assert.ok(e instanceof AggregateError);
    assert.deepEqual(e.errors, [scan, resume]);
    return true;
  });
  assert.equal(f.observation().complete, false);
});
test("local GCC uncertain pause completion attempts resume before retaining its failure", async () => {
  const f = fixture();
  const error = Error("Authored lost pause response");
  f.pauseError = error;
  await assert.rejects(f.run(), (e) => e === error);
  assert.equal(f.sampleCalls(), 0);
  assert.equal(f.state.Paused, false);
  assert.ok(f.calls.some((a) => a[0] === "unpause"));
});
test("local GCC acknowledged pause command without native paused state never reaches a resource scan", async () => {
  const f = fixture();
  f.pauseAcknowledged = false;
  await assert.rejects(f.run(), /freeze was not acknowledged/u);
  assert.equal(f.sampleCalls(), 0);
  assert.equal(f.state.Paused, false);
  assert.equal(f.observation().complete, false);
});
for (const field of ["owner", "name", "id", "image"])
  test(
    "local GCC refuses a different " + field + " before pausing or sampling",
    async () => {
      const f = fixture();
      if (field === "owner")
        f.row.Config.Labels["io.checktrail.producer-attempt"] = attempt + "0";
      else if (field === "name") f.row.Name += "-other";
      else if (field === "id") f.row.Id = "c".repeat(64);
      else f.row.Config.Image = image + "0";
      await assert.rejects(f.run());
      assert.equal(f.sampleCalls(), 0);
      assert.deepEqual(
        f.calls.map((a) => a[0]),
        ["ps", "inspect"],
      );
      assert.equal(f.observation().complete, false);
    },
  );
test("local GCC preserves another owner's preexisting paused state", async () => {
  const f = fixture();
  f.state.Paused = true;
  await assert.rejects(f.run(), /already paused/u);
  assert.equal(f.sampleCalls(), 0);
  assert.equal(f.state.Paused, true);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ["ps", "inspect"],
  );
});
test("local GCC does not resume a container that replaced the owned name", async () => {
  const f = fixture();
  f.rebound = true;
  await assert.rejects(f.run(), /name was rebound/u);
  assert.equal(f.sampleCalls(), 1);
  assert.equal(f.calls.filter((a) => a[0] === "unpause").length, 0);
  assert.equal(f.observation().complete, false);
});
test("local GCC absent pre-admission valid case samples before starting an upstream writer", async () => {
  const f = fixture();
  f.present = false;
  f.nativeStarted = false;
  assert.deepEqual(await f.run(), sampleValue);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ["ps", "actual-sample"],
  );
  assert.deepEqual(f.observation().actions, [
    "absent-before-admission",
    "sample-completed",
  ]);
});
test("local GCC unexpected existing container cannot become a pre-admission sample", async () => {
  const f = fixture();
  f.nativeStarted = false;
  await assert.rejects(f.run(), /already exists before/u);
  assert.equal(f.sampleCalls(), 0);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ["ps"],
  );
});
test("local GCC absent post-terminal valid case requires a repeated positive absence check", async () => {
  const f = fixture();
  f.present = false;
  f.finished = true;
  assert.deepEqual(await f.run(), sampleValue);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ["ps", "ps", "actual-sample"],
  );
  assert.deepEqual(f.observation().actions, [
    "absent-after-native-terminal",
    "sample-completed",
  ]);
});
test("local GCC stopped post-terminal valid case needs no pause or resume", async () => {
  const f = fixture();
  f.state.Running = false;
  f.finished = true;
  assert.deepEqual(await f.run(), sampleValue);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ["ps", "inspect", "actual-sample"],
  );
  assert.deepEqual(f.observation().actions, [
    "stopped-after-native-terminal",
    "sample-completed",
  ]);
});
test("local GCC stopped container without native terminal is incomplete", async () => {
  const f = fixture();
  f.state.Running = false;
  await assert.rejects(f.run(), /terminal was observed/u);
  assert.equal(f.sampleCalls(), 0);
  assert.equal(f.observation().complete, false);
});

function missingContainer() {
  return Object.assign(new Error("Authored owned-container absence"), {
    code: 1,
    killed: false,
    signal: null,
    stderr: "Error response from daemon: No such container: " + id + "\n",
  });
}
test("local GCC refuses a post-stop collector role before pausing or sampling", async () => {
  const f = fixture();
  Object.assign(f.row.Config.Labels, {
    "io.checktrail.producer-role": "post-stop-reports",
  });
  await assert.rejects(f.run(), /Unexpected native container role/u);
  assert.equal(f.sampleCalls(), 0);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ["ps", "inspect"],
  );
  assert.equal(f.observation().complete, false);
});
test("local GCC natural terminal and positive absence during pause permit a stopped-writer sample", async () => {
  const f = fixture();
  f.pauseError = missingContainer();
  f.pauseAcknowledged = false;
  f.onPause = () => {
    f.present = false;
    f.finished = true;
  };
  assert.deepEqual(await f.run(), sampleValue);
  assert.equal(f.sampleCalls(), 1);
  assert.equal(f.observation().complete, true);
  assert.deepEqual(f.observation().actions, [
    "pause-requested",
    "owned-container-absent-after-native-terminal-during-pause",
    "sample-completed",
  ]);
  assert.equal(f.calls.filter((a) => a[0] === "unpause").length, 0);
});
test("local GCC disappearance during pause without a native terminal preserves the actual error", async () => {
  const f = fixture();
  const error = missingContainer();
  f.pauseError = error;
  f.pauseAcknowledged = false;
  f.onPause = () => {
    f.present = false;
  };
  await assert.rejects(f.run(), (actual) => {
    assert.ok(actual instanceof AggregateError);
    assert.equal(actual.errors.length, 2);
    assert.equal(actual.errors[0], error);
    assert.match(String(actual.errors[1]), /vanished before its terminal/u);
    return true;
  });
  assert.equal(f.sampleCalls(), 0);
  assert.equal(f.observation().complete, false);
});
test("local GCC unrelated pause failure is not erased by a simultaneous native terminal", async () => {
  const f = fixture();
  const error = Object.assign(Error("Authored transport unavailable"), {
    code: 1,
    killed: false,
    signal: null,
    stderr: "Authored transport unavailable\n",
  });
  f.pauseError = error;
  f.onPause = () => {
    f.present = false;
    f.finished = true;
  };
  await assert.rejects(f.run(), (e) => e === error);
  assert.equal(f.sampleCalls(), 0);
  assert.equal(f.observation().complete, false);
});
test("local GCC natural terminal after resume accepts verified absence instead of demanding a live container", async () => {
  const f = fixture();
  f.onUnpause = () => {
    f.present = false;
    f.finished = true;
  };
  assert.deepEqual(await f.run(), sampleValue);
  assert.equal(f.sampleCalls(), 1);
  assert.equal(f.observation().complete, true);
  assert.equal(f.calls.filter((a) => a[0] === "unpause").length, 1);
  assert.ok(
    f
      .observation()
      .actions.includes("owned-container-absent-after-native-terminal"),
  );
});

test("C cancellation during a resource scan resumes the owned writer and preserves cancellation", async () => {
  const f = fixture();
  const error = new DOMException("Authored cancellation", "AbortError");
  f.sampleError = error;
  await assert.rejects(f.run(), (actual) => actual === error);
  assert.equal(f.state.Paused, false);
  assert.equal(f.observation().complete, false);
  assert.equal(f.calls.filter((call) => call[0] === "unpause").length, 1);
});
test("C record failure after scanning and resuming cannot become complete evidence", async () => {
  const f = fixture();
  f.recordError = Error("Authored record failure");
  await assert.rejects(f.run(), (actual) => actual === f.recordError);
  assert.equal(f.state.Paused, false);
  assert.equal(f.observation().complete, false);
});
test("C vanished writer during resume requires a positive native terminal", async () => {
  const f = fixture();
  f.onSample = async () => {
    f.present = false;
    return sampleValue;
  };
  await assert.rejects(f.run(), /vanished before its terminal/u);
  assert.equal(f.observation().complete, false);
});
test("C verified terminal and repeated absence during resume are a valid near miss", async () => {
  const f = fixture();
  f.onSample = async () => {
    f.present = false;
    f.finished = true;
    return sampleValue;
  };
  assert.deepEqual(await f.run(), sampleValue);
  assert.equal(f.observation().complete, true);
  assert.deepEqual(f.observation().actions, [
    "pause-requested",
    "paused-acknowledged",
    "sample-completed",
    "owned-container-absent-during-resume",
  ]);
});

function quiescentRaw(rows: QuiescentRow[]) {
  const chunk = (stream: string, value: unknown) =>
    JSON.stringify({
      stream,
      base64: Buffer.from(JSON.stringify(value) + "\n").toString("base64"),
    }) + "\n";
  return Buffer.from(
    chunk("stdout", {
      schemaVersion: 1,
      kind: "ready",
      roots: ["/observed/bundle", "/observed/controls", "/observed/work"],
    }) +
      rows
        .map(
          (row) =>
            chunk("stdin", {
              schemaVersion: 1,
              kind: "sample",
              sequence: row.sample.sequence,
            }) + chunk("stdout", row.sample),
        )
        .join(""),
  );
}
function syntheticQuiescentReceipt() {
  const makeRow = (
    sequence: number,
    phase: "initial" | "active" | "final",
  ): QuiescentRow => ({
    schemaVersion: 2,
    name: "checktrail-producer-" + attempt,
    image,
    id: phase === "active" ? id : null,
    nativeStarted: phase !== "initial",
    nativeTerminalObservedBeforeSample: phase === "final",
    nativeTerminalObservedAtCompletion: phase === "final",
    sample: { ...sampleValue, sequence, bytes: sequence * 17 },
    actions:
      phase === "initial"
        ? ["absent-before-admission", "sample-completed"]
        : phase === "final"
          ? ["absent-after-native-terminal", "sample-completed"]
          : [
              "pause-requested",
              "paused-acknowledged",
              "sample-completed",
              "unpause-requested",
              "unpaused-acknowledged",
            ],
    elapsedMilliseconds: sequence * 2,
    complete: true,
    errors: [],
  });
  const rows = [
    makeRow(1, "initial"),
    makeRow(2, "active"),
    makeRow(3, "active"),
    makeRow(4, "final"),
  ];
  const receipt = {
    schemaVersion: 3,
    attempt,
    retentionSamplingPolicy: { ...cProducerRetentionSamplingPolicy },
    quiescentResourceSamples: rows,
    retentionObserver: {
      samples: rows.length,
      lastSample: rows.at(-1)!.sample,
      independentImage: image,
      retainedLogBytes: 0,
    },
    finalRetention: rows.at(-1)!.sample,
  };
  const raw = quiescentRaw(rows);
  receipt.retentionObserver.retainedLogBytes = raw.length;
  return { receipt, raw };
}
const validTerminalNearMisses = [
  {
    label: "natural terminal during pause",
    before: true,
    actions: [
      "pause-requested",
      "owned-container-absent-after-native-terminal-during-pause",
      "sample-completed",
    ],
  },
  {
    label: "natural terminal before pause acknowledgement",
    before: true,
    actions: [
      "pause-requested",
      "owned-container-absent-after-native-terminal",
      "sample-completed",
    ],
  },
  {
    label: "positive absence during resume",
    before: false,
    actions: [
      "pause-requested",
      "paused-acknowledged",
      "sample-completed",
      "owned-container-absent-during-resume",
    ],
  },
  {
    label: "natural terminal after resume",
    before: false,
    actions: [
      "pause-requested",
      "paused-acknowledged",
      "sample-completed",
      "unpause-requested",
      "owned-container-absent-after-native-terminal",
    ],
  },
  {
    label: "stopped writer during resume",
    before: false,
    actions: [
      "pause-requested",
      "paused-acknowledged",
      "sample-completed",
      "stopped-after-native-terminal-during-resume",
    ],
  },
];
function nearMissReceipt(near: (typeof validTerminalNearMisses)[number]) {
  const { receipt, raw } = syntheticQuiescentReceipt();
  Object.assign(receipt.quiescentResourceSamples[2]!, {
    nativeTerminalObservedBeforeSample: near.before,
    nativeTerminalObservedAtCompletion: true,
    actions: near.actions,
  });
  return { receipt, raw };
}
for (const near of validTerminalNearMisses)
  test(
    "C schema3 accepts " + near.label + " only with positive terminal proof",
    () => {
      const { receipt, raw } = nearMissReceipt(near);
      assert.equal(validateCQuiescentResourceSamples(receipt, raw), 4);
      receipt.quiescentResourceSamples[2]!.nativeTerminalObservedAtCompletion = false;
      assert.throws(() => validateCQuiescentResourceSamples(receipt, raw));
    },
  );

test("C schema3 binds every complete raw sequence to its owned intervention including two active scans", () => {
  const { receipt, raw } = syntheticQuiescentReceipt();
  assert.equal(validateCQuiescentResourceSamples(receipt, raw), 4);
});
const corruptions: [
  string,
  (receipt: ReturnType<typeof syntheticQuiescentReceipt>["receipt"]) => void,
][] = [
  [
    "sampling policy",
    (receipt) => {
      receipt.retentionSamplingPolicy.id += "-unknown";
    },
  ],
  [
    "omitted row",
    (receipt) => {
      receipt.quiescentResourceSamples.splice(1, 1);
    },
  ],
  [
    "duplicate row",
    (receipt) => {
      receipt.quiescentResourceSamples[2] = structuredClone(
        receipt.quiescentResourceSamples[1]!,
      );
    },
  ],
  [
    "reordered rows",
    (receipt) => {
      const rows = receipt.quiescentResourceSamples;
      [rows[1], rows[2]] = [rows[2]!, rows[1]!];
    },
  ],
  [
    "wrong raw counters",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.sample.bytes++;
    },
  ],
  [
    "unacknowledged pause",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.actions.splice(1, 1);
    },
  ],
  [
    "missing resume",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.actions.pop();
    },
  ],
  [
    "unfinished intervention",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.complete = false;
    },
  ],
  [
    "hidden scan failure",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.errors.push("Authored scan failure");
    },
  ],
  [
    "wrong owner name",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.name += "-other";
    },
  ],
  [
    "wrong image",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.image += "0";
    },
  ],
  [
    "malformed container",
    (receipt) => {
      receipt.quiescentResourceSamples[1]!.id = "short";
    },
  ],
  [
    "rebound container between scans",
    (receipt) => {
      receipt.quiescentResourceSamples[2]!.id = "c".repeat(64);
    },
  ],
  [
    "unknown row field",
    (receipt) => {
      Object.assign(receipt.quiescentResourceSamples[1]!, { ignored: true });
    },
  ],
  [
    "missing counter",
    (receipt) => {
      Reflect.deleteProperty(
        receipt.quiescentResourceSamples[1]!.sample,
        "files",
      );
    },
  ],
  [
    "missing first absence",
    (receipt) => {
      receipt.quiescentResourceSamples[0]!.actions.shift();
    },
  ],
  [
    "unproved final terminal",
    (receipt) => {
      receipt.quiescentResourceSamples.at(
        -1,
      )!.nativeTerminalObservedBeforeSample = false;
    },
  ],
  [
    "paused final writer",
    (receipt) => {
      const last = receipt.quiescentResourceSamples.at(-1)!;
      last.id = id;
      last.actions = [...receipt.quiescentResourceSamples[1]!.actions];
    },
  ],
];
for (const [label, corrupt] of corruptions)
  test(
    "C schema3 refuses " + label + " without relabeling a complete raw sample",
    () => {
      const { receipt, raw } = syntheticQuiescentReceipt();
      corrupt(receipt);
      assert.throws(() => validateCQuiescentResourceSamples(receipt, raw));
    },
  );

test(
  "C real persistent stat/rename churn fails all3 retries but two owner-frozen scans retain exact complete counters",
  { skip: nofollowSkip },
  async () => {
    const fixtureFile = path.join(
      repository,
      "test/fixtures/c-retention-quiescent-rename.py",
    );
    const scan = (paused: boolean) => {
      const result = spawnSync(
        nofollowPython!,
        [
          "-I",
          "-S",
          "-B",
          fixtureFile,
          repository,
          paused ? "paused" : "running",
        ],
        { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as {
        result: { bytes: number; files: number; directories: number } | null;
        error: { type: string; errno: number } | null;
        actualRenames: number;
        actualDirectoryEnumerations: number;
        retryDiagnostics: unknown[];
        allRealFDsClosed: boolean;
      };
    };
    const red = scan(false);
    assert.equal(red.result, null);
    assert.equal(red.error?.type, "FileNotFoundError");
    assert.equal(red.error?.errno, 2);
    assert.equal(red.actualRenames, 3);
    assert.equal(red.actualDirectoryEnumerations, 3);
    assert.equal(red.retryDiagnostics.length, 2);
    assert.equal(red.allRealFDsClosed, true);
    const f = fixture();
    f.onSample = async () => {
      const observed = scan(f.state.Paused);
      assert.deepEqual(observed.result, {
        bytes: 46,
        files: 3,
        directories: 4,
        links: 0,
        linkTargetBytes: 0,
        sockets: 0,
        fifos: 0,
        devices: 0,
      });
      assert.equal(observed.error, null);
      assert.equal(observed.actualRenames, 0);
      assert.equal(observed.actualDirectoryEnumerations, 1);
      assert.deepEqual(observed.retryDiagnostics, []);
      assert.equal(observed.allRealFDsClosed, true);
      return {
        schemaVersion: 1,
        kind: "sample",
        sequence: f.sampleCalls(),
        bytes: observed.result!.bytes,
        files: observed.result!.files,
        directories: observed.result!.directories,
      };
    };
    for (const sequence of [1, 2]) {
      assert.deepEqual(await f.run(), {
        schemaVersion: 1,
        kind: "sample",
        sequence,
        bytes: 46,
        files: 3,
        directories: 4,
      });
      assert.equal(f.state.Paused, false);
    }
    assert.equal(f.calls.filter((call) => call[0] === "pause").length, 2);
    assert.equal(f.calls.filter((call) => call[0] === "unpause").length, 2);
  },
);

function workBoundaryCases() {
  const exact = syntheticQuiescentReceipt();
  const exceeded = syntheticQuiescentReceipt();
  exceeded.receipt.quiescentResourceSamples[1]!.sample.bytes = 69;
  exceeded.raw = quiescentRaw(exceeded.receipt.quiescentResourceSamples);
  exceeded.receipt.retentionObserver.retainedLogBytes = exceeded.raw.length;
  return [
    {
      label: "exact frozen work allowance",
      ...exact,
      maximum: 68,
      expected: true,
    },
    {
      label: "oversized middle sample with under-limit final",
      ...exceeded,
      maximum: 68,
      expected: false,
    },
  ];
}
test("C schema3 checks every actual raw counter against frozen work allowance including exact-bound near miss", () => {
  for (const candidate of workBoundaryCases()) {
    if (candidate.expected)
      assert.equal(
        validateCQuiescentResourceSamples(
          candidate.receipt,
          candidate.raw,
          candidate.maximum,
        ),
        4,
      );
    else
      assert.throws(
        () =>
          validateCQuiescentResourceSamples(
            candidate.receipt,
            candidate.raw,
            candidate.maximum,
          ),
        /exceeded frozen work allowance/u,
      );
  }
});

test(
  "C independent Python replay agrees with JS on exact schema3 sample and lifecycle corruptions",
  { skip: nofollowSkip },
  () => {
    const { receipt, raw } = syntheticQuiescentReceipt();
    const cases = [
      { label: "complete", receipt, expected: true },
      ...workBoundaryCases().map((candidate) => ({
        ...candidate,
        raw: candidate.raw.toString("base64"),
      })),
      ...corruptions.map(([label, corrupt]) => {
        const candidate = structuredClone(receipt);
        corrupt(candidate);
        return { label, receipt: candidate, expected: false };
      }),
    ];
    const program = String.raw`
import base64,importlib.util,json,pathlib,sys,tempfile
repo=pathlib.Path(sys.argv[1]);payload=json.load(sys.stdin)
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
replay=load('c_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
exporter=load('c_export',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
raw=base64.b64decode(payload['raw'],validate=True)
results=[]
for case in payload['cases']:
 raw=base64.b64decode(case.get('raw',payload['raw']),validate=True)
 receipt=case['receipt'];observer=receipt['retentionObserver']
 observer.update(workObjectPolicy=replay.C_BUILD_POLICY['workObjectPolicy'],log=replay.pin(raw))
 receipt.update(retentionTransportPolicy=replay.C_BUILD_POLICY,reportRetention=replay.REPORT_LOCATIONS['original-trap'])
 try:
  selected=replay.evidence_format(receipt)
  last=replay.retention(raw,observer,selected,receipt)
  replay.quiescent_samples(receipt,case.get('maximum'))
  assert last==receipt['finalRetention']
 except (ValueError,KeyError,TypeError) as error:
  if case.get('maximum') is not None and not case['expected']:
   assert str(error)=='Quiescent C sample exceeded frozen work allowance'
  accepted=False
 else:accepted=True
 results.append({'label':case['label'],'accepted':accepted})
 assert accepted is case['expected'],case['label']
with tempfile.TemporaryDirectory(prefix='ct-c-receipt-format-') as directory:
 file=pathlib.Path(directory)/'receipt.json'
 complete=payload['cases'][0]['receipt']
 for version in [1,2,3]:
  value=dict(complete,schemaVersion=version)
  if version<3:value.pop('retentionSamplingPolicy')
  if version==1:
   value.pop('retentionTransportPolicy');value.pop('reportRetention')
  file.write_text(json.dumps(value))
  assert exporter.evidence_format(pathlib.Path(directory).resolve())==(version,'schema'+str(version))
  assert replay.evidence_format(value)['schemaVersion']==version
  if version<3:
   value['retentionSamplingPolicy']=replay.C_SAMPLING_POLICY
   file.write_text(json.dumps(value))
   assert exporter.evidence_format(pathlib.Path(directory).resolve())[1]=='unverified'
   try:replay.evidence_format(value)
   except ValueError:pass
   else:raise AssertionError('Historical receipt relabeled with new policy')
 raw=base64.b64decode(payload['raw'],validate=True)
 base=pathlib.Path(directory).resolve()
 inputs=base/'inputs';common=base/'common';result=base/'result'
 for folder in [inputs,common,result/'work']:
  folder.mkdir(parents=True)
 (result/'receipt.json').write_text(json.dumps(complete))
 (result/'retention-observer.jsonl').write_bytes(raw)
 startup=base/'startup.json';startup.write_text('{}')
 archive=base/'schema3.zip'
 exporter.export(repo,inputs,common,result,startup,archive,profile_name='gcc-12')
 packet=replay.Packet(archive)
 try:
  assert packet.manifest['schemaVersion']==3 and packet.manifest['controllerReceiptFormat']=='schema3'
  assert packet.manifest['unavailable']
  physical=packet.json('result/receipt.json')
  selected=replay.evidence_format(physical)
  assert replay.retention(packet.read('result/retention-observer.jsonl',256*1024**2),physical['retentionObserver'],selected,physical)==physical['finalRetention']
 finally:packet.close()
 try:replay.replay(archive,repo,expected_profile='gcc-12')
 except ValueError as error:assert 'Incomplete raw C export' in str(error)
 else:raise AssertionError('Synthetic schema3 transport became native qualification')
print(json.dumps(results))
`;
    const result = spawnSync(
      nofollowPython!,
      ["-I", "-S", "-B", "-c", program, repository],
      {
        input: JSON.stringify({ raw: raw.toString("base64"), cases }),
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 65536,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      cases.map((candidate) => ({
        label: candidate.label,
        accepted: candidate.expected,
      })),
    );
  },
);

test("C startup absence waits for and verifies the owned writer before sampling", async () => {
  const f = fixture();
  f.present = false;
  f.onList = () => {
    if (f.listCount === 2) f.present = true;
  };
  assert.deepEqual(await f.run(), sampleValue);
  assert.equal(f.sampleCalls(), 1);
  assert.equal(f.calls.filter((call) => call[0] === "pause").length, 1);
  assert.equal(f.state.Paused, false);
});
test("C startup absence becomes a valid stopped-writer case only after observed terminal and repeated absence", async () => {
  const f = fixture();
  f.present = false;
  f.onList = () => {
    if (f.listCount === 2) f.finished = true;
  };
  assert.deepEqual(await f.run(), sampleValue);
  assert.equal(f.listCount, 3);
  assert.deepEqual(f.observation().actions, [
    "absent-after-native-terminal",
    "sample-completed",
  ]);
});
test("C natural terminal between pause response and acknowledgement requires verified absence", async () => {
  const f = fixture();
  f.onPause = () => {
    f.present = false;
    f.finished = true;
  };
  assert.deepEqual(await f.run(), sampleValue);
  assert.deepEqual(f.observation().actions, [
    "pause-requested",
    "owned-container-absent-after-native-terminal",
    "sample-completed",
  ]);
  assert.equal(f.calls.filter((call) => call[0] === "unpause").length, 0);
});
test("C writer stopped during resume is valid only with a positive native terminal", async () => {
  for (const terminal of [false, true]) {
    const f = fixture();
    f.onSample = async () => {
      f.state.Running = false;
      f.state.Paused = false;
      f.finished = terminal;
      return sampleValue;
    };
    if (terminal) {
      assert.deepEqual(await f.run(), sampleValue);
      assert.deepEqual(f.observation().actions, [
        "pause-requested",
        "paused-acknowledged",
        "sample-completed",
        "stopped-after-native-terminal-during-resume",
      ]);
    } else {
      await assert.rejects(f.run(), /stopped before its terminal/u);
      assert.equal(f.observation().complete, false);
    }
  }
});
test("C writer resumed outside its verified measurement owner is incomplete", async () => {
  const f = fixture();
  f.onSample = async () => {
    f.state.Paused = false;
    return sampleValue;
  };
  await assert.rejects(f.run(), /resumed outside the measurement owner/u);
  assert.equal(f.observation().complete, false);
});
