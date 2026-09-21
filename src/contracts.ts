import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  contractBundleSchema,
  contractReportSchema,
  contractSummarySchema,
  type ContractReport,
} from "./contract-schema.js";
import { VERSION } from "./types.js";

function inputJSON(input: unknown): string {
  let count = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number) {
    if (++count > 100_000 || depth > 32)
      throw new Error("Contract input exceeds structure limits");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (typeof value !== "object" || seen.has(value))
      throw new Error("Contract input must be finite acyclic JSON");
    seen.add(value);
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Contract input must contain plain JSON objects");
    for (const item of Object.values(value)) visit(item, depth + 1);
    seen.delete(value);
  }
  visit(input, 0);
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024)
    throw new Error("Contract input exceeds 8 MiB limit");
  return json;
}

export async function validateContracts(
  input: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ContractReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error(
      "Contract timeout must be between 1 and 30000 milliseconds",
    );
  const json = inputJSON(input);
  const bundle = contractBundleSchema.parse(JSON.parse(json));
  const ids = new Set<string>();
  for (const contract of bundle.contracts) {
    if (ids.has(contract.id)) throw new Error("Duplicate contract ID");
    ids.add(contract.id);
    const samples = new Set<string>();
    for (const sample of contract.samples) {
      if (samples.has(sample.name) || !Object.hasOwn(sample, "payload"))
        throw new Error("Duplicate sample name or missing payload");
      samples.add(sample.name);
    }
  }
  const fingerprint = createHash("sha256").update(json).digest("hex");
  const incomplete = (): ContractReport => ({
    schemaVersion: 1,
    engineVersion: VERSION,
    provenance: "imported-contract-samples",
    outcome: "incomplete",
    reason:
      "Contract validation did not finish within its worker, time or cancellation limits.",
    artifactFingerprint: fingerprint,
    counts: {
      contracts: bundle.contracts.length,
      passed: 0,
      failed: 0,
      unverified: bundle.contracts.length,
      samples: 0,
      accepted: 0,
      rejected: 0,
    },
    contracts: bundle.contracts.map((contract) => ({
      id: contract.id,
      outcome: "incomplete",
      reason: "Worker validation did not complete.",
      samples: [],
    })),
  });
  if (options.signal?.aborted) return incomplete();
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL("./contract-worker.js", import.meta.url),
      {
        workerData: { bundle, fingerprint },
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      },
    );
    let settled = false;
    const finish = (value: ContractReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      void worker.terminate().finally(() => resolve(value));
    };
    const abort = () => finish(incomplete());
    const timer = setTimeout(abort, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: unknown) => {
      const result = contractReportSchema.safeParse(message);
      finish(result.success ? result.data : incomplete());
    });
    worker.once("error", abort);
    worker.once("exit", abort);
    if (options.signal?.aborted) abort();
  });
}

export function projectContractReport(
  result: ContractReport,
  detailed: boolean,
) {
  if (detailed) return result;
  return contractSummarySchema.parse({
    schemaVersion: result.schemaVersion,
    engineVersion: result.engineVersion,
    provenance: result.provenance,
    outcome: result.outcome,
    reason: result.reason,
    artifactFingerprint: result.artifactFingerprint,
    counts: result.counts,
  });
}
