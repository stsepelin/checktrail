import assert from "node:assert/strict";
import { test } from "node:test";
import {
  swiftAst,
  swiftAstMethods,
  swiftAstTesting,
} from "../src/swift-ast.js";

const file = "/owned workspace/project/Tests/Original Tests.swift";
const method = (name: string, line: number) =>
  `(func_decl range=[${file}:${line}:5 - line:${line}:70] "${name}()" interface_type="(OriginalTests) -> () -> ()" access=internal
    (parameter "self") result="()" thrown_type="<null>"
    (brace_stmt range=[${file}:${line}:20 - line:${line}:70]
      (string_literal_expr value=${JSON.stringify('Original (literal) [not a node] "quote"')})))`;
const declaration = (body: string, base = "XCTestCase") =>
  `(source_file ${JSON.stringify(file)}
    (class_decl range=[${file}:3:7 - line:8:1] "OriginalTests" inherits="${base}" ${body}))`;

test("Swift native declaration structure binds physical paths and exact callback identities", () => {
  const text = declaration(
    method("testZeroBoundary", 4) + method("testPositiveBoundary", 5),
  );
  assert.deepEqual(swiftAstMethods(text, "OriginalTestsModule", file), [
    {
      className: "OriginalTestsModule.OriginalTests",
      methodName: "testZeroBoundary",
      file,
      line: 4,
      column: 5,
      endLine: 4,
      endColumn: 70,
    },
    {
      className: "OriginalTestsModule.OriginalTests",
      methodName: "testPositiveBoundary",
      file,
      line: 5,
      column: 5,
      endLine: 5,
      endColumn: 70,
    },
  ]);
  assert.equal(swiftAst(text).children[0]!.children.length, 2);
  assert.ok(
    swiftAst(text).children[0]!.children[0]!.header.includes('result="()"'),
  );
  assert.equal(
    swiftAst(text).children[0]!.children[0]!.children[0]!.kind,
    "parameter",
  );
  assert.deepEqual(
    swiftAstMethods(
      declaration(method("testLiteral", 4), "XCTestCaseNearMiss"),
      "OriginalTestsModule",
      file,
    ),
    [],
  );
  assert.equal(
    swiftAstMethods(
      declaration(method("testLiteral", 4), "XCTest.XCTestCase"),
      "OriginalTestsModule",
      file,
    ).length,
    1,
  );
});

test("Swift native declaration artifacts reject ambiguous roots methods addresses and structure", () => {
  const text = declaration(method("testZeroBoundary", 4));
  for (const wrong of [
    text + text,
    text.slice(0, -1),
    text.replace("source_file", "unknown_source"),
    text.replace(JSON.stringify(file), JSON.stringify("/foreign/Test.swift")),
    text.replace(`range=[${file}:4:5`, "range=[/foreign/Test.swift:4:5"),
    text.replace("line:4:70", "line:3:70"),
    text.replace(":4:5 -", ":0:5 -"),
    text.replace(":4:5 - line:4:70", ":9:5 - line:9:70"),
    declaration(method("testZeroBoundary", 4) + method("testZeroBoundary", 5)),
    text + "\0",
    '(source_file "original.swift" ' +
      "(brace_stmt ".repeat(260) +
      ")".repeat(261),
  ])
    assert.throws(() => swiftAstMethods(wrong, "OriginalTestsModule", file));
  assert.throws(() =>
    swiftAstMethods(text, "OriginalTestsModuleSuffix!", file),
  );
});

test("Swift Testing native macros bind physical annotation points and exclude similarly named attributes and generated methods", () => {
  const declaration = `(source_file ${JSON.stringify(file)}
    (func_decl range=[${file}:5:10 - line:6:40] "originalBoundary(input:expected:)" interface_type="(Int, Int) -> ()" captures=($original_capture<direct>)
      (custom_attr range=[${file}:4:3 - line:4:50] macro="Testing.(file).Test(_:arguments:) [with (original substitutions)]"))
    (func_decl range=[@original_generated.swift:1:1 - line:3:1] "originalGenerated()"))`;
  assert.deepEqual(swiftAstTesting(declaration, "OriginalTests", file), [
    {
      module: "OriginalTests",
      name: "originalBoundary(input:expected:)",
      file,
      line: 4,
      column: 4,
      endLine: 6,
    },
  ]);
  assert.deepEqual(
    swiftAstTesting(
      declaration.replace(
        "Testing.(file).Test(",
        "Testing.(file).TestNearMiss(",
      ),
      "OriginalTests",
      file,
    ),
    [],
  );
  assert.throws(() =>
    swiftAstTesting(
      declaration.replace(
        `custom_attr range=[${file}`,
        "custom_attr range=[/foreign/source.swift",
      ),
      "OriginalTests",
      file,
    ),
  );
  assert.throws(() =>
    swiftAstTesting(
      declaration.replace(":4:3 - line:4:50", ":7:3 - line:7:50"),
      "OriginalTests",
      file,
    ),
  );
  assert.throws(() =>
    swiftAstTesting(
      declaration.replace(
        JSON.stringify(file),
        JSON.stringify("/foreign/source.swift"),
      ),
      "OriginalTests",
      file,
    ),
  );
});
