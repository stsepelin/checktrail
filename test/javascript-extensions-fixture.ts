import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { copyInstalledPackages } from "./tool-fixture.js";
import { fixture, nodeManifest } from "./helpers.js";
import type { TestContext } from "node:test";
export const cjs = `const fs=require('node:fs');require('node:module').registerHooks({load(url,context,next){if(url.endsWith('.cts'))return {format:'commonjs',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace(/: number/g,'').replaceAll('__answer__','42')};return next(url,context)}});`;
export const asyncEsm = `import {register} from 'node:module';register('data:text/javascript,'+encodeURIComponent("import fs from 'node:fs/promises';export async function load(url,context,next){if(url.endsWith('.mts'))return {format:'module',shortCircuit:true,source:(await fs.readFile(new URL(url),'utf8')).replace(/: number/g,'').replaceAll('__answer__','42')};return next(url,context)}"),import.meta.url);`;
export const esm = `import {registerHooks} from 'node:module';import fs from 'node:fs';registerHooks({load(url,context,next){if(url.endsWith('.mts'))return {format:'module',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace(/: number/g,'').replaceAll('__answer__','42')};return next(url,context)}});`;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const loaderProfile = () =>
  JSON.stringify({
    schemaVersion: 1,
    nodeTest: {
      loaders: [
        { kind: "import", path: "esm hook.mjs", sha256: hash(esm) },
        { kind: "require", path: "cjs hook.cjs", sha256: hash(cjs) },
      ],
    },
  });
export const loaderFiles = {
  "package.json": nodeManifest,
  "checktrail.json": JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: ".", checks: ["javascript.node-test"] }],
  }),
  "checktrail.javascript.json": loaderProfile(),
  "esm hook.mjs": esm,
  "cjs hook.cjs": cjs,
  "esm.test.mts":
    "import {test} from 'node:test';import assert from 'node:assert/strict';const actual: number=__answer__;test('ESM loader rewrites the sentinel',()=>assert.equal(actual,42));",
  "cjs.test.cts":
    "const {test}=require('node:test');const assert=require('node:assert/strict');const actual: number=__answer__;test('CJS loader rewrites the sentinel',()=>assert.equal(actual,42));",
};

export const available =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" &&
    process.arch === "arm64" &&
    !(
      process.report.getReport() as {
        header?: { glibcVersionRuntime?: string };
      }
    ).header?.glibcVersionRuntime);
export const source = {
  ...loaderFiles,
  "checktrail.json": JSON.stringify({
    schemaVersion: 1,
    projects: [
      {
        path: ".",
        checks: [
          "javascript.node-test",
          "javascript.eslint",
          "javascript.vite-library",
        ],
      },
    ],
  }),
  "checktrail.javascript.json": JSON.stringify({
    ...JSON.parse(loaderProfile()),
    eslint: { sourceParticipation: true },
    library: {
      sourceDirectory: "lib",
      entry: "lib/index.ts",
      consumers: ["use.ts"],
    },
  }),
  "lib/index.ts": "export {value} from './value.js';",
  "lib/value.ts": "export const value: number=42;",
  "use.ts":
    "import {value} from 'checktrail:library';export const actual: number=value;",
  "processed.js": "export const label: number=7;",
  "eslint.config.mjs": `import parser from '@typescript-eslint/parser';export default [{files:['**/*.[cm]?[jt]s','**/*.js','**/*.mjs','**/*.cjs','**/*.ts','**/*.mts','**/*.cts'],languageOptions:{parser},rules:{'no-debugger':'error'}},{files:['processed.js'],processor:{preprocess(text){return [{text,filename:'first.ts'},{text,filename:'second.ts'}]},postprocess(messages){return messages.flat()}}}];`,
};
export async function project(
  t: TestContext,
  files: Record<string, string> = source,
  prepared = true,
) {
  const root = await fixture(t, files);
  if (prepared)
    await copyInstalledPackages(root, [
      "eslint",
      "@typescript-eslint/parser",
      "typescript",
      "vite",
    ]);
  return realpath(root);
}
