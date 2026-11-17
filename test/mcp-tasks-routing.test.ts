import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "./helpers.js";

// Fixture dependencies may be explicitly aliased by the fresh harness. Resolve
// inside their actual root; hoisted and nested packages still need exact locks.
async function requirePinnedClientCore(
  root: string,
  lock: { packages: Record<string, { version: string }> },
) {
  const nodeModules = await realpath(path.join(root, "node_modules"));
  const clientManifestFile = await realpath(
    path.join(nodeModules, "@modelcontextprotocol/client/package.json"),
  );
  const clientManifest = JSON.parse(await readFile(clientManifestFile, "utf8"));
  const require = createRequire(clientManifestFile);
  let directory = path.dirname(
    await realpath(require.resolve("@modelcontextprotocol/core")),
  );
  let clientCore: { name: string; version: string } | undefined;
  let clientCoreLocation: string | undefined;
  for (let depth = 0; depth < 16; depth++) {
    const relative = path.relative(nodeModules, directory);
    assert.ok(
      relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative),
    );
    try {
      const metadata = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      );
      if (metadata.name === "@modelcontextprotocol/core") {
        clientCore = metadata;
        clientCoreLocation =
          "node_modules/" +
          path.relative(nodeModules, directory).split(path.sep).join("/");
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  assert.ok(clientCore && clientCoreLocation);
  assert.equal(
    clientCore.version,
    clientManifest.dependencies["@modelcontextprotocol/core"],
  );
  assert.equal(lock.packages[clientCoreLocation]?.version, clientCore.version);
  return { version: clientCore.version, location: clientCoreLocation };
}

test("published official SDK routes standard Tasks get cancel and update without transport interception", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const lock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const selected = JSON.parse(
    await readFile(
      new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    manifest.dependencies["@modelcontextprotocol/server"],
    selected.toolVersions["mcp-sdk"],
    "SDK candidate pin must match the exact production dependency",
  );
  for (const name of ["server", "client", "core"]) {
    const installed = JSON.parse(
      await readFile(
        new URL(
          `../../node_modules/@modelcontextprotocol/${name}/package.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(installed.name, "@modelcontextprotocol/" + name);
    if (name !== "core")
      assert.equal(
        installed.version,
        (name === "client" ? manifest.devDependencies : manifest.dependencies)[
          "@modelcontextprotocol/" + name
        ],
      );
    assert.equal(
      lock.packages[`node_modules/@modelcontextprotocol/${name}`].version,
      installed.version,
    );
  }
  await requirePinnedClientCore(root, lock);
  const probe = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/probe-mcp-tasks.mjs", import.meta.url),
      ),
    ],
    { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  );
  assert.equal(probe.status, 0, probe.stderr + probe.stdout);
  assert.equal(probe.signal, null);
  assert.deepEqual(JSON.parse(probe.stdout), {
    protocol: "2026-07-28",
    probe: "extension method routing only",
    results: ["tasks/get", "tasks/cancel", "tasks/update"].map((method) => ({
      method,
      handlerReached: true,
      errorCode: null,
    })),
  });
});

const syntheticClient = JSON.stringify({
  name: "@modelcontextprotocol/client",
  version: "2.4.0",
  dependencies: { "@modelcontextprotocol/core": "2.4.0" },
});
const syntheticCore = JSON.stringify({
  name: "@modelcontextprotocol/core",
  version: "2.4.0",
  main: "index.js",
});
const inertCore =
  "throw new Error('SDK metadata resolution must not execute package code');\n";

test("SDK lock identity accepts an explicit fixture dependency-root alias without executing SDK code", async (t) => {
  const root = await fixture(t, {
    "canonical/node_modules/@modelcontextprotocol/client/package.json":
      syntheticClient,
    "canonical/node_modules/@modelcontextprotocol/core/package.json":
      syntheticCore,
    "canonical/node_modules/@modelcontextprotocol/core/index.js": inertCore,
  });
  const alias = path.join(root, "alias");
  await mkdir(alias);
  await symlink(
    path.join(root, "canonical/node_modules"),
    path.join(alias, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const lock = {
    packages: {
      "node_modules/@modelcontextprotocol/core": { version: "2.4.0" },
    },
  };
  assert.deepEqual(
    await requirePinnedClientCore(alias, lock),
    await requirePinnedClientCore(path.join(root, "canonical"), lock),
  );
});

test("SDK lock identity refuses a core resolved outside the physical fixture dependency root", async (t) => {
  const root = await fixture(t, {
    "node_modules/@modelcontextprotocol/client/package.json": syntheticClient,
    "node_modules-adjacent/core/package.json": syntheticCore,
    "node_modules-adjacent/core/index.js": inertCore,
  });
  await symlink(
    path.join(root, "node_modules-adjacent/core"),
    path.join(root, "node_modules/@modelcontextprotocol/core"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    requirePinnedClientCore(root, {
      packages: {
        "node_modules/@modelcontextprotocol/core": { version: "2.4.0" },
      },
    }),
    { code: "ERR_ASSERTION" },
  );
  if (!process.execArgv.includes("--preserve-symlinks")) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const preserved = spawnSync(
      process.execPath,
      [
        "--preserve-symlinks",
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^SDK lock identity refuses a core resolved outside the physical fixture dependency root$",
        fileURLToPath(import.meta.url),
      ],
      { env, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(preserved.status, 0, preserved.stderr + preserved.stdout);
    assert.match(
      preserved.stdout,
      /^ok \d+ - SDK lock identity refuses a core resolved outside the physical fixture dependency root$/m,
    );
  }
});

test("SDK lock identity refuses wrong nested identities even when a matching hoisted pin exists", async (t) => {
  const root = await fixture(t, {
    "node_modules/@modelcontextprotocol/client/package.json": syntheticClient,
    "node_modules/@modelcontextprotocol/client/node_modules/@modelcontextprotocol/core/package.json":
      syntheticCore,
    "node_modules/@modelcontextprotocol/client/node_modules/@modelcontextprotocol/core/index.js":
      inertCore,
  });
  const nested =
    "node_modules/@modelcontextprotocol/client/node_modules/@modelcontextprotocol/core";
  for (const version of [undefined, "2.4.1"])
    await assert.rejects(
      requirePinnedClientCore(root, {
        packages: {
          "node_modules/@modelcontextprotocol/core": { version: "2.4.0" },
          ...(version ? { [nested]: { version } } : {}),
        },
      }),
      { code: "ERR_ASSERTION" },
    );
  assert.deepEqual(
    await requirePinnedClientCore(root, {
      packages: { [nested]: { version: "2.4.0" } },
    }),
    { version: "2.4.0", location: nested },
  );
});
