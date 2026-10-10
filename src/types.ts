import type { CapturedProcessOutput } from "./process-output.js";
import type { WindowsExecution } from "./windows-execution.js";
import type { RustBuildSelection } from "./rust-build.js";
import type { GoTargetEvidence, GoBuildSelection } from "./go-build.js";
import type { GoScopePolicy } from "./go-scope-policy.js";
import type { GoWorkspace } from "./go-workspace.js";
import type { ExternalIdentity } from "./external-adapter.js";
import type { RuntimeInventory } from "./runtime-inventory.js";
export const VERSION = "0.1.0-alpha.5";

export const PARSERS = [
  "vue-router-json",
  "nuxt-json",
  "exit",
  "empty",
  "node-events",
  "node-loader-events",
  "vite-library-json",
  "unittest",
  "go-scope-test",
  "go-scope-analysis",
  "go-build",
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
  "rust-test-json",
  "rustfmt-json",
  "clang-json",
  "cpp-tools-json",
  "kubeconform-json",
  "kustomize-json",
  "terraform-json",
  "helm-json",
  "java-json",
  "checkstyle-json",
  "spotbugs-json",
  "detekt-json",
  "kotlin-json",
  "scala-json",
  "maven-json",
  "gradle-json",
  "dotnet-json",
  "dotnet-build-json",
  "dotnet-test-json",
  "dotnet-format-json",
  "fsharp-format-json",
  "dotnet-format-extensions-json",
  "dotnet-generator-extensions-json",
  "actionlint-json",
  "external-json",
  "ruby-syntax",
  "ruby-tools-json",
  "swift-tools-json",
  "silent-syntax",
  "ruff-json",
  "python-extension-json",
  "mypy-json",
  "pyright-json",
  "phpstan-json",
  "php-extension-json",
  "phpunit-junit",
  "pint-json",
  "php-cs-fixer-json",
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
  | {
      name: string;
      source: "package-metadata";
      path: string | null;
      package?: string;
    }
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
  goScope?: GoScopePolicy;
  goWorkspace?: GoWorkspace;
  goBuild?: GoBuildSelection;
  rustBuild?: RustBuildSelection;
  executionId?: string;
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
  capturedOutput?: CapturedProcessOutput;
  windowsExecution?: WindowsExecution;
  command: Command;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  /** Raw stdout/stderr bytes delivered, including chunks beyond the retention limit. */
  outputBytes?: number;
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
  goTarget?: GoTargetEvidence;
  goScope?: GoScopePolicy;
  goWorkspace?: GoWorkspace;
  goBuild?: GoBuildSelection;
  rustBuild?: RustBuildSelection;
  executionId?: string;
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
  requiredExecutionIds?: string[];
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
