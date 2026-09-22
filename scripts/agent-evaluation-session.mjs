import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { TextDecoder } from "node:util";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const parserVersion = "subscription-jsonl-v1";
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const budgetSchema = z.strictObject({
  wallSeconds: z.number().positive().max(86400),
  maxToolCalls: integer,
  maxInputTokens: integer.nullable(),
  maxOutputTokens: integer,
});
const analysisSchema = z.strictObject({
  client: z.enum(["claude", "codex"]),
  budget: budgetSchema,
  maxEventsBytes: integer
    .positive()
    .max(32 * 1024 * 1024)
    .default(32 * 1024 * 1024),
  maxLineBytes: integer
    .positive()
    .max(2 * 1024 * 1024)
    .default(2 * 1024 * 1024),
});
const sessionSchema = analysisSchema.extend({
  executable: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().refine(path.isAbsolute),
  environment: z.record(z.string(), z.string()),
  outputDirectory: z.string().refine(path.isAbsolute),
  binding: z.strictObject({
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    subjectId: z.string().min(1),
    sessionId: z.string().min(1),
    role: z.enum(["reviewer", "judge"]),
  }),
  stdin: z.string().default(""),
  maxStderrBytes: integer
    .positive()
    .max(32 * 1024 * 1024)
    .default(1024 * 1024),
  killGraceMs: integer.positive().max(10000).default(500),
});

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function usage(value, camel = false, complete = false) {
  if (!value || typeof value !== "object") return null;
  const keys = camel
    ? [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
      ]
    : [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ];
  if (complete && (!count(value[keys[0]]) || !count(value[keys[1]])))
    return null;
  if (!keys.some((key) => value[key] !== undefined)) return null;
  if (keys.some((key) => value[key] !== undefined && !count(value[key])))
    return null;
  const input =
    (value[keys[0]] ?? 0) + (value[keys[2]] ?? 0) + (value[keys[3]] ?? 0);
  const output = value[keys[1]] ?? 0;
  return count(input) && count(output) ? { input, output } : null;
}

function submissionObject(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// Observed telemetry can stop a process; it cannot cap tokens billed before telemetry arrives.
export function createSessionMonitor(options) {
  const config = analysisSchema.parse(options);
  const violations = new Set();
  const tools = new Map();
  const messages = new Map();
  const eventIds = new Map();
  const hash = createHash("sha256");
  let bytes = 0;
  let pending = Buffer.alloc(0);
  let discardedLine = false;
  let terminal = null;
  let terminalTotals = null;
  let submission = null;
  let agentMessage = null;
  const completedMessages = new Map();
  let streamMessage = null;
  let finished = null;
  let observedInput = 0;
  let observedOutput = 0;
  let sawUsage = false;

  function checkBudget(input, output) {
    if (
      config.budget.maxInputTokens !== null &&
      input > config.budget.maxInputTokens
    )
      violations.add("input-token-budget");
    if (output > config.budget.maxOutputTokens)
      violations.add("output-token-budget");
    if (tools.size > config.budget.maxToolCalls)
      violations.add("tool-call-budget");
  }
  function updateUsage(id, value) {
    if (!value) {
      violations.add("invalid-usage");
      return;
    }
    sawUsage = true;
    const prior = messages.get(id) ?? { input: 0, output: 0 };
    const next = {
      input: Math.max(prior.input, value.input),
      output: Math.max(prior.output, value.output),
    };
    messages.set(id, next);
    observedInput += next.input - prior.input;
    observedOutput += next.output - prior.output;
    if (!count(observedInput) || !count(observedOutput))
      violations.add("invalid-usage");
    checkBudget(observedInput, observedOutput);
  }
  function addTool(id, name, args) {
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) {
      violations.add("invalid-tool-event");
      return;
    }
    const prior = tools.get(id);
    if (
      prior &&
      (prior.name !== name ||
        (args !== undefined &&
          prior.arguments !== undefined &&
          JSON.stringify(prior.arguments) !== JSON.stringify(args)))
    ) {
      violations.add("conflicting-tool-event");
      return;
    }
    tools.set(id, {
      id,
      name,
      ...(prior?.arguments !== undefined
        ? { arguments: prior.arguments }
        : args !== undefined
          ? { arguments: args }
          : {}),
    });
    checkBudget(observedInput, observedOutput);
  }
  function accept(event) {
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      typeof event.type !== "string"
    ) {
      violations.add("malformed-event");
      return;
    }
    const supported =
      config.client === "claude"
        ? [
            "system",
            "assistant",
            "user",
            "rate_limit_event",
            "stream_event",
            "result",
          ]
        : [
            "thread.started",
            "turn.started",
            "item.started",
            "item.updated",
            "item.completed",
            "turn.completed",
            "turn.failed",
            "error",
          ];
    if (!supported.includes(event.type))
      violations.add("unsupported-event-type");
    const eventId = event.uuid ?? event.event_id;
    if (eventId !== undefined) {
      if (typeof eventId !== "string" || !eventId)
        violations.add("malformed-event-id");
      const encoded = JSON.stringify(event);
      if (eventIds.has(eventId)) {
        if (eventIds.get(eventId) !== encoded)
          violations.add("conflicting-event-id");
        return;
      }
      eventIds.set(eventId, encoded);
    }
    if (terminal) {
      if (JSON.stringify(event) === JSON.stringify(terminal)) return;
      violations.add("event-after-terminal");
    }
    if (config.client === "claude") {
      if (
        event.type === "system" &&
        !["init", "thinking_tokens"].includes(event.subtype)
      )
        violations.add("unsupported-system-event");
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content)
          if (!["text", "tool_result"].includes(block?.type))
            violations.add("unsupported-user-content");
      }
      if (event.type === "assistant") {
        const message = event.message;
        if (
          !message ||
          typeof message.id !== "string" ||
          !Array.isArray(message.content)
        ) {
          violations.add("malformed-assistant");
          return;
        }
        for (const block of message.content) {
          if (
            !["text", "thinking", "redacted_thinking", "tool_use"].includes(
              block?.type,
            )
          )
            violations.add("unsupported-assistant-content");
          if (block?.type === "tool_use")
            addTool(block.id, block.name, block.input);
        }
        if (message.usage !== undefined)
          updateUsage(message.id, usage(message.usage));
      }
      if (event.type === "stream_event") {
        const part = event.event;
        if (
          ![
            "message_start",
            "message_delta",
            "message_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "ping",
            "error",
          ].includes(part?.type)
        )
          violations.add("unsupported-stream-event");
        if (part?.type === "error") violations.add("provider-error");
        if (
          part?.type === "content_block_start" &&
          !["text", "thinking", "redacted_thinking", "tool_use"].includes(
            part.content_block?.type,
          )
        )
          violations.add("unsupported-assistant-content");
        if (
          part?.type === "content_block_delta" &&
          ![
            "text_delta",
            "input_json_delta",
            "thinking_delta",
            "signature_delta",
          ].includes(part.delta?.type)
        )
          violations.add("unsupported-content-delta");
        if (part?.type === "message_start") {
          streamMessage = part.message?.id;
          if (typeof streamMessage !== "string")
            violations.add("malformed-assistant");
          else if (part.message.usage !== undefined)
            updateUsage(streamMessage, usage(part.message.usage));
        }
        if (part?.type === "message_delta" && part.usage !== undefined) {
          if (!streamMessage) violations.add("orphan-usage");
          else updateUsage(streamMessage, usage(part.usage));
        }
        if (part?.type === "message_stop") streamMessage = null;
        if (
          part?.type === "content_block_start" &&
          part.content_block?.type === "tool_use"
        )
          addTool(part.content_block.id, part.content_block.name, undefined);
      }
      if (event.type === "result") {
        let totals;
        if (
          event.modelUsage &&
          typeof event.modelUsage === "object" &&
          !Array.isArray(event.modelUsage) &&
          Object.keys(event.modelUsage).length
        ) {
          const all = Object.values(event.modelUsage).map((item) =>
            usage(item, true, true),
          );
          if (all.every(Boolean))
            totals = all.reduce(
              (sum, item) => ({
                input: sum.input + item.input,
                output: sum.output + item.output,
              }),
              { input: 0, output: 0 },
            );
        } else totals = usage(event.usage, false, true);
        recordTerminal(
          event,
          totals,
          event.is_error === false && event.subtype === "success",
        );
      }
    } else {
      if (
        ["item.started", "item.updated", "item.completed"].includes(event.type)
      ) {
        const item = event.item;
        if (
          item &&
          ![
            "mcp_tool_call",
            "command_execution",
            "file_change",
            "web_search",
            "agent_message",
            "reasoning",
            "todo_list",
            "error",
          ].includes(item.type)
        )
          violations.add("unsupported-item-type");
        if (!item || typeof item.type !== "string")
          violations.add("malformed-item");
        else if (
          item.type === "agent_message" &&
          event.type === "item.completed"
        ) {
          if (
            typeof item.id !== "string" ||
            !item.id ||
            typeof item.text !== "string"
          )
            violations.add("malformed-submission-event");
          else {
            if (completedMessages.has(item.id)) {
              if (completedMessages.get(item.id) !== item.text)
                violations.add("conflicting-submission-event");
            } else {
              completedMessages.set(item.id, item.text);
              agentMessage = submissionObject(item.text);
            }
          }
        } else if (item.type === "mcp_tool_call") {
          if (
            typeof item.server !== "string" ||
            !item.server ||
            typeof item.tool !== "string" ||
            !item.tool
          )
            violations.add("invalid-tool-event");
          else
            addTool(
              item.id,
              `mcp__${item.server}__${item.tool}`,
              item.arguments,
            );
        } else if (
          !["agent_message", "reasoning", "todo_list", "error"].includes(
            item.type,
          )
        )
          addTool(
            item.id,
            item.type,
            item.arguments ??
              (item.command !== undefined
                ? { command: item.command }
                : undefined),
          );
      }
      if (event.type === "turn.completed") {
        // Codex input_tokens includes cached_input_tokens; adding the cache again double-counts it.
        const totals = usage(event.usage, false, true);
        if (
          event.usage?.cached_input_tokens !== undefined &&
          (!count(event.usage.cached_input_tokens) ||
            event.usage.cached_input_tokens > event.usage.input_tokens)
        )
          violations.add("invalid-usage");
        recordTerminal(event, totals, true);
      }
      if (event.type === "turn.failed") recordTerminal(event, null, false);
      if (event.type === "error") violations.add("provider-error");
    }
  }
  function recordTerminal(event, totals, success) {
    if (terminal && JSON.stringify(terminal) !== JSON.stringify(event))
      violations.add("multiple-terminals");
    if (!terminal) {
      terminal = event;
      submission =
        config.client === "claude"
          ? submissionObject(
              event.structured_output !== undefined
                ? event.structured_output
                : event.result,
            )
          : agentMessage;
    }
    if (!success) violations.add("terminal-failure");
    if (!totals || !count(totals.input) || !count(totals.output)) {
      violations.add("missing-terminal-usage");
      return;
    }
    if (totals.input < observedInput || totals.output < observedOutput)
      violations.add("terminal-usage-regression");
    terminalTotals ??= totals;
    checkBudget(totals.input, totals.output);
  }
  function line(value) {
    if (!value.length || (value.length === 1 && value[0] === 13)) return;
    if (value.length > config.maxLineBytes) {
      violations.add("line-overflow");
      return;
    }
    try {
      accept(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)),
      );
    } catch {
      violations.add("malformed-jsonl");
    }
  }
  return {
    feed(chunk) {
      if (finished) throw new Error("Session monitor is finalized");
      const received = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(received);
      const data = received.subarray(
        0,
        Math.max(0, config.maxEventsBytes - bytes),
      );
      bytes += received.length;
      if (bytes > config.maxEventsBytes) violations.add("events-overflow");
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        if (!discardedLine)
          line(Buffer.concat([pending, data.subarray(start, i)]));
        discardedLine = false;
        pending = Buffer.alloc(0);
        start = i + 1;
      }
      if (!discardedLine) {
        pending = Buffer.concat([pending, data.subarray(start)]);
        if (pending.length > config.maxLineBytes) {
          violations.add("line-overflow");
          discardedLine = true;
          pending = Buffer.alloc(0);
        }
      }
    },
    get violations() {
      return [...violations];
    },
    finish() {
      if (finished) return finished;
      if (pending.length) line(pending);
      if (!terminal) violations.add("missing-terminal");
      finished = {
        parserVersion,
        terminalObserved: terminal !== null,
        terminalSuccess:
          terminal !== null && !violations.has("terminal-failure"),
        inputTokens: terminalTotals?.input ?? (sawUsage ? observedInput : null),
        outputTokens:
          terminalTotals?.output ?? (sawUsage ? observedOutput : null),
        toolCalls: tools.size,
        tools: [...tools.values()],
        submission,
        violations: [...violations].sort(),
        eventsSha256: hash.digest("hex"),
        eventsBytes: bytes,
      };
      return finished;
    },
  };
}

export function analyzeSessionEvents(eventsBytes, options) {
  const monitor = createSessionMonitor(options);
  const data = Buffer.isBuffer(eventsBytes)
    ? eventsBytes
    : Buffer.from(eventsBytes);
  // Match stream analysis across arbitrary chunk boundaries, including overflow tails.
  for (let offset = 0; offset < data.length; offset += 65536)
    monitor.feed(data.subarray(offset, offset + 65536));
  return monitor.finish();
}

export async function runSession(options) {
  const { signal, ...values } = options;
  const config = sessionSchema.parse(values);
  if (signal !== undefined && !(signal instanceof globalThis.AbortSignal))
    throw new TypeError("signal must be an AbortSignal");
  if (process.platform === "win32")
    throw new Error("Session supervision requires POSIX process groups");
  await mkdir(config.outputDirectory, { mode: 0o700 });
  const eventsFile = await open(
    path.join(config.outputDirectory, "events.jsonl"),
    "wx",
    0o600,
  );
  let stderrFile;
  try {
    stderrFile = await open(
      path.join(config.outputDirectory, "stderr.txt"),
      "wx",
      0o600,
    );
  } catch (error) {
    await eventsFile.close();
    throw error;
  }
  const monitor = createSessionMonitor({
    client: config.client,
    budget: config.budget,
    maxEventsBytes: config.maxEventsBytes,
    maxLineBytes: config.maxLineBytes,
  });
  const started = performance.now();
  let stoppedReason = null;
  let stoppedAt = null;
  let killTimer;
  let forceTimer;
  let child;
  let retainedEvents = 0;
  let retainedStderr = 0;
  let writeFailure = false;
  let writes = Promise.resolve();
  let cleanup = Promise.resolve();
  function sendSignal(name) {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") stoppedReason ??= "termination-error";
    }
  }
  function stop(reason) {
    if (stoppedReason) return;
    stoppedReason = reason;
    stoppedAt = performance.now();
    sendSignal("SIGTERM");
    killTimer = setTimeout(() => sendSignal("SIGKILL"), config.killGraceMs);
    pipeDeadline();
  }
  function pipeDeadline() {
    if (forceTimer) return;
    // A detached descendant may hold a pipe open even after the process group dies.
    forceTimer = setTimeout(() => {
      stoppedReason ??= "cleanup-pipe-timeout";
      child?.stdout.destroy();
      child?.stderr.destroy();
    }, config.killGraceMs + 1000);
  }
  function groupExists() {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      // An exiting group can transiently reject signal 0; only ESRCH proves it is gone.
      if (error.code === "EPERM") return true;
      stoppedReason ??= "termination-error";
      return true;
    }
  }
  async function cleanupGroup() {
    pipeDeadline();
    const deadline = (stoppedAt ?? performance.now()) + config.killGraceMs;
    sendSignal("SIGTERM");
    while (groupExists()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        stoppedReason ??= "cleanup-timeout";
        sendSignal("SIGKILL");
        return;
      }
      await delay(Math.min(10, remaining));
    }
  }
  function retain(file, bytes) {
    writes = writes
      .then(() => file.writeFile(bytes))
      .catch(() => {
        writeFailure = true;
        stop("artifact-write-error");
      });
  }
  const aborted = () => stop("cancelled");
  let exitCode = null;
  let exitSignal = null;
  try {
    if (signal?.aborted) stoppedReason = "cancelled";
    else {
      child = spawn(config.executable, config.args, {
        cwd: config.cwd,
        env: config.environment,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        const available = config.maxEventsBytes - retainedEvents;
        const bytes = chunk.subarray(0, Math.max(0, available));
        if (bytes.length) {
          retain(eventsFile, bytes);
          monitor.feed(bytes);
          retainedEvents += bytes.length;
        }
        if (chunk.length > available) stop("events-overflow");
        else if (monitor.violations.length) stop(monitor.violations[0]);
      });
      child.stderr.on("data", (chunk) => {
        const available = config.maxStderrBytes - retainedStderr;
        const bytes = chunk.subarray(0, Math.max(0, available));
        if (bytes.length) {
          retain(stderrFile, bytes);
          retainedStderr += bytes.length;
        }
        if (chunk.length > available) stop("stderr-overflow");
      });
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") stop("stdin-error");
      });
      child.stdin.end(config.stdin);
      signal?.addEventListener("abort", aborted, { once: true });
      const wallTimer = setTimeout(
        () => stop("wall-budget"),
        config.budget.wallSeconds * 1000,
      );
      await new Promise((resolve) => {
        child.once("error", () => stop("spawn-error"));
        child.once("exit", () => {
          cleanup = cleanupGroup();
        });
        child.once("close", (code, childSignal) => {
          exitCode = code;
          exitSignal = childSignal;
          resolve();
        });
      });
      await cleanup;
      clearTimeout(wallTimer);
    }
    await writes;
  } finally {
    clearTimeout(killTimer);
    clearTimeout(forceTimer);
    signal?.removeEventListener("abort", aborted);
    await eventsFile.close();
    await stderrFile.close();
  }
  const elapsedMs = performance.now() - started;
  const analysis = monitor.finish();
  if (elapsedMs > config.budget.wallSeconds * 1000)
    stoppedReason ??= "wall-budget";
  if (analysis.violations.length) stoppedReason ??= analysis.violations[0];
  const receipt = {
    ...analysis,
    client: config.client,
    binding: config.binding,
    elapsedMs,
    exitCode,
    exitSignal,
    stoppedReason,
    complete:
      !writeFailure &&
      !stoppedReason &&
      exitCode === 0 &&
      analysis.terminalSuccess &&
      analysis.violations.length === 0,
  };
  await writeFile(
    path.join(config.outputDirectory, "metering.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length !== 4 || process.argv[3] !== "--trust-client") {
    process.stderr.write(
      "Usage: agent-evaluation-session.mjs CONFIG.json --trust-client\n",
    );
    process.exitCode = 2;
  } else {
    const controller = new globalThis.AbortController();
    const cancel = () => controller.abort();
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    try {
      const config = JSON.parse(await readFile(process.argv[2], "utf8"));
      const result = await runSession({ ...config, signal: controller.signal });
      const {
        complete,
        stoppedReason,
        elapsedMs,
        inputTokens,
        outputTokens,
        toolCalls,
      } = result;
      process.stdout.write(
        JSON.stringify({
          complete,
          stoppedReason,
          elapsedMs,
          inputTokens,
          outputTokens,
          toolCalls,
        }) + "\n",
      );
      process.exitCode = complete ? 0 : 1;
    } catch {
      process.stderr.write("Session configuration or artifact setup failed.\n");
      process.exitCode = 2;
    } finally {
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
    }
  }
}
