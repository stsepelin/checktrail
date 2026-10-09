import path from "node:path";
import { nodeLoaderManifestSchema } from "./node-loader-contract.js";
import type { Check, ProcessResult } from "./types.js";
export function nodeLoaderEvidence(
  check: Check,
  processes: ProcessResult[],
  root?: string,
) {
  const incomplete = (reason: string) => ({
    status: "inconclusive" as const,
    reason,
  });
  if (processes.length !== 1 || !root)
    return incomplete(
      "Native loader evidence requires one source-bound process",
    );
  const command = check.commands[0];
  if (
    !command ||
    command.args.length !== 3 ||
    Buffer.byteLength(command.args[2]!) > 65536
  )
    return incomplete("Invalid native loader plan");
  try {
    const selected = nodeLoaderManifestSchema.safeParse(
      JSON.parse(command.args[2]!),
    );
    if (
      !selected.success ||
      JSON.stringify(selected.data.files.map((f) => f.path)) !==
        JSON.stringify(check.scope)
    )
      return incomplete("Native loader source selection differs from the plan");
    const events = processes[0]!.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      processes[0]!.exitCode === 3 &&
      events.length === 1 &&
      events[0].type === "checktrail:node-loader-unavailable" &&
      ["unsupported-native-runtime", "source-or-hook-mismatch"].includes(
        events[0].reason,
      )
    )
      return {
        status: "unavailable" as const,
        reason:
          "The selected native loader runtime or source bytes are unavailable",
      };
    const markers = events.filter(
      (event) => event.type === "checktrail:node-loaders",
    );
    if (
      markers.length !== 2 ||
      events[0] !== markers[0] ||
      events.at(-1) !== markers[1] ||
      markers[0].phase !== "start" ||
      markers[1].phase !== "end" ||
      markers[0].runtime !== markers[1].runtime ||
      markers[0].runtime !== selected.data.runtime ||
      !/^(?:22|24|26)\.\d+\.\d+$/.test(markers[0].runtime)
    )
      return incomplete(
        "Native loader execution did not reach both source checks",
      );
    for (const marker of markers)
      if (
        JSON.stringify(nodeLoaderManifestSchema.parse(marker.manifest)) !==
        JSON.stringify(selected.data)
      )
        return incomplete(
          "Native loader receipt does not match planned source and hooks",
        );
    const summaries = events
      .filter(
        (event) =>
          event.type === "test:summary" && event.data?.file !== undefined,
      )
      .map((event) => event.data.file);
    const expected = check.scope.map((file) =>
      path.resolve(root, check.project, file),
    );
    if (
      summaries.length !== expected.length ||
      new Set(summaries).size !== expected.length ||
      summaries.some((file) => !expected.includes(file))
    )
      return incomplete(
        "Every selected native test file must produce its own summary",
      );
    return {
      stdout: events
        .filter((event) => event.type !== "checktrail:node-loaders")
        .map((event) => JSON.stringify(event))
        .join("\n"),
    };
  } catch {
    return incomplete("Malformed native loader evidence");
  }
}
