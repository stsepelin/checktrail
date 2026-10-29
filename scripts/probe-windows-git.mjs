import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitReader } from "../dist/src/git-selection.js";
import { runHostGitMetadata } from "../dist/src/posix-target.js";
import { windowsEnvironment } from "../dist/src/windows-process.js";
import {
  gitMetadataEnvironment,
  gitMetadataPrefix,
  isWindowsBuiltinGit,
} from "../dist/src/git-metadata-policy.js";
import { fixtureGit, syntheticCommit } from "../dist/test/git-fixture.js";

if (process.platform !== "win32")
  throw Error("Native Windows diagnostic required");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-synthetic-git-diagnostic-")),
);
const report = {
  scope:
    "Diagnostic observations of a synthetic repository; not PR acceptance or Gate A closure",
  node: process.version,
  platform: process.platform,
  environmentKeys: Object.keys(process.env).filter((key) =>
    ["PATH", "SYSTEMROOT", "HOME", "USERPROFILE"].includes(key.toUpperCase()),
  ),
  candidates: [],
  cmdOnlyReader: [],
  reader: [],
  gateAComplete: false,
  inferenceInvoked: false,
};
let readerPassed = false;
const summarize = (r) => ({
  status: r.status ?? r.exitCode,
  signal: r.signal,
  errorCode: r.error?.code ?? r.errorCode,
  timedOut: r.timedOut,
  stdout: (r.stdout ?? "").toString().slice(0, 2000),
  stderr: (r.stderr ?? "").toString().slice(0, 4000),
});
try {
  fixtureGit(root, ["init", "--quiet"]);
  report.base = await syntheticCommit(root, {
    "original.js": "export const original = true;\n",
  });
  const candidates = new Set();
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const launcher = await realpath(path.join(directory, "git.exe"));
      const possible = [launcher];
      if (
        ["cmd", "bin"].includes(
          path.basename(path.dirname(launcher)).toLowerCase(),
        )
      )
        possible.push(
          path.join(
            path.dirname(path.dirname(launcher)),
            "mingw64",
            "bin",
            "git.exe",
          ),
        );
      for (const value of possible) {
        try {
          candidates.add(await realpath(value));
        } catch {}
      }
    } catch {}
  }
  for (const executable of candidates) {
    const observed = {
      executable,
      builtin: isWindowsBuiltinGit(executable),
      commands: [],
    };
    if (observed.builtin) {
      for (const args of [
        ["--version"],
        ["rev-parse", "--show-toplevel"],
        ["rev-parse", "--verify", "HEAD^{commit}"],
        ["ls-files", "--stage", "-z"],
      ]) {
        const command = {
          executable,
          args: [...gitMetadataPrefix, ...args],
          cwd: ".",
          env: gitMetadataEnvironment,
        };
        try {
          observed.commands.push({
            args,
            collector: summarize(
              await runHostGitMetadata(root, command, {
                timeoutMs: 5000,
                maxOutputBytes: 65536,
              }),
            ),
          });
        } catch (error) {
          observed.commands.push({
            args,
            collectorError: { code: error.code, message: error.message },
          });
        }
        observed.commands.push({
          args,
          direct: summarize(
            spawnSync(executable, command.args, {
              cwd: root,
              env: windowsEnvironment(process.env, undefined, command.env),
              shell: false,
              windowsHide: true,
              timeout: 5000,
              maxBuffer: 65536,
            }),
          ),
        });
      }
    }
    report.candidates.push(observed);
  }
  const read = gitReader(root);
  for (const args of [
    ["--version"],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--verify", "HEAD^{commit}"],
    ["ls-files", "--stage", "-z"],
  ]) {
    try {
      report.reader.push({ args, stdout: (await read(args)).slice(0, 4000) });
    } catch (error) {
      report.reader.push({
        args,
        error: { code: error.code, message: error.message },
      });
      break;
    }
  }
  const launcher = [...candidates].find(
    (value) => path.basename(path.dirname(value)).toLowerCase() === "cmd",
  );
  const originalPath = process.env.PATH;
  try {
    if (!launcher) throw Error("Selected diagnostic host has no cmd launcher");
    process.env.PATH = path.dirname(launcher);
    const readFromLauncher = gitReader(root);
    for (const args of [
      ["--version"],
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["ls-files", "--stage", "-z"],
    ]) {
      try {
        report.cmdOnlyReader.push({
          args,
          stdout: (await readFromLauncher(args)).slice(0, 4000),
        });
      } catch (error) {
        report.cmdOnlyReader.push({
          args,
          error: { code: error.code, message: error.message },
        });
        break;
      }
    }
  } finally {
    process.env.PATH = originalPath;
  }
  readerPassed =
    report.reader.length === 4 &&
    report.reader.every((value) => !value.error) &&
    report.cmdOnlyReader.length === 4 &&
    report.cmdOnlyReader.every((value) => !value.error);
} catch (error) {
  report.setupError = {
    code: error.code,
    message: error.message,
    stderr: error.stderr?.toString().slice(0, 4000),
  };
} finally {
  await rm(root, { recursive: true, force: true });
}
report.readerPassed = readerPassed;
console.log(JSON.stringify(report));
if (!readerPassed) process.exitCode = 1;
