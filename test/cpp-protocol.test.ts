import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cppFormat,
  cppCtest,
  cppCtestConsole,
  cppWords,
  cppArchive,
} from "../src/cpp-native.js";
const xml = (
  body: string,
  tests = 2,
  failures = 0,
  disabled = 0,
  skipped = 0,
) =>
  `<?xml version="1.0"?><testsuite name="(empty)" tests="${tests}" failures="${failures}" disabled="${disabled}" skipped="${skipped}" hostname="" time="0" timestamp="2026-10-06T00:00:00">${body}</testsuite>`;
const caseXml = (name: string, status = "run", outcome = "") =>
  `<testcase name="${name}" classname="${name}" time="0" status="${status}">${outcome}<properties/><system-out></system-out></testcase>`;
const names = ["OriginalFirst", "OriginalSecond"];
test("CTest XML rejects empty stale duplicate and contradictory outcomes and keeps native skip and disabled counts distinct", () => {
  const original = xml(names.map((n) => caseXml(n)).join(""));
  assert.deepEqual(cppCtest(original, names, 0).tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  assert.throws(() => cppCtest(xml("", 0), [], 0));
  assert.throws(() => cppCtest(original, [names[0]!], 0));
  assert.throws(() =>
    cppCtest(original.replace('tests="2"', 'tests="3"'), names, 0),
  );
  assert.throws(() =>
    cppCtest(original.replace("OriginalSecond", "OriginalFirst"), names, 0),
  );
  assert.throws(() => cppCtest(original, names, 8));
  const failed = xml(
    caseXml(names[0]!, "fail", '<failure message="Failed"/>') +
      caseXml(names[1]!),
    2,
    1,
  );
  assert.deepEqual(cppCtest(failed, names, 8).tests, {
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
  });
  assert.throws(() => cppCtest(failed, names, 0));
  const skipped = xml(
    caseXml(names[0]!) +
      caseXml(names[1]!, "notrun", '<skipped message="SKIP_RETURN_CODE=77"/>'),
    2,
    0,
    0,
    1,
  );
  assert.equal(cppCtest(skipped, names, 0).tests.skipped, 1);
  assert.throws(() =>
    cppCtest(skipped.replace('skipped="1"', 'skipped="0"'), names, 0),
  );
  const disabled = xml(
    caseXml(names[0]!) + caseXml(names[1]!, "disabled"),
    2,
    0,
    1,
  );
  assert.equal(cppCtest(disabled, names, 0).tests.skipped, 1);
  assert.throws(() =>
    cppCtest(disabled.replace('disabled="1"', 'disabled="0"'), names, 0),
  );
  assert.throws(() =>
    cppCtest(
      original.replace(
        "<properties/>",
        '<skipped message="hidden"/><properties/>',
      ),
      names,
      0,
    ),
  );
});
test("CTest console reconciles callback starts result identities and global counters instead of trusting its percentage", () => {
  const counts = { total: 2, passed: 2, failed: 0, skipped: 0 };
  const console =
    "Test project /original/build\n    Start 1: OriginalFirst\n1/2 Test #1: OriginalFirst ............   Passed    0.00 sec\n    Start 2: OriginalSecond\n2/2 Test #2: OriginalSecond ............   Passed    0.00 sec\n100% tests passed, 0 tests failed out of 2\n";
  cppCtestConsole(console, "", names, counts);
  for (const [before, after] of [
    ["100%", "99%"],
    ["out of 2", "out of 3"],
    ["2/2 Test #2", "2/3 Test #2"],
    ["Start 2:", "Start 1:"],
    ["2/2 Test #2", "1/2 Test #2"],
    ["Passed", "Skipped"],
  ])
    assert.throws(
      () =>
        cppCtestConsole(console.replace(before!, after!), "", names, counts),
      before,
    );
  assert.throws(() =>
    cppCtestConsole(console, "hidden warning", names, counts),
  );
});
test("format XML uses UTF8 byte bounds and decodes character references exactly once with no silent incomplete result", () => {
  const wrapped = (body: string) =>
    `<?xml version='1.0'?><replacements xml:space='preserve' incomplete_format='false'>${body}</replacements>`;
  assert.deepEqual(cppFormat(wrapped(""), "original"), []);
  assert.deepEqual(
    cppFormat(
      wrapped(
        "<replacement offset='2' length='0'>&#10;&amp;#10;</replacement>",
      ),
      "éx",
    ),
    [{ line: 1 }],
  );
  for (const body of [
    "<replacement offset='1' length='0'> </replacement>",
    "<replacement offset='4' length='0'> </replacement>",
    "<replacement offset='0' length='4'> </replacement>",
    "<replacement offset='0' length='2'> </replacement><replacement offset='1' length='1'> </replacement>",
    "<replacement offset='0' length='2'>é</replacement>",
    "<replacement offset='0' length='0'>&invalid;</replacement>",
  ])
    assert.throws(() => cppFormat(wrapped(body), "éx"));
  assert.throws(() =>
    cppFormat(
      wrapped("").replace(
        "incomplete_format='false'",
        "incomplete_format='true'",
      ),
      "x",
    ),
  );
});
test("native command decoding is passive and rejects shell expansion wrappers response syntax and embedded commands", () => {
  assert.deepEqual(cppWords("/original/clang  -std=c17 -c original.c\n"), [
    "/original/clang",
    "-std=c17",
    "-c",
    "original.c",
  ]);
  for (const value of [
    "clang @options",
    "clang original.c; other",
    "clang $(other)",
    "clang `other`",
    'clang "original.c"',
    "clang original.c\nother",
    "clang ${flags}",
  ])
    assert.throws(() => cppWords(value), value);
  assert.throws(() => cppArchive(Buffer.from("not an archive")));
});
