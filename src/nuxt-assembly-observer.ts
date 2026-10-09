import { NuxtAssemblyUnsupported } from "./nuxt-assembly-error.js";
import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  vueRouteData,
  captureVueRecords,
  vueRecordIdentity,
  type RouteRecord,
} from "./vue-router-capture.js";
import { nuxtMiddlewareEventSchema } from "./nuxt-assembly-schema.js";
import type {
  NuxtHandler,
  NuxtMiddleware,
  NuxtMiddlewareEvent,
} from "./nuxt-assembly-schema.js";
type Callback = (...args: unknown[]) => unknown;
interface Event {
  path: string;
  method: string;
  context: {
    matchedRoute?: { path: string; handlers: Record<string, Callback> };
  };
}
interface Layer {
  route: string;
  handler: Callback;
  match?: unknown;
}
export interface NitroApp {
  h3App: { stack: Layer[] };
  router: Record<string, unknown>;
  hooks: { hook(name: string, fn: Callback): unknown };
}
export interface NativeHandler {
  route: string;
  method?: string;
  handler: Callback;
  lazy: boolean;
  middleware: boolean;
}
export interface NuxtApp {
  $router: {
    getRoutes(): RouteRecord[];
    currentRoute: { value: { matched: RouteRecord[] } };
    options: { strict?: boolean; sensitive?: boolean };
  };
  _middleware: { global: Callback[]; named: Record<string, unknown> };
  ssrContext: { url: string; runtimeConfig: unknown; config: unknown };
  hook(name: string, callback: Callback): unknown;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(vueRouteData(value)))
    .digest("hex");
function callable(value: unknown): Callback {
  if (
    typeof value !== "function" ||
    types.isProxy(value) ||
    !Number.isInteger(value.length) ||
    value.length > 32
  )
    throw new NuxtAssemblyUnsupported("Opaque native callback");
  return value as Callback;
}
function forwarded(
  original: Callback,
  reached: (args: unknown[]) => void,
): Callback {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    reached(args);
    return Reflect.apply(original, this, args);
  };
  Object.defineProperties(wrapped, {
    name: { value: original.name, configurable: true },
    length: { value: original.length, configurable: true },
  });
  // Preserve native handler markers and metadata without evaluating getters.
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(original),
  ))
    if (!["name", "length", "prototype", "arguments", "caller"].includes(key))
      Object.defineProperty(wrapped, key, descriptor);
  return wrapped;
}
export function runtimeConfigBoundaries(value: unknown) {
  const config = vueRouteData(value) as Record<string, unknown>;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !config.public ||
    typeof config.public !== "object" ||
    Array.isArray(config.public)
  )
    throw new NuxtAssemblyUnsupported("Opaque runtime config namespaces");
  if (
    !config.app ||
    typeof config.app !== "object" ||
    Array.isArray(config.app) ||
    JSON.stringify(Object.keys(config.app).sort()) !==
      JSON.stringify(["baseURL", "buildAssetsDir", "buildId", "cdnURL"]) ||
    Object.values(config.app).some((v) => typeof v !== "string")
  )
    throw new NuxtAssemblyUnsupported(
      "Reserved app runtime config boundary changed",
    );
  if (
    !config.nitro ||
    typeof config.nitro !== "object" ||
    Array.isArray(config.nitro) ||
    JSON.stringify(Object.keys(config.nitro).sort()) !==
      JSON.stringify(["envPrefix", "routeRules"])
  )
    throw new NuxtAssemblyUnsupported(
      "Reserved Nitro runtime config boundary changed",
    );
  const internalRows = ["app", "nitro"].map((key) => ({
    visibility: "internal" as const,
    key,
    sha256: digest(config[key]),
  }));
  const privateRows = Object.entries(config)
    .filter(([key]) => !["public", "app", "nitro"].includes(key))
    .map(([key, value]) => ({
      visibility: "private" as const,
      key,
      sha256: digest(value),
    }));
  const publicRows = Object.entries(
    config.public as Record<string, unknown>,
  ).map(([key, value]) => ({
    visibility: "public" as const,
    key,
    sha256: digest(value),
  }));
  if (privateRows.length + publicRows.length + internalRows.length > 128)
    throw new NuxtAssemblyUnsupported("Runtime config key budget exceeded");
  return [...privateRows, ...publicRows, ...internalRows];
}
export function observeNuxtAssembly() {
  let native:
    | { app: NitroApp; handlers: NativeHandler[]; config: () => unknown }
    | undefined;
  let compiled: NuxtHandler[] | undefined,
    appModule:
      | { global: string[]; named: { name: string; source: string }[] }
      | undefined;
  let middleware: NuxtMiddleware[] = [],
    events: NuxtMiddlewareEvent[] = [],
    matches: { path: string; method: string; route: string | null }[] = [];
  let layers: Layer[] = [],
    originalLayers: Callback[] = [],
    wrappedLayers: Callback[] = [];
  const routerMethods = new Map<string, unknown>();
  let requestEvents: Event[] = [],
    errorEvents: Event[] = [];
  let nativeHandlers: Callback[] = [],
    handlerDescriptors: string[] = [];
  let registrationChanged = false,
    active: { path: string; method: string } | undefined;
  const captures: {
    app: NuxtApp;
    records: RouteRecord[];
    matched: { path: string; name: string | null }[];
    entries: ReturnType<typeof captureVueRecords>["entries"];
    get: () => RouteRecord[];
    method: unknown;
    signature: string;
  }[] = [];
  let globalIdentity: Callback[] | undefined,
    namedIdentity: Record<string, unknown> | undefined;
  const wrappers = new Map<Callback, Callback>(),
    loaders = new Map<string, unknown>();
  function record(input: unknown) {
    const event = nuxtMiddlewareEventSchema.parse(input);
    if (!active || events.length >= 2048)
      throw new NuxtAssemblyUnsupported(
        "Unbounded or detached middleware invocation",
      );
    events.push(event);
  }
  function assertNative() {
    if (
      !native ||
      !compiled ||
      !appModule ||
      registrationChanged ||
      native.app.h3App.stack.length !== layers.length ||
      native.handlers.length !== nativeHandlers.length
    )
      throw new NuxtAssemblyUnsupported(
        "Native assembly changed or incomplete",
      );
    for (const [i, layer] of native.app.h3App.stack.entries())
      if (
        layer !== layers[i] ||
        layer.handler !== wrappedLayers[i] ||
        layer.route !== "/" ||
        layer.match !== undefined
      )
        throw new NuxtAssemblyUnsupported("Native middleware identity changed");
    for (const [i, h] of native.handlers.entries())
      if (
        h.handler !== nativeHandlers[i] ||
        JSON.stringify([h.route, h.method ?? null, h.lazy, h.middleware]) !==
          handlerDescriptors[i]
      )
        throw new NuxtAssemblyUnsupported("Compiled handler identity changed");
    for (const [key, value] of routerMethods)
      if (native.app.router[key] !== value)
        throw new NuxtAssemblyUnsupported(
          "Native router registration method changed",
        );
  }
  return {
    compiled(
      handlers: NuxtHandler[],
      module: { global: string[]; named: { name: string; source: string }[] },
    ) {
      if (compiled)
        throw new NuxtAssemblyUnsupported("Repeated native compilation");
      compiled = handlers;
      appModule = module;
    },
    nitro(app: NitroApp, handlers: NativeHandler[], config: () => unknown) {
      if (
        native ||
        !compiled ||
        !appModule ||
        handlers.length !== compiled.length
      )
        throw new NuxtAssemblyUnsupported(
          "Repeated or premature Nitro construction",
        );
      for (const [i, h] of handlers.entries()) {
        const expected = compiled[i]!;
        callable(h.handler);
        if (
          h.route !== expected.route ||
          h.method !== (expected.method ?? undefined) ||
          h.lazy !== expected.lazy ||
          h.middleware !== expected.middleware
        )
          throw new NuxtAssemblyUnsupported(
            "Compiled and constructed handlers differ",
          );
      }
      native = { app, handlers, config };
      nativeHandlers = handlers.map((h) => h.handler);
      handlerDescriptors = handlers.map((h) =>
        JSON.stringify([h.route, h.method ?? null, h.lazy, h.middleware]),
      );
      layers = app.h3App.stack.slice();
      originalLayers = layers.map((l) => callable(l.handler));
      const effective = compiled.filter((h) => h.middleware || !h.route);
      if (
        layers.length !== effective.length + 2 ||
        layers.some((l) => l.route !== "/" || l.match !== undefined) ||
        effective.some((h) => h.lazy || h.route !== "")
      )
        throw new NuxtAssemblyUnsupported(
          "Unsupported native H3 middleware assembly",
        );
      middleware = layers.map((_, i) => ({
        phase: "h3" as const,
        position: i,
        route: "/",
        source:
          i === 0
            ? "nitropack:route-rules"
            : i === layers.length - 1
              ? "h3:router"
              : effective[i - 1]!.source,
        name: "",
      }));
      wrappedLayers = layers.map((layer, position) => {
        const original = originalLayers[position]!;
        const wrapped = forwarded(original, () => {
          // The H3 stack calls one argument: its actual event. Capture it separately below.
        });
        const observed = function (this: unknown, ...args: unknown[]) {
          const event = args[0] as Event;
          if (
            !event ||
            typeof event.path !== "string" ||
            typeof event.method !== "string"
          )
            throw new NuxtAssemblyUnsupported("Opaque H3 event");
          if (position === 0) {
            if (requestEvents.length >= 128)
              throw new NuxtAssemblyUnsupported("Native event budget exceeded");
            requestEvents.push(event);
          }
          record({
            phase: "h3",
            position,
            path: event.path,
            method: event.method,
          });
          return Reflect.apply(wrapped, this, args);
        };
        Object.defineProperties(observed, {
          name: { value: original.name },
          length: { value: original.length },
        });
        layer.handler = observed;
        return observed;
      });
      for (const key of [
        "use",
        "add",
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "connect",
        "trace",
      ]) {
        const original = app.router[key];
        if (typeof original !== "function") continue;
        const wrapped = forwarded(callable(original), () => {
          registrationChanged = true;
        });
        app.router[key] = wrapped;
        routerMethods.set(key, wrapped);
      }
      app.hooks.hook("error", (_error, context) => {
        const event = (context as { event?: Event }).event;
        if (event) {
          if (!active || errorEvents.length >= 128)
            throw new NuxtAssemblyUnsupported(
              "Detached or excessive native error events",
            );
          errorEvents.push(event);
        }
      });
      app.hooks.hook("afterResponse", (value) => {
        const event = value as Event;
        if (!active || matches.length >= 128)
          throw new NuxtAssemblyUnsupported("Detached native response");
        const route = event.context.matchedRoute?.path ?? null;
        if (
          route !== null &&
          !compiled!.some((h) => !h.middleware && h.route === route)
        )
          throw new NuxtAssemblyUnsupported(
            "Native matched route is absent from compiled handlers",
          );
        matches.push({ path: event.path, method: event.method, route });
      });
    },
    app(app: NuxtApp, global: Callback[], named: Record<string, Callback>) {
      if (!active || !appModule || captures.length >= 2)
        throw new NuxtAssemblyUnsupported(
          "Detached or repeated SSR app construction",
        );
      if (
        global.length !== appModule.global.length ||
        Object.keys(named).length !== appModule.named.length
      )
        throw new NuxtAssemblyUnsupported(
          "Generated app middleware count changed",
        );
      if (!globalIdentity) {
        globalIdentity = global;
        for (const [position, original] of global.entries()) {
          callable(original);
          let wrapped = wrappers.get(original);
          if (!wrapped) {
            wrapped = forwarded(original, (args) => {
              const to = args[0] as { fullPath?: unknown };
              if (typeof to?.fullPath !== "string")
                throw new NuxtAssemblyUnsupported(
                  "Opaque native navigation target",
                );
              record({
                phase: "global",
                position,
                path: to.fullPath,
                method: "NAVIGATE",
              });
            });
            wrappers.set(original, wrapped);
          }
          global[position] = wrapped;
          middleware.push({
            phase: "global",
            position,
            route: "",
            source: appModule.global[position]!,
            name: "",
          });
        }
        namedIdentity = named;
        for (const [position, entry] of appModule.named.entries()) {
          const loader = callable(named[entry.name]);
          const observed = function (this: unknown, ...args: unknown[]) {
            const value = Reflect.apply(loader, this, args);
            if (!(value instanceof Promise))
              throw new NuxtAssemblyUnsupported(
                "Opaque native middleware loader",
              );
            return value.then((module: unknown) => {
              if (
                !module ||
                typeof module !== "object" ||
                !("default" in module)
              )
                throw new NuxtAssemblyUnsupported(
                  "Opaque native middleware module",
                );
              const original = callable(module.default);
              return {
                ...module,
                default: forwarded(original, (args) => {
                  const to = args[0] as { fullPath?: unknown };
                  if (typeof to?.fullPath !== "string")
                    throw new NuxtAssemblyUnsupported(
                      "Opaque named navigation target",
                    );
                  record({
                    phase: "named",
                    position,
                    path: to.fullPath,
                    method: "NAVIGATE",
                  });
                }),
              };
            });
          };
          named[entry.name] = observed;
          loaders.set(entry.name, observed);
          middleware.push({
            phase: "named",
            position,
            route: "",
            source: entry.source,
            name: entry.name,
          });
        }
      } else if (global !== globalIdentity || named !== namedIdentity)
        throw new NuxtAssemblyUnsupported(
          "App middleware module identity changed",
        );
      const router = app.$router,
        get = router.getRoutes.bind(router),
        method = router.getRoutes;
      app.hook("app:rendered", () => {
        const records = get();
        if (records.length > 2048)
          throw new NuxtAssemblyUnsupported("Page inventory exceeds limit");
        const projected = captureVueRecords(records, {
          strict: router.options.strict ?? false,
          sensitive: router.options.sensitive ?? false,
        });
        if (projected.entries.length !== records.length || !records.length)
          throw new NuxtAssemblyUnsupported(
            "Unsupported or empty page inventory",
          );
        const matched =
          router.currentRoute.value.matched.map(vueRecordIdentity);
        if (router.currentRoute.value.matched.some((r) => !records.includes(r)))
          throw new NuxtAssemblyUnsupported(
            "Native matched page is absent from inventory",
          );
        captures.push({
          app,
          records,
          matched,
          entries: projected.entries,
          get,
          method,
          signature: digest(projected.entries),
        });
      });
    },
    begin(input: { path: string; method: string }) {
      assertNative();
      active = input;
      events = [];
      matches = [];
      requestEvents = [];
      errorEvents = [];
      captures.length = 0;
    },
    finish(input: { path: string; method: string }, status: number) {
      assertNative();
      if (
        !active ||
        active.path !== input.path ||
        active.method !== input.method
      )
        throw new NuxtAssemblyUnsupported("Request identity changed");
      const completed = matches.filter(
        (m) => m.path === input.path && m.method === input.method,
      );
      const reached = requestEvents.filter(
        (e) => e.path === input.path && e.method === input.method,
      );
      if (
        reached.length !== 1 ||
        completed.length > 1 ||
        (completed.length === 0 &&
          !(status >= 400 && errorEvents.includes(reached[0]!)))
      )
        throw new NuxtAssemblyUnsupported(
          "Native controlled response did not complete exactly once",
        );
      const serverRoute = reached[0]!.context.matchedRoute?.path ?? null;
      if (completed.length === 1 && completed[0]!.route !== serverRoute)
        throw new NuxtAssemblyUnsupported(
          "Native response route identity changed",
        );
      const completion =
        completed.length === 1
          ? ("after-response" as const)
          : ("error-response" as const);
      const boundaries = runtimeConfigBoundaries(native!.config());
      for (const capture of captures) {
        const router = capture.app.$router,
          records = capture.get();
        if (
          router.getRoutes !== capture.method ||
          records.length !== capture.records.length ||
          records.some((r, i) => r !== capture.records[i]) ||
          digest(
            captureVueRecords(records, {
              strict: router.options.strict ?? false,
              sensitive: router.options.sensitive ?? false,
            }).entries,
          ) !== capture.signature
        )
          throw new NuxtAssemblyUnsupported(
            "Page assembly identity changed during response",
          );
        if (
          capture.app._middleware.global.length ||
          Object.keys(capture.app._middleware.named).length
        )
          throw new NuxtAssemblyUnsupported(
            "Dynamic app middleware is outside the selected profile",
          );
        if (
          !globalIdentity ||
          globalIdentity.some((fn) => ![...wrappers.values()].includes(fn)) ||
          !namedIdentity ||
          [...loaders].some(([name, fn]) => namedIdentity![name] !== fn)
        )
          throw new NuxtAssemblyUnsupported(
            "Static app middleware identity changed",
          );
        if (
          JSON.stringify(
            runtimeConfigBoundaries(capture.app.ssrContext.runtimeConfig),
          ) !== JSON.stringify(boundaries)
        )
          throw new NuxtAssemblyUnsupported("Request runtime config changed");
        const client = vueRouteData(capture.app.ssrContext.config) as Record<
          string,
          unknown
        >;
        if (
          JSON.stringify(Object.keys(client).sort()) !==
            JSON.stringify(["app", "public"]) ||
          digest(client.public) !==
            digest(
              (vueRouteData(native!.config()) as Record<string, unknown>)
                .public,
            ) ||
          digest(client.app) !==
            digest(
              (vueRouteData(native!.config()) as Record<string, unknown>).app,
            )
        )
          throw new NuxtAssemblyUnsupported(
            "SSR public runtime config boundary changed",
          );
      }
      if (captures.length > 1)
        throw new NuxtAssemblyUnsupported("Repeated SSR capture");
      const capture = captures[0];
      active = undefined;
      return {
        serverRoute,
        completion,
        matched: capture?.matched ?? null,
        pages: capture?.entries ?? null,
        events: [...events],
        runtimeConfig: boundaries,
      };
    },
    inventory() {
      assertNative();
      return {
        handlers: compiled!,
        middleware,
        runtimeConfig: runtimeConfigBoundaries(native!.config()),
      };
    },
  };
}
