import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { captureProcessOutput } from "../src/process-output.js";
import { frameworkReportSemantics } from "./framework-report-semantics.js";
function report(capturedAt: string, route = "/catalog", plain = false) {
  const stdout = plain
      ? "original plain output\n"
      : JSON.stringify({
          schemaVersion: 1,
          runtime: { capturedAt, collections: [{ routes: [route] }] },
        }) + "\n",
    stderr = "",
    bytes = Buffer.byteLength(stdout);
  return [
    {
      runtime: { capturedAt, collections: [{ routes: [route] }] },
      processes: [
        {
          durationMs: 1,
          outputBytes: bytes,
          stdout,
          stderr,
          capturedOutput: captureProcessOutput(
            Buffer.from(stdout),
            Buffer.from(stderr),
            bytes,
            true,
          ),
        },
      ],
    },
  ];
}
test("framework semantic comparison validates distinct timestamped physical captures and retains changed route and plain output semantics", () => {
  const left = report("2026-10-11T00:00:00.000Z"),
    right = report("2026-10-11T00:00:00.999Z");
  right[0]!.processes[0]!.durationMs = 7;
  assert.notDeepEqual(left, right);
  assert.deepEqual(
    frameworkReportSemantics(left),
    frameworkReportSemantics(right),
  );
  assert.notDeepEqual(
    frameworkReportSemantics(left),
    frameworkReportSemantics(report("2026-10-11T00:00:00.999Z", "/different")),
  );
  const plain = report("2026-10-11T00:00:00.000Z", "/catalog", true);
  assert.deepEqual(
    frameworkReportSemantics(plain),
    frameworkReportSemantics(
      report("2026-10-11T00:00:00.999Z", "/catalog", true),
    ),
  );
  assert.equal(left[0]!.processes[0]!.stdout.includes("00.000Z"), true);
});
test("framework semantic comparison rejects inconsistent text digests lengths observed bytes and incomplete physical captures before normalization", () => {
  const original = report("2026-10-11T00:00:00.000Z");
  for (const field of [
    "text",
    "hash",
    "length",
    "observed",
    "process-observed",
    "incomplete",
  ]) {
    const changed = structuredClone(original),
      p = changed[0]!.processes[0]!;
    switch (field) {
      case "text":
        p.stdout = "different original text";
        break;
      case "hash":
        p.capturedOutput.stdout.sha256 = "0".repeat(64);
        break;
      case "length":
        p.capturedOutput.stdout.bytes++;
        break;
      case "observed":
        p.capturedOutput.observedBytes++;
        break;
      case "process-observed":
        p.outputBytes++;
        break;
      case "incomplete":
        p.capturedOutput.completeForObservedStreams = false;
        break;
    }
    assert.throws(() => frameworkReportSemantics(changed));
    assert.throws(() =>
      frameworkReportSemantics(changed, { omitProcessOutput: true }),
    );
  }
});
test("framework semantic comparison preserves runtime decisions when a profile excludes process output from equality", () => {
  const left = report("2026-10-11T00:00:00.000Z"),
    right = report("2026-10-11T00:00:00.999Z"),
    p = right[0]!.processes[0]!;
  p.stdout = "original variable transport port 23456\n";
  p.outputBytes = Buffer.byteLength(p.stdout);
  p.capturedOutput = captureProcessOutput(
    Buffer.from(p.stdout),
    Buffer.alloc(0),
    p.outputBytes,
    true,
  );
  assert.deepEqual(
    frameworkReportSemantics(left, { omitProcessOutput: true }),
    frameworkReportSemantics(right, { omitProcessOutput: true }),
  );
  assert.notDeepEqual(
    frameworkReportSemantics(left, { omitProcessOutput: true }),
    frameworkReportSemantics(report("2026-10-11T00:00:00.999Z", "/different"), {
      omitProcessOutput: true,
    }),
  );
});

test("framework semantic comparison preserves capture-like fields in runtime metadata and validates captures only at process addresses", () => {
  const left = report("2026-10-11T00:00:00.000Z"),
    right = report("2026-10-11T00:00:00.999Z");
  const metadata = {
    capturedOutput: "original declared metadata",
    stdout: "original attribute",
    outputBytes: 42,
    capturedAt: "original business timestamp",
    durationMs: 42,
  };
  const a = [{ ...left[0], metadata }],
    b = [{ ...right[0], metadata: { ...metadata } }];
  assert.deepEqual(frameworkReportSemantics(a), frameworkReportSemantics(b));
  b[0]!.metadata.capturedOutput = "changed declared metadata";
  assert.notDeepEqual(frameworkReportSemantics(a), frameworkReportSemantics(b));
  for (const field of ["capturedAt", "durationMs"] as const) {
    const changed = structuredClone(a);
    if (field === "capturedAt")
      changed[0]!.metadata.capturedAt = "different business timestamp";
    else changed[0]!.metadata.durationMs++;
    assert.notDeepEqual(
      frameworkReportSemantics(a),
      frameworkReportSemantics(changed),
    );
  }
  assert.throws(() => frameworkReportSemantics({ checks: left }));
});

test("framework semantic comparison validates tool probe captures and excludes only probe elapsed time while retaining identity status command and output", () => {
  const probe = {
    command: { executable: "python3", args: ["--version"], cwd: "." },
    exitCode: 0,
    signal: null,
    durationMs: 5,
    timedOut: false,
    cancelled: false,
    truncated: false,
    stdout: "Python 3.12.13\n",
    stderr: "",
    outputBytes: 15,
    capturedOutput: captureProcessOutput(
      Buffer.from("Python 3.12.13\n"),
      Buffer.alloc(0),
      15,
      true,
    ),
  };
  const left = [
    {
      ...report("2026-10-11T00:00:00.000Z")[0],
      tools: [
        {
          name: "python",
          source: "version-command",
          version: "3.12.13",
          status: "identified",
          process: probe,
        },
        {
          name: "original-runtime",
          source: "package-metadata",
          version: "1.0.0",
          status: "identified",
          metadata: { durationMs: 42 },
        },
      ],
    },
  ];
  const right = structuredClone(left);
  right[0]!.tools[0]!.process!.durationMs = 73;
  for (const options of [{}, { omitProcessOutput: true }]) {
    assert.deepEqual(
      frameworkReportSemantics(left, options),
      frameworkReportSemantics(right, options),
    );
    for (const field of [
      "name",
      "source",
      "version",
      "status",
      "command",
      "exit",
      "signal",
      "timeout",
      "cancel",
      "truncated",
      "output",
      "metadata",
    ]) {
      const changed = structuredClone(right),
        tool = changed[0]!.tools[0]!,
        p = tool.process!;
      switch (field) {
        case "name":
          tool.name = "different-tool";
          break;
        case "source":
          tool.source = "different-source";
          break;
        case "version":
          tool.version = "0.0.0";
          break;
        case "status":
          tool.status = "unavailable";
          break;
        case "command":
          p.command.args = ["different-command"];
          break;
        case "exit":
          p.exitCode = 1;
          break;
        case "signal":
          Object.assign(p, { signal: "SIGTERM" });
          break;
        case "timeout":
          p.timedOut = true;
          break;
        case "cancel":
          p.cancelled = true;
          break;
        case "truncated":
          p.truncated = true;
          break;
        case "output": {
          p.stdout = "Python 0.00.00\n";
          p.outputBytes = Buffer.byteLength(p.stdout);
          p.capturedOutput = captureProcessOutput(
            Buffer.from(p.stdout),
            Buffer.alloc(0),
            p.outputBytes,
            true,
          );
          break;
        }
        case "metadata":
          changed[0]!.tools[1]!.metadata!.durationMs++;
          break;
      }
      assert.notDeepEqual(
        frameworkReportSemantics(left, options),
        frameworkReportSemantics(changed, options),
        field,
      );
    }
    for (const field of ["text", "hash", "length", "observed", "incomplete"]) {
      const changed = structuredClone(right),
        p = changed[0]!.tools[0]!.process!;
      switch (field) {
        case "text":
          p.stdout = "different text";
          break;
        case "hash":
          p.capturedOutput.stdout.sha256 = "0".repeat(64);
          break;
        case "length":
          p.capturedOutput.stdout.bytes++;
          break;
        case "observed":
          p.outputBytes++;
          break;
        case "incomplete":
          p.capturedOutput.completeForObservedStreams = false;
          break;
      }
      assert.throws(
        () => frameworkReportSemantics(changed, options),
        (error: unknown) => error instanceof Error,
        field,
      );
    }
  }
  assert.equal(left[0]!.tools[0]!.process!.durationMs, 5);
});
