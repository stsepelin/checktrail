import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as espree from "espree";
import { z } from "zod";

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const languageSchema = z.strictObject({
  ecmaVersion: z
    .union([z.literal("latest"), z.number().int().min(3).max(2026)])
    .optional(),
  sourceType: z.enum(["script", "module", "commonjs"]).optional(),
  parserOptions: z
    .strictObject({
      ecmaFeatures: z
        .strictObject({
          jsx: z.boolean().optional(),
          globalReturn: z.boolean().optional(),
          impliedStrict: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
function properties(node) {
  if (node?.type !== "ObjectExpression") throw new Error("nonliteral-object");
  const result = new Map();
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.method ||
      property.shorthand ||
      property.kind !== "init"
    )
      throw new Error("nonliteral-property");
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.value;
    if (
      typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      result.has(key)
    )
      throw new Error("ambiguous-property");
    result.set(key, property.value);
  }
  return result;
}
function literal(node, depth = 0) {
  if (depth > 16) throw new Error("literal-depth");
  if (
    node?.type === "Literal" &&
    !node.regex &&
    ["string", "number", "boolean"].includes(typeof node.value)
  )
    return node.value;
  if (node?.type === "Literal" && node.value === null) return null;
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1 &&
    node.quasis[0].value.cooked !== null
  )
    return node.quasis[0].value.cooked;
  if (node?.type === "ArrayExpression")
    return node.elements.map((value) => literal(value, depth + 1));
  if (node?.type === "ObjectExpression")
    return Object.fromEntries(
      [...properties(node)].map(([key, value]) => [
        key,
        literal(value, depth + 1),
      ]),
    );
  throw new Error("nonliteral-value");
}
function mergeLanguage(base, extra) {
  const result = { ...base, ...extra };
  if (base.parserOptions || extra.parserOptions)
    result.parserOptions = {
      ...base.parserOptions,
      ...extra.parserOptions,
      ecmaFeatures: {
        ...base.parserOptions?.ecmaFeatures,
        ...extra.parserOptions?.ecmaFeatures,
      },
    };
  return languageSchema.parse(result);
}
function expectations(node) {
  if (node?.type !== "ArrayExpression" || !node.elements.length)
    throw new Error("unsupported-diagnostic-label");
  return node.elements.map((item) => {
    const fields = properties(item);
    const messageId = literal(fields.get("messageId"));
    if (typeof messageId !== "string" || !messageId.length)
      throw new Error("unsupported-diagnostic-label");
    const expected = { messageId };
    for (const key of ["line", "column", "endLine", "endColumn"])
      if (fields.has(key)) {
        const value = literal(fields.get(key));
        if (!Number.isInteger(value) || value < 1)
          throw new Error("unsupported-diagnostic-location");
        expected[key] = value;
      }
    return expected;
  });
}
function caseArray(node) {
  if (node?.type === "ArrayExpression") return node;
  const callee = node?.callee;
  const mapper = node?.arguments?.[0];
  const body = mapper?.body;
  if (
    node?.type !== "CallExpression" ||
    node.arguments.length !== 1 ||
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.name !== "map" ||
    callee.object.type !== "ArrayExpression" ||
    mapper?.type !== "ArrowFunctionExpression" ||
    mapper.async ||
    mapper.params.length !== 1 ||
    mapper.params[0].type !== "Identifier" ||
    body?.type !== "CallExpression" ||
    body.callee.type !== "MemberExpression" ||
    body.callee.computed ||
    body.callee.object.name !== "Object" ||
    body.callee.property.name !== "assign" ||
    body.arguments.length !== 2 ||
    body.arguments[1].type !== "Identifier" ||
    body.arguments[1].name !== mapper.params[0].name
  )
    throw new Error("Unsupported dynamic case list");
  const defaults = properties(body.arguments[0]);
  assert.deepEqual([...defaults.keys()], ["output"]);
  assert.equal(literal(defaults.get("output")), null);
  return callee.object;
}

export function extractRuleCases(source, rule, limits) {
  assert.ok(Buffer.byteLength(source) <= 1024 * 1024);
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    range: true,
    loc: true,
  });
  const declarations = ast.body.flatMap((node) =>
    node.type === "VariableDeclaration" ? node.declarations : [],
  );
  const testers = declarations.filter(
    (node) =>
      node.id.type === "Identifier" &&
      node.id.name === "ruleTester" &&
      node.init?.type === "NewExpression" &&
      node.init.callee.type === "Identifier" &&
      node.init.callee.name === "RuleTester",
  );
  assert.equal(
    testers.length,
    1,
    "Exactly one native RuleTester constructor is required",
  );
  assert.ok(testers[0].init.arguments.length <= 1);
  const defaults = testers[0].init.arguments.length
    ? literal(testers[0].init.arguments[0])
    : {};
  const config = z
    .strictObject({ languageOptions: languageSchema.optional() })
    .parse(defaults);
  const calls = ast.body
    .filter(
      (node) =>
        node.type === "ExpressionStatement" &&
        node.expression.type === "CallExpression" &&
        node.expression.callee.type === "MemberExpression" &&
        !node.expression.callee.computed &&
        node.expression.callee.object.name === "ruleTester" &&
        node.expression.callee.property.name === "run",
    )
    .map((node) => node.expression);
  assert.equal(
    calls.length,
    1,
    "Exactly one top-level RuleTester run is required",
  );
  assert.equal(literal(calls[0].arguments[0]), rule);
  assert.ok([3, 4].includes(calls[0].arguments.length));
  const groups = properties(calls[0].arguments[2]);
  assert.deepEqual([...groups.keys()].sort(), ["invalid", "valid"]);
  const cases = [];
  const excluded = [];
  let total = 0;
  for (const group of ["valid", "invalid"]) {
    const array = caseArray(groups.get(group));
    assert.equal(array.type, "ArrayExpression");
    total += array.elements.length;
    assert.ok(total <= limits.maxCasesPerRule);
    for (const [index, node] of array.elements.entries()) {
      assert.ok(
        node && node.type !== "SpreadElement",
        "Dynamic case lists cannot establish a total",
      );
      const metadata = {
        id: `${rule}/${group}/${String(index).padStart(4, "0")}`,
        rule,
        label: group === "valid" ? "valid" : "defect",
        upstreamLine: node.loc.start.line,
        caseSha256: sha256(source.slice(...node.range)),
      };
      try {
        const fields =
          node.type === "ObjectExpression"
            ? properties(node)
            : new Map([["code", node]]);
        if (
          [...fields.keys()].some(
            (key) =>
              ![
                "code",
                "options",
                "languageOptions",
                "errors",
                "output",
                "name",
              ].includes(key),
          )
        )
          throw new Error("unsupported-case-settings");
        const code = literal(fields.get("code"));
        if (
          typeof code !== "string" ||
          Buffer.byteLength(code) > limits.maxSourceBytes
        )
          throw new Error("unsupported-source");
        const options = fields.has("options")
          ? literal(fields.get("options"))
          : [];
        if (!Array.isArray(options))
          throw new Error("unsupported-rule-options");
        const languageOptions = mergeLanguage(
          config.languageOptions ?? {},
          fields.has("languageOptions")
            ? languageSchema.parse(literal(fields.get("languageOptions")))
            : {},
        );
        const expected =
          group === "invalid" ? expectations(fields.get("errors")) : [];
        if (group === "valid" && fields.has("errors"))
          throw new Error("ambiguous-valid-label");
        const payload = { code, options, languageOptions, expected };
        cases.push({
          ...metadata,
          ...payload,
          payloadSha256: sha256(JSON.stringify(payload)),
        });
      } catch (error) {
        excluded.push({
          ...metadata,
          reason:
            error instanceof z.ZodError
              ? "unsupported-language-options"
              : error.message,
        });
      }
    }
  }
  assert.equal(cases.length + excluded.length, total);
  assert.equal(
    new Set([...cases, ...excluded].map((item) => item.id)).size,
    total,
  );
  return { total, cases, excluded };
}

export function classifyExternalCase(item, observation) {
  if (observation.outcome === "incomplete") return "incomplete";
  if (item.label === "valid")
    return observation.outcome === "passed" &&
      observation.diagnostics.length === 0
      ? "clean"
      : "false-positive";
  if (observation.outcome === "passed") return "missed";
  const expected = item.expected;
  const exact =
    observation.diagnostics.length === expected.length &&
    expected.every((value, index) => {
      const actual = observation.diagnostics[index];
      return (
        actual.ruleId === item.rule &&
        Object.entries(value).every(([key, entry]) => actual[key] === entry)
      );
    });
  return exact ? "detected" : "wrong-signal";
}
export function summarizeExternalCases(cases, observations, excluded = []) {
  assert.ok(cases.length > 0);
  const all = [...cases, ...excluded];
  assert.equal(new Set(all.map((item) => item.id)).size, all.length);
  for (const item of all) assert.ok(["valid", "defect"].includes(item.label));
  assert.equal(observations.length, cases.length * 2);
  const ids = new Set(cases.map((item) => item.id));
  assert.equal(ids.size, cases.length);
  const seen = new Set();
  const rows = [];
  for (const item of cases)
    for (const system of ["native", "verifier"]) {
      const matches = observations.filter(
        (value) => value.id === item.id && value.system === system,
      );
      assert.equal(
        matches.length,
        1,
        "Exactly one observation per case and system is required",
      );
      const observation = matches[0];
      assert.ok(
        ["passed", "failed", "incomplete"].includes(observation.outcome),
      );
      assert.ok(Array.isArray(observation.diagnostics));
      for (const diagnostic of observation.diagnostics) {
        z.strictObject({
          file: z.enum(["case.js", "eslint.config.cjs"]),
          ruleId: z.string().nullable(),
          messageId: z.string().nullable(),
          severity: z.union([z.literal(1), z.literal(2)]),
          line: z.number().int().positive(),
          column: z.number().int().positive(),
          endLine: z.number().int().positive().optional(),
          endColumn: z.number().int().positive().optional(),
        }).parse(diagnostic);
      }
      assert.ok(Number.isFinite(observation.wallMs) && observation.wallMs >= 0);
      const classification = classifyExternalCase(item, observation);
      rows.push({
        id: item.id,
        rule: item.rule,
        label: item.label,
        system,
        classification,
      });
      seen.add(`${item.id}/${system}`);
    }
  assert.equal(seen.size, observations.length);
  for (const item of excluded)
    for (const system of ["native", "verifier"])
      rows.push({
        id: item.id,
        rule: item.rule,
        label: item.label,
        system,
        classification: "excluded",
      });
  const totals = [];
  for (const rule of [...new Set(all.map((item) => item.rule))])
    for (const system of ["native", "verifier"]) {
      const selected = rows.filter(
        (row) => row.rule === rule && row.system === system,
      );
      const counts = Object.fromEntries(
        [
          "clean",
          "false-positive",
          "detected",
          "missed",
          "wrong-signal",
          "incomplete",
          "excluded",
        ].map((key) => [
          key,
          selected.filter((row) => row.classification === key).length,
        ]),
      );
      assert.equal(
        Object.values(counts).reduce((sum, value) => sum + value, 0),
        selected.length,
      );
      totals.push({
        rule,
        system,
        count: selected.length,
        valid: selected.filter((row) => row.label === "valid").length,
        defect: selected.filter((row) => row.label === "defect").length,
        ...counts,
      });
    }
  return { totals, rows };
}
