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
  const jsonActual = boundedJsonResult(actual);
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
      profile: "node-export-json-v1",
      actual: jsonActual,
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

// Require an actual JSON value, without silently invoking getters/toJSON or losing
// holes, extra properties, unsupported prototypes, non-finite numbers or -0.
function boundedJsonResult(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 16)
      throw new Error("JSON result exceeds structural limits");
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return item;
    if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      !Object.is(item, -0)
    )
      return item;
    if (typeof item !== "object") throw new Error("Result is not a JSON value");
    if (seen.has(item))
      throw new Error("JSON result contains circular references");
    seen.add(item);
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("JSON result prototype is unsupported");
    if (Object.getOwnPropertySymbols(item).length)
      throw new Error("JSON result has symbol properties");
    const properties = Object.getOwnPropertyDescriptors(item);
    const keys = Object.keys(properties).filter(
      (key) => !(array && key === "length"),
    );
    for (const key of keys) {
      const descriptor = properties[key]!;
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new Error("JSON result has hidden or accessor properties");
    }
    if (array) {
      if (
        keys.length !== item.length ||
        keys.some((key, index) => key !== String(index))
      )
        throw new Error("JSON result has holes or extra array properties");
      const result = keys.map((key) =>
        visit(properties[key]!.value, depth + 1),
      );
      seen.delete(item);
      return result;
    }
    const result = Object.fromEntries(
      keys.map((key) => [key, visit(properties[key]!.value, depth + 1)]),
    );
    seen.delete(item);
    return result;
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized)) > 16384)
    throw new Error("JSON result exceeds physical value byte limit");
  return normalized;
}
