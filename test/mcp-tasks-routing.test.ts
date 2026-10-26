import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
  // Resolve from the actual client. npm may hoist a matching core or retain a
  // distinct nested version; the exact locked package remains the authority.
  const clientManifestFile = path.join(
    root,
    "node_modules/@modelcontextprotocol/client/package.json",
  );
  const clientManifest = JSON.parse(await readFile(clientManifestFile, "utf8"));
  const require = createRequire(clientManifestFile);
  let directory = path.dirname(require.resolve("@modelcontextprotocol/core"));
  let clientCore: { name: string; version: string } | undefined;
  let clientCoreLocation: string | undefined;
  for (let depth = 0; depth < 16; depth++) {
    const relative = path.relative(path.join(root, "node_modules"), directory);
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
        clientCoreLocation = path
          .relative(root, directory)
          .split(path.sep)
          .join("/");
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
  assert.equal(lock.packages[clientCoreLocation].version, clientCore.version);
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
