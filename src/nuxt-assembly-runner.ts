import { NuxtAssemblyUnsupported } from "./nuxt-assembly-error.js";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile, realpath, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { nuxtVersions } from "./nuxt.js";
import {
  nuxtAssemblyConfigSchema,
  nuxtAssemblyResultSchema,
} from "./nuxt-assembly-schema.js";
import { nuxtAssemblyRuntimePins } from "./nuxt-assembly-runtime-pins.js";
import {
  nativeHandlerModule,
  nativeMiddlewareModule,
  checkNativeApiTypes,
} from "./nuxt-assembly-native.js";
import {
  observeNuxtAssembly,
  type NitroApp,
  type NativeHandler,
  type NuxtApp,
} from "./nuxt-assembly-observer.js";

interface NativeNitro {
  vfs: Record<string, string>;
  options: {
    plugins: string[];
    externals: { inline?: string[] };
    preset: string;
    output: { serverDir: string };
    prerender: { routes: string[]; crawlLinks: boolean };
  };
}
interface NativeNuxt {
  options: {
    dev: boolean;
    test: boolean;
    ssr: boolean;
    buildDir: string;
    rootDir: string;
    vite: { cacheDir: string };
    experimental: { buildCache: boolean };
  };
  _nitro: NativeNitro;
  hook(name: string, callback: (nitro: NativeNitro) => void): void;
  ready(): Promise<void>;
  close(): Promise<void>;
}
const versionsExpected = {
  ...nuxtVersions,
  h3: "1.15.11",
  vite: "8.3.0",
  typescript: "6.0.3",
};
const symbol = Symbol.for("checktrail.nuxt.assembly.v2");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const host = globalThis as typeof globalThis & {
  [symbol]?: ReturnType<typeof observeNuxtAssembly>;
};
async function main() {
  const [entry, encodedMetadata, encodedConfig, sourceFingerprint] =
    process.argv.slice(2);
  const config = nuxtAssemblyConfigSchema.parse(JSON.parse(encodedConfig!));
  const root = await realpath(process.cwd()),
    temporary = await realpath(process.env.CHECKTRAIL_TEMP!);
  if (root === temporary || temporary.startsWith(root + path.sep))
    throw new NuxtAssemblyUnsupported(
      "Nuxt build must use a fresh separate process directory",
    );
  const metadata = JSON.parse(encodedMetadata!) as Record<string, string>,
    require = createRequire(entry!);

  const versions: Record<string, string> = {};
  try {
    for (const name of ["h3", "vite"])
      metadata[name] = require.resolve(name + "/package.json");
    metadata.typescript = createRequire(import.meta.url).resolve(
      "typescript/package.json",
    );
    for (const [name, expected] of Object.entries(versionsExpected)) {
      versions[name] = (
        JSON.parse(await readFile(metadata[name]!, "utf8")) as {
          version: string;
        }
      ).version;
      if (versions[name] !== expected) {
        writeSync(
          1,
          JSON.stringify({
            unavailable: "nuxt-runtime",
            reason: "unsupported-version",
          }),
        );
        process.exitCode = 3;
        return;
      }
    }
    for (const pin of nuxtAssemblyRuntimePins) {
      const packageRoot = await realpath(path.dirname(metadata[pin.package]!)),
        file = await realpath(path.join(packageRoot, pin.file));
      if (!file.startsWith(packageRoot + path.sep))
        throw new NuxtAssemblyUnsupported(
          "Native source pin escapes its package",
        );
      const bytes = await readFile(file);
      if (
        bytes.length !== pin.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== pin.sha256
      ) {
        writeSync(
          1,
          JSON.stringify({
            unavailable: "nuxt-runtime",
            reason: "runtime-byte-mismatch",
          }),
        );
        process.exitCode = 3;
        return;
      }
    }
  } catch {
    writeSync(
      1,
      JSON.stringify({
        unavailable: "nuxt-runtime",
        reason: "missing-package",
      }),
    );
    process.exitCode = 3;
    return;
  }
  const packageRoots = await Promise.all(
    Object.entries(metadata).map(async ([name, file]) => ({
      name,
      root: await realpath(path.dirname(file)),
    })),
  );
  function sourceLabel(value: string) {
    if (value === "#internal/nuxt/island-renderer.mjs") return value;
    const file = path.normalize(value);
    for (const item of packageRoots)
      if (file.startsWith(item.root + path.sep))
        return (
          item.name +
          ":" +
          path.relative(item.root, file).split(path.sep).join("/")
        );
    if (file.startsWith(root + path.sep)) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (
        relative.startsWith("node_modules/") ||
        relative.startsWith(".checktrail/")
      )
        throw new NuxtAssemblyUnsupported("Unbound native source dependency");
      return "project:" + relative;
    }
    throw new NuxtAssemblyUnsupported(
      "Generated handler source lies outside selected project/packages",
    );
  }
  for (const consumer of config.consumers) {
    const file = await realpath(path.join(root, consumer));
    if (
      !file.startsWith(root + path.sep) ||
      (await stat(file)).size > 512 * 1024
    )
      throw new NuxtAssemblyUnsupported("Invalid or oversized type consumer");
  }
  const buildDir = path.join(temporary, "build"),
    serverDir = path.join(temporary, "server"),
    viteCache = path.join(temporary, "vite");
  const appPlugin = path.join(temporary, "app-capture.mjs"),
    nitroPlugin = path.join(temporary, "nitro-capture.mjs");
  await writeFile(
    appPlugin,
    `import {defineNuxtPlugin} from '#app';import{globalMiddleware,namedMiddleware}from'#build/middleware';
export default defineNuxtPlugin({name:'checktrail-assembly',dependsOn:['nuxt:router'],enforce:'pre',setup(app){globalThis[Symbol.for('checktrail.nuxt.assembly.v2')].app(app,globalMiddleware,namedMiddleware);}});`,
  );
  await writeFile(
    nitroPlugin,
    `import {handlers}from'#nitro-internal-virtual/server-handlers';import{useRuntimeConfig}from'nitropack/runtime';
export default function(app){globalThis[Symbol.for('checktrail.nuxt.assembly.v2')].nitro(app,handlers,useRuntimeConfig);}`,
  );
  const observer = observeNuxtAssembly();
  host[symbol] = observer;
  const { loadNuxt, build } = (await import(pathToFileURL(entry!).href)) as {
    loadNuxt(options: unknown): Promise<NativeNuxt>;
    build(nuxt: NativeNuxt): Promise<void>;
  };
  const kit = (await import(
    pathToFileURL(createRequire(entry!).resolve("@nuxt/kit")).href
  )) as { writeTypes(nuxt: NativeNuxt): Promise<void> };
  let nuxt: NativeNuxt | undefined,
    runtime:
      | {
          localFetch(url: string, options: unknown): Promise<Response>;
          closePrerenderer(): Promise<void>;
        }
      | undefined;
  try {
    nuxt = await loadNuxt({
      cwd: root,
      dotenv: false,
      ready: false,
      overrides: {
        dev: false,
        test: true,
        ssr: true,
        logLevel: "silent",
        telemetry: false,
        devtools: { enabled: false },
        builder: "@nuxt/vite-builder",
        buildDir,
        plugins: [{ src: appPlugin, mode: "server" }],
        vite: { cacheDir: viteCache },
        nitro: {
          logLevel: 0,
          preset: "nitro-prerender",
          output: {
            dir: path.join(temporary, "output"),
            serverDir,
            publicDir: path.join(temporary, "public"),
          },
          prerender: { crawlLinks: false, routes: [] },
          externals: { inline: [nitroPlugin] },
        },
        experimental: {
          buildCache: false,
          typescriptPlugin: false,
          chromeDevtoolsProjectSettings: false,
        },
      },
    });
    nuxt.hook("nitro:init", (nitro) => {
      nitro.options.plugins.unshift(nitroPlugin);
    });
    const settings = () => {
      const options = nuxt!.options,
        nitro = nuxt!._nitro;
      if (
        options.dev ||
        !options.test ||
        !options.ssr ||
        options.buildDir !== buildDir ||
        options.rootDir !== root ||
        options.vite.cacheDir !== viteCache ||
        options.experimental.buildCache ||
        nitro.options.preset !== "nitro-prerender" ||
        nitro.options.output.serverDir !== serverDir ||
        nitro.options.prerender.crawlLinks ||
        nitro.options.prerender.routes.length
      )
        throw new NuxtAssemblyUnsupported(
          "Nuxt protected testing/build settings changed",
        );
    };
    await nuxt.ready();
    settings();
    await kit.writeTypes(nuxt);
    settings();
    await build(nuxt);
    settings();
    const nitro = nuxt._nitro;
    const handlers = nativeHandlerModule(
      nitro.vfs["#nitro-internal-virtual/server-handlers"]!,
      sourceLabel,
    );
    const appMiddleware = nativeMiddlewareModule(
      nitro.vfs["#build/middleware.mjs"]!,
      sourceLabel,
    );
    observer.compiled(handlers, appMiddleware);
    const typeReceipt = await checkNativeApiTypes(root, buildDir, config);
    for (const selected of config.expectedApis)
      if (
        !handlers.some(
          (h) =>
            !h.middleware &&
            h.route === selected.route &&
            h.method === selected.method &&
            h.source.startsWith("project:"),
        )
      )
        throw new NuxtAssemblyUnsupported(
          "Selected native API has no compiled project producer",
        );
    runtime = await import(
      pathToFileURL(path.join(serverDir, "index.mjs")).href
    );
    const requests = [];
    let pages: ReturnType<typeof observer.finish>["pages"] = null;
    const covered = new Set<string>();
    for (const request of config.requests) {
      const input = { path: request.path, method: request.method };
      observer.begin(input);
      const response = await runtime!.localFetch(input.path, {
        method: input.method,
        headers: { host: "checktrail.invalid" },
      });
      const reader = response.body?.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader)
        try {
          for (let parts = 0; ; parts++) {
            const result = await reader.read();
            if (result.done) break;
            if (parts >= 64 || bytes + result.value.byteLength > 64 * 1024)
              throw new NuxtAssemblyUnsupported(
                "Native response exceeds byte/chunk limit",
              );
            bytes += result.value.byteLength;
            chunks.push(result.value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      const body = Buffer.concat(chunks).toString("utf8"),
        observed = observer.finish(input, response.status);
      if (observed.pages) {
        if (pages && JSON.stringify(pages) !== JSON.stringify(observed.pages))
          throw new NuxtAssemblyUnsupported(
            "Page assembly differs between controlled requests",
          );
        pages = observed.pages;
        for (const record of observed.matched ?? [])
          covered.add(JSON.stringify([record.path, record.name]));
      }
      requests.push({
        ...input,
        status: response.status,
        serverRoute: observed.serverRoute,
        completion: observed.completion,
        matched: observed.matched,
        responseBody: body,
        events: observed.events,
      });
    }
    if (
      !pages ||
      !pages.length ||
      pages.some(
        (e) =>
          !covered.has(JSON.stringify([e.attributes.path, e.attributes.name])),
      )
    )
      throw new NuxtAssemblyUnsupported(
        "Generated page participation is incomplete",
      );
    const inventory = observer.inventory();
    const entry = (family: string, value: Record<string, unknown>) => ({
      key: family + ":" + hash(value),
      attributes: { family, ...value },
    });
    const collections = [
      {
        kind: "routes",
        ordered: true,
        complete: true,
        entries: [
          ...pages.map((e) => entry("page", e.attributes)),
          ...inventory.handlers
            .filter((h) => !h.middleware)
            .map((h) => entry("server", h)),
        ],
      },
      {
        kind: "middleware",
        ordered: true,
        complete: true,
        entries: inventory.middleware.map((m) => entry("middleware", m)),
      },
      {
        kind: "bindings",
        ordered: true,
        complete: true,
        entries: [
          ...inventory.runtimeConfig.map((c) => entry("config", c)),
          ...typeReceipt.apis.map((a) => entry("api-type", a)),
        ],
      },
    ];
    const result = nuxtAssemblyResultSchema.parse({
      schemaVersion: 2,
      versions,
      runtime: {
        schemaVersion: 1,
        format: "runtime-inventory",
        producer: { name: "checktrail.nuxt", version: "2.0.0" },
        assembly: { name: config.assembly, environment: config.environment },
        sourceFingerprint,
        capturedAt: new Date().toISOString(),
        collections,
      },
      counts: [
        pages.length,
        inventory.handlers.length,
        inventory.middleware.filter((m) => m.phase === "h3").length,
        inventory.middleware.filter((m) => m.phase !== "h3").length,
        inventory.runtimeConfig.length,
        typeReceipt.apis.length,
      ],
      handlers: inventory.handlers,
      middleware: inventory.middleware,
      runtimeConfig: inventory.runtimeConfig,
      types: typeReceipt,
      requests,
    });
    writeSync(1, JSON.stringify(result));
  } finally {
    delete host[symbol];
    await runtime?.closePrerenderer();
    await nuxt?.close();
  }
}
main().catch((error: unknown) => {
  writeSync(
    1,
    JSON.stringify({
      incomplete: "nuxt-assembly",
      reason:
        error instanceof NuxtAssemblyUnsupported
          ? error.message
          : "Native construction, types or controlled response observation is unsupported or incomplete.",
    }),
  );
  process.exitCode = 4;
});
// The observer receives these native types through the generated plugin bridge.
export type { NitroApp, NativeHandler, NuxtApp };
