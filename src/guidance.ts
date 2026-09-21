import { createHash } from "node:crypto";
import { z } from "zod";
import { VERSION } from "./types.js";

export const guidanceTopicSchema = z.enum([
  "test-lifecycle",
  "analysis-scope",
  "package-consumers",
  "python-imports",
  "framework-assembly",
  "execution-depth",
]);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9.-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const guidanceContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checks: z.array(identifier).max(100),
  topics: z.array(guidanceTopicSchema).max(16),
});
const referenceSchema = z.strictObject({
  title: z.string().min(1).max(160),
  url: z
    .url()
    .regex(/^https:\/\//)
    .max(512)
    .meta({ format: "uri" }),
});
const itemSchema = z.strictObject({
  id: identifier,
  version: z.literal("1.0.0"),
  title: z.string().min(1).max(160),
  triggers: z.strictObject({
    checks: z.array(identifier).max(32),
    topics: z.array(guidanceTopicSchema).min(1).max(16),
  }),
  questions: z.array(z.string().min(1).max(600)).min(1).max(8),
  references: z.array(referenceSchema).min(1).max(8),
});

const catalogue = z
  .array(itemSchema)
  .max(64)
  .parse([
    {
      id: "review.test-lifecycle",
      version: "1.0.0",
      title: "Await asynchronous work and release test resources",
      triggers: {
        checks: ["javascript.node-test"],
        topics: ["test-lifecycle"],
      },
      questions: [
        "Does each asynchronous assertion finish before its test completes, including assertions inside subtests and callbacks?",
        "Are timers, mocks and open handles released when an assertion throws, and does running the test alongside its siblings preserve the result?",
      ],
      references: [
        {
          title: "Node.js test runner",
          url: "https://nodejs.org/api/test.html",
        },
      ],
    },
    {
      id: "review.analysis-scope",
      version: "1.0.0",
      title: "Check the files selected by analysis configuration",
      triggers: {
        checks: ["javascript.eslint"],
        topics: ["analysis-scope"],
      },
      questions: [
        "Which source files does the resolved lint configuration select, and which files does it intentionally ignore?",
        "Do changed file extensions and nested packages appear in the tool's observed scope, with any exclusions reviewed explicitly?",
      ],
      references: [
        {
          title: "ESLint ignore configuration",
          url: "https://eslint.org/docs/latest/use/configure/ignore",
        },
      ],
    },
    {
      id: "review.package-consumers",
      version: "1.0.0",
      title: "Exercise the package consumed after a build",
      triggers: {
        checks: ["javascript.typescript-build"],
        topics: ["package-consumers"],
      },
      questions: [
        "Does a consumer resolve the freshly built declarations and runtime entry points that will actually be distributed?",
        "Would both the consumer type check and its runtime test detect a producer interface change, including a declaration that disagrees with emitted JavaScript?",
      ],
      references: [
        {
          title: "TypeScript project references",
          url: "https://www.typescriptlang.org/docs/handbook/project-references.html",
        },
      ],
    },
    {
      id: "review.python-imports",
      version: "1.0.0",
      title: "Establish which Python package tests import",
      triggers: {
        checks: ["python.pytest"],
        topics: ["python-imports"],
      },
      questions: [
        "Does the import mode exercise the intended installed package or source checkout, and is that choice recorded?",
        "Can the distribution's public imports be exercised in a clean environment without relying on the working directory being on the import path?",
      ],
      references: [
        {
          title: "pytest integration practices",
          url: "https://docs.pytest.org/en/stable/explanation/goodpractices.html",
        },
      ],
    },
    {
      id: "review.framework-assembly",
      version: "1.0.0",
      title: "Compare the supported runtime assembly projection",
      triggers: {
        checks: [
          "php.laravel-runtime",
          "javascript.vue-router",
          "javascript.nuxt-runtime",
          "python.fastapi-routes",
          "python.django-routes",
        ],
        topics: ["framework-assembly"],
      },
      questions: [
        "Were both inventories captured after the required startup phase, using compatible collectors and the intended test environment?",
        "Which registration, multiplicity or ordering changes are expected, and which application decisions need separate request-level tests beyond this collector's projection?",
      ],
      references: [
        {
          title: "Laravel routing",
          url: "https://laravel.com/docs/13.x/routing",
        },
      ],
    },
    {
      id: "review.execution-depth",
      version: "1.0.0",
      title: "Distinguish parsing and compilation from executed behavior",
      triggers: {
        checks: [
          "php.syntax",
          "ruby.syntax",
          "swift.syntax",
          "rust.cargo-check",
        ],
        topics: ["execution-depth"],
      },
      questions: [
        "What does the selected native command establish: grammar, types, linking or executed tests?",
        "Which behavioral assertions still need to run after parsing or compilation succeeds, and is unavailable test execution visible in the review?",
      ],
      references: [
        {
          title: "Cargo check command",
          url: "https://doc.rust-lang.org/cargo/commands/cargo-check.html",
        },
      ],
    },
  ]);
const catalogueDigest = createHash("sha256")
  .update(JSON.stringify(catalogue))
  .digest("hex");
const metadata = {
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  channel: z.literal("advisory"),
  provenance: z.literal("builtin-guidance-selection"),
  catalogueDigest: digest,
  automatedCoverage: z.literal(false),
  selectionBasis: z.literal("exact-check-or-topic"),
};
export const guidanceReportSchema = z.strictObject({
  ...metadata,
  context: guidanceContextSchema,
  items: z.array(itemSchema.extend({ matched: guidanceContextSchema })).max(64),
});
export const guidanceSummarySchema = z.strictObject({
  ...metadata,
  items: z.array(itemSchema.omit({ triggers: true })).max(64),
});
export type GuidanceContext = z.infer<typeof guidanceContextSchema>;
export type GuidanceReport = z.infer<typeof guidanceReportSchema>;

export function retrieveGuidance(input: unknown): GuidanceReport {
  const serialized = JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized) > 16_384)
    throw new Error("Guidance context exceeds input limits");
  const context = guidanceContextSchema.parse(input);
  for (const values of [context.checks, context.topics])
    if (new Set(values).size !== values.length)
      throw new Error("Guidance context identifiers must be unique");
  context.checks.sort();
  context.topics.sort();
  const checks = new Set(context.checks);
  const topics = new Set(context.topics);
  const items = catalogue.flatMap((item) => {
    const matched = {
      schemaVersion: 1 as const,
      checks: item.triggers.checks.filter((check) => checks.has(check)),
      topics: item.triggers.topics.filter((topic) => topics.has(topic)),
    };
    return matched.checks.length || matched.topics.length
      ? [{ ...item, matched }]
      : [];
  });
  return guidanceReportSchema.parse({
    schemaVersion: 1,
    engineVersion: VERSION,
    channel: "advisory",
    provenance: "builtin-guidance-selection",
    catalogueDigest,
    automatedCoverage: false,
    selectionBasis: "exact-check-or-topic",
    context,
    items,
  });
}

export function projectGuidance(
  report: GuidanceReport,
  detailed: boolean,
): Record<string, unknown> {
  const parsed = guidanceReportSchema.parse(report);
  if (detailed) return parsed;
  return guidanceSummarySchema.parse({
    schemaVersion: parsed.schemaVersion,
    engineVersion: parsed.engineVersion,
    channel: parsed.channel,
    provenance: parsed.provenance,
    catalogueDigest: parsed.catalogueDigest,
    automatedCoverage: parsed.automatedCoverage,
    selectionBasis: parsed.selectionBasis,
    items: parsed.items.map((item) => ({
      id: item.id,
      version: item.version,
      title: item.title,
      questions: item.questions,
      references: item.references,
    })),
  });
}
