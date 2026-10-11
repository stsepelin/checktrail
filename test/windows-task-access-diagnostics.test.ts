import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const helper = await import(
  new URL("../../scripts/windows-task-access-diagnostics.mjs", import.meta.url)
    .href
);
test("Windows ACL diagnostic separates completed stdin from JSON conversion without changing the shipped request or ACL decisions", async () => {
  const source = ts.createSourceFile(
    "windows-task-access.js",
    await readFile(
      new URL("../src/windows-task-access.js", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .filter((d) => ts.isIdentifier(d.name) && d.name.text === "accessScript");
  assert.equal(declarations.length, 1);
  const value = declarations[0]!.initializer;
  assert.ok(
    value &&
      ts.isTaggedTemplateExpression(value) &&
      ts.isNoSubstitutionTemplateLiteral(value.template),
  );
  const original = value.template.rawText ?? value.template.text;
  const diagnostic = helper.buildWindowsTaskAccessDiagnostic(
    original,
  ) as string;
  const request = "  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json";
  const strip = (s: string) =>
    s
      .split("\n")
      .filter(
        (l) => !l.includes("CT_ACL_STAGE|") && !l.includes("CT_ACL_EXCEPTION|"),
      )
      .join("\n");
  assert.equal(
    strip(diagnostic).replace(
      "  $requestText = [Console]::In.ReadToEnd()\n  $request = $requestText | ConvertFrom-Json",
      request,
    ),
    original,
  );
  const inputAt = diagnostic.indexOf(
      "$requestText = [Console]::In.ReadToEnd()",
    ),
    finishedAt = diagnostic.indexOf("CT_ACL_STAGE|stdin-finished|"),
    convertAt = diagnostic.indexOf(
      "$request = $requestText | ConvertFrom-Json",
    );
  assert.ok(inputAt >= 0 && inputAt < finishedAt && finishedAt < convertAt);
  for (const anchor of [
    request,
    "  $acl = Get-Acl -LiteralPath $request.path",
    "  [Console]::Error.WriteLine('Windows task ACL inspection unavailable')",
  ]) {
    assert.throws(
      () =>
        helper.buildWindowsTaskAccessDiagnostic(original.replace(anchor, "")),
      /anchor changed/,
    );
    assert.throws(
      () => helper.buildWindowsTaskAccessDiagnostic(original + "\n" + anchor),
      /anchor changed/,
    );
  }
});
test("Windows ACL diagnostic retains safe machine exception identities and hashes unsafe text without exposing paths messages or unknown stages", () => {
  const stderr =
    "CT_ACL_STAGE|request-start|123\r\nCT_ACL_STAGE|stdin-finished|124\r\nCT_ACL_EXCEPTION|System.Management.Automation.CommandNotFoundException|CommandNotFoundException|CommandNotFoundException\r\n";
  const value = helper.summarizeWindowsTaskAccessDiagnostic(stderr);
  assert.deepEqual(value.stages, [
    { stage: "request-start", clockTicks: "123" },
    { stage: "stdin-finished", clockTicks: "124" },
  ]);
  assert.equal(
    value.exceptions[0].type,
    "System.Management.Automation.CommandNotFoundException",
  );
  assert.equal(value.exceptions[0].id, "CommandNotFoundException");
  assert.equal(value.exceptions[0].reason, "CommandNotFoundException");
  const privateText = "C:\\original-private\\caller.txt";
  const unsafe = helper.summarizeWindowsTaskAccessDiagnostic(
    "CT_ACL_EXCEPTION|" +
      privateText +
      "|" +
      privateText +
      "|original private message\n",
  );
  assert.equal(unsafe.exceptions.length, 1);
  assert.equal(unsafe.exceptions[0].type, null);
  assert.equal(unsafe.exceptions[0].id, null);
  assert.equal(unsafe.exceptions[0].reason, null);
  assert.match(unsafe.exceptions[0].recordSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(unsafe).includes("original"), false);
  assert.throws(
    () =>
      helper.summarizeWindowsTaskAccessDiagnostic("CT_ACL_STAGE|unknown|125\n"),
    /Unknown/,
  );
  assert.throws(
    () => helper.summarizeWindowsTaskAccessDiagnostic("x".repeat(32769)),
    /bound/,
  );
});
