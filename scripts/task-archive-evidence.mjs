import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
export const taskArchiveTestFiles = [
  ["task-store.test.js", 9],
  ["validation-tasks.test.js", 8],
  ["mcp-validation-tasks.test.js", 10],
  ["task-report-archives.test.js", 9],
];
export async function taskArchiveRequirements(root) {
  assert.ok(
    ["darwin", "linux"].includes(process.platform),
    "Native archive acceptance has not yet established the Windows storage controls",
  );
  const frozen = JSON.parse(
    await readFile(
      path.join(root, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  const original = [
    ...new Map(
      Object.values(frozen)
        .flat()
        .map((entry) => [JSON.stringify(entry), entry]),
    ).values(),
  ];
  const requirements = [];
  for (const [name, expected] of taskArchiveTestFiles) {
    const file = path.join(root, "dist/test", name);
    if (name !== "task-report-archives.test.js") {
      const selected = original.filter(
        (entry) => entry.file === "dist/test/" + name,
      );
      assert.equal(
        selected.length,
        expected,
        "Preserved native declaration differs: " + name,
      );
      assert.equal(new Set(selected.map((entry) => entry.name)).size, expected);
      requirements.push(
        ...selected.map((entry) => ({ file, name: entry.name })),
      );
      continue;
    }
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
      if (!ts.isIdentifier(call.expression) || call.expression.text !== "test")
        continue;
      assert.ok(
        call.arguments[0] && ts.isStringLiteral(call.arguments[0]),
        "Required callbacks need exact static names",
      );
      names.push(call.arguments[0].text);
    }
    assert.equal(names.length, expected, name);
    assert.equal(new Set(names).size, expected, name);
    requirements.push(...names.map((name) => ({ file, name })));
  }
  assert.equal(requirements.length, 36);
  return requirements;
}
