import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { validate } from "../src/engine.js";
import type { z } from "zod";
import type { vueRouteAttributesSchema } from "../src/vue-router-protocol.js";
import { fixture } from "./helpers.js";
const tools = fileURLToPath(
  new URL("../../.checktrail/vue-router-tools/node_modules", import.meta.url),
);

export const source =
  "export async function configure(router) {\n  if(process.env.NODE_ENV!=='test' || process.env.NODE_OPTIONS) throw Error('Original protected environment required');\n  const component={render(){return null;}};\n  const removed=router.beforeEach(function removed(){throw Error('Removed guard ran');}); removed(); removed();\n  const temporary=router.addRoute({path:'/temporary',name:'temporary',component}); temporary();\n  router.addRoute({path:'/ready',name:'ready',component});\n  router.addRoute({path:'/deny',name:'deny',component});\n  router.addRoute({path:'/jump',name:'jump',redirect:'/catalog/7'});\n  router.addRoute({path:'/catalog',name:'catalog',components:{default:component,sidebar:component},meta:{role:'reader'},\n    beforeEnter:[function routeFirst(to){if(to.meta.allowed!==true)throw Error('Initialization did not precede route guard');}, function routeSecond(){}],\n    children:[{path:'',name:'catalog-index',component,meta:{tier:1}},{path:':id',name:'catalog-item',alias:'p/:id',component,meta:{tier:2}}]});\n  function initialize(to){to.meta.allowed=true;}\n  function authorize(to){if(to.path.startsWith('/catalog') && to.meta.allowed!==true)return '/deny';}\n  router.beforeEach(initialize); router.beforeEach(authorize);\n  router.beforeResolve(function verified(to){if(to.meta.allowed!==true)throw Error('Uninitialized navigation');});\n  function audit(){}\n  router.afterEach(audit); router.afterEach(audit);\n  await Promise.resolve();\n  router.addRoute({path:'/late',name:'late',component});\n}\n";
const identity = (path: string, name: string) => ({ path, name });
const catalog = identity("/catalog", "catalog"),
  ready = identity("/ready", "ready"),
  late = identity("/late", "late");
function record(
  path: string,
  name: string,
  extra: Partial<z.infer<typeof vueRouteAttributesSchema>> = {},
): z.infer<typeof vueRouteAttributesSchema> {
  return {
    path,
    name,
    aliasPath: null,
    aliasName: null,
    views: ["default"],
    meta: "{}",
    redirect: "null",
    beforeEnter: [],
    children: 0,
    globalStrict: false,
    globalSensitive: false,
    ...extra,
  };
}
const expectedRecords = [
  record("/catalog/p/:id", "catalog-item", {
    aliasPath: "/catalog/:id",
    aliasName: "catalog-item",
    meta: '{"tier":2}',
  }),
  record("/catalog/:id", "catalog-item", { meta: '{"tier":2}' }),
  record("/ready", "ready"),
  record("/deny", "deny"),
  record("/jump", "jump", { views: [], redirect: '"/catalog/7"' }),
  record("/catalog", "catalog-index", { meta: '{"tier":1}' }),
  record("/catalog", "catalog", {
    views: ["default", "sidebar"],
    meta: '{"role":"reader"}',
    beforeEnter: ["routeFirst", "routeSecond"],
    children: 2,
  }),
  record("/late", "late"),
];
export const expectedHooks = [
  { phase: "beforeEach", name: "initialize" },
  { phase: "beforeEach", name: "authorize" },
  { phase: "beforeResolve", name: "verified" },
  { phase: "afterEach", name: "audit" },
  { phase: "afterEach", name: "audit" },
];
const event = (to: string, from: string) =>
  expectedHooks.map((hook) => ({ ...hook, to, from }));
const navigation = [
  {
    path: "/ready",
    fullPath: "/ready",
    matched: [ready],
    meta: '{"allowed":true}',
    hooks: event("/ready", "/"),
    failure: null,
  },
  {
    path: "/catalog",
    fullPath: "/catalog",
    matched: [catalog, identity("/catalog", "catalog-index")],
    meta: '{"allowed":true,"role":"reader","tier":1}',
    hooks: event("/catalog", "/ready"),
    failure: null,
  },
  {
    path: "/catalog/7",
    fullPath: "/catalog/7",
    matched: [catalog, identity("/catalog/:id", "catalog-item")],
    meta: '{"allowed":true,"role":"reader","tier":2}',
    hooks: event("/catalog/7", "/catalog"),
    failure: null,
  },
  {
    path: "/jump",
    fullPath: "/catalog/7",
    matched: [catalog, identity("/catalog/:id", "catalog-item")],
    meta: '{"allowed":true,"role":"reader","tier":2}',
    hooks: expectedHooks
      .filter((h) => h.phase === "afterEach")
      .map((h) => ({ ...h, to: "/catalog/7", from: "/catalog/7" })),
    failure: 16,
  },
  {
    path: "/catalog/p/9",
    fullPath: "/catalog/p/9",
    matched: [catalog, identity("/catalog/p/:id", "catalog-item")],
    meta: '{"allowed":true,"role":"reader","tier":2}',
    hooks: event("/catalog/p/9", "/catalog/7"),
    failure: null,
  },
  {
    path: "/deny",
    fullPath: "/deny",
    matched: [identity("/deny", "deny")],
    meta: '{"allowed":true}',
    hooks: event("/deny", "/catalog/p/9"),
    failure: null,
  },
  {
    path: "/late",
    fullPath: "/late",
    matched: [late],
    meta: '{"allowed":true}',
    hooks: event("/late", "/deny"),
    failure: null,
  },
];
export const profile = {
  schemaVersion: 2,
  module: "routes.mjs",
  attribute: "configure",
  assembly: "original.router.assembly",
  environment: "test",
  strict: false,
  sensitive: false,
  probes: [
    { path: "/ready", matched: [ready] },
    { path: "/deny", matched: [identity("/deny", "deny")] },
    { path: "/jump", matched: [identity("/jump", "jump")] },
    {
      path: "/catalog",
      matched: [catalog, identity("/catalog", "catalog-index")],
    },
    {
      path: "/catalog/7",
      matched: [catalog, identity("/catalog/:id", "catalog-item")],
    },
    {
      path: "/catalog/p/9",
      matched: [catalog, identity("/catalog/p/:id", "catalog-item")],
    },
    { path: "/late", matched: [late] },
    { path: "/absent", matched: [] },
  ],
  expectedRecords,
  expectedHooks,
  navigation,
};
export async function project(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
  prepared = true,
) {
  const root = await fixture(t, {
    "package.json": '{"private":true,"type":"module"}',
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["javascript.vue-router"] }],
    }),
    "checktrail.vue-router.json": JSON.stringify(configuration),
    "routes.mjs": program,
  });
  if (prepared)
    await cp(tools, path.join(root, "node_modules"), { recursive: true });
  return root;
}
export async function run(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
) {
  const root = await project(t, program, configuration);
  return validate(root, { trusted: true });
}
