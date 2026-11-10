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
    reconcileRetentionLog(raw, receipt.retentionObserver, { cBuildWork: true });
    let buffer = "",
      index = 0;
    for (const line of raw.toString("utf8").trimEnd().split("\n")) {
      const row = JSON.parse(line);
      if (row.stream !== "stdout") continue;
      buffer += Buffer.from(row.base64, "base64").toString("utf8");
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.kind === "sample")
          assert.deepEqual(
            message,
            rows[index++].sample,
            "Quiescent C receipt differs from exact raw sample",
          );
      }
    }
    assert.equal(index, rows.length);
  }
  return rows.length;
}
