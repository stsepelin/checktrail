import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate, createPlan } from "../src/engine.js";
import { vueRouterEvidence } from "../src/vue-router-evidence.js";
import {
  source,
  profile,
  project,
  run,
} from "./review-vue-router-assembly-fixture.js";
const skip = await access(
  fileURLToPath(
    new URL(
      "../../.checktrail/vue-router-tools/node_modules/vue-router/package.json",
      import.meta.url,
    ),
  ),
).then(
  () => false,
  () => "Prepared pinned Vue Router assembly runtime unavailable",
);
test(
  "assembly-vue-router native facade and repeated remover guard acceptance",
  { skip },
  async (t) => {
    const altered = source.replace(
      "await Promise.resolve();",
      'router.getRoutes=()=>[]; router.resolve=()=>({matched:[]}); router.push=async()=>{throw Error("replaced push ran")}; router.isReady=async()=>{throw Error("replaced readiness ran")}; router.currentRoute={value:{fullPath: "/forged",matched:[],meta:{}}}; await Promise.resolve();',
    );
    assert.notEqual(altered, source);
    assert.equal((await run(t, altered)).outcome, "passed");
    const changed = source.replace(
      "router.afterEach(audit); router.afterEach(audit);",
      "router.afterEach(audit); router.afterEach(function between(){}); const second=router.afterEach(audit); second(); second();",
    );
    assert.notEqual(changed, source);
    const next = structuredClone(profile);
    next.expectedHooks.splice(3, 2, { phase: "afterEach", name: "between" });
    for (const step of next.navigation) {
      step.hooks = step.hooks.filter(
        (h) =>
          h.phase !== "afterEach" ||
          h === step.hooks.find((h) => h.phase === "afterEach"),
      );
      for (const hook of step.hooks)
        if (hook.phase === "afterEach") hook.name = "between";
    }
    const report = await run(t, changed, next);
    assert.equal(
      report.outcome,
      "passed",
      JSON.stringify(
        report.checks.map((c) => ({ status: c.status, findings: c.findings })),
      ),
    );
  },
);
test(
  "assembly-vue-router changed runtime byte guard acceptance",
  { skip },
  async (t) => {
    const root = await project(
        t,
        source.replace(
          "export async function configure(router) {",
          'export async function configure(router) { await (await import("node:fs/promises")).writeFile("startup.executed","yes");',
        ),
      ),
      file = path.join(root, "node_modules/vue-router/dist/vue-router.js"),
      original = await readFile(file);
    try {
      const sameSize = Buffer.from(
        original
          .toString("utf8")
          .replace("vue-router v5.3.1", "vue-router v5.3.2"),
      );
      assert.equal(sameSize.length, original.length);
      assert.notDeepEqual(sameSize, original);
      for (const changed of [
        Buffer.concat([
          original,
          Buffer.from("\n/* original changed-runtime control */\n"),
        ]),
        sameSize,
      ]) {
        await writeFile(file, changed);
        const report = await validate(root, { trusted: true });
        assert.equal(report.checks[0]!.status, "unavailable");
        assert.equal(report.outcome, "incomplete");
        await assert.rejects(
          access(path.join(root, "startup.executed")),
          (error: unknown) =>
            (error as NodeJS.ErrnoException).code === "ENOENT",
        );
      }
    } finally {
      await writeFile(file, original);
    }
  },
);

test(
  "assembly-vue-router registration and event budget guard acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const hooks = [
      { phase: "beforeEach", name: "initialize" },
      { phase: "beforeEach", name: "authorize" },
      { phase: "beforeResolve", name: "verified" },
      ...Array.from({ length: 253 }, () => ({
        phase: "afterEach",
        name: "audit",
      })),
    ];
    const next = structuredClone(profile);
    next.expectedHooks = hooks;
    next.navigation = [
      {
        ...next.navigation[0]!,
        hooks: hooks.map((h) => ({ ...h, to: "/ready", from: "/" })),
      },
    ];
    const at = source
      .replace(
        "const removed=router.beforeEach(function removed(){throw Error('Removed guard ran');}); removed(); removed();",
        "",
      )
      .replace(
        "router.afterEach(audit); router.afterEach(audit);",
        "for(let i=0;i<253;i++)router.afterEach(audit);",
      );
    assert.notEqual(at, source);
    assert.equal((await run(t, at, next)).outcome, "passed");
    const beyond = at
      .replace("i<253", "i<254")
      .replace(
        "await Promise.resolve();",
        "await (await import('node:fs/promises')).writeFile('registration.finished','yes'); await Promise.resolve();",
      );
    assert.notEqual(beyond, at);
    const root = await project(t, beyond, next);
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "error",
    );
    await assert.rejects(
      access(path.join(root, "registration.finished")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    const observed = at
      .replace(
        "function initialize(to){to.meta.allowed=true;}",
        "function initialize(to){if(to.fullPath.endsWith('?seed=9'))fs.writeFileSync('event.overrun','yes');to.meta.allowed=true;}",
      )
      .replace(
        "export async function configure(router) {",
        "export async function configure(router) { const fs=await import('node:fs');",
      );
    assert.notEqual(observed, at);
    const warmup = observed.replace(
      "router.addRoute({path:'/late',name:'late',component});",
      "router.addRoute({path:'/late',name:'late',component}); for(let seed=1;seed<=8;seed++)await router.push('/late?seed='+seed);",
    );
    assert.notEqual(warmup, observed);
    const warmProfile = structuredClone(next);
    for (const hook of warmProfile.navigation[0]!.hooks)
      hook.from = "/late?seed=8";
    assert.equal((await run(t, warmup, warmProfile)).outcome, "passed");
    const exhausted = warmup.replace("seed<=8", "seed<=9");
    assert.notEqual(exhausted, warmup);
    const exhaustedRoot = await project(t, exhausted, warmProfile);
    assert.equal(
      (await validate(exhaustedRoot, { trusted: true })).checks[0]!.status,
      "error",
    );
    await assert.rejects(
      access(path.join(exhaustedRoot, "event.overrun")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  },
);
test(
  "assembly-vue-router unawaited after hook guard acceptance",
  { skip },
  async (t) => {
    const changed = source.replace(
      "function audit(){}",
      "function audit(){return Promise.resolve();}",
    );
    assert.notEqual(changed, source);
    assert.equal((await run(t, changed)).checks[0]!.status, "error");
  },
);

test(
  "assembly-vue-router identical-name assembly drift guard acceptance",
  { skip },
  async (t) => {
    const changed = source
      .replace(
        "function audit(){}",
        "let calls=0; let remove; function audit(){if(++calls===2){remove();router.afterEach(function audit(){});}}",
      )
      .replace(
        "router.afterEach(audit); router.afterEach(audit);",
        "router.afterEach(audit); remove=router.afterEach(audit);",
      );
    assert.notEqual(changed, source);
    assert.equal((await run(t, changed)).checks[0]!.status, "error");
  },
);
test(
  "assembly-vue-router inert then metadata guard acceptance",
  { skip },
  async (t) => {
    const changed = source.replace(
      "function audit(){}",
      'function audit(){return {then: "inert"};}',
    );
    assert.notEqual(changed, source);
    assert.equal((await run(t, changed)).outcome, "passed");
    const computed = source.replace(
      "function audit(){}",
      'function audit(){return {get then(){throw Error("Observer evaluated an ignored return getter");}};}',
    );
    assert.notEqual(computed, source);
    assert.equal((await run(t, computed)).checks[0]!.status, "error");
  },
);

test(
  "assembly-vue-router declared records guard acceptance",
  { skip },
  async (t) => {
    for (const change of [
      (c: typeof profile) => {
        c.expectedRecords[0]!.views = ["default", "foreign"];
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.meta = "{}";
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.aliasPath = "/foreign";
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.aliasName = "foreign";
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.beforeEnter = ["foreign"];
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.redirect = '"/foreign"';
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.children = 1;
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.globalStrict = true;
      },
      (c: typeof profile) => {
        c.expectedRecords[0]!.globalSensitive = true;
      },
    ]) {
      const next = structuredClone(profile);
      change(next);
      const report = await run(t, source, next);
      assert.equal(report.outcome, "failed");
      assert.deepEqual(
        report.checks[0]!.findings!.map((f) => f.ruleId),
        ["vue-router/assembly-records-mismatch"],
      );
    }
  },
);
test(
  "assembly-vue-router unreachable hooks guard acceptance",
  { skip },
  async (t) => {
    const root = await project(t),
      report = await validate(root, { trusted: true }),
      check = (await createPlan(root)).plan.checks[0]!,
      execution = report.checks[0]!.processes[0]!,
      original = JSON.parse(execution.stdout);
    original.hooks[0].reached = false;
    original.runtime.collections[1].entries[0].attributes.reached = false;
    original.runtime.collections[1].complete = false;
    assert.equal(
      vueRouterEvidence(check, [
        { ...execution, stdout: JSON.stringify(original) },
      ]).status,
      "inconclusive",
    );
  },
);

test(
  "assembly-vue-router identical-record assembly drift guard acceptance",
  { skip },
  async (t) => {
    const changed = source
      .replace(
        "function audit(){}",
        "let changed=false; function audit(){if(!changed){changed=true;router.removeRoute('late');router.addRoute({path:'/late',name:'late',component});}}",
      )
      .replace(
        "await Promise.resolve();",
        "router.getRoutes=()=>[]; await Promise.resolve();",
      );
    assert.notEqual(changed, source);
    assert.equal((await run(t, changed)).checks[0]!.status, "error");
  },
);
