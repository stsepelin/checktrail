import path from "node:path";
import { workflowPath } from "./actionlint.js";
import { parseDocument, visit, isScalar } from "yaml";
import type { Finding } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function actionlintInputs(
  files: Map<string, Buffer>,
  scope: string[],
): { findings: Finding[]; unavailable?: string } {
  const findings: Finding[] = [];
  const visited = new Set<string>();
  const queue = scope.map((file) => ({ file, action: false }));
  const requireFile = (file: string) => {
    if (!files.has(file))
      throw new Error(
        "A local workflow, action or runtime asset is missing or excluded from the inventory",
      );
  };
  const localPath = (base: string, value: string) => {
    if (
      !workflowPath(value) ||
      path.posix.isAbsolute(value) ||
      value.includes("${{")
    )
      throw new Error("Local action paths must be literal relative paths");
    const file = path.posix.normalize(path.posix.join(base, value));
    if (file === ".." || file.startsWith("../"))
      throw new Error("A local action path escapes the project");
    return file;
  };
  const action = (value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("./")) return;
    const directory = localPath(".", value);
    const metadata = ["action.yml", "action.yaml"]
      .map((name) => path.posix.join(directory, name))
      .filter((file) => files.has(file));
    if (metadata.length !== 1)
      throw new Error(
        "A local action requires exactly one inventoried metadata file",
      );
    queue.push({ file: metadata[0]!, action: true });
  };
  const steps = (value: unknown) => {
    if (Array.isArray(value))
      for (const step of value) action(record(step).uses);
  };
  try {
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index]!;
      if (visited.has(entry.file)) continue;
      if (visited.size >= 512)
        throw new Error(
          "Local action dependency closure exceeds 512 YAML files",
        );
      visited.add(entry.file);
      requireFile(entry.file);
      const bytes = files.get(entry.file)!;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const doc = parseDocument(text, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
      });
      if (doc.errors.length) {
        findings.push(
          ...doc.errors.map((error) => ({
            ruleId: `yaml/${error.code}`,
            level: "error" as const,
            message: error.message,
            file: entry.file,
            line: text.slice(0, error.pos[0]).split("\n").length,
          })),
        );
        continue;
      }
      if (doc.warnings.length)
        throw new Error(
          "YAML warnings prevent reliable local dependency inspection",
        );
      visit(doc, {
        Alias() {
          throw new Error(
            "YAML aliases require a separate verified workflow profile",
          );
        },
        Pair(_key, pair) {
          if (isScalar(pair.key) && pair.key.value === "<<")
            throw new Error(
              "YAML merge keys require a separate verified workflow profile",
            );
        },
      });
      const data = record(doc.toJS({ maxAliasCount: 0 }) as unknown);
      if (entry.action) {
        const runs = record(data.runs);
        for (const key of [
          "main",
          "pre",
          "post",
          "image",
          "entrypoint",
          "pre-entrypoint",
          "post-entrypoint",
        ]) {
          const value = runs[key];
          if (
            typeof value === "string" &&
            value &&
            !(key === "image" && value.startsWith("docker://"))
          )
            requireFile(localPath(path.posix.dirname(entry.file), value));
        }
        steps(runs.steps);
      } else {
        for (const job of Object.values(record(data.jobs))) {
          const item = record(job);
          if (typeof item.uses === "string" && item.uses.startsWith("./")) {
            const file = localPath(".", item.uses);
            requireFile(file);
            if (!scope.includes(file))
              throw new Error(
                "Local reusable workflows must belong to the planned workflow scope",
              );
          }
          steps(item.steps);
        }
      }
    }
    return { findings };
  } catch (error) {
    return {
      findings,
      unavailable:
        error instanceof Error
          ? error.message
          : "Workflow dependencies could not be inspected",
    };
  }
}
