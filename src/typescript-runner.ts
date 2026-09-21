import { createRequire } from "node:module";
import path from "node:path";
import { withinRoot } from "./inventory.js";
import { typecheckArguments } from "./typescript-arguments.js";

async function main(): Promise<void> {
  const [entry, root, ...args] = process.argv.slice(2);
  if (!entry || !root) throw new Error("Invalid TypeScript compiler arguments");
  const tool = await withinRoot(root, path.relative(root, entry));
  const api = await withinRoot(
    root,
    path.relative(
      root,
      path.resolve(path.dirname(tool), "../lib/typescript.js"),
    ),
  );
  const load = createRequire(tool);
  const ts = load(api) as typeof import("typescript");
  process.argv = [process.execPath, tool, ...typecheckArguments(ts, args)];
  load(tool);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "TypeScript checking failed"}\n`,
  );
  process.exitCode = 2;
});
