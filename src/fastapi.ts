import path from "node:path";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { fastapiAssemblyRunner } from "./fastapi-assembly-runner.js";
import {
  fastapiAssemblyRouteSchema,
  fastapiAssemblyMiddlewareSchema,
  fastapiAssemblyLifespanSchema,
  fastapiAssemblyBindingSchema,
  fastapiAssemblyRequestSchema,
} from "./fastapi-assembly-schema.js";
import { fastapiRunner } from "./fastapi-runner.js";
import type { Check, Inventory, Project } from "./types.js";

const legacyConfigSchema = z.strictObject({
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
const assemblyConfigSchema = legacyConfigSchema.extend({
  schemaVersion: z.literal(2),
  expectedRoutes: z.array(fastapiAssemblyRouteSchema).min(1).max(2048),
  expectedMiddleware: z.array(fastapiAssemblyMiddlewareSchema).max(2048),
  expectedLifespan: z.array(fastapiAssemblyLifespanSchema).min(1).max(2048),
  expectedBindings: z.array(fastapiAssemblyBindingSchema).max(2048),
  requests: z.array(fastapiAssemblyRequestSchema).min(1).max(64),
});
export const fastapiConfigSchema = z.discriminatedUnion("schemaVersion", [
  legacyConfigSchema,
  assemblyConfigSchema,
]);
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
  const text = await readProjectFile(
    source.root,
    path.posix.join(project.path, "checktrail.fastapi.json"),
  );
  if (Buffer.byteLength(text) > 65536)
    throw new Error("FastAPI configuration exceeds 64 KiB");
  const config = fastapiConfigSchema.parse(JSON.parse(text));
  if (
    config.schemaVersion === 2 &&
    config.requests.some(
      (request) =>
        request.headers.some(
          ([name, value]) =>
            name.toLowerCase() === "host" ||
            /[^\x20-\x7e\x80-\xff]/.test(value),
        ) ||
        request.path.includes("?") ||
        request.path.includes("#") ||
        (request.protocol === "websocket" &&
          (request.method !== "WEBSOCKET" || request.body !== "")),
    )
  )
    throw new Error("Unsupported FastAPI ASGI request profile");
  if (config.schemaVersion === 2)
    check.reason =
      "Verify the declared native FastAPI hierarchy, dependencies, response models, middleware/lifespan registrations and controlled ASGI responses.";
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
      args:
        config.schemaVersion === 2
          ? [
              "-I",
              "-c",
              fastapiAssemblyRunner,
              JSON.stringify(config),
              source.fingerprint,
              path.resolve(source.root, project.path),
            ]
          : ["-c", fastapiRunner, JSON.stringify(config), source.fingerprint],
      cwd: project.path,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    },
  ];
  return check;
}
