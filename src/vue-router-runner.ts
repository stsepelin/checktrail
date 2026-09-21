import {
  captureVueRecords,
  vueRecordIdentity,
  type Router,
} from "./vue-router-capture.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { vueRouterConfigSchema } from "./vue-router.js";
import { vueRouterResultSchema } from "./vue-router-protocol.js";

async function main() {
  const [routerEntry, vueMetadata, moduleEntry, encoded, fingerprint] =
    process.argv.slice(2);
  const config = vueRouterConfigSchema.parse(JSON.parse(encoded!));
  const routerVersion = JSON.parse(
    await readFile(
      path.join(path.dirname(routerEntry!), "package.json"),
      "utf8",
    ),
  ).version;
  const vueVersion = JSON.parse(await readFile(vueMetadata!, "utf8")).version;
  if (routerVersion !== "5.3.1" || vueVersion !== "3.5.43") {
    process.stdout.write(
      JSON.stringify({
        unavailable: "vue-router-runtime",
        reason: "unsupported-version",
      }),
    );
    process.exitCode = 3;
    return;
  }
  const native = (await import(pathToFileURL(routerEntry!).href)) as {
    createRouter(options: unknown): Router;
    createMemoryHistory(): unknown;
  };
  const router = native.createRouter({
    history: native.createMemoryHistory(),
    routes: [],
    strict: config.strict,
    sensitive: config.sensitive,
  });
  const routes = router.getRoutes.bind(router);
  const resolve = router.resolve.bind(router);
  const startup: Record<string, unknown> = await import(
    pathToFileURL(moduleEntry!).href
  );
  const configure = startup[config.attribute];
  if (typeof configure !== "function")
    throw new Error("Missing route startup function");
  await configure(router);
  const records = routes();
  if (records.length > 2048) throw new Error("Route inventory exceeds limits");
  const { entries, indices } = captureVueRecords(records, config);
  const covered = new Set<number>();
  const probes = config.probes.map((probe) => {
    const matched = resolve(probe.path).matched;
    for (const record of matched) {
      const index = records.indexOf(record);
      if (index >= 0) covered.add(index);
    }
    return {
      path: probe.path,
      matched: matched.map(vueRecordIdentity),
      indices: matched.map((record) => {
        const index = records.indexOf(record);
        return index >= 0 ? index : null;
      }),
    };
  });
  if (
    routes().length !== records.length ||
    routes().some((record, index) => record !== records[index])
  )
    throw new Error("Route assembly changed during capture");
  const result = vueRouterResultSchema.parse({
    schemaVersion: 1,
    versions: { router: routerVersion, vue: vueVersion },
    totalRoutes: records.length,
    supportedRoutes: entries.length,
    indices,
    coveredIndices: [...covered].sort((a, b) => a - b),
    probes,
    runtime: {
      schemaVersion: 1,
      format: "runtime-inventory",
      producer: { name: "repo-verifier.vue-router", version: "1.0.0" },
      assembly: { name: config.assembly, environment: config.environment },
      sourceFingerprint: fingerprint,
      capturedAt: new Date().toISOString(),
      collections: [
        {
          kind: "routes",
          complete: entries.length === records.length,
          ordered: true,
          entries,
        },
      ],
    },
  });
  process.stdout.write(JSON.stringify(result));
}
main().catch(() => {
  process.stderr.write(
    "Vue Router startup or runtime capture could not complete\n",
  );
  process.exitCode = 2;
});
