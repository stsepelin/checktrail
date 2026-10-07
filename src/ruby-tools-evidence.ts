import path from "node:path";
import { z } from "zod";
import {
  rubyToolsInvocationSchema,
  rubyToolsRepositorySchema,
  rubyToolsSame,
} from "./ruby-tools.js";
import { rubyToolsNativeSource } from "./ruby-tools-native.js";
import { mavenHash } from "./maven.js";
import { externalPathSchema } from "./external-schema.js";
import type {
  Check,
  CheckResult,
  Finding,
  ProcessResult,
  TestEvidence,
} from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  string = z.string().max(65536),
  file = z.string().min(1).max(8192),
  count = z.number().int().nonnegative().max(20000);
export const rubyToolsPacketSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["rubocop", "rspec", "minitest"]),
  inputSha256: digest,
  observerSha256: digest,
  optionsSha256: digest,
  repositoryManifest: z.string().max(1024 * 1024),
  workspace: file,
  install: file,
  installedArtifactsAfter: z.strictObject({
    files: count,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    sha256: digest,
  }),
  installedArtifacts: z.strictObject({
    entries: z
      .array(
        z.strictObject({
          path: externalPathSchema,
          bytes: z
            .number()
            .int()
            .nonnegative()
            .max(32 * 1024 * 1024),
          sha256: digest,
        }),
      )
      .min(1)
      .max(20000),
    files: z.number().int().positive().max(20000),
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    sha256: digest,
  }),
  metadata: z.string().max(1024 * 1024),
  data: z.string().max(2 * 1024 * 1024),
  dataSha256: digest,
  metadataSha256: digest,
  receipts: z
    .array(
      z.strictObject({
        phase: file,
        exitCode: z.number().int().min(0).max(255),
        stdoutBytes: z
          .number()
          .int()
          .nonnegative()
          .max(2 * 1024 * 1024),
        stderrBytes: z
          .number()
          .int()
          .nonnegative()
          .max(2 * 1024 * 1024),
        stdoutSha256: digest,
        stderrSha256: digest,
        durationMs: z.number().int().nonnegative(),
      }),
    )
    .length(2),
});
const spec = z.strictObject({ name: file, version: file, path: file });
const metadataSchema = z.strictObject({
  messages: string,
  ruby: z.literal("4.0.7"),
  engine: z.literal("ruby"),
  platform: file,
  patchlevel: z.literal(0),
  bundler: z.literal("4.0.20"),
  specs: z.array(spec).min(1).max(513),
  loaded: z.array(spec).min(1).max(1024),
  compiled: z.array(z.strictObject({ file, sha256: digest })).max(2048),
  toolVersion: file,
  toolFile: file,
  toolFileSha256: digest,
});
const rowSchema = z.strictObject({
  id: file,
  name: string,
  file,
  line: z.number().int().positive().max(1000000),
});
const resultSchema = rowSchema.extend({
  outcome: z.enum(["passed", "failed", "pending"]),
  assertions: count.nullable(),
  error: string,
});
const testSchema = z.strictObject({
  rows: z.array(rowSchema).max(20000),
  started: z.array(file).max(20000),
  results: z.array(resultSchema).max(20000),
  summary: z
    .strictObject({
      total: count,
      failed: count,
      skipped: count,
      assertions: count.nullable(),
      outsideErrors: count,
    })
    .nullable(),
});
const offenseSchema = z.strictObject({
  severity: z.enum(["refactor", "convention", "warning", "error", "fatal"]),
  message: string,
  cop_name: file,
  corrected: z.literal(false),
  correctable: z.boolean(),
  location: z.strictObject({
    start_line: z.number().int().positive(),
    start_column: z.number().int().positive(),
    last_line: z.number().int().positive(),
    last_column: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  }),
});
const rubocopSchema = z.strictObject({
  metadata: z.strictObject({
    rubocop_version: z.literal("1.91.0"),
    ruby_engine: z.literal("ruby"),
    ruby_version: z.literal("4.0.7"),
    ruby_patchlevel: z.literal("0"),
    ruby_platform: file,
  }),
  files: z
    .array(
      z.strictObject({
        path: file,
        offenses: z.array(offenseSchema).max(20000),
      }),
    )
    .min(1)
    .max(2049),
  summary: z.strictObject({
    offense_count: count,
    target_file_count: count,
    inspected_file_count: count,
  }),
});
function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
export function rubyToolsEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "tests"> {
  try {
    requireEvidence(
      check.commands.length === 1 && processes.length === 1,
      "Ruby process accounting differs",
    );
    const process = processes[0]!;
    requireEvidence(
      process.exitCode === 0 &&
        !process.stderr.trim() &&
        !process.cancelled &&
        !process.timedOut &&
        !process.truncated &&
        !process.errorCode &&
        !process.signal,
      "Ruby native collection is incomplete",
    );
    const invocation = rubyToolsInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      config = invocation.config;
    const packet = rubyToolsPacketSchema.parse(JSON.parse(process.stdout));
    requireEvidence(
      check.id === `ruby.${packet.mode}` &&
        check.commands[0]!.args[3] === packet.mode,
      "Ruby check and native mode differ",
    );
    requireEvidence(
      packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)) &&
        new Set(invocation.inputs.map((p) => p.path)).size ===
          invocation.inputs.length,
      "Ruby input identity differs",
    );
    requireEvidence(
      packet.observerSha256 === mavenHash(rubyToolsNativeSource),
      "Ruby observer identity differs",
    );
    const options =
      packet.mode === "rubocop"
        ? "AllCops:\n  TargetRubyVersion: 4.0\n  NewCops: disable\n  EnabledByDefault: false\n" +
          config.cops.map((cop) => cop + ":\n  Enabled: true\n").join("")
        : "";
    requireEvidence(
      packet.optionsSha256 === mavenHash(options) &&
        new Set(config.cops).size === config.cops.length,
      "Ruby effective settings differ",
    );
    requireEvidence(
      packet.dataSha256 === mavenHash(packet.data) &&
        packet.metadataSha256 === mavenHash(packet.metadata),
      "Ruby native artifact identity differs",
    );
    requireEvidence(
      mavenHash(packet.repositoryManifest) === config.repositorySha256,
      "Ruby repository identity differs",
    );
    const repository = rubyToolsRepositorySchema.parse(
      JSON.parse(packet.repositoryManifest),
    );
    requireEvidence(
      new Set(repository.files.map((p) => p.path)).size ===
        repository.files.length,
      "Ruby repository paths are ambiguous",
    );
    const installed = packet.installedArtifacts,
      entries = installed.entries;
    requireEvidence(
      new Set(entries.map((e) => e.path)).size === entries.length &&
        installed.files === entries.length &&
        installed.bytes === entries.reduce((n, e) => n + e.bytes, 0) &&
        installed.sha256 === mavenHash(JSON.stringify(entries)) &&
        JSON.stringify(packet.installedArtifactsAfter) ===
          JSON.stringify({
            files: installed.files,
            bytes: installed.bytes,
            sha256: installed.sha256,
          }),
      "Ruby installed artifact identity differs",
    );
    const metadata = metadataSchema.parse(JSON.parse(packet.metadata));
    requireEvidence(
      path.isAbsolute(packet.workspace) &&
        path.isAbsolute(packet.install) &&
        path.join(path.dirname(packet.workspace), "install") ===
          packet.install &&
        path.basename(packet.workspace) === "project",
      "Ruby owned output paths differ",
    );
    requireEvidence(
      new Set(metadata.specs.map((s) => s.name)).size ===
        metadata.specs.length &&
        new Set(metadata.loaded.map((s) => s.name)).size ===
          metadata.loaded.length,
      "Ruby gem identities are ambiguous",
    );
    const dependencySpecs = metadata.specs.filter((s) => s.name !== "bundler");
    requireEvidence(
      metadata.specs.find((s) => s.name === "bundler")?.version === "4.0.20" &&
        rubyToolsSame(
          repository.files.map((f) => f.path),
          dependencySpecs.map((s) => `${s.name}-${s.version}.gem`),
        ),
      "Ruby native dependency closure differs",
    );
    for (const spec of dependencySpecs)
      requireEvidence(
        spec.path ===
          path.join(
            packet.install,
            "ruby/4.0.0/gems",
            `${spec.name}-${spec.version}`,
          ),
        "Ruby gem escaped the fresh install",
      );
    const tools = {
      rubocop: {
        name: "rubocop",
        version: "1.91.0",
        entry: "lib/rubocop/cli.rb",
      },
      rspec: {
        name: "rspec-core",
        version: "3.13.6",
        entry: "lib/rspec/core/runner.rb",
      },
      minitest: {
        name: "minitest",
        version: "6.0.6",
        entry: "lib/minitest.rb",
      },
    }[packet.mode];
    const tool = metadata.loaded.find((s) => s.name === tools.name),
      resolved = metadata.specs.find((s) => s.name === tools.name);
    requireEvidence(
      tool &&
        resolved &&
        tool.version === tools.version &&
        resolved.version === tools.version &&
        tool.path === resolved.path &&
        metadata.toolVersion === tools.version &&
        metadata.toolFile === path.join(tool.path, tools.entry),
      "Ruby native tool entry point or version differs",
    );
    requireEvidence(
      entries.find(
        (e) => path.join(packet.install, e.path) === metadata.toolFile,
      )?.sha256 === metadata.toolFileSha256,
      "Ruby loaded entry point bytes differ",
    );
    const compiled = new Map(metadata.compiled.map((s) => [s.file, s]));
    requireEvidence(
      compiled.size === metadata.compiled.length &&
        metadata.compiled.every(
          (s) =>
            invocation.inputs.find((p) => p.path === s.file)?.sha256 ===
            s.sha256,
        ) &&
        compiled.has("Gemfile"),
      "Ruby native compiled source differs",
    );
    const restore = packet.receipts[0]!,
      native = packet.receipts[1]!;
    requireEvidence(
      restore.phase === "restore" &&
        restore.exitCode === 0 &&
        native.phase === packet.mode &&
        [0, 1].includes(native.exitCode) &&
        native.stderrBytes === 0 &&
        native.stderrSha256 === mavenHash(""),
      "Ruby native phase receipts differ",
    );
    const findings: Finding[] = [];
    if (packet.mode === "rubocop") {
      requireEvidence(
        native.stdoutBytes === Buffer.byteLength(packet.data) &&
          native.stdoutSha256 === packet.dataSha256,
        "RuboCop stdout receipt differs",
      );
      const data = rubocopSchema.parse(JSON.parse(packet.data));
      requireEvidence(
        data.metadata.ruby_platform === metadata.platform &&
          rubyToolsSame(
            data.files.map((f) => f.path),
            ["Gemfile", ...config.sources],
          ) &&
          rubyToolsSame(check.scope, ["Gemfile", ...config.sources]),
        "RuboCop inspected scope differs",
      );
      let offenses = 0;
      for (const entry of data.files)
        for (const offense of entry.offenses) {
          requireEvidence(
            config.cops.includes(offense.cop_name) ||
              offense.cop_name === "Lint/Syntax",
            "RuboCop reported an unselected cop",
          );
          requireEvidence(
            offense.location.line === offense.location.start_line &&
              offense.location.column === offense.location.start_column &&
              offense.location.last_line >= offense.location.start_line,
            "RuboCop diagnostic location differs",
          );
          offenses++;
          findings.push({
            ruleId: `ruby.rubocop.${offense.cop_name}`,
            level: "error",
            message: offense.message,
            file: path.posix.join(check.project, entry.path),
            line: offense.location.start_line,
          });
        }
      requireEvidence(
        data.summary.offense_count === offenses &&
          data.summary.target_file_count === data.files.length &&
          data.summary.inspected_file_count === data.files.length &&
          native.exitCode === (offenses ? 1 : 0),
        "RuboCop native counts or exit differ",
      );
      return {
        status: offenses ? "failed" : "passed",
        reason: offenses
          ? "Native RuboCop reported diagnostics in the complete declared scope."
          : "Every declared Ruby file was inspected by the pinned selected native cops.",
        ...(findings.length ? { findings } : {}),
      };
    }
    const suite = config[packet.mode];
    requireEvidence(
      suite.files.length > 0 &&
        rubyToolsSame(check.scope, [...suite.files, ...suite.support]) &&
        [...suite.files, ...suite.support].every((file) => compiled.has(file)),
      "Ruby test source participation differs",
    );
    const data = testSchema.parse(JSON.parse(packet.data));
    const registered = new Map(data.rows.map((row) => [row.id, row]));
    requireEvidence(
      data.rows.length > 0 &&
        registered.size === data.rows.length &&
        rubyToolsSame(
          data.rows.map((r) => r.id),
          data.started,
        ) &&
        rubyToolsSame(
          data.rows.map((r) => r.id),
          data.results.map((r) => r.id),
        ),
      "Ruby registered, started and result cases differ",
    );
    requireEvidence(
      suite.files.every((file) => data.rows.some((row) => row.file === file)),
      "A selected Ruby test file registered no test",
    );
    const counts: TestEvidence = {
      total: data.results.length,
      passed: 0,
      failed: 0,
      skipped: 0,
    };
    let assertions = 0;
    for (const result of data.results) {
      const row = registered.get(result.id)!;
      requireEvidence(
        JSON.stringify({
          id: result.id,
          name: result.name,
          file: result.file,
          line: result.line,
        }) === JSON.stringify(row) &&
          suite.files.includes(row.file) &&
          compiled.has(row.file),
        "Ruby result source or method identity differs",
      );
      if (packet.mode === "rspec")
        requireEvidence(
          result.assertions === null,
          "RSpec assertion count must stay unknown",
        );
      else {
        requireEvidence(
          result.assertions !== null,
          "Minitest assertion count is missing",
        );
        assertions += result.assertions;
      }
      if (result.outcome === "passed") {
        requireEvidence(!result.error, "Passing Ruby test carries an error");
        counts.passed++;
      } else if (result.outcome === "pending") counts.skipped++;
      else {
        counts.failed++;
        findings.push({
          ruleId: check.id,
          level: "error",
          message:
            result.error || "A source-bound registered Ruby test failed.",
          file: path.posix.join(check.project, row.file),
          line: row.line,
        });
      }
    }
    const summary = data.summary;
    requireEvidence(
      summary &&
        summary.total === counts.total &&
        summary.failed === counts.failed &&
        summary.skipped === counts.skipped &&
        summary.outsideErrors === 0 &&
        summary.assertions === (packet.mode === "rspec" ? null : assertions) &&
        native.exitCode === (counts.failed ? 1 : 0),
      "Ruby native summary, errors or exit differ",
    );
    return {
      status: counts.failed
        ? "failed"
        : counts.skipped || !counts.passed
          ? "inconclusive"
          : "passed",
      reason: counts.failed
        ? "Source-bound registered native Ruby tests failed."
        : counts.skipped
          ? "Native Ruby tests include skipped cases; the declared scope is not fully exercised."
          : "Every registered native Ruby case ran with reconciled source locations and outcomes.",
      tests: counts,
      ...(findings.length ? { findings } : {}),
    };
  } catch {
    return {
      status: "inconclusive",
      reason:
        "Ruby native scope, provenance, lifecycle, artifacts or counts did not reconcile.",
    };
  }
}
