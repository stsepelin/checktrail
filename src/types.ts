import type { ExternalIdentity } from "./external-adapter.js";
import type { RuntimeInventory } from "./runtime-inventory.js";
export const VERSION = "0.1.0-alpha.1";

export const PARSERS = [
  "vue-router-json",
  "nuxt-json",
  "exit",
  "empty",
  "node-events",
  "unittest",
  "go-scope-test",
  "go-scope-analysis",
  "golangci-json",
  "staticcheck-json",
  "go-json",
  "typescript-build-json",
  "tsc-files",
  "eslint-json",
  "vitest-json",
  "playwright-json",
  "jest-json",
  "pytest-json",
  "fastapi-json",
  "django-json",
  "laravel-json",
  "rust-json",
  "clang-json",
  "java-json",
  "dotnet-json",
  "actionlint-json",
  "external-json",
  "ruby-syntax",
  "silent-syntax",
  "ruff-json",
  "mypy-json",
  "phpstan-json",
  "phpunit-junit",
  "pint-json",
] as const;

export type Status =
  "passed" | "failed" | "unavailable" | "skipped" | "error" | "inconclusive";
export type Outcome = "passed" | "failed" | "incomplete";

export interface Inventory {
  root: string;
  files: string[];
  excluded: string[];
  fingerprint: string;
}

export interface Project {
  path: string;
  adapter: string;
  markers: string[];
  files: string[];
}

export interface Command {
  temporaryDirectory?: boolean;
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export type ToolSpec =
  | { name: "node"; source: "engine-runtime" }
  | { name: string; source: "package-metadata"; path: string | null }
  | { name: string; source: "version-command"; command: Command };

export interface ToolEvidence {
  name: string;
  source: ToolSpec["source"];
  version: string | null;
  status: "identified" | "unavailable" | "inconclusive";
  process?: ProcessResult;
  path?: string;
}

export interface Check {
  external?: ExternalIdentity;
  id: string;
  adapter: string;
  project: string;
  scope: string[];
  kind: "format" | "analysis" | "test" | "syntax" | "unsupported";
  parser: (typeof PARSERS)[number];
  commands: Command[];
  reason: string;
  unavailableReason?: string;
  tools?: ToolSpec[];
  environment?: string[];
}

export interface Workspace {
  complete: boolean;
  dependencies: { consumer: string; producer: string }[];
}
export interface GitIdentity {
  baseCommit: string;
  headCommit: string;
  version: string;
  worktreeId: string;
  indexFingerprint: string;
}
export interface ChangeSelection {
  mode: "full" | "affected";
  reason: string;
  changedFiles: string[];
  selectedProjects: string[];
  git?: GitIdentity;
}

export interface Plan {
  schemaVersion: 1;
  engineVersion: string;
  sourceFingerprint: string;
  policyFingerprint: string;
  excluded: string[];
  projects: Project[];
  checks: Check[];
  workspace?: Workspace;
  selection?: ChangeSelection;
}

export interface ProcessResult {
  command: Command;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  errorCode?: string;
}

export interface TestEvidence {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface Finding {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: string;
  file?: string;
  line?: number;
}

export interface CheckResult {
  external?: ExternalIdentity & {
    tools?: { name: string; version: string; source: "adapter-reported" }[];
  };
  runtime?: RuntimeInventory;
  id: string;
  adapter: string;
  project: string;
  scope: string[];
  status: Status;
  reason: string;
  processes: ProcessResult[];
  tests?: TestEvidence;
  findings?: Finding[];
  findingsComplete?: boolean;
  environment?: { names: string[]; fingerprint: string };
  tools?: ToolEvidence[];
}

export interface Report {
  selection?: ChangeSelection;
  schemaVersion: 1;
  engineVersion: string;
  runId: string;
  startedAt: string;
  durationMs: number;
  sourceFingerprint: string;
  finalSourceFingerprint: string | null;
  policyFingerprint: string;
  sourceChanged: boolean;
  sourceError: boolean;
  excluded: string[];
  outcome: Outcome;
  checks: CheckResult[];
}
