import path from "node:path";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { localTool } from "./local-tool.js";
import { laravelRunner } from "./laravel-runner.js";
import { laravelAssemblyRunner } from "./laravel-assembly-runner.js";
import {
  laravelAssemblyConfigSchema,
  validateLaravelAssemblyCollections,
} from "./laravel-assembly-schema.js";
import type { Check, Inventory, Project } from "./types.js";

const laravelLegacyConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  assembly: z.string().min(1).max(256),
  environment: z.literal("testing"),
});
export const laravelConfigSchema = z.discriminatedUnion("schemaVersion", [
  laravelLegacyConfigSchema,
  laravelAssemblyConfigSchema,
]);
export const laravelAssemblyPhpFlags = [
  "-d",
  "opcache.enable_cli=0",
  "-d",
  "opcache.preload=",
  "-d",
  "auto_prepend_file=",
  "-d",
  "auto_append_file=",
  "-r",
] as const;
export async function laravelCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "php.laravel-runtime",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    commands: [],
    kind: "analysis",
    parser: "laravel-json",
    reason:
      "Bootstrap the explicit Laravel testing profile and capture native assembly registrations without dispatching requests or scheduled work.",
  };
  if (!project.files.includes("checktrail.laravel.json")) {
    check.unavailableReason =
      "Laravel runtime capture requires an explicit checktrail.laravel.json profile.";
    return check;
  }
  const config = laravelConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.laravel.json"),
      ),
    ),
  );
  const encoded = JSON.stringify(config);
  if (config.schemaVersion === 2) {
    validateLaravelAssemblyCollections(
      config.expectedCollections,
      config.models,
    );
    if (new Set(config.models).size !== config.models.length)
      throw Error("Laravel model selectors must be unique");
    for (const request of config.requests) {
      const headers = request.headers.map((h) => h.name.toLowerCase());
      if (
        new Set(headers).size !== headers.length ||
        headers.some((h) => ["host", "content-length"].includes(h))
      )
        throw Error(
          "Laravel headers must be unique and preserve the controlled host and content length",
        );
      if (
        Buffer.byteLength(request.body ?? "") > 32768 ||
        Buffer.byteLength(request.expected.body) > 65536
      )
        throw Error(
          "Laravel request or expected response exceeds its UTF-8 byte budget",
        );
    }
    if (Buffer.byteLength(encoded) > 256 * 1024)
      throw Error("Laravel assembly profile exceeds 256 KiB");
  }
  const autoload = await localTool(
    source.root,
    project.path,
    "autoload.php",
    "vendor",
  );
  if (!autoload || !project.files.includes("bootstrap/app.php")) {
    check.unavailableReason =
      "Laravel requires local vendor/autoload.php within the operator root and inventoried bootstrap/app.php.";
    return check;
  }
  check.scope = ["bootstrap/app.php"];
  if (config.schemaVersion === 2) {
    const transport = Buffer.from(encoded, "utf8")
      .toString("base64")
      .match(/.{1,65536}/g)!;
    check.reason =
      "Bootstrap the declared Laravel testing assembly, compare all five native registration projections and selected model defaults, and complete controlled native HTTP requests.";
    check.commands = [
      {
        executable: "php",
        args: [
          ...laravelAssemblyPhpFlags,
          laravelAssemblyRunner,
          autoload,
          source.fingerprint,
          ...transport,
        ],
        cwd: project.path,
        temporaryDirectory: true,
        env: { APP_ENV: "testing", APP_DEBUG: "false" },
      },
    ];
    return check;
  }
  check.commands = [
    {
      executable: "php",
      args: [
        "-r",
        laravelRunner,
        autoload,
        JSON.stringify(config),
        source.fingerprint,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: { APP_ENV: "testing", APP_DEBUG: "false" },
    },
  ];
  return check;
}
