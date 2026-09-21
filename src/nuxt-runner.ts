import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nuxtConfigSchema, nuxtVersions } from "./nuxt.js";
import { nuxtResultSchema } from "./nuxt-protocol.js";
import {
  captureVueRecords,
  vueRecordIdentity,
  type RouteRecord,
} from "./vue-router-capture.js";

interface NativeNuxt {
  options: {
    dev: boolean;
    test: boolean;
    ssr: boolean;
    buildDir: string;
    rootDir: string;
  };
  close(): Promise<void>;
}
interface RuntimeCapture {
  records: RouteRecord[];
  matched: RouteRecord[];
  strict: boolean;
  sensitive: boolean;
  url: string;
}
const symbol = Symbol.for("checktrail.nuxt.capture");
const host = globalThis as typeof globalThis & {
  [symbol]?: (capture: () => RuntimeCapture) => void;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function main() {
  const [entry, encodedMetadata, encodedConfig, sourceFingerprint] =
    process.argv.slice(2);
  const config = nuxtConfigSchema.parse(JSON.parse(encodedConfig!));
  const metadata = JSON.parse(encodedMetadata!) as Record<string, string>;
  const versions: Record<string, string> = {};
  for (const [name, expected] of Object.entries(nuxtVersions)) {
    versions[name] = JSON.parse(
      await readFile(metadata[name]!, "utf8"),
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
  const temporary = await realpath(process.env.CHECKTRAIL_TEMP!);
  const root = await realpath(process.cwd());
  const buildDir = path.join(temporary, "build");
  const serverDir = path.join(temporary, "server");
  const plugin = path.join(temporary, "capture.mjs");
  await writeFile(
    plugin,
    `import {defineNuxtPlugin} from '#app';
export default defineNuxtPlugin({name:'checktrail-capture',dependsOn:['nuxt:router'],enforce:'pre',setup(app){
 const router=app.$router; const records=router.getRoutes.bind(router);
 app.hook('app:rendered',()=>globalThis[Symbol.for('checktrail.nuxt.capture')]?.(()=>({records:records(),matched:router.currentRoute.value.matched,strict:router.options.strict??false,sensitive:router.options.sensitive??false,url:app.ssrContext.url})));
}});`,
  );
  const { loadNuxt, build } = (await import(pathToFileURL(entry!).href)) as {
    loadNuxt(options: unknown): Promise<NativeNuxt>;
    build(nuxt: NativeNuxt): Promise<void>;
  };
  let nuxt: NativeNuxt | undefined;
  let runtime:
    | {
        localFetch(url: string, options: unknown): Promise<Response>;
        closePrerenderer(): Promise<void>;
      }
    | undefined;
  try {
    nuxt = await loadNuxt({
      cwd: root,
      dotenv: false,
      overrides: {
        dev: false,
        test: true,
        ssr: true,
        telemetry: false,
        devtools: { enabled: false },
        builder: "@nuxt/vite-builder",
        buildDir,
        plugins: [{ src: plugin, mode: "server" }],
        vite: { cacheDir: path.join(temporary, "vite") },
        nitro: {
          preset: "nitro-prerender",
          output: {
            dir: path.join(temporary, "output"),
            serverDir,
            publicDir: path.join(temporary, "public"),
          },
          prerender: { crawlLinks: false, routes: [] },
        },
        experimental: {
          buildCache: false,
          typescriptPlugin: false,
          chromeDevtoolsProjectSettings: false,
        },
      },
    });
    if (
      nuxt.options.dev ||
      !nuxt.options.test ||
      !nuxt.options.ssr ||
      nuxt.options.buildDir !== buildDir ||
      nuxt.options.rootDir !== root
    )
      throw new Error("Nuxt testing assembly settings changed");
    await build(nuxt);
    runtime = await import(
      pathToFileURL(path.join(serverDir, "index.mjs")).href
    );
    const result = {
      schemaVersion: 1,
      versions,
      sourceFingerprint,
      runtime: null as unknown,
      totalRoutes: 0,
      indices: [] as number[],
      signature: null as string | null,
      probes: [] as unknown[],
    };
    for (const probe of config.probes) {
      const captures: (() => RuntimeCapture)[] = [];
      host[symbol] = (capture) => {
        if (captures.length >= 2) throw new Error("Repeated runtime capture");
        captures.push(capture);
      };
      const response = await runtime!.localFetch(probe.path, {
        headers: { host: "checktrail.invalid" },
      });
      await response.body?.cancel();
      let capture: unknown = null;
      const native = captures.length === 1 ? captures[0]!() : undefined;
      if (native?.url === probe.path) {
        if (
          native.records.length > 2048 ||
          typeof native.strict !== "boolean" ||
          typeof native.sensitive !== "boolean"
        )
          throw new Error("Unsupported native router");
        const { entries, indices } = captureVueRecords(native.records, native);
        const signature = hash({
          totalRoutes: native.records.length,
          indices,
          entries,
        });
        if (!result.runtime) {
          result.totalRoutes = native.records.length;
          result.indices = indices;
          result.signature = signature;
          result.runtime = {
            schemaVersion: 1,
            format: "runtime-inventory",
            producer: { name: "checktrail.nuxt", version: "1.0.0" },
            assembly: {
              name: config.assembly,
              environment: config.environment,
            },
            sourceFingerprint,
            capturedAt: new Date().toISOString(),
            collections: [
              {
                kind: "routes",
                ordered: true,
                complete: entries.length === native.records.length,
                entries,
              },
            ],
          };
        }
        capture = {
          signature,
          totalRoutes: native.records.length,
          supportedRoutes: entries.length,
          matched: native.matched.map(vueRecordIdentity),
          indices: native.matched.map((record) => {
            const index = native.records.indexOf(record);
            return index < 0 ? null : index;
          }),
        };
      }
      result.probes.push({
        path: probe.path,
        status: response.status,
        capture,
      });
    }
    writeSync(1, JSON.stringify(nuxtResultSchema.parse(result)));
  } finally {
    delete host[symbol];
    await runtime?.closePrerenderer();
    await nuxt?.close();
  }
}
main().catch(() => {
  writeSync(2, "Nuxt build or SSR runtime capture could not complete\n");
  process.exitCode = 2;
});
