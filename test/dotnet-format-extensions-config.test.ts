import test from "node:test";
import assert from "node:assert/strict";
import {
  dotnetFormatExtensionsConfigSchema,
  validateDotnetFormattingRules,
} from "../src/dotnet-format-extensions.js";
const original = {
  schemaVersion: 1,
  profile: "sdk-code-style-and-analyzers-v1",
  styleDiagnostics: ["IDE0005", "IDE0007"],
  analyzerDiagnostics: ["CA1822"],
  severity: "info",
  includeGenerated: true,
} as const;
test("SDK formatting policy admits native rules for their actual language cohort and preserves adjacent valid choices", () => {
  const config = dotnetFormatExtensionsConfigSchema.parse(original);
  assert.doesNotThrow(() =>
    validateDotnetFormattingRules(config, ["csharp", "visual-basic"]),
  );
  assert.doesNotThrow(() =>
    validateDotnetFormattingRules(
      { ...config, styleDiagnostics: ["IDE0005"], severity: "warn" },
      ["visual-basic"],
    ),
  );
  assert.doesNotThrow(() =>
    validateDotnetFormattingRules(
      { ...config, styleDiagnostics: ["IDE0007"], severity: "error" },
      ["csharp"],
    ),
  );
  assert.throws(
    () =>
      validateDotnetFormattingRules(
        { ...config, styleDiagnostics: ["IDE0007"] },
        ["visual-basic"],
      ),
    /native SDK catalogue/,
  );
});
test("SDK formatting policy rejects guessed identifiers duplicates unsupported cohorts and disabled generated participation", () => {
  const config = dotnetFormatExtensionsConfigSchema.parse(original);
  for (const styleDiagnostics of [
    ["IDE00070"],
    ["IDE0007", "IDE0007"],
    ["CA1822"],
  ])
    assert.throws(() =>
      validateDotnetFormattingRules({ ...config, styleDiagnostics }, [
        "csharp",
      ]),
    );
  for (const analyzerDiagnostics of [
    ["CA18220"],
    ["CA1822", "CA1822"],
    ["IDE0005"],
  ])
    assert.throws(() =>
      validateDotnetFormattingRules({ ...config, analyzerDiagnostics }, [
        "csharp",
      ]),
    );
  for (const languages of [[], ["fsharp"], ["csharp", "fsharp"]])
    assert.throws(
      () => validateDotnetFormattingRules(config, languages),
      /project languages/,
    );
  for (const invalid of [
    { ...original, styleDiagnostics: [] },
    { ...original, analyzerDiagnostics: [] },
    { ...original, styleDiagnostics: ["IDE0007suffix"] },
    { ...original, severity: "hidden" },
    { ...original, includeGenerated: false },
    { ...original, trusted: true },
    { ...original, profile: "arbitrary-fixes" },
  ])
    assert.equal(
      dotnetFormatExtensionsConfigSchema.safeParse(invalid).success,
      false,
    );
});
