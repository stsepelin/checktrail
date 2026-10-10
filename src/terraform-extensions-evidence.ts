import path from "node:path";
import { realpathSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseAllDocuments } from "yaml";
import { mavenHash } from "./maven.js";
import { terraformBinarySha256, terraformRequire } from "./terraform.js";
import {
  terraformExtensionsProvider as provider,
  terraformExtensionsLock,
  terraformExtensionsModules,
} from "./terraform-extensions-contract.js";
import {
  terraformExtensionsInvocationSchema,
  terraformExtensionsVerify,
  terraformExtensionsRegular,
} from "./terraform-extensions-physical.js";
import {
  terraformExtensionsPacketSchema,
  terraformExtensionsNativeResultSchema,
  terraformExtensionsPositionSchema,
} from "./terraform-extensions-packet.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const same = (a: unknown, b: unknown, message: string) =>
  terraformRequire(isDeepStrictEqual(a, b), message);
const json = (text: string) => {
  const documents = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  terraformRequire(
    documents.length === 1 &&
      !documents[0]!.errors.length &&
      !documents[0]!.warnings.length,
    "Strict native JSON required",
  );
  return JSON.parse(text) as unknown;
};
export function terraformExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Terraform extension evidence is incomplete stale or inconsistent with the declared local modules provider schema physical source or native diagnostics.",
    findingsComplete: false,
  };
  try {
    terraformRequire(
      check.id === "infrastructure.terraform-extensions" &&
        check.commands.length === 1 &&
        processes.length === 1,
      "Execution accounting differs",
    );
    const command = check.commands[0]!,
      process = processes[0]!;
    terraformRequire(
      !process.stderr &&
        !process.truncated &&
        !process.cancelled &&
        !process.timedOut &&
        !process.errorCode &&
        !process.signal,
      "Native execution incomplete",
    );
    terraformRequire(
      root &&
        path.isAbsolute(root) &&
        realpathSync(root) === root &&
        command.args.length === 3 &&
        command.args[1] === root &&
        path.basename(command.args[0]!) === "terraform-extensions-runner.js",
      "Current root/command differs",
    );
    const directory = path.join(root!, check.project);
    terraformRequire(
      directory === root || directory.startsWith(root + path.sep),
      "Current project escapes root",
    );
    const invocation = terraformExtensionsInvocationSchema.parse(
        json(command.args[2]!),
      ),
      current = terraformExtensionsVerify(directory, invocation);
    same(check.scope, current.files, "Planned source scope differs");
    if (process.exitCode === 3) {
      z.strictObject({
        unavailable: z.literal("terraform-extensions"),
        reason: z.literal("pinned-prerequisite"),
      }).parse(json(process.stdout));
      return {
        status: "unavailable",
        reason:
          "Pinned Terraform/provider prerequisites are missing incompatible or changed.",
        findingsComplete: false,
      };
    }
    terraformRequire(process.exitCode === 0, "Collector did not complete");
    const packet = terraformExtensionsPacketSchema.parse(json(process.stdout));
    terraformRequire(
      path.isAbsolute(packet.temporary) &&
        path.basename(packet.temporary).startsWith("terraform-extensions-"),
      "Owned temporary root differs",
    );
    for (const [key, relative] of [
      ["workspace", "native"],
      ["source", "source"],
      ["data", "data"],
      ["mirror", "mirror"],
    ] as const)
      same(
        packet[key],
        path.join(packet.temporary, relative),
        "Owned directory role differs",
      );
    same(
      packet.nativeTemporary.before,
      path.join(packet.temporary, "tmp"),
      "Owned native temporary alias target differs",
    );
    same(
      packet.nativeTemporary.after,
      packet.nativeTemporary.before,
      "Owned native temporary alias changed",
    );
    same(
      packet.inputSha256,
      mavenHash(JSON.stringify(invocation)),
      "Invocation digest differs",
    );
    same(
      packet.preparedProvider,
      command.env?.CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT,
      "Operator provider root differs",
    );
    same(
      packet.sourceInputs,
      invocation.inputs.map((input) => ({
        ...input,
        afterSha256: input.sha256,
      })),
      "Frozen input cohort differs",
    );
    same(
      packet.nativeFiles,
      Object.keys(current.rendered).toSorted(),
      "Native source cohort differs",
    );
    same(
      packet.dataFiles,
      [
        "modules/modules.json",
        ...provider.members.map((member) =>
          path.posix.join(
            "providers",
            provider.address,
            provider.version,
            "linux_arm64",
            member.path,
          ),
        ),
      ].toSorted(),
      "Native data cohort differs",
    );
    terraformRequire(
      path.isAbsolute(packet.tool.entry) &&
        path.isAbsolute(packet.tool.resolved) &&
        realpathSync(packet.tool.entry) === packet.tool.resolved,
      "Current tool alias differs",
    );
    same(packet.tool.sha256, terraformBinarySha256, "Tool pin differs");
    same(packet.tool.afterSha256, packet.tool.sha256, "Tool changed");
    const toolBytes = terraformExtensionsRegular(
      packet.tool.resolved,
      128 * 1024 * 1024,
    );
    same(packet.tool.bytes, toolBytes.length, "Tool size differs");
    same(mavenHash(toolBytes), packet.tool.sha256, "Current tool changed");
    same(
      readdirSync(packet.preparedProvider).toSorted(),
      [
        provider.archive,
        "identity.json",
        ...provider.members.map((member) => member.path),
      ].toSorted(),
      "Current prepared provider cohort differs",
    );
    same(process.command, command, "Executed collector command differs");
    const pins = [
      {
        path: provider.archive,
        bytes: provider.archiveBytes,
        sha256: provider.archiveSha256,
      },
      ...provider.members,
    ];
    for (const [index, pin] of pins.entries()) {
      const observed = packet.artifacts[index]!;
      same(
        observed,
        {
          ...pin,
          entry: path.join(packet.preparedProvider, pin.path),
          afterSha256: pin.sha256,
        },
        "Prepared artifact pin differs",
      );
      const bytes = terraformExtensionsRegular(
        observed.entry,
        32 * 1024 * 1024,
      );
      same(bytes.length, pin.bytes, "Current provider size differs");
      same(mavenHash(bytes), pin.sha256, "Current provider bytes differ");
    }
    const metadata = packet.artifacts[3]!;
    same(metadata.path, "identity.json", "Prepared metadata role differs");
    same(
      metadata.entry,
      path.join(packet.preparedProvider, "identity.json"),
      "Prepared metadata path differs",
    );
    same(metadata.afterSha256, metadata.sha256, "Prepared metadata changed");
    const identityBytes = terraformExtensionsRegular(metadata.entry, 64 * 1024);
    same(
      identityBytes.length,
      metadata.bytes,
      "Current prepared metadata size differs",
    );
    same(
      mavenHash(identityBytes),
      metadata.sha256,
      "Current prepared metadata changed",
    );
    const identity = json(identityBytes.toString("utf8")) as {
      archiveSource?: unknown;
    };
    terraformRequire(
      identity &&
        [
          "operator-prepared-artifact",
          "https://releases.hashicorp.com/terraform-provider-random/3.9.1/" +
            provider.archive,
        ].includes(String(identity.archiveSource)),
      "Prepared origin differs",
    );
    same(
      identity,
      {
        schemaVersion: 1,
        provider,
        archiveSource: identity.archiveSource,
        completeMembersObserved: true,
        releaseSignatureVerified: false,
        publisherAndLicenseClosureVerified: false,
        nativeExecutionReached: false,
      },
      "Prepared metadata declaration differs",
    );
    for (const [index, pin] of provider.members.entries())
      same(
        packet.providerMembers[index],
        {
          ...pin,
          entry: path.join(
            packet.data,
            "providers",
            provider.address,
            provider.version,
            "linux_arm64",
            pin.path,
          ),
          afterSha256: pin.sha256,
        },
        "Installed provider member differs",
      );
    same(
      packet.copiedArchive,
      {
        file: path.join(
          packet.mirror,
          "registry.terraform.io/hashicorp/random",
          provider.archive,
        ),
        sha256: provider.archiveSha256,
        afterSha256: provider.archiveSha256,
      },
      "Owned archive pin differs",
    );
    const configText = `provider_installation {\n  filesystem_mirror {\n    path = ${JSON.stringify(packet.mirror)}\n    include = ["registry.terraform.io/hashicorp/random"]\n  }\n}\n`;
    same(
      packet.cliConfig,
      {
        file: path.join(packet.temporary, "home/terraform.tfrc"),
        text: configText,
        sha256: mavenHash(configText),
        afterSha256: mavenHash(configText),
      },
      "Exact local-only installation policy differs",
    );
    same(
      packet.lock,
      {
        file: path.join(packet.workspace, ".terraform.lock.hcl"),
        sha256: mavenHash(terraformExtensionsLock),
        afterSha256: mavenHash(terraformExtensionsLock),
      },
      "Pinned readonly lock differs",
    );
    same(
      packet.modules.file,
      path.join(packet.data, "modules/modules.json"),
      "Native modules role differs",
    );
    same(
      packet.modules.sha256,
      mavenHash(packet.modules.text),
      "Native metadata hash differs",
    );
    same(
      packet.modules.afterSha256,
      packet.modules.sha256,
      "Native modules metadata changed",
    );
    const modules = z
      .strictObject({
        Modules: z
          .array(
            z.strictObject({
              Key: z.string(),
              Source: z.string(),
              Dir: z.string(),
            }),
          )
          .min(4)
          .max(64),
      })
      .parse(json(packet.modules.text));
    const instances = terraformExtensionsModules(current.config);
    same(
      modules.Modules.toSorted((a, b) => a.Key.localeCompare(b.Key, "en")),
      instances
        .map((instance) => ({
          Key: instance.key,
          Source: instance.source,
          Dir: instance.directory,
        }))
        .sort((a, b) => a.Key.localeCompare(b.Key, "en")),
      "Complete installed local module graph differs",
    );
    const receipt = (index: number, phase: string, args: string[]) => {
      const row = packet.receipts[index]!;
      same(row.phase, phase, "Native phase order differs");
      same(row.executable, packet.tool.entry, "Native executable differs");
      same(row.args, args, "Fixed native arguments differ");
      same(row.stdoutSha256, mavenHash(row.stdout), "Native stdout changed");
      same(row.stderrSha256, mavenHash(row.stderr), "Native stderr changed");
      terraformRequire(!row.stderr, "Native stderr unaccounted");
      return row;
    };
    const versionSchema = z.strictObject({
      terraform_version: z.literal("1.16.5"),
      platform: z.literal("linux_arm64"),
      provider_selections: z.record(z.string(), z.string()),
      terraform_outdated: z.boolean(),
    });
    for (const [index, phase] of [
      [0, "version"],
      [2, "selected-version"],
    ] as const) {
      const r = receipt(index, phase, ["version", "-json"]);
      same(r.exitCode, 0, "Version did not complete");
      same(
        versionSchema.parse(json(r.stdout)).provider_selections,
        { [provider.address]: provider.version },
        "Native lock selection differs",
      );
    }
    const init = receipt(1, "init", [
      "init",
      "-json",
      "-no-color",
      "-backend=false",
      "-input=false",
      "-upgrade=false",
      "-lockfile=readonly",
    ]);
    same(init.exitCode, 0, "Local initialization did not complete");
    const ui = z.strictObject({
      "@level": z.literal("info"),
      "@message": z.string().min(1).max(65536),
      "@module": z.literal("terraform.ui"),
      "@timestamp": z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/),
      type: z.enum(["version", "init_output", "log"]),
      terraform: z.literal("1.16.5").optional(),
      ui: z.literal("1.3").optional(),
      message_code: z
        .enum([
          "initializing_modules_message",
          "initializing_provider_plugin_message",
          "output_init_success_message",
        ])
        .optional(),
    });
    const events = init.stdout
      .trim()
      .split("\n")
      .map((line) => ui.parse(json(line)));
    same(
      events.length,
      instances.length + 6,
      "Complete initialization UI cohort differs",
    );
    same(events[0]!.type, "version", "Initialization version missing");
    same(
      events[0]!["@message"],
      "Terraform 1.16.5",
      "Initialization version message differs",
    );
    same(
      events[0]!.message_code,
      undefined,
      "Initialization version role differs",
    );
    same(
      events.filter((event) => event.type === "version").length,
      1,
      "Initialization version cohort differs",
    );
    same(
      events[0]!.terraform,
      "1.16.5",
      "Initialization tool identity differs",
    );
    same(events[0]!.ui, "1.3", "Initialization UI format differs");
    const stages = events.filter((event) => event.type === "init_output");
    same(
      stages.map((event) => event.message_code),
      [
        "initializing_modules_message",
        "initializing_provider_plugin_message",
        "output_init_success_message",
      ],
      "Initialization stage order differs",
    );
    same(
      stages.map((event) => ({
        message: event["@message"],
        terraform: event.terraform,
        ui: event.ui,
      })),
      [
        "Initializing modules...",
        "Initializing provider plugins...",
        "Terraform has been successfully initialized!",
      ].map((message) => ({ message, terraform: undefined, ui: undefined })),
      "Initialization stage messages/roles differ",
    );
    same(
      events[1]!.message_code,
      "initializing_modules_message",
      "Initialization module stage position differs",
    );
    const pluginIndex = events.findIndex(
      (event) => event.message_code === "initializing_provider_plugin_message",
    );
    const moduleEvents = events.slice(2, pluginIndex);
    terraformRequire(
      moduleEvents.every(
        (event) =>
          event.type === "log" &&
          !event.message_code &&
          !event.terraform &&
          !event.ui,
      ),
      "Unknown module initialization role",
    );
    same(
      moduleEvents.map((event) => event["@message"]).toSorted(),
      instances
        .filter((instance) => instance.key)
        .map((instance) => "- " + instance.key + " in " + instance.directory)
        .toSorted(),
      "Complete module initialization log differs",
    );
    same(
      events.slice(pluginIndex + 1, -1).map((event) => ({
        type: event.type,
        message: event["@message"],
        code: event.message_code,
        terraform: event.terraform,
        ui: event.ui,
      })),
      [
        {
          type: "log",
          message:
            "hashicorp/random: Reusing previous version from the dependency lock file",
          code: undefined,
          terraform: undefined,
          ui: undefined,
        },
        {
          type: "log",
          message: "Installing provider version: hashicorp/random v3.9.1...",
          code: undefined,
          terraform: undefined,
          ui: undefined,
        },
        {
          type: "log",
          message:
            "Installed provider version: hashicorp/random v3.9.1 (unauthenticated)",
          code: undefined,
          terraform: undefined,
          ui: undefined,
        },
      ],
      "Exact provider installation log differs",
    );
    same(
      events.at(-1)!.message_code,
      "output_init_success_message",
      "Initialization terminal event differs",
    );
    const schema = receipt(3, "provider-schema", [
      "providers",
      "schema",
      "-json",
    ]);
    same(schema.exitCode, 0, "Native provider schema did not complete");
    same(
      mavenHash(schema.stdout),
      provider.schemaSha256,
      "Complete pinned provider schema differs",
    );
    const validation = receipt(4, "validate", [
        "validate",
        "-json",
        "-no-color",
      ]),
      result = terraformExtensionsNativeResultSchema.parse(
        json(validation.stdout),
      );
    const errors = result.diagnostics.filter(
        (d) => d.severity === "error",
      ).length,
      warnings = result.diagnostics.filter(
        (d) => d.severity === "warning",
      ).length;
    same(result.error_count, errors, "Error cohort differs");
    same(result.warning_count, warnings, "Warning cohort differs");
    same(result.valid, errors === 0, "Native validity differs");
    same(validation.exitCode, errors ? 1 : 0, "Validation exit differs");
    const findings: Finding[] = [];
    for (const diagnostic of result.diagnostics) {
      terraformRequire(
        diagnostic.range && diagnostic.snippet,
        "Source-bound diagnostics required",
      );
      const { range, snippet } = diagnostic;
      const sourceText = current.rendered[range.filename];
      terraformRequire(
        sourceText && range.filename !== ".terraform.lock.hcl",
        "Declared original diagnostic source required",
      );
      const bytes = Buffer.from(sourceText),
        { start, end } = range;
      terraformRequire(
        start.byte < end.byte && end.byte <= bytes.length,
        "Physical diagnostic range differs",
      );
      const point = (p: z.infer<typeof terraformExtensionsPositionSchema>) => {
        const before = bytes.subarray(0, p.byte).toString("utf8");
        terraformRequire(
          Buffer.byteLength(before) === p.byte &&
            before.split("\n").length === p.line &&
            Array.from(
              new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
                before.slice(before.lastIndexOf("\n") + 1),
              ),
            ).length +
              1 ===
              p.column,
          "Physical diagnostic position differs",
        );
      };
      point(start);
      point(end);
      const lines = sourceText.split("\n");
      same(
        lines
          .slice(
            snippet.start_line - 1,
            snippet.start_line - 1 + snippet.code.split("\n").length,
          )
          .join("\n"),
        snippet.code,
        "Native snippet differs",
      );
      terraformRequire(
        snippet.highlight_start_offset < snippet.highlight_end_offset &&
          snippet.highlight_end_offset <= Buffer.byteLength(snippet.code),
        "Native highlight bound differs",
      );
      const prefixBytes = Buffer.byteLength(
        lines.slice(0, snippet.start_line - 1).join("\n") +
          (snippet.start_line > 1 ? "\n" : ""),
      );
      same(
        prefixBytes + snippet.highlight_start_offset,
        start.byte,
        "Native highlight start differs",
      );
      same(
        prefixBytes + snippet.highlight_end_offset,
        end.byte,
        "Native highlight end differs",
      );
      findings.push({
        ruleId: "terraform/validate-extensions",
        level: diagnostic.severity,
        file: range.filename,
        line: start.line,
        message:
          diagnostic.summary +
          (diagnostic.detail ? ": " + diagnostic.detail : ""),
      });
    }
    if (warnings)
      return {
        ...incomplete,
        findings,
        reason:
          "Native Terraform extension validation returned warnings outside the selected warning-free profile.",
      };
    return {
      status: errors ? "failed" : "passed",
      reason: errors
        ? "Native Terraform validation found source-bound local module/provider errors."
        : "The complete declared local module and pinned-provider graph passed native validation.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
