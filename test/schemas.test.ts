import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import {
  vueRouterConfigSchema,
  nuxtConfigSchema,
  externalManifestSchema,
  externalReferenceSchema,
  externalRequestSchema,
  externalResultSchema,
  actionlintConfigSchema,
  goScopePolicySchema,
  goBuildPolicySchema,
  dotnetConfigSchema,
  javaConfigSchema,
  clangDatabaseSchema,
  mutationRecipeSchema,
  mutationReportSchema,
  mutationSummarySchema,
  reviewSelectionSchema,
  reviewContextSchema,
  reviewContextSummarySchema,
  reviewAssessmentSchema,
  reviewReceiptSchema,
  reviewReceiptSummarySchema,
  guidanceContextSchema,
  guidanceReportSchema,
  guidanceSummarySchema,
  dependencyGraphSchema,
  architecturePolicySchema,
  architectureReportSchema,
  architectureSummarySchema,
  runtimeInventorySchema,
  runtimeComparisonSchema,
  runtimeComparisonSummarySchema,
  findingBaselineSchema,
  findingComparisonSchema,
  findingComparisonSummarySchema,
  junitImportSchema,
  contractBundleSchema,
  contractReportSchema,
  contractSummarySchema,
  laravelConfigSchema,
  djangoConfigSchema,
  fastapiConfigSchema,
  configSchema,
  policyPackSchema,
  planSchema,
  planSummarySchema,
  reportSchema,
  reportSummarySchema,
} from "../src/schemas.js";
import { importJUnit } from "../src/junit.js";
import { createPlan, validate } from "../src/engine.js";
import { projectPlan, projectReport } from "../src/output.js";
import { VERSION } from "../src/types.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

test("published schemas match runtime definitions and compile in a strict standard validator", async () => {
  const ajv = new Ajv2020({ strict: true });
  (addFormatsImport.default ?? addFormatsImport)(ajv);
  for (const [name, schema] of Object.entries({
    "vue-router-config": vueRouterConfigSchema,
    "nuxt-config": nuxtConfigSchema,
    "external-manifest": externalManifestSchema,
    "external-reference": externalReferenceSchema,
    "external-request": externalRequestSchema,
    "external-result": externalResultSchema,
    "actionlint-config": actionlintConfigSchema,
    "go-scope-policy": goScopePolicySchema,
    "go-build-policy": goBuildPolicySchema,
    "dotnet-config": dotnetConfigSchema,
    "java-config": javaConfigSchema,
    "clang-database": clangDatabaseSchema,
    "mutation-recipe": mutationRecipeSchema,
    "mutation-report": mutationReportSchema,
    "mutation-summary": mutationSummarySchema,
    "review-selection": reviewSelectionSchema,
    "review-context": reviewContextSchema,
    "review-context-summary": reviewContextSummarySchema,
    "review-assessment": reviewAssessmentSchema,
    "review-receipt": reviewReceiptSchema,
    "review-receipt-summary": reviewReceiptSummarySchema,
    "guidance-context": guidanceContextSchema,
    "guidance-report": guidanceReportSchema,
    "guidance-summary": guidanceSummarySchema,
    "dependency-graph": dependencyGraphSchema,
    "architecture-policy": architecturePolicySchema,
    "architecture-report": architectureReportSchema,
    "architecture-summary": architectureSummarySchema,
    "runtime-inventory": runtimeInventorySchema,
    "runtime-comparison": runtimeComparisonSchema,
    "runtime-comparison-summary": runtimeComparisonSummarySchema,
    "finding-baseline": findingBaselineSchema,
    "finding-comparison": findingComparisonSchema,
    "finding-comparison-summary": findingComparisonSummarySchema,
    junit: junitImportSchema,
    "contract-bundle": contractBundleSchema,
    "contract-report": contractReportSchema,
    "contract-summary": contractSummarySchema,
    "laravel-config": laravelConfigSchema,
    "django-config": djangoConfigSchema,
    "fastapi-config": fastapiConfigSchema,
    config: configSchema,
    "policy-pack": policyPackSchema,
    plan: planSchema,
    "plan-summary": planSummarySchema,
    report: reportSchema,
    "report-summary": reportSummarySchema,
  })) {
    const disk = JSON.parse(
      await readFile(
        new URL(`../../schemas/${name}.schema.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(disk, z.toJSONSchema(schema));
    ajv.compile(disk);
  }
  const metadata = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(metadata.version, VERSION);
});

test("real plans and reports satisfy both detailed and summary schemas", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const { plan } = await createPlan(root);
  planSchema.parse(projectPlan(plan, true));
  planSummarySchema.parse(projectPlan(plan, false));
  const report = await validate(root, { trusted: true });
  reportSchema.parse(projectReport(report, true));
  reportSummarySchema.parse(projectReport(report, false));
});

test("JUnit import results satisfy the published schema for parsed and incomplete evidence", () => {
  junitImportSchema.parse(
    importJUnit('<testsuite tests="1"><testcase name="adds"/></testsuite>'),
  );
  junitImportSchema.parse(importJUnit("broken"));
});

test("Rust and Laravel plans conform to the public detailed schema before any project execution", async (t) => {
  const root = await fixture(t, {
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: "rust", checks: ["rust.cargo-check"] },
        { path: "php", checks: ["php.laravel-runtime"] },
      ],
    }),
    "rust/Cargo.toml": '[package]\nname="synthetic"\nversion="0.1.0"\n',
    "rust/Cargo.lock": "version = 4\n",
    "rust/src/lib.rs": "pub fn value() {}\n",
    "php/composer.json": "{}",
    "php/bootstrap/app.php":
      "<?php throw new RuntimeException('Planning must never load bootstrap');",
    "php/vendor/autoload.php":
      "<?php throw new RuntimeException('Planning must never load autoload');",
    "php/checktrail.laravel.json": JSON.stringify({
      schemaVersion: 1,
      assembly: "synthetic",
      environment: "testing",
    }),
  });
  const { plan } = await createPlan(root);
  assert.deepEqual(
    new Set(plan.checks.map((check) => check.parser)),
    new Set(["rust-json", "laravel-json"]),
  );
  planSchema.parse(plan);
});

test("route schema prefixes and request boundaries agree in runtime and standard validators", async () => {
  const { vueRouteIdentitySchema } = await import("../src/vue-router.js");
  const { vueRouteAttributesSchema } =
    await import("../src/vue-router-protocol.js");
  const profiles = [
    ["Vue identity", vueRouteIdentitySchema.shape.path, false, false],
    ["Vue attributes", vueRouteAttributesSchema.shape.path, false, false],
    [
      "Vue probe",
      vueRouterConfigSchema.shape.probes.element.shape.path,
      true,
      false,
    ],
    [
      "Nuxt probe",
      nuxtConfigSchema.shape.probes.element.shape.path,
      true,
      true,
    ],
  ] as const;
  for (const [
    name,
    schema,
    rejectAuthority,
    rejectRequestDelimiters,
  ] of profiles) {
    const validate = new Ajv2020({ strict: true }).compile(
      z.toJSONSchema(schema),
    );
    const cases: [string, boolean][] = [
      ["/", true],
      ["/items/7?view=full", true],
      ["/café", true],
      ["/" + "a".repeat(4095), true],
      ["/" + "a".repeat(4096), false],
      ["", false],
      ["items/7", false],
      ["x/items", false],
      ["https://example.test/items", false],
      ["//example.test/items", !rejectAuthority],
      ["/items#section", !rejectRequestDelimiters],
      ["/items\n", !rejectRequestDelimiters],
      ["/items\r", !rejectRequestDelimiters],
      ["/items\nnext", !rejectRequestDelimiters],
    ];
    for (const [value, accepted] of cases) {
      assert.equal(
        schema.safeParse(value).success,
        accepted,
        `${name} runtime: ${JSON.stringify(value)}`,
      );
      assert.equal(
        validate(value),
        accepted,
        `${name} JSON Schema: ${JSON.stringify(value)}`,
      );
    }
  }
});
