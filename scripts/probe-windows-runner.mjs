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
  await server.listen("\\\\.\\pipe\\" + controlPipe);
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
    ["$line = [IO.File]::ReadAllText", "ownership-established"],
    ["Add-Type -TypeDefinition $source", "source-decompressed"],
    ["$result = [ChecktrailWindowsJobV1]::Run", "source-compiled"],
    ["[Environment]::Exit($result)", "native-returned"],
  ])
    source = source.replace(needle, mark(label) + needle);
  await invoke(source, "instrumented-fixed-bootstrap");
  console.log(
    JSON.stringify({
      label: "fixed-bootstrap-stages",
      stages: await readFile(path.join(root, "startup-stages"), "utf8").catch(
        () => "missing",
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
