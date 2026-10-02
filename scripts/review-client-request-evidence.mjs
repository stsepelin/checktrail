// Development evidence only. Never retain native request prose or credentials.
export function inspectClientRequest(
  body,
  assignment,
  hiddenCanaries,
  priorAssignments,
) {
  const validObject =
    body !== null && typeof body === "object" && !Array.isArray(body);
  const input = validObject ? (body.input ?? body.messages ?? []) : [];
  const validInput = Array.isArray(input);
  const validTools =
    validObject && (body.tools === undefined || Array.isArray(body.tools));
  const strings = [];
  const walk = (value, at = []) => {
    if (typeof value === "string") strings.push({ at: at.join("/"), value });
    else if (Array.isArray(value))
      value.forEach((child, index) => walk(child, [...at, index]));
    else if (value !== null && typeof value === "object")
      Object.entries(value).forEach(([key, child]) =>
        walk(child, [...at, key]),
      );
  };
  walk(body);
  const text = (item) =>
    typeof item.content === "string"
      ? [item.content]
      : Array.isArray(item.content)
        ? item.content
            .filter(
              (part) => part?.type === "input_text" || part?.type === "text",
            )
            .map((part) => part.text)
            .filter((value) => typeof value === "string")
        : [];
  const userTexts = validInput
    ? input.filter((item) => item?.role === "user").flatMap(text)
    : [];
  const exactAssignmentTexts = userTexts.filter(
    (value) => value === assignment.prompt,
  );
  const sourceIncluded = exactAssignmentTexts.some((value) => {
    try {
      return JSON.parse(value).files.some(
        (file) =>
          file.path === "subject.mjs" && file.content === assignment.source,
      );
    } catch {
      return false;
    }
  });
  // A marker inside the exact assigned source packet is data, not a host instruction.
  const outsideAssignment = strings.filter(
    ({ value }) => value !== assignment.prompt && value !== assignment.system,
  );
  const hostRules = outsideAssignment.filter(
    ({ value }) =>
      value.includes("The review bar") ||
      value.includes("Shared agent environments on this Mac"),
  );
  const contains = (markers) =>
    strings.some(({ value }) =>
      markers.some((marker) => value.includes(marker)),
    );
  const counts = {
    selectedAssignment: exactAssignmentTexts.length,
    other: userTexts.length - exactAssignmentTexts.length,
    total: userTexts.length,
  };
  return {
    malformedRequest: !validObject || !validInput || !validTools,
    model: validObject && typeof body.model === "string" ? body.model : null,
    tools: validTools
      ? (body.tools ?? []).map((tool) => tool?.name ?? tool?.type ?? "unknown")
      : ["unknown"],
    inputRoles: validInput
      ? input.map((item) => item?.role ?? item?.type ?? "unknown")
      : [],
    userTextCounts: counts,
    assignedSourceIncluded: sourceIncluded,
    originalCanariesIncluded: contains(hiddenCanaries),
    priorAssignmentIncluded: contains(priorAssignments),
    previousResponse:
      validObject && Object.hasOwn(body, "previous_response_id"),
    conversation: validObject && Object.hasOwn(body, "conversation"),
    agentInstructionMessages: outsideAssignment
      .filter(
        ({ value }) =>
          value.includes("# AGENTS.md instructions for") ||
          value.includes("# CLAUDE.md"),
      )
      .map(({ at }) => at),
    hostReviewRulesDetected: hostRules.length > 0,
    hostReviewRulesLocations: hostRules.map(({ at }) => at),
    additionalInstructionScope: "not-fully-classified",
  };
}

// Inspect native JSON events without exposing error prose or client paths.
export function inspectClientEvents(
  stdout,
  kind,
  expectedModel,
  expectedVersion,
  expectedOutput,
) {
  const events = [];
  let malformedEventStream = false;
  for (const line of stdout.split("\n").filter((value) => value.trim())) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event))
        malformedEventStream = true;
      else events.push(event);
    } catch {
      malformedEventStream = true;
    }
  }
  const starts = events.filter((event) =>
    kind === "codex"
      ? event.type === "thread.started"
      : event.type === "system" && event.subtype === "init",
  );
  const start = starts[0];
  const session = kind === "codex" ? start?.thread_id : start?.session_id;
  const nativeSessionId =
    typeof session === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      session,
    )
      ? session
      : null;
  const completions = events.filter((event) =>
    kind === "codex"
      ? event.type === "turn.completed"
      : event.type === "result" &&
        event.subtype === "success" &&
        event.is_error === false,
  );
  const outputTexts = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "agent_message",
    )
    .map((event) => event.item.text);
  const outputContractObserved =
    kind === "codex"
      ? outputTexts.length === 1 && outputTexts[0] === expectedOutput
      : completions.length === 1 && completions[0].result === expectedOutput;
  const modelMetadataFallback = events.some(
    (event) =>
      typeof event.item?.message === "string" &&
      event.item.message.includes("Defaulting to fallback metadata"),
  );
  return {
    malformedEventStream,
    nativeSessionId,
    inconsistentSessionIds: events.some(
      (event) =>
        typeof event.session_id === "string" &&
        event.session_id !== nativeSessionId,
    ),
    singleNativeSessionStart: starts.length === 1 && nativeSessionId !== null,
    nativeCompletionObserved: completions.length === 1,
    outputContractObserved,
    runtimeModelObserved:
      kind === "claude" ? start?.model === expectedModel : null,
    runtimeVersionObserved:
      kind === "claude" ? start?.claude_code_version === expectedVersion : null,
    runtimeToolsAbsent:
      kind === "claude"
        ? Array.isArray(start?.tools) && start.tools.length === 0
        : null,
    runtimeMcpAbsent:
      kind === "claude"
        ? Array.isArray(start?.mcp_servers) && start.mcp_servers.length === 0
        : null,
    modelMetadataFallback,
  };
}
