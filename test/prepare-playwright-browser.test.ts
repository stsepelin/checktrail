import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  captureFixtureProcessGroup,
  cleanupFixtureProcessGroup,
} from "./helpers.js";
import { processSnapshot } from "../src/process-tree.js";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const browser = await import(
  pathToFileURL(path.join(repository, "scripts/prepare-playwright-browser.mjs"))
    .href
);
const transientOutput = [
  "Reading package lists...",
  "Err:1 https://security.ubuntu.com/ubuntu synthetic/main amd64 fonts-synthetic all 1.0",
  "  Temporary failure resolving 'security.ubuntu.com'",
  "E: Failed to fetch https://security.ubuntu.com/ubuntu/pool/main/f/fonts-synthetic/fonts-synthetic_1.0_all.deb  Temporary failure resolving 'security.ubuntu.com'",
  "E: Unable to fetch some archives, maybe run apt update or try with --fix-missing?",
  "Failed to install browsers",
  "Error: Installation process exited with code: 100",
].join("\n");
const withDiagnostic = (diagnostic: string, output = transientOutput) =>
  output.replace(
    "Error: Installation process exited with code: 100",
    diagnostic + "\nError: Installation process exited with code: 100",
  );

type Attempt = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  canceled: boolean;
  outputExceeded: boolean;
  error: string | null;
  output: string;
};
const terminal = (edit: Partial<Attempt> = {}): Attempt => ({
  exitCode: 1,
  signal: null,
  timedOut: false,
  canceled: false,
  outputExceeded: false,
  error: null,
  output: transientOutput,
  ...edit,
});
const success = () => terminal({ exitCode: 0, output: "Chromium acquired\n" });
const inactiveMirrors = {
  schemaVersion: 1,
  state: "not-applicable",
  reason: "synthetic",
  sourceCount: 0,
  targetCount: 0,
  changedCount: 0,
  restoredCount: 0,
  hashes: [],
};
const noSystemMirrors = async () => ({
  metadata: inactiveMirrors,
  restore: async () => inactiveMirrors,
});

async function profile(cliSource = "process.exit(0);\n") {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "checktrail-browser-test-")),
  );
  const prefix = path.join(root, ".checktrail/playwright-tools");
  await mkdir(path.join(root, "scripts/playwright-tools"), { recursive: true });
  await mkdir(prefix, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    const bytes = await readFile(
      path.join(repository, "scripts/playwright-tools", name),
    );
    await writeFile(path.join(root, "scripts/playwright-tools", name), bytes);
    await writeFile(path.join(prefix, name), bytes);
  }
  const lock = JSON.parse(
    await readFile(path.join(prefix, "package-lock.json"), "utf8"),
  );
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    const entry = lock.packages["node_modules/" + name];
    const directory = path.join(prefix, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name,
        version: entry.version,
        dependencies: entry.dependencies ?? {},
      }),
    );
  }
  const cli = path.join(prefix, "node_modules/playwright/cli.js");
  await writeFile(cli, cliSource);
  return {
    root,
    cli,
    version: lock.packages[""].dependencies["@playwright/test"],
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("browser acquisition uses the qualified fixture CLI and exact Chromium arguments once on success", async () => {
  const f = await profile();
  try {
    const calls: unknown[] = [];
    const observed: unknown[] = [];
    const result = await browser.preparePlaywrightBrowser(f.root, {
      now: () => 0,
      run: async (options: Record<string, unknown>) => {
        calls.push(options);
        return success();
      },
      delay: async () => assert.fail("Healthy acquisition must not back off"),
      onAttempt: (record: unknown, output: string) =>
        observed.push({ record, output }),
    });
    assert.equal(result.state, "ready");
    assert.equal(result.version, f.version);
    assert.equal(result.attempts.length, 1);
    assert.deepEqual((calls[0] as { args: string[] }).args, [
      "install",
      "chromium",
      "--only-shell",
      "--with-deps",
    ]);
    assert.equal((calls[0] as { cli: string }).cli, f.cli);
    assert.equal((calls[0] as { repository: string }).repository, f.root);
    assert.equal(
      (calls[0] as { timeoutMilliseconds: number }).timeoutMilliseconds,
      165000,
    );
    assert.equal(calls.length, 1);
    assert.equal(observed.length, 1);
    assert.equal(result.attempts[0].passed, true);
  } finally {
    await f.cleanup();
  }
});

test("positive APT DNS acquisition failure is retained before a fresh bounded recovery attempt", async () => {
  const f = await profile();
  try {
    let clock = 0,
      calls = 0;
    const waits: number[] = [],
      reports: unknown[] = [];
    const result = await browser.preparePlaywrightBrowser(f.root, {
      now: () => clock,
      run: async (options: {
        cli: string;
        args: string[];
        timeoutMilliseconds: number;
      }) => {
        assert.equal(options.cli, f.cli);
        assert.deepEqual(options.args, [...browser.browserInstallArguments]);
        assert.equal(options.timeoutMilliseconds, 165000);
        calls++;
        clock += 10;
        return calls === 1 ? terminal() : success();
      },
      delay: async (milliseconds: number) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      onAttempt: (record: unknown) => reports.push(record),
    });
    assert.equal(result.state, "ready");
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2000]);
    assert.equal(reports.length, 2);
    assert.deepEqual(
      result.attempts.map((row: { passed: boolean; retryable: boolean }) => [
        row.passed,
        row.retryable,
      ]),
      [
        [false, true],
        [true, false],
      ],
    );
    assert.equal(
      result.attempts[0].outputSha256,
      createHash("sha256").update(transientOutput).digest("hex"),
    );
    assert.equal(result.elapsedMilliseconds, 2020);
  } finally {
    await f.cleanup();
  }
});

test("persistent positive APT DNS failures stop after exactly three attempts and two backoffs", async () => {
  const f = await profile();
  try {
    let calls = 0;
    const waits: number[] = [];
    const result = await browser.preparePlaywrightBrowser(f.root, {
      now: () => 0,
      run: async () => {
        calls++;
        return terminal();
      },
      delay: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "attempts-exhausted");
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 5000]);
    assert.equal(result.attempts.length, 3);
    assert.ok(result.attempts.every((row: { passed: boolean }) => !row.passed));
  } finally {
    await f.cleanup();
  }
});

const noRetry: [string, Partial<Attempt>][] = [
  [
    "unknown index warning",
    {
      output:
        "W: Some index files failed to download. They have been ignored, or old ones used instead.\n" +
        transientOutput,
    },
  ],
  [
    "index mirror-file prefix near miss",
    {
      output:
        "W: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt-backup/dists/synthetic/InRelease  Temporary failure resolving 'security.ubuntu.com'\n" +
        transientOutput,
    },
  ],
  [
    "index DNS host suffix near miss",
    {
      output:
        "W: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/dists/synthetic/InRelease  Temporary failure resolving 'security.ubuntu.com.invalid'\n" +
        transientOutput,
    },
  ],
  [
    "standalone fatal marker mixed with DNS",
    { output: withDiagnostic("FATAL: synthetic terminal") },
  ],
  [
    "archive path boundary near miss",
    {
      output: transientOutput.replace(
        ".com/ubuntu synthetic",
        ".com/ubuntu-adjacent synthetic",
      ),
    },
  ],
  [
    "integrity mismatch mixed with DNS",
    { output: withDiagnostic("E: Hash Sum mismatch") },
  ],
  [
    "signature failure mixed with DNS",
    {
      output: withDiagnostic("W: GPG error: repository signature invalid"),
    },
  ],
  [
    "missing package mixed with DNS",
    {
      output: withDiagnostic("E: Unable to locate package fonts-synthetic"),
    },
  ],
  [
    "permission failure mixed with DNS",
    {
      output: withDiagnostic("E: Could not open lock file: Permission denied"),
    },
  ],
  [
    "unknown fatal marker mixed with DNS",
    { output: withDiagnostic("fatal error: synthetic failure") },
  ],
  [
    "unrelated mirror near miss",
    {
      output: transientOutput.replaceAll(
        "security.ubuntu.com",
        "security.ubuntu.com.invalid",
      ),
    },
  ],
  [
    "mirror identifier prefix near miss",
    {
      output: transientOutput.replaceAll(
        "security.ubuntu.com",
        "security.ubuntu.com-token",
      ),
    },
  ],
  [
    "URL and diagnosed mirror disagree",
    {
      output: transientOutput.replace(
        ".deb  Temporary failure resolving 'security.ubuntu.com'",
        ".deb  Temporary failure resolving 'archive.ubuntu.com'",
      ),
    },
  ],
  [
    "missing observed APT wrapper marker",
    {
      output: transientOutput.replace(
        "Error: Installation process exited with code: 100",
        "",
      ),
    },
  ],
  [
    "APT status without a positive DNS diagnostic",
    {
      output:
        "E: synthetic failure\nError: Installation process exited with code: 100",
    },
  ],
  ["signal", { exitCode: null, signal: "SIGTERM" }],
  ["timeout", { timedOut: true }],
  ["cancellation", { canceled: true }],
  ["truncated output", { outputExceeded: true }],
  ["spawn failure", { exitCode: null, error: "ENOENT" }],
];
for (const [name, edit] of noRetry) {
  test("browser acquisition does not retry " + name, async () => {
    const f = await profile();
    try {
      let calls = 0;
      const outcome = terminal(edit);
      if (edit.output !== undefined)
        assert.notEqual(
          edit.output,
          transientOutput,
          "Failure fixture must actually change its diagnostic",
        );
      assert.equal(browser.isTransientAptDnsFailure(outcome), false);
      const result = await browser.preparePlaywrightBrowser(f.root, {
        now: () => 0,
        run: async () => {
          calls++;
          return outcome;
        },
        delay: async () => assert.fail("Terminal failures must not back off"),
      });
      assert.equal(result.state, "failed");
      assert.equal(calls, 1);
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].retryable, false);
    } finally {
      await f.cleanup();
    }
  });
}

test("acquisition graph and installed version validation reject stale input before any executable is admitted", async () => {
  for (const changed of ["declaration", "installed"]) {
    const f = await profile();
    try {
      const target =
        changed === "declaration"
          ? path.join(f.root, "scripts/playwright-tools/package.json")
          : path.join(
              f.root,
              ".checktrail/playwright-tools/node_modules/playwright/package.json",
            );
      const value = JSON.parse(await readFile(target, "utf8"));
      if (changed === "declaration")
        value.dependencies["@playwright/test"] = "^1.0.0";
      else value.version = "0.0.0";
      await writeFile(target, JSON.stringify(value));
      let calls = 0;
      await assert.rejects(
        browser.preparePlaywrightBrowser(f.root, {
          run: async () => {
            calls++;
            return success();
          },
        }),
        /pinned|Unqualified/u,
      );
      assert.equal(calls, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("acquisition does not admit an attempt after preflight exhausts its total wall window", async () => {
  const f = await profile();
  try {
    let reads = 0,
      calls = 0;
    const result = await browser.preparePlaywrightBrowser(f.root, {
      now: () => (reads++ === 0 ? 0 : 540000),
      run: async () => {
        calls++;
        return success();
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "deadline-exceeded");
    assert.equal(calls, 0);
    assert.deepEqual(result.attempts, []);
  } finally {
    await f.cleanup();
  }
});

test("late healthy acquisition remains failed and no later attempt is started", async () => {
  const f = await profile();
  try {
    let clock = 0,
      calls = 0;
    const result = await browser.preparePlaywrightBrowser(f.root, {
      now: () => clock,
      run: async () => {
        calls++;
        clock = 540000;
        return success();
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "deadline-exceeded");
    assert.equal(calls, 1);
    assert.equal(result.attempts[0].passed, false);
  } finally {
    await f.cleanup();
  }
});

test("cancellation during acquisition backoff prevents every later attempt", async () => {
  const f = await profile();
  try {
    const abort = new AbortController();
    let calls = 0;
    const result = await browser.preparePlaywrightBrowser(f.root, {
      signal: abort.signal,
      now: () => 0,
      run: async () => {
        calls++;
        return terminal();
      },
      delay: async () => {
        abort.abort();
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "canceled");
    assert.equal(calls, 1);
  } finally {
    await f.cleanup();
  }
});

test("bounded raw output admits its exact ceiling and refuses one extra byte even with zero exit", async () => {
  const f = await profile();
  try {
    for (const length of [64, 65]) {
      let calls = 0;
      const result = await browser.preparePlaywrightBrowser(f.root, {
        limits: { ...browser.browserAcquisitionLimits, outputBytes: 64 },
        now: () => 0,
        run: async () => {
          calls++;
          return terminal({ exitCode: 0, output: "x".repeat(length) });
        },
      });
      assert.equal(result.state, length === 64 ? "ready" : "failed");
      assert.equal(calls, 1);
    }
  } finally {
    await f.cleanup();
  }
});

test("malformed acquisition outcomes and backward clocks cannot become recovery evidence", async () => {
  const f = await profile();
  try {
    await assert.rejects(
      browser.preparePlaywrightBrowser(f.root, {
        run: async () => ({ ...success(), timedOut: undefined }),
      }),
      /Malformed acquisition flag/u,
    );
    let calls = 0;
    await assert.rejects(
      browser.preparePlaywrightBrowser(f.root, {
        now: () => 0,
        run: async () => {
          calls++;
          return { ...success(), exitCode: Number.NaN };
        },
      }),
      /Malformed acquisition exit/u,
    );
    assert.equal(calls, 1);
    const clock = [10, 10, 9];
    await assert.rejects(
      browser.preparePlaywrightBrowser(f.root, {
        now: () => clock.shift() ?? 9,
        run: async () => success(),
      }),
      /Invalid acquisition clock/u,
    );
  } finally {
    await f.cleanup();
  }
});

test("actual synthetic acquisition executable retains its stdout and uses the fixed argument vector", async () => {
  const f = await profile(
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  );
  try {
    const result = await browser.preparePlaywrightBrowser(f.root, {
      run: (options: unknown) => browser.runBrowserAcquisitionAttempt(options),
    });
    assert.equal(result.state, "ready");
    assert.equal(result.attempts.length, 1);
    const expected = JSON.stringify([
      "install",
      "chromium",
      "--only-shell",
      "--with-deps",
    ]);
    assert.equal(
      result.attempts[0].outputSha256,
      createHash("sha256").update(expected).digest("hex"),
    );
  } finally {
    await f.cleanup();
  }
});

test(
  "actual acquisition deadline stops a ready three-level synthetic process tree before returning",
  {
    skip:
      process.platform === "win32"
        ? "POSIX process-family cleanup unavailable"
        : false,
  },
  async () => {
    const f = await profile(`
      const {fork}=require('node:child_process');
      const fs=require('node:fs');
      const path=require('node:path');
      const child=fork(path.join(process.cwd(),'browser-child.cjs'),[],{stdio:['ignore','inherit','inherit','ipc']});
      child.on('message',m=>{if(m.ready)fs.writeFileSync(path.join(process.cwd(),'tree.ready'),JSON.stringify({root:process.pid,child:child.pid,leaf:m.leaf}));});
      setInterval(()=>{},1000);
    `);
    await writeFile(
      path.join(f.root, "browser-child.cjs"),
      `
      const {fork}=require('node:child_process');
      const path=require('node:path');
      const leaf=fork(path.join(process.cwd(),'browser-leaf.cjs'),[],{stdio:['ignore','inherit','inherit','ipc']});
      leaf.on('message',m=>{if(m.ready)process.send({ready:true,leaf:leaf.pid});});
      setInterval(()=>{},1000);
    `,
    );
    await writeFile(
      path.join(f.root, "browser-leaf.cjs"),
      "process.send({ready:true}); setInterval(()=>{},1000);\n",
    );
    const abort = new AbortController(),
      watch = new AbortController();
    let group:
      Awaited<ReturnType<typeof captureFixtureProcessGroup>> | undefined;
    let mirrorRestored = 0;
    const running = browser.preparePlaywrightBrowser(f.root, {
      signal: abort.signal,
      prepareMirrors: async () => ({
        metadata: { state: "prepared" },
        restore: async () => {
          assert.ok(
            group,
            "Mirror restoration must follow ready family capture",
          );
          const after = await processSnapshot();
          for (const held of [group.owner, ...group.members])
            assert.ok(
              !after.some(
                (row) => row.pid === held.pid && row.identity === held.identity,
              ),
              "Mirror restoration must wait until every owned CLI process is gone",
            );
          mirrorRestored++;
          return { state: "restored" };
        },
      }),
      run: (options: unknown) => browser.runBrowserAcquisitionAttempt(options),
      limits: {
        ...browser.browserAcquisitionLimits,
        attempts: 1,
        totalMilliseconds: 5000,
        attemptMilliseconds: 3000,
      },
    });
    running.catch(() => {});
    try {
      const readyDeadline = Date.now() + 2000;
      let ready: { root: number; child: number; leaf: number } | undefined;
      while (!ready) {
        try {
          ready = JSON.parse(
            await readFile(path.join(f.root, "tree.ready"), "utf8"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          assert.ok(
            Date.now() < readyDeadline,
            "Entire synthetic process family must be ready before its acquisition deadline",
          );
          await delay(10);
        }
      }
      group = await captureFixtureProcessGroup(ready.root, process.pid);
      assert.deepEqual(
        group.members.map((row) => row.pid).sort((a, b) => a - b),
        [ready.child, ready.leaf].sort((a, b) => a - b),
      );
      const result = await Promise.race([
        running,
        delay(7000, undefined, { signal: watch.signal, ref: false }).then(
          () => {
            throw Error(
              "Acquisition failed to return after its bounded cleanup",
            );
          },
        ),
      ]);
      assert.equal(result.state, "failed");
      assert.equal(result.mirrorPreparation.state, "restored");
      assert.equal(mirrorRestored, 1);
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].timedOut, true);
      assert.equal(result.attempts[0].passed, false);
      assert.notEqual(result.attempts[0].signal, null);
      const after = await processSnapshot();
      for (const held of [group.owner, ...group.members])
        assert.ok(
          !after.some(
            (row) => row.pid === held.pid && row.identity === held.identity,
          ),
          "Every held process identity must be gone when acquisition returns",
        );
    } finally {
      watch.abort();
      abort.abort();
      try {
        if (group) await cleanupFixtureProcessGroup(group);
      } finally {
        await running.catch(() => {});
        await f.cleanup();
      }
    }
  },
);

test("DNS-only APT index warnings are eligible only with complete DNS archive failures and the observed terminal", () => {
  for (const location of [
    "mirror+file:/etc/apt/apt-mirrors.txt/dists/synthetic/InRelease",
    "https://security.ubuntu.com/ubuntu/dists/synthetic/InRelease",
  ]) {
    const output = [
      "W: Failed to fetch " +
        location +
        "  Temporary failure resolving 'security.ubuntu.com'",
      "W: Some index files failed to download. They have been ignored, or old ones used instead.",
      transientOutput,
    ].join("\n");
    assert.equal(browser.isTransientAptDnsFailure(terminal({ output })), true);
    assert.equal(
      browser.isTransientAptDnsFailure(
        terminal({
          output: withDiagnostic(
            "W: GPG error: synthetic bad signature",
            output,
          ),
        }),
      ),
      false,
    );
  }
});

test("browser acquisition rejects expanded budgets before admission", async () => {
  for (const changed of [
    { attempts: 4 },
    { totalMilliseconds: 540001 },
    { attemptMilliseconds: 165001 },
    { outputBytes: 2 * 1048576 + 1 },
    { backoffMilliseconds: [2001, 5000] },
  ]) {
    let calls = 0;
    await assert.rejects(
      browser.preparePlaywrightBrowser("unused", {
        limits: { ...browser.browserAcquisitionLimits, ...changed },
        run: async () => {
          calls++;
          return success();
        },
      }),
    );
    assert.equal(calls, 0);
  }
});

test(
  "actual synthetic output overflow is terminal and retains only the declared byte ceiling",
  {
    skip:
      process.platform === "win32"
        ? "POSIX process-family cleanup unavailable"
        : false,
  },
  async () => {
    const f = await profile(
      "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);\n",
    );
    try {
      const result = await browser.preparePlaywrightBrowser(f.root, {
        run: (options: unknown) =>
          browser.runBrowserAcquisitionAttempt(options),
        limits: {
          ...browser.browserAcquisitionLimits,
          attempts: 1,
          totalMilliseconds: 3000,
          attemptMilliseconds: 2000,
          outputBytes: 128,
        },
      });
      assert.equal(result.state, "failed");
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].outputExceeded, true);
      assert.equal(result.attempts[0].timedOut, false);
      assert.equal(result.attempts[0].retainedOutputBytes, 128);
      assert.equal(
        result.attempts[0].outputSha256,
        createHash("sha256").update("x".repeat(128)).digest("hex"),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test("native browser owner admission requires actual Linux root identities and exact supported platform names", () => {
  assert.deepEqual(browser.validateBrowserAcquisitionOwner("linux", 0, 0), {
    platform: "linux",
    uid: 0,
    effectiveUid: 0,
  });
  assert.deepEqual(
    browser.validateBrowserAcquisitionOwner("darwin", 501, 501),
    { platform: "darwin", uid: 501, effectiveUid: 501 },
  );
  for (const [platform, uid, euid] of [
    ["linux", 1001, 1001],
    ["linux", 1001, 0],
    ["linux", 0, 1001],
    ["linux", undefined, undefined],
    ["linux", "0", "0"],
    ["linux-other", 0, 0],
    ["darwin-other", 501, 501],
    ["win32", 0, 0],
    ["darwin", undefined, undefined],
  ])
    assert.throws(() =>
      browser.validateBrowserAcquisitionOwner(platform, uid, euid),
    );
});

const inlineProgressFatal = [
  "Err:2 https://archive.ubuntu.com/ubuntu Hash Sum mismatch",
  "Err:2 https://archive.ubuntu.com/ubuntu Signature verification failed",
  "Err:2 https://archive.ubuntu.com/ubuntu NO_PUBKEY A1B2C3D4",
  "Err:2 https://archive.ubuntu.com/ubuntu Permission denied",
  "Err:2 https://archive.ubuntu.com/ubuntu Unable to locate package synthetic",
  "Err:2 https://archive.ubuntu.com/ubuntu Synthetic terminal condition",
  "Err:2 https://archive.ubuntu.com/ubuntu synthetic InRelease Hash Sum mismatch",
  "Err:2 https://archive.ubuntu.com/ubuntu synthetic/main amd64 fonts-synthetic all 1.0 Permission denied",
  "Err:2 https://archive.ubuntu.com/ubuntu synthetic InRelease\n  403 Forbidden",
  "Err:2 https://archive.ubuntu.com/ubuntu synthetic InRelease\n  Temporary failure resolving 'archive.ubuntu.com'\n  403 Forbidden",
];
test("APT progress cannot absorb inline integrity, signature, package, permission or unknown fatal diagnostics", () => {
  for (const header of inlineProgressFatal)
    assert.equal(
      browser.isTransientAptDnsFailure(
        terminal({ output: header + "\n" + transientOutput }),
      ),
      false,
      header,
    );
  for (const kind of ["Ign", "Get", "Hit"])
    for (const body of [
      "Hash Sum mismatch",
      "Signature verification failed",
      "Permission denied",
      "Synthetic terminal condition",
    ])
      assert.equal(
        browser.isTransientAptDnsFailure(
          terminal({
            output:
              kind +
              ":2 https://archive.ubuntu.com/ubuntu synthetic InRelease " +
              body +
              "\n" +
              transientOutput,
          }),
        ),
        false,
        kind + " " + body,
      );
  assert.equal(
    browser.isTransientAptDnsFailure(
      terminal({
        output:
          "Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist [144 B] Synthetic terminal condition\n" +
          transientOutput,
      }),
    ),
    false,
  );
  for (const kind of ["ERR", "ign", "get", "HIT"]) {
    assert.equal(
      browser.isTransientAptDnsFailure(
        terminal({
          output:
            kind +
            ":2 https://archive.ubuntu.com/ubuntu Synthetic terminal condition\n" +
            transientOutput,
        }),
      ),
      false,
      kind + " must not disguise an unknown progress diagnostic",
    );
  }
});
test("complete DNS-only index and archive progress headers retain their valid near misses", () => {
  for (const header of [
    "Ign:2 https://archive.ubuntu.com/ubuntu synthetic InRelease",
    "Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist [144 B]",
    "Get:2 https://packages.microsoft.com/ubuntu/26.04/prod synthetic InRelease [3964 B]",
    "Get:3 https://packages.microsoft.com/ubuntu/26.04/prod synthetic/main amd64 Packages [154 kB]",
    "Err:2 https://archive.ubuntu.com/ubuntu synthetic InRelease\n  Temporary failure resolving 'archive.ubuntu.com'",
    "Err:2 https://archive.ubuntu.com/ubuntu synthetic/universe amd64v3 fonts-synthetic all 1:0.7.3-1build1\n  Temporary failure resolving 'archive.ubuntu.com'",
  ])
    assert.equal(
      browser.isTransientAptDnsFailure(
        terminal({ output: header + "\n" + transientOutput }),
      ),
      true,
      header,
    );
});

test("native default admission uses actual host ownership and publishes a readable physical cache", async () => {
  const f = await profile();
  try {
    if (
      process.platform === "linux" &&
      (process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    ) {
      await assert.rejects(
        browser.preparePlaywrightBrowser(f.root),
        /root-owned helper|effective root/u,
      );
    } else if (["linux", "darwin"].includes(process.platform)) {
      const result = await browser.preparePlaywrightBrowser(f.root, {
        prepareMirrors: noSystemMirrors,
      });
      assert.equal(result.state, "ready");
      const cache = await lstat(
        path.join(f.root, ".checktrail/playwright-browsers"),
      );
      assert.ok(cache.isDirectory());
      assert.equal(cache.mode & 0o777, 0o755);
    } else {
      await assert.rejects(
        browser.preparePlaywrightBrowser(f.root),
        /Unsupported browser acquisition owner platform/u,
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("a terminal wrapper followed by extra progress is incomplete acquisition output", () => {
  assert.equal(
    browser.isTransientAptDnsFailure(
      terminal({
        output:
          transientOutput +
          "\nIgn:3 https://archive.ubuntu.com/ubuntu synthetic InRelease",
      }),
    ),
    false,
  );
});

test("native CLI enforces actual ownership and gives admitted children a readable-file umask", async () => {
  const f = await profile(
    "process.stdout.write(JSON.stringify({mask:process.umask(),version:process.version,args:process.argv.slice(2)})+'\\n');\n",
  );
  try {
    const script = path.join(
      repository,
      "scripts/prepare-playwright-browser.mjs",
    );
    const launch =
      "process.umask(0o077);process.argv=[process.execPath," +
      JSON.stringify(script) +
      "];await import(" +
      JSON.stringify(pathToFileURL(script).href) +
      ");";
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", launch],
      {
        cwd: f.root,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          RUNNER_ENVIRONMENT: "synthetic",
        },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1048576,
      },
    );
    assert.equal(result.signal, null);
    const admitted =
      process.platform === "darwin" ||
      (process.platform === "linux" &&
        process.getuid?.() === 0 &&
        process.geteuid?.() === 0);
    if (admitted) {
      assert.equal(result.status, 0, result.stderr);
      const first = JSON.parse(result.stdout.split("\n")[0]!);
      assert.deepEqual(first, {
        mask: 0o022,
        version: process.version,
        args: ["install", "chromium", "--only-shell", "--with-deps"],
      });
      assert.equal(
        (await lstat(path.join(f.root, ".checktrail/playwright-browsers")))
          .mode & 0o777,
        0o755,
      );
    } else {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /root-owned helper|effective root|Unsupported browser acquisition owner platform/u,
      );
      assert.equal(result.stdout, "");
    }
  } finally {
    await f.cleanup();
  }
});

test("qualified browser graph validation precedes mirror modification and CLI execution follows the scoped update", async () => {
  const f = await profile();
  const marker = path.join(f.root, "synthetic-mirror-state");
  await writeFile(marker, "original");
  const order: string[] = [];
  const metadata = {
    schemaVersion: 1,
    state: "prepared",
    reason: null,
    sourceCount: 1,
    targetCount: 1,
    changedCount: 1,
    restoredCount: 0,
    hashes: [],
  };
  const prepareMirrors = async () => {
    order.push("prepare");
    await writeFile(marker, "prepared");
    return {
      metadata,
      restore: async () => {
        order.push("restore");
        await writeFile(marker, "original");
        return { ...metadata, state: "restored", restoredCount: 1 };
      },
    };
  };
  try {
    const source = path.join(f.root, "scripts/playwright-tools/package.json");
    const original = await readFile(source);
    const invalid = JSON.parse(original.toString());
    invalid.dependencies["@playwright/test"] = "^0.0.0";
    await writeFile(source, JSON.stringify(invalid));
    await assert.rejects(
      browser.preparePlaywrightBrowser(f.root, {
        prepareMirrors,
        run: async () => {
          assert.fail("Invalid fixture must not execute CLI");
        },
      }),
      /pinned/u,
    );
    assert.equal(order.length, 0);
    assert.equal(await readFile(marker, "utf8"), "original");
    await writeFile(source, original);
    const result = await browser.preparePlaywrightBrowser(f.root, {
      prepareMirrors,
      run: async () => {
        order.push("cli");
        assert.equal(await readFile(marker, "utf8"), "prepared");
        return success();
      },
    });
    assert.equal(result.state, "ready");
    assert.equal(result.mirrorPreparation.state, "restored");
    assert.deepEqual(order, ["prepare", "cli", "restore"]);
    assert.equal(await readFile(marker, "utf8"), "original");
  } finally {
    await f.cleanup();
  }
});

for (const mode of ["failure", "cancel"])
  test(
    "scoped mirror state is restored after executor completion: " + mode,
    async () => {
      const f = await profile();
      const abort = new AbortController();
      let closed = false,
        restores = 0;
      try {
        const metadata = { state: "prepared" };
        const operation = browser.preparePlaywrightBrowser(f.root, {
          signal: abort.signal,
          prepareMirrors: async () => ({
            metadata,
            restore: async () => {
              assert.equal(
                closed,
                true,
                "Restore must follow owned executor completion",
              );
              restores++;
              return { state: "restored" };
            },
          }),
          run: async () => {
            closed = true;
            if (mode === "throw") throw Error("synthetic executor failure");
            if (mode === "cancel") abort.abort();
            return terminal({
              output: "E: synthetic terminal package failure",
              canceled: mode === "cancel",
            });
          },
        });
        if (mode === "throw")
          await assert.rejects(operation, /synthetic executor failure/u);
        else {
          const result = await operation;
          assert.equal(result.state, "failed");
          assert.equal(result.mirrorPreparation.state, "restored");
        }
        assert.equal(restores, 1);
      } finally {
        await f.cleanup();
      }
    },
  );

test("an incomplete mirror restoration prevents a healthy CLI result from passing", async () => {
  const f = await profile();
  let calls = 0;
  try {
    const result = await browser.preparePlaywrightBrowser(f.root, {
      prepareMirrors: async () => ({
        metadata: { state: "prepared" },
        restore: async () => ({
          state: "failed",
          reason: "restoration-incomplete",
        }),
      }),
      run: async () => {
        calls++;
        return success();
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.attempts[0].passed, true);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "mirror-restoration-failed");
  } finally {
    await f.cleanup();
  }
});

test("injected acquisition runners never select the real system-mirror component", async () => {
  const f = await profile();
  try {
    const result = await browser.preparePlaywrightBrowser(f.root, {
      run: async () => success(),
    });
    assert.equal(result.state, "ready");
    assert.equal(result.mirrorPreparation.state, "not-applicable");
    assert.equal(result.mirrorPreparation.reason, "injected-runner");
    assert.equal(result.mirrorPreparation.changedCount, 0);
  } finally {
    await f.cleanup();
  }
});

test("failed mirror preparation prevents CLI execution and remains an explicit acquisition failure", async () => {
  const f = await profile();
  let calls = 0,
    restores = 0;
  try {
    const failed = { state: "failed", reason: "unsafe-metadata" };
    const result = await browser.preparePlaywrightBrowser(f.root, {
      prepareMirrors: async () => ({
        metadata: failed,
        restore: async () => {
          restores++;
          return failed;
        },
      }),
      run: async () => {
        calls++;
        return success();
      },
    });
    assert.equal(calls, 0);
    assert.equal(restores, 1);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "mirror-preparation-failed");
    assert.deepEqual(result.attempts, []);
  } finally {
    await f.cleanup();
  }
});

test("an unverified native cleanup rejection cannot authorize mirror restoration or retry", async () => {
  const f = await profile();
  let restores = 0,
    abandoned = 0,
    calls = 0;
  try {
    const result = await browser.preparePlaywrightBrowser(f.root, {
      prepareMirrors: async () => ({
        metadata: { state: "prepared" },
        restore: async () => {
          restores++;
          return { state: "restored" };
        },
        abandon: async () => {
          abandoned++;
          return { state: "failed", reason: "quiescence-unverified" };
        },
      }),
      run: async () => {
        calls++;
        return terminal({ error: "Process cleanup deadline exceeded" });
      },
    });
    assert.equal(calls, 1);
    assert.equal(restores, 0);
    assert.equal(abandoned, 1);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "mirror-quiescence-unverified");
    assert.equal(result.mirrorPreparation.state, "failed");
  } finally {
    await f.cleanup();
  }
});

test("an executor exception without a verified terminal retains failed scope metadata without rollback", async () => {
  const f = await profile();
  let restores = 0,
    abandoned = 0;
  try {
    await assert.rejects(
      browser.preparePlaywrightBrowser(f.root, {
        prepareMirrors: async () => ({
          metadata: { state: "prepared" },
          restore: async () => {
            restores++;
            return { state: "restored" };
          },
          abandon: async () => {
            abandoned++;
            return { state: "failed", reason: "quiescence-unverified" };
          },
        }),
        run: async () => {
          throw Error("synthetic executor rejection");
        },
      }),
      (error) => {
        assert.match((error as Error).message, /synthetic executor rejection/u);
        assert.equal(
          (error as Error & { mirrorPreparation: { state: string } })
            .mirrorPreparation.state,
          "failed",
        );
        return true;
      },
    );
    assert.equal(restores, 0);
    assert.equal(abandoned, 1);
  } finally {
    await f.cleanup();
  }
});
