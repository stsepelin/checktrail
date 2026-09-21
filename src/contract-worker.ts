import { parentPort, workerData } from "node:worker_threads";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ContractBundle, ContractReport } from "./contract-schema.js";
import { VERSION } from "./types.js";

const addFormats = addFormatsImport.default ?? addFormatsImport;
const { bundle, fingerprint } = workerData as {
  bundle: ContractBundle;
  fingerprint: string;
};
function localSchema(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  for (const [key, item] of Object.entries(value)) {
    if (
      ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) &&
      (typeof item !== "string" || !item.startsWith("#"))
    )
      return false;
    if (["$async", "$data", "nullable", "discriminator"].includes(key))
      return false;
    if (
      [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "dependentSchemas",
      ].includes(key) &&
      item !== null &&
      typeof item === "object" &&
      !Object.values(item).every(localSchema)
    )
      return false;
    if (
      ["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) &&
      Array.isArray(item) &&
      !item.every(localSchema)
    )
      return false;
    if (
      [
        "items",
        "additionalProperties",
        "unevaluatedProperties",
        "unevaluatedItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
      ].includes(key) &&
      !localSchema(item)
    )
      return false;
  }
  return true;
}
const contracts: ContractReport["contracts"] = bundle.contracts.map(
  (contract) => {
    const incomplete = {
      id: contract.id,
      outcome: "incomplete" as const,
      reason:
        "Contract lacks complete samples or a supported strict JSON Schema 2020-12 definition.",
      samples: [],
    };
    if (
      !contract.complete ||
      !contract.samples.length ||
      typeof contract.schema.type !== "string" ||
      !localSchema(contract.schema)
    )
      return incomplete;
    try {
      const ajv = new Ajv2020({
        strict: true,
        strictRequired: true,
        allErrors: false,
        ownProperties: true,
        logger: false,
        coerceTypes: false,
        useDefaults: false,
        removeAdditional: false,
        loopRequired: 32,
        loopEnum: 32,
      });
      addFormats(ajv);
      const validate = ajv.compile(contract.schema);
      const samples = contract.samples.map((sample) => ({
        name: sample.name,
        accepted: validate(sample.payload) === true,
        errors: (validate.errors ?? []).slice(0, 20).map((error) => ({
          keyword: error.keyword,
          instancePath: error.instancePath,
          schemaPath: error.schemaPath,
        })),
      }));
      const outcome = samples.some((sample) => !sample.accepted)
        ? "failed"
        : "passed";
      return {
        id: contract.id,
        outcome,
        reason:
          outcome === "passed"
            ? "Captured producer samples satisfy the consumer schema."
            : "A captured producer sample violates the consumer schema.",
        samples,
      };
    } catch {
      return incomplete;
    }
  },
);
const counts = {
  contracts: contracts.length,
  passed: contracts.filter((contract) => contract.outcome === "passed").length,
  failed: contracts.filter((contract) => contract.outcome === "failed").length,
  unverified: contracts.filter((contract) => contract.outcome === "incomplete")
    .length,
  samples: contracts.reduce(
    (sum, contract) => sum + contract.samples.length,
    0,
  ),
  accepted: contracts.reduce(
    (sum, contract) =>
      sum + contract.samples.filter((sample) => sample.accepted).length,
    0,
  ),
  rejected: contracts.reduce(
    (sum, contract) =>
      sum + contract.samples.filter((sample) => !sample.accepted).length,
    0,
  ),
};
parentPort?.postMessage({
  schemaVersion: 1,
  engineVersion: VERSION,
  provenance: "imported-contract-samples",
  outcome: counts.failed
    ? "failed"
    : counts.unverified
      ? "incomplete"
      : "passed",
  reason:
    "Consumer schemas were checked against supplied producer samples; this does not prove live integration, source freshness or general schema compatibility.",
  artifactFingerprint: fingerprint,
  counts,
  contracts,
} satisfies ContractReport);
