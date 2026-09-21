import { XMLParser, XMLValidator } from "fast-xml-parser";
import { VERSION } from "./types.js";
import type { TestEvidence } from "./types.js";

export interface JUnitCase {
  name: string;
  file?: string;
  status: "passed" | "failed" | "skipped";
  assertions?: number;
}

export interface JUnitImport {
  schemaVersion: 1;
  engineVersion: string;
  format: "junit";
  provenance: "imported-report";
  outcome: "passed" | "failed" | "incomplete";
  reason: string;
  tests?: TestEvidence;
  cases?: JUnitCase[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected XML element");
  return value as Record<string, unknown>;
}
const array = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
function count(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Invalid JUnit counter");
  return Number(value);
}

export function importJUnit(xml: string): JUnitImport {
  const base: JUnitImport = {
    schemaVersion: 1,
    engineVersion: VERSION,
    format: "junit",
    provenance: "imported-report",
    outcome: "incomplete",
    reason:
      "JUnit evidence is malformed, inconsistent, empty, or entirely skipped; an import does not establish execution freshness.",
  };
  if (
    Buffer.byteLength(xml) > 8 * 1024 * 1024 ||
    /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)
  )
    return base;
  try {
    if (XMLValidator.validate(xml) !== true) return base;
    const parser = new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      ignoreDeclaration: true,
      processEntities: true,
      htmlEntities: false,
    });
    const root = object(parser.parse(xml));
    if (
      Object.keys(root).length !== 1 ||
      !("testsuite" in root || "testsuites" in root)
    )
      return base;
    const cases: JUnitCase[] = [];
    const identities = new Set<string>();
    type Counts = {
      total: number;
      failures: number;
      errors: number;
      skipped: number;
    };
    const walk = (
      value: unknown,
      depth: number,
      trail: string[],
      wrapper = false,
    ): Counts => {
      if (depth > 32) throw new Error("JUnit nesting limit");
      const suite = object(value);
      if (wrapper && suite.testcase !== undefined)
        throw new Error("Test case outside suite");
      if (
        Object.keys(suite).some(
          (key) =>
            !key.startsWith("@_") &&
            ![
              "testsuite",
              "testcase",
              "properties",
              "system-out",
              "system-err",
            ].includes(key),
        )
      )
        throw new Error("Unknown JUnit suite element");
      const names = [
        ...trail,
        typeof suite["@_name"] === "string" ? suite["@_name"] : "",
      ];
      const counts: Counts = { total: 0, failures: 0, errors: 0, skipped: 0 };
      for (const value of array(suite.testcase)) {
        if (cases.length >= 100_000) throw new Error("JUnit case limit");
        const entry = object(value);
        if (
          Object.keys(entry).some(
            (key) =>
              !key.startsWith("@_") &&
              ![
                "failure",
                "error",
                "skipped",
                "properties",
                "system-out",
                "system-err",
              ].includes(key),
          )
        )
          throw new Error("Unknown JUnit case element");
        if (typeof entry["@_name"] !== "string" || !entry["@_name"].length)
          throw new Error("Missing test name");
        const identity = JSON.stringify([
          names,
          entry["@_file"],
          entry["@_classname"],
          entry["@_class"],
          entry["@_name"],
        ]);
        if (identities.has(identity)) throw new Error("Duplicate JUnit case");
        identities.add(identity);
        const failures = array(entry.failure).length;
        const errors = array(entry.error).length;
        const skipped = array(entry.skipped).length;
        if (failures + errors + skipped > 1)
          throw new Error("Contradictory JUnit case states");
        const item: JUnitCase = {
          name: entry["@_name"],
          status:
            failures || errors ? "failed" : skipped ? "skipped" : "passed",
        };
        if (entry["@_file"] !== undefined) {
          if (typeof entry["@_file"] !== "string" || !entry["@_file"].length)
            throw new Error("Invalid JUnit file");
          item.file = entry["@_file"];
        }
        if (entry["@_assertions"] !== undefined)
          item.assertions = count(entry["@_assertions"]);
        cases.push(item);
        counts.total++;
        counts.failures += failures;
        counts.errors += errors;
        counts.skipped += skipped;
      }
      for (const child of array(suite.testsuite)) {
        const nested = walk(child, depth + 1, names);
        for (const key of ["total", "failures", "errors", "skipped"] as const)
          counts[key] += nested[key];
      }
      for (const [attribute, key] of [
        ["tests", "total"],
        ["failures", "failures"],
        ["errors", "errors"],
        ["skipped", "skipped"],
      ] as const) {
        const declared = suite[`@_${attribute}`];
        if (declared !== undefined && count(declared) !== counts[key])
          throw new Error("JUnit counts disagree");
        if (!wrapper && attribute === "tests" && declared === undefined)
          throw new Error("Missing suite count");
      }
      return counts;
    };
    const value =
      "testsuites" in root
        ? walk(root.testsuites, 0, [], true)
        : walk(root.testsuite, 0, []);
    const tests: TestEvidence = {
      total: value.total,
      passed: value.total - value.failures - value.errors - value.skipped,
      failed: value.failures + value.errors,
      skipped: value.skipped,
    };
    const outcome = tests.failed
      ? "failed"
      : tests.passed
        ? "passed"
        : "incomplete";
    return {
      ...base,
      outcome,
      tests,
      cases,
      reason:
        "Imported JUnit counts describe this report only; source identity, scope and execution freshness are not established.",
    };
  } catch {
    return base;
  }
}
