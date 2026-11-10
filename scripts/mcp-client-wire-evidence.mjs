import assert from "node:assert/strict";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const version = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const versionKey = "io.modelcontextprotocol/protocolVersion";

// Only transport metadata crosses this boundary, never tool arguments, result
// bodies, instructions, descriptions, schemas or client identity metadata.
export function projectMcpWireMessage(value) {
  assert.ok(object(value), "MCP observer requires one JSON-RPC object");
  const output = {};
  if (Object.hasOwn(value, "id")) {
    assert.ok(
      (typeof value.id === "number" && Number.isSafeInteger(value.id)) ||
        (typeof value.id === "string" && value.id.length <= 256),
      "MCP observer requires an exact bounded request ID",
    );
    output.id = value.id;
  }
  if (Object.hasOwn(value, "method")) {
    assert.ok(typeof value.method === "string" && value.method.length <= 128);
    output.method = value.method;
  }
  const params = object(value.params) ? value.params : {};
  const result = object(value.result) ? value.result : {};
  const meta = object(params._meta) ? params._meta : {};
  if (Object.hasOwn(params, "cursor")) output.requestHasCursor = true;
  if (Object.hasOwn(result, "nextCursor")) output.resultHasNextCursor = true;
  if (Object.hasOwn(meta, versionKey)) {
    assert.ok(version(meta[versionKey]), "Malformed per-request MCP version");
    output.requestProtocol = meta[versionKey];
  }
  const legacy = params.protocolVersion ?? result.protocolVersion;
  if (legacy !== undefined) {
    assert.ok(version(legacy), "Malformed legacy MCP version");
    output.legacyProtocol = legacy;
  }
  output.response =
    Object.hasOwn(value, "result") || Object.hasOwn(value, "error");
  if (Object.hasOwn(value, "error")) {
    assert.ok(object(value.error) && Number.isSafeInteger(value.error.code));
    output.errorCode = value.error.code;
  }
  if (Object.hasOwn(result, "supportedVersions")) {
    assert.ok(
      Array.isArray(result.supportedVersions) &&
        result.supportedVersions.length > 0 &&
        result.supportedVersions.length <= 32 &&
        result.supportedVersions.every(version),
      "Malformed supported MCP versions",
    );
    assert.equal(
      new Set(result.supportedVersions).size,
      result.supportedVersions.length,
    );
    output.supportedProtocols = result.supportedVersions;
  }
  if (Object.hasOwn(result, "resultType"))
    output.completeResult = result.resultType === "complete";
  if (Object.hasOwn(result, "tools")) {
    assert.ok(Array.isArray(result.tools) && result.tools.length <= 512);
    output.tools = result.tools
      .map((tool) => {
        assert.ok(
          object(tool) &&
            typeof tool.name === "string" &&
            tool.name.length <= 128,
        );
        return tool.name;
      })
      .sort();
    assert.equal(
      new Set(output.tools).size,
      output.tools.length,
      "Duplicate advertised tool",
    );
  }
  return output;
}

export function inspectMcpClientConnection(events, expectedTools) {
  assert.ok(
    Array.isArray(events) && events.length > 0 && events.length <= 4096,
  );
  assert.ok(Array.isArray(expectedTools) && expectedTools.length > 0);
  const connections = new Map();
  const protocols = new Set();
  const evidence = new Set();
  let discoveries = 0,
    failedDiscoveryProbes = 0,
    lists = 0;
  for (const event of events) {
    if (event.event !== "message") continue;
    assert.ok(
      typeof event.connectionId === "string" &&
        event.connectionId.length > 0 &&
        event.connectionId.length <= 64,
      "Missing bounded physical MCP connection identity",
    );
    if (!connections.has(event.connectionId))
      connections.set(event.connectionId, {
        pending: new Map(),
        legacy: undefined,
        supported: undefined,
        lists: 0,
      });
    const connection = connections.get(event.connectionId);
    const pending = connection.pending;
    if (
      event.direction === "client" &&
      ["initialize", "server/discover", "tools/list"].includes(event.method)
    ) {
      assert.ok(Object.hasOwn(event, "id"), "Tracked MCP request lacks its ID");
      assert.ok(
        !pending.has(event.id),
        "MCP request ID reused before response",
      );
      pending.set(event.id, event);
      continue;
    }
    if (
      event.direction !== "server" ||
      !event.response ||
      !pending.has(event.id)
    )
      continue;
    const request = pending.get(event.id);
    pending.delete(event.id);
    if (event.errorCode !== undefined) {
      assert.ok(
        request.method === "server/discover" && event.errorCode === -32601,
        "Native MCP request failed",
      );
      failedDiscoveryProbes++;
      continue;
    }
    if (request.method === "initialize") {
      assert.ok(
        version(request.legacyProtocol) && version(event.legacyProtocol),
        "Legacy MCP handshake lacks version evidence",
      );
      connection.legacy = event.legacyProtocol;
    } else if (request.method === "server/discover") {
      assert.ok(
        version(request.requestProtocol) &&
          event.supportedProtocols?.length > 0,
        "Modern discovery lacks supported-version evidence",
      );
      assert.equal(
        event.completeResult,
        true,
        "Modern discovery was not complete",
      );
      connection.supported = event.supportedProtocols;
      discoveries++;
    } else {
      assert.ok(
        !request.requestHasCursor && !event.resultHasNextCursor,
        "Paginated tools list is not a complete inventory",
      );
      assert.deepEqual(
        event.tools,
        [...expectedTools].sort(),
        "Advertised MCP tool inventory changed",
      );
      const selected = request.requestProtocol ?? connection.legacy;
      assert.ok(
        version(selected),
        "Tools response has no bound protocol evidence",
      );
      if (request.requestProtocol !== undefined) {
        assert.equal(
          event.completeResult,
          true,
          "Versioned tools list was not complete",
        );
        if (connection.supported)
          assert.ok(
            connection.supported.includes(selected),
            "Used version was not advertised",
          );
        evidence.add(
          connection.supported
            ? "discovery-and-versioned-tools-list"
            : "direct-versioned-tools-list",
        );
      } else {
        assert.ok(
          connection.legacy,
          "Unversioned tools list lacks a completed legacy handshake",
        );
        assert.notEqual(
          event.completeResult,
          false,
          "Legacy tools list was incomplete",
        );
        evidence.add("legacy-initialize-and-tools-list");
      }
      protocols.add(selected);
      lists++;
      connection.lists++;
    }
  }
  assert.ok(
    [...connections.values()].every(
      (connection) => connection.pending.size === 0,
    ),
    "MCP observation ended with unanswered tracked requests",
  );
  assert.ok(lists > 0, "No correlated successful MCP tools list");
  return {
    observedProtocols: [...protocols].sort(),
    observedConnections: connections.size,
    connectionsWithToolLists: [...connections.values()].filter(
      (connection) => connection.lists > 0,
    ).length,
    protocolEvidence: [...evidence].sort(),
    successfulDiscoveryResponses: discoveries,
    failedDiscoveryProbes,
    correlatedToolLists: lists,
    tools: [...expectedTools].sort(),
  };
}
