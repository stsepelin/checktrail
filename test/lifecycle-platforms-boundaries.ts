import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { projectReport } from "../src/output.js";
import { reportSchema, reportSummarySchema } from "../src/schemas.js";
import {
  lifecycleCanary,
  lifecycleExecute,
  lifecycleProject,
  validateLifecycleProject,
} from "./lifecycle-platforms-fixture.js";
const execute = promisify(execFile);
const cli = fileURLToPath(
  new URL("./cli.js", import.meta.resolve("../src/engine.js")),
);
const secretName = "CHECKTRAIL_LIFECYCLE_SYNTHETIC_SECRET";
const secret = "original-lifecycle-unlisted-environment-37c2";
const environment = () => ({
  ...getDefaultEnvironment(),
  ...Object.fromEntries(
    ["TMPDIR", "TMP", "TEMP"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]],
    ),
  ),
  [secretName]: secret,
});
function summary(value: unknown, root: string) {
  const parsed = reportSummarySchema.parse(value);
  assert.equal(parsed.outcome, "failed");
  const text = JSON.stringify(parsed);
  for (const denied of [
    root,
    lifecycleCanary,
    secret,
    "capturedOutput",
    "nativeJournal",
    "base64",
    "quota.test.js",
  ])
    assert.equal(text.includes(denied), false, denied);
  return parsed;
}
export async function lifecyclePrivacy(t: TestContext) {
  const previous = process.env[secretName],
    clients: Client[] = [];
  process.env[secretName] = secret;
  try {
    const local = await validateLifecycleProject(t, { broken: true });
    assert.equal(JSON.stringify(local.report).includes(lifecycleCanary), true);
    assert.equal(JSON.stringify(local.report).includes(secret), false);
    summary(projectReport(local.report, false), local.project.root);
    const denied = await lifecycleProject(t);
    await assert.rejects(
      execute(process.execPath, [cli, "run", "--root", denied.root], {
        env: environment(),
        timeout: 60000,
      }),
      (error: unknown) => {
        assert.equal((error as { code: unknown }).code, 2);
        return true;
      },
    );
    await assert.rejects(access(denied.marker), { code: "ENOENT" });
    for (const detailed of [false, true]) {
      const d = await lifecycleProject(t, { broken: true });
      const observed = await lifecycleExecute(d, async (signal) => {
        try {
          await execute(
            process.execPath,
            [
              cli,
              "run",
              "--root",
              d.root,
              "--trust-project",
              ...(detailed ? ["--detailed"] : []),
            ],
            {
              signal,
              env: environment(),
              timeout: 60000,
              maxBuffer: 2 * 1048576,
            },
          );
          assert.fail("The original failing quota must return CLI status 1");
        } catch (error) {
          const failed = error as {
            code: unknown;
            stdout: string;
            stderr: string;
          };
          assert.equal(failed.code, 1);
          assert.equal((failed.stdout + failed.stderr).includes(secret), false);
          return JSON.parse(failed.stdout) as unknown;
        }
      });
      if (detailed) {
        const report = reportSchema.parse(observed.value);
        assert.equal(report.outcome, "failed");
        assert.equal(report.checks[0]!.tests!.failed, 1);
        assert.equal(JSON.stringify(report).includes(lifecycleCanary), true);
      } else summary(observed.value, d.root);
    }
    async function connect(root: string, args: string[]) {
      const client = new Client(
        { name: "original-lifecycle-host", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      clients.push(client);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root, ...args],
        env: environment(),
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => {});
      await client.connect(transport);
      return client;
    }
    const refused = await lifecycleProject(t),
      readOnly = await connect(refused.root, []);
    for (const args of [{}, { trusted: true }, { allowExecution: true }]) {
      const response = await readOnly.callTool({
        name: "validation_run",
        arguments: args,
      });
      assert.equal(response.isError, true);
    }
    await assert.rejects(access(refused.marker), { code: "ENOENT" });
    for (const detailed of [false, true]) {
      const d = await lifecycleProject(t, { broken: true }),
        client = await connect(d.root, [
          "--allow-execution",
          ...(detailed ? ["--detailed"] : []),
        ]);
      const observed = await lifecycleExecute(d, async (signal) => {
        const close = () => {
          void client.close();
        };
        signal.addEventListener("abort", close, { once: true });
        try {
          return await client.callTool({
            name: "validation_run",
            arguments: {},
          });
        } finally {
          signal.removeEventListener("abort", close);
        }
      });
      assert.equal(observed.value.isError, undefined);
      assert.equal(JSON.stringify(observed.value).includes(secret), false);
      if (detailed) {
        const report = reportSchema.parse(observed.value.structuredContent);
        assert.equal(report.outcome, "failed");
        assert.equal(report.checks[0]!.tests!.failed, 1);
        assert.equal(JSON.stringify(report).includes(lifecycleCanary), true);
      } else summary(observed.value.structuredContent, d.root);
    }
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
    const closed = await Promise.allSettled(
      clients.map((client) => client.close()),
    );
    assert.deepEqual(
      closed.map((result) => result.status),
      clients.map(() => "fulfilled"),
    );
  }
}
