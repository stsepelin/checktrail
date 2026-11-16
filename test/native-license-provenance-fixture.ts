import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { validate } from "../src/engine.js";
import type { Report } from "../src/types.js";

export const provenanceRepository = fileURLToPath(
  new URL("../../", import.meta.url),
);
export const provenanceNotice =
  "Original synthetic notice for fictional components.\r\nCopyright Synthetic Contributors\r\n";
export const hash = (raw: string | Buffer) =>
  createHash("sha256").update(raw).digest("hex");
const installedPackage =
  process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE;
if (process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED === "1") {
  assert.ok(
    installedPackage && path.isAbsolute(installedPackage),
    "Installed fixture requires the selected package root",
  );
}
export const coordinator = await import(
  pathToFileURL(
    path.join(
      process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED === "1"
        ? installedPackage!
        : provenanceRepository,
      "scripts/native-provenance-coordinator.mjs",
    ),
  ).href
);
export interface ProvenanceReceipt {
  schemaVersion: number;
  scope: string;
  runId: string;
  state: "incomplete" | "error";
  rawOutputRetentionComplete: boolean;
  sourceFingerprint: string;
  operatorPolicySha256: string;
  inputs: Record<string, { files: number; bytes: number; sha256: string }>;
  audits: Array<{
    phase: string;
    state: string;
    exitCode?: number;
    auditorSha256?: string;
    stdoutSha256?: string;
    stderrSha256?: string;
    timedOut?: boolean;
    truncated?: boolean;
    gaps?: number;
    inspectedPackageCount?: number;
    lockedPackageCount?: number;
  }>;
  proofs: Array<{
    family: string;
    state: string;
    nativeVerificationObservedByCoordinator: boolean;
  }>;
  unresolved: Array<{ family: string; dimension: string; state: string }>;
  legalComplianceAssessed: false;
  cryptographicVerificationExecutedByCoordinator: false;
  fullCompilerSdkBootstrapClosureVerified: false;
  completeOriginalNoticeClosureVerified: false;
  gateAComplete: false;
  error?: string;
}
export async function provenanceFixture(t: TestContext) {
  const root = await realpath(await fixture(t, {}));
  const project = path.join(root, "project"),
    npm = path.join(root, "npm"),
    artifacts = path.join(root, "artifacts"),
    journal = path.join(root, "private-journal/operator-observation.jsonl");
  await mkdir(path.dirname(journal), { mode: 0o700 });
  if (process.platform === "win32") {
    const acl = await import("../src/windows-task-access.js");
    acl.ensureWindowsTaskAccess(path.dirname(journal), "directory", true);
  }
  await mkdir(project);
  await mkdir(npm);
  await mkdir(artifacts);
  await writeFile(
    path.join(project, "native-provenance.project"),
    "Original synthetic provenance control; private marker contents\n",
  );
  const manifest = {
    name: "synthetic-native-provenance",
    version: "1.0.0",
    private: true,
    dependencies: { "synthetic-production": "1.0.0" },
    devDependencies: { "synthetic-development": "1.0.0" },
  };
  const packages: Record<string, unknown> = {
    "": {
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
    },
  };
  await mkdir(path.join(npm, "scripts"));
  await writeFile(
    path.join(npm, "scripts/audit-dependencies.mjs"),
    await readFile(
      path.join(provenanceRepository, "scripts/audit-dependencies.mjs"),
    ),
  );
  await writeFile(path.join(npm, "scripts/license-sources.json"), "{}");
  for (const [name, dev] of [
    ["synthetic-production", false],
    ["synthetic-development", true],
  ] as const) {
    const local = "node_modules/" + name;
    packages[local] = {
      name,
      version: "1.0.0",
      resolved:
        "https://registry.npmjs.org/" + name + "/-/" + name + "-1.0.0.tgz",
      integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64"),
      license: "MIT",
      ...(dev ? { dev: true } : {}),
    };
    await mkdir(path.join(npm, local), { recursive: true });
    await writeFile(
      path.join(npm, local, "package.json"),
      JSON.stringify({ name, version: "1.0.0", license: "MIT" }),
    );
    await writeFile(
      path.join(npm, local, "LICENSE"),
      "Original synthetic license text for " + name + "\n",
    );
  }
  await writeFile(path.join(npm, "package.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(npm, "package-lock.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    }),
  );
  const directory = "docs/measurements/artifact-identities-2026-10-21",
    evidence = path.join(artifacts, directory);
  await mkdir(evidence, { recursive: true });
  await mkdir(path.join(artifacts, "src"));
  const source = Buffer.from("export const syntheticProvenance = 1;\n"),
    sourcePin = {
      file: "src/synthetic.ts",
      bytes: source.length,
      sha256: hash(source),
    };
  await writeFile(path.join(artifacts, sourcePin.file), source);
  const notice = Buffer.from(provenanceNotice),
    noticePin = {
      file: "NOTICE-synthetic.txt",
      bytes: notice.length,
      sha256: hash(notice),
    };
  await writeFile(path.join(evidence, noticePin.file), notice);
  const entries = [noticePin];
  for (const [name, scope] of [
    ["scala2.json", "scala2"],
    ["fantomas.json", "fantomas"],
    ["random-provider.json", "random-provider"],
    ["wasm-toolchain.json", "wasm-toolchain"],
  ]) {
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        scope,
        repositoryInputs: [sourcePin],
        observations: {
          originalNotice: {
            bytes: notice.length,
            sha256: hash(notice),
            originalBytesBase64: notice.toString("base64"),
          },
        },
        retainedNotices: [noticePin],
        remainingInputs: [
          "Original producer and complete notice applicability not qualified",
        ],
        gateAComplete: false,
        completeArtifactAndNoticeClosureVerified: false,
        preparationAndReceiptIntegrationVerified: false,
      }),
    );
    await writeFile(path.join(evidence, name!), body);
    entries.push({ file: name!, bytes: body.length, sha256: hash(body) });
  }
  await writeFile(
    path.join(evidence, "artifact-evidence-index.v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      observationsOnly: true,
      retainedReferences: 4,
      files: entries,
      repositoryInputs: [sourcePin],
    }),
  );
  const engineRoot = await realpath(
    fileURLToPath(new URL("../src/", import.meta.url)),
  );
  const prepare = async (
    options: {
      engineRoot?: string;
      npmCliFile?: string;
      proofs?: unknown[];
      limits?: { auditTimeoutMs: number; auditOutputBytes: number };
    } = {},
  ) => {
    const bundle = await coordinator.createNativeProvenanceBundle({
      engineRoot: options.engineRoot ?? engineRoot,
      npmRoot: npm,
      artifactRoot: artifacts,
      journal,
      ...options,
    });
    const target = path.join(
      root,
      "adapter-" + hash(bundle.bytes) + ".bundle.json",
    );
    await writeFile(target, bundle.bytes);
    return {
      reference: { path: target, sha256: hash(bundle.bytes) },
      policy: bundle.policy,
      manifest: bundle.manifest,
      bytes: bundle.bytes as Buffer,
    };
  };
  return {
    root,
    project,
    npm,
    artifacts,
    evidence,
    journal,
    engineRoot,
    prepare,
  };
}
export function retainedProvenanceReceipt(report: Report): ProvenanceReceipt {
  const process = report.checks[0]!.processes.at(-1)!;
  assert.ok(process.stdout, JSON.stringify(process));
  const envelope = JSON.parse(process.stdout) as {
    stdout: string;
    stderr: string;
  };
  assert.ok(
    envelope.stderr.startsWith("CHECKTRAIL_PROVENANCE_RECEIPT "),
    envelope.stderr,
  );
  const raw = envelope.stderr
    .slice("CHECKTRAIL_PROVENANCE_RECEIPT ".length)
    .trim();
  const result = JSON.parse(envelope.stdout) as {
    tools: Array<{ version: string }>;
  };
  assert.equal(result.tools[0]!.version, "v1-" + hash(raw));
  return JSON.parse(raw) as ProvenanceReceipt;
}
export async function runProvenance(
  project: string,
  reference: { path: string; sha256: string },
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return validate(project, {
    trusted: true,
    externalAdapters: [reference],
    timeoutMs: 30000,
    ...options,
  });
}
export async function observeProvenanceBootstrap(
  journal: string,
  timeout = 10000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const text = await readFile(journal, "utf8").catch(() => "");
    const event = text
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            state: string;
            pid?: number;
            temporary?: string;
          },
      )
      .find((row) => row.state === "audit-bootstrap-entered");
    if (event) {
      assert.ok(event.pid);
      return event as { state: string; pid: number; temporary: string };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(
    "The real pinned audit child bootstrap must be reached before steering",
  );
}
export async function assertProvenanceProcessGone(pid: number) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Owned audit child remains after terminal cleanup");
}
export async function removeProvenanceNotice(npm: string) {
  await rm(path.join(npm, "node_modules/synthetic-development/LICENSE"));
}
