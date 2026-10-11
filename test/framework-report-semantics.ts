import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  captureProcessOutput,
  parseCapturedProcessOutput,
} from "../src/process-output.js";

/** Compare independent framework runs after validating each original physical capture. */
export function frameworkReportSemantics(
  input: unknown,
  options: { omitProcessOutput?: boolean } = {},
): unknown {
  assert.ok(
    Array.isArray(input),
    "Framework comparison requires the check array",
  );
  const normalizeText = (text: string): string => {
    if (!text.startsWith("{")) return text;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return text;
    }
    return JSON.stringify(normalize(value, "raw"));
  };
  function normalize(
    value: unknown,
    context: "ordinary" | "check" | "process" | "raw" | "runtime" = "ordinary",
  ): unknown {
    if (Array.isArray(value))
      return value.map((item) => normalize(item, context));
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    let normalizedCapture: unknown;
    if (context === "process" && Object.hasOwn(object, "capturedOutput")) {
      const captured = parseCapturedProcessOutput(object.capturedOutput);
      if (Object.hasOwn(object, "outputBytes"))
        assert.equal(
          object.outputBytes,
          captured.observedBytes,
          "Framework observed output differs from its physical capture",
        );
      assert.equal(
        captured.completeForObservedStreams,
        true,
        "Framework transport comparison requires complete physical output",
      );
      for (const name of ["stdout", "stderr"] as const) {
        assert.equal(
          typeof object[name],
          "string",
          "Framework process output text is missing",
        );
        assert.ok(
          Buffer.from(object[name] as string).equals(
            Buffer.from(captured[name].base64, "base64"),
          ),
          "Framework physical capture differs from original process text",
        );
      }
      if (options.omitProcessOutput)
        normalizedCapture = {
          profile: captured.profile,
          completeForObservedStreams: captured.completeForObservedStreams,
        };
      else {
        const stdout = Buffer.from(normalizeText(object.stdout as string)),
          stderr = Buffer.from(normalizeText(object.stderr as string));
        normalizedCapture = captureProcessOutput(
          stdout,
          stderr,
          stdout.length + stderr.length,
          true,
        );
      }
    }
    return Object.fromEntries(
      Object.entries(object)
        .filter(
          ([key]) =>
            !(context === "process" && key === "durationMs") &&
            !(context === "runtime" && key === "capturedAt") &&
            !(
              context === "process" &&
              options.omitProcessOutput &&
              ["stdout", "stderr", "outputBytes"].includes(key)
            ),
        )
        .map(([key, item]) => {
          if (key === "capturedOutput" && normalizedCapture)
            return [key, normalizedCapture];
          if (
            context === "process" &&
            (key === "stdout" || key === "stderr") &&
            typeof item === "string"
          )
            return [key, normalizeText(item)];
          if (
            context === "process" &&
            key === "outputBytes" &&
            normalizedCapture
          )
            return [
              key,
              parseCapturedProcessOutput(normalizedCapture).observedBytes,
            ];
          return [
            key,
            normalize(
              item,
              context === "check" && key === "processes"
                ? "process"
                : (context === "check" || context === "raw") &&
                    key === "runtime"
                  ? "runtime"
                  : "ordinary",
            ),
          ];
        }),
    );
  }
  return input.map((check) => normalize(check, "check"));
}
