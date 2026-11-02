import { Buffer } from "node:buffer";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import {
  windowsNativeCode,
  windowsSupervisorScript,
} from "../dist/src/windows-native.js";
import { windowsCommandLine } from "../dist/src/windows-process.js";
import { runProcess } from "../dist/src/runner.js";

assert.equal(process.platform, "win32");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-startup-stages-")),
);
const supervisor = path.join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const summary = [];
const mark = (label) =>
  `[IO.File]::AppendAllText('stages.txt', '${label}\t' + [Diagnostics.Stopwatch]::GetTimestamp() + [Environment]::NewLine)\n`;
const instrument = (source, boundaries) => {
  for (const [needle, label] of boundaries) {
    assert.equal(source.split(needle).length, 2, label);
    source = source.replace(needle, mark(label) + needle);
  }
  return mark("entered") + source + "\n" + mark("returned");
};
async function capture(label, script, input, setup = async () => {}) {
  const work = await realpath(await mkdtemp(path.join(root, label + "-")));
  await setup(work);
  const zipped = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  const bootstrap = `$b=[Convert]::FromBase64String('${zipped}');$r=[IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new($b),[IO.Compression.CompressionMode]::Decompress),[Text.Encoding]::UTF8);try{$s=$r.ReadToEnd()}finally{$r.Dispose()};[ScriptBlock]::Create($s).Invoke()`;
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(bootstrap, "utf16le").toString("base64"),
  ];
  windowsCommandLine(supervisor, args);
  const started = performance.now();
  const child = spawn(supervisor, args, {
    cwd: work,
    shell: false,
    windowsHide: true,
    detached: false,
    env: {
      SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      TEMP: work,
      TMP: work,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = { stdout: [], stderr: [] };
  let bytes = 0,
    timedOut = false,
    outputOverrun = false,
    spawnError;
  for (const key of ["stdout", "stderr"])
    child[key].on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 65536) chunks[key].push(chunk);
      else {
        outputOverrun = true;
        child.kill("SIGKILL");
      }
    });
  child.on("error", (error) => {
    spawnError = error.code;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 60000);
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  const row = {
    label,
    exitCode,
    timedOut,
    outputOverrun,
    spawnError,
    durationMs: Math.round(performance.now() - started),
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
    stages: await readFile(path.join(work, "stages.txt"), "utf8").catch(
      () => null,
    ),
    error: await readFile(path.join(work, "error.txt"), "utf8").catch(
      () => null,
    ),
    receipt: await readFile(path.join(work, "receipt.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null),
  };
  summary.push(row);
  console.log(JSON.stringify(row));
}
function caught(script) {
  return `try {\n${script}\n} catch { [IO.File]::WriteAllText('error.txt', $_.Exception.ToString());[Environment]::Exit(253) }`;
}
try {
  const accessFile = ts.createSourceFile(
    "windows-task-access.js",
    await readFile(
      new URL("../dist/src/windows-task-access.js", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const accessScripts = [];
  const walk = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "accessScript" &&
      node.initializer &&
      ts.isTaggedTemplateExpression(node.initializer) &&
      ts.isNoSubstitutionTemplateLiteral(node.initializer.template)
    )
      accessScripts.push(node.initializer.template.text);
    ts.forEachChild(node, walk);
  };
  walk(accessFile);
  assert.equal(accessScripts.length, 1);
  await capture(
    "acl",
    caught(
      instrument(accessScripts[0], [
        ["[Console]::InputEncoding", "input-encoding"],
        ["[Console]::OutputEncoding", "output-encoding"],
        ["[void][System.Reflection.Assembly]::Load", "web-assembly-load"],
        ["$serializer = ", "serializer-create"],
        ["$request = ", "json-deserialize"],
        ["if ($request.kind -ne", "json-returned"],
        ["$identity = ", "identity"],
        ["if ($request.created)", "acl-create"],
        ["$item.SetAccessControl($acl)", "acl-write"],
        ["$acl = $item.GetAccessControl()", "acl-read"],
        ["$observed = ", "acl-read-returned"],
        ["[Console]::Out.WriteLine", "json-serialize-output"],
      ]),
    ),
    JSON.stringify({ path: root, kind: "directory", created: true }),
  );
  const requestId = randomUUID(),
    controlPipe = "checktrail-" + requestId;
  let socket;
  const server = createServer((value) => {
    socket = value;
    value.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen("\\\\.\\pipe\\" + controlPipe, resolve);
  });
  try {
    await capture(
      "guardian",
      caught(
        instrument(windowsSupervisorScript, [
          ["$api = $type.CreateType()", "reflection-type"],
          ["$outerJob = ", "create-job"],
          ["$limits = ", "allocate-limits"],
          ["if (-not $api::SetInformationJobObject", "install-limits"],
          ["if (-not $api::AssignProcessToJobObject", "assign-job"],
          ["[Console]::OutputEncoding", "output-encoding"],
          ["$ownedDirectory = ", "current-directory"],
          ["$line = ", "request-read"],
          ["if ($null -eq $line", "request-read-returned"],
          ["[void][Reflection.Assembly]::Load", "web-assembly-load"],
          ["$json = ", "serializer-create"],
          ["$request = ", "json-deserialize"],
          ["$sourceReader = ", "source-open"],
          ["$sourceHasher = ", "source-hasher"],
          ["if ($sourceDigest -ne", "source-hash-returned"],
          ["$source = ", "source-decode"],
          ["$compiler = ", "compiler-create"],
          ["$parameters = ", "compiler-parameters"],
          ["$compiled = ", "compile-source"],
          ["if ($compiled.Errors.HasErrors)", "compile-returned"],
          ["$nativeApi = ", "compiled-type"],
          ["$result = $nativeApi::Run", "native-run"],
          ["[Environment]::Exit($result)", "native-returned"],
        ]),
      ),
      "",
      async (work) => {
        await writeFile(path.join(work, "native.cs"), windowsNativeCode, {
          flag: "wx",
        });
        await writeFile(path.join(work, "owner-id"), requestId, { flag: "wx" });
        await writeFile(
          path.join(work, "request.json"),
          JSON.stringify({
            requestId,
            controlPipe,
            executable: process.execPath,
            commandLine: windowsCommandLine(process.execPath, [
              "-e",
              "process.stdout.write('original diagnostic')",
            ]),
            cwd: work,
            environment: [
              "SYSTEMROOT=" +
                (process.env.SystemRoot ?? process.env.SYSTEMROOT),
            ],
            receipt: path.join(work, "receipt.json"),
          }),
          { flag: "wx" },
        );
      },
    );
  } finally {
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  const result = await runProcess(
    root,
    {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('original product startup')"],
      cwd: ".",
    },
    { timeoutMs: 30000 },
  );
  const row = { label: "unchanged-product-30000ms", result };
  summary.push(row);
  console.log(JSON.stringify(row));
} finally {
  await writeFile(
    "windows-startup-stages.json",
    JSON.stringify(
      {
        scope:
          "Original synthetic startup diagnostic only; no acceptance claim",
        node: process.version,
        image: process.env.ImageVersion,
        summary,
      },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
}
