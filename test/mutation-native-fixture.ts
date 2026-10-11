import assert from "node:assert/strict";
import { access, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type {
  NativeMutationProfile,
  NativeMutationRecipe,
} from "../src/mutation-native-schema.js";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";
export const mutationFamilies = [
  "vitest",
  "jest",
  "pytest",
  "phpunit",
] as const;
export type MutationFamily = (typeof mutationFamilies)[number];
export const mutationProfile = (family: MutationFamily) =>
  (family + "-flat-tests") as NativeMutationProfile;
const repository = fileURLToPath(new URL("../../", import.meta.url));
export async function mutationFixture(
  t: Pick<TestContext, "after">,
  family: MutationFamily,
) {
  const check =
    family === "pytest"
      ? "python.pytest"
      : family === "phpunit"
        ? "php.phpunit"
        : "javascript." + family;
  const policy = JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: ".", checks: [check] }],
  });
  const files: Record<string, string> = { "checktrail.json": policy };
  let file: string,
    expected: string,
    replacements: Record<string, string>,
    modeExpected: string;
  if (family === "vitest" || family === "jest") {
    files["package.json"] = family === "vitest" ? '{"type":"module"}' : "{}";
    file = "original-subject.js";
    expected = "left + right";
    modeExpected = "mode=0";
    files[file] =
      (family === "vitest"
        ? "export const mode=0;\nexport function combine(left,right)"
        : "exports.mode=0;\nexports.combine=function(left,right)") +
      "{return left + right;}\n";
    // Jest's property assignment and Vitest's lexical export have different exact mutation anchors.
    if (family === "jest") modeExpected = "exports.mode=0";
    const start =
      family === "vitest"
        ? "import{test,expect,beforeEach,afterEach}from'vitest';import{combine,mode}from'./original-subject.js';\n"
        : "const{test,expect,beforeEach,afterEach}=require('@jest/globals');const{combine,mode}=require('./original-subject.js');\n";
    files["original.test.js"] =
      start +
      "beforeEach(()=>{if(mode===2)expect(mode).toBe(0);});\nafterEach(()=>{if(mode===3)expect(mode).toBe(0);});\nconst selected=mode===1?test.skip:test;\nselected('original binary',()=>{expect(combine(4,7)).toBe(11);});\nselected('original near zero',()=>{expect(combine(0,0)).toBe(0);});\n";
    replacements = {
      killed: "left - right",
      survived: "left + right + 0",
      "body-error": "missingOriginal()",
    };
  } else if (family === "pytest") {
    files["pyproject.toml"] =
      '[project]\nname="original-mutation-fixture"\nversion="1.0.0"\n';
    file = "original_subject.py";
    expected = "left + right";
    modeExpected = "mode=0";
    files[file] = "mode=0\ndef combine(left,right):\n    return left + right\n";
    files["test_original.py"] =
      "import pytest\nfrom original_subject import combine,mode\n@pytest.fixture(autouse=True)\ndef original_setup():\n    if mode==2:\n        assert mode==0\n    yield\n    if mode==3:\n        assert mode==0\ndef test_original_binary():\n    if mode==1:\n        pytest.skip('original skip')\n    assert combine(4,7)==11\ndef test_original_near_zero():\n    if mode==1:\n        pytest.skip('original skip')\n    assert combine(0,0)==0\n";
    replacements = {
      killed: "left - right",
      survived: "left + right + 0",
      "body-error": "missing_original()",
    };
  } else {
    files["composer.json"] = '{"require-dev":{"phpunit/phpunit":"13.3.4"}}';
    file = "original-subject.php";
    expected = "$left + $right";
    modeExpected = "MODE=0";
    files[file] =
      "<?php\nfinal class OriginalSubject { public const MODE=0; public static function combine(int $left,int $right):int {return $left + $right;} }\n";
    files["OriginalTest.php"] =
      "<?php\nrequire __DIR__.'/original-subject.php';\nuse PHPUnit\\Framework\\TestCase;\nfinal class OriginalTest extends TestCase {\n protected function setUp():void {if(OriginalSubject::MODE===2)self::assertSame(0,OriginalSubject::MODE);}\n protected function tearDown():void {if(OriginalSubject::MODE===3)self::assertSame(0,OriginalSubject::MODE);}\n public function testOriginalBinary():void {if(OriginalSubject::MODE===1)self::markTestSkipped('original skip');self::assertSame(11,OriginalSubject::combine(4,7));}\n public function testOriginalNearZero():void {if(OriginalSubject::MODE===1)self::markTestSkipped('original skip');self::assertSame(0,OriginalSubject::combine(0,0));}\n}\n";
    replacements = {
      killed: "$left - $right",
      survived: "$left + $right + 0",
      "body-error": "missingOriginal()",
    };
  }
  const recipe: NativeMutationRecipe = {
    schemaVersion: 1,
    profile: mutationProfile(family),
    mutations: Object.entries(replacements).map(([id, replacement]) => ({
      id,
      file,
      expected,
      replacement,
    })),
  };
  recipe.mutations.push(
    {
      id: "skipped",
      file,
      expected: modeExpected,
      replacement: modeExpected.slice(0, -1) + "1",
    },
    {
      id: "setup-assertion",
      file,
      expected: modeExpected,
      replacement: modeExpected.slice(0, -1) + "2",
    },
    {
      id: "teardown-assertion",
      file,
      expected: modeExpected,
      replacement: modeExpected.slice(0, -1) + "3",
    },
  );
  const importPrefix =
    family === "vitest" || family === "jest"
      ? "throw new TypeError('original import error');\n"
      : family === "pytest"
        ? "raise TypeError('original import error')\n"
        : "<?php throw new TypeError('original import error'); ?>\n";
  const source = files[file]!;
  recipe.mutations.push({
    id: "import-error",
    file,
    expected: source,
    replacement: importPrefix + source,
  });
  const root = await fixture(t, files);
  if (family === "vitest" || family === "jest")
    await copyInstalledPackages(
      root,
      family === "vitest" ? ["vitest", "vite"] : ["jest"],
      path.join(
        repository,
        ".checktrail/mutation-javascript-tools/node_modules",
      ),
    );
  else if (family === "pytest")
    await cp(
      path.join(repository, ".checktrail/python-extension-tools"),
      path.join(root, ".checktrail/mutation-python-tools"),
      { recursive: true },
    );
  else
    await cp(
      path.join(repository, ".checktrail/php-tools/vendor"),
      path.join(root, "vendor"),
      { recursive: true },
    );
  return { root, recipe, file, source };
}
export async function mutationFamilyAvailable(family: MutationFamily) {
  if (
    process.platform !== "linux" ||
    process.arch !== "arm64" ||
    process.versions.node !== "22.23.2"
  )
    return false;
  return access(
    path.join(
      repository,
      family === "pytest"
        ? ".checktrail/python-extension-tools/pytest/__init__.py"
        : family === "phpunit"
          ? ".checktrail/php-tools/vendor/phpunit/phpunit/phpunit"
          : ".checktrail/mutation-javascript-tools/node_modules/" +
            family +
            "/package.json",
    ),
  ).then(
    () => true,
    () => false,
  );
}
export async function assertMutationOriginal(
  root: string,
  file: string,
  expected: string,
) {
  assert.equal(await readFile(path.join(root, file), "utf8"), expected);
}
export async function mutationFixtureWrite(
  root: string,
  file: string,
  contents: string,
) {
  await writeFile(path.join(root, file), contents);
}
