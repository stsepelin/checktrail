import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { runCiCommand } from "./ci-validation.mjs";
import { readPlaywrightTools } from "./prepare-playwright-tools.mjs";
import { prepareUbuntuMirrors } from "./prepare-ubuntu-mirrors.mjs";

export const browserInstallArguments = Object.freeze([
  "install",
  "chromium",
  "--only-shell",
  "--with-deps",
]);
export const browserAcquisitionLimits = Object.freeze({
  attempts: 3,
  totalMilliseconds: 540000,
  attemptMilliseconds: 165000,
  outputBytes: 2 * 1048576,
  backoffMilliseconds: Object.freeze([2000, 5000]),
});
export function validateBrowserAcquisitionOwner(platform, uid, effectiveUid) {
  assert.ok(
    ["linux", "darwin"].includes(platform),
    "Unsupported browser acquisition owner platform",
  );
  assert.ok(
    Number.isSafeInteger(uid) &&
      uid >= 0 &&
      Number.isSafeInteger(effectiveUid) &&
      effectiveUid >= 0,
    "Browser acquisition needs observed process ownership",
  );
  if (platform === "linux") {
    assert.equal(
      uid,
      0,
      "Linux browser acquisition requires a root-owned helper",
    );
    assert.equal(
      effectiveUid,
      0,
      "Linux browser acquisition requires an effective root owner",
    );
  }
  return Object.freeze({ platform, uid, effectiveUid });
}

const mirrors = new Set([
  "azure.archive.ubuntu.com",
  "archive.ubuntu.com",
  "security.ubuntu.com",
]);
const archiveUrl = (value) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      mirrors.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/ubuntu" || url.pathname.startsWith("/ubuntu/")) &&
      url
    );
  } catch {
    return false;
  }
};

const aptArchitecture =
  "(?:all|amd64|amd64v2|amd64v3|amd64v4|arm64|armhf|i386)";
const aptSuite = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
const aptComponent = "(?:main|restricted|universe|multiverse)";
const aptSize = "(?: \\[\\d+(?:\\.\\d+)? (?:B|kB|MB)\\])?";
const aptIndex = new RegExp("^" + aptSuite + " InRelease" + aptSize + "$", "u");
const aptIndexPackages = new RegExp(
  "^" +
    aptSuite +
    "/" +
    aptComponent +
    " " +
    aptArchitecture +
    " Packages" +
    aptSize +
    "$",
  "u",
);
const aptArchive = new RegExp(
  "^" +
    aptSuite +
    "/" +
    aptComponent +
    " " +
    aptArchitecture +
    " [a-z0-9][a-z0-9+.-]+ " +
    aptArchitecture +
    " (?:[0-9]+:)?[0-9][A-Za-z0-9.+~_-]*" +
    aptSize +
    "$",
  "u",
);
function aptProgress(line) {
  if (
    /^Get:[1-9]\d* file:\/etc\/apt\/apt-mirrors\.txt Mirrorlist \[\d+(?:\.\d+)? (?:B|kB|MB)\]$/u.test(
      line,
    )
  )
    return { kind: "Get" };
  const match = /^(Err|Ign|Get|Hit):[1-9]\d* (\S+) (.+)$/u.exec(line);
  if (!match) return null;
  let url;
  try {
    url = new URL(match[2]);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return null;
  if (
    ["Err", "Ign"].includes(match[1]) &&
    (!mirrors.has(url.hostname) ||
      !["/ubuntu", "/ubuntu/"].includes(url.pathname))
  )
    return null;
  if (
    !aptIndex.test(match[3]) &&
    !aptArchive.test(match[3]) &&
    !(["Get", "Hit"].includes(match[1]) && aptIndexPackages.test(match[3]))
  )
    return null;
  return { kind: match[1] };
}
function aptErrorBoundary(line) {
  return (
    /^(?:Err|Ign|Get|Hit):/iu.test(line) ||
    /^(?:E:|W:)/u.test(line) ||
    /^(?:Reading package lists|Building dependency tree|Reading state information)\.\.\.(?: Done)?$/u.test(
      line,
    ) ||
    /^Fetched \d+(?:\.\d+)? (?:B|kB|MB) in (?:\d+min )?\d+s \(\d+(?:\.\d+)? (?:B|kB|MB)\/s\)$/u.test(
      line,
    )
  );
}

// An unknown failure is terminal. APT's generic exit 100 alone does not identify
// a network failure: it also covers bad signatures, missing packages and locks.
export function isTransientAptDnsFailure(result) {
  if (
    !result ||
    typeof result !== "object" ||
    ![1, 100].includes(result.exitCode) ||
    !["timedOut", "canceled", "outputExceeded"].every(
      (key) => result[key] === false,
    ) ||
    result.signal !== null ||
    result.timedOut ||
    result.canceled ||
    result.outputExceeded ||
    result.error !== null ||
    typeof result.output !== "string" ||
    Buffer.byteLength(result.output) > browserAcquisitionLimits.outputBytes
  )
    return false;
  const color = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
  const text = result.output.replace(color, "");
  if (
    [...text].some(
      (character) =>
        character.codePointAt(0) < 32 && !"\r\n\t".includes(character),
    ) ||
    text.includes(String.fromCharCode(127)) ||
    text.includes("\ufffd")
  )
    return false;
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  if (
    lines.filter(Boolean).at(-1) !==
    "Error: Installation process exited with code: 100"
  )
    return false;
  let fetches = 0,
    terminal = 0,
    aggregates = 0,
    indexDns = 0,
    indexAggregates = 0,
    pendingError = false,
    pendingDns = false;
  for (const line of lines) {
    if (!line) continue;
    const dns = /^Temporary failure resolving '([^']+)'$/u.exec(line);
    if (dns) {
      if (!pendingError || !mirrors.has(dns[1])) return false;
      pendingDns = true;
      continue;
    }
    if (pendingError) {
      if (!pendingDns || !aptErrorBoundary(line)) return false;
      pendingError = false;
      pendingDns = false;
    }
    if (/^(?:Err|Ign|Get|Hit):/iu.test(line)) {
      const progress = aptProgress(line);
      if (!progress) return false;
      if (progress.kind === "Err") pendingError = true;
      continue;
    }
    if (line === "Error: Installation process exited with code: 100") {
      terminal++;
      continue;
    }
    if (line === "Failed to install browsers") continue;
    if (
      line ===
        "E: Unable to fetch some archives, maybe run apt update or try with --fix-missing?" ||
      line ===
        "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?"
    ) {
      aggregates++;
      continue;
    }
    const fetch =
      /^E: Failed to fetch (\S+)\s+Temporary failure resolving '([^']+)'$/u.exec(
        line,
      );
    if (fetch) {
      const url = archiveUrl(fetch[1]);
      if (!url || url.hostname !== fetch[2] || !url.pathname.endsWith(".deb"))
        return false;
      fetches++;
      continue;
    }
    const indexFetch =
      /^W: Failed to fetch (\S+)\s+Temporary failure resolving '([^']+)'$/u.exec(
        line,
      );
    if (indexFetch) {
      const url = archiveUrl(indexFetch[1]);
      const direct =
        url &&
        url.hostname === indexFetch[2] &&
        /^\/ubuntu\/dists\/[a-z0-9][a-z0-9-]*\/InRelease$/u.test(url.pathname);
      const mirrored =
        /^mirror\+file:\/etc\/apt\/apt-mirrors\.txt\/dists\/[a-z0-9][a-z0-9-]*\/InRelease$/u.test(
          indexFetch[1],
        );
      if (!mirrors.has(indexFetch[2]) || (!direct && !mirrored)) return false;
      indexDns++;
      continue;
    }
    if (
      line ===
      "W: Some index files failed to download. They have been ignored, or old ones used instead."
    ) {
      if (indexDns === 0) return false;
      indexAggregates++;
      continue;
    }
    // Do not retry a positively identified DNS failure mixed with any other
    // fatal/warning diagnostic. Ordinary APT progress is retained verbatim.
    if (
      /^(?:E:|W:|Err:)/u.test(line) ||
      /error|fail|fatal|denied|mismatch|signature|certificate|unauthenticated|unsigned|unmet|corrupt|invalid|no space|read-only|not found|no installation candidate|unable|could not|cannot|not signed/iu.test(
        line,
      )
    )
      return false;
  }
  return (
    fetches > 0 &&
    aggregates === 1 &&
    terminal === 1 &&
    indexAggregates === (indexDns > 0 ? 1 : 0)
  );
}

async function qualifiedCli(repository) {
  const root = await realpath(path.resolve(repository));
  for (const input of [
    "scripts/playwright-tools/package.json",
    "scripts/playwright-tools/package-lock.json",
  ]) {
    const target = path.join(root, input);
    assert.ok(
      (await lstat(target)).isFile(),
      "Nonphysical Playwright declaration",
    );
    assert.equal(
      await realpath(target),
      target,
      "Linked Playwright declaration",
    );
  }
  const profile = await readPlaywrightTools(pathToFileURL(root + path.sep));
  const prefix = path.join(root, ".checktrail/playwright-tools");
  for (const [name, expected] of [
    ["package.json", profile.manifestBytes],
    ["package-lock.json", profile.lockBytes],
  ]) {
    const target = path.join(prefix, name);
    assert.ok((await lstat(target)).isFile(), "Nonphysical Playwright input");
    assert.deepEqual(
      await readFile(target),
      expected,
      "Stale Playwright inputs",
    );
  }
  const version = profile.manifest.dependencies["@playwright/test"];
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    const directory = path.join(prefix, "node_modules", name);
    assert.ok(
      (await lstat(directory)).isDirectory(),
      "Linked Playwright package",
    );
    assert.equal(
      await realpath(directory),
      directory,
      "Linked Playwright package path",
    );
    const target = path.join(directory, "package.json");
    assert.ok((await lstat(target)).isFile(), "Linked Playwright manifest");
    const installed = JSON.parse(await readFile(target, "utf8"));
    assert.equal(installed.name, name);
    assert.equal(installed.version, version, "Unqualified Playwright version");
    assert.deepEqual(
      installed.dependencies ?? {},
      profile.lock.packages["node_modules/" + name].dependencies ?? {},
      "Unqualified Playwright dependency graph",
    );
  }
  const cli = path.join(prefix, "node_modules/playwright/cli.js");
  assert.ok((await lstat(cli)).isFile(), "Nonphysical Playwright CLI");
  assert.equal(
    await realpath(cli),
    cli,
    "Playwright CLI path escaped its prefix",
  );
  return { root, cli, version };
}

export async function runBrowserAcquisitionAttempt({
  repository,
  cli,
  signal,
  timeoutMilliseconds,
  outputBytes,
}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-browser-"));
  const log = path.join(temporary, "acquisition.log");
  const abort = new globalThis.AbortController();
  let timedOut = false,
    failure = null;
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) abort.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMilliseconds);
  try {
    try {
      await runCiCommand(
        repository,
        {
          script: cli,
          args: [...browserInstallArguments],
          env: {
            PLAYWRIGHT_BROWSERS_PATH: path.join(
              repository,
              ".checktrail/playwright-browsers",
            ),
          },
        },
        { signal: abort.signal, temporary, log, maxOutputBytes: outputBytes },
      );
    } catch (error) {
      failure = error;
    }
    const output = await readFile(log, "utf8").catch((error) => {
      if (error.code === "ENOENT" && signal.aborted) return "";
      throw error;
    });
    const terminal = failure?.message.match(
      /\(code=(\d+|null), signal=(SIG[A-Z0-9]+|null)\)$/u,
    );
    return {
      exitCode: failure
        ? !terminal || terminal[1] === "null"
          ? null
          : Number(terminal[1])
        : 0,
      signal: terminal && terminal[2] !== "null" ? terminal[2] : null,
      timedOut,
      canceled: signal.aborted,
      outputExceeded: Boolean(
        failure?.message.startsWith("CI command output limit exceeded:"),
      ),
      error: failure && !terminal ? failure.message : null,
      output,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function preparePlaywrightBrowser(
  repository,
  {
    run = runBrowserAcquisitionAttempt,
    now = () => performance.now(),
    delay = (milliseconds, signal) =>
      sleep(milliseconds, undefined, { signal }),
    signal = new globalThis.AbortController().signal,
    onAttempt = () => {},
    limits = browserAcquisitionLimits,
    prepareMirrors = prepareUbuntuMirrors,
  } = {},
) {
  assert.deepEqual(
    Object.keys(limits).sort(),
    Object.keys(browserAcquisitionLimits).sort(),
  );
  for (const key of [
    "attempts",
    "totalMilliseconds",
    "attemptMilliseconds",
    "outputBytes",
  ])
    assert.ok(
      Number.isSafeInteger(limits[key]) &&
        limits[key] > 0 &&
        limits[key] <= browserAcquisitionLimits[key],
      "Invalid browser acquisition limit: " + key,
    );
  assert.ok(
    Array.isArray(limits.backoffMilliseconds) &&
      limits.backoffMilliseconds.length === 2,
  );
  for (const [index, value] of limits.backoffMilliseconds.entries())
    assert.ok(
      Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= browserAcquisitionLimits.backoffMilliseconds[index],
    );
  const start = now();
  let last = start;
  const elapsed = () => {
    const value = now();
    assert.ok(
      Number.isFinite(value) && value >= last,
      "Invalid acquisition clock",
    );
    last = value;
    return value - start;
  };
  assert.ok(Number.isFinite(start), "Invalid acquisition clock");
  // Production ownership comes from the actual Node process, never a CLI flag.
  // Linux Playwright escalates APT descendants; its supervisor must own them.
  const native = run === runBrowserAcquisitionAttempt;
  if (native)
    validateBrowserAcquisitionOwner(
      process.platform,
      process.getuid?.(),
      process.geteuid?.(),
    );
  const { root, cli, version } = await qualifiedCli(repository);
  const inactive = {
    schemaVersion: 1,
    state: "not-applicable",
    reason: "injected-runner",
    sourceCount: 0,
    targetCount: 0,
    changedCount: 0,
    restoredCount: 0,
    hashes: [],
  };
  const mirrors =
    native || prepareMirrors !== prepareUbuntuMirrors
      ? await prepareMirrors()
      : { metadata: inactive, restore: async () => inactive };
  assert.ok(
    mirrors &&
      typeof mirrors.restore === "function" &&
      mirrors.metadata &&
      typeof mirrors.metadata.state === "string",
    "Malformed Ubuntu mirror preparation",
  );
  let familyQuiescent = true;
  const acquire = async () => {
    if (mirrors.metadata.state === "failed")
      return {
        state: "failed",
        reason: "mirror-preparation-failed",
        version,
        attempts: [],
        elapsedMilliseconds: elapsed(),
      };
    if (native) {
      const cache = path.join(root, ".checktrail/playwright-browsers");
      try {
        await mkdir(cache, { mode: 0o755 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      assert.ok(
        (await lstat(cache)).isDirectory(),
        "Nonphysical Playwright browser cache",
      );
      assert.equal(
        await realpath(cache),
        cache,
        "Linked Playwright browser cache",
      );
      await chmod(cache, 0o755);
    }
    const attempts = [];
    const receipt = (state, reason) => ({
      state,
      reason,
      version,
      attempts,
      elapsedMilliseconds: elapsed(),
    });
    for (let attempt = 1; attempt <= limits.attempts; attempt++) {
      if (signal.aborted) return receipt("failed", "canceled");
      const remaining = limits.totalMilliseconds - elapsed();
      if (remaining <= 0) return receipt("failed", "deadline-exceeded");
      familyQuiescent = false;
      const result = await run({
        repository: root,
        cli,
        args: [...browserInstallArguments],
        signal,
        timeoutMilliseconds: Math.min(remaining, limits.attemptMilliseconds),
        outputBytes: limits.outputBytes,
      });
      assert.ok(
        result && typeof result === "object",
        "Malformed acquisition result",
      );
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          "exitCode",
          "signal",
          "timedOut",
          "canceled",
          "outputExceeded",
          "error",
          "output",
        ].sort(),
        "Malformed acquisition result keys",
      );
      assert.ok(
        result.exitCode === null ||
          (Number.isInteger(result.exitCode) &&
            result.exitCode >= 0 &&
            result.exitCode <= 255),
        "Malformed acquisition exit",
      );
      assert.ok(
        result.signal === null ||
          (typeof result.signal === "string" &&
            /^SIG[A-Z0-9]+$/u.test(result.signal)),
        "Malformed acquisition signal",
      );
      for (const key of ["timedOut", "canceled", "outputExceeded"])
        assert.equal(
          typeof result[key],
          "boolean",
          "Malformed acquisition flag",
        );
      assert.ok(
        result.error === null || typeof result.error === "string",
        "Malformed acquisition error",
      );
      assert.equal(
        typeof result.output,
        "string",
        "Malformed acquisition output",
      );
      // runCiCommand's terminal wrapper survives only when its awaited family
      // cleanup succeeded; a cleanup rejection is retained in result.error.
      familyQuiescent =
        result.error === null &&
        (Number.isInteger(result.exitCode) || result.signal !== null);
      const retainedBytes = Buffer.byteLength(result.output);
      const safe =
        result.signal === null &&
        !result.timedOut &&
        !result.canceled &&
        !result.outputExceeded &&
        result.error === null &&
        retainedBytes <= limits.outputBytes;
      const passed =
        safe &&
        result.exitCode === 0 &&
        !signal.aborted &&
        elapsed() < limits.totalMilliseconds;
      const retryable =
        !signal.aborted &&
        retainedBytes <= limits.outputBytes &&
        isTransientAptDnsFailure(result);
      const record = {
        attempt,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        canceled: result.canceled,
        outputExceeded: result.outputExceeded,
        error: result.error,
        retainedOutputBytes: retainedBytes,
        outputSha256: createHash("sha256").update(result.output).digest("hex"),
        passed,
        retryable,
      };
      attempts.push(record);
      await onAttempt(record, result.output);
      if (passed) return receipt("ready", null);
      if (signal.aborted) return receipt("failed", "canceled");
      if (elapsed() >= limits.totalMilliseconds)
        return receipt("failed", "deadline-exceeded");
      if (!retryable || attempt === limits.attempts)
        return receipt(
          "failed",
          retryable ? "attempts-exhausted" : "terminal-acquisition-failure",
        );
      const wait = limits.backoffMilliseconds[attempt - 1];
      if (elapsed() + wait >= limits.totalMilliseconds)
        return receipt("failed", "deadline-exceeded");
      try {
        await delay(wait, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    throw Error("Browser acquisition did not produce a terminal receipt");
  };
  let result, failure;
  try {
    result = await acquire();
  } catch (error) {
    failure = error;
  }
  if (!familyQuiescent) {
    let mirrorPreparation = {
      ...mirrors.metadata,
      state: "failed",
      reason: "quiescence-unverified",
    };
    try {
      if (typeof mirrors.abandon === "function")
        mirrorPreparation = await mirrors.abandon();
    } catch {
      /* Retain failure; never restore while the CLI family is unverified. */
    }
    if (failure) {
      const error =
        failure instanceof Error
          ? failure
          : Error("Browser acquisition family quiescence is unverified");
      error.mirrorPreparation = mirrorPreparation;
      throw error;
    }
    return {
      ...result,
      state: "failed",
      reason: "mirror-quiescence-unverified",
      mirrorPreparation,
    };
  }
  let mirrorPreparation;
  try {
    mirrorPreparation = await mirrors.restore();
  } catch {
    mirrorPreparation = {
      ...inactive,
      state: "failed",
      reason: "restoration-incomplete",
    };
  }
  const restored =
    mirrorPreparation &&
    ["not-applicable", "unsupported", "unchanged", "restored"].includes(
      mirrorPreparation.state,
    );
  if (!restored) {
    if (failure)
      throw Error(
        "Browser acquisition failed and Ubuntu mirror restoration is incomplete",
      );
    return {
      ...result,
      state: "failed",
      reason:
        result?.reason === "mirror-preparation-failed"
          ? result.reason
          : "mirror-restoration-failed",
      mirrorPreparation,
    };
  }
  if (failure) throw failure;
  return { ...result, mirrorPreparation };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(
    process.argv.length,
    2,
    "Browser acquisition accepts no arguments",
  );
  const previousMask = process.umask(0o022);
  const abort = new globalThis.AbortController();
  const interrupt = () => abort.abort();
  for (const name of ["SIGINT", "SIGTERM"]) process.on(name, interrupt);
  try {
    const result = await preparePlaywrightBrowser(process.cwd(), {
      signal: abort.signal,
      onAttempt(record, output) {
        process.stdout.write(output);
        process.stdout.write(
          "\nBrowser acquisition attempt: " + JSON.stringify(record) + "\n",
        );
      },
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.state !== "ready") process.exitCode = 1;
  } finally {
    process.umask(previousMask);
    for (const name of ["SIGINT", "SIGTERM"])
      process.removeListener(name, interrupt);
  }
}
