import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, cp } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
import { validate } from "../src/engine.js";
import { reportSchema } from "../src/schemas.js";
const vendor = fileURLToPath(
  new URL("../../.checktrail/php-review-tools/vendor", import.meta.url),
);
const available = await access(path.join(vendor, "autoload.php")).then(
  () => spawnSync("php", ["--version"], { timeout: 10000 }).status === 0,
  () => false,
);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const cacheNames = [
  "APP_PACKAGES_CACHE",
  "APP_SERVICES_CACHE",
  "APP_CONFIG_CACHE",
  "APP_ROUTES_CACHE",
];
async function connect(root: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [cli, "serve", "--root", root, ...args],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  let stopped = false;
  let sequence = 0;
  let stderr = "";
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  child.stderr.on("data", (b) => {
    stderr = (stderr + String(b)).slice(-4096);
  });
  const lines = createInterface({ input: child.stdout });
  child.on("exit", () => {
    stopped = true;
    for (const entry of pending.values())
      entry.reject(new Error(`Server exited: ${stderr}`));
    pending.clear();
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.id === "number") {
      pending.get(value.id)?.resolve(value);
      pending.delete(value.id);
    }
  });
  return {
    async request(name: string, arguments_: Record<string, unknown> = {}) {
      const id = sequence++;
      const timer = setTimeout(() => {
        pending.get(id)?.reject(new Error(`Tool timeout: ${stderr}`));
        pending.delete(id);
      }, 30000);
      try {
        const result = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                  name,
                  arguments: arguments_,
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                },
              }) + "\n",
            );
          },
        );
        assert.equal(result.error, undefined);
        return result.result as {
          isError?: boolean;
          structuredContent?: unknown;
        };
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (!stopped) child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        await exit;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}
test(
  "PHP review profiles share native CLI and MCP outcomes with startup-only trust environment and summary privacy",
  {
    skip: available ? false : "Pinned PHP review runtime unavailable",
    timeout: 120000,
  },
  async (t) => {
    for (const id of ["php.php-cs-fixer", "php.phpstan"]) {
      const larastan = id === "php.phpstan";
      const root = await fixture(t, {
        "composer.json": "{}",
        "checktrail.json": JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: [id],
              ...(larastan ? { environment: cacheNames } : {}),
            },
          ],
        }),
        "Subject.php": larastan
          ? "<?php\nuse Illuminate\\Database\\Eloquent\\Model;\nuse Illuminate\\Database\\Eloquent\\Casts\\Attribute;\nclass SyntheticModel extends Model {\n/** @return Attribute<int, never> */\nprotected function amount(): Attribute { return Attribute::make(get: fn (): int => 42); }\n}\nfunction amount(SyntheticModel $model): string { return $model->amount; }\n"
          : "<?php function amount(): int {return 42;}\n",
        ...(larastan
          ? {
              "phpstan.neon":
                "includes:\n    - vendor/larastan/larastan/extension.neon\nparameters:\n    level: 5\n    disableMigrationScan: true\n    disableSchemaScan: true\n    enableMigrationCache: false\n",
              "bootstrap/app.php":
                "<?php return Illuminate\\Foundation\\Application::configure(basePath: dirname(__DIR__))->withExceptions()->create();\n",
              "bootstrap/providers.php": "<?php return [];\n",
            }
          : {
              ".php-cs-fixer.php":
                "<?php return (new PhpCsFixer\\Config())->setRules(['braces_position'=>true])->setFinder(PhpCsFixer\\Finder::create()->in(__DIR__));\n",
            }),
        ".checktrail/keep": "",
      });
      await cp(vendor, path.join(root, "vendor"), { recursive: true });
      const environment = larastan
        ? Object.fromEntries(
            cacheNames.map((name, i) => [
              name,
              path.join(root, `.checktrail/cache-${i}.php`),
            ]),
          )
        : {};
      const env = { ...process.env, ...environment };
      const grants = Object.keys(environment).flatMap((name) => [
        "--allow-env",
        name,
      ]);
      const native = await validate(root, { trusted: true, environment });
      assert.equal(native.outcome, "failed", JSON.stringify(native.checks));
      assert.equal(native.sourceChanged, false);
      assert.equal(native.checks[0]!.findingsComplete, true);
      const output = spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          "--trust-project",
          "--detailed",
          ...grants,
        ],
        { env, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(output.status, 1, output.stderr);
      const detailed = reportSchema.parse(JSON.parse(output.stdout));
      assert.equal(detailed.outcome, native.outcome);
      assert.deepEqual(
        detailed.checks[0]!.findings,
        native.checks[0]!.findings,
      );
      const denied = spawnSync(
        process.execPath,
        [cli, "run", "--root", root, ...grants],
        { env, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(denied.status, 2);
      assert.match(denied.stderr, /trust/);
      const server = await connect(root, ["--allow-execution", ...grants], env);
      try {
        const result = await server.request("validation_run");
        assert.notEqual(result.isError, true);
        const summary = result.structuredContent as {
          outcome: string;
          checks: { id: string; status: string }[];
        };
        assert.equal(summary.outcome, native.outcome);
        assert.equal(summary.checks[0]!.id, id);
        assert.equal(summary.checks[0]!.status, native.checks[0]!.status);
        const bytes = JSON.stringify(result);
        assert.ok(
          !bytes.includes(root) &&
            !bytes.includes("Subject.php") &&
            !bytes.includes("return 42"),
        );
        assert.equal(
          (await server.request("validation_run", { trusted: true })).isError,
          true,
        );
      } finally {
        await server.close();
      }
      const untrusted = await connect(root, grants, env);
      try {
        assert.equal((await untrusted.request("validation_run")).isError, true);
      } finally {
        await untrusted.close();
      }
    }
  },
);
