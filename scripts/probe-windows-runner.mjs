import { Buffer } from "node:buffer";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { runProcess } from "../dist/src/runner.js";
import { windowsSupervisorScript } from "../dist/src/windows-native.js";
import { windowsCommandLine } from "../dist/src/windows-process.js";
const root = await mkdtemp(
  path.join(tmpdir(), "checktrail-windows-diagnostic-"),
);
const supervisor = path.join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const controlPipe = "checktrail-" + randomUUID();
let socket;
const server = createServer((value) => {
  socket = value;
  value.on("error", () => {});
});
async function invoke(source, label) {
  const started = performance.now();
  const child = spawn(
    supervisor,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT,
        PATH: process.env.PATH ?? "",
        TEMP: root,
        TMP: root,
      },
      windowsHide: true,
      shell: false,
    },
  );
  const output = [],
    errors = [];
  let timedOut = false;
  child.stdout.on("data", (x) => output.push(x));
  child.stderr.on("data", (x) => errors.push(x));
  child.on("error", (x) => errors.push(Buffer.from(x.code ?? "startup-error")));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 20000);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  console.log(
    JSON.stringify({
      label,
      code,
      timedOut,
      durationMs: Math.round(performance.now() - started),
      stdout: Buffer.concat(output).toString("utf8").slice(0, 16384),
      stderr: Buffer.concat(errors).toString("utf8").slice(0, 16384),
    }),
  );
}
try {
  await invoke(
    "[Console]::WriteLine('original plain native PowerShell startup')",
    "plain-powershell-startup",
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen("\\\\.\\pipe\\" + controlPipe, resolve);
  });
  const requestId = controlPipe.slice("checktrail-".length);
  await writeFile(path.join(root, "owner-id"), requestId, { flag: "wx" });
  await writeFile(
    path.join(root, "request.json"),
    JSON.stringify({
      requestId,
      controlPipe,
      executable: process.execPath,
      commandLine: windowsCommandLine(process.execPath, [
        "-e",
        "process.stdout.write('original instrumented startup')",
      ]),
      cwd: root,
      environment: [
        "SYSTEMROOT=" + (process.env.SystemRoot ?? process.env.SYSTEMROOT),
      ],
      receipt: path.join(root, "receipt.json"),
    }),
    { flag: "wx" },
  );
  const mark = (label) =>
    `[IO.File]::AppendAllText('startup-stages', '${label}' + [Environment]::NewLine)\n`;
  let source = mark("entered") + windowsSupervisorScript;
  for (const [needle, label] of [
    ["$api = $type.CreateType()", "reflection-defined"],
    [
      "$limits = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)",
      "job-created",
    ],
    [
      "[Runtime.InteropServices.Marshal]::WriteInt32($limits,16,0x2000)",
      "limits-zeroed",
    ],
    ["if (-not $api::SetInformationJobObject", "limits-flags-written"],
    ["if (-not $api::AssignProcessToJobObject", "limits-installed"],
    ["$line = [IO.File]::ReadAllText", "ownership-established"],
    ["Add-Type -TypeDefinition $source", "source-decompressed"],
    ["$result = [ChecktrailWindowsJobV1]::Run", "source-compiled"],
    ["[Environment]::Exit($result)", "native-returned"],
  ])
    source = source.replace(needle, mark(label) + needle);
  // Split the two native calls at the last observed boundary. This changes only
  // the diagnostic copy; the product bootstrap and acceptance callbacks stay intact.
  source = source.replace(
    "if (-not $api::AssignProcessToJobObject($outerJob,$api::GetCurrentProcess())) { throw 'WINDOWS_BOOTSTRAP_OWNERSHIP_UNAVAILABLE' }",
    mark("current-process-call") +
      "$bootstrapProcess = $api::GetCurrentProcess()\n" +
      "[IO.File]::WriteAllText('startup-process-handle', [string]$bootstrapProcess)\n" +
      mark("current-process-returned") +
      "$bootstrapAssigned = $api::AssignProcessToJobObject($outerJob,$bootstrapProcess)\n" +
      "[IO.File]::WriteAllText('startup-assigned', [string]$bootstrapAssigned)\n" +
      mark("assignment-returned") +
      "if (-not $bootstrapAssigned) { throw 'WINDOWS_BOOTSTRAP_OWNERSHIP_UNAVAILABLE' }",
  );
  source = source.replace(
    "[Environment]::Exit($result)",
    "[IO.File]::WriteAllText('startup-result', [string]$result); [Environment]::Exit($result)",
  );
  source =
    "try {\n" +
    source +
    "\n} catch { [IO.File]::WriteAllText('startup-error', [string]$_.Exception); [Environment]::Exit(253) }";
  await invoke(source, "instrumented-fixed-bootstrap");
  console.log(
    JSON.stringify({
      label: "fixed-bootstrap-stages",
      stages: await readFile(path.join(root, "startup-stages"), "utf8").catch(
        () => "missing",
      ),
      controlConnected: !!socket,
      processHandle: await readFile(
        path.join(root, "startup-process-handle"),
        "utf8",
      ).catch(() => null),
      assigned: await readFile(
        path.join(root, "startup-assigned"),
        "utf8",
      ).catch(() => null),
      result: await readFile(path.join(root, "startup-result"), "utf8").catch(
        () => null,
      ),
      error: await readFile(path.join(root, "startup-error"), "utf8").catch(
        () => null,
      ),
      receipt: await readFile(path.join(root, "receipt.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null),
    }),
  );
  const result = await runProcess(
    root,
    {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('original native startup')"],
      cwd: ".",
    },
    { timeoutMs: 10000 },
  );
  console.log(
    JSON.stringify({
      scope:
        "Original synthetic Windows startup diagnostic; not an acceptance result",
      node: process.version,
      platform: process.platform,
      result,
    }),
  );
} finally {
  socket?.destroy();
  server.close();
  await rm(root, { recursive: true, force: true });
}
