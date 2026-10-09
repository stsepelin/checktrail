import { access, cp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { createHash } from "node:crypto";
import { validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
const tools = fileURLToPath(
  new URL("../../.checktrail/nuxt-tools/node_modules", import.meta.url),
);
export const available =
  process.platform === "linux" &&
  (await access(path.join(tools, "nuxt/package.json")).then(
    () => true,
    () => false,
  ));
export const source: Record<string, string> = {
  "nuxt.config.ts":
    "export default defineNuxtConfig({runtimeConfig:{originalPrivate:'original-server-private',public:{originalLabel:'public-ready'}}});\n",
  "app/pages/index.vue":
    "<script setup>const config=useRuntimeConfig();const rows=[{id:1},{id:2}];</script><template><main>{{config.public.originalLabel}} {{rows.length}}</main></template>\n",
  "app/pages/catalog/[id].vue":
    "<script setup>definePageMeta({name:'catalog-item',middleware:['verify']});const route=useRoute();</script><template><main>{{route.params.id}}</main></template>\n",
  "app/middleware/00-initialize.global.ts":
    "export default defineNuxtRouteMiddleware(function originalInitialize(to){to.meta.originalReady=true;});\n",
  "app/middleware/01-authorize.global.ts":
    "export default defineNuxtRouteMiddleware(function originalAuthorize(to){if(to.meta.originalReady!==true)throw createError({statusCode:403,statusMessage:'initialization required'});});\n",
  "app/middleware/verify.ts":
    "export default defineNuxtRouteMiddleware(function originalVerify(to){if(to.meta.originalReady!==true)throw createError({statusCode:403,statusMessage:'named initialization required'});});\n",
  "server/middleware/00-initialize.ts":
    "export default defineEventHandler(event=>{event.context.originalReady=true;event.context.originalRows=[{id:1},{id:2}];});\n",
  "server/middleware/01-authorize.ts":
    "export default defineEventHandler(event=>{if(event.path.startsWith('/api/') && event.context.originalReady!==true)throw createError({statusCode:403,statusMessage:'initialization required'});});\n",
  "server/api/items.get.ts":
    "export default defineEventHandler(event=>event.context.originalRows as {id:number}[]);\n",
  "server/api/items.post.ts":
    "export default defineEventHandler(()=>({created:true}));\n",
  "server/api/config.get.ts":
    "export default defineEventHandler(event=>{const config=useRuntimeConfig(event);return {private:config.originalPrivate,public:config.public};});\n",
  "consumer.ts":
    "import type {InternalApi}from'nitropack/types';const rows:InternalApi['/api/items']['get']=[{id:1},{id:2}];const first:number=rows[0]!.id;export{first};\n",
};
const page = (path: string, name: string, meta = "{}") => ({
  path,
  name,
  aliasPath: null,
  aliasName: null,
  views: ["default"],
  meta,
  redirect: "null",
  beforeEnter: [],
  children: 0,
  globalStrict: false,
  globalSensitive: false,
});
const handler = (
  position: number,
  route: string,
  method: string | null,
  source: string,
  lazy: boolean,
  middleware = false,
) => ({ position, route, method, source, lazy, middleware });
const expectedHandlers = [
  handler(0, "", null, "nitropack:dist/runtime/internal/static", false, true),
  handler(
    1,
    "",
    null,
    "project:server/middleware/00-initialize.ts",
    false,
    true,
  ),
  handler(
    2,
    "",
    null,
    "project:server/middleware/01-authorize.ts",
    false,
    true,
  ),
  handler(3, "/api/config", "get", "project:server/api/config.get.ts", true),
  handler(4, "/api/items", "get", "project:server/api/items.get.ts", true),
  handler(5, "/api/items", "post", "project:server/api/items.post.ts", true),
  handler(
    6,
    "/__nuxt_error",
    null,
    "@nuxt/nitro-server:dist/runtime/handlers/renderer",
    true,
  ),
  handler(
    7,
    "/__nuxt_island/**",
    null,
    "#internal/nuxt/island-renderer.mjs",
    false,
  ),
  handler(
    8,
    "/**",
    null,
    "@nuxt/nitro-server:dist/runtime/handlers/renderer",
    true,
  ),
];
const expectedMiddleware = [
  ...[
    "nitropack:route-rules",
    "nitropack:dist/runtime/internal/static",
    "project:server/middleware/00-initialize.ts",
    "project:server/middleware/01-authorize.ts",
    "h3:router",
  ].map((source, position) => ({
    phase: "h3",
    position,
    route: "/",
    source,
    name: "",
  })),
  ...[
    "nuxt:dist/pages/runtime/validate.js",
    "project:app/middleware/00-initialize.global.ts",
    "project:app/middleware/01-authorize.global.ts",
    "nuxt:dist/app/middleware/route-rules.js",
  ].map((source, position) => ({
    phase: "global",
    position,
    route: "",
    source,
    name: "",
  })),
  {
    phase: "named",
    position: 0,
    route: "",
    source: "project:app/middleware/verify.ts",
    name: "verify",
  },
];
const events = (path: string, method: string, page = false, named = false) => [
  ...Array.from({ length: 5 }, (_, position) => ({
    phase: "h3",
    position,
    path,
    method,
  })),
  ...(page
    ? [0, 1, 2, 3].map((position) => ({
        phase: "global",
        position,
        path,
        method: "NAVIGATE",
      }))
    : []),
  ...(named ? [{ phase: "named", position: 0, path, method: "NAVIGATE" }] : []),
];
const request = (
  path: string,
  method: string,
  body: string | null,
  matched: { path: string; name: string }[] | null,
  includes: string[] = [],
) => ({
  path,
  method,
  expected: {
    status: 200,
    serverRoute: matched ? "/**" : path,
    matched,
    body,
    includes,
    excludes: matched ? ["original-server-private"] : [],
    events: events(path, method, !!matched, path === "/catalog/7"),
  },
});
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const profile = {
  schemaVersion: 2,
  assembly: "original.nuxt.assembly",
  environment: "test",
  expectedPages: [
    page("/catalog/:id()", "catalog-item", '{"middleware":["verify"]}'),
    page("/", "index"),
  ],
  expectedHandlers,
  expectedMiddleware,
  expectedRuntimeConfig: [
    {
      visibility: "private",
      key: "originalPrivate",
      sha256: digest("original-server-private"),
    },
    {
      visibility: "public",
      key: "originalLabel",
      sha256: digest("public-ready"),
    },
    {
      visibility: "internal",
      key: "app",
      sha256:
        "4bc0fc379651a3bd822fe18753f95a56a43f17b63dada3fbd9b328d26588b6de",
    },
    {
      visibility: "internal",
      key: "nitro",
      sha256:
        "41d31582cb0b6ef81358c86d70e1c1564b87593f16074d197ede26c2a910120e",
    },
  ],
  consumers: ["consumer.ts"],
  expectedApis: [
    {
      route: "/api/items",
      method: "get",
      type: '{"kind":"array","items":{"kind":"object","properties":[{"name":"id","optional":false,"type":{"kind":"number"}}],"indexes":[]}}',
    },
  ],
  requests: [
    request("/api/items", "GET", '[{"id":1},{"id":2}]', null),
    request("/api/items", "POST", '{"created":true}', null),
    request(
      "/api/config",
      "GET",
      '{"private":"original-server-private","public":{"originalLabel":"public-ready"}}',
      null,
    ),
    request(
      "/",
      "GET",
      null,
      [{ path: "/", name: "index" }],
      ["<main>public-ready 2</main>"],
    ),
    request(
      "/catalog/7",
      "GET",
      null,
      [{ path: "/catalog/:id()", name: "catalog-item" }],
      ["<main>7</main>"],
    ),
  ],
};
export async function project(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
  prepared = true,
) {
  const root = await fixture(t, {
    ...program,
    "package.json":
      '{"name":"original-nuxt-assembly","private":true,"type":"module"}',
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["javascript.nuxt-runtime"] }],
    }),
    "checktrail.nuxt.json": JSON.stringify(configuration),
  });
  if (prepared)
    await cp(tools, path.join(root, "node_modules"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  return root;
}
export async function run(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
) {
  const root = await project(t, program, configuration);
  try {
    return await validate(root, { trusted: true, timeoutMs: 60000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
