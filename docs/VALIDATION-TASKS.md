# Durable local validation worker

`openValidationTasks` connects the shared validation engine to the bounded local
[task store](TASK-STORAGE.md). This is a library API, not a daemon or an MCP
extension. The CLI and MCP server still use their existing execution paths.
Standard MCP Tasks remains unadvertised until its wire contracts and SDK routing
work; see [MCP compatibility](MCP-COMPATIBILITY.md).

## Use

```js
import { setTimeout as delay } from "node:timers/promises";
import { openValidationTasks } from "@stsepelin/checktrail";

const tasks = await openValidationTasks({
  root: projectRoot,
  directory: privateStoreDirectory,
  allowExecution: true,
  detailed: false,
  timeoutMs: 30000,
});
try {
  let task = await tasks.start();
  while (task.status === "working") {
    await delay(250);
    task = await tasks.get(task.taskId);
  }
  console.log(task);
} finally {
  await tasks.close();
}
```

The store directory must satisfy the canonical-parent, private-permission and
local-filesystem requirements in `TASK-STORAGE.md`. Keep it outside inventoried
source, or inside an excluded directory. Native lifecycle tests cover macOS with
Node 26.8.1 and Linux with Node 22.23.2. Node 22's built-in SQLite is experimental.
The worker calls the same engine and adapter registry; the new worker-specific
native fixtures exercise Node validation, rather than claiming another full
native-toolchain compatibility matrix.

Execution permission, output mode, timeout, Git base, policy overlay, explicit
environment values and external adapter registrations are startup settings.
`start()` takes no arguments that can change them. Opening with
`allowExecution: false` permits reading retained results but rejects execution.
Starting a worker does not evaluate project source. The helper uses the current
Node executable, empty Node startup arguments and a narrow inherited environment;
parent `NODE_OPTIONS` preloads are not forwarded. Project execution still has the
user's privileges and is not sandboxed.

## Operations and results

- `start()` performs execution-free planning, durably creates a task, then starts
  validation. It returns the working task with an opaque ID. One validation or
  pending start is allowed at a time; overlap is rejected, not silently queued.
- `get(id)` returns a detached snapshot while validation continues. Completed
  reports retain their native `passed`, `failed` or `incomplete` outcome. A task
  with status `completed` does not by itself indicate that checks passed.
- `cancel(id)` reserves cancellation, aborts the shared engine, waits for process
  cleanup and then returns the terminal task. Completed tasks stay unchanged.
- `close()` rejects new work, stops active validation, waits for cleanup and
  releases the store. It is idempotent. Always await it during normal shutdown.

The client wrapper bounds pending requests at 32. The store bounds retained tasks,
result bytes and disk pages separately. Task TTL is the store default of 24 hours;
this worker API does not accept per-call TTL overrides. Validation uses the
engine's timeout contract, defaulting to 30 seconds and accepting at most 120.
Timeouts retain native incomplete evidence when it fits the configured result
projection. Invalid, missing and expired IDs fail without exposing filesystem
paths or raw exceptions.

If validation throws, source identity no longer matches the task, or the selected
result projection exceeds the store limit, the task retains an explicit
`isError: true` interruption result with no structured validation report. A large
detailed report can exceed the limit even when its summary fits. A persistence
failure that also prevents recording interruption shuts down the worker; it is
not converted into a passing result. Historical results are not revalidated or
used as a cache on retrieval.

## Ownership and parent loss

A child Node process owns both the SQLite handle and the active engine call. The
parent communicates through a local IPC channel; raw tool output is not forwarded
to the parent's stdout or stderr. The worker keeps the store's exclusive lock
until cleanup finishes, preventing a new owner from taking over live work.

When the parent disconnects or is killed, the worker detects the lost IPC channel,
reserves cancellation, aborts validation and closes the store after cleanup. Native
tests confirm that the running test and its ordinary descendant stop before the
worker's normal shutdown completes. SIGTERM and SIGINT to the worker use the same
cleanup path. The caller waits for process exit; it does not depend exclusively
on Node emitting `close` after simultaneous IPC disconnects.

This behavior covers loss of the parent while its worker survives to clean up.
It is not proof of cleanup if the worker itself is forcibly killed, native code
escapes its process group, or the operating system fails. After an abrupt store
owner death, the existing store recovery records unfinished work as an
interruption error and never resumes it. Broader orphan-process supervision is a
separate capability; no stronger guarantee is advertised here.

## Reproduce

```sh
npm run build
node --test --test-timeout=15000 dist/test/validation-tasks.test.js
node scripts/verify-task-store-container.mjs
```

The native regressions exercise passing/failing/empty validation, retained results,
read-only reopening, trust and preload boundaries, responsive polling, overlap,
explicit cancellation, shutdown, parent SIGKILL, native descendants, timeout,
oversized output and close during planning. The container helper additionally
checks this API from a fresh offline production-only installation, with networking
disabled and the installed package mounted read-only. The corresponding hosted
Linux Node 22 step passed at `52ba415`; see `NATIVE-CI.md`.

Removing the worker's parent-disconnect handler made the named SIGKILL regression
fail because native descendants remained alive. Restoring the handler restored
the native suite. This experiment checks cleanup behavior, not just stored status.
