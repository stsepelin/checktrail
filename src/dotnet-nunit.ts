import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import path from "node:path";
import { mavenHash } from "./maven.js";
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function dotnetNunitSettings(directory: string) {
  return `<RunSettings><RunConfiguration><MaxCpuCount>1</MaxCpuCount></RunConfiguration><NUnit><DumpXmlTestDiscovery>true</DumpXmlTestDiscovery><DumpXmlTestResults>false</DumpXmlTestResults><NumberOfTestWorkers>0</NumberOfTestWorkers><SkipNonTestAssemblies>false</SkipNonTestAssemblies><TestOutputXml>${escape(directory)}</TestOutputXml></NUnit></RunSettings>`;
}
const artifact = z.strictObject({
  file: z.string().min(1).max(8192),
  text: z.string().max(1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const dotnetNunitSchema = z.strictObject({
  settingsFile: z.string().min(1).max(8192),
  settingsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  discovery: artifact.nullable(),
  execution: artifact.nullable(),
});
const requireValue = (value: unknown, reason: string) => {
  if (!value) throw Error(reason);
};
const object = (value: unknown) =>
  z.record(z.string(), z.unknown()).parse(value);
const array = (value: unknown) =>
  value === undefined
    ? []
    : (Array.isArray(value) ? value : [value]).map(object);
const count = (value: unknown) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(20000))
    .parse(value);
export interface DotnetNunitCase {
  id: string;
  name: string;
  fullname: string;
  className: string;
  methodName: string;
  runstate: string;
  result: string | null;
  site: string | null;
  label: string | null;
}
export interface DotnetNunitSuite {
  id: string;
  type: string;
  fullname: string;
  className: string | null;
  caseFullNames: string[];
  parentId: string | null;
}
export function dotnetNunitCases(
  raw: z.infer<typeof artifact>,
  assembly: string,
  phase: "discovery" | "execution",
  discovery?: { suites: DotnetNunitSuite[]; rows: DotnetNunitCase[] },
) {
  requireValue(
    raw.text.length > 0 &&
      Buffer.byteLength(raw.text) <= 1024 * 1024 &&
      mavenHash(raw.text) === raw.sha256,
    "Exact bounded native NUnit artifact bytes",
  );
  requireValue(
    !/<!DOCTYPE|<!ENTITY/.test(raw.text) &&
      XMLValidator.validate(raw.text) === true,
    "Native NUnit XML must be complete without DTD/entity declarations",
  );
  const parsed = object(
    new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
    }).parse(raw.text),
  );
  requireValue(
    Object.keys(parsed).every(
      (k) =>
        k === "?xml" || k === (phase === "discovery" ? "NUnitXml" : "test-run"),
    ),
    "One native NUnit document root",
  );
  const wrapper = phase === "discovery" ? object(parsed.NUnitXml) : parsed;
  if (phase === "discovery")
    requireValue(
      Object.keys(wrapper).length === 1 && "test-run" in wrapper,
      "One native NUnit discovery tree",
    );
  const root = object(wrapper["test-run"]),
    assemblies = array(root["test-suite"]);
  requireValue(
    root["@_fullname"] === assembly &&
      root["@_name"] === path.basename(assembly) &&
      assemblies.length === 1,
    "Native NUnit selected assembly root",
  );
  const suite = assemblies[0]!;
  requireValue(
    suite["@_type"] === "Assembly" &&
      suite["@_fullname"] === assembly &&
      suite["@_name"] === path.basename(assembly),
    "Native NUnit assembly suite",
  );
  const environment = object(suite.environment),
    settings = array(object(suite.settings).setting);
  requireValue(
    environment["@_framework-version"] === "4.6.0.0" &&
      environment["@_clr-version"] === "10.0.12" &&
      environment["@_cwd"] === path.dirname(assembly),
    "Selected NUnit framework runtime and native working directory",
  );
  for (const [name, value] of [
    ["NumberOfTestWorkers", "0"],
    ["ProcessModel", "InProcess"],
    ["WorkDirectory", path.dirname(assembly)],
  ])
    requireValue(
      settings.filter((s) => s["@_name"] === name).length === 1 &&
        settings.find((s) => s["@_name"] === name)!["@_value"] === value,
      "Native NUnit effective setting: " + name,
    );
  const properties = array(object(suite.properties).property),
    pid = properties.filter((p) => p["@_name"] === "_PID");
  requireValue(
    pid.length === 1 &&
      /^\d+$/.test(String(pid[0]!["@_value"])) &&
      Number(pid[0]!["@_value"]) > 1,
    "Actual native NUnit host identity",
  );
  const rows: DotnetNunitCase[] = [],
    suites: DotnetNunitSuite[] = [],
    ids = new Set<string>();
  let nodes = 0;
  const opaque = (value: unknown, depth: number) => {
    if (typeof value !== "object" || value === null) return;
    requireValue(
      ++nodes <= 24000 && depth <= 32,
      "Bounded native NUnit auxiliary tree",
    );
    if (Array.isArray(value)) {
      for (const item of value) opaque(item, depth + 1);
      return;
    }
    const node = object(value);
    requireValue(
      !("test-case" in node) && !("test-suite" in node),
      "No native NUnit structural nodes hidden in auxiliary elements",
    );
    for (const item of Object.values(node)) opaque(item, depth + 1);
  };
  const visit = (
    node: Record<string, unknown>,
    depth: number,
    parentCases: DotnetNunitCase[] = [],
    parentId: string | null = null,
  ) => {
    for (const [key, value] of Object.entries(node))
      if (key !== "test-case" && key !== "test-suite") opaque(value, 0);
    requireValue(
      ++nodes <= 24000 && depth <= 32,
      "Bounded complete native NUnit tree",
    );
    const id = z.string().min(1).max(256).parse(node["@_id"]);
    requireValue(!ids.has(id), "Unique native NUnit node identity");
    ids.add(id);
    const cases = array(node["test-case"]),
      children = array(node["test-suite"]),
      before = rows.length;
    for (const leaf of cases) {
      for (const value of Object.values(leaf)) opaque(value, 0);
      requireValue(
        ++nodes <= 24000 && !leaf["test-case"] && !leaf["test-suite"],
        "Native NUnit case is a leaf",
      );
      const id = z.string().min(1).max(256).parse(leaf["@_id"]);
      requireValue(!ids.has(id), "Unique native NUnit case identity");
      ids.add(id);
      rows.push({
        id,
        name: z.string().min(1).max(65536).parse(leaf["@_name"]),
        fullname: z.string().min(1).max(65536).parse(leaf["@_fullname"]),
        className: z.string().min(1).max(8192).parse(leaf["@_classname"]),
        methodName: z.string().min(1).max(8192).parse(leaf["@_methodname"]),
        runstate: z.string().min(1).max(256).parse(leaf["@_runstate"]),
        site: typeof leaf["@_site"] === "string" ? leaf["@_site"] : null,
        label: typeof leaf["@_label"] === "string" ? leaf["@_label"] : null,
        result:
          phase === "execution"
            ? z.string().min(1).max(256).parse(leaf["@_result"])
            : null,
      });
    }
    const directCases = rows.slice(before);
    for (const child of children) visit(child, depth + 1, directCases, id);
    const expected = discovery?.suites.find((s) => s.id === id),
      type = typeof node["@_type"] === "string" ? node["@_type"] : "Root",
      fullname = z.string().min(1).max(8192).parse(node["@_fullname"]),
      className =
        typeof node["@_classname"] === "string" ? node["@_classname"] : null,
      descendantCases = rows.slice(before).map((r) => r.fullname),
      declaredCount = count(node["@_testcasecount"]);
    if (phase === "execution")
      requireValue(
        expected &&
          expected.type === type &&
          expected.parentId === parentId &&
          expected.fullname === fullname &&
          expected.className === className &&
          expected.caseFullNames.length === declaredCount,
        "Every native NUnit result suite matches complete discovery",
      );
    const promoted =
      phase === "execution" &&
      type === "ParameterizedMethod" &&
      node["@_site"] === "Parent" &&
      descendantCases.length === 0 &&
      declaredCount > 0;
    if (promoted) {
      requireValue(
        expected &&
          ((node["@_result"] === "Failed" && node["@_label"] === "Error") ||
            (node["@_result"] === "Skipped" &&
              node["@_label"] === "Ignored")) &&
          [
            "total",
            "initiated",
            "passed",
            "failed",
            "warnings",
            "completed",
            "skipped",
            "inconclusive",
            "asserts",
          ].every((key) => count(node["@_" + key]) === 0),
        "Native NUnit parent failure leaves only an empty parameterized-method placeholder",
      );
      const promotedCases = parentCases.filter((r) =>
        expected!.caseFullNames.includes(r.fullname),
      );
      requireValue(
        promotedCases.length === declaredCount &&
          promotedCases.every((r) => {
            const original = discovery!.rows.find(
              (d) => d.fullname === r.fullname,
            );
            return (
              original &&
              original.className === r.className &&
              original.methodName === r.methodName &&
              r.result === node["@_result"] &&
              r.site === "Parent" &&
              r.label === node["@_label"]
            );
          }),
        "Every native NUnit placeholder case is promoted to its direct parent with discovery identity and outcome",
      );
    } else {
      requireValue(
        count(node["@_testcasecount"]) === rows.length - before,
        "Every native NUnit suite accounts for its descendant cases",
      );
      if (expected)
        requireValue(
          JSON.stringify([...descendantCases].sort()) ===
            JSON.stringify([...expected.caseFullNames].sort()),
          "Every native NUnit result suite retains exactly its discovered cases",
        );
    }
    suites.push({
      id,
      type,
      fullname,
      className,
      parentId,
      caseFullNames: promoted ? [...expected!.caseFullNames] : descendantCases,
    });
  };
  visit(root, 0);
  requireValue(
    new Set(rows.map((r) => r.fullname)).size === rows.length,
    "Unambiguous native NUnit case full names",
  );
  if (phase === "execution") {
    requireValue(
      root["@_engine-version"] === "3.18.1.0" &&
        root["@_clr-version"] === "10.0.12",
      "Selected native NUnit result engine/runtime",
    );
    const counts = { Passed: 0, Failed: 0, Skipped: 0 };
    for (const row of rows) {
      requireValue(
        ["Passed", "Failed", "Skipped"].includes(row.result!),
        "Supported native NUnit case outcome",
      );
      counts[row.result as keyof typeof counts]++;
    }
    requireValue(
      count(root["@_total"]) === rows.length &&
        count(root["@_passed"]) === counts.Passed &&
        count(root["@_failed"]) === counts.Failed &&
        count(root["@_skipped"]) === counts.Skipped &&
        count(root["@_warnings"]) === 0 &&
        count(root["@_inconclusive"]) === 0,
      "Complete native NUnit result counts",
    );
  }
  return {
    rows,
    suites,
    hostPid: Number(pid[0]!["@_value"]),
    commandLine:
      typeof root["command-line"] === "string" ? root["command-line"] : null,
  };
}
