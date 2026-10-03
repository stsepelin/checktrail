import { createServer } from "node:http";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  inspectClientRequest,
  inspectClientEvents,
} from "./review-client-request-evidence.mjs";
import { createHash, randomUUID } from "node:crypto";
const { values } = parseArgs({
  options: {
    "codex-executable": { type: "string", default: "codex" },
    "claude-executable": { type: "string", default: "claude" },
    "codex-version": { type: "string" },
    "claude-version": { type: "string" },
    "log-dir": { type: "string" },
  },
});
if (!values["codex-version"] || !values["claude-version"])
  throw new Error(
    "Pin both native client versions before the synthetic preflight",
  );
const clients = {
  codex: values["codex-executable"],
  claude: values["claude-executable"],
};
const clientVersions = {};
for (const kind of ["codex", "claude"]) {
  const result = spawnSync(clients[kind], ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
  });
  if (result.error || result.status !== 0)
    throw new Error("Native client version is unavailable");
  const version =
    kind === "codex"
      ? result.stdout.trim().replace(/^codex-cli /, "")
      : result.stdout.trim().replace(/ \(Claude Code\)$/, "");
  if (version !== values[kind + "-version"])
    throw new Error("Native client version does not match the operator pin");
  clientVersions[kind] = version;
}
const models = {
  codex: "synthetic-exact-session-model",
  claude: "claude-sonnet-4-6",
};
const expectedOutput = '{"result":"Original synthetic transport response"}';
let logDirectory;
if (values["log-dir"]) {
  await mkdir(values["log-dir"], { recursive: true, mode: 0o700 });
  logDirectory = await mkdtemp(path.join(values["log-dir"], "attempts-"));
}
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1)
  throw new Error("Managed assigned port required");
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-client-canaries-"),
);
const results = [];
let server;
try {
  const cwd = path.join(temporary, "assignment");
  await mkdir(cwd);
  const canaries = [
    "OriginalParentInstruction" + randomUUID(),
    "OriginalProjectInstruction" + randomUUID(),
    "OriginalHiddenAnswer" + randomUUID(),
  ];
  await writeFile(path.join(temporary, "AGENTS.md"), canaries[0]);
  await writeFile(path.join(cwd, "AGENTS.md"), canaries[1]);
  await writeFile(path.join(temporary, "CLAUDE.md"), canaries[0]);
  await writeFile(path.join(cwd, "CLAUDE.md"), canaries[1]);
  await writeFile(path.join(temporary, "hidden-answer.mjs"), canaries[2]);
  await mkdir(path.join(cwd, ".codex"));
  await writeFile(
    path.join(cwd, ".codex/config.toml"),
    'developer_instructions="' + canaries[1] + '"\n',
  );
  await mkdir(path.join(cwd, ".claude"));
  await writeFile(
    path.join(cwd, ".claude/settings.json"),
    JSON.stringify({ env: { ORIGINAL_FORBIDDEN_CLIENT_SETTING: canaries[1] } }),
  );
  const system =
    "You are an independent original synthetic reviewer. Read only the supplied assignment. Return the required JSON. Do not use tools or previous context.";
  const policyFile = path.join(temporary, "instructions.md");
  await writeFile(policyFile, system);
  const schemaFile = path.join(temporary, "output.json");
  const schema = {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    additionalProperties: false,
  };
  await writeFile(schemaFile, JSON.stringify(schema));
  let selected,
    records = [];
  server = createServer(async (req, res) => {
    const chunks = [];
    let requestBytes = 0;
    for await (const chunk of req) {
      requestBytes += chunk.length;
      if (requestBytes > 2097152) {
        res.writeHead(413);
        res.end("{}");
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = {};
    }
    const inspected = inspectClientRequest(
      body,
      selected,
      canaries,
      results.map((previous) => previous.assignmentCanary),
    );
    records.push({
      method: req.method,
      path: req.url,
      bytes: raw.length,
      ...inspected,
      requestDigest: createHash("sha256").update(raw).digest("hex"),
    });
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":100}');
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    const output = expectedOutput;
    if (selected.kind === "codex") {
      const item = {
        id: "msg_original_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: output, annotations: [] }],
      };
      const response = {
        id: "resp_original_fixture",
        object: "response",
        created_at: 0,
        status: "completed",
        model: body.model,
        output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      };
      emit("response.created", {
        response: { ...response, status: "in_progress", output: [] },
      });
      emit("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response });
    } else {
      emit("message_start", {
        message: {
          id: "msg_original_fixture",
          type: "message",
          role: "assistant",
          content: [],
          model: body.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
      emit("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      emit("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: output },
      });
      emit("content_block_stop", { index: 0 });
      emit("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      emit("message_stop", {});
    }
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const inherited = Object.fromEntries(
    ["PATH", "HOME", "CODEX_HOME", "LANG", "LC_ALL", "TMPDIR"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  for (const kind of ["codex", "claude"])
    for (const sequence of [0, 1]) {
      const assignmentCanary = "OriginalAssignedCase" + randomUUID();
      const source = `export function decision(value){return value==="${assignmentCanary}";}\n`;
      const prompt = JSON.stringify({
        task: "Inspect only this original synthetic assignment.",
        files: [{ path: "subject.mjs", content: source }],
      });
      selected = { kind, source, prompt, system };
      records = [];
      let args, executable, environment;
      if (kind === "codex") {
        executable = clients.codex;
        args = [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--strict-config",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--cd",
          cwd,
          "--json",
          "--color",
          "never",
          "--output-schema",
          schemaFile,
          "-c",
          'model_provider="original_test"',
          "-c",
          'model="synthetic-exact-session-model"',
          "-c",
          'model_providers.original_test.name="Original native-client transport fixture"',
          "-c",
          `model_providers.original_test.base_url="http://127.0.0.1:${port}/v1"`,
          "-c",
          'model_providers.original_test.env_key="CHECKTRAIL_SYNTHETIC_CLIENT_KEY"',
          "-c",
          'model_providers.original_test.wire_api="responses"',
          "-c",
          "model_providers.original_test.requires_openai_auth=false",
          "-c",
          "model_providers.original_test.request_max_retries=0",
          "-c",
          "model_providers.original_test.stream_max_retries=0",
          "-c",
          "model_providers.original_test.stream_idle_timeout_ms=2000",
          "-c",
          "model_providers.original_test.supports_websockets=false",
          "-c",
          'developer_instructions=""',
          "-c",
          `model_instructions_file=${JSON.stringify(policyFile)}`,
          "-c",
          "analytics.enabled=false",
          "-c",
          'web_search="disabled"',
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          "features.skip_host_skill_discovery=true",
          "-c",
          "mcp_servers={}",
          "-c",
          `log_dir=${JSON.stringify(path.join(temporary, "logs"))}`,
          "-c",
          `sqlite_home=${JSON.stringify(path.join(temporary, "sqlite"))}`,
        ];
        for (const feature of [
          "apps",
          "browser_use",
          "browser_use_external",
          "computer_use",
          "in_app_browser",
          "in_app_chat",
          "in_app_local_automation",
          "image_generation",
          "view_image",
          "plugins",
          "plugin_sharing",
          "remote_plugin",
          "skill_search",
          "skill_mcp_dependency_install",
          "memories",
          "external_agent_memory_import",
          "shell_snapshot",
          "shell_tool",
          "unified_exec",
          "code_mode",
          "code_mode_host",
          "multi_agent",
          "multi_agent_v2",
          "goals",
          "hooks",
          "sleep_tool",
          "tool_suggest",
          "request_permissions_tool",
          "unbounded_connection_retries",
          "workspace_dependencies",
          "daemon_auto_start",
          "default_mode_request_user_input",
        ])
          args.push("--disable", feature);
        args.push("-");
        environment = {
          ...inherited,
          CHECKTRAIL_SYNTHETIC_CLIENT_KEY:
            "original-synthetic-client-credential",
        };
      } else {
        executable = clients.claude;
        args = [
          "--print",
          "--safe-mode",
          "--restricted",
          "--tools",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--disable-slash-commands",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--permission-prompts",
          "none",
          "--setting-sources",
          "",
          "--system-prompt",
          system,
          "--model",
          "claude-sonnet-4-6",
          "--output-format",
          "stream-json",
          "--verbose",
        ];
        environment = {
          ...inherited,
          ANTHROPIC_API_KEY: "original-synthetic-client-credential",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          DISABLE_AUTOUPDATER: "1",
        };
      }
      const child = spawn(executable, args, {
        cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "",
        stderr = "",
        bytes = 0,
        timedOut = false,
        outputTruncated = false;
      const stop = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const collect = (data, err) => {
        bytes += data.length;
        if (bytes > 1048576) {
          outputTruncated = true;
          stop();
        } else if (err) stderr += data.toString();
        else stdout += data.toString();
      };
      child.stdout.on("data", (data) => collect(data, false));
      child.stderr.on("data", (data) => collect(data, true));
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, 20000);
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
      let exit;
      try {
        exit = await new Promise((resolve) => {
          child.once("error", () =>
            resolve({ code: null, signal: null, launchFailed: true }),
          );
          child.once("close", (code, signal) =>
            resolve({ code, signal, launchFailed: false }),
          );
        });
      } finally {
        clearTimeout(timer);
      }
      if (logDirectory) {
        await writeFile(
          path.join(logDirectory, `${kind}-${sequence}-stdout.log`),
          stdout,
          { mode: 0o600 },
        );
        await writeFile(
          path.join(logDirectory, `${kind}-${sequence}-stderr.log`),
          stderr,
          { mode: 0o600 },
        );
      }
      const inferenceRecords = records.filter(
        (record) =>
          record.method === "POST" &&
          record.path?.split("?")[0] ===
            (kind === "codex" ? "/v1/responses" : "/v1/messages"),
      );
      const nativeEvents = inspectClientEvents(
        stdout,
        kind,
        models[kind],
        clientVersions[kind],
        expectedOutput,
      );
      const distinctNativeSession =
        nativeEvents.nativeSessionId !== null &&
        !results.some(
          (previous) =>
            previous.nativeEvents.nativeSessionId ===
            nativeEvents.nativeSessionId,
        );
      let ownedMessagingSocketRemoved = null;
      if (kind === "claude") {
        const init = stdout.split("\n").flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event.type === "system" && event.subtype === "init"
              ? [event]
              : [];
          } catch {
            return [];
          }
        })[0];
        // Only inspect this child's declared socket; never delete other client resources.
        const socket = init?.messaging_socket_path;
        if (
          typeof socket === "string" &&
          socket === `/tmp/cc-socks/${child.pid}.sock`
        ) {
          try {
            await stat(socket);
            ownedMessagingSocketRemoved = false;
          } catch (error) {
            ownedMessagingSocketRemoved = error?.code === "ENOENT";
          }
        }
      }
      const constructionObserved =
        exit.code === 0 &&
        !exit.launchFailed &&
        !timedOut &&
        !outputTruncated &&
        !nativeEvents.malformedEventStream &&
        !nativeEvents.inconsistentSessionIds &&
        nativeEvents.singleNativeSessionStart &&
        nativeEvents.nativeCompletionObserved &&
        nativeEvents.outputContractObserved &&
        distinctNativeSession &&
        (kind !== "claude" ||
          (nativeEvents.runtimeModelObserved &&
            nativeEvents.runtimeVersionObserved &&
            nativeEvents.runtimeToolsAbsent &&
            nativeEvents.runtimeMcpAbsent &&
            ownedMessagingSocketRemoved)) &&
        bytes <= 1048576 &&
        inferenceRecords.length === 1 &&
        inferenceRecords.every(
          (record) =>
            !record.malformedRequest &&
            record.model === models[kind] &&
            record.assignedSourceIncluded &&
            record.userTextCounts.selectedAssignment === 1 &&
            !record.originalCanariesIncluded &&
            !record.priorAssignmentIncluded &&
            !record.previousResponse &&
            !record.conversation,
        );
      const rejectedInstructionOrToolScope = inferenceRecords.some(
        (record) =>
          record.hostReviewRulesDetected ||
          record.agentInstructionMessages.length > 0 ||
          record.tools.length > 0,
      );
      const result = {
        kind,
        clientVersion: clientVersions[kind],
        sequence,
        assignmentCanary,
        exit,
        timedOut,
        outputTruncated,
        nativeEvents,
        distinctNativeSession,
        ownedMessagingSocketRemoved,
        records,
        constructionObserved,
        rejectedInstructionOrToolScope,
        subscriptionProfileAccepted: false,
        actualProviderInference: false,
        subscriptionAuthExercised: false,
        ownedChildClosed: !exit.launchFailed,
        processTreeCleanupVerified: false,
      };
      results.push(result);
    }
} finally {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
const result = {
  schemaVersion: 1,
  purpose: "original-synthetic-native-client-construction-diagnostic",
  results,
  ownedTemporaryArtifactsRemoved: true,
  retainedPrivateLogs: Boolean(logDirectory),
  realInferenceRequests: 0,
  subscriptionProfilesAccepted: false,
  qualityGate: "not-assessed",
};
process.stdout.write(JSON.stringify(result) + "\n");
// A diagnostic receipt is not a passing subscription acceptance profile.
process.exitCode = results.every(
  (item) => item.constructionObserved && !item.rejectedInstructionOrToolScope,
)
  ? 0
  : 2;
