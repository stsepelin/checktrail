import path from "node:path";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { fastapiRunner } from "./fastapi-runner.js";
import type { Check, Inventory, Project } from "./types.js";

export const fastapiConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  module: z
    .string()
    .regex(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/)
    .max(256),
  attribute: z
    .string()
    .regex(/^[A-Za-z_]\w*$/)
    .max(128),
  assembly: z.string().min(1).max(256),
  environment: z.string().min(1).max(256),
});
export async function fastapiCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "python.fastapi-routes",
    adapter: project.adapter,
    project: project.path,
    kind: "analysis",
    parser: "fastapi-json",
    scope: [],
    commands: [],
    reason:
      "Capture the configured FastAPI application's flat native route table after lifespan startup and reject exact duplicate HTTP/WebSocket routes.",
  };
  if (!project.files.includes("checktrail.fastapi.json")) {
    check.unavailableReason =
      "FastAPI route validation requires an explicit checktrail.fastapi.json application profile.";
    return check;
  }
  const config = fastapiConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.fastapi.json"),
      ),
    ),
  );
  const modulePath = config.module.replaceAll(".", "/");
  const candidates = [`${modulePath}.py`, `${modulePath}/__init__.py`].filter(
    (file) => project.files.includes(file),
  );
  if (candidates.length !== 1) {
    check.unavailableReason =
      "FastAPI import entry must resolve to one inventoried local Python module or package.";
    return check;
  }
  check.scope = candidates;
  check.commands = [
    {
      executable: "python3",
      args: ["-c", fastapiRunner, JSON.stringify(config), source.fingerprint],
      cwd: project.path,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    },
  ];
  return check;
}
