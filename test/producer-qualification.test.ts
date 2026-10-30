import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import filesystem, {
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture as sourceFixture } from "./helpers.js";
const fixture = async (
  t: Parameters<typeof sourceFixture>[0],
  files: Record<string, string>,
) => realpath(await sourceFixture(t, files));

const repository = fileURLToPath(new URL("../../", import.meta.url));
const controller = path.join(
  repository,
  "scripts/qualify-binutils-producer.mjs",
);
const api = await import(pathToFileURL(controller).href);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pin = (file: string, value: string) => ({
  file,
  bytes: Buffer.byteLength(value),
  sha256: digest(value),
});

test("producer preflight refuses changed later inputs and linked paths before publishing a destination", async (t) => {
  const root = await fixture(t, {
    first: "first original",
    second: "changed",
    "parent/.keep": "",
  });
  const output = path.join(root, "parent/result");
  await assert.rejects(
    api.validateInputs(root, [
      pin("first", "first original"),
      pin("second", "second original"),
    ]),
    /Pinned input mismatch: second/,
  );
  assert.deepEqual(await readdir(path.join(root, "parent")), [".keep"]);
  await writeFile(path.join(root, "second"), "second original");
  await api.validateInputs(root, [
    pin("first", "first original"),
    pin("second", "second original"),
  ]);
  const destination = await api.validateDestination(
    path.join(root, "parent"),
    path.join(root, "new"),
  );
  assert.equal(destination.destination, path.join(root, "new"));
  await assert.rejects(api.validateDestination(root, output), /overlap/);
  await assert.rejects(
    api.validateInputs(root, [pin("../first", "first original")]),
    /Invalid or duplicate/,
  );
  await assert.rejects(
    api.validateInputs(root, [
      pin("first", "first original"),
      pin("first", "first original"),
    ]),
    /Invalid or duplicate/,
  );
  if (process.platform !== "win32") {
    await symlink(path.join(root, "first"), path.join(root, "linked"));
    await assert.rejects(
      api.validateInputs(root, [pin("linked", "first original")]),
      /Linked path refused/,
    );
  }
});
test("producer destination preflight preserves an existing directory and never overwrites its receipt", async (t) => {
  const root = await fixture(t, {
    "inputs/value": "original",
    "result/receipt.json": "existing exact bytes",
  });
  await assert.rejects(
    api.validateDestination(
      path.join(root, "inputs"),
      path.join(root, "result"),
    ),
    /Output must be a new directory/,
  );
  assert.equal(
    await readFile(path.join(root, "result/receipt.json"), "utf8"),
    "existing exact bytes",
  );
  await assert.rejects(
    api.validateDestination(
      path.join(root, "inputs"),
      path.join(root, "missing/child"),
    ),
    /ENOENT/,
  );
});
async function reportFixture(t: Parameters<typeof fixture>[0], failed = false) {
  const raw = failed
    ? "PASS: first\nFAIL: second\nOriginal extra\n"
    : "PASS: first\nPASS: second\nOriginal extra\n";
  const root = await fixture(t, { "builddir-single/ld/ld.sum": raw });
  return {
    root,
    raw,
    value: {
      schemaVersion: 1,
      completeConfigurationInventoryAssessed: false,
      reports: [
        {
          file: "builddir-single/ld/ld.sum",
          configuration: "builddir-single",
          bytes: Buffer.byteLength(raw),
          sha256: digest(raw),
          counts: {
            PASS: failed ? 1 : 2,
            FAIL: failed ? 1 : 0,
            XFAIL: 0,
            XPASS: 0,
            UNSUPPORTED: 0,
            UNRESOLVED: 0,
            UNTESTED: 0,
            ERROR: 0,
          },
          otherLines: 1,
          totalLines: 3,
        },
      ],
    },
  };
}
test("producer test evidence rederives physical outcomes and keeps repeated configurations distinct", async (t) => {
  const good = await reportFixture(t);
  assert.equal(
    (await api.summarizeReports(good.value, good.root)).state,
    "reported",
  );
  const failure = await reportFixture(t, true);
  assert.equal(
    (await api.summarizeReports(failure.value, failure.root)).state,
    "failed",
  );
  const empty = await fixture(t, {});
  assert.equal(
    (
      await api.summarizeReports(
        {
          schemaVersion: 1,
          completeConfigurationInventoryAssessed: false,
          reports: [],
        },
        empty,
      )
    ).state,
    "unavailable",
  );
  const forged = structuredClone(good.value);
  forged.reports[0]!.counts.PASS = 0;
  forged.reports[0]!.counts.FAIL = 2;
  await assert.rejects(
    api.summarizeReports(forged, good.root),
    /differ from physical report bytes/,
  );
  const omitted = structuredClone(good.value);
  omitted.reports = [];
  await assert.rejects(
    api.summarizeReports(omitted, good.root),
    /physical report inventory/,
  );
  const duplicate = structuredClone(good.value);
  duplicate.reports.push(structuredClone(duplicate.reports[0]!));
  await assert.rejects(api.summarizeReports(duplicate, good.root));
  const second = structuredClone(good.value);
  const row = structuredClone(second.reports[0]!);
  row.file = "builddir-multi/ld/ld.sum";
  row.configuration = "builddir-multi";
  await mkdir(path.join(good.root, "builddir-multi/ld"), { recursive: true });
  await writeFile(path.join(good.root, row.file), good.raw);
  second.reports.push(row);
  const result = await api.summarizeReports(second, good.root);
  assert.equal(result.reports.length, 2);
  assert.equal(result.repeatedConfigurationsPooled, false);
  assert.equal(result.completeConfigurationInventoryAssessed, false);
  const changed = structuredClone(second);
  changed.reports[0]!.sha256 = "0".repeat(64);
  await assert.rejects(
    api.summarizeReports(changed, good.root),
    /byte identity mismatch/,
  );
});
test("producer foreground observation preserves nonzero native exit and exact bounded output", async (t) => {
  const root = await fixture(t, {});
  let child: ReturnType<typeof spawn> | undefined;
  const controller = new AbortController();
  t.after(() => child?.kill("SIGKILL"));
  const observed = await api.observeForeground(
    () =>
      (child = spawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write('original stdout');process.stderr.write('original stderr');process.exitCode=7",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      )),
    path.join(root, "log"),
    {
      timeoutMs: 5000,
      maxBytes: 1024,
      signal: controller.signal,
      stop: () => child?.kill("SIGKILL"),
    },
  );
  assert.equal(observed.exitCode, 7);
  assert.equal(observed.reason, null);
  const retained = await readFile(path.join(root, "log"), "utf8");
  assert.ok(
    retained.includes("original stdout") &&
      retained.includes("original stderr"),
  );
  assert.equal(observed.retainedBytes, Buffer.byteLength(retained));
});
test("producer foreground limits stop actual reached output and atomically retain interruption without a success claim", async (t) => {
  const root = await fixture(t, {});
  for (const mode of ["output", "cancel"] as const) {
    const log = path.join(root, mode + ".log");
    let child: ReturnType<typeof spawn> | undefined;
    const controller = new AbortController();
    let stopped = 0;
    const running = api.observeForeground(
      () =>
        (child = spawn(
          process.execPath,
          [
            "-e",
            mode === "output"
              ? "process.stdout.write('R'.repeat(4096));setInterval(()=>{},1000)"
              : "process.stdout.write('Original ready\\n');setInterval(()=>{},1000)",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        )),
      log,
      {
        timeoutMs: 5000,
        maxBytes: mode === "output" ? 128 : 1024,
        signal: controller.signal,
        stop: () => {
          stopped++;
          child?.kill("SIGKILL");
        },
      },
    );
    try {
      if (mode === "cancel") {
        const end = performance.now() + 2500;
        let reached = false;
        while (performance.now() < end) {
          try {
            reached = (await readFile(log, "utf8")).includes("Original ready");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (reached) break;
          await delay(10);
        }
        assert.equal(
          reached,
          true,
          "The actual child must reach its body before cancellation",
        );
        controller.abort();
      }
      const native = await running;
      assert.equal(
        native.reason,
        mode === "output" ? "output-limit" : "interrupted",
      );
      assert.equal(stopped, 1);
      assert.notEqual(native.exitCode, 0);
      assert.equal((await readFile(log)).length, native.retainedBytes);
      if (mode === "output") assert.equal(native.retainedBytes, 128);
      const destination = path.join(root, mode);
      await mkdir(destination);
      const receipt = {
        state: native.reason,
        originalBuild: native,
        gateAComplete: false,
        fullCompilerSdkBootstrapClosureVerified: false,
      };
      await api.atomicReceipt(destination, receipt);
      assert.deepEqual(
        JSON.parse(
          await readFile(path.join(destination, "receipt.json"), "utf8"),
        ),
        receipt,
      );
      assert.deepEqual(await readdir(destination), ["receipt.json"]);
    } finally {
      controller.abort();
      child?.kill("SIGKILL");
      await running;
    }
  }
});

test("producer log preflight never starts a child for an invalid target", async (t) => {
  const root = await fixture(t, { "existing.log": "original" });
  for (const file of [
    path.join(root, "existing.log"),
    path.join(root, "missing/new.log"),
  ]) {
    let starts = 0;
    await assert.rejects(
      api.observeForeground(
        () => {
          starts++;
          throw Error("Native body must not be invoked");
        },
        file,
        {
          timeoutMs: 1000,
          maxBytes: 100,
          signal: new AbortController().signal,
          stop: () => {
            throw Error("No child exists");
          },
        },
      ),
    );
    assert.equal(starts, 0);
  }
  assert.equal(
    await readFile(path.join(root, "existing.log"), "utf8"),
    "original",
  );
});
test("producer staged copy binds held no-follow source bytes and refuses changed or linked inputs", async (t) => {
  const root = await fixture(t, {
    source: "original source",
    bad: "changed source",
  });
  await api.copyPinnedInput(
    path.join(root, "source"),
    path.join(root, "copy"),
    pin("source", "original source"),
  );
  assert.equal(
    await readFile(path.join(root, "copy"), "utf8"),
    "original source",
  );
  await assert.rejects(
    api.copyPinnedInput(
      path.join(root, "bad"),
      path.join(root, "refused"),
      pin("source", "original source"),
    ),
  );
  assert.equal((await readdir(root)).includes("refused"), false);
  if (process.platform !== "win32") {
    await symlink(path.join(root, "source"), path.join(root, "linked"));
    await assert.rejects(
      api.copyPinnedInput(
        path.join(root, "linked"),
        path.join(root, "linked-copy"),
        pin("source", "original source"),
      ),
      /Linked path refused/,
    );
    assert.equal((await readdir(root)).includes("linked-copy"), false);
  }
});

test("producer held-input open rejects a path swapped to a symlink after physical preflight", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX no-follow open boundary");
    return;
  }
  const root = await fixture(t, {
    source: "original source",
    "private-adjacent": "original source",
  });
  const source = path.join(root, "source");
  const originalOpen = filesystem.open;
  let swapped = false;
  t.mock.method(
    filesystem,
    "open",
    async (
      file: Parameters<typeof filesystem.open>[0],
      flags: Parameters<typeof filesystem.open>[1],
      mode?: Parameters<typeof filesystem.open>[2],
    ) => {
      if (file === source && !swapped) {
        swapped = true;
        await unlink(source);
        await symlink(path.join(root, "private-adjacent"), source);
      }
      return originalOpen(file, flags, mode);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      api.copyPinnedInput(
        source,
        path.join(root, "copy"),
        pin("source", "original source"),
      ),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP",
    );
    assert.equal(swapped, true);
    assert.equal((await readdir(root)).includes("copy"), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
test("producer minimum source obligations refuse omitted configurations and named package reports", async (t) => {
  const good = await reportFixture(t);
  const minimum = {
    buildConfigurations: ["builddir-single"],
    minimumExplicitPackageCheckReports: ["builddir-single/ld/ld.sum"],
    completeUpstreamTestInventoryAssessed: false,
  };
  const result = await api.summarizeReports(good.value, good.root, minimum);
  assert.equal(result.minimumSourceObligationsSatisfied, true);
  assert.equal(result.completeConfigurationInventoryAssessed, false);
  await assert.rejects(
    api.summarizeReports(good.value, good.root, {
      ...minimum,
      buildConfigurations: ["builddir-single", "builddir-multi"],
    }),
    /default build configurations/,
  );
  await assert.rejects(
    api.summarizeReports(good.value, good.root, {
      ...minimum,
      minimumExplicitPackageCheckReports: [
        "builddir-single/binutils/binutils.sum",
      ],
    }),
    /Required original package test report missing/,
  );
});

test("producer pre-cancelled admission never starts a child or publishes a log", async (t) => {
  const root = await fixture(t, {});
  const controller = new AbortController();
  controller.abort("caller-signal");
  let starts = 0;
  await assert.rejects(
    api.observeForeground(
      () => {
        starts++;
        throw Error("Unreached body");
      },
      path.join(root, "refused.log"),
      {
        timeoutMs: 1000,
        maxBytes: 100,
        signal: controller.signal,
        stop: () => {},
      },
    ),
    /Interrupted before child admission/,
  );
  assert.equal(starts, 0);
  assert.deepEqual(await readdir(root), []);
});

test("producer report collection preserves configurations with no declared package test reports", async (t) => {
  const root = await fixture(t, {
    "source/builddir-single/ld/ld.sum": "PASS: first\nPASS: second\n",
    "source/builddir-multi/.keep":
      "Original configuration without a package test rule\n",
    "output/.keep": "",
  });
  const result = spawnSync(
    "python3",
    [
      path.join(
        repository,
        "scripts/producer-qualification/binutils-test-reports.py",
      ),
      path.join(root, "source"),
      path.join(root, "output/test-reports.json"),
    ],
    { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const retained = path.join(root, "output/original-test-reports");
  assert.deepEqual((await readdir(retained)).sort(), [
    "builddir-multi",
    "builddir-single",
  ]);
  assert.deepEqual(await readdir(path.join(retained, "builddir-multi")), []);
  const report = JSON.parse(
    await readFile(path.join(root, "output/test-reports.json"), "utf8"),
  );
  const observed = await api.summarizeReports(report, retained, {
    completeUpstreamTestInventoryAssessed: false,
    buildConfigurations: ["builddir-single", "builddir-multi"],
    minimumExplicitPackageCheckReports: ["builddir-single/ld/ld.sum"],
  });
  assert.equal(observed.state, "reported");
  assert.equal(observed.minimumSourceObligationsSatisfied, true);
  assert.equal(observed.completeConfigurationInventoryAssessed, false);
  assert.equal(observed.reports.length, 1);
  assert.equal(report.gateAComplete, false);
});
