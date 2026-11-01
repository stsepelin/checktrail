import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { validateWindowsTaskAccessBatch } from "../src/windows-task-access.js";

const user = "S-1-5-21-10-20-30-1001";
const tokenOwner = "S-1-5-32-544";
function observed(kind: "file" | "directory" = "directory") {
  return {
    userSid: user,
    tokenOwnerSid: tokenOwner,
    ownerSid: user,
    protected: true,
    canonical: true,
    rules: [
      {
        sid: user,
        rights: 2032127,
        inheritance: kind === "directory" ? 3 : 0,
        propagation: 0,
        type: "Allow",
      },
    ],
  };
}

const batch = [
  { filename: "C:\\original-'[literal]-🧪", kind: "directory" },
  { filename: "C:\\original-'[literal]-🧪\\input.blob", kind: "file" },
] as const;
function batchObserved() {
  return batch.map((target, index) => ({
    index,
    ...target,
    access: observed(target.kind),
  }));
}

test("Windows private ACL batches bind every indexed literal target and each permission boundary", () => {
  validateWindowsTaskAccessBatch(batchObserved(), batch);
  for (const mode of [
    "missing",
    "duplicate",
    "order",
    "index",
    "filename",
    "kind",
    "private",
    "extra",
  ]) {
    const rows = batchObserved();
    if (mode === "missing") rows.pop();
    else if (mode === "duplicate") rows.push(rows[0]!);
    else if (mode === "order") rows.reverse();
    else if (mode === "index") rows[1]!.index = 0;
    else if (mode === "filename")
      Object.assign(rows[1]!, { filename: batch[1].filename + ".other" });
    else if (mode === "kind") Object.assign(rows[1]!, { kind: "directory" });
    else if (mode === "private") rows[1]!.access.rules[0]!.sid = "S-1-1-0";
    else Object.assign(rows[1]!, { unexpected: true });
    assert.throws(() => validateWindowsTaskAccessBatch(rows, batch), mode);
  }
  for (const targets of [
    [],
    [batch[0], batch[0]],
    [{ filename: "C:\\x\\..\\input", kind: "file" }],
    [{ filename: "C:\\input:stream", kind: "file" }],
    [{ filename: "\\\\server\\share", kind: "file" }],
    [{ filename: "C:\\x\ninput", kind: "file" }],
    Array(8193).fill(batch[0]),
  ])
    assert.throws(
      () =>
        validateWindowsTaskAccessBatch(
          targets.map((target, index) => ({
            index,
            ...target,
            access: observed(target.kind as "file" | "directory"),
          })),
          targets as Parameters<typeof validateWindowsTaskAccessBatch>[1],
        ),
      JSON.stringify(targets.slice(0, 2)),
    );
});

test("Windows private ACL batching ships one fixed read-only OS program", async () => {
  const filename = "../src/windows-task-access.js";
  const file = ts.createSourceFile(
    filename,
    await readFile(new URL(filename, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let script: string | undefined;
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "accessBatchScript" &&
      node.initializer &&
      ts.isTaggedTemplateExpression(node.initializer)
    ) {
      assert.ok(ts.isNoSubstitutionTemplateLiteral(node.initializer.template));
      assert.equal(script, undefined);
      script = node.initializer.template.text;
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  assert.ok(script);
  assert.ok(script.includes("$item.GetAccessControl()"));
  assert.ok(
    script.includes("$serializer.DeserializeObject([Console]::In.ReadToEnd())"),
  );
  assert.ok(
    script.includes(
      "System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
    ),
  );
  assert.doesNotMatch(
    script,
    /SetAccessControl|SetAccessRule|SetOwner|New-Object|ConvertFrom-Json|ConvertTo-Json|Get-Acl|Set-Acl|Get-Item|ForEach-Object/,
  );
});
