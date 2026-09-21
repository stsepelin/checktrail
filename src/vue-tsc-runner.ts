import { createRequire } from "node:module";
import path from "node:path";
import { withinRoot } from "./inventory.js";

async function main(): Promise<void> {
  const [entry, root, ...args] = process.argv.slice(2);
  if (!entry || !root) throw new Error("Invalid Vue compiler arguments");
  const tool = await withinRoot(root, path.relative(root, entry));
  const load = createRequire(tool);
  const resolve = async (name: string) =>
    withinRoot(root, path.relative(root, load.resolve(name)));
  const ts = load(await resolve("typescript")) as typeof import("typescript");
  const core = load(
    await resolve("@vue/language-core"),
  ) as typeof import("@vue/language-core");
  const config = core.createParsedCommandLine(
    ts,
    ts.sys,
    path.resolve("tsconfig.json"),
  );
  if (config.vueOptions.skipTemplateCodegen)
    throw new Error("Vue template checking is disabled by skipTemplateCodegen");
  const compiler = load(tool) as typeof import("vue-tsc");
  const tsc = await resolve("typescript/lib/tsc.js");
  process.argv = [process.execPath, tool, ...args];
  compiler.run(tsc);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Vue type checking failed"}\n`,
  );
  process.exitCode = 2;
});
