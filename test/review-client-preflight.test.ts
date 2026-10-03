import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Development probe module intentionally has no production type declarations.
import * as evidence from "../../scripts/review-client-request-evidence.mjs";
const { inspectClientRequest, inspectClientEvents } = evidence;
const source =
  'export function decision(value){return value === "original-case";}\n';
const assignment = {
  source,
  system: "Original pinned system policy",
  prompt: JSON.stringify({ files: [{ path: "subject.mjs", content: source }] }),
};
const request = () => ({
  model: "original-model",
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: assignment.prompt }],
    },
  ],
  tools: [],
});

test("native client request evidence decodes assigned JSON source and reconciles text categories", () => {
  const result = inspectClientRequest(
    request(),
    assignment,
    ["original-hidden"],
    ["original-prior"],
  );
  assert.equal(result.assignedSourceIncluded, true);
  assert.equal(result.malformedRequest, false);
  assert.deepEqual(result.userTextCounts, {
    selectedAssignment: 1,
    other: 0,
    total: 1,
  });
  assert.equal(result.hostReviewRulesDetected, false);
  assert.equal(result.originalCanariesIncluded, false);
  assert.equal(result.priorAssignmentIncluded, false);
  const missing = request();
  missing.input[0]!.content[0]!.text = JSON.stringify({ files: [] });
  assert.equal(
    inspectClientRequest(missing, assignment, [], []).assignedSourceIncluded,
    false,
  );
});

test("native client evidence separates host instruction leakage from identical words in assigned source", () => {
  const leaked = request();
  leaked.input.unshift({
    role: "developer",
    content: [
      { type: "input_text", text: "The review bar and original-hidden" },
    ],
  });
  const bad = inspectClientRequest(leaked, assignment, ["original-hidden"], []);
  assert.equal(bad.hostReviewRulesDetected, true);
  assert.deepEqual(bad.hostReviewRulesLocations, ["input/0/content/0/text"]);
  assert.equal(bad.originalCanariesIncluded, true);
  const otherSource =
    "export function decision(){return false;} // The review bar\n";
  const selected = {
    ...assignment,
    source: otherSource,
    prompt: JSON.stringify({
      files: [{ path: "subject.mjs", content: otherSource }],
    }),
  };
  const valid = request();
  valid.input[0]!.content[0]!.text = selected.prompt;
  const good = inspectClientRequest(valid, selected, [], []);
  assert.equal(good.assignedSourceIncluded, true);
  assert.equal(good.hostReviewRulesDetected, false);
  assert.equal(JSON.stringify(good).includes(otherSource), false);
});

test("native client request evidence retains malformed source duplicate assignments history and tool exposure", () => {
  for (const body of [null, [], { input: {} }, { tools: {} }])
    assert.equal(
      inspectClientRequest(body, assignment, [], []).malformedRequest,
      true,
    );
  const duplicate = request();
  duplicate.input.push(duplicate.input[0]!);
  assert.deepEqual(
    inspectClientRequest(duplicate, assignment, [], []).userTextCounts,
    { selectedAssignment: 2, other: 0, total: 2 },
  );
  const prior = {
    ...request(),
    previous_response_id: null,
    conversation: "original-prior",
    tools: [{ type: "function", name: "request_user_input" }],
  };
  const result = inspectClientRequest(
    prior,
    assignment,
    [],
    ["original-prior"],
  );
  assert.equal(result.previousResponse, true);
  assert.equal(result.conversation, true);
  assert.equal(result.priorAssignmentIncluded, true);
  assert.deepEqual(result.tools, ["request_user_input"]);
});

test("native client event evidence rejects malformed streams duplicate sessions missing completion and changed output", () => {
  const id = "00112233-4455-6677-8899-aabbccddeeff";
  const output = '{"result":"original"}';
  const codex = [
    { type: "thread.started", thread_id: id },
    { type: "item.completed", item: { type: "agent_message", text: output } },
    { type: "turn.completed" },
  ];
  const inspect = (events: unknown[], kind = "codex") =>
    inspectClientEvents(
      events.map((event) => JSON.stringify(event)).join("\n"),
      kind,
      "exact-model",
      "exact-version",
      output,
    );
  const good = inspect(codex);
  assert.equal(good.singleNativeSessionStart, true);
  assert.equal(good.nativeCompletionObserved, true);
  assert.equal(good.outputContractObserved, true);
  assert.equal(good.nativeSessionId, id);
  assert.equal(inspect([...codex, codex[0]]).singleNativeSessionStart, false);
  assert.equal(inspect(codex.slice(0, -1)).nativeCompletionObserved, false);
  assert.equal(
    inspect([
      codex[0],
      {
        type: "item.completed",
        item: { type: "agent_message", text: "wrong" },
      },
      codex[2],
    ]).outputContractObserved,
    false,
  );
  assert.equal(
    inspectClientEvents(
      "not json",
      "codex",
      "exact-model",
      "exact-version",
      output,
    ).malformedEventStream,
    true,
  );
  const claude = [
    {
      type: "system",
      subtype: "init",
      session_id: id,
      model: "exact-model",
      claude_code_version: "exact-version",
      tools: [],
      mcp_servers: [],
    },
    { type: "result", subtype: "success", is_error: false, result: output },
  ];
  assert.equal(inspect(claude, "claude").inconsistentSessionIds, false);
  assert.equal(
    inspect(
      [
        ...claude,
        {
          type: "assistant",
          session_id: "ffeeddcc-bbaa-9988-7766-554433221100",
        },
      ],
      "claude",
    ).inconsistentSessionIds,
    true,
  );
  assert.equal(inspect(claude, "claude").runtimeModelObserved, true);
  assert.equal(inspect(claude, "claude").runtimeVersionObserved, true);
  assert.equal(inspect(claude, "claude").runtimeToolsAbsent, true);
  assert.equal(inspect(claude, "claude").runtimeMcpAbsent, true);
  claude[0]!.model = "changed-model";
  claude[0]!.claude_code_version = "changed-version";
  assert.equal(inspect(claude, "claude").runtimeModelObserved, false);
  assert.equal(inspect(claude, "claude").runtimeVersionObserved, false);
});
