import { types } from "node:util";
import {
  vueRouteData,
  vueRecordIdentity,
  type Router,
} from "./vue-router-capture.js";
import {
  vueHookSchema,
  vueHookEventSchema,
  vueNavigationSchema,
  type VueHook,
  type VueHookEvent,
} from "./vue-router-assembly-schema.js";
type Hook = VueHook;
type Event = VueHookEvent;
type Callback = (...args: unknown[]) => unknown;
type HookState = Hook & {
  callback: Callback;
  active: boolean;
  reached: boolean;
};
export interface AssemblyRouter extends Router {
  beforeEach(callback: (...args: unknown[]) => unknown): () => void;
  beforeResolve(callback: (...args: unknown[]) => unknown): () => void;
  afterEach(callback: (...args: unknown[]) => unknown): () => void;
  push(path: string): Promise<unknown>;
  isReady(): Promise<void>;
  currentRoute: {
    value: {
      fullPath: string;
      matched: Parameters<typeof vueRecordIdentity>[0][];
      meta: unknown;
    };
  };
}
function unawaitedAfterValue(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  const seen = new Set<object>();
  let current: object | null = value;
  for (let depth = 0; current !== null; depth++) {
    if (depth >= 8 || seen.has(current) || types.isProxy(current)) return true;
    seen.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (descriptor)
      return !("value" in descriptor) || typeof descriptor.value === "function";
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}
/** Observe registrations and native invocations while preserving callback arity, this, arguments and removers. */
export function observeVueHooks(router: AssemblyRouter) {
  const states: HookState[] = [],
    methods = new Map<string, unknown>();
  let events: Event[] = [],
    asynchronousAfterHook = false;
  const cursors = new Map<
    Hook["phase"],
    { to: string; from: string; next: number }
  >();
  for (const phase of ["beforeEach", "beforeResolve", "afterEach"] as const) {
    const register = router[phase].bind(router),
      wrappers = new WeakMap<Callback, Callback>();
    const observed = (callback: (...args: unknown[]) => unknown) => {
      if (
        typeof callback !== "function" ||
        states.length >= 256 ||
        !Number.isInteger(callback.length) ||
        callback.length < 0 ||
        callback.length > 32
      )
        throw new Error(
          "Unsupported or exhausted Vue Router hook registration",
        );
      const state: HookState = {
        ...vueHookSchema.parse({ phase, name: callback.name }),
        callback,
        active: true,
        reached: false,
      };
      let wrapped = wrappers.get(callback);
      if (!wrapped) {
        wrapped = function (this: unknown, ...args: unknown[]) {
          if (events.length >= 2048)
            throw new Error("Vue Router hook event budget exhausted");
          const to = args[0] as { fullPath?: unknown },
            from = args[1] as { fullPath?: unknown };
          events.push(
            vueHookEventSchema.parse({
              phase,
              name: state.name,
              to: to?.fullPath,
              from: from?.fullPath,
            }),
          );
          const event = events.at(-1)!,
            active = states.filter(
              (state) => state.active && state.phase === phase,
            );
          let cursor = cursors.get(phase);
          if (
            !cursor ||
            cursor.to !== event.to ||
            cursor.from !== event.from ||
            cursor.next >= active.length
          ) {
            cursor = { to: event.to, from: event.from, next: 0 };
            cursors.set(phase, cursor);
          }
          const reached = active[cursor.next++];
          if (!reached || reached.callback !== callback)
            throw new Error("Native hook order did not reconcile");
          reached.reached = true;
          const value = Reflect.apply(callback, this, args);
          if (phase === "afterEach" && unawaitedAfterValue(value))
            asynchronousAfterHook = true;
          return value;
        };
        Object.defineProperties(wrapped, {
          length: { value: callback.length },
          name: { value: callback.name },
        });
        wrappers.set(callback, wrapped);
      }
      const remove = register(wrapped);
      if (typeof remove !== "function")
        throw new Error("Missing native hook remover");
      states.push(state);
      return () => {
        remove();
        const removed = states.find(
          (state) =>
            state.active &&
            state.phase === phase &&
            state.callback === callback,
        );
        if (removed) removed.active = false;
      };
    };
    router[phase] = observed;
    methods.set(phase, observed);
  }
  const verify = () => {
    for (const [phase, method] of methods)
      if (router[phase as Hook["phase"]] !== method)
        throw new Error("Vue Router hook observation was replaced");
    if (asynchronousAfterHook)
      throw new Error(
        "Asynchronous after hooks are not awaited by the native router",
      );
  };
  return {
    verify,
    signature() {
      return states
        .filter((state) => state.active)
        .map((state) => states.indexOf(state));
    },
    begin() {
      events = [];
      cursors.clear();
    },
    events() {
      return events.slice();
    },
    receipts() {
      return states
        .filter((state) => state.active)
        .map(({ phase, name, reached }) => ({ phase, name, reached }));
    },
  };
}
export function vueAssemblyOperations(router: AssemblyRouter) {
  return {
    push: router.push.bind(router),
    ready: router.isReady.bind(router),
    records: router.getRoutes.bind(router),
    current: router.currentRoute,
  };
}
export async function navigateVueAssembly(
  operations: ReturnType<typeof vueAssemblyOperations>,
  observation: ReturnType<typeof observeVueHooks>,
  paths: string[],
) {
  const { push, ready, records } = operations;
  const initial = records(),
    hooks = JSON.stringify(observation.signature()),
    navigation = [];
  for (const [index, path] of paths.entries()) {
    observation.begin();
    const failure = await push(path);
    if (index === 0) {
      if (failure)
        throw new Error(
          "Assembly readiness requires a successful initial navigation",
        );
      await ready();
    }
    observation.verify();
    if (
      JSON.stringify(observation.signature()) !== hooks ||
      records().length !== initial.length ||
      records().some((record, offset) => record !== initial[offset])
    )
      throw new Error("Vue Router assembly changed during navigation probes");
    const current = operations.current.value;
    navigation.push(
      vueNavigationSchema.parse({
        path,
        fullPath: current.fullPath,
        matched: current.matched.map(vueRecordIdentity),
        meta: JSON.stringify(vueRouteData(current.meta)),
        hooks: observation.events(),
        failure: failure ? (failure as { type?: unknown }).type : null,
      }),
    );
  }
  return navigation;
}
