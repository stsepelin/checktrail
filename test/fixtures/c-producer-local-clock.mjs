// Authored controller flow only. No Docker, compiler or upstream input executes.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
const { structuredClone } = globalThis;

const repository = path.resolve(process.argv[2]);
const root = path.resolve(process.argv[3]);
const scenario = process.argv[4];
assert.ok(
  [
    "observer-cutoff",
    "controller-cutoff",
    "root-replaced",
    "absence-unavailable",
    "preparation-refused",
  ].includes(scenario),
);
const target = pathToFileURL(
  path.join(repository, "scripts/qualify-c-producer.mjs"),
).href;
const key = "__checktrailAuthoredLocalControllerClock";
const events = [],
  receipts = [],
  timeouts = new Map();
let now = 1000000,
  sequence = 0,
  originalStarts = 0,
  collectorStarts = 0;
let collectorTimeout = null,
  sourceInstrumented = false;
const caller = { uid: process.getuid(), gid: process.getgid() };
const digest = (raw) => createHash("sha256").update(raw).digest("hex");
const identify = async (file, maximum) => {
  events.push("read:" + path.basename(file));
  const raw = await fs.readFile(file);
  assert.ok(raw.length <= maximum);
  return { bytes: raw.length, sha256: digest(raw) };
};
const result = path.join(root, "result");
const fireAt = (instant) => {
  now = instant;
  for (const [id, row] of [...timeouts]) {
    if (row.at <= now) {
      timeouts.delete(id);
      events.push("timer:" + row.delay);
      row.callback();
    }
  }
};
const record = (delay, callback) => {
  const id = ++sequence;
  timeouts.set(id, { at: now + delay, delay, callback });
  events.push("schedule:" + delay);
  return id;
};
const bridge = {
  process: {
    ...process,
    platform: "linux",
    arch: "x64",
    on: process.on.bind(process),
    off: process.off.bind(process),
  },
  performance: { now: () => now },
  os: { machine: () => "x86_64" },
  fs: {
    ...fs,
    statfs: async () => ({ bavail: 128n * 1024n ** 3n, bsize: 1n }),
  },
  timers: {
    setTimeout: (callback, delay) => record(delay, callback),
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: () => ++sequence,
    clearInterval: () => {},
  },
  execFile: Object.assign(
    () => {
      throw Error(
        "Only the explicit promisified transport double is available",
      );
    },
    {
      [promisify.custom]: async (_file, args) => ({
        stdout: JSON.stringify(
          args[0] === "info"
            ? {
                OSType: "linux",
                Architecture: "aarch64",
                NCPU: 4,
                MemTotal: 6442450944,
              }
            : [{}],
        ),
        stderr: "",
      }),
    },
  ),
  spawn(_file, argv) {
    const child = new EventEmitter();
    child.argv = argv;
    if (argv.includes("/controller/c-producer-build.sh")) {
      originalStarts++;
      events.push("spawn:original");
    } else if (argv.includes("/controller/c-producer-test-reports.py")) {
      collectorStarts++;
      events.push("spawn:collector");
    } else throw Error("Unexpected authored transport spawn");
    return child;
  },
  async custodyPreflight(plan, _caller, signal, state) {
    assert.equal(signal.aborted, false);
    await fs.mkdir(path.join(plan.destination, "custody-preflight"));
    await fs.writeFile(
      path.join(plan.destination, "custody-preflight/test-reports.json"),
      "authored custody metadata\n",
    );
    await fs.writeFile(
      path.join(plan.destination, "custody-preflight.log"),
      "authored custody transport\n",
    );
    state.custodyPreflight = {
      manifest: await identify(
        path.join(plan.destination, "custody-preflight/test-reports.json"),
        65536,
      ),
      log: await identify(
        path.join(plan.destination, "custody-preflight.log"),
        65536,
      ),
    };
  },
  helpers: {
    async atomicReceipt(destination, state) {
      receipts.push(structuredClone(state));
      await fs.writeFile(
        path.join(destination, "receipt.json"),
        JSON.stringify(state),
        { mode: 0o600 },
      );
    },
    caseSensitiveParent: async () => {},
    async cleanupContainer(_cid, _attempt, role = "producer") {
      const label = path.basename(_cid);
      events.push("stop:" + label);
      if (scenario === "absence-unavailable" && label === "container.id")
        return { state: "unavailable" };
      return { state: "removed", id: "a".repeat(64), role };
    },
    copyPinnedInput: async () => {},
    identifyFile: identify,
    physicalPath: async () => {},
    validateDestination: async () => ({ destination: result, parent: root }),
    async validateInputs() {
      if (scenario === "preparation-refused")
        throw Error("Authored input admission refusal");
    },
    async observeForeground(factory, log, options) {
      const child = factory();
      await fs.writeFile(log, "authored process transport\n", { mode: 0o600 });
      const retainedBytes = (await fs.stat(log)).size;
      if (path.basename(log) === "build.log") {
        assert.equal(child.argv.includes("82800"), true);
        assert.equal(options.timeoutMs, 82890000);
        if (scenario === "controller-cutoff") {
          fireAt(1000000 + 84000000);
          assert.equal(options.signal.aborted, true);
          assert.equal(options.signal.reason, "controller-deadline");
        } else fireAt(now + options.timeoutMs);
        await options.stop();
        if (scenario === "root-replaced") {
          await fs.rename(
            path.join(result, "work/native-build"),
            path.join(result, "work/original-held-root"),
          );
          await fs.mkdir(path.join(result, "work/native-build"), {
            mode: 0o700,
          });
        }
        const observedTerminal = {
          exitCode: null,
          signal: "SIGTERM",
          error: null,
          reason: scenario === "controller-cutoff" ? "abort" : "deadline",
          stopError: null,
          retainedBytes,
        };
        if (
          [
            "observer-cutoff",
            "controller-cutoff",
            "absence-unavailable",
          ].includes(scenario)
        ) {
          const error = new Error(
            "Authored transport interruption after owned stop",
          );
          error.observedTerminal = observedTerminal;
          throw error;
        }
        return observedTerminal;
      }
      assert.equal(path.basename(log), "post-stop-reports.log");
      collectorTimeout = options.timeoutMs;
      assert.equal(collectorTimeout, 180000);
      assert.equal(options.signal.aborted, false);
      assert.equal(
        child.argv.includes("/controller/c-producer-build.sh"),
        false,
      );
      return {
        exitCode: 0,
        signal: null,
        error: null,
        reason: null,
        stopError: null,
        retainedBytes,
      };
    },
  },
  retention: {
    cBuildRetentionPolicy: {
      sampleIntervalMs: 10000,
      maximumSamples: 9000,
      maximumLogBytes: 268435456,
    },
    reconcileRetentionLog: () => {},
    async startRetentionObserver({ destination }) {
      await fs.writeFile(
        path.join(destination, "retention-observer.jsonl"),
        "authored observer metadata\n",
      );
      return {
        sample: async () => ({ bytes: 0 }),
        close: async () => ({ state: "completed" }),
      };
    },
  },
  images: {
    registryImageIdentity: () => ({}),
    validateObservedImage: () => ({ authoredTransportOnly: true }),
  },
};
globalThis[key] = bridge;
const moduleFor = (name, names) =>
  `const b=globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];` +
  names.map((n) => `export const ${n}=b[${JSON.stringify(n)}];`).join("\n");
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let source;
    if (context.parentURL === target) {
      if (specifier === "node:process")
        source = `export default globalThis[${JSON.stringify(key)}].process;`;
      if (specifier === "node:os")
        source = `export default globalThis[${JSON.stringify(key)}].os;`;
      if (specifier === "node:fs/promises")
        source = moduleFor("fs", [
          "lstat",
          "mkdir",
          "open",
          "readdir",
          "statfs",
          "writeFile",
        ]);
      if (specifier === "node:timers")
        source = moduleFor("timers", [
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ]);
      if (specifier === "node:child_process")
        source = `const b=globalThis[${JSON.stringify(key)}];export const spawn=b.spawn;export const execFile=b.execFile;`;
      if (specifier === "./qualify-binutils-producer.mjs")
        source = moduleFor("helpers", Object.keys(bridge.helpers));
      if (specifier.endsWith("/binutils-retention-observer.mjs"))
        source = moduleFor("retention", Object.keys(bridge.retention));
      if (specifier.endsWith("/binutils-image-identity.mjs"))
        source = moduleFor("images", Object.keys(bridge.images));
    }
    if (
      (context.parentURL === target ||
        context.parentURL?.endsWith("/c-producer-profile.mjs")) &&
      specifier === "node:perf_hooks"
    )
      source = `export const performance=globalThis[${JSON.stringify(key)}].performance;`;
    if (source !== undefined)
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(source),
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    const source =
      typeof loaded.source === "string"
        ? loaded.source
        : Buffer.from(loaded.source).toString("utf8");
    const tree = ts.createSourceFile(
      "controller.mjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const nodes = tree.statements.filter(
      (n) =>
        ts.isFunctionDeclaration(n) &&
        n.name?.text === "verifyCustodyPreflight",
    );
    assert.equal(nodes.length, 1);
    const body = nodes[0].body;
    const changed =
      source.slice(0, body.pos) +
      `{return globalThis[${JSON.stringify(key)}].custodyPreflight(plan,caller,signal,state);}` +
      source.slice(body.end);
    const updated = ts.createSourceFile(
      "controller.mjs",
      changed,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const name of ["run", "mainCProducer", "collectCProducerEvidence"]) {
      const find = (value) =>
        value.statements
          .find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)
          .getText(value);
      assert.equal(
        find(tree),
        find(updated),
        "Edited controller and recovery functions remain byte-identical",
      );
    }
    sourceInstrumented = true;
    return { ...loaded, format: "module", source: changed, shortCircuit: true };
  },
});
const beforeSignals = [
  process.listenerCount("SIGINT"),
  process.listenerCount("SIGTERM"),
];
try {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await fs.chown(root, caller.uid, caller.gid);
  const { mainCProducer } = await import(target);
  const argv = [
    "--profile",
    "gcc-12",
    "--inputs",
    path.join(root, "inputs"),
    "--output",
    result,
    "--operator-trust-execution",
    "--coordinated-heavy-slot",
    "--allow-local-arm64-daemon",
    "--execution-policy",
    "local-gcc12-23h-v1",
  ];
  if (scenario === "preparation-refused") {
    await assert.rejects(
      mainCProducer(argv),
      /Authored input admission refusal/,
    );
    assert.equal(originalStarts, 0);
    assert.equal(receipts.length, 0);
    assert.deepEqual(
      events.filter((x) => x.startsWith("schedule:")),
      ["schedule:600000"],
    );
  } else {
    const returned = await mainCProducer(argv);
    const final = receipts.at(-1);
    assert.equal(returned.gateAComplete, false);
    assert.equal(final.gateAComplete, false);
    assert.notEqual(
      final.state,
      "original-command-completed-qualification-incomplete",
    );
    assert.equal(final.originalBuild.exitCode, null);
    assert.equal(originalStarts, 1);
    assert.equal(final.limits.deadlineSeconds, 43200);
    assert.equal(final.executionLimits.deadlineSeconds, 82800);
    assert.deepEqual(
      events.filter((x) => x.startsWith("schedule:")),
      ["schedule:600000", "schedule:84000000"],
    );
    if (scenario === "observer-cutoff") {
      assert.equal(collectorStarts, 1);
      assert.equal(collectorTimeout, 180000);
      assert.ok(
        events.indexOf("stop:container.id") < events.indexOf("spawn:collector"),
      );
      assert.equal(final.commandObservations.terminal.state, "unavailable");
      assert.equal(final.commandObservations.requested.state, "unavailable");
      for (const name of [
        "originalBuild",
        "originalTrapReports",
        "outputs",
        "installedPackageIdentities",
      ])
        assert.ok(final.collectionFailures.some((row) => row.field === name));
    } else {
      assert.equal(collectorStarts, 0);
      if (scenario === "controller-cutoff")
        assert.match(
          final.postStopRetention.primary,
          /recovery allowance exhausted/,
        );
      if (scenario === "root-replaced")
        assert.ok(
          final.collectionFailures.some(
            (row) => row.field === "retainedBuildRoot",
          ),
        );
      if (scenario === "absence-unavailable")
        assert.match(final.collectionRecoveryError, /absence must precede/);
    }
    assert.ok(final.nativeBuildRootClose.state === "closed");
  }
  const nativeArchiveReads = events.filter(
    (x) => x === "read:native-build-worktree.tar",
  ).length;
  assert.equal(
    nativeArchiveReads,
    ["absence-unavailable", "preparation-refused"].includes(scenario) ? 0 : 1,
    "Independent artifact collection must remain one-shot across try/catch/finally",
  );
  assert.equal(sourceInstrumented, true);
  assert.equal(
    timeouts.size,
    0,
    "No setup or whole-controller timer leaks after early/final failure",
  );
  assert.deepEqual(
    [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    beforeSignals,
  );
  console.log(
    JSON.stringify({
      scenario,
      controllerAndRecoveryBytesUnchanged: true,
      originalStarts,
      collectorStarts,
      compilerOrDockerOrOriginalInputExecuted: false,
      acquisitionAndCustodyPreflightAreAuthoredDoubles: true,
    }),
  );
} finally {
  hooks.deregister();
  delete globalThis[key];
}
