import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Operator measurement module has no production type declarations.
import * as evidence from "../../scripts/mcp-client-wire-evidence.mjs";
const { inspectMcpClientConnection, projectMcpWireMessage } = evidence;

const key = "io.modelcontextprotocol/protocolVersion";
const tools = ["project_context", "validation_plan"];
const message = (direction: string, value: unknown) => ({
  event: "message",
  direction,
  connectionId: "original-connection",
  ...projectMcpWireMessage(value),
});
const request = (id: number | string, method: string, params = {}) =>
  message("client", { id, method, params });
const response = (id: number | string, result: unknown) =>
  message("server", { id, result });
const listing = (id: number | string, modern = false) =>
  response(id, {
    tools: tools.map((name) => ({ name })),
    ...(modern ? { resultType: "complete" } : {}),
  });
const modern = () => [
  request(0, "server/discover", { _meta: { [key]: "2026-07-28" } }),
  response(0, {
    supportedVersions: ["2025-11-25", "2026-07-28"],
    resultType: "complete",
  }),
  request("tools", "tools/list", { _meta: { [key]: "2026-07-28" } }),
  listing("tools", true),
];

test("MCP wire evidence binds modern discovery and complete versioned tools by exact ID", () => {
  assert.deepEqual(inspectMcpClientConnection(modern(), tools), {
    observedProtocols: ["2026-07-28"],
    observedConnections: 1,
    connectionsWithToolLists: 1,
    protocolEvidence: ["discovery-and-versioned-tools-list"],
    successfulDiscoveryResponses: 1,
    failedDiscoveryProbes: 0,
    correlatedToolLists: 1,
    tools,
  });
});
test("MCP wire evidence retains legacy negotiation including an accepted older version", () => {
  const events = [
    request(0, "initialize", { protocolVersion: "2025-11-25" }),
    response(0, { protocolVersion: "2025-06-18" }),
    request(1, "tools/list"),
    listing(1),
  ];
  assert.equal(
    inspectMcpClientConnection(events, tools).observedProtocols[0],
    "2025-06-18",
  );
});
test("MCP wire evidence accepts direct versioned calls and explicit method-not-found legacy fallback", () => {
  const direct = modern().slice(2);
  assert.deepEqual(inspectMcpClientConnection(direct, tools).protocolEvidence, [
    "direct-versioned-tools-list",
  ]);
  const fallback = [
    request(0, "server/discover", { _meta: { [key]: "2026-07-28" } }),
    message("server", { id: 0, error: { code: -32601 } }),
    request(1, "initialize", { protocolVersion: "2025-11-25" }),
    response(1, { protocolVersion: "2025-11-25" }),
    request(2, "tools/list"),
    listing(2),
  ];
  assert.equal(
    inspectMcpClientConnection(fallback, tools).failedDiscoveryProbes,
    1,
  );
});
test("MCP wire evidence refuses empty discovery-only failed incomplete and stale-ID lists", () => {
  assert.throws(() => inspectMcpClientConnection([], tools), /AssertionError/);
  assert.throws(
    () => inspectMcpClientConnection(modern().slice(0, 2), tools),
    /No correlated/,
  );
  const wrongId = modern();
  wrongId[3] = listing(0, true);
  assert.throws(() => inspectMcpClientConnection(wrongId, tools), /unanswered/);
  const typedId = modern();
  typedId[1] = response("0", {
    supportedVersions: ["2026-07-28"],
    resultType: "complete",
  });
  assert.throws(() => inspectMcpClientConnection(typedId, tools), /unanswered/);
  const missingResultType = modern();
  missingResultType[3] = listing("tools");
  assert.throws(
    () => inspectMcpClientConnection(missingResultType, tools),
    /not complete/,
  );
  const failedList = modern();
  failedList[3] = message("server", { id: "tools", error: { code: -32603 } });
  assert.throws(
    () => inspectMcpClientConnection(failedList, tools),
    /request failed/,
  );
});
test("MCP wire evidence rejects unadvertised versions changed inventory and active ID reuse", () => {
  const wrongVersion = modern();
  wrongVersion[1] = response(0, {
    supportedVersions: ["2025-11-25"],
    resultType: "complete",
  });
  assert.throws(
    () => inspectMcpClientConnection(wrongVersion, tools),
    /not advertised/,
  );
  const wrongTools = modern();
  wrongTools[3] = response("tools", {
    tools: [{ name: "project_context" }],
    resultType: "complete",
  });
  assert.throws(
    () => inspectMcpClientConnection(wrongTools, tools),
    /inventory changed/,
  );
  const duplicateId = modern();
  duplicateId.splice(1, 0, request(0, "tools/list"));
  assert.throws(() => inspectMcpClientConnection(duplicateId, tools), /reused/);
});
test("MCP wire evidence rejects paginated legacy and modern inventories even when one page matches", () => {
  for (const modernProtocol of [false, true]) {
    const events = modernProtocol
      ? modern()
      : [
          request(0, "initialize", { protocolVersion: "2025-11-25" }),
          response(0, { protocolVersion: "2025-11-25" }),
          request("tools", "tools/list"),
          listing("tools"),
        ];
    const more = structuredClone(events);
    more[3] = response("tools", {
      tools: tools.map((name) => ({ name })),
      nextCursor: "private-next-page",
      ...(modernProtocol ? { resultType: "complete" } : {}),
    });
    assert.throws(
      () => inspectMcpClientConnection(more, tools),
      /Paginated tools/,
    );
    const resumed = structuredClone(events);
    resumed[2] = request("tools", "tools/list", {
      cursor: "private-previous-page",
      ...(modernProtocol ? { _meta: { [key]: "2026-07-28" } } : {}),
    });
    assert.throws(
      () => inspectMcpClientConnection(resumed, tools),
      /Paginated tools/,
    );
    assert.equal(
      JSON.stringify([more, resumed]).includes("private-next-page"),
      false,
    );
    assert.equal(
      JSON.stringify([more, resumed]).includes("private-previous-page"),
      false,
    );
  }
});
test("MCP observer projects no arguments instructions schemas identity or error text", () => {
  const secret = "original-private-canary";
  const projected = projectMcpWireMessage({
    id: 1,
    method: "tools/call",
    params: {
      arguments: { path: secret },
      _meta: { [key]: "2026-07-28", private: secret },
    },
    result: {
      tools: [
        {
          name: "project_context",
          description: secret,
          inputSchema: { secret },
        },
      ],
      instructions: secret,
    },
  });
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.equal(
    JSON.stringify(
      projectMcpWireMessage({
        id: 2,
        error: { code: -32603, message: secret },
      }),
    ).includes(secret),
    false,
  );
});
test("MCP observer refuses malformed protocol identifiers duplicate tools and batch or overlong IDs", () => {
  for (const value of [
    [],
    { id: 1, params: { _meta: { [key]: "2026-07-28-suffix" } } },
    { id: 1, result: { supportedVersions: [] } },
    { id: 1, result: { tools: [{ name: "x" }, { name: "x" }] } },
    { id: "x".repeat(257) },
    { id: 1.5 },
  ])
    assert.throws(() => projectMcpWireMessage(value));
});

test("MCP wire evidence separates simultaneous equal request IDs across physical connections", () => {
  const a = modern().map((event) => ({
    ...event,
    connectionId: "connection-a",
  }));
  const b = modern().map((event) => ({
    ...event,
    connectionId: "connection-b",
  }));
  const interleaved = a.flatMap((event, index) => [event, b[index]!]);
  const report = inspectMcpClientConnection(interleaved, tools);
  assert.equal(report.observedConnections, 2);
  assert.equal(report.connectionsWithToolLists, 2);
  assert.equal(report.correlatedToolLists, 2);
  const crossed = interleaved.map((event) => ({ ...event }));
  crossed[3]!.connectionId = "connection-a";
  assert.throws(() => inspectMcpClientConnection(crossed, tools), /unanswered/);
  const noIdentity = modern().map((event) => ({
    ...event,
    connectionId: undefined,
  }));
  assert.throws(
    () => inspectMcpClientConnection(noIdentity, tools),
    /connection identity/,
  );
});
