import process from "node:process";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { runRequiredTests } from "./required-test-evidence.mjs";
const requirements = [];
for (const file of [
  "dist/test/review-laravel-assembly-guards.test.js",
  "dist/test/process-tree.test.js",
]) {
  const code = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = [];
  for (const statement of code.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      continue;
    const call = statement.expression;
    if (ts.isIdentifier(call.expression) && call.expression.text === "test") {
      assert.ok(
        call.arguments[0] && ts.isStringLiteral(call.arguments[0]),
        "Every supplemental callback needs an exact static name",
      );
      names.push(call.arguments[0].text);
    }
  }
  assert.ok(names.length > 0, "Supplemental files cannot be empty");
  assert.equal(new Set(names).size, names.length);
  requirements.push(...names.map((name) => ({ file, name })));
}
const profile = await runRequiredTests(requirements, {
  timeoutMs: 300000,
  isolatedCaseWorkers: 1,
});
assert.equal(profile.complete, true, JSON.stringify(profile.problems));
assert.equal(profile.required, requirements.length);
assert.equal(profile.passed, requirements.length);
assert.equal(profile.ledger.cases.length, requirements.length);
assert.equal(profile.ledger.truncated, false);
assert.ok(profile.ledger.cases.every((c) => c.outcome === "passed"));
process.stdout.write(JSON.stringify(profile) + "\n");
