import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";
export async function dotnetMethodFixture(t: TestContext) {
  const { root, config } = await dotnetTestFixture(t),
    edits: Array<[string, string]> = [];
  for (const [file, old, value] of [
    [
      "CSharpTests/CounterTests.cs",
      "[TestCase(-1)]",
      '[TestCase(-1, TestName="Original C# minus one <boundary>")]',
    ],
    [
      "FSharpTests/CounterTests.fs",
      "[<TestCase(-1)>]",
      '[<TestCase(-1, TestName="Original F# minus one <boundary>")>]',
    ],
    [
      "VisualBasicTests/CounterTests.vb",
      "<TestCase(-1)>",
      '<TestCase(-1, TestName:="Original VB minus one <boundary>")>',
    ],
  ]) {
    const target = path.join(root, file!),
      source = await readFile(target, "utf8");
    if (source.split(old!).length !== 2)
      throw Error("One original method-name anchor: " + file);
    edits.push([target, source.replace(old!, value!)]);
  }
  for (const [file, source] of edits) await writeFile(file, source);
  return { root, config };
}
