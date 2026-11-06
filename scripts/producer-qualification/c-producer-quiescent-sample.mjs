// Operator-only resource measurement. The upstream command and its clock stay intact.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";

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
  const observation = { schemaVersion: 1, name, id: null, actions: [] };
  const began = performance.now(),
    failures = [];
  let id,
    value,
    pauseRequested = false;
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
              if (paused !== null) {
                assert.equal(paused.Running, true);
                assert.equal(
                  paused.Paused,
                  true,
                  "Producer freeze was not acknowledged",
                );
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
    value = await sample();
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
        if (found === null)
          observation.actions.push("owned-container-absent-during-resume");
        else {
          const current = await inspect();
          if (current !== null) {
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
      } catch (error) {
        failures.push(error);
      }
    }
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
