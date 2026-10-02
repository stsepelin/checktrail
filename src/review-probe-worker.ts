// Engine-owned native worker. Project code is operator-trusted, not sandboxed.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const session = new Session();
try {
  const bytes = await readFile(process.argv[2]!);
  const input = JSON.parse(bytes.toString("utf8")) as {
    file: string;
    exportName: string;
    args: unknown[];
  };
  const target = pathToFileURL(path.resolve("source", input.file)).href;
  session.connect();
  await session.post("Debugger.enable");
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
  const module = (await import(target)) as Record<string, unknown>;
  const callable = module[input.exportName];
  if (typeof callable !== "function") throw new Error("Export is not callable");
  const actual: unknown = await Reflect.apply(callable, undefined, input.args);
  if (typeof actual !== "boolean")
    throw new Error("Export result is not boolean");
  const coverage = await session.post("Profiler.takePreciseCoverage");
  const functions =
    coverage.result
      .find((script) => script.url === target)
      ?.functions.filter(
        (fn) => fn.functionName === input.exportName && fn.ranges[0]!.count > 0,
      ) ?? [];
  if (functions.length !== 1)
    throw new Error("Named function execution is not unambiguous");
  const fn = functions[0]!;
  const script = coverage.result.find((script) => script.url === target)!;
  const nativeSource = await session.post("Debugger.getScriptSource", {
    scriptId: script.scriptId,
  });
  process.stdout.write(
    JSON.stringify({
      requestDigest: createHash("sha256").update(bytes).digest("hex"),
      actual,
      sourceDigest: createHash("sha256")
        .update(nativeSource.scriptSource)
        .digest("hex"),
      functionRange: {
        start: fn.ranges[0]!.startOffset,
        end: fn.ranges[0]!.endOffset,
      },
      ranges: fn.ranges.map((range) => ({
        start: range.startOffset,
        end: range.endOffset,
        count: range.count,
      })),
    }),
  );
} catch {
  process.stdout.write(JSON.stringify({ failure: "probe-runtime-error" }));
  process.exitCode = 2;
} finally {
  session.disconnect();
}
