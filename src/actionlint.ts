import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

export function workflowPath(value: string): boolean {
  return [...value].every(
    (character) =>
      character.charCodeAt(0) >= 32 &&
      character.charCodeAt(0) !== 127 &&
      character !== "\\",
  );
}

export const actionlintConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runnerLabels: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))
    .max(128)
    .refine(
      (items) =>
        new Set(items.map((item) => item.toLowerCase())).size === items.length,
    ),
  variables: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
    .max(256)
    .refine(
      (items) =>
        new Set(items.map((item) => item.toLowerCase())).size === items.length,
    ),
});
export const actionlintInvocationSchema = z.strictObject({
  config: actionlintConfigSchema,
  scope: z
    .array(
      z
        .string()
        .regex(/^\.github\/workflows\/[^/]+\.ya?ml$/)
        .refine(workflowPath),
    )
    .min(1)
    .max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export function workflowRoot(file: string): string | undefined {
  const match = /^(.*?)(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.exec(file);
  return match ? match[1] || "." : undefined;
}

export async function actionlintCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const prefix = project.path === "." ? "" : `${project.path}/`;
  const scope = source.files
    .filter((file) => workflowRoot(file) === project.path)
    .map((file) => file.slice(prefix.length));
  const check: Check = {
    id: "infrastructure.actionlint",
    adapter: project.adapter,
    project: project.path,
    scope,
    kind: "analysis",
    parser: "actionlint-json",
    commands: [],
    reason:
      "Statically check every inventoried workflow with native completion accounting and explicit local dependencies.",
  };
  try {
    const file = `${prefix}repo-verifier.actionlint.json`;
    if (!source.files.includes(file))
      throw new Error(
        "Prepare repo-verifier.actionlint.json with explicit runnerLabels and variables",
      );
    const config = actionlintConfigSchema.parse(
      JSON.parse(await readProjectFile(source.root, file)),
    );
    const invocation = JSON.stringify(
      actionlintInvocationSchema.parse({
        config,
        scope,
        fingerprint: source.fingerprint,
      }),
    );
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw new Error("Actionlint invocation exceeds 100 KiB");
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./actionlint-runner.js", import.meta.url)),
        source.root,
        invocation,
      ],
      cwd: project.path,
      env: { PATH: process.env.PATH ?? "" },
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : "Workflow profile could not be prepared";
  }
  return check;
}
