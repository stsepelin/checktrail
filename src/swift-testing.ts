import path from "node:path";
import { z } from "zod";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { SwiftTestingDeclaration } from "./swift-ast.js";
import { swiftRequire, swiftSame } from "./swift-native.js";
import type { Finding, TestEvidence } from "./types.js";
const file = z.string().min(1).max(8192),
  text = z.string().max(65536),
  positive = z.number().int().positive().max(1000000),
  location = z.strictObject({
    _filePath: file,
    fileID: file,
    line: positive,
    column: positive,
  }),
  testCase = z.strictObject({ id: text, displayName: text }),
  declaration = z.strictObject({
    id: file,
    isParameterized: z.boolean(),
    kind: z.literal("function"),
    name: file,
    sourceLocation: location,
    _testCases: z.array(testCase).max(20000).optional(),
  }),
  event = z.strictObject({
    instant: z.strictObject({
      absolute: z.number().nonnegative(),
      since1970: z.number().nonnegative(),
    }),
    kind: z.enum([
      "runStarted",
      "runEnded",
      "testStarted",
      "testEnded",
      "testCaseStarted",
      "testCaseEnded",
      "testSkipped",
      "issueRecorded",
    ]),
    messages: z.array(z.strictObject({ symbol: file, text })).max(32),
    testID: file.optional(),
    _testCase: testCase.optional(),
    issue: z
      .strictObject({
        _severity: z.literal("error"),
        isKnown: z.literal(false),
        sourceLocation: location,
        _backtrace: z
          .array(z.strictObject({ address: z.number().int().nonnegative() }))
          .max(2048)
          .optional(),
      })
      .optional(),
  }),
  envelope = z.strictObject({
    kind: z.enum(["test", "event"]),
    payload: z.unknown(),
    version: z.literal(0),
  });
const time = z
    .string()
    .regex(/^[0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?$/)
    .refine((v) => Number.isFinite(Number(v))),
  counter = z
    .string()
    .regex(/^[0-9]+$/)
    .refine((v) => Number(v) <= 20000),
  xmlCase = z.strictObject({
    "@_classname": file,
    "@_name": file,
    "@_time": time.optional(),
    failure: z
      .array(z.strictObject({ "@_message": text }))
      .max(20000)
      .optional(),
    skipped: text.optional(),
  }),
  xmlSchema = z.strictObject({
    testsuites: z.strictObject({
      testsuite: z.strictObject({
        "@_name": z.literal("TestResults"),
        "@_errors": z.literal("0"),
        "@_tests": counter,
        "@_failures": counter,
        "@_skipped": counter,
        "@_time": time,
        testcase: z.array(xmlCase).min(1).max(20000),
      }),
    }),
  });
/** Decode XML character references once, preserving escaped reference-looking text. */
export function swiftXmlText(value: string) {
  const references: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  swiftRequire(
    !/&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9A-Fa-f]+);)/.test(value),
    "Swift XML reference is invalid",
  );
  return value.replace(/&([^;]+);/g, (_, reference: string) => {
    if (Object.hasOwn(references, reference)) return references[reference]!;
    const number = reference.startsWith("#x")
      ? Number.parseInt(reference.slice(2), 16)
      : Number(reference.slice(1));
    swiftRequire(
      [9, 10, 13].includes(number) ||
        (number >= 32 && number <= 0xd7ff) ||
        (number >= 0xe000 && number <= 0xfffd) ||
        (number >= 0x10000 && number <= 0x10ffff),
      "Swift XML character is invalid",
    );
    return String.fromCodePoint(number);
  });
}
export function swiftTestingEvidence(
  project: string,
  workspace: string,
  declarations: SwiftTestingDeclaration[],
  listed: string[],
  stream: string,
  xml: string,
  exitCode: number,
) {
  swiftRequire(
    Buffer.byteLength(stream) <= 4 * 1024 * 1024 &&
      Buffer.byteLength(xml) <= 4 * 1024 * 1024 &&
      stream.endsWith("\n") &&
      !/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) &&
      XMLValidator.validate(xml) === true,
    "Swift Testing artifacts incomplete",
  );
  type State = {
    native: z.infer<typeof declaration>;
    bound: SwiftTestingDeclaration;
    cases: z.infer<typeof testCase>[];
    started: boolean;
    ended: boolean;
    skipped: boolean;
    activeCases: Set<string>;
    endedCases: Set<string>;
    issues: Map<string, string[]>;
    messages: string[];
  };
  const states = new Map<string, State>(),
    findings: Finding[] = [];
  let running = false,
    complete = false,
    issues = 0,
    skipped = 0;
  const lines = stream.trimEnd().split("\n");
  swiftRequire(lines.length <= 100000, "Swift Testing event bound");
  for (const line of lines) {
    const row = envelope.parse(JSON.parse(line));
    if (row.kind === "test") {
      swiftRequire(!running && !complete, "Swift Testing late declaration");
      const native = declaration.parse(row.payload),
        loc = native.sourceLocation,
        bound = declarations.find(
          (d) => d.file === loc._filePath && d.name === native.name,
        );
      swiftRequire(
        bound &&
          loc.line === bound.line &&
          loc.column === bound.column &&
          loc.fileID === bound.module + "/" + path.basename(bound.file) &&
          native.id ===
            bound.module +
              "." +
              bound.name +
              "/" +
              path.basename(bound.file) +
              ":" +
              bound.line +
              ":" +
              bound.column &&
          !states.has(native.id),
        "Swift Testing compiler/runtime source differs",
      );
      swiftRequire(
        native.isParameterized
          ? !!native._testCases?.length
          : native._testCases === undefined,
        "Swift Testing parameter scope empty or ambiguous",
      );
      const cases = native._testCases ?? [
        { id: native.id, displayName: native.name },
      ];
      swiftRequire(
        new Set(cases.map((c) => c.id)).size === cases.length,
        "Swift Testing case identities duplicated",
      );
      states.set(native.id, {
        native,
        bound: bound!,
        cases,
        started: false,
        ended: false,
        skipped: false,
        activeCases: new Set(),
        endedCases: new Set(),
        issues: new Map(),
        messages: [],
      });
      continue;
    }
    const native = event.parse(row.payload);
    if (native.kind === "runStarted") {
      swiftRequire(
        !running &&
          !complete &&
          !native.testID &&
          !native._testCase &&
          !native.issue &&
          swiftSame(
            [...states.values()].map(
              (s) => s.bound.module + "." + s.bound.name,
            ),
            listed,
          ) &&
          swiftSame(
            [...states.values()].map((s) => s.native.id),
            declarations.map(
              (d) =>
                d.module +
                "." +
                d.name +
                "/" +
                path.basename(d.file) +
                ":" +
                d.line +
                ":" +
                d.column,
            ),
          ) &&
          native.messages.some(
            (m) =>
              m.text === "Testing Library Version: 6.2.3 (48a471ab313e858)",
          ) &&
          native.messages.some(
            (m) => m.text === "Target Platform: aarch64-unknown-linux-gnu",
          ),
        "Swift Testing run/discovery identity differs",
      );
      running = true;
      continue;
    }
    swiftRequire(running && !complete, "Swift Testing event outside run");
    if (native.kind === "runEnded") {
      swiftRequire(
        !native.testID &&
          !native.issue &&
          !native._testCase &&
          [...states.values()].every((s) => s.skipped || s.ended) &&
          native.messages.length === 1,
        "Swift Testing run ended without callbacks",
      );
      const summary =
        /^Test run with ([0-9]+) tests? in 0 suites (passed|failed) after [0-9.]+ seconds(?: with ([0-9]+) issues?)?\.$/.exec(
          native.messages[0]!.text,
        );
      swiftRequire(
        summary &&
          Number(summary[1]) === states.size &&
          Number(summary[3] ?? 0) === issues &&
          (summary[2] === "failed") === issues > 0 &&
          native.messages[0]!.symbol === (issues ? "fail" : "pass"),
        "Swift Testing native run summary differs",
      );
      complete = true;
      continue;
    }
    const state = states.get(native.testID ?? "");
    swiftRequire(
      state && !state.ended && !state.skipped,
      "Swift Testing callback identity differs",
    );
    const s = state!;
    if (native.kind === "testSkipped") {
      swiftRequire(
        !s.started &&
          !native.issue &&
          !native._testCase &&
          native.messages.length === 1 &&
          native.messages[0]!.symbol === "skip",
        "Swift Testing skip lifecycle differs",
      );
      s.skipped = true;
      skipped++;
      continue;
    }
    if (native.kind === "testStarted") {
      swiftRequire(
        !s.started && !native.issue && !native._testCase,
        "Swift Testing callback repeated",
      );
      s.started = true;
      if (!s.native.isParameterized) s.activeCases.add(s.cases[0]!.id);
      continue;
    }
    swiftRequire(s.started, "Swift Testing callback not started");
    if (native.kind === "testEnded") {
      if (!s.native.isParameterized) {
        s.activeCases.delete(s.cases[0]!.id);
        s.endedCases.add(s.cases[0]!.id);
      }
      swiftRequire(
        !native.issue &&
          !native._testCase &&
          !s.activeCases.size &&
          swiftSame(
            [...s.endedCases],
            s.cases.map((c) => c.id),
          ) &&
          native.messages.length === 1 &&
          native.messages[0]!.symbol === (s.messages.length ? "fail" : "pass"),
        "Swift Testing callback terminal differs",
      );
      s.ended = true;
      continue;
    }
    const selected = s.native.isParameterized ? native._testCase : s.cases[0];
    swiftRequire(
      selected &&
        s.cases.some((c) => JSON.stringify(c) === JSON.stringify(selected)),
      "Swift Testing case scope differs",
    );
    const id = selected!.id;
    if (native.kind === "testCaseStarted") {
      swiftRequire(
        s.native.isParameterized &&
          !native.issue &&
          !s.activeCases.has(id) &&
          !s.endedCases.has(id),
        "Swift Testing case start differs",
      );
      s.activeCases.add(id);
      continue;
    }
    swiftRequire(s.activeCases.has(id), "Swift Testing case not active");
    if (native.kind === "testCaseEnded") {
      swiftRequire(
        s.native.isParameterized && !native.issue && !native.messages.length,
        "Swift Testing case terminal differs",
      );
      s.activeCases.delete(id);
      s.endedCases.add(id);
      continue;
    }
    swiftRequire(
      native.kind === "issueRecorded" &&
        native.issue &&
        (native.messages.length === 1 ||
          (native.messages.length === 2 &&
            native.messages[1]!.symbol === "difference" &&
            native.messages[0]!.text.startsWith("Expectation failed:"))) &&
        native.messages[0]!.symbol === "fail",
      "Swift Testing issue shape differs",
    );
    const loc = native.issue!.sourceLocation;
    swiftRequire(
      loc._filePath === s.bound.file &&
        loc.fileID === s.native.sourceLocation.fileID &&
        loc.line >= s.bound.line &&
        loc.line <= s.bound.endLine,
      "Swift Testing issue outside bound callback",
    );
    const message = native.messages[0]!.text,
      previous = s.issues.get(id) ?? [];
    previous.push(message);
    s.issues.set(id, previous);
    s.messages.push(message);
    issues++;
    findings.push({
      ruleId: "swift.test",
      level: "error",
      message,
      file: path.posix.join(
        project,
        path.relative(workspace, loc._filePath).split(path.sep).join("/"),
      ),
      line: loc.line,
    });
  }
  // Non-parameterized methods have one native case, without separate case events.
  // Their completion is reconciled when the testEnded event arrives.
  swiftRequire(
    complete && exitCode === (issues ? 1 : 0),
    "Swift Testing process/run status differs",
  );
  const parsed = xmlSchema.parse(
    new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      ignoreDeclaration: true,
      processEntities: false,
      trimValues: true,
      isArray: (name) => ["testcase", "failure"].includes(name),
    }).parse(xml),
  ).testsuites.testsuite;
  swiftRequire(
    Number(parsed["@_tests"]) ===
      [...states.values()].filter((s) => s.started).length &&
      Number(parsed["@_failures"]) === issues &&
      Number(parsed["@_skipped"]) === skipped &&
      swiftSame(
        parsed.testcase.map((c) => c["@_classname"] + "." + c["@_name"]),
        [...states.values()].map((s) => s.bound.module + "." + s.native.name),
      ),
    "Swift Testing XML method/issue counters differ",
  );
  for (const row of parsed.testcase) {
    const s = [...states.values()].find(
      (s) =>
        s.bound.module + "." + s.native.name ===
        row["@_classname"] + "." + row["@_name"],
    )!;
    swiftRequire(
      (row.skipped !== undefined) === s.skipped &&
        JSON.stringify(
          (row.failure?.map((f) => swiftXmlText(f["@_message"])) ?? []).sort(),
        ) === JSON.stringify(s.messages.map((m) => m + " (error)").sort()),
      "Swift Testing XML outcomes differ",
    );
  }
  const tests: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
  for (const state of states.values())
    for (const c of state.cases) {
      tests.total++;
      if (state.skipped) tests.skipped++;
      else if (state.issues.has(c.id)) tests.failed++;
      else tests.passed++;
    }
  swiftRequire(tests.total > 0, "Swift Testing has no executed cases");
  return { tests, findings };
}
