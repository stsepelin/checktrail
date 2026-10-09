import { run } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import reporter from "./node-reporter.js";
import { javascriptSource } from "./javascript-source.js";
import { nodeLoaderManifestSchema } from "./node-loader-contract.js";
async function main() {
  const [root, encoded] = process.argv.slice(2);
  if (
    !root ||
    !encoded ||
    process.argv.length !== 4 ||
    Buffer.byteLength(encoded) > 65536
  )
    throw new Error("Invalid Node loader manifest transport");
  const manifest = nodeLoaderManifestSchema.parse(JSON.parse(encoded));
  if (
    new Set(manifest.files.map((f) => f.path)).size !== manifest.files.length ||
    new Set(manifest.loaders.map((f) => f.path)).size !==
      manifest.loaders.length
  )
    throw new Error("Duplicate Node loader manifest identity");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (
    manifest.runtime !== process.versions.node ||
    ![22, 24, 26].includes(major!) ||
    (major === 22 && minor! < 15)
  ) {
    process.stdout.write(
      JSON.stringify({
        type: "checktrail:node-loader-unavailable",
        reason: "unsupported-native-runtime",
      }) + "\n",
    );
    process.exitCode = 3;
    return;
  }
  const cwd = process.cwd();
  const resolve = async (file: string) =>
    await javascriptSource(root, path.relative(root, path.resolve(cwd, file)));
  const verify = async () => {
    for (const loader of manifest.loaders)
      if ((await resolve(loader.path)).identity.sha256 !== loader.sha256)
        throw new Error("Declared Node loader changed");
    for (const file of manifest.files) {
      const observed = (await resolve(file.path)).identity;
      if (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes)
        throw new Error("Planned native test source changed");
    }
  };
  try {
    await verify();
  } catch {
    process.stdout.write(
      JSON.stringify({
        type: "checktrail:node-loader-unavailable",
        reason: "source-or-hook-mismatch",
      }) + "\n",
    );
    process.exitCode = 3;
    return;
  }
  const execArgv = ["--no-experimental-strip-types"];
  for (const loader of manifest.loaders) {
    const resolved = (await resolve(loader.path)).resolved;
    execArgv.push(
      loader.kind === "import"
        ? `--import=${pathToFileURL(resolved).href}`
        : `--require=${resolved}`,
    );
  }
  const emit = (phase: string) =>
    process.stdout.write(
      JSON.stringify({
        type: "checktrail:node-loaders",
        phase,
        manifest,
        runtime: process.versions.node,
      }) + "\n",
    );
  emit("start");
  const events = run({
    files: manifest.files.map((f) => path.resolve(cwd, f.path)),
    execArgv,
    isolation: "process",
    concurrency: false,
  });
  let failed = false;
  events.on("test:fail", () => {
    failed = true;
  });
  for await (const line of reporter(events))
    if (!process.stdout.write(line))
      await new Promise<void>((resolve) =>
        process.stdout.once("drain", resolve),
      );
  await verify();
  emit("end");
  process.exitCode = failed ? 1 : 0;
}
main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error
      ? error.message
      : "Native Node loader execution failed") + "\n",
  );
  process.exitCode = 2;
});
