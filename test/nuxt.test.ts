import assert from "node:assert/strict";
import { access, cp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const tools = fileURLToPath(
  new URL("../../.repo-verifier/nuxt-tools/node_modules", import.meta.url),
);
const example = fileURLToPath(new URL("../../examples/nuxt", import.meta.url));
const available = await access(path.join(tools, "nuxt/package.json")).then(
  () => true,
  () => false,
);
const skip = available ? false : "Prepared Nuxt runtime unavailable";
async function project(t: TestContext, prepared = true) {
  const root = await fixture(t, {});
  await cp(example, root, { recursive: true });
  if (prepared)
    await cp(tools, path.join(root, "node_modules"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  return root;
}
test("Nuxt planning requires an explicit profile, inventoried config and prepared tools without evaluating Nuxt config", async (t) => {
  const root = await project(t, false);
  await writeFile(
    path.join(root, "nuxt.config.ts"),
    "throw new Error('configuration must not execute during planning');",
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /installed/,
  );
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  const config = JSON.parse(
    await readFile(path.join(root, "repo-verifier.nuxt.json"), "utf8"),
  );
  for (const change of [
    { environment: "production" },
    { extra: true },
    { probes: [] },
    { probes: [config.probes[0], config.probes[0]] },
  ]) {
    await writeFile(
      path.join(root, "repo-verifier.nuxt.json"),
      JSON.stringify({ ...config, ...change }),
    );
    await assert.rejects(createPlan(root));
  }
});
test(
  "native Nuxt SSR captures generated pages and async runtime registration, catches a changed contract and uncovered records",
  { skip, timeout: 120000 },
  async (t) => {
    const root = await project(t);
    const run = () => validate(root, { trusted: true, timeoutMs: 120000 });
    const good = await run();
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(good.checks[0]!.runtime!.collections[0]!.entries.length, 3);
    assert.equal(good.checks[0]!.findingsComplete, true);
    const module = path.join(root, "app/plugins/late.ts");
    const original = await readFile(module, "utf8");
    await writeFile(
      module,
      original.replace('name: "late"', 'name: "changed"'),
    );
    const broken = await run();
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.deepEqual(
      broken.checks[0]!.findings!.map((finding) => finding.ruleId),
      ["nuxt/probe-mismatch"],
    );
    await writeFile(
      module,
      original.replace(
        "app.$router.addRoute(",
        "app.$router.addRoute({path:'/hidden',name:'hidden',component:{render:()=>null}});\napp.$router.addRoute(",
      ),
    );
    const hidden = await run();
    assert.equal(hidden.outcome, "incomplete", JSON.stringify(hidden.checks));
    assert.equal(hidden.checks[0]!.findingsComplete, false);
    await writeFile(module, original);
    assert.equal((await run()).outcome, "passed");
  },
);

test(
  "native Nuxt SSR distinguishes HTTP failures, request-dependent route assemblies and unsupported metadata",
  { skip, timeout: 120000 },
  async (t) => {
    const root = await project(t);
    const file = path.join(root, "app/plugins/late.ts");
    const original = await readFile(file, "utf8");
    const run = () => validate(root, { trusted: true, timeoutMs: 120000 });
    await writeFile(
      file,
      original.replace('path: "/late"', 'path: "/renamed"'),
    );
    const failed = await run();
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.ok(
      failed.checks[0]!.findings!.some(
        (finding) => finding.ruleId === "nuxt/http-status",
      ),
    );
    await writeFile(
      file,
      original.replace(
        'name: "late"',
        'name: app.ssrContext.url === "/" ? "conditional" : "late"',
      ),
    );
    const conditional = await run();
    assert.equal(
      conditional.outcome,
      "incomplete",
      JSON.stringify(conditional.checks),
    );
    assert.equal(conditional.checks[0]!.findingsComplete, false);
    await writeFile(
      file,
      original.replace(
        'name: "late",',
        'name: "late", meta: {callback: () => true},',
      ),
    );
    const unsupported = await run();
    assert.equal(
      unsupported.outcome,
      "incomplete",
      JSON.stringify(unsupported.checks),
    );
    assert.equal(
      unsupported.checks[0]!.runtime!.collections[0]!.complete,
      false,
    );
  },
);

test(
  "Nuxt cancellation terminates a live startup and removes its owned build directory",
  { skip, timeout: 45000 },
  async (t) => {
    const root = await project(t);
    const marker = path.join(root, "node_modules/nuxt-startup-state.json");
    await writeFile(
      path.join(root, "nuxt.config.ts"),
      `import {writeFileSync} from 'node:fs';
 export default defineNuxtConfig({telemetry:false,devtools:{enabled:false},hooks:{ready:async()=>{
 writeFileSync('node_modules/nuxt-startup-state.json',JSON.stringify({pid:process.pid,temporary:process.env.REPO_VERIFIER_TEMP}));
 await new Promise(()=>setInterval(()=>{},1000));
 }}});`,
    );
    const controller = new AbortController();
    const running = validate(root, {
      trusted: true,
      timeoutMs: 30000,
      signal: controller.signal,
    });
    let state: { pid: number; temporary: string } | undefined;
    let report: Awaited<typeof running>;
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          state = JSON.parse(await readFile(marker, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(state, "Native startup must be observed before cancellation");
      process.kill(state.pid, 0);
      await access(state.temporary);
    } finally {
      controller.abort();
      report = await running;
    }
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.processes[0]!.cancelled, true);
    assert.throws(() => process.kill(state!.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(state!.temporary), { code: "ENOENT" });
  },
);

test(
  "Nuxt native evidence reconciles capture identity, ordered records and probe accounting",
  { skip, timeout: 45000 },
  async (t) => {
    const root = await project(t);
    const { plan } = await createPlan(root);
    const report = await validate(root, { trusted: true, timeoutMs: 30000 });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const { nuxtEvidence } = await import("../src/nuxt-evidence.js");
    const { nuxtResultSchema } = await import("../src/nuxt-protocol.js");
    const execution = report.checks[0]!.processes[0]!;
    const original = nuxtResultSchema.parse(JSON.parse(execution.stdout));
    type Result = typeof original;
    for (const mutate of [
      (value: Result) => {
        value.sourceFingerprint = "0".repeat(64);
      },
      (value: Result) => {
        value.versions.nuxt = "0.0.0";
      },
      (value: Result) => {
        value.probes.pop();
      },
      (value: Result) => {
        value.probes[0]!.path = "/forged";
      },
      (value: Result) => {
        value.totalRoutes++;
      },
      (value: Result) => {
        value.indices.pop();
      },
      (value: Result) => {
        value.signature = "0".repeat(64);
      },
      (value: Result) => {
        value.runtime!.collections[0]!.complete = false;
      },
      (value: Result) => {
        value.probes[0]!.capture = null;
      },
      (value: Result) => {
        value.probes[0]!.capture!.indices = [2048];
      },
      (value: Result) => {
        value.probes[0]!.capture!.indices = [];
      },
      (value: Result) => {
        value.probes[0]!.capture!.signature = "0".repeat(64);
      },
      (value: Result) => {
        value.probes[0]!.capture!.supportedRoutes--;
      },
    ]) {
      const value = structuredClone(original);
      mutate(value);
      assert.equal(
        nuxtEvidence(plan.checks[0]!, [
          { ...execution, stdout: JSON.stringify(value) },
        ]).status,
        "inconclusive",
      );
    }
    assert.equal(
      nuxtEvidence(plan.checks[0]!, [{ ...execution, stdout: "malformed" }])
        .status,
      "inconclusive",
    );
    assert.equal(
      nuxtEvidence(plan.checks[0]!, [{ ...execution, exitCode: 1 }]).status,
      "error",
    );
  },
);

test(
  "Nuxt capture includes awaited app:rendered changes registered after the observer",
  { skip, timeout: 45000 },
  async (t) => {
    const root = await project(t);
    const file = path.join(root, "app/plugins/late.ts");
    const original = await readFile(file, "utf8");
    const source = original.replace(
      "  await Promise.resolve();",
      `  app.hook('app:rendered', async () => {
    await Promise.resolve();
    app.$router.addRoute({path:'/after-render',name:'after-render',component:{render:()=>null}});
  });
  await Promise.resolve();`,
    );
    assert.notEqual(source, original);
    await writeFile(file, source);
    const report = await validate(root, { trusted: true, timeoutMs: 30000 });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.ok(
      report.checks[0]!.runtime!.collections[0]!.entries.some(
        (entry) => entry.attributes.name === "after-render",
      ),
    );
  },
);

test(
  "Nuxt rejects unsupported runtime identities and protects test environment without loading dotenv or stale build output",
  { skip, timeout: 45000 },
  async (t) => {
    const root = await project(t);
    const { plan } = await createPlan(root);
    const metadata = JSON.parse(
      plan.checks[0]!.commands[0]!.args[2]!,
    ) as Record<string, string>;
    for (const file of Object.values(metadata)) {
      const original = await readFile(file, "utf8");
      try {
        await writeFile(
          file,
          JSON.stringify({ ...JSON.parse(original), version: "0.0.0" }),
        );
        const unsupported = await validate(root, { trusted: true });
        assert.equal(unsupported.outcome, "incomplete");
        assert.equal(unsupported.checks[0]!.status, "unavailable");
      } finally {
        await writeFile(file, original);
      }
    }
    const configuration = path.join(root, "nuxt.config.ts");
    const original = await readFile(configuration, "utf8");
    await writeFile(
      configuration,
      `if(process.env.NODE_ENV!=='test'||process.env.NODE_OPTIONS||process.env.CI!=='1'||process.env.NUXT_TELEMETRY_DISABLED!=='1'||process.env.NUXT_FIXTURE_DOTENV) throw new Error('unexpected environment');\n${original}`,
    );
    await writeFile(path.join(root, ".env"), "NUXT_FIXTURE_DOTENV=synthetic\n");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, ".nuxt"));
    await writeFile(
      path.join(root, ".nuxt/routes.mjs"),
      "throw new Error('stale build must not be read');",
    );
    const report = await validate(root, {
      trusted: true,
      timeoutMs: 30000,
      environment: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--invalid",
        CI: "0",
        NUXT_TELEMETRY_DISABLED: "0",
      },
    });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  },
);
