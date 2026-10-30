import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  cp,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, mock, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createNativeAttemptStorage,
  NativeAttemptWriter,
} from "../src/native-attempt-storage.js";
import {
  nativeJournalContextEnvironment,
  nativeJournalEnvironmentName,
  withoutNativeJournalContext,
} from "../src/native-journal-channel.js";
import {
  engineNativeJournalSchema,
  nativeJournalCaptureSchema,
} from "../src/native-journal-schema.js";
import {
  nativeJournalAllowsParserPass,
  nativeOuterCommandSha256,
  nativeWrapperEntry,
  type EngineNativeJournal,
} from "../src/native-journal-engine.js";
import { inheritEnvironment, operatorEnvironment } from "../src/environment.js";
import { createPlan, validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { reportSchema, reportSummarySchema } from "../src/schemas.js";
import { runProcess } from "../src/runner.js";
import type { Command, Report } from "../src/types.js";
import type { NativeJournalHeader } from "../src/native-attempt-frames.js";
import { fixture } from "./helpers.js";
import { wire } from "./tasks-wire-fixture.js";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
import { renameNativeStorageDirectory } from "./native-storage-fixture.js";
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const entry = (name: string) =>
  fs.realpathSync(
    fileURLToPath(new URL("../src/" + name + "-runner.js", import.meta.url)),
  );
const invokeUrl = new URL("../src/native-invoke.js", import.meta.url).href;
const header = (maximum = 4096): NativeJournalHeader => ({
  schemaVersion: 1,
  format: "native-attempt-journal",
  journalId: randomUUID(),
  sourceFingerprint: hash("original journal integration source"),
  outerCommandSha256: hash("original journal integration command"),
  maxNativeCalls: 3,
  maxOutputBytes: maximum,
});
function observation(storage: ReturnType<typeof createNativeAttemptStorage>) {
  const writer = new NativeAttemptWriter(storage.context);
  try {
    for (const code of [0, 1]) {
      const program =
        "process.stdout.write(Buffer.from([0,255,195,169]));process.exitCode=" +
        code;
      const child = spawnSync(process.execPath, ["-e", program], {
        timeout: 10000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      assert.equal(child.status, code);
      const id = writer.admit(hash(program));
      writer.started(id, child.pid);
      writer.output(id, "stdout", child.stdout);
      writer.terminal({
        type: "terminal",
        attemptId: id,
        state: "exited",
        exitCode: code,
        signal: null,
        errorCode: null,
      });
    }
  } finally {
    writer.close();
  }
}
function receipt(
  storage: ReturnType<typeof createNativeAttemptStorage>,
): EngineNativeJournal {
  return {
    expectedHeader: storage.header,
    producer: {
      name: "external",
      beforeSha256: hash("original producer"),
      afterSha256: hash("original producer"),
    },
    status: "collected",
    capture: storage.capture(),
  };
}
async function copiedRuntime(t: TestContext) {
  const root = await realpath(
    await fixture(t, { "package.json": '{"type":"module"}' }),
  );
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  await cp(source, path.join(root, "src"), {
    recursive: true,
    dereference: true,
  });
  assert.equal(await realpath(path.join(root, "src")), path.join(root, "src"));
  await symlink(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return root;
}

test("native capture preserves physical valid partial invalid and changed-header buffers while strict replay remains strict", async () => {
  const storage = createNativeAttemptStorage(header());
  const h = path.join(storage.context.directory, "header.json"),
    f = path.join(storage.context.directory, "frames.jsonl");
  try {
    assert.equal(storage.capture().state, "incomplete");
    observation(storage);
    const closed = receipt(storage),
      raw = await readFile(f);
    assert.equal(closed.capture!.state, "complete");
    assert.equal(nativeJournalAllowsParserPass(closed), true);
    assert.deepEqual(
      closed.capture!.replay!.attempts.map((a) => a.exitCode),
      [0, 1],
    );
    assert.equal(closed.capture!.replay!.claimsVerified, false);
    for (const a of closed.capture!.replay!.attempts)
      assert.deepEqual(
        Buffer.from(a.capturedOutput.stdout.base64, "base64"),
        Buffer.from([0, 255, 195, 169]),
      );
    engineNativeJournalSchema.parse(closed);
    for (const suffix of [
      Buffer.from('{"type":'),
      Buffer.from([255]),
      Buffer.from("\n"),
      Buffer.from('{"type":"unknown"}\n'),
    ]) {
      const bytes = Buffer.concat([raw, suffix]);
      await writeFile(f, bytes);
      const value = storage.capture();
      assert.equal(value.state, "invalid");
      assert.equal(value.framesData.sha256, hash(bytes));
      assert.deepEqual(Buffer.from(value.framesData.base64, "base64"), bytes);
      nativeJournalCaptureSchema.parse(value);
      assert.throws(() => storage.read());
      assert.equal(
        nativeJournalAllowsParserPass({ ...closed, capture: value }),
        false,
      );
      if (suffix.at(-1) !== 10) {
        assert.equal(value.errorCode, "NATIVE_JOURNAL_PARTIAL_FRAME");
        assert.equal(value.replayedPrefixBytes, raw.length);
        assert.equal(value.replay!.attempts.length, 2);
      }
    }
    await writeFile(f, raw);
    await writeFile(h, "{}\n");
    const changed = storage.capture();
    assert.equal(changed.errorCode, "NATIVE_JOURNAL_HEADER_CHANGED");
    assert.deepEqual(
      Buffer.from(changed.headerData.base64, "base64"),
      Buffer.from("{}\n"),
    );
    assert.equal(changed.framesData.sha256, hash(raw));
    nativeJournalCaptureSchema.parse(changed);
    assert.throws(() => storage.read(), /header changed/);
  } finally {
    storage.destroy();
  }
});

test("native capture revalidates every held file and directory boundary and preserves replacement safety", async () => {
  const cases = [
    "header-replaced",
    "frames-replaced",
    "header-link",
    "frames-link",
    "header-large",
    "frames-large",
    "directory-replaced",
    ...(process.platform === "win32"
      ? []
      : ["header-mode", "frames-mode", "directory-mode"]),
  ] as const;
  for (const kind of cases) {
    const storage = createNativeAttemptStorage(header()),
      root = storage.context.directory;
    const target = path.join(
        root,
        kind.startsWith("header") ? "header.json" : "frames.jsonl",
      ),
      moved = root + "-moved";
    let directoryMoved = false;
    const movedFiles: string[] = [];
    try {
      if (kind === "directory-replaced") {
        await renameNativeStorageDirectory(storage, moved);
        directoryMoved = true;
        await mkdir(root, { mode: 0o700 });
        if (process.platform === "win32")
          ensureWindowsTaskAccess(root, "directory", true);
        await writeFile(path.join(root, "foreign"), "preserve");
        // Moving both original files must not make a new directory impersonate the old one.
        for (const name of ["header.json", "frames.jsonl"]) {
          await rename(path.join(moved, name), path.join(root, name));
          movedFiles.push(name);
        }
      } else if (kind === "directory-mode") await chmod(root, 0o755);
      else if (kind.endsWith("-replaced")) {
        await rename(target, target + ".old");
        await writeFile(target, "", { mode: 0o600 });
      } else if (kind.endsWith("-link")) await link(target, target + ".linked");
      else if (kind.endsWith("-large"))
        await truncate(
          target,
          kind.startsWith("header") ? 4097 : 8 * 1024 * 1024 + 1,
        );
      else await chmod(target, 0o644);
      assert.throws(() => storage.capture(), /Native journal|requires/, kind);
      assert.throws(() => storage.read(), /Native journal|requires/, kind);
      if (kind === "directory-replaced") {
        assert.throws(() => storage.destroy(), /directory changed/);
        assert.equal(
          await readFile(path.join(root, "foreign"), "utf8"),
          "preserve",
        );
      }
    } finally {
      if (directoryMoved) {
        for (const name of movedFiles)
          await rename(path.join(root, name), path.join(moved, name));
        await rm(root, { recursive: true });
        await rename(moved, root);
      }
      if (kind === "directory-mode") await chmod(root, 0o700);
      storage.destroy();
    }
  }
});

test("native receipt schemas recompute physical replay and reject every false declaration and lifecycle error", () => {
  const storage = createNativeAttemptStorage(header());
  try {
    observation(storage);
    const value = receipt(storage);
    const changes: Array<(v: EngineNativeJournal) => void> = [
      (v) => {
        v.capture!.framesData.bytes++;
      },
      (v) => {
        v.capture!.framesData.base64 += "=";
      },
      (v) => {
        v.capture!.framesData.sha256 = "0".repeat(64);
      },
      (v) => {
        v.capture!.headerData.sha256 = "0".repeat(64);
      },
      (v) => {
        v.capture!.replayedPrefixBytes--;
      },
      (v) => {
        v.capture!.state = "incomplete";
      },
      (v) => {
        v.capture!.replay!.attempts[0]!.pid = 2;
      },
      (v) => {
        v.capture!.replay!.retainedBytes++;
      },
      (v) => {
        v.capture!.header.journalId = randomUUID();
      },
      (v) => {
        v.expectedHeader.sourceFingerprint = "0".repeat(64);
      },
      (v) => {
        v.status = "unavailable";
      },
      (v) => {
        delete v.capture;
      },
      (v) => {
        v.producer.afterSha256 = null;
      },
      (v) => {
        v.errorCode = "NATIVE_JOURNAL_PRODUCER_CHANGED";
      },
      (v) => {
        v.errorCode = "NATIVE_JOURNAL_STORAGE_UNAVAILABLE";
      },
    ];
    for (const change of changes) {
      const broken = structuredClone(value);
      change(broken);
      assert.equal(engineNativeJournalSchema.safeParse(broken).success, false);
    }
    for (const changed of [
      {
        ...value,
        producer: { ...value.producer, afterSha256: null },
        errorCode: "NATIVE_JOURNAL_PRODUCER_CHANGED" as const,
      },
      {
        ...value,
        cleanupErrorCode: "NATIVE_JOURNAL_CLEANUP_UNAVAILABLE" as const,
      },
      {
        expectedHeader: value.expectedHeader,
        producer: { ...value.producer, afterSha256: null },
        status: "unavailable" as const,
        errorCode: "NATIVE_JOURNAL_STORAGE_UNAVAILABLE" as const,
      },
    ]) {
      engineNativeJournalSchema.parse(changed);
      assert.equal(nativeJournalAllowsParserPass(changed), false);
    }
  } finally {
    storage.destroy();
  }
});

test("native producer catalog matches exact shipped entrypoints and exempts only the two metadata-only identity paths", () => {
  const names = [
    "actionlint",
    "checkstyle",
    "clang",
    "cpp-extensions",
    "cpp-tools",
    "detekt",
    "dotnet-build",
    "dotnet",
    "external",
    "go-build",
    "golangci",
    "helm-extensions",
    "helm",
    "java",
    "kotlin",
    "kubeconform",
    "kustomize",
    "pyright",
    "ruby-tools",
    "rust",
    "rustfmt",
    "scala",
    "spotbugs",
    "swift-extensions",
    "swift-tools",
    "swift-version",
    "terraform-extensions",
    "terraform",
    "scala2",
    "scala-extensions",
    "spotbugs-extensions",
    "gradle",
    "maven",
    "fsharp-format",
    "kotlin-extensions",
    "detekt-extensions",
    "rust-workspace",
  ];
  assert.equal(names.length, 37);
  assert.equal(new Set(names).size, 37);
  for (const name of names) {
    const command = {
      executable: process.execPath,
      args: [entry(name)],
      cwd: ".",
    };
    assert.equal(nativeWrapperEntry(command), entry(name));
    for (const changed of [
      { ...command, executable: process.execPath + "-other" },
      { ...command, args: [entry(name) + ".old"] },
      {
        ...command,
        args: [
          path.join(
            path.dirname(entry(name)),
            "nested",
            path.basename(entry(name)),
          ),
        ],
      },
    ])
      assert.equal(nativeWrapperEntry(changed), undefined);
  }
  for (const [name, args] of [
    ["external", ["--version", "{}"]],
    ["fsharp-format", ["original-root", "{}", "--version"]],
  ] as const) {
    const command = {
      executable: process.execPath,
      args: [entry(name), ...args],
      cwd: ".",
    };
    assert.equal(nativeWrapperEntry(command), undefined);
    assert.equal(
      nativeWrapperEntry({ ...command, args: [...command.args, "extra"] }),
      entry(name),
    );
    assert.equal(
      nativeWrapperEntry({
        ...command,
        args: command.args.map((a) =>
          a === "--version" ? "--version-extra" : a,
        ),
      }),
      entry(name),
    );
  }
  const command = {
    executable: process.execPath,
    args: [entry("external"), "a", "b"],
    cwd: ".",
    env: { Z: "last", A: "first" },
    temporaryDirectory: true,
  };
  assert.equal(
    nativeOuterCommandSha256(command),
    nativeOuterCommandSha256({
      temporaryDirectory: true,
      cwd: ".",
      args: command.args,
      env: { A: "first", Z: "last" },
      executable: process.execPath,
    }),
  );
  for (const changed of [
    { ...command, args: [entry("external"), "b", "a"] },
    { ...command, cwd: "nested" },
    { ...command, env: { ...command.env, A: "changed" } },
    { ...command, temporaryDirectory: false },
  ])
    assert.notEqual(
      nativeOuterCommandSha256(changed),
      nativeOuterCommandSha256(command),
    );
});

test("native protected process channel records two actual child PIDs and strips exact context aliases without stripping near misses", () => {
  const storage = createNativeAttemptStorage(header());
  try {
    const program = `import {invokeNative} from ${JSON.stringify(invokeUrl)};
const supplied={...process.env};const rows=[];
const code='process.stdout.write(JSON.stringify({pid:process.pid,keys:Object.keys(process.env).filter(k=>k.toUpperCase().startsWith("CHECKTRAIL_NATIVE_JOURNAL_CONTEXT")),near:process.env.CHECKTRAIL_NATIVE_JOURNAL_CONTEXT_NEAR}));';
rows.push(await invokeNative(process.execPath,['-e',code],{env:supplied,maxOutputBytes:2048,timeoutMs:10000}));
rows.push(await invokeNative(process.execPath,['-e','process.stdout.write(Buffer.from([0,255,195,169]));process.exitCode=1'],{maxOutputBytes:2048,timeoutMs:10000}));
console.log(JSON.stringify(rows.map(r=>({pid:r.pid,status:r.status,stdout:r.stdout.toString('base64')}))));`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program],
      {
        env: {
          ...process.env,
          ...nativeJournalContextEnvironment(storage.context),
          CHECKTRAIL_NATIVE_JOURNAL_CONTEXT_NEAR: "original near miss",
        },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
    assert.equal(child.error, undefined);
    const rows = JSON.parse(child.stdout) as Array<{
      pid: number;
      status: number;
      stdout: string;
    }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.status),
      [0, 1],
    );
    const witness = JSON.parse(
      Buffer.from(rows[0]!.stdout, "base64").toString(),
    ) as { pid: number; keys: string[]; near: string };
    assert.equal(witness.pid, rows[0]!.pid);
    assert.deepEqual(witness.keys, ["CHECKTRAIL_NATIVE_JOURNAL_CONTEXT_NEAR"]);
    assert.equal(witness.near, "original near miss");
    const captured = storage.capture();
    assert.equal(captured.state, "complete");
    assert.deepEqual(
      captured.replay!.attempts.map((a) => a.pid),
      rows.map((r) => r.pid),
    );
    assert.notEqual(rows[0]!.pid, rows[1]!.pid);
    assert.deepEqual(
      captured.replay!.attempts.map((a) => a.capturedOutput.stdout.base64),
      rows.map((r) => r.stdout),
    );
    const env = {
      [nativeJournalEnvironmentName]: "secret",
      [nativeJournalEnvironmentName.toLowerCase()]: "alias",
      CHECKTRAIL_NATIVE_JOURNAL_CONTEXT_NEAR: "keep",
      PREFIX_CHECKTRAIL_NATIVE_JOURNAL_CONTEXT: "keep-prefix",
    };
    assert.deepEqual(withoutNativeJournalContext(env), {
      CHECKTRAIL_NATIVE_JOURNAL_CONTEXT_NEAR: "keep",
      PREFIX_CHECKTRAIL_NATIVE_JOURNAL_CONTEXT: "keep-prefix",
    });
    assert.throws(() =>
      operatorEnvironment({ [nativeJournalEnvironmentName]: "cannot grant" }),
    );
    assert.throws(() =>
      inheritEnvironment([nativeJournalEnvironmentName], env),
    );
    assert.deepEqual(
      operatorEnvironment({ CHECKTRAIL_NATIVE_JOURNAL_CONTEXT_NEAR: "keep" }),
      { CHECKTRAIL_NATIVE_JOURNAL_CONTEXT_NEAR: "keep" },
    );
  } finally {
    storage.destroy();
  }
});

test("native context initialization failures stay failed across retries before any child executes", async (t) => {
  const root = await fixture(t, {});
  for (const kind of [
    "json",
    "oversize",
    "foreign",
    ...(process.platform === "win32" ? [] : ["duplicate"]),
  ]) {
    const storage = createNativeAttemptStorage(header()),
      marker = path.join(root, kind);
    try {
      const raw =
        kind === "json"
          ? "{"
          : kind === "oversize"
            ? "x".repeat(4097)
            : JSON.stringify({
                ...storage.context,
                ...(kind === "foreign" ? { headerSha256: "0".repeat(64) } : {}),
              });
      const program = `import {invokeNative} from ${JSON.stringify(invokeUrl)};const errors=[];for(let i=0;i<2;i++){try{await invokeNative(process.execPath,['-e',${JSON.stringify("require('fs').writeFileSync(" + JSON.stringify(marker) + ",'ran')")}],{maxOutputBytes:1024,timeoutMs:5000})}catch(e){errors.push(e.message)}process.env.${nativeJournalEnvironmentName}=${JSON.stringify(JSON.stringify(storage.context))}}console.log(JSON.stringify(errors));`;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", program],
        {
          env: {
            ...process.env,
            [nativeJournalEnvironmentName]: raw,
            ...(kind === "duplicate"
              ? { [nativeJournalEnvironmentName.toLowerCase()]: raw }
              : {}),
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), [
        "Native journal context unavailable",
        "Native journal context unavailable",
      ]);
      await assert.rejects(access(marker));
      assert.equal(storage.capture().state, "incomplete");
      assert.deepEqual(storage.capture().replay!.attempts, []);
    } finally {
      storage.destroy();
    }
  }
});

test("native outer launch uses the engine-owned context after stripping operator and command aliases", async (t) => {
  const root = await fixture(t, {}),
    storage = createNativeAttemptStorage(header());
  try {
    const code = `import {invokeNative} from ${JSON.stringify(invokeUrl)};const r=await invokeNative(process.execPath,['-e','console.log(process.pid)'],{maxOutputBytes:1024,timeoutMs:10000});process.stdout.write(r.stdout);`;
    const command: Command = {
      executable: process.execPath,
      args: ["--input-type=module", "-e", code],
      cwd: ".",
      env: {
        [nativeJournalEnvironmentName]: "invalid-command",
        [nativeJournalEnvironmentName.toLowerCase()]: "invalid-alias",
      },
    };
    const result = await runProcess(root, command, {
      timeoutMs: 15000,
      nativeJournalContext: storage.context,
      environment: { [nativeJournalEnvironmentName]: "invalid-operator" },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.cancelled, false);
    const captured = storage.capture();
    assert.equal(captured.state, "complete");
    assert.equal(captured.replay!.attempts.length, 1);
    assert.equal(
      captured.replay!.attempts[0]!.pid,
      Number(result.stdout.trim()),
    );
  } finally {
    storage.destroy();
  }
});

test("native cancelled outer wrappers retain reached raw prefixes without inventing completion after cleanup", async (t) => {
  const root = await fixture(t, {}),
    storage = createNativeAttemptStorage(header()),
    abort = new AbortController();
  let running: ReturnType<typeof runProcess> | undefined;
  try {
    const code = `import {invokeNative} from ${JSON.stringify(invokeUrl)};await invokeNative(process.execPath,['-e','console.log("original reached prefix "+process.pid);setInterval(()=>{},1000)'],{maxOutputBytes:2048,timeoutMs:10000});`;
    running = runProcess(
      root,
      {
        executable: process.execPath,
        args: ["--input-type=module", "-e", code],
        cwd: ".",
      },
      {
        timeoutMs: 12000,
        nativeJournalContext: storage.context,
        signal: abort.signal,
        captureRawOutput: true,
      },
    );
    const started = performance.now();
    let reached = false;
    while (performance.now() - started < 5000) {
      const raw = await readFile(
        path.join(storage.context.directory, "frames.jsonl"),
        "utf8",
      );
      if (raw.includes('"type":"output"')) {
        reached = true;
        break;
      }
      await delay(20);
    }
    assert.equal(
      reached,
      true,
      "The cancellation must happen after a physical output frame, not at N=0",
    );
    abort.abort();
    const result = await running;
    running = undefined;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    const value = receipt(storage);
    assert.equal(value.capture!.state, "incomplete");
    assert.equal(value.capture!.replay!.attempts.length, 1);
    assert.equal(nativeJournalAllowsParserPass(value), false);
    const attempt = value.capture!.replay!.attempts[0]!;
    assert.equal(attempt.exitCode, null);
    assert.equal(attempt.state, "interrupted");
    const bytes = Buffer.from(attempt.capturedOutput.stdout.base64, "base64");
    assert.equal(
      bytes.toString(),
      "original reached prefix " + attempt.pid + "\n",
    );
    assert.equal(attempt.capturedOutput.stdout.sha256, hash(bytes));
  } finally {
    abort.abort();
    await running;
    storage.destroy();
  }
});

async function originalAdapter(t: TestContext) {
  const root = await fixture(t, {
    "journal.project": "original",
    "first.txt": "clean\n",
    "second.txt": "clean\n",
  });
  const marker = path.join(await fixture(t, {}), "original-execution-marker");
  const program = `import {writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(marker)},String(process.pid));import {readFile} from 'node:fs/promises';const r=JSON.parse(await readFile(process.argv[2],'utf8'));const findings=[];for(const file of r.scope){if((await readFile(file,'utf8')).includes('broken')) findings.push({ruleId:'original-broken',level:'error',message:'Original broken fixture',file,line:1});}const result={protocolVersion:1,identity:r.identity,checkId:r.checkId,sourceFingerprint:r.sourceFingerprint,files:r.scope.map(path=>({path,status:'checked'})),findings,findingsComplete:true,tools:[{name:'original-pid',version:String(process.pid)}]};console.log(JSON.stringify(result));process.exitCode=findings.length ? 1 : 0;`;
  const manifest = {
    schemaVersion: 1,
    id: "external.journal",
    version: "1.0.0",
    description: "Original native journal control",
    runtime: "node",
    entry: "adapter.mjs",
    files: [{ path: "adapter.mjs", sha256: hash(program) }],
    markers: ["journal.project"],
    checks: [
      {
        id: "analysis",
        kind: "analysis",
        description: "Original two-file control",
        failOn: "error",
        scope: { extensions: [".txt"], names: [] },
      },
    ],
  };
  const text = JSON.stringify(manifest),
    bundle = await fixture(t, { "adapter.mjs": program, "adapter.json": text });
  const reference = {
    path: path.join(bundle, "adapter.json"),
    sha256: hash(text),
  };
  return {
    root,
    reference,
    marker,
    argument: reference.path + "#sha256=" + reference.sha256,
  };
}
function assertPhysicalReport(report: Report, expected: "passed" | "failed") {
  reportSchema.parse(report);
  assert.equal(report.outcome, expected);
  assert.equal(report.sourceChanged, false);
  assert.equal(report.checks.length, 1);
  const check = report.checks[0]!,
    process = check.processes[0]!,
    journal = process.nativeJournal!;
  assert.equal(check.status, expected);
  assert.equal(journal.status, "collected");
  assert.equal(journal.capture!.state, "complete");
  assert.equal(
    journal.expectedHeader.sourceFingerprint,
    report.sourceFingerprint,
  );
  assert.equal(
    journal.expectedHeader.outerCommandSha256,
    nativeOuterCommandSha256(process.command),
  );
  assert.equal(nativeJournalAllowsParserPass(journal), true);
  assert.equal(journal.capture!.replay!.attempts.length, 1);
  const call = journal.capture!.replay!.attempts[0]!;
  const envelope = JSON.parse(process.stdout) as {
    stdout: string;
    exitCode: number;
  };
  assert.equal(call.exitCode, expected === "passed" ? 0 : 1);
  assert.equal(call.exitCode, envelope.exitCode);
  const bytes = Buffer.from(call.capturedOutput.stdout.base64, "base64");
  assert.equal(bytes.toString(), envelope.stdout);
  assert.equal(call.capturedOutput.stdout.sha256, hash(bytes));
  const native = JSON.parse(bytes.toString()) as {
    tools: Array<{ name: string; version: string }>;
  };
  assert.equal(
    call.pid,
    Number(native.tools.find((x) => x.name === "original-pid")!.version),
  );
  assert.ok(call.pid! > 1);
  assert.equal(journal.producer.beforeSha256, journal.producer.afterSha256);
  assert.ok(
    check
      .tools!.filter((x) => x.process)
      .every((x) => x.process!.nativeJournal === undefined),
    "Metadata-only external identity must retain outer capture without inventing native calls",
  );
  const summary = projectReport(report, false);
  reportSummarySchema.parse(summary);
  for (const privateValue of [
    report.sourceFingerprint,
    process.command.args[0]!,
    journal.capture!.framesData.base64,
    "nativeJournal",
  ])
    assert.equal(JSON.stringify(summary).includes(privateValue), false);
}

test("engine journals preserve actual original adapter success and failure while discovery and untrusted runs execute nothing", async (t) => {
  const { root, reference, marker } = await originalAdapter(t);
  const planned = await createPlan(root, { externalAdapters: [reference] });
  assert.equal(planned.plan.checks.length, 1);
  assert.equal(planned.plan.checks[0]!.unavailableReason, undefined);
  await assert.rejects(
    validate(root, { trusted: false, externalAdapters: [reference] }),
    /operator trust/,
  );
  await assert.rejects(access(marker));
  const options = { trusted: true, externalAdapters: [reference] };
  const passed = await validate(root, options);
  assertPhysicalReport(passed, "passed");
  assert.equal(
    Number(await readFile(marker, "utf8")),
    passed.checks[0]!.processes[0]!.nativeJournal!.capture!.replay!.attempts[0]!
      .pid,
  );
  const changed = structuredClone(passed);
  changed.checks[0]!.processes[0]!.command.args.push("other");
  assert.equal(reportSchema.safeParse(changed).success, false);
  const changedSource = structuredClone(passed);
  changedSource.sourceFingerprint = "0".repeat(64);
  assert.equal(reportSchema.safeParse(changedSource).success, false);
  const toolBound = structuredClone(passed);
  toolBound.checks[0]!.tools = [
    {
      name: "original",
      source: "version-command",
      version: "1",
      status: "identified",
      process: structuredClone(passed.checks[0]!.processes[0]!),
    },
  ];
  reportSchema.parse(toolBound);
  toolBound.checks[0]!.tools[0]!.process!.command.cwd = "nested";
  assert.equal(reportSchema.safeParse(toolBound).success, false);
  await writeFile(path.join(root, "second.txt"), "broken\n");
  const failed = await validate(root, options);
  assertPhysicalReport(failed, "failed");
  assert.equal(failed.checks[0]!.findings!.length, 1);
  assert.equal(failed.checks[0]!.findings![0]!.file, "second.txt");
});

test("engine wrapper journals are shared by native CLI and stateless MCP with startup-only trust and detailed receipts", async (t) => {
  const { root, reference, argument } = await originalAdapter(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "run",
      "--root",
      root,
      "--adapter",
      argument,
      "--trust-project",
      "--detailed",
    ],
    { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(run.status, 0, run.stderr);
  assertPhysicalReport(JSON.parse(run.stdout) as Report, "passed");
  const connection = await wire(
    t,
    { root, directory: path.join(root, "unused") },
    ["--allow-execution", "--detailed", "--adapter", argument],
    false,
  );
  const response = await connection.request(
    "tools/call",
    { name: "validation_run", arguments: {} },
    false,
  );
  assert.equal(response.error, undefined);
  assert.equal(response.result?.isError, undefined);
  assertPhysicalReport(response.result!.structuredContent as Report, "passed");
  const rejected = await connection.request(
    "tools/call",
    {
      name: "validation_run",
      arguments: { trusted: true, nativeJournalContext: reference },
    },
    false,
  );
  assert.equal(rejected.result?.isError, true);
  await connection.close();
});

test("engine collector retains physical bytes on producer changes and simulated cleanup failure and rejects empty capture", async (t) => {
  const copied = await copiedRuntime(t),
    engine = (await import(
      pathToFileURL(path.join(copied, "src/native-journal-engine.js")).href
    )) as typeof import("../src/native-journal-engine.js");
  const command = {
    executable: process.execPath,
    args: [path.join(copied, "src/external-runner.js"), "original-root", "{}"],
    cwd: ".",
  };
  const original = await readFile(command.args[0]!);
  for (const kind of ["producer", "cleanup"]) {
    const owned = engine.prepareEngineNativeJournal(
      command,
      hash("original collector source"),
      4096,
    )!;
    const originalRemove = fs.rmSync;
    let restore: (() => void) | undefined;
    try {
      observation({ context: owned.context } as ReturnType<
        typeof createNativeAttemptStorage
      >);
      const raw = await readFile(
        path.join(owned.context.directory, "frames.jsonl"),
      );
      if (kind === "producer")
        await appendFile(
          command.args[0]!,
          "\n// original producer replacement\n",
        );
      else {
        const replaced = mock.method(
          fs,
          "rmSync",
          (...args: Parameters<typeof fs.rmSync>) => {
            if (String(args[0]) === owned.context.directory)
              throw Object.assign(Error("Original simulated cleanup refusal"), {
                code: "EACCES",
              });
            return originalRemove(...args);
          },
        );
        syncBuiltinESMExports();
        restore = () => {
          replaced.mock.restore();
          syncBuiltinESMExports();
        };
      }
      const value = owned.collect();
      assert.equal(engine.nativeJournalAllowsParserPass(value), false);
      assert.equal(value.status, "collected");
      assert.equal(value.capture!.framesData.sha256, hash(raw));
      assert.deepEqual(
        Buffer.from(value.capture!.framesData.base64, "base64"),
        raw,
      );
      engineNativeJournalSchema.parse(value);
      if (kind === "producer")
        assert.equal(value.errorCode, "NATIVE_JOURNAL_PRODUCER_CHANGED");
      else {
        assert.equal(value.errorCode, undefined);
        assert.equal(
          value.cleanupErrorCode,
          "NATIVE_JOURNAL_CLEANUP_UNAVAILABLE",
        );
      }
    } finally {
      restore?.();
      await writeFile(command.args[0]!, original);
      owned.cleanup();
    }
  }
  const empty = engine.prepareEngineNativeJournal(
    command,
    hash("original empty producer source"),
    4096,
  )!;
  const value = empty.collect();
  assert.equal(value.capture!.state, "incomplete");
  assert.deepEqual(value.capture!.replay!.attempts, []);
  assert.equal(engine.nativeJournalAllowsParserPass(value), false);
});

test("engine refuses a zero-call successful wrapper and rejects a passed report with an incomplete current journal", async (t) => {
  const copied = await copiedRuntime(t),
    engine = (await import(
      pathToFileURL(path.join(copied, "src/engine.js")).href
    )) as typeof import("../src/engine.js");
  const { root, reference } = await originalAdapter(t);
  const body = `const request=JSON.parse(process.argv[3]);const result={protocolVersion:1,identity:request.identity,checkId:request.checkId,sourceFingerprint:request.sourceFingerprint,files:request.scope.map(path=>({path,status:'checked'})),findings:[],findingsComplete:true,tools:[{name:'original-control',version:'1.0.0'}]};`;
  const producer = path.join(copied, "src/external-runner.js");
  await writeFile(
    producer,
    "if(process.argv[2] === '--version'){console.log('1.0.0')}else{" +
      body +
      "console.log(JSON.stringify({exitCode:0,stdout:JSON.stringify(result),stderr:''}))}",
  );
  const empty = await engine.validate(root, {
    trusted: true,
    externalAdapters: [reference],
  });
  assert.equal(empty.checks[0]!.processes[0]!.exitCode, 0);
  assert.equal(empty.outcome, "incomplete");
  assert.equal(empty.checks[0]!.status, "inconclusive");
  const journal = empty.checks[0]!.processes[0]!.nativeJournal!;
  assert.equal(journal.capture!.state, "incomplete");
  assert.deepEqual(journal.capture!.replay!.attempts, []);
  reportSchema.parse(empty);
  const falsePass = structuredClone(empty);
  falsePass.outcome = "passed";
  falsePass.checks[0]!.status = "passed";
  assert.equal(reportSchema.safeParse(falsePass).success, false);
  await writeFile(
    producer,
    "import {invokeNativeOutput} from './native-invoke-output.js';if(process.argv[2] === '--version'){console.log('1.0.0')}else{" +
      body +
      "const code='console.log('+JSON.stringify(JSON.stringify(result))+')';const child=await invokeNativeOutput(process.execPath,['-e',code],{encoding:'utf8',maxBuffer:4096});console.log(JSON.stringify({exitCode:child.status,stdout:child.stdout,stderr:child.stderr}))}",
  );
  const reached = await engine.validate(root, {
    trusted: true,
    externalAdapters: [reference],
  });
  assert.equal(reached.outcome, "passed");
  assert.equal(reached.checks[0]!.status, "passed");
  assert.equal(
    reached.checks[0]!.processes[0]!.nativeJournal!.capture!.replay!.attempts
      .length,
    1,
  );
  reportSchema.parse(reached);
});
