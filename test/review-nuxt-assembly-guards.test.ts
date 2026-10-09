import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { symlink } from "node:fs/promises";
import { validate } from "../src/engine.js";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-nuxt-assembly-fixture.js";
const skip = available
  ? false
  : "Prepared pinned native Nuxt runtime unavailable";
test(
  "assembly-nuxt reserved config boundary guard acceptance",
  { skip },
  async (t) => {
    const changed = {
      ...source,
      "nuxt.config.ts": source["nuxt.config.ts"]!.replace(
        "runtimeConfig:{",
        "runtimeConfig:{app:{originalSecret:'original-app-secret'} as any,",
      ),
    };
    assert.notDeepEqual(changed, source);
    const report = await run(t, changed);
    if (report.outcome === "passed") {
      const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
      assert.equal(
        raw.requests[3].responseBody.includes("original-app-secret"),
        true,
      );
    }
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Reserved app runtime config boundary changed",
    );
  },
);
test(
  "assembly-nuxt generated consumer participation guard acceptance",
  { skip },
  async (t) => {
    const two = { ...source, "unused.ts": "export const unrelated=1;\n" },
      next = structuredClone(profile);
    next.consumers.push("unused.ts");
    const report = await run(t, two, next);
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Selected consumer does not reference a native generated API type",
    );
  },
);
test(
  "assembly-nuxt generated API participation guard acceptance",
  { skip },
  async (t) => {
    const next = structuredClone(profile);
    next.expectedApis.push({
      route: "/api/items",
      method: "post",
      type: '{"kind":"object","properties":[{"name":"created","optional":false,"type":{"kind":"boolean"}}],"indexes":[]}',
    });
    const report = await run(t, source, next);
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Selected generated API consumer participation is incomplete",
    );
  },
);
test(
  "assembly-nuxt response byte budget guard acceptance",
  { skip },
  async (t) => {
    const program = {
      ...source,
      "server/api/items.get.ts":
        "export default defineEventHandler(()=>({padding:'x'.repeat(65523)}));\n",
    };
    const report = await run(t, program);
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Native response exceeds byte/chunk limit",
    );
  },
);
test(
  "assembly-nuxt middleware identity guard acceptance",
  { skip },
  async (t) => {
    const changed = {
      ...source,
      "server/plugins/drift.ts":
        "export default defineNitroPlugin(app=>{(app.h3App.stack as any[])[2].handler=function originalInitialize(){};});\n",
    };
    const report = await run(t, changed);
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Native middleware identity changed",
    );
  },
);
test(
  "assembly-nuxt router registration guard acceptance",
  { skip },
  async (t) => {
    const changed = {
      ...source,
      "server/plugins/drift.ts":
        "export default defineNitroPlugin(app=>{app.router.get('/runtime-extra',defineEventHandler(()=>({ready:true})));});\n",
    };
    const report = await run(t, changed);
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Native assembly changed or incomplete",
    );
  },
);

test("assembly-nuxt page identity guard acceptance", { skip }, async (t) => {
  const changed = {
    ...source,
    "app/plugins/drift.ts":
      "export default defineNuxtPlugin(()=>{useRouter().getRoutes=()=>[];});\n",
  };
  const report = await run(t, changed);
  assert.equal(report.outcome, "incomplete");
  assert.equal(
    JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
    "Page assembly identity changed during response",
  );
});
test(
  "assembly-nuxt dynamic middleware guard acceptance",
  { skip },
  async (t) => {
    const changed = {
      ...source,
      "app/plugins/drift.ts":
        "export default defineNuxtPlugin(()=>{addRouteMiddleware('original-extra',()=>{}, {global:true});});\n",
    };
    const report = await run(t, changed);
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Dynamic app middleware is outside the selected profile",
    );
  },
);

test(
  "assembly-nuxt native query collision guard acceptance",
  { skip },
  async (t) => {
    const next = structuredClone(profile);
    next.consumers = [".__checktrail_native_api_query.ts"];
    const report = await run(
      t,
      {
        ...source,
        ".__checktrail_native_api_query.ts":
          'const unrelated:number="wrong";export{unrelated};\n',
      },
      next,
    );
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).reason,
      "Native API query path collides with project source",
    );
    const directory = await run(t, {
      ...source,
      ".__checktrail_native_api_query.ts/entry.ts": "export const value=1;\n",
    });
    assert.equal(directory.outcome, "incomplete");
    assert.equal(
      JSON.parse(directory.checks[0]!.processes[0]!.stdout).reason,
      "Native API query path collides with project source",
    );
    const root = await project(t);
    await symlink(
      "consumer.ts",
      path.join(root, ".__checktrail_native_api_query.ts"),
    );
    const linked = await validate(root, { trusted: true, timeoutMs: 60000 });
    assert.equal(linked.outcome, "incomplete");
    assert.equal(
      JSON.parse(linked.checks[0]!.processes[0]!.stdout).reason,
      "Native API query path collides with project source",
    );
    const near = structuredClone(profile);
    near.consumers = [".__checktrail_native_api_query_extra.ts"];
    assert.equal(
      (
        await run(
          t,
          {
            ...source,
            ".__checktrail_native_api_query_extra.ts": source["consumer.ts"]!,
          },
          near,
        )
      ).outcome,
      "passed",
    );
  },
);
