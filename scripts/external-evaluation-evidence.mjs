import assert from "node:assert/strict";
import path from "node:path";

export function normalizeExternalDiagnostics(results, root) {
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
  const seen = new Set();
  const diagnostics = [];
  for (const result of [...results].sort((a, b) =>
    a.filePath.localeCompare(b.filePath, "en"),
  )) {
    const file = path.relative(root, result.filePath).split(path.sep).join("/");
    assert.ok(["case.js", "eslint.config.cjs"].includes(file));
    assert.ok(!seen.has(file));
    seen.add(file);
    assert.ok(Array.isArray(result.messages));
    for (const field of ["errorCount", "warningCount", "fatalErrorCount"])
      assert.ok(Number.isInteger(result[field]) && result[field] >= 0);
    assert.equal(
      result.errorCount + result.warningCount,
      result.messages.length,
    );
    assert.equal(
      result.messages.filter((item) => item.severity === 2).length,
      result.errorCount,
    );
    assert.equal(
      result.messages.filter((item) => item.severity === 1).length,
      result.warningCount,
    );
    assert.equal(
      result.messages.filter((item) => item.fatal === true).length,
      result.fatalErrorCount,
    );
    for (const message of result.messages) {
      const value = {
        file,
        ruleId: message.ruleId ?? null,
        messageId: message.messageId ?? null,
        severity: message.severity,
        line: message.line,
        column: message.column,
      };
      assert.ok(value.ruleId === null || typeof value.ruleId === "string");
      assert.ok(
        value.messageId === null || typeof value.messageId === "string",
      );
      for (const key of ["line", "column"])
        assert.ok(Number.isInteger(value[key]) && value[key] > 0);
      for (const key of ["endLine", "endColumn"])
        if (message[key] !== undefined) {
          assert.ok(Number.isInteger(message[key]) && message[key] > 0);
          value[key] = message[key];
        }
      diagnostics.push(value);
    }
  }
  return diagnostics;
}
