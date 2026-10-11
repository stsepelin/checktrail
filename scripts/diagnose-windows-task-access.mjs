import assert from "node:assert/strict";
import {
  buildWindowsTaskAccessDiagnostic,
  summarizeWindowsTaskAccessDiagnostic,
} from "./windows-task-access-diagnostics.mjs";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import ts from "typescript";
import { validateWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import { windowsEnvironment } from "../dist/src/windows-process.js";
assert.equal(process.argv.length, 2);
assert.equal(
  process.platform,
  "win32",
  "This is a native Windows setup diagnostic, not acceptance",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = await readFile(
  new URL("../dist/src/windows-task-access.js", import.meta.url),
);
const source = ts.createSourceFile(
  "windows-task-access.js",
  sourceBytes.toString("utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const declarations = source.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .filter(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "accessScript",
  );
assert.equal(declarations.length, 1);
const initializer = declarations[0].initializer;
assert.ok(
  initializer &&
    ts.isTaggedTemplateExpression(initializer) &&
    ts.isNoSubstitutionTemplateLiteral(initializer.template),
);
const program = buildWindowsTaskAccessDiagnostic(
  initializer.template.rawText ?? initializer.template.text,
);
const environment = windowsEnvironment(process.env);
assert.ok(environment.SYSTEMROOT);
const executable = await realpath(
  path.win32.join(
    environment.SYSTEMROOT,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  ),
);
const executableSha256 = hash(await readFile(executable));
const temporary = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "checktrail-ci-acl-probe-")),
);
const cases = [];
try {
  for (const mode of ["systemroot-only", "full-inherited"]) {
    const directory = path.join(temporary, mode + "-'[literal]-🧪");
    await mkdir(directory);
    for (const created of [true, false]) {
      const started = performance.now();
      let stdout = "",
        stderr = "",
        status = 0,
        errorCode = null,
        signal = null;
      try {
        const observed = spawnSync(
          executable,
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(program, "utf16le").toString("base64"),
          ],
          {
            input: JSON.stringify({
              path: directory,
              kind: "directory",
              created,
            }),
            encoding: "utf8",
            env:
              mode === "systemroot-only"
                ? { SYSTEMROOT: environment.SYSTEMROOT }
                : process.env,
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 32768,
          },
        );
        stdout = String(observed.stdout ?? "");
        stderr = String(observed.stderr ?? "");
        status = observed.status;
        errorCode = observed.error?.code ?? null;
        signal = observed.signal;
      } catch (error) {
        status = typeof error.status === "number" ? error.status : null;
        errorCode = error.code ?? null;
        signal = error.signal ?? null;
        stdout = String(error.stdout ?? "");
        stderr = String(error.stderr ?? "");
      }
      let validPrivateAcl = false;
      if (status === 0) {
        try {
          validateWindowsTaskAccess(
            JSON.parse(stdout.replace(/^\uFEFF/, "")),
            "directory",
          );
          validPrivateAcl = true;
        } catch {
          /* This diagnostic does not convert unusable data into acceptance. */
        }
      }
      const diagnostic = summarizeWindowsTaskAccessDiagnostic(stderr);
      cases.push({
        environment: mode,
        created,
        durationMs: Math.round(performance.now() - started),
        status,
        errorCode,
        signal,
        validPrivateAcl,
        stdoutBytes: Buffer.byteLength(stdout),
        stdoutSha256: hash(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        stderrSha256: hash(stderr),
        ...diagnostic,
      });
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
assert.equal(hash(await readFile(executable)), executableSha256);
assert.equal(
  hash(
    await readFile(
      new URL("../dist/src/windows-task-access.js", import.meta.url),
    ),
  ),
  hash(sourceBytes),
);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    scope:
      "Shipped Windows ACL decisions with staged stdin and JSON parsing; private owned setup only",
    sourceEntrypointSha256: hash(sourceBytes),
    diagnosticProgramSha256: hash(program),
    node: process.versions.node,
    systemPowerShellSha256: executableSha256,
    cases,
    cleanupComplete: true,
    acceptanceClaim: false,
    gateAClosed: false,
    inferenceExecuted: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
