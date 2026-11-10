// Operator-only resource measurement. The upstream command and its clock stay intact.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import {
  cBuildRetentionPolicy,
  reconcileRetentionLog,
  validateRetentionMessage,
} from "./binutils-retention-observer.mjs";

export const cProducerRetentionSamplingPolicy = Object.freeze({
  id: "owned-container-quiescent-v1",
  counters: "complete-fixed-root-scan",
  nativeDeadlineIncludesObservation: true,
});

// Trusted reader authority for exact public historical controller bodies.
// Provenance and inert originals are in test/fixtures/c-controller-history/.
// Never obtain this index from an evidence archive or caller-provided metadata.
const historicalCControllerEpochs = Object.freeze({
  be1561e57b777e5c08aea20e39a734e80ce0fed47ddb09e6730f77db544c7bdf: {
    epoch: 2,
    bytes: 67909,
  },
  aea6f78bf62439189636a0765e31ee0ca881a7a7a7c4ce2c12104f59011f5884: {
    epoch: 2,
    bytes: 67101,
  },
  c7298cc50eb437d7bf6a34bd0fdd156edaaa3322f04a767801776023970fb65c: {
    epoch: 2,
    bytes: 63182,
  },
  c675c3244feaa2a3c28003290519307db273a77f70f24550be388eb0f0602492: {
    epoch: 1,
    bytes: 46160,
  },
  "183a5cf1c2412d496bbd43f69cfbe1558d23abb3dc15a006f5ad0da08de028ef": {
    epoch: 1,
    bytes: 44685,
  },
  "7f23265d6bc2f6e0521287cb5e63bb0f3e93c79cf72461b0593286e73937926e": {
    epoch: 1,
    bytes: 41703,
  },
  "3cc575883e38ab8da7de299686ec549717df7581de22c6e8ebc4d5aaf7cfed30": {
    epoch: 1,
    bytes: 41656,
  },
  "3fd12c507228d53d1987c4b27f5db1fc8746221148e7ae02c76eb5ef5919c083": {
    epoch: 1,
    bytes: 41812,
  },
  dba900988c4630c79737720d70ac165bc4ea2d65fc867bd8f578c77c074dbd1f: {
    epoch: 1,
    bytes: 41734,
  },
  "9ba614fb44695ca46d3d95d30db2df2f49dd5d1355222b6474f93c4874852003": {
    epoch: 1,
    bytes: 34452,
  },
  "68c82b4e467cc16e1281a4c07d43ae5a3e4b86e4d15fab2253e9d9637ae0714c": {
    epoch: 1,
    bytes: 34414,
  },
  a7ab7606d15dab9c2cfc2101dd88faa5287be21bbe727e79f33b7d17a0b2d408: {
    epoch: 1,
    bytes: 33922,
  },
});

// Call only after the startup pins have been bound to physical committed source.
export function validateCControllerSourceEpoch(receipt, verifiedSourcePins) {
  assert.ok(Array.isArray(verifiedSourcePins));
  const rows = verifiedSourcePins.filter(
    (row) => row?.file === "scripts/qualify-c-producer.mjs",
  );
  assert.equal(
    rows.length,
    1,
    "Exactly one canonical C controller source pin is required",
  );
  const row = rows[0];
  assert.deepEqual(Object.keys(row).sort(), ["bytes", "file", "sha256"]);
  assert.ok(
    Number.isSafeInteger(row.bytes) &&
      row.bytes > 0 &&
      row.bytes <= 2 * 1024 ** 2,
  );
  assert.equal(typeof row.sha256, "string");
  assert.equal(row.sha256.length, 64);
  assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  const historical = historicalCControllerEpochs[row.sha256];
  if (historical)
    assert.equal(
      row.bytes,
      historical.bytes,
      "Historical C controller byte length differs",
    );
  const expected = historical?.epoch ?? 3;
  assert.equal(
    receipt.schemaVersion,
    expected,
    "C controller source identity requires receipt schema" + expected,
  );
  return expected;
}

export async function sampleQuiescentCProducer({
  attempt,
  image,
  docker,
  sample,
  nativeStarted,
  nativeFinished,
  record,
}) {
  assert.match(attempt, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  assert.match(image, /^docker\.io\/coqorg\/coq@sha256:[a-f0-9]{64}$/u);
  assert.equal(typeof nativeStarted, "boolean");
  for (const fn of [docker, sample, nativeFinished, record])
    assert.equal(typeof fn, "function");
  const name = "checktrail-producer-" + attempt;
  const observation = {
    schemaVersion: 2,
    name,
    image,
    id: null,
    nativeStarted,
    nativeTerminalObservedBeforeSample: null,
    nativeTerminalObservedAtCompletion: null,
    actions: [],
    sample: null,
  };
  const began = performance.now(),
    failures = [];
  let id,
    value,
    pauseRequested = false,
    pauseAcknowledged = false;
  const finished = () => {
    const result = nativeFinished();
    assert.equal(typeof result, "boolean");
    return result;
  };
  const missing = (error) =>
    error?.code === 1 &&
    !error.killed &&
    error.signal == null &&
    [
      "Error: No such object: " + id + "\n",
      "Error: No such container: " + id + "\n",
      "Error response from daemon: No such object: " + id + "\n",
      "Error response from daemon: No such container: " + id + "\n",
      "error: no such object: " + id + "\n",
    ].includes(error.stderr);
  const list = async () => {
    const { stdout } = await docker([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      "name=^/" + name + "$",
      "--format",
      "{{.ID}}",
    ]);
    assert.equal(typeof stdout, "string");
    const found = stdout.trim();
    assert.ok(
      found === "" || /^[a-f0-9]{64}$/u.test(found),
      "Ambiguous producer identity",
    );
    return found || null;
  };
  const endedAndAbsent = async (error) =>
    missing(error) && finished() && (await list()) === null;
  const inspect = async () => {
    let result;
    try {
      result = await docker(["inspect", id]);
    } catch (error) {
      if (!(await endedAndAbsent(error))) throw error;
      observation.actions.push("owned-container-absent-after-native-terminal");
      return null;
    }
    const rows = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows) && rows.length === 1);
    const row = rows[0];
    assert.equal(row.Id, id);
    assert.equal(row.Name, "/" + name);
    assert.equal(row.Config.Labels["io.checktrail.producer-attempt"], attempt);
    assert.equal(
      row.Config.Labels["io.checktrail.producer-role"],
      undefined,
      "Unexpected native container role",
    );
    assert.equal(row.Config.Image, image);
    for (const key of ["Running", "Paused", "Restarting", "Dead"])
      assert.equal(typeof row.State[key], "boolean");
    assert.equal(row.State.Restarting, false);
    assert.equal(row.State.Dead, false);
    return row.State;
  };
  try {
    id = await list();
    observation.id = id;
    if (!nativeStarted) {
      assert.equal(id, null, "Producer already exists before native admission");
      observation.actions.push("absent-before-admission");
    } else {
      // Empty during Docker startup does not establish a stopped writer.
      while (id === null && !finished()) {
        assert.ok(
          performance.now() - began < 10000,
          "Producer startup observation deadline",
        );
        await setTimeout(100);
        id = await list();
        observation.id = id;
      }
      if (id === null) {
        assert.equal(finished(), true);
        assert.equal(await list(), null);
        observation.actions.push("absent-after-native-terminal");
      } else {
        const before = await inspect();
        if (before !== null) {
          assert.equal(
            before.Paused,
            false,
            "Producer was already paused by another owner",
          );
          if (before.Running) {
            pauseRequested = true;
            observation.actions.push("pause-requested");
            try {
              await docker(["pause", id]);
            } catch (error) {
              if (!(await endedAndAbsent(error))) throw error;
              pauseRequested = false;
              observation.actions.push(
                "owned-container-absent-after-native-terminal-during-pause",
              );
            }
            if (pauseRequested) {
              const paused = await inspect();
              if (paused === null) pauseRequested = false;
              else {
                assert.equal(paused.Running, true);
                assert.equal(
                  paused.Paused,
                  true,
                  "Producer freeze was not acknowledged",
                );
                pauseAcknowledged = true;
                observation.actions.push("paused-acknowledged");
              }
            }
          } else {
            assert.equal(
              finished(),
              true,
              "Producer stopped before its terminal was observed",
            );
            observation.actions.push("stopped-after-native-terminal");
          }
        }
      }
    }
    observation.nativeTerminalObservedBeforeSample = finished();
    value = await sample();
    assert.ok(Number.isSafeInteger(value?.sequence) && value.sequence > 0);
    validateRetentionMessage(value, value.sequence);
    observation.sample = value;
    observation.actions.push("sample-completed");
  } catch (error) {
    failures.push(error);
  } finally {
    if (pauseRequested) {
      try {
        const found = await list();
        assert.ok(
          found === null || found === id,
          "Producer name was rebound during measurement",
        );
        if (found === null) {
          assert.equal(
            finished(),
            true,
            "Producer vanished before its terminal was observed",
          );
          assert.equal(await list(), null);
          observation.actions.push("owned-container-absent-during-resume");
        } else {
          const current = await inspect();
          if (current !== null) {
            if (!current.Running) {
              assert.equal(current.Paused, false);
              assert.equal(
                finished(),
                true,
                "Producer stopped before its terminal was observed",
              );
              observation.actions.push(
                "stopped-after-native-terminal-during-resume",
              );
            } else {
              assert.ok(
                current.Paused || !pauseAcknowledged,
                "Producer resumed outside the measurement owner",
              );
              if (current.Paused) {
                observation.actions.push("unpause-requested");
                await docker(["unpause", id]);
              }
              const resumed = await inspect();
              if (resumed !== null) {
                assert.equal(
                  resumed.Paused,
                  false,
                  "Producer resume was not acknowledged",
                );
                observation.actions.push("unpaused-acknowledged");
              }
            }
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }
    observation.nativeTerminalObservedAtCompletion = finished();
    observation.elapsedMilliseconds = Math.ceil(performance.now() - began);
    observation.complete = failures.length === 0;
    observation.errors = failures.map((error) => String(error).slice(0, 2000));
    try {
      record(observation);
    } catch (error) {
      failures.push(error);
      observation.complete = false;
      observation.errors.push(String(error).slice(0, 2000));
    }
  }
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Resource measurement or cleanup failed",
    );
  if (failures.length === 1) throw failures[0];
  return value;
}

// The historical controller also bounded every successful sample. Re-read all
// raw counters for every receipt epoch; a smaller final tree cannot erase an
// earlier work-retention overrun.
function cRetentionSamples(raw, observer, cBuildWork) {
  reconcileRetentionLog(raw, observer, { cBuildWork });
  const text = raw.toString("utf8"),
    samples = [];
  let buffer = "",
    start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    assert.ok(end >= start);
    const row = JSON.parse(text.slice(start, end));
    start = end + 1;
    if (row.stream !== "stdout") continue;
    buffer += Buffer.from(row.base64, "base64").toString("utf8");
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 1);
      if (message.kind === "sample") samples.push(message);
    }
  }
  assert.equal(samples.length, observer.samples);
  return samples;
}
export function validateCWorkSampleBounds(
  raw,
  observer,
  cBuildWork,
  maximumBytes,
) {
  assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes >= 0);
  const samples = cRetentionSamples(raw, observer, cBuildWork);
  for (const sample of samples)
    assert.ok(
      sample.bytes <= maximumBytes,
      "C raw retention sample exceeded frozen work allowance",
    );
  return samples.length;
}

// Schema3 binds complete observer replies to recorded operator interventions.
// Historical controller schemas1/2 retain their original meaning.
export function validateCQuiescentResourceSamples(receipt, raw, maximumBytes) {
  assert.equal(receipt.schemaVersion, 3);
  assert.deepEqual(
    receipt.retentionSamplingPolicy,
    cProducerRetentionSamplingPolicy,
  );
  assert.match(
    receipt.attempt,
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
  );
  if (maximumBytes !== undefined)
    assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes >= 0);
  const rows = receipt.quiescentResourceSamples;
  assert.ok(
    Array.isArray(rows) &&
      rows.length >= 2 &&
      rows.length <= cBuildRetentionPolicy.maximumSamples,
    "Incomplete quiescent C sample inventory",
  );
  assert.equal(rows.length, receipt.retentionObserver.samples);
  const name = "checktrail-producer-" + receipt.attempt;
  let terminalSeen = false,
    containerId = null;
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(Object.keys(row).sort(), [
      "actions",
      "complete",
      "elapsedMilliseconds",
      "errors",
      "id",
      "image",
      "name",
      "nativeStarted",
      "nativeTerminalObservedAtCompletion",
      "nativeTerminalObservedBeforeSample",
      "sample",
      "schemaVersion",
    ]);
    assert.equal(row.schemaVersion, 2);
    assert.equal(row.name, name);
    assert.equal(row.image, receipt.retentionObserver.independentImage);
    assert.ok(
      row.id === null ||
        (typeof row.id === "string" && /^[a-f0-9]{64}$/u.test(row.id)),
    );
    if (row.id !== null) {
      if (containerId !== null)
        assert.equal(
          row.id,
          containerId,
          "Original C producer container identity changed between samples",
        );
      containerId = row.id;
    }
    assert.ok(
      Number.isSafeInteger(row.elapsedMilliseconds) &&
        row.elapsedMilliseconds >= 0,
    );
    assert.equal(row.complete, true, "Incomplete quiescent C intervention");
    assert.deepEqual(row.errors, []);
    assert.equal(typeof row.nativeStarted, "boolean");
    assert.equal(typeof row.nativeTerminalObservedBeforeSample, "boolean");
    assert.equal(typeof row.nativeTerminalObservedAtCompletion, "boolean");
    assert.ok(
      !terminalSeen || row.nativeTerminalObservedBeforeSample,
      "Native terminal observation regressed",
    );
    assert.ok(
      !row.nativeTerminalObservedBeforeSample ||
        row.nativeTerminalObservedAtCompletion,
    );
    terminalSeen = row.nativeTerminalObservedAtCompletion;
    validateRetentionMessage(row.sample, index + 1);
    if (maximumBytes !== undefined)
      assert.ok(
        row.sample.bytes <= maximumBytes,
        "Quiescent C sample exceeded frozen work allowance",
      );

    const actions = row.actions;
    assert.ok(
      Array.isArray(actions) &&
        actions.every((action) => typeof action === "string"),
    );
    const is = (expected) =>
      JSON.stringify(actions) === JSON.stringify(expected);
    if (index === 0) {
      assert.equal(row.nativeStarted, false);
      assert.equal(row.id, null);
      assert.equal(row.nativeTerminalObservedBeforeSample, false);
      assert.equal(row.nativeTerminalObservedAtCompletion, false);
      assert.ok(is(["absent-before-admission", "sample-completed"]));
      continue;
    }
    assert.equal(row.nativeStarted, true);
    if (row.id === null) {
      assert.ok(is(["absent-after-native-terminal", "sample-completed"]));
      assert.equal(row.nativeTerminalObservedBeforeSample, true);
    } else if (
      is(["stopped-after-native-terminal", "sample-completed"]) ||
      is([
        "owned-container-absent-after-native-terminal",
        "sample-completed",
      ]) ||
      is([
        "pause-requested",
        "owned-container-absent-after-native-terminal",
        "sample-completed",
      ]) ||
      is([
        "pause-requested",
        "owned-container-absent-after-native-terminal-during-pause",
        "sample-completed",
      ])
    )
      assert.equal(row.nativeTerminalObservedBeforeSample, true);
    else {
      assert.deepEqual(actions.slice(0, 3), [
        "pause-requested",
        "paused-acknowledged",
        "sample-completed",
      ]);
      const resume = actions.slice(3);
      assert.ok(
        [
          ["unpause-requested", "unpaused-acknowledged"],
          ["unpause-requested", "owned-container-absent-after-native-terminal"],
          ["owned-container-absent-after-native-terminal"],
          ["owned-container-absent-during-resume"],
          ["stopped-after-native-terminal-during-resume"],
        ].some(
          (expected) => JSON.stringify(resume) === JSON.stringify(expected),
        ),
        "Incomplete owned C pause/resume lifecycle",
      );
      if (
        resume.includes("owned-container-absent-after-native-terminal") ||
        resume.includes("owned-container-absent-during-resume") ||
        resume.includes("stopped-after-native-terminal-during-resume")
      )
        assert.equal(row.nativeTerminalObservedAtCompletion, true);
    }
    if (index === rows.length - 1) {
      assert.equal(
        row.nativeTerminalObservedBeforeSample,
        true,
        "Final C sample preceded native terminal",
      );
      assert.ok(
        !actions.includes("paused-acknowledged"),
        "Final C sample requires a positively stopped or absent writer",
      );
    }
  }
  assert.deepEqual(rows.at(-1).sample, receipt.retentionObserver.lastSample);
  assert.deepEqual(rows.at(-1).sample, receipt.finalRetention);
  if (raw !== undefined) {
    const samples = cRetentionSamples(raw, receipt.retentionObserver, true);
    for (const [index, sample] of samples.entries())
      assert.deepEqual(
        sample,
        rows[index].sample,
        "Quiescent C receipt differs from exact raw sample",
      );
  }
  return rows.length;
}
