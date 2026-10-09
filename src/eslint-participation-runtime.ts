import { createHash } from "node:crypto";
import path from "node:path";
import { types } from "node:util";
import type {
  ESLintParticipationTrace,
  ESLintSourceIdentity,
} from "./eslint-participation.js";
type NativeFile = { path: string; physicalPath: string; rawBody: unknown };
type NativeFunction = (this: unknown, ...args: unknown[]) => unknown;
type NativeConfiguration = {
  language: object;
  processor?: object;
  rules?: Record<string, unknown>;
};
/** Instrument each recursively selected native Config once; never replay a callback. */
export function observeESLintParticipation(
  prototype: object,
  physicalPath: string,
) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "getConfig");
  if (
    !descriptor ||
    typeof descriptor.value !== "function" ||
    !descriptor.configurable
  )
    throw new Error("Unsupported native config API");
  const getConfig = descriptor.value as NativeFunction;
  const originals = new Map<
    NativeConfiguration,
    { language: object; processor: object | undefined }
  >();
  const trace: ESLintParticipationTrace = { complete: true, events: [] };
  let nextId = 0,
    totalBytes = 0;
  const identity = (filename: unknown, body: unknown): ESLintSourceIdentity => {
    if (
      typeof filename !== "string" ||
      typeof body !== "string" ||
      filename.length > 8192 ||
      filename.includes("\0") ||
      !(
        filename === physicalPath ||
        filename.startsWith(physicalPath + path.sep)
      )
    )
      throw new Error("Unsupported virtual source identity");
    if (Buffer.from(body, "utf8").toString("utf8") !== body)
      throw new Error("Unsupported non-scalar virtual source text");
    const bytes = Buffer.byteLength(body);
    totalBytes += bytes;
    if (
      bytes > 8 * 1024 * 1024 ||
      totalBytes > 64 * 1024 * 1024 ||
      trace.events.length >= 3072
    )
      throw new Error("Native source participation exceeds bounds");
    return {
      path: filename,
      bytes,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  };
  Object.defineProperty(prototype, "getConfig", {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const config = getConfig.apply(this, args) as
        NativeConfiguration | undefined;
      if (config && !originals.has(config)) {
        const language = config.language,
          processor = config.processor;
        originals.set(config, { language, processor });
        config.language = new Proxy(language, {
          get(target, key) {
            const value = Reflect.get(target, key, target) as unknown;
            if (key === "parse" && typeof value === "function")
              return function (file: NativeFile, options: unknown) {
                try {
                  if (file.physicalPath !== physicalPath)
                    throw new Error("Native physical source identity differs");
                  const event: Extract<
                    ESLintParticipationTrace["events"][number],
                    { kind: "parse" }
                  > = {
                    kind: "parse",
                    input: identity(file.path, file.rawBody),
                    successful: false,
                    activeRules: Object.values(config.rules ?? {}).filter(
                      (rule) => {
                        const severity = Array.isArray(rule) ? rule[0] : rule;
                        return [1, 2, "warn", "error"].includes(
                          severity as string | number,
                        );
                      },
                    ).length,
                  };
                  trace.events.push(event);
                  const result = (value as NativeFunction).call(
                    target,
                    file,
                    options,
                  );
                  if (
                    result === null ||
                    typeof result !== "object" ||
                    typeof (result as { ok?: unknown }).ok !== "boolean"
                  )
                    trace.complete = false;
                  else event.successful = (result as { ok: boolean }).ok;
                  return result;
                } catch (error) {
                  trace.complete = false;
                  throw error;
                }
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        if (processor) {
          const stack: number[] = [];
          config.processor = new Proxy(processor, {
            get(target, key) {
              const value = Reflect.get(target, key, target) as unknown;
              if (key === "preprocess" && typeof value === "function")
                return function (
                  this: unknown,
                  body: unknown,
                  filename: unknown,
                ) {
                  try {
                    if (nextId >= 1024)
                      throw new Error("Native processor count exceeds bounds");
                    const id = nextId++;
                    const event: Extract<
                      ESLintParticipationTrace["events"][number],
                      { kind: "preprocess" }
                    > = {
                      kind: "preprocess",
                      id,
                      input: identity(filename, body),
                      outputs: [],
                    };
                    trace.events.push(event);
                    stack.push(id);
                    const outputs = (value as NativeFunction).call(
                      this,
                      body,
                      filename,
                    );
                    if (
                      !Array.isArray(outputs) ||
                      types.isProxy(outputs) ||
                      Object.getPrototypeOf(outputs) !== Array.prototype ||
                      outputs.length > 1024
                    )
                      throw new Error("Unsupported native processor blocks");
                    const blocks: unknown[] = [];
                    for (let i = 0; i < outputs.length; i++) {
                      const element = Object.getOwnPropertyDescriptor(
                        outputs,
                        String(i),
                      );
                      if (!element || !("value" in element))
                        throw new Error(
                          "Opaque or sparse processor block arrays are unsupported",
                        );
                      blocks.push(element.value);
                    }
                    event.outputs = blocks.map(
                      (block: unknown, index: number) => {
                        if (typeof block === "string")
                          return identity(filename, block);
                        if (
                          block === null ||
                          typeof block !== "object" ||
                          types.isProxy(block)
                        )
                          throw new Error("Unsupported native processor block");
                        const filenameProperty =
                          Object.getOwnPropertyDescriptor(block, "filename");
                        const textProperty = Object.getOwnPropertyDescriptor(
                          block,
                          "text",
                        );
                        if (
                          !filenameProperty ||
                          !textProperty ||
                          !("value" in filenameProperty) ||
                          !("value" in textProperty) ||
                          typeof filenameProperty.value !== "string" ||
                          typeof textProperty.value !== "string"
                        )
                          throw new Error(
                            "Opaque processor block properties are unsupported",
                          );
                        const named = {
                          filename: filenameProperty.value as string,
                          text: textProperty.value as string,
                        };
                        return identity(
                          path.join(
                            filename as string,
                            `${index}_${named.filename}`,
                          ),
                          named.text,
                        );
                      },
                    );
                    return outputs;
                  } catch (error) {
                    trace.complete = false;
                    throw error;
                  }
                };
              if (key === "postprocess" && typeof value === "function")
                return function (this: unknown, ...args: unknown[]) {
                  try {
                    const id = stack.pop();
                    if (id === undefined || trace.events.length >= 3072)
                      throw new Error("Unsupported native postprocessor order");
                    const result = (value as NativeFunction).apply(this, args);
                    trace.events.push({ kind: "postprocess", id });
                    return result;
                  } catch (error) {
                    trace.complete = false;
                    throw error;
                  }
                };
              return value;
            },
          });
        }
      }
      return config;
    },
  });
  return {
    trace,
    restore() {
      for (const [config, original] of originals) {
        config.language = original.language;
        if (original.processor === undefined) delete config.processor;
        else config.processor = original.processor;
      }
      Object.defineProperty(prototype, "getConfig", descriptor);
    },
  };
}
