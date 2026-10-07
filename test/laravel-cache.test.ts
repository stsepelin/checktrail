import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  access,
  cp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
const vendor = fileURLToPath(
  new URL("../../.checktrail/laravel-tools/vendor", import.meta.url),
);
const example = fileURLToPath(
  new URL("../../examples/frameworks/laravel/", import.meta.url),
);
const available = await access(path.join(vendor, "autoload.php")).then(
  () => spawnSync("php", ["--version"], { timeout: 10000 }).status === 0,
  () => false,
);
interface Ready {
  token: string;
  phase: string;
  pid: number;
  directory: string;
  parent: string;
  environment: string;
  dotenvProbe: unknown;
}
async function project(t: TestContext, mode: string) {
  const token = randomUUID();
  const root = await fixture(t, {
    ".checktrail/ready.json": "",
    ".checktrail/go": "",
    "original-target.txt": "original target survives cache cleanup",
    ".env": "SYNTHETIC_DOTENV_PROBE=original-do-not-load\n",
    "bootstrap/cache/config.php":
      "<?php throw new RuntimeException('original stale config must not load');",
    "bootstrap/cache/routes-v7.php":
      "<?php throw new RuntimeException('original stale routes must not load');",
  });
  await cp(example, root, { recursive: true });
  await cp(vendor, path.join(root, "vendor"), { recursive: true });
  const bootstrap = await readFile(
    path.join(root, "bootstrap/app.php"),
    "utf8",
  );
  assert.equal(bootstrap.split("return Application::configure").length, 2);
  await writeFile(
    path.join(root, "bootstrap/app.php"),
    bootstrap.replace(
      "return Application::configure",
      "$app = Application::configure",
    ) +
      `
$app->booted(function () use ($app) {
    $directory = dirname($app->getCachedConfigPath());
    file_put_contents($directory.'/original-owned.php', '<?php return "original";');
    mkdir($directory.'/nested', 0700);
    file_put_contents($directory.'/nested/owned.php', '<?php return "nested original";');
    symlink(base_path('original-target.txt'), $directory.'/target-link');
    file_put_contents(base_path('.checktrail/ready.json'), json_encode(['token' => '${token}', 'phase' => 'framework-booted', 'pid' => getmypid(), 'directory' => $directory, 'parent' => dirname($directory), 'environment' => $app->environment(), 'dotenvProbe' => env('SYNTHETIC_DOTENV_PROBE')], JSON_THROW_ON_ERROR));
    if ('${mode}' === 'error') throw new RuntimeException('original reached bootstrap failure');
    if ('${mode}' === 'normal') return;
    while (!file_exists(base_path('.checktrail/go')) || file_get_contents(base_path('.checktrail/go')) !== 'go') usleep(10000);
    if ('${mode}' === 'output') while (true) fwrite(STDOUT, str_repeat('original-output', 8192));
    while (true) usleep(10000);
});
return $app;
`,
  );
  return { root: await realpath(root), token };
}
async function ready(
  root: string,
  token: string,
  deadlineMs = 10000,
): Promise<Ready> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const text = await readFile(
      path.join(root, ".checktrail/ready.json"),
      "utf8",
    );
    try {
      const value = JSON.parse(text) as Ready;
      if (value.token === token && value.phase === "framework-booted")
        return value;
    } catch {
      /* Wait for complete bytes. */
    }
    await delay(10);
  }
  assert.fail(
    "Original native Laravel boot callback did not publish complete readiness",
  );
}
async function absent(directory: string) {
  await assert.rejects(access(directory), { code: "ENOENT" });
}
function retainCleanup(t: TestContext, observation: Ready) {
  // Only this original fixture's cache directory; never delete its parent from a receipt.
  t.after(() => rm(observation.directory, { recursive: true, force: true }));
}
function owned(observation: Ready) {
  assert.ok(Number.isSafeInteger(observation.pid) && observation.pid > 1);
  assert.equal(path.basename(observation.directory), "laravel-cache");
  assert.match(
    path.basename(observation.parent),
    /^checktrail-command-[A-Za-z0-9]{6}$/,
  );
  assert.equal(observation.environment, "testing");
  assert.equal(observation.dotenvProbe, null);
  assert.equal(path.dirname(observation.directory), observation.parent);
}

test("Laravel cache planning selects shared runner ownership without running project bootstrap or autoload", async (t) => {
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["php.laravel-runtime"] }],
    }),
    "checktrail.laravel.json": JSON.stringify({
      schemaVersion: 1,
      assembly: "original",
      environment: "testing",
    }),
    "bootstrap/app.php":
      "<?php throw new RuntimeException('must not execute');",
    "vendor/autoload.php":
      "<?php throw new RuntimeException('must not execute');",
  });
  const planned = await createPlan(root);
  assert.equal(planned.plan.checks[0]!.commands[0]!.temporaryDirectory, true);
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  const supplied = await createPlan(root, {
    environment: { CHECKTRAIL_TEMP: "project-selected" },
  });
  assert.equal(supplied.plan.checks[0]!.commands[0]!.temporaryDirectory, true);
  assert.equal(
    supplied.plan.checks[0]!.commands[0]!.env?.CHECKTRAIL_TEMP,
    undefined,
  );
});

test(
  "native Laravel forced PHP termination after boot removes cache files and the shared owned parent",
  {
    skip: available ? false : "PHP or prepared Laravel unavailable",
    timeout: 60000,
  },
  async (t) => {
    const { root, token } = await project(t, "hang");
    const controller = new AbortController();
    const running = validate(root, {
      trusted: true,
      signal: controller.signal,
      timeoutMs: 20000,
    });
    try {
      const observed = await ready(root, token);
      retainCleanup(t, observed);
      owned(observed);
      assert.equal(
        await readFile(
          path.join(observed.directory, "original-owned.php"),
          "utf8",
        ),
        '<?php return "original";',
      );
      process.kill(observed.pid, 0);
      process.kill(observed.pid, "SIGKILL");
      const report = await running;
      assert.notEqual(report.outcome, "passed");
      assert.equal(report.sourceChanged, false);
      assert.ok(
        report.checks[0]!.processes.some(
          (process) => process.signal === "SIGKILL",
        ),
      );
      await absent(observed.directory);
      await absent(observed.parent);
      assert.equal(
        await readFile(path.join(root, "original-target.txt"), "utf8"),
        "original target survives cache cleanup",
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(path.join(root, ".checktrail/ready.json"), "utf8"),
        ),
        observed,
      );
    } finally {
      controller.abort();
      await running;
    }
  },
);

test(
  "native Laravel reached cancellation deadline and output exhaustion remove every owned cache without reporting pass",
  {
    skip: available ? false : "PHP or prepared Laravel unavailable",
    timeout: 90000,
  },
  async (t) => {
    for (const mode of ["cancel", "deadline", "output"]) {
      const { root, token } = await project(t, mode);
      const controller = new AbortController();
      const running = validate(root, {
        trusted: true,
        signal: controller.signal,
        timeoutMs: mode === "deadline" ? 5000 : 20000,
      });
      try {
        const observed = await ready(
          root,
          token,
          mode === "deadline" ? 4500 : 10000,
        );
        retainCleanup(t, observed);
        owned(observed);
        assert.equal(
          await readFile(
            path.join(observed.directory, "original-owned.php"),
            "utf8",
          ),
          '<?php return "original";',
        );
        if (mode === "cancel") controller.abort();
        else if (mode === "output")
          await writeFile(path.join(root, ".checktrail/go"), "go");
        const report = await running;
        assert.notEqual(report.outcome, "passed");
        assert.equal(report.sourceChanged, false);
        const property =
          mode === "cancel"
            ? "cancelled"
            : mode === "deadline"
              ? "timedOut"
              : "truncated";
        assert.ok(
          report.checks[0]!.processes.some((process) => process[property]),
          JSON.stringify(report.checks[0]),
        );
        await absent(observed.directory);
        await absent(observed.parent);
        assert.equal(
          await readFile(path.join(root, "original-target.txt"), "utf8"),
          "original target survives cache cleanup",
        );
      } finally {
        controller.abort();
        await running;
      }
    }
  },
);

test(
  "native Laravel normal and reached bootstrap error paths preserve project caches and clean owned cache parents",
  {
    skip: available ? false : "PHP or prepared Laravel unavailable",
    timeout: 60000,
  },
  async (t) => {
    for (const mode of ["normal", "error"]) {
      const { root, token } = await project(t, mode);
      const report = await validate(root, { trusted: true, timeoutMs: 20000 });
      const observed = await ready(root, token);
      retainCleanup(t, observed);
      owned(observed);
      assert.equal(report.sourceChanged, false);
      if (mode === "normal")
        assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      else {
        assert.notEqual(report.outcome, "passed");
        assert.ok(
          report.checks[0]!.processes.some(
            (process) =>
              process.exitCode === 2 &&
              process.stderr.includes("original reached bootstrap failure"),
          ),
        );
      }
      await absent(observed.directory);
      await absent(observed.parent);
      assert.equal(
        await readFile(path.join(root, "original-target.txt"), "utf8"),
        "original target survives cache cleanup",
      );
    }
  },
);

test(
  "native Laravel owned cache accepts a canonical temporary-parent alias without loading dotenv or deleting link targets",
  {
    skip: available ? false : "PHP or prepared Laravel unavailable",
    timeout: 60000,
  },
  async (t) => {
    const { root, token } = await project(t, "normal");
    const destination = await realpath(await fixture(t, {}));
    const aliasRoot = await realpath(await fixture(t, {}));
    const alias = path.join(aliasRoot, "original-temp-alias");
    await symlink(destination, alias, "dir");
    const engine = pathToFileURL(
      fileURLToPath(new URL("../src/engine.js", import.meta.url)),
    ).href;
    const program = `import { validate } from ${JSON.stringify(engine)}; const report = await validate(process.argv[1], { trusted: true, timeoutMs: 20000 }); process.stdout.write(JSON.stringify(report));`;
    const execution = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", program, root],
      {
        env: { ...process.env, TMPDIR: alias },
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    const report = JSON.parse(execution.stdout);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    const observed = await ready(root, token);
    retainCleanup(t, observed);
    owned(observed);
    assert.equal(path.dirname(observed.parent), destination);
    await absent(observed.directory);
    await absent(observed.parent);
    assert.equal(
      await readFile(path.join(root, "original-target.txt"), "utf8"),
      "original target survives cache cleanup",
    );
  },
);

test(
  "native Laravel CLI and MCP reached forced termination share owned cache cleanup and startup-only execution trust",
  {
    skip: available ? false : "PHP or prepared Laravel unavailable",
    timeout: 90000,
  },
  async (t) => {
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    for (const surface of ["cli", "mcp"]) {
      const { root, token } = await project(t, "hang");
      const child = spawn(
        process.execPath,
        [
          cli,
          surface === "cli" ? "run" : "serve",
          "--root",
          root,
          ...(surface === "cli"
            ? ["--trust-project", "--detailed"]
            : ["--allow-execution"]),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const exit = once(child, "exit");
      let output = "",
        error = "";
      child.stderr.on("data", (bytes) => {
        error = (error + String(bytes)).slice(-4096);
      });
      child.stdout.on("data", (bytes) => {
        output += String(bytes);
      });
      const lines =
        surface === "mcp"
          ? createInterface({ input: child.stdout })
          : undefined;
      const result =
        surface === "mcp"
          ? new Promise<Record<string, unknown>>((resolve, reject) => {
              lines!.on("line", (line) => {
                const message = JSON.parse(line) as {
                  id?: number;
                  error?: unknown;
                  result?: Record<string, unknown>;
                };
                if (message.id !== 1) return;
                if (message.error)
                  reject(new Error(JSON.stringify(message.error)));
                else resolve(message.result!);
              });
              child.on("exit", () =>
                reject(new Error("MCP exited before result: " + error)),
              );
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: {
                    name: "validation_run",
                    arguments: {},
                    _meta: {
                      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                      "io.modelcontextprotocol/clientCapabilities": {},
                    },
                  },
                }) + "\n",
              );
            })
          : undefined;
      void result?.catch(() => undefined);
      const emergency = setTimeout(() => child.kill("SIGKILL"), 30000);
      try {
        const observed = await ready(root, token);
        retainCleanup(t, observed);
        owned(observed);
        process.kill(observed.pid, "SIGKILL");
        if (surface === "cli") {
          const [code] = await exit;
          assert.equal(code, 2, error);
          const report = JSON.parse(output);
          assert.equal(report.outcome, "incomplete");
          assert.equal(report.sourceChanged, false);
          assert.ok(
            report.checks[0].processes.some(
              (p: { signal: string }) => p.signal === "SIGKILL",
            ),
          );
        } else {
          const response = await result!;
          assert.notEqual(response.isError, true);
          const summary = response.structuredContent as {
            outcome: string;
            checks: { id: string; status: string }[];
          };
          assert.notEqual(summary.outcome, "passed");
          assert.equal(summary.checks[0]!.id, "php.laravel-runtime");
          assert.notEqual(summary.checks[0]!.status, "passed");
          const bytes = JSON.stringify(response);
          for (const secret of [
            root,
            observed.directory,
            "original-owned.php",
            token,
          ])
            assert.equal(bytes.includes(secret), false);
        }
        await absent(observed.directory);
        await absent(observed.parent);
        assert.equal(
          await readFile(path.join(root, "original-target.txt"), "utf8"),
          "original target survives cache cleanup",
        );
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await exit;
        } finally {
          clearTimeout(timer);
          clearTimeout(emergency);
          lines?.close();
        }
      }
    }
    const { root } = await project(t, "normal");
    const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/);
    assert.equal(
      await readFile(path.join(root, ".checktrail/ready.json"), "utf8"),
      "",
    );
  },
);
