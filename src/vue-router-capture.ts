import { vueRouteIdentitySchema } from "./vue-router.js";
import {
  vueRouteAttributesSchema,
  vueRouteKey,
} from "./vue-router-protocol.js";

export interface RouteRecord {
  path: unknown;
  name?: unknown;
  aliasOf?: RouteRecord;
  components?: Record<string, unknown>;
  children: unknown[];
  meta: unknown;
  redirect?: unknown;
  beforeEnter?: unknown;
}
export interface Router {
  getRoutes(): RouteRecord[];
  resolve(value: string): { matched: RouteRecord[] };
}
function data(
  value: unknown,
  depth = 0,
  budget = { remaining: 1024 },
): unknown {
  if (depth > 8 || --budget.remaining < 0)
    throw new Error("Route data nesting exceeds limits");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value) && value.length <= 64) {
    if (
      Reflect.ownKeys(value).some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" ||
            String(Number(key)) !== key ||
            !Number.isInteger(Number(key)) ||
            Number(key) < 0 ||
            Number(key) >= value.length),
      )
    )
      throw new Error("Array metadata contains non-JSON properties");
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor))
        throw new Error("Sparse or computed array metadata is unsupported");
      return data(descriptor.value, depth + 1, budget);
    });
  }
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
      throw new Error("Symbol metadata is outside the JSON projection");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.values(descriptors).some(
        (descriptor) => !descriptor.enumerable || !("value" in descriptor),
      )
    )
      throw new Error("Computed or hidden metadata is unsupported");
    const entries = Object.entries(descriptors)
      .map(([key, descriptor]) => [key, descriptor.value] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length > 64) throw new Error("Route metadata exceeds limits");
    return Object.fromEntries(
      entries.map(([key, item]) => [key, data(item, depth + 1, budget)]),
    );
  }
  throw new Error("Route data is not a supported JSON value");
}
export function vueRecordIdentity(record: RouteRecord) {
  return vueRouteIdentitySchema.parse({
    path: record.path,
    name: record.name ?? null,
  });
}

export function captureVueRecords(
  records: RouteRecord[],
  config: { strict: boolean; sensitive: boolean },
) {
  const entries = [];
  const indices = [];
  for (const [index, record] of records.entries()) {
    try {
      const guards =
        record.beforeEnter === undefined
          ? []
          : Array.isArray(record.beforeEnter)
            ? record.beforeEnter
            : [record.beforeEnter];
      if (guards.some((guard) => typeof guard !== "function"))
        throw new Error("Unsupported route guard");
      const attributes = vueRouteAttributesSchema.parse({
        ...vueRecordIdentity(record),
        aliasPath: record.aliasOf
          ? vueRecordIdentity(record.aliasOf).path
          : null,
        aliasName: record.aliasOf
          ? vueRecordIdentity(record.aliasOf).name
          : null,
        views: Object.keys(record.components ?? {}).sort(),
        meta: JSON.stringify(data(record.meta)),
        redirect:
          record.redirect === undefined
            ? "null"
            : JSON.stringify(data(record.redirect)),
        beforeEnter: guards.map((guard) => (guard as { name: string }).name),
        children: record.children.length,
        globalStrict: config.strict,
        globalSensitive: config.sensitive,
      });
      entries.push({ key: vueRouteKey(attributes), attributes });
      indices.push(index);
    } catch {
      continue;
    }
  }
  return { entries, indices };
}
