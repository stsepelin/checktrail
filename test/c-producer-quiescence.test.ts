import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const { sampleQuiescentCProducer } = await import(
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
const sampleValue = { bytes: 17, files: 2, directories: 4 };
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
    onPause: undefined as (() => void) | undefined,
    onUnpause: undefined as (() => void) | undefined,
    listCount: 0,
    rebound: false,
    async docker(argv: string[]) {
      calls.push(argv);
      if (argv[0] === "ps") {
        f.listCount++;
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
        record: (r: { complete: boolean; actions: string[] }) =>
          observations.push(r),
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
          return sampleValue;
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
  await assert.rejects(f.run(), (e) => e === error);
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
