// Node-only network admission; every other native configuration check reuses Go.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  goContainerSpec,
  requireGoContainerConfiguration,
} from "./go-bootstrap-transport.mjs";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const succeeded = (row) =>
  row.exitCode === 0 &&
  row.signal === null &&
  row.error === null &&
  row.reason === null &&
  row.stopError === null;
export const nodeOriginalNetworkPolicy = Object.freeze({
  metadata: "none",
  "caller-preflight": "none",
  original: "bridge",
  "cache-preparation": "bridge",
});

export function nodeContainerSpec(args, imageConfig, imageId, kind) {
  assert.ok(
    Object.hasOwn(nodeOriginalNetworkPolicy, kind),
    "Unknown original Node transport kind",
  );
  assert.equal(args.filter((arg) => arg === "--network").length, 1);
  const index = args.indexOf("--network") + 1;
  const networkMode = nodeOriginalNetworkPolicy[kind];
  assert.equal(
    args[index],
    networkMode,
    "Original Node stage network policy differs",
  );
  // Go's unchanged parser handles the same closed argv vocabulary. Only this
  // separately checked token is projected to its fixed none-mode contract.
  const projected = args.slice();
  projected[index] = "none";
  return {
    ...goContainerSpec(projected, imageConfig, imageId),
    networkMode,
    nodeKind: kind,
  };
}

export function requireNodeContainerConfiguration(
  value,
  spec,
  protectedRoot = null,
) {
  assert.equal(spec.networkMode, nodeOriginalNetworkPolicy[spec.nodeKind]);
  assert.equal(
    value.HostConfig?.NetworkMode,
    spec.networkMode,
    "Actual Node stage network policy differs",
  );
  const emptyCommandProjectionApplied =
    Array.isArray(spec.cmd) &&
    spec.cmd.length === 0 &&
    value.Config?.Cmd === null;
  const projected = {
    ...value,
    Config: emptyCommandProjectionApplied
      ? { ...value.Config, Cmd: [] }
      : value.Config,
    HostConfig: { ...value.HostConfig, NetworkMode: "none" },
  };
  const result = requireGoContainerConfiguration(
    projected,
    spec,
    protectedRoot,
  );
  // Retain actual raw configuration identity; the none-mode projection is never
  // represented as an observation of the bridge-connected container.
  return {
    ...result,
    configurationSha256: sha256(JSON.stringify(value)),
    hostConfiguration: value.HostConfig,
    containerConfiguration: value.Config,
    emptyCommandProjectionApplied,
    networkMode: spec.networkMode,
    originalNpmNetworkFallbackAvailable: spec.networkMode === "bridge",
  };
}
function inspect(result) {
  assert.ok(succeeded(result.terminal), "Container inspect transport failed");
  const rows = JSON.parse(result.text);
  assert.ok(
    Array.isArray(rows) && rows.length === 1,
    "Malformed native container inspection",
  );
  return rows[0];
}

// Closed create/inspect/start/inspect/cleanup sequence from the reviewed Go
// transport; the two configuration decisions use the Node-only verifier above.
export async function runNodeContainerTransport({
  args,
  spec,
  protectedRoot,
  custody,
  invoke,
  cleanup,
  record,
  now,
  deadline,
}) {
  let failure, answer;
  const remaining = () => {
    const value = deadline - now();
    assert.ok(
      value > 0,
      "Original Node work budget expired before native start",
    );
    return value;
  };
  try {
    const created = await invoke("create", args, Math.min(15000, remaining()));
    assert.ok(
      succeeded(created.terminal),
      "Container creation transport failed",
    );
    const containerId = created.text.trim();
    assert.ok(id(containerId), "Malformed created container identity");
    const beforeRaw = await invoke(
      "inspect-before-start",
      ["inspect", containerId],
      Math.min(15000, remaining()),
    );
    const before = inspect(beforeRaw);
    assert.equal(before.Id, containerId);
    const configuration = requireNodeContainerConfiguration(
      before,
      spec,
      protectedRoot,
    );
    assert.equal(before.State.Status, "created");
    assert.equal(before.State.Running, false);
    assert.equal(before.State.Pid, 0);
    await custody();
    await record({
      phase: "before-start",
      rawConfigurationSha256: sha256(beforeRaw.text),
      ...configuration,
    });
    const started = await invoke(
      "start-attached",
      ["start", "--attach", containerId],
      remaining(),
    );
    const afterRaw = await invoke(
      "inspect-after-terminal",
      ["inspect", containerId],
      15000,
      true,
    );
    const after = inspect(afterRaw);
    assert.equal(after.Id, containerId);
    requireNodeContainerConfiguration(after, spec, protectedRoot);
    assert.equal(after.State.Status, "exited");
    assert.equal(after.State.Running, false);
    assert.ok(
      Number.isInteger(after.State.ExitCode) && after.State.ExitCode >= 0,
    );
    assert.ok(
      Date.parse(after.State.StartedAt) > 0 &&
        Date.parse(after.State.FinishedAt) >= Date.parse(after.State.StartedAt),
      "Native start and terminal observations unavailable",
    );
    assert.equal(after.State.OOMKilled, false);
    assert.equal(after.State.Error, "");
    await custody();
    await record({
      phase: "after-terminal",
      rawConfigurationSha256: sha256(afterRaw.text),
      state: after.State,
    });
    assert.equal(
      started.terminal.exitCode,
      after.State.ExitCode,
      "Docker attached client and actual native terminal differ",
    );
    for (const key of ["signal", "error", "reason", "stopError"])
      assert.equal(started.terminal[key], null);
    answer = {
      ...started,
      nativeState: after.State,
      prestartConfiguration: configuration,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "Node transport primary and cleanup failure",
            { cause: failure },
          )
        : error;
    }
  }
  if (failure) throw failure;
  return answer;
}
