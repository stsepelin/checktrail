import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { vueRouterEvidence } from "../src/vue-router-evidence.js";
import { compareRuntimeInventories } from "../src/runtime-inventory.js";
import { fixture } from "./helpers.js";
import { reportSchema, reportSummarySchema } from "../src/schemas.js";

const tools = fileURLToPath(
  new URL(
    "../../.repo-verifier/vue-router-tools/node_modules",
    import.meta.url,
  ),
);
const available = await access(
  path.join(tools, "vue-router/package.json"),
).then(
  () => true,
  () => false,
);
const skip = available
  ? false
  : "Prepared Vue Router fixture runtime unavailable";
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["javascript.vue-router"] }],
});
const profile = {
  schemaVersion: 1,
  module: "routes.mjs",
  attribute: "configure",
  assembly: "synthetic.web",
  environment: "test",
  strict: false,
  sensitive: false,
  probes: [
    {
      path: "/items",
      matched: [
        { path: "/items", name: "items" },
        { path: "/items", name: "items-index" },
      ],
    },
    {
      path: "/items/7",
      matched: [
        { path: "/items", name: "items" },
        { path: "/items/:id", name: "item" },
      ],
    },
    {
      path: "/items/p/7",
      matched: [
        { path: "/items", name: "items" },
        { path: "/items/p/:id", name: "item" },
      ],
    },
    { path: "/late", matched: [{ path: "/late", name: "late" }] },
    { path: "/absent", matched: [] },
  ],
};
const source = `
export async function configure(router) {
  const lazy = () => { throw new Error('components must not be loaded by resolution'); };
  const remove = router.addRoute({path:'/temporary', name:'temporary', component:lazy}); remove();
  router.addRoute({path:'/items', name:'items', component:lazy, meta:{roles:['reader']},
    beforeEnter: function accessGuard() { throw new Error('navigation guards must not execute'); },
    children:[{path:'',name:'items-index',component:lazy},{path:':id',name:'item',component:lazy,alias:'p/:id'}]});
  await Promise.resolve();
  router.addRoute({path:'/late',name:'late',component:lazy});
}
`;
async function project(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
  prepared = true,
) {
  const root = await fixture(t, {
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "repo-verifier.json": policy,
    "repo-verifier.vue-router.json": JSON.stringify(configuration),
    "routes.mjs": program,
  });
  if (prepared)
    await cp(tools, path.join(root, "node_modules"), { recursive: true });
  return root;
}

test("Vue Router planning validates explicit scope without executing startup or granting trust", async (t) => {
  const root = await project(
    t,
    "throw new Error('startup must not execute');",
    profile,
    false,
  );
  const plan = await createPlan(root);
  assert.match(plan.plan.checks[0]!.unavailableReason!, /installed/);
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  for (const change of [
    { module: "../outside.mjs" },
    { attribute: "bad-name" },
    { environment: "production" },
    { probes: [] },
    { probes: [{ path: "/", matched: [] }] },
    { probes: [profile.probes[0], profile.probes[0]] },
    { extra: true },
  ]) {
    await writeFile(
      path.join(root, "repo-verifier.vue-router.json"),
      JSON.stringify({ ...profile, ...change }),
    );
    await assert.rejects(createPlan(root));
  }
  await writeFile(
    path.join(root, "repo-verifier.vue-router.json"),
    JSON.stringify({ ...profile, module: "missing.mjs" }),
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /inventoried/,
  );
});

test(
  "native Vue Router captures async registration, nested default children and aliases without loading views or navigation guards",
  { skip },
  async (t) => {
    const root = await project(t);
    const run = () => validate(root, { trusted: true });
    const good = await run();
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    const check = good.checks[0]!;
    assert.equal(check.runtime!.collections[0]!.entries.length, 5);
    assert.equal(check.findingsComplete, true);
    assert.deepEqual(
      check.tools!.map((tool) => [tool.name, tool.version]),
      [
        ["node", process.versions.node],
        ["vue", "3.5.43"],
        ["vue-router", "5.3.1"],
      ],
    );
    assert.ok(
      check.runtime!.collections[0]!.entries.some(
        (entry) => entry.attributes.aliasPath === "/items/:id",
      ),
    );
    assert.ok(!JSON.stringify(check.runtime).includes("temporary"));
    await writeFile(
      path.join(root, "routes.mjs"),
      source.replace("name:'item'", "name:'changed'"),
    );
    const broken = await run();
    assert.equal(broken.outcome, "failed");
    assert.equal(broken.checks[0]!.findings!.length, 2);
    assert.ok(
      broken.checks[0]!.findings!.every(
        (finding) => finding.ruleId === "vue-router/probe-mismatch",
      ),
    );
    await writeFile(path.join(root, "routes.mjs"), source);
    assert.equal((await run()).outcome, "passed");
    await writeFile(
      path.join(root, "routes.mjs"),
      source.replace("roles:['reader']", "roles:['editor']"),
    );
    const changed = await run();
    assert.equal(changed.outcome, "passed");
    const comparison = compareRuntimeInventories(
      check.runtime,
      changed.checks[0]!.runtime,
    );
    assert.equal(comparison.outcome, "failed");
    assert.equal(comparison.counts.changed, 1);
  },
);

test(
  "native Vue Router cannot pass uncovered or shadowed records, unsupported dynamic redirects or an empty router",
  { skip },
  async (t) => {
    const root = await project(t);
    const hidden = source.replace(
      "await Promise.resolve();",
      "router.addRoute({path:'/hidden',name:'hidden',component:lazy}); await Promise.resolve();",
    );
    await writeFile(path.join(root, "routes.mjs"), hidden);
    const uncovered = await validate(root, { trusted: true });
    assert.equal(uncovered.outcome, "incomplete");
    assert.equal(uncovered.checks[0]!.findingsComplete, false);
    const coveredProfile = {
      ...profile,
      probes: [
        ...profile.probes,
        { path: "/hidden", matched: [{ path: "/hidden", name: "hidden" }] },
      ],
    };
    await writeFile(
      path.join(root, "repo-verifier.vue-router.json"),
      JSON.stringify(coveredProfile),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await writeFile(
      path.join(root, "routes.mjs"),
      hidden.replace("path:'/hidden'", "path:'/late'"),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await writeFile(
      path.join(root, "routes.mjs"),
      source.replace(
        "path:'/late',name:'late',component:lazy",
        "path:'/late',name:'late',redirect:()=>'/items'",
      ),
    );
    await writeFile(
      path.join(root, "repo-verifier.vue-router.json"),
      JSON.stringify(profile),
    );
    const unsupported = await validate(root, { trusted: true });
    assert.equal(unsupported.outcome, "incomplete");
    assert.equal(
      unsupported.checks[0]!.runtime!.collections[0]!.complete,
      false,
    );
    for (const metadata of [
      "{[Symbol('private')]:true}",
      "{created:new Date()}",
      "{callback:()=>true}",
      "Object.defineProperty({},'hidden',{value:true})",
      "{flags:Object.assign([true],{hidden:true})}",
      "{flags:new Array(1)}",
    ]) {
      await writeFile(
        path.join(root, "routes.mjs"),
        source.replace("{roles:['reader']}", metadata),
      );
      const report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks[0]!.runtime!.collections[0]!.complete, false);
    }
    await writeFile(
      path.join(root, "routes.mjs"),
      "export function configure() {};",
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
  },
);

test(
  "native Vue Router probes preserve case and trailing-slash options and capture static redirects without navigating",
  { skip },
  async (t) => {
    const configuration = {
      ...profile,
      strict: true,
      sensitive: true,
      probes: [
        { path: "/Catalog", matched: [{ path: "/Catalog", name: "catalog" }] },
        { path: "/catalog", matched: [] },
        { path: "/Catalog/", matched: [] },
        { path: "/old", matched: [{ path: "/old", name: "old" }] },
      ],
    };
    const program = `export function configure(router) {
      router.addRoute({path:'/Catalog',name:'catalog',components:{default:{render:()=>null},sidebar:{render:()=>null}}});
      router.addRoute({path:'/old',name:'old',redirect:'/Catalog'});
    }`;
    const root = await project(t, program, configuration);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const entries = report.checks[0]!.runtime!.collections[0]!.entries;
    assert.deepEqual(
      entries.find((entry) => entry.attributes.name === "catalog")!.attributes
        .views,
      ["default", "sidebar"],
    );
    assert.equal(
      entries.find((entry) => entry.attributes.name === "old")!.attributes
        .redirect,
      JSON.stringify("/Catalog"),
    );
    for (const change of [{ sensitive: false }, { strict: false }]) {
      await writeFile(
        path.join(root, "repo-verifier.vue-router.json"),
        JSON.stringify({ ...configuration, ...change }),
      );
      const broken = await validate(root, { trusted: true });
      assert.equal(broken.outcome, "failed");
      assert.equal(broken.checks[0]!.findings!.length, 1);
      assert.equal(
        broken.checks[0]!.findings![0]!.ruleId,
        "vue-router/probe-mismatch",
      );
    }
  },
);

test(
  "Vue Router evidence reconciles native record indices, probe participation, versions and source identity",
  { skip },
  async (t) => {
    const root = await project(t);
    const { plan } = await createPlan(root);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed");
    const execution = report.checks[0]!.processes[0]!;
    type Payload = {
      totalRoutes: number;
      supportedRoutes: number;
      indices: number[];
      coveredIndices: number[];
      versions: { router: string };
      probes: {
        path: string;
        indices: (number | null)[];
        matched: unknown[];
      }[];
      runtime: {
        sourceFingerprint: string;
        collections: { complete: boolean; entries: { key: string }[] }[];
      };
    };
    const original = JSON.parse(execution.stdout) as Payload;
    for (const change of [
      (value: Payload) => value.indices.pop(),
      (value: Payload) => value.coveredIndices.pop(),
      (value: Payload) => value.totalRoutes++,
      (value: Payload) => value.supportedRoutes--,
      (value: Payload) => value.probes.pop(),
      (value: Payload) => {
        value.probes[0]!.path = "/other";
      },
      (value: Payload) => {
        value.probes[0]!.indices[0] = 2048;
      },
      (value: Payload) => {
        value.probes[0]!.indices[0] = value.probes[0]!.indices[1]!;
      },
      (value: Payload) => {
        value.probes[0]!.matched = [];
      },
      (value: Payload) => {
        value.versions.router = "0.0.0";
      },
      (value: Payload) => {
        value.runtime.sourceFingerprint = "0".repeat(64);
      },
      (value: Payload) => {
        value.runtime.collections[0]!.entries[0]!.key = "forged";
      },
      (value: Payload) => {
        value.runtime.collections[0]!.complete = false;
      },
    ]) {
      const value = structuredClone(original);
      change(value);
      assert.equal(
        vueRouterEvidence(plan.checks[0]!, [
          { ...execution, stdout: JSON.stringify(value) },
        ]).status,
        "inconclusive",
      );
    }
    assert.equal(
      vueRouterEvidence(plan.checks[0]!, [
        { ...execution, stdout: "malformed" },
      ]).status,
      "inconclusive",
    );
    assert.equal(
      vueRouterEvidence(plan.checks[0]!, [{ ...execution, exitCode: 1 }])
        .status,
      "error",
    );
  },
);

test(
  "Vue Router version gates, protected environment and native readers survive startup facade replacement",
  { skip },
  async (t) => {
    const program = source.replace(
      "export async function configure(router) {",
      "export async function configure(router) { if(process.env.NODE_ENV!=='test' || process.env.NODE_OPTIONS) throw new Error('unsafe environment'); router.getRoutes=()=>[]; router.resolve=()=>({matched:[]});",
    );
    const root = await project(t, program);
    assert.equal(
      (
        await validate(root, {
          trusted: true,
          environment: { NODE_ENV: "production", NODE_OPTIONS: "--invalid" },
        })
      ).outcome,
      "passed",
    );
    const metadataPath = path.join(
      root,
      "node_modules/vue-router/package.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, version: "0.0.0" }),
    );
    const unavailable = await validate(root, { trusted: true });
    assert.equal(unavailable.outcome, "incomplete");
    assert.equal(unavailable.checks[0]!.status, "unavailable");
    await mkdir(path.join(root, "source"));
    await writeFile(path.join(root, "source/real.mjs"), source);
    await symlink(
      path.join(root, "source/real.mjs"),
      path.join(root, "linked.mjs"),
    );
    await writeFile(
      path.join(root, "repo-verifier.vue-router.json"),
      JSON.stringify({ ...profile, module: "linked.mjs" }),
    );
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /inventoried/,
    );
  },
);

test(
  "Vue Router CLI preserves explicit trust and returns path-free summary evidence",
  { skip },
  async (t) => {
    const root = await project(t);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
      encoding: "utf8",
    });
    assert.equal(denied.status, 2);
    const result = spawnSync(
      process.execPath,
      [cli, "run", "--root", root, "--trust-project"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "passed");
    assert.ok(!result.stdout.includes("/items"));
    assert.ok(!result.stdout.includes(root));
    assert.equal(report.checks[0].id, "javascript.vue-router");
  },
);

test(
  "Vue Router MCP keeps runtime route metadata behind the operator detail setting",
  { skip },
  async (t) => {
    const root = await project(t);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    for (const detailed of [false, true]) {
      const client = new Client(
        { name: "synthetic-vue-router-client", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              cli,
              "serve",
              "--root",
              root,
              "--allow-execution",
              ...(detailed ? ["--detailed"] : []),
            ],
            stderr: "pipe",
          }),
        );
        const result = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        assert.equal(result.isError, undefined);
        assert.equal(
          (detailed ? reportSchema : reportSummarySchema).parse(
            result.structuredContent,
          ).outcome,
          "passed",
        );
        assert.equal(JSON.stringify(result).includes("/items"), detailed);
        assert.equal(JSON.stringify(result).includes("reader"), detailed);
        const injected = await client.callTool({
          name: "validation_run",
          arguments: { detailed: true },
        });
        assert.equal(injected.isError, true);
      } finally {
        await client.close();
      }
    }
  },
);
